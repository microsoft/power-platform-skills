#!/usr/bin/env node

// set-governance.js — Applies a governance policy to an environment or to a
// single portal, then polls the matching status endpoint until terminal.
//
// Request shape (per Power Apps Core Services Gateway appsettings.json AND
// the admin-portal HAR):
//   Body: [
//     { policyName: "<policy>",
//       policyValue: "All" | "None" | "Include" | "Exclude",
//       ToBeAdded:   [ "<portalId>", ... ],
//       ToBeRemoved: [ "<portalId>", ... ] }
//   ]
//
// Semantics (per Power Apps gateway / admin portal contract):
//   - "All"     apply to every portal in the env
//   - "None"    apply to no portals (clears any inclusion / exclusion list)
//   - "Include" apply ONLY to portals listed in ToBeAdded (allow-list)
//   - "Exclude" apply to every portal EXCEPT those in ToBeAdded (block-list)
//
// Transport differences:
//   gateway:      POST /governance          (env id implied by base URL).
//   admin-portal: POST /api/v1/powerPortal/governance/{envId}.
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
const { SUPPORTED_POLICIES, assertPolicy, classifyStatus } = require('./policies');
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
                         [--useAdminPortal --token <bearer>
                            [--principalId <guid>] [--tenantId <guid>]]

Flags:
  --policy           Governance policy name. One of:
                       ${SUPPORTED_POLICIES.join('\n                       ')}
  --portalId         Optional single portal id. Legacy flag.
  --portalIds        Optional comma- or space-separated list of portal ids.
                     Use this for Include / Exclude scopes with multiple
                     portals. When provided, the policy defaults to
                     policyValue="Include" + ToBeAdded=[ids]. When omitted
                     and --portalId is also omitted, defaults to "All".
  --policyValue      Optional explicit policy value (overrides the default
                     derived from --portalId). One of: ${VALID_POLICY_VALUES.join(', ')}.
                     Use "None" for a safe round-trip test of the write path.
  --envId            Environment id (required with --useAdminPortal; falls
                     back to current PAC env on gateway transport).
  --timeoutMinutes   Maximum wait for terminal status (default: ${DEFAULT_TIMEOUT_MIN}).
  --useAdminPortal   Use the admin-portal transport.
  --token            Bearer token for the admin portal.
  --principalId      Caller's Entra Object Id (admin portal only).
  --tenantId         Tenant id (admin portal only).
  --help             Show this help message.

Exit codes:
  0  Roll-out reached a success terminal state
  2  Sign-in required (gateway transport only)
  3  Polling timed out before terminal state
  4  Terminal state reached but it was Failed
  1  Other failure

Stdout (JSON):
  { "status": "applied", "policy", "envId", "portalId", "transport",
    "attempts", "finalValue" }
`;

function buildPolicyPayload(policy, portalIdsArg, policyValueOverride) {
  // Accept either a single portalId string (legacy) or an array of ids.
  let portalIds;
  if (portalIdsArg == null || portalIdsArg === '') {
    portalIds = [];
  } else if (Array.isArray(portalIdsArg)) {
    portalIds = portalIdsArg.filter(Boolean);
  } else {
    portalIds = [portalIdsArg];
  }
  return [
    {
      policyName: policy,
      policyValue:
        policyValueOverride || (portalIds.length > 0 ? 'Include' : 'All'),
      ToBeAdded: portalIds,
      ToBeRemoved: [],
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
  const useAdminPortal = Boolean(args.useAdminPortal);
  const policyValueOverride = args.policyValue || null;
  if (policyValueOverride && !VALID_POLICY_VALUES.includes(policyValueOverride)) {
    fail(`--policyValue must be one of: ${VALID_POLICY_VALUES.join(', ')}`, 1);
  }

  if (useAdminPortal && !args.envId) {
    fail('--useAdminPortal requires --envId (the admin portal URL embeds it).', 1);
  }

  const transportLabel = useAdminPortal ? 'admin-portal' : 'gateway';
  const scopeLabel = portalIds.length > 0
    ? `${portalIds.length} portal(s)`
    : `env ${args.envId || '<current>'}`;
  process.stderr.write(
    `Applying ${args.policy} to ${scopeLabel} via ${transportLabel}...\n`
  );

  const body = buildPolicyPayload(args.policy, portalIds, policyValueOverride);
  const start = await callGovernance({
    op: 'apply',
    envId: args.envId,
    policy: args.policy,
    portalId: portalIds[0] || null,
    body,
    useAdminPortal,
    token: args.token,
    principalId: args.principalId,
    tenantId: args.tenantId,
  });

  // If the POST didn't come back with a clean 2xx, don't bail immediately —
  // the response parsing can produce undefined statusCode for transient blips
  // even when the gateway accepted the upsert. Consult the status endpoint
  // (the source of truth) before reporting failure.
  if (start.statusCode !== 200 && start.statusCode !== 202 && start.statusCode !== 204) {
    if (start.error?.code === 'ContextError') {
      fail(`POST governance failed: ${describeFetchError(start)}`, 2);
    }
    // Status endpoint reality check.
    const postCheck = await callGovernance({
      op: 'getStatus',
      envId: args.envId,
      policy: args.policy,
      useAdminPortal,
      token: args.token,
      principalId: args.principalId,
      tenantId: args.tenantId,
    });
    const postCheckRaw = postCheck.ok ? postCheck.body : null;
    const postCheckValue =
      typeof postCheckRaw === 'string'
        ? postCheckRaw
        : postCheckRaw?.status ?? postCheckRaw?.state ?? postCheckRaw?.value ?? '';
    const postCheckCls = classifyStatus(String(postCheckValue));
    if (postCheckCls === 'success' || postCheckCls === 'in-progress') {
      // POST landed (or is landing) even though our parsing of the POST
      // response was off — log and continue to the polling loop.
      process.stderr.write(
        `  POST response was unparseable (${describeFetchError(start)}); status endpoint reports "${postCheckValue}" — continuing to poll.\n`
      );
    } else {
      fail(`POST governance failed (${start.statusCode != null ? start.statusCode : 'no response'}): ${describeFetchError(start)}`, 1);
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
        useAdminPortal,
        token: args.token,
        principalId: args.principalId,
        tenantId: args.tenantId,
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
      useAdminPortal,
      token: args.token,
      principalId: args.principalId,
      tenantId: args.tenantId,
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
