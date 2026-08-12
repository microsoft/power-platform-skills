#!/usr/bin/env node

// set-governance.js — Applies a governance policy to an environment or to a
// single portal, then polls the matching status endpoint until terminal.
//
// Request shape (per Power Apps Core Services Gateway appsettings.json):
//   Body: [
//     { policyName: "<policy>",
//       policyValue: "All" | "None" | "Include" | "Exclude",
//       ToBeAdded:   [ "<portalId>", ... ],
//       ToBeRemoved: [ "<portalId>", ... ] }
//   ]
//
// Semantics (per Power Apps gateway contract):
//   - "All"     apply to every portal in the env
//   - "None"    apply to no portals (clears any inclusion / exclusion list)
//   - "Include" apply ONLY to portals listed in ToBeAdded (allow-list)
//   - "Exclude" apply to every portal EXCEPT those in ToBeAdded (block-list)
//
// Transport: gateway only — POST /governance (env id implied by base URL).
//
// Defaults this script encodes when --policyValue is not passed explicitly:
//   --portalId omitted → policyValue="All",     ToBeAdded=[]         (env-wide).
//   --portalId given   → policyValue="Include", ToBeAdded=[portalId] (allow-list).
// Override with --policyValue to pick any of All|None|Include|Exclude.

const {
  pollUntil,
  parseCliArgs,
  parseTimeoutMs,
  fail,
  runCli,
} = require('../../../scripts/lib/power-platform-api');
const { SUPPORTED_POLICIES, assertPolicy, classifyStatus, toWritePolicyValue, normalizeEnvValue } = require('./policies');
const { callGovernance } = require('./governance-transport');

const DEFAULT_TIMEOUT_MIN = 15;
const POLL_INTERVAL_MS = 30_000;
// How many consecutive transient errors we tolerate inside the poll loop
// before bailing. 5 × 30s = ~2.5 minutes of "give the server another chance"
// before the script gives up on the status endpoint.
const MAX_CONSECUTIVE_POLL_ERRORS = 5;
const VALID_POLICY_VALUES = ['All', 'None', 'Include', 'Exclude'];

// Builds a useful error message from a callGovernance failure envelope. Never
// returns the literal string "undefined" — that was the symptom of the original
// polling bug, where the fallback chain `error?.message || ${statusCode}`
// would degrade to the string "undefined" when both fields were empty.
function describeFetchError(r) {
  const trimmedMsg = (r && r.error && typeof r.error.message === 'string')
    ? r.error.message.trim()
    : '';
  if (trimmedMsg) return trimmedMsg;
  const code = (r && r.error && r.error.code) ? r.error.code : null;
  if (r && r.statusCode != null && r.statusCode !== 0) {
    return code ? `HTTP ${r.statusCode} (${code})` : `HTTP ${r.statusCode}`;
  }
  if (code) return code;
  return 'status endpoint returned an unparseable response';
}

const HELP = `set-governance.js — Applies a governance policy and watches the roll-out.

Usage:
  node set-governance.js --policy <name> [--portalId <guid>] [--envId <guid>]
                         [--timeoutMinutes <n>]

Flags:
  --policy           Governance policy name. One of:
                       ${SUPPORTED_POLICIES.join('\n                       ')}
  --portalId         Optional single portal id. Legacy flag.
  --portalIds        Optional comma- or space-separated list of portal ids.
                     Use this for Include / Exclude scopes with multiple
                     portals. When provided, the policy defaults to
                     policyValue="Include" + ToBeAdded=[ids]. When omitted
                     and --portalId is also omitted, defaults to "All".
  --removePortalIds  Optional comma- or space-separated list of portal ids to
                     DROP from an existing Include allow-list / Exclude
                     block-list (populates ToBeRemoved). The gateway treats
                     ToBeAdded as additive, so this is the ONLY way to shrink a
                     list without clearing the whole policy via "None". Combine
                     with --policyValue Include (or Exclude) to keep the mode.
  --policyValue      Optional explicit policy value (overrides the default
                     derived from --portalId). One of: ${VALID_POLICY_VALUES.join(', ')}.
                     Use "None" for a safe round-trip test of the write path.
  --envId            Optional environment id. Falls back to the current PAC env.
  --timeoutMinutes   Maximum wait for terminal status (default: ${DEFAULT_TIMEOUT_MIN}).
  --help             Show this help message.

Exit codes:
  0  Roll-out reached a success terminal state
  2  Sign-in required
  3  Polling timed out before terminal state
  4  Terminal state reached but it was Failed
  1  Other failure

Stdout (JSON):
  { "status": "applied", "policy", "envId", "portalId", "transport",
    "attempts", "finalValue" }
`;

function buildPolicyPayload(policy, portalIdsArg, policyValueOverride, removePortalIdsArg) {
  // Accept either a single portalId string (legacy) or an array of ids.
  let portalIds;
  if (portalIdsArg == null || portalIdsArg === '') {
    portalIds = [];
  } else if (Array.isArray(portalIdsArg)) {
    portalIds = portalIdsArg.filter(Boolean);
  } else {
    portalIds = [portalIdsArg];
  }
  // ToBeRemoved is the gateway's REMOVAL delta for an Include/Exclude allow-list.
  // The gateway treats ToBeAdded as an ADDITIVE delta against the existing list
  // (NOT a full replace, despite the doc contract's "apply only to portals in
  // ToBeAdded" wording): re-posting Include with a SHORTER ToBeAdded leaves the
  // previously-added sites on the list untouched. So the ONLY way to drop a site
  // from an Include allow-list (or an Exclude block-list) without clearing the
  // whole policy (None) is to name it here in ToBeRemoved. Observed live on
  // EnableProtocolOpenIdConnect: Include=[P1,P2] then re-post Include=[P1] ->
  // env still reads {P1,P2}; Include + ToBeRemoved=[P2] -> env reads {P1}.
  let removePortalIds;
  if (removePortalIdsArg == null || removePortalIdsArg === '') {
    removePortalIds = [];
  } else if (Array.isArray(removePortalIdsArg)) {
    removePortalIds = removePortalIdsArg.filter(Boolean);
  } else {
    removePortalIds = [removePortalIdsArg];
  }
  // Derive the canonical policyValue (All / None / Include / Exclude) first,
  // then forward-map it to the gateway WRITE vocabulary. As of the 2026-07
  // A059 shift the wire form IS the short canonical value — the older applyTo
  // `*Sites` enums ("AllSites"/"IncludeSites"/"ExcludeSites") are now rejected
  // with HTTP 400 A059 "The provided policy value is not a valid governance
  // policy value." So the forward-map is currently an identity map; the seam
  // is retained in case the vocabulary shifts again. See policies.js
  // toWritePolicyValue / WRITE_VALUE_ALIASES for the WHY and empirical proof.
  // A removal-only edit (drop a site from the allow-list, keep the mode) passes
  // no ToBeAdded, so fall back to Include as the mode when only removals are
  // present — the caller keeps the env in allow-list mode, it just shrinks.
  const canonicalValue =
    policyValueOverride ||
    (portalIds.length > 0 || removePortalIds.length > 0 ? 'Include' : 'All');
  return [
    {
      policyName: policy,
      policyValue: toWritePolicyValue(canonicalValue, policy),
      ToBeAdded: portalIds,
      ToBeRemoved: removePortalIds,
    },
  ];
}

function parsePortalIdsFlag(flagValue) {
  // Comma- or space-separated list of portal ids.
  if (!flagValue) return [];
  return String(flagValue)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseCliArgs(process.argv);
  if (!args.policy) {
    fail('Usage: node set-governance.js --policy <name> [--portalId <guid>] [--envId <guid>]', 1);
  }
  assertPolicy(args.policy);
  const timeoutMs = parseTimeoutMs(args.timeoutMinutes, DEFAULT_TIMEOUT_MIN);
  const portalIdsFromFlag = parsePortalIdsFlag(args.portalIds);
  const portalIds = portalIdsFromFlag.length > 0
    ? portalIdsFromFlag
    : (args.portalId ? [args.portalId] : []);
  const removePortalIds = parsePortalIdsFlag(args.removePortalIds);
  const policyValueOverride = args.policyValue || null;
  if (policyValueOverride && !VALID_POLICY_VALUES.includes(policyValueOverride)) {
    fail(`--policyValue must be one of: ${VALID_POLICY_VALUES.join(', ')}`, 1);
  }

  const transportLabel = 'gateway';
  const scopeLabel = portalIds.length > 0
    ? `${portalIds.length} portal(s)`
    : (removePortalIds.length > 0
        ? `remove ${removePortalIds.length} portal(s)`
        : `env ${args.envId || '<current>'}`);
  process.stderr.write(
    `Applying ${args.policy} to ${scopeLabel} via ${transportLabel}...\n`
  );

  const body = buildPolicyPayload(args.policy, portalIds, policyValueOverride, removePortalIds);
  // The canonical scope (All/None/Include/Exclude) we are asking the gateway to
  // set — mirrors the derivation inside buildPolicyPayload. Used below to verify
  // the write against the ACTUAL env state, not the (possibly stale) status
  // endpoint.
  const requestedCanonical =
    policyValueOverride ||
    (portalIds.length > 0 || removePortalIds.length > 0 ? 'Include' : 'All');
  const start = await callGovernance({
    op: 'apply',
    envId: args.envId,
    policy: args.policy,
    portalId: portalIds[0] || null,
    body,
  });

  // If the POST didn't come back with a clean 2xx, don't bail immediately —
  // the response parsing can produce undefined statusCode for transient blips
  // even when the gateway accepted the upsert. Verify against the ACTUAL
  // env-level state (getEnv), NOT the status endpoint. The status endpoint
  // reflects the LAST rollout and can report "Succeeded" from a previous apply
  // even when THIS POST was rejected (e.g. the gateway returns
  // "Website id cannot be null or empty" for a malformed body) — trusting it
  // masks a real failure as success. getEnv reads the live policy value, so if
  // the POST was rejected the env still shows the OLD scope and we fail loudly.
  if (start.statusCode !== 200 && start.statusCode !== 202 && start.statusCode !== 204) {
    if (start.error?.code === 'ContextError') {
      fail(`POST governance failed: ${describeFetchError(start)}`, 2);
    }
    // Live-state reality check: does the env now reflect the scope we asked for?
    const envCheck = await callGovernance({
      op: 'getEnv',
      envId: args.envId,
      policy: args.policy,
    });
    const envValue = envCheck.ok ? normalizeEnvValue(envCheck.body) : null;
    if (envValue && envValue === requestedCanonical) {
      // POST landed (env reflects the requested scope) even though our parsing
      // of the POST response was off — log and continue to the polling loop.
      process.stderr.write(
        `  POST response was unparseable (${describeFetchError(start)}); env now reports "${envValue}" (matches request) — continuing to poll.\n`
      );
    } else {
      const observed = envValue ? `env still reports "${envValue}"` : 'live state unreadable';
      fail(`POST governance failed (${start.statusCode != null ? start.statusCode : 'no response'}): ${describeFetchError(start)} — ${observed}, expected "${requestedCanonical}".`, 1);
    }
  }

  let finalValue = '';
  let consecutiveErrors = 0;
  let lastErrorMessage = '';
  const poll = await pollUntil({
    fetchStatus: async () => {
      const r = await callGovernance({
        op: 'getStatus',
        envId: args.envId,
        policy: args.policy,
      });
      if (!r.ok) {
        // Transient failure on the status endpoint — retry on the next tick
        // unless we've hit the consecutive-error ceiling. Reports each retry
        // to stderr so the orchestrator sees what's happening.
        consecutiveErrors += 1;
        lastErrorMessage = describeFetchError(r);
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          return { ok: false, error: lastErrorMessage };
        }
        process.stderr.write(
          `  status poll ${consecutiveErrors}/${MAX_CONSECUTIVE_POLL_ERRORS} transient error: ${lastErrorMessage}; retrying...\n`
        );
        return { ok: true, body: 'in-progress' };
      }
      consecutiveErrors = 0;
      const raw = r.body;
      const value =
        typeof raw === 'string'
          ? raw
          : raw?.status ?? raw?.state ?? raw?.value ?? '';
      finalValue = String(value);
      const cls = classifyStatus(finalValue);
      if (cls === 'failure') {
        return { ok: false, error: `roll-out reached terminal state "${finalValue}"` };
      }
      return { ok: true, body: cls };
    },
    isDone: (cls) => cls === 'success',
    timeoutMs,
    intervalMs: POLL_INTERVAL_MS,
  });

  // If the poll loop bailed without seeing a terminal success state, give the
  // status endpoint one last chance — sometimes the rollout actually completed
  // while we were in the middle of a transient outage. This is the safety net
  // that turns "Polling failed" false negatives into successful exits when the
  // real state has already flipped.
  if (!poll.ok) {
    const finalCheck = await callGovernance({
      op: 'getStatus',
      envId: args.envId,
      policy: args.policy,
    });
    if (finalCheck.ok) {
      const raw = finalCheck.body;
      const value =
        typeof raw === 'string'
          ? raw
          : raw?.status ?? raw?.state ?? raw?.value ?? '';
      finalValue = String(value);
      const cls = classifyStatus(finalValue);
      if (cls === 'success') {
        poll.ok = true;
        poll.body = cls;
      } else if (cls === 'failure') {
        // Fall through to the failure-terminal-state branch below.
      }
    }
  }

  if (!poll.ok && poll.error === 'timeout') {
    fail(`Roll-out did not reach a success state before timeout. Last seen: "${finalValue}".`, 3);
  }
  if (!poll.ok && classifyStatus(finalValue) === 'failure') {
    fail(`Roll-out reported a failure terminal state ("${finalValue}").`, 4);
  }
  if (!poll.ok) {
    const msg = poll.error || lastErrorMessage || 'status endpoint unavailable';
    fail(`Polling failed: ${msg}`, 1);
  }

  process.stdout.write(
    JSON.stringify(
      {
        status: 'applied',
        policy: args.policy,
        envId: args.envId,
        portalIds,
        transport: start.transport,
        attempts: poll.attempts,
        finalValue,
      },
      null,
      2
    ) + '\n'
  );
}

module.exports = { buildPolicyPayload, parsePortalIdsFlag };

runCli(module, main);
