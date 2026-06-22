#!/usr/bin/env node

// Checks for an ALM plan and reports freshness. Used as a Phase 0 gate by ALM
// skills (setup-pipeline, deploy-pipeline, etc.) so the orchestrator
// (plan-alm) becomes the front door for ALM intents.
//
// Usage:
//   node check-alm-plan.js --projectRoot <path>
//                          [--envUrl <url>] [--token <t>] [--solutionId <id>]
//
// Output (JSON to stdout):
//   {
//     exists:     true | false,
//     deferred:   true | false,                          // .alm-deferred marker present
//     deferral:   { reason, deferredBy, ... } | null,    // contents of the marker
//     planPath:   "<projectRoot>/docs/.alm-plan-data.json" | null,
//     htmlPath:   "<projectRoot>/docs/alm-plan.html" | null,
//     generatedAt: "<ISO timestamp>" | null,
//     lastInvocationAt: "<ISO timestamp>" | null,        // heartbeat refreshed by this helper
//     approver:    "..." | null,
//     planStatus:  "Draft" | "Approved" | "In Execution" | "Completed" | null,
//     stale:       true | false,
//     staleness: {
//       reason:    "no-plan" | "solution-modified" | "deferred" | null,
//       detail:    "<human-readable>" | null
//     },
//     inExecution: {
//       status:    "active" | "stale-heartbeat" | "not-running" | "no-plan",
//       reason:    "<human-readable>",
//       windowMin: 60                                    // staleness threshold for the heartbeat
//     }
//   }
//
// Heartbeat semantics (the `inExecution` block):
//   - "active":            planStatus === "In Execution" AND a `lastInvocationAt` exists
//                          AND lastInvocationAt is within `windowMin` minutes of now.
//                          Phase 0 in calling skills should SKIP the no-plan / stale-plan gates.
//   - "stale-heartbeat":   planStatus === "In Execution" but the heartbeat is older than
//                          `windowMin` minutes. Likely a stalled or abandoned orchestration —
//                          treat as "not in execution" (run Phase 0 gates normally).
//   - "not-running":       planStatus is something other than "In Execution" (Draft, Approved,
//                          Completed) — Phase 0 gates run normally.
//   - "no-plan":           plan file doesn't exist or is unreadable — Phase 0 fires the no-plan gate.
//
// Heartbeat write: when the plan exists AND planStatus === "In Execution", this helper
// writes `lastInvocationAt: <now>` back to docs/.alm-plan-data.json before returning.
// This is the "any in-chain skill refreshes the heartbeat" mechanism that lets the
// orchestration survive multi-hour deploys (deploy-pipeline alone can take 60+ minutes
// per stage) without Phase 0 gates incorrectly firing in downstream skills. Pass
// `--no-heartbeat` to disable the write (e.g. for read-only audits / tests).
//
// Deferral handling: if the project root contains a .alm-deferred marker
// (created by the user when they explicitly defer ALM for a project, e.g.
// "ni-dev — handled separately"), the helper reports deferred:true. The
// Phase 0 gate in setup-pipeline / deploy-pipeline should treat this as
// "user-explicit decision, do not nag" — pass through silently to Phase 1
// without recommending plan-alm.
//
// Exit 0 always (callers inspect the JSON). Exit 1 on argparse / fatal error.
//
// Freshness logic:
//   - No plan file -> exists:false, stale:true (reason: "no-plan").
//   - Plan file unreadable -> exists:false, stale:true (reason: "no-plan").
//   - When --envUrl + --token + --solutionId are all provided, query the
//     solution's modifiedon and compare against `max(GENERATED_AT, LAST_SYNC_AT)`.
//     If the solution was modified after that reference point -> stale
//     (reason: "solution-modified").
//   - `LAST_SYNC_AT` is written by `refresh-alm-plan-data.js` when setup-solution
//     runs in sync mode (its bump-then-add operations modify `modifiedon`, so
//     without this field every post-sync invocation would incorrectly report
//     stale: true). Acts as a "the plan accepts changes up to this timestamp"
//     marker — orchestrations that finished sync expect their next
//     setup-pipeline / deploy-pipeline / etc. to see stale:false.
//   - Without env credentials, the helper returns stale:false based on
//     existence alone — callers that want a deeper check can run
//     discover-site-components.js separately.

'use strict';

const fs = require('fs');
const path = require('path');
const helpers = require('./validation-helpers');
const { planDataPath, planHtmlPath } = require('./alm-paths');

// Heartbeat window — how recent `lastInvocationAt` must be for the plan to count
// as actively executing. 60 minutes is comfortably larger than the longest single
// skill runtime (deploy-pipeline can take 60 min for a large solution import), and
// any in-chain skill's Phase 0 check refreshes the heartbeat on entry so the chain
// stays "active" as long as something is making forward progress.
const HEARTBEAT_WINDOW_MIN = 60;

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    projectRoot: process.cwd(),
    envUrl: null,
    token: null,
    solutionId: null,
    writeHeartbeat: true,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
    else if (args[i] === '--no-heartbeat') out.writeHeartbeat = false;
  }
  return out;
}

function emptyResult(extraStaleness) {
  return {
    exists: false,
    deferred: false,
    deferral: null,
    planPath: null,
    htmlPath: null,
    generatedAt: null,
    lastInvocationAt: null,
    approver: null,
    planStatus: null,
    stale: true,
    staleness: extraStaleness || { reason: 'no-plan', detail: 'ALM plan not found. Run /power-pages:plan-alm to create one.' },
    inExecution: { status: 'no-plan', reason: 'No ALM plan file found.', windowMin: HEARTBEAT_WINDOW_MIN },
  };
}

// Compute the `inExecution` block from the plan status + heartbeat timestamp.
// Caller-supplied `now` lets tests pin the clock; defaults to Date.now().
function computeInExecution(planStatus, lastInvocationAt, now) {
  if (planStatus !== 'In Execution') {
    return {
      status: 'not-running',
      reason: `planStatus is '${planStatus || 'null'}' (not 'In Execution').`,
      windowMin: HEARTBEAT_WINDOW_MIN,
    };
  }
  if (!lastInvocationAt) {
    // In Execution but no heartbeat yet — could be the very first invocation
    // since plan-alm wrote PLAN_STATUS. Treat as active so the first skill in
    // the chain doesn't fire its no-plan gate; the heartbeat is written below.
    return {
      status: 'active',
      reason: 'planStatus is In Execution and this is the first heartbeat.',
      windowMin: HEARTBEAT_WINDOW_MIN,
    };
  }
  const heartbeatMs = Date.parse(lastInvocationAt);
  if (!Number.isFinite(heartbeatMs)) {
    return {
      status: 'stale-heartbeat',
      reason: `lastInvocationAt='${lastInvocationAt}' is not a parseable ISO timestamp.`,
      windowMin: HEARTBEAT_WINDOW_MIN,
    };
  }
  const ageMin = (now - heartbeatMs) / 60000;
  if (ageMin > HEARTBEAT_WINDOW_MIN) {
    return {
      status: 'stale-heartbeat',
      reason: `Last in-chain invocation was ${Math.round(ageMin)}min ago (window=${HEARTBEAT_WINDOW_MIN}min). Orchestration likely stalled.`,
      windowMin: HEARTBEAT_WINDOW_MIN,
    };
  }
  return {
    status: 'active',
    reason: `Last in-chain invocation was ${Math.round(ageMin)}min ago (within ${HEARTBEAT_WINDOW_MIN}min window).`,
    windowMin: HEARTBEAT_WINDOW_MIN,
  };
}

function readDeferralLocal(projectRoot) {
  // Inline minimal version (matches readDeferralMarker in validation-helpers).
  // Kept here so this helper stays standalone and can be invoked from any cwd.
  if (!projectRoot) return null;
  const markerPath = path.join(projectRoot, '.alm-deferred');
  if (!fs.existsSync(markerPath)) return null;
  let raw = '';
  try { raw = fs.readFileSync(markerPath, 'utf8'); } catch {}
  let info = null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try { info = JSON.parse(trimmed); } catch {}
  }
  return { path: markerPath, raw, info };
}

async function checkAlmPlan({ projectRoot, envUrl, token, solutionId, makeRequest, writeHeartbeat = true, now }) {
  if (!projectRoot) throw new Error('--projectRoot is required');
  const planPath = planDataPath(projectRoot);
  const htmlPath = planHtmlPath(projectRoot);
  const nowMs = (typeof now === 'number') ? now : Date.now();

  // Deferral marker check — runs first, regardless of plan presence.
  // When deferred, the Phase 0 gate in calling skills should pass through
  // without nagging the user about a missing plan.
  const deferral = readDeferralLocal(projectRoot);
  if (deferral) {
    const reason = (deferral.info && (deferral.info.reason || deferral.info.detail))
      || (deferral.raw && deferral.raw.trim())
      || 'ALM explicitly deferred for this project (.alm-deferred marker present).';
    return {
      exists: false,
      deferred: true,
      deferral: deferral.info || { reason },
      planPath: null,
      htmlPath: null,
      generatedAt: null,
      lastInvocationAt: null,
      approver: null,
      planStatus: null,
      stale: false,                        // Not stale — deferred is a deliberate state.
      staleness: { reason: 'deferred', detail: 'ALM deferred: ' + reason },
      inExecution: { status: 'not-running', reason: 'ALM deferred for this project.', windowMin: HEARTBEAT_WINDOW_MIN },
    };
  }

  if (!fs.existsSync(planPath)) {
    return emptyResult();
  }

  let planData;
  try {
    planData = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (e) {
    return emptyResult({
      reason: 'no-plan',
      detail: 'docs/.alm-plan-data.json could not be parsed as JSON: ' + e.message,
    });
  }

  // Refresh the heartbeat when the plan is actively executing. We READ the
  // existing value first (it drives the `inExecution.status` classification
  // for this very call) and then WRITE the refreshed timestamp back — that
  // way each in-chain skill's Phase 0 call both observes the prior heartbeat
  // (for its own decision) AND keeps the chain alive for the next skill.
  const priorLastInvocationAt = planData.LAST_INVOCATION_AT || null;
  const priorPlanStatus = planData.PLAN_STATUS || null;

  // Classify `inExecution` from the PRIOR on-disk status, BEFORE any promotion.
  // An Approved plan is NOT yet an active orchestration — the user has just
  // approved it and this is the first execution skill to reach its Phase 0 gate.
  // If we promoted to "In Execution" first and then classified, computeInExecution
  // would return status:"active" (the "first heartbeat" branch) — and callers that
  // skip Phase 0 gates whenever inExecution.status === "active" (see deploy-pipeline
  // SKILL.md Phase 0) would take the active shortcut and bypass the stale-plan
  // confirmation that this helper computes further below. That would mask stale:true
  // on the FIRST execution after approval — defeating the ALM freshness gate exactly
  // when the source solution was modified between plan generation and approval. So
  // the first Approved->In Execution entry reports inExecution:"not-running", keeping
  // THIS caller on the normal Phase 0 path where it still honors stale:true. The
  // promotion is persisted below, so the NEXT in-chain skill reads "In Execution"
  // and correctly classifies as "active".
  const inExecution = computeInExecution(priorPlanStatus, priorLastInvocationAt, nowMs);

  // Promote Approved -> In Execution on the FIRST execution-skill Phase 0 entry and
  // persist it (+ the first heartbeat) so the NEXT in-chain skill sees an active
  // orchestration. plan-alm is plan-only: it leaves the plan "Approved" and the user
  // runs the execution skills themselves, so the first execution skill to reach its
  // Phase 0 gate is what actually starts execution — this is the transition that
  // activates the heartbeat/active-chain machinery (nothing else sets it). The
  // heartbeat write below then persists both the new status AND the first heartbeat
  // in one atomic write. This promotion intentionally does NOT change `inExecution`
  // for THIS caller (classified above from the prior status). Gated on `writeHeartbeat`
  // so read-only callers (--no-heartbeat: audits, tests, and plan-alm's own deferral
  // check) never mutate the plan's status.
  let planStatus = priorPlanStatus;
  if (writeHeartbeat && planStatus === 'Approved') {
    planStatus = 'In Execution';
    planData.PLAN_STATUS = 'In Execution';
  }

  if (writeHeartbeat && planStatus === 'In Execution') {
    try {
      planData.LAST_INVOCATION_AT = new Date(nowMs).toISOString();
      // Tmp-file + rename for atomicity — a concurrent read mid-write should
      // never see a half-written file. (Cross-process races on Windows are
      // possible but plan-alm orchestrations are single-process.)
      const tmp = planPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(planData, null, 2));
      fs.renameSync(tmp, planPath);
    } catch {
      // Best-effort — a failed heartbeat write must not break the gate check.
      // Subsequent calls will see the stale heartbeat and reclassify as
      // `stale-heartbeat` after windowMin elapses.
    }
  }

  const result = {
    exists: true,
    deferred: false,
    deferral: null,
    planPath,
    htmlPath: fs.existsSync(htmlPath) ? htmlPath : null,
    generatedAt: planData.GENERATED_AT || null,
    lastInvocationAt: priorLastInvocationAt,
    approver: planData.APPROVED_BY || null,
    planStatus,
    stale: false,
    staleness: { reason: null, detail: null },
    inExecution,
  };

  // Optional: solution modifiedon vs plan GENERATED_AT comparison.
  if (envUrl && token && solutionId) {
    const url = envUrl.replace(/\/+$/, '') +
      '/api/data/v9.2/solutions(' + solutionId + ')?$select=modifiedon,version';
    let res;
    try {
      res = await (makeRequest || helpers.makeRequest)({
        url,
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          'OData-Version': '4.0',
          'OData-MaxVersion': '4.0',
          Accept: 'application/json',
        },
        timeout: 10000,
      });
    } catch {
      // Network errors are non-fatal — skip the check
      return result;
    }

    if (res && res.statusCode === 200 && res.body) {
      let sol;
      try { sol = JSON.parse(res.body); } catch { return result; }
      const modOn = sol.modifiedon;
      if (modOn && result.generatedAt) {
        // Reference point = the LATER of GENERATED_AT and LAST_SYNC_AT.
        // setup-solution sync mode writes LAST_SYNC_AT (via refresh-alm-plan-data.js
        // refreshSetupSolution) because its bump-then-add operations bump
        // `modifiedon` past GENERATED_AT — without LAST_SYNC_AT, every
        // subsequent Phase 0 check would falsely flag the plan as stale.
        const lastSyncAt = planData.LAST_SYNC_AT || null;
        const planTime = Date.parse(result.generatedAt);
        const syncTime = lastSyncAt ? Date.parse(lastSyncAt) : NaN;
        const refTime = Number.isFinite(syncTime) ? Math.max(planTime, syncTime) : planTime;
        const solTime = Date.parse(modOn);
        if (Number.isFinite(refTime) && Number.isFinite(solTime) && solTime > refTime) {
          const refLabel = Number.isFinite(syncTime) && syncTime > planTime
            ? 'last sync at ' + lastSyncAt
            : 'plan generated at ' + result.generatedAt;
          result.stale = true;
          result.staleness = {
            reason: 'solution-modified',
            detail: 'Solution was modified at ' + modOn + ' (after ' + refLabel + '). Components may have changed since.',
          };
        }
      }
    }
  }

  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  checkAlmPlan(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => { process.stderr.write('check-alm-plan: ' + e.message + '\n'); process.exit(1); });
}

module.exports = { checkAlmPlan, computeInExecution, HEARTBEAT_WINDOW_MIN };
