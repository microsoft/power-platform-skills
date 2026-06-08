#!/usr/bin/env node

// Checks for an inner-loop (Dataverse Git integration) plan and reports
// freshness + execution state. Used as a Phase 0 helper by inner-loop skills
// (plan-inner-loop, commit-to-git, sync-from-git, etc.) — the same shape and
// semantics as `check-alm-plan.js`, but for the inner-loop plan file.
//
// Usage:
//   node inner-loop-plan-state.js --projectRoot <path>
//                                 [--no-heartbeat]
//
// Output (JSON to stdout):
//   {
//     exists:            true | false,
//     planPath:          "<projectRoot>/docs/inner-loop/inner-loop-plan.json" | null,
//     htmlPath:          "<projectRoot>/docs/inner-loop/inner-loop-plan.html" | null,
//     generatedAt:       "<ISO timestamp>" | null,
//     lastInvocationAt:  "<ISO timestamp>" | null,
//     bindingDetected:   true | false,                   // from cached state
//     bindingType:       "environment" | "solution" | null,
//     state:             "Disconnected" | "Connected & Clean" | "Dirty"
//                        | "Stale" | "Mixed" | "Conflicted" | "Broken" | null,
//     pendingCounts:     { changes, updates, conflicts } | null,
//     stale:             true | false,
//     staleness: { reason, detail },
//     inExecution: {
//       status:    "active" | "stale-heartbeat" | "not-running" | "no-plan",
//       reason:    "<human-readable>",
//       windowMin: 60
//     }
//   }
//
// Heartbeat semantics (mirrors check-alm-plan.js):
//   - "active":          PLAN_STATUS === "In Execution" AND lastInvocationAt
//                        within `windowMin` minutes of now. Calling skill's
//                        Phase 0 should pass through silently.
//   - "stale-heartbeat": "In Execution" but heartbeat older than window.
//                        Treat as not-running; gates fire normally.
//   - "not-running":     Any non-"In Execution" status (Idle / Completed / etc.)
//   - "no-plan":         Plan file missing or unreadable.
//
// Heartbeat write: when the plan exists AND PLAN_STATUS === "In Execution",
// this helper writes `LAST_INVOCATION_AT: <now>` back to the plan file before
// returning. Pass `--no-heartbeat` to disable (read-only audits / tests).
//
// Why a separate helper from check-alm-plan.js?
//   The plan file shape, the staleness rules (no solution-modifiedon
//   comparison — the inner loop is per-binding, not per-solution), and the
//   state vocabulary differ enough that conflating them in one helper would
//   harm readability. The two helpers DO share the heartbeat math via
//   `computeInExecution` from check-alm-plan; that function is generic.
//
// Exit 0 always (callers inspect the JSON). Exit 1 on argparse / fatal error.

'use strict';

const fs = require('fs');
const path = require('path');
const { innerLoopPath } = require('./inner-loop-paths');
const { computeInExecution, HEARTBEAT_WINDOW_MIN } = require('./check-alm-plan');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    projectRoot: process.cwd(),
    writeHeartbeat: true,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--no-heartbeat') out.writeHeartbeat = false;
  }
  return out;
}

function emptyResult() {
  return {
    exists: false,
    planPath: null,
    htmlPath: null,
    generatedAt: null,
    lastInvocationAt: null,
    bindingDetected: false,
    bindingType: null,
    state: null,
    pendingCounts: null,
    stale: true,
    staleness: {
      reason: 'no-plan',
      detail: 'Inner-loop plan not found. Run /power-pages:plan-inner-loop to create one.',
    },
    inExecution: {
      status: 'no-plan',
      reason: 'No inner-loop plan file found.',
      windowMin: HEARTBEAT_WINDOW_MIN,
    },
  };
}

/**
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {boolean} [options.writeHeartbeat=true]
 * @param {number} [options.now] Pinned wall clock for tests (ms since epoch).
 */
async function checkInnerLoopPlan({ projectRoot, writeHeartbeat = true, now } = {}) {
  if (!projectRoot) throw new Error('--projectRoot is required');
  const planPath = innerLoopPath(projectRoot, 'plan');
  const htmlPath = innerLoopPath(projectRoot, 'planHtml');
  const nowMs = (typeof now === 'number') ? now : Date.now();

  if (!fs.existsSync(planPath)) {
    return emptyResult();
  }

  let planData;
  try {
    planData = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (e) {
    const r = emptyResult();
    r.staleness = {
      reason: 'no-plan',
      detail: 'docs/inner-loop/inner-loop-plan.json could not be parsed as JSON: ' + e.message,
    };
    return r;
  }

  const priorLastInvocationAt = planData.LAST_INVOCATION_AT || null;
  const planStatus = planData.PLAN_STATUS || null;
  const inExecution = computeInExecution(planStatus, priorLastInvocationAt, nowMs);

  if (writeHeartbeat && planStatus === 'In Execution') {
    try {
      planData.LAST_INVOCATION_AT = new Date(nowMs).toISOString();
      const tmp = planPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(planData, null, 2));
      fs.renameSync(tmp, planPath);
    } catch {
      // Best-effort — a failed heartbeat write must not break the gate check.
    }
  }

  // Pull cached state from the plan file. plan-inner-loop writes these on every
  // refresh; downstream skills consume them to decide their own routing.
  const binding = planData.binding || null;
  const counts = planData.pendingCounts || null;

  return {
    exists: true,
    planPath,
    htmlPath: fs.existsSync(htmlPath) ? htmlPath : null,
    generatedAt: planData.GENERATED_AT || null,
    lastInvocationAt: priorLastInvocationAt,
    bindingDetected: !!(binding && (binding.bindingType || binding.repo)),
    bindingType: binding ? (binding.bindingType || null) : null,
    state: planData.state || null,
    pendingCounts: counts ? {
      changes: typeof counts.changes === 'number' ? counts.changes : null,
      updates: typeof counts.updates === 'number' ? counts.updates : null,
      conflicts: typeof counts.conflicts === 'number' ? counts.conflicts : null,
    } : null,
    stale: false,
    staleness: { reason: null, detail: null },
    inExecution,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  checkInnerLoopPlan(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('inner-loop-plan-state: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { checkInnerLoopPlan, HEARTBEAT_WINDOW_MIN };
