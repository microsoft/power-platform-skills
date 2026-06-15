#!/usr/bin/env node

// Refreshes docs/inner-loop/inner-loop-plan.json with post-run state from
// the marker files written by inner-loop skills (git-configure, git-sync,
// revert-workspace, revert-branch, open-pr, diagnose-git-integration).
//
// plan-inner-loop writes the plan file once at orchestration start, reflecting
// the state at that moment (binding, pending counts, classified state). After
// each downstream skill runs, the cached state goes stale. This helper
// re-ingests the freshly-written marker so the next plan-inner-loop invocation
// (or any reader of the plan file) sees current state without redoing
// discovery from scratch.
//
// This is the inner-loop sibling of `refresh-alm-plan-data.js`.
//
// Usage:
//   node refresh-inner-loop-plan-data.js
//     --projectRoot <path>
//     --phase <git-configure|git-sync|revert-workspace
//             |revert-branch|open-pr|diagnose|finalize>
//     [--state-only]      only flip PLAN_STATUS / step status (skip marker read)
//
// What gets refreshed per phase:
//   git-configure:
//     - binding from last-git-configure.json
//     - state -> "Connected & Clean" (assumes a fresh bind has no pending work)
//   git-sync:
//     - lastCommit from last-commit.json (sha, message, components)
//     - lastValidation from last-validation.json (dry-run pre-flight)
//     - lastSync from last-sync.json (pulled updates list)
//     - lastConflictResolution from last-conflict-resolution.json
//     - pendingCounts updated only for marker-backed mutations
//     - state recomputed from the remaining counts
//   revert-workspace:
//     - pendingCounts.changes -> 0
//     - state -> "Connected & Clean" (if updates/conflicts are also 0) else Stale/Conflicted
//   revert-branch:
//     - last-branch-revert.json metadata recorded; pending counts NOT changed
//       (the env still believes it's clean; teammates must sync to see the revert)
//   open-pr:
//     - lastPr from last-pr.json (url, title, description) — pure record
//   diagnose:
//     - lastDiagnosis from last-diagnosis.json — pure record
//   finalize:
//     - PLAN_STATUS = "Completed"
//
// All marker-file reads are best-effort: a missing marker is a silent no-op
// (caller may have run a downstream skill without using its validator), not
// an error. The plan file is rewritten atomically (tmp + rename).
//
// Exit 0 always (no-op on missing plan file or marker). Exit 1 only on
// argparse / fatal error.

'use strict';

const fs = require('fs');
const path = require('path');
const { innerLoopPath } = require('./inner-loop-paths');
const { gitConfigurePath } = require('./git-configure-paths');

const PHASES = new Set([
  'git-configure',
  'git-sync',
  'revert-workspace',
  'revert-branch',
  'open-pr',
  'diagnose',
  'finalize',
]);

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { projectRoot: process.cwd(), phase: null, stateOnly: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--phase' && args[i + 1]) out.phase = args[++i];
    else if (args[i] === '--state-only') out.stateOnly = true;
  }
  return out;
}

function readJsonMarker(projectRoot, key) {
  const p = innerLoopPath(projectRoot, key);
  return readJsonFile(p);
}

function readGitConfigureMarker(projectRoot) {
  return readJsonFile(gitConfigurePath(projectRoot, 'lastGitConfigure'));
}

function readJsonFile(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writePlan(planPath, planData) {
  const tmp = planPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(planData, null, 2));
  fs.renameSync(tmp, planPath);
}

// Classify state from binding presence + pending counts. Mirrors §1 of
// references/inner-loop-flow.md. Caller is expected to have set the counts
// before calling this (handlers below do so).
function classifyState(binding, counts) {
  if (!binding) return 'Disconnected';
  if (!counts) return null;
  const c = counts.conflicts || 0;
  const ch = counts.changes || 0;
  const u = counts.updates || 0;
  if (c > 0) return 'Conflicted';
  if (ch > 0 && u > 0) return 'Mixed';
  if (ch > 0) return 'Dirty';
  if (u > 0) return 'Stale';
  return 'Connected & Clean';
}

function ensureCountsShape(planData) {
  if (!planData.pendingCounts || typeof planData.pendingCounts !== 'object') {
    planData.pendingCounts = { changes: 0, updates: 0, conflicts: 0 };
  } else {
    if (typeof planData.pendingCounts.changes !== 'number') planData.pendingCounts.changes = 0;
    if (typeof planData.pendingCounts.updates !== 'number') planData.pendingCounts.updates = 0;
    if (typeof planData.pendingCounts.conflicts !== 'number') planData.pendingCounts.conflicts = 0;
  }
}

const HANDLERS = {
  'git-configure': (planData, projectRoot) => {
    const marker = readGitConfigureMarker(projectRoot);
    if (marker) {
      planData.lastGitConfigure = marker;
      if (marker.mode === 'disconnect') {
        planData.binding = null;
      } else {
        planData.binding = {
          bindingType: marker.bindingType || planData.binding && planData.binding.bindingType || null,
          organization: marker.organization || null,
          project: marker.project || null,
          repository: marker.repository || null,
          branch: marker.newBranch || marker.branch || null,
          gitFolder: marker.gitFolder || null,
          rootFolder: marker.rootFolder || null,
          solutionUniqueName: marker.solutionUniqueName || null,
          boundAt: marker.boundAt || marker.completedAt || marker.ranAt || null,
        };
      }
    }
    planData.pendingCounts = { changes: 0, updates: 0, conflicts: 0 };
    planData.state = classifyState(planData.binding, planData.pendingCounts);
  },
  'git-sync': (planData, projectRoot) => {
    const commit = readJsonMarker(projectRoot, 'lastCommit');
    if (commit) planData.lastCommit = commit;

    // git-sync --dry-run writes last-validation.json without mutating Dataverse.
    // Surface it, but only zero Changes when a real commit marker exists.
    const validation = readJsonMarker(projectRoot, 'lastValidation');
    if (validation) planData.lastValidation = validation;

    const sync = readJsonMarker(projectRoot, 'lastSync');
    if (sync) planData.lastSync = sync;

    const conflict = readJsonMarker(projectRoot, 'lastConflictResolution');
    if (conflict) planData.lastConflictResolution = conflict;

    ensureCountsShape(planData);
    if (commit) planData.pendingCounts.changes = 0;
    if (sync) {
      planData.pendingCounts.updates = 0;
      // Pull might surface new conflicts before completing; trust the marker if it says so.
      if (typeof sync.conflictsAfter === 'number') {
        planData.pendingCounts.conflicts = sync.conflictsAfter;
      }
    }
    if (conflict) planData.pendingCounts.conflicts = 0;
    planData.state = classifyState(planData.binding, planData.pendingCounts);
  },
  'revert-workspace': (planData, projectRoot) => {
    const marker = readJsonMarker(projectRoot, 'lastRevert');
    if (marker) planData.lastRevert = marker;
    ensureCountsShape(planData);
    planData.pendingCounts.changes = 0;
    planData.state = classifyState(planData.binding, planData.pendingCounts);
  },
  'revert-branch': (planData, projectRoot) => {
    const marker = readJsonMarker(projectRoot, 'lastBranchRevert');
    if (marker) planData.lastBranchRevert = marker;
    // Note: env's pending counts are NOT changed. The reverted branch HEAD
    // will surface as Updates on the next refresh-changes-from-git call.
  },
  'open-pr': (planData, projectRoot) => {
    const marker = readJsonMarker(projectRoot, 'lastPr');
    if (marker) planData.lastPr = marker;
  },
  'diagnose': (planData, projectRoot) => {
    const marker = readJsonMarker(projectRoot, 'lastDiagnosis');
    if (marker) planData.lastDiagnosis = marker;
  },
  'finalize': (planData) => {
    planData.PLAN_STATUS = 'Completed';
    planData.COMPLETED_AT = new Date().toISOString();
  },
};

async function refreshInnerLoopPlanData({ projectRoot, phase, stateOnly = false } = {}) {
  if (!projectRoot) throw new Error('--projectRoot is required');
  if (!phase) throw new Error('--phase is required (one of: ' + Array.from(PHASES).join(', ') + ')');
  if (!PHASES.has(phase)) throw new Error('Unknown phase: ' + phase);

  const planPath = innerLoopPath(projectRoot, 'plan');
  if (!fs.existsSync(planPath)) {
    return { ok: false, phase, reason: 'plan-not-found', planPath };
  }

  let planData;
  try {
    planData = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch (e) {
    return { ok: false, phase, reason: 'plan-unparseable', error: e.message, planPath };
  }

  if (stateOnly) {
    // Re-classify state from current counts only; skip marker reads.
    planData.state = classifyState(planData.binding, planData.pendingCounts);
  } else {
    const handler = HANDLERS[phase];
    handler(planData, projectRoot);
  }

  planData.LAST_REFRESH_AT = new Date().toISOString();

  try {
    writePlan(planPath, planData);
  } catch (e) {
    return { ok: false, phase, reason: 'plan-write-failed', error: e.message, planPath };
  }

  return { ok: true, phase, planPath, state: planData.state, pendingCounts: planData.pendingCounts || null };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  refreshInnerLoopPlanData(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('refresh-inner-loop-plan-data: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { refreshInnerLoopPlanData, classifyState, PHASES };
