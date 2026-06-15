#!/usr/bin/env node

// Single source of truth for inner-loop (Dataverse Git integration) artifact paths.
//
// Every inner-loop state file lives under `<projectRoot>/docs/inner-loop/`
// rather than the project root. This mirrors the ALM separation in
// `alm-paths.js` (which puts ALM artifacts under `docs/alm/`) and keeps the
// project root from accumulating dot-files as developers iterate through
// commit / sync / resolve-conflicts cycles.
//
// The two loops are intentionally kept in sibling folders, not nested:
//   docs/
//     alm/            outer-loop (cross-environment promotion, pipelines)
//     inner-loop/     inner-loop (per-env Git binding, daily commits)
//
// One file lives at the project root (NOT under docs/inner-loop/), by design:
//   .git-integration-manifest.json     binding type / repo / branch / folder /
//                                      solution unique name / last commit SHA.
//                                      Sits at root because every inner-loop
//                                      skill reads it during Phase 1, the same
//                                      way every ALM skill reads
//                                      .solution-manifest.json.
//
// All callers must require this module instead of inlining
// `path.join(root, 'docs/inner-loop/last-*.json')`. The frozen FILE_NAMES
// table makes typos a hard error (almPath('lastCommt') throws).

'use strict';

const fs = require('fs');
const path = require('path');

const INNER_LOOP_DIR = 'docs/inner-loop';

const FILE_NAMES = Object.freeze({
  // Orchestrator state (written by plan-inner-loop)
  plan:                      'inner-loop-plan.json',
  planHtml:                  'inner-loop-plan.html',

  // Skill-run markers (written when a skill completes)
  // NOTE: `git-configure` (which merged setup-git-integration + connect-solution-to-git +
  // branch-switch) writes its own marker via `git-configure-paths.js` (last-git-configure.json
  // / last-git-configure-validation.json / git-configure-plan-data.json), NOT through this
  // table. Lifecycle isolation is documented at the top of git-configure-paths.js.
  lastCommit:                'last-commit.json',
  lastSync:                  'last-sync.json',
  lastValidation:            'last-validation.json',
  lastConflictResolution:    'last-conflict-resolution.json',
  lastRevert:                'last-revert.json',
  lastBranchRevert:          'last-branch-revert.json',
  lastPr:                    'last-pr.json',
  lastDiagnosis:             'last-diagnosis.json',

  // Human-readable HTML reports (written by their respective skills)
  preCommitReportHtml:       'pre-commit-report.html',
  conflictsHtml:             'conflicts.html',
  diagnosisHtml:             'diagnosis.html',

  // Transient internal state for validate-pending-changes (not user-facing).
  // - Snapshot is the materialised list-pending-changes output that the 5
  //   pre-flight validators consume via --pending-file. Overwritten each run.
  // - Cache is a TTL-bounded memo of the same payload keyed by
  //   (boundSyncedCommitId, pendingChangesCount, solutionUniqueName), used to
  //   skip the full Dataverse list call when a user re-runs the skill after
  //   fixing a blocker. See scripts/lib/pending-changes-cache.js.
  pendingChangesSnapshot:    'pending-changes-snapshot.json',
  pendingChangesCache:       'pending-changes-cache.json',

  // Optional CI-friendly emissions from run-prevalidators.js. Written only
  // when the orchestrator runs with --format junit / --format sarif (the
  // default --format json still goes to lastValidation). Both formats
  // describe the same findings; pipelines pick whichever they ingest.
  lastValidationJunit:       'last-validation.junit.xml',
  lastValidationSarif:       'last-validation.sarif',

  // Append-only JSONL journal written by every inner-loop skill run via
  // scripts/lib/append-skill-metric.js. One JSON-encoded line per run with
  // {ts, skill, durationMs, commitId?, pollAttempts?, componentsCommitted?,
  // payloadBytes?, branch?, status, ...}. Used for trend analysis ("commits
  // got 3× slower this week") and ALM health dashboards. Append-only so
  // concurrent writers never clobber each other.
  skillMetricsJsonl:         'skill-metrics.jsonl',

  // Ticket file written by commit-to-git --background when the helper POSTs
  // CommitToGit and returns immediately. Carries the spawned poller's PID
  // and the commitId stub so a follow-up `commit-to-git --background-status`
  // can find the polling process and read last-commit.json once it lands.
  pendingCommitTicket:       'pending-commit-ticket.json',

  // Last-known git tag (C-13) — written by commit-to-git Phase 9 after a
  // user-accepted tag-offer choice. Captures { name, tagSha, commitSha,
  // url, taggedAt }.
  lastTag:                   'last-tag.json',
});

/**
 * Returns the absolute directory path that holds the inner-loop artifacts.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function innerLoopDir(projectRoot) {
  if (!projectRoot) throw new Error('innerLoopDir: projectRoot is required');
  return path.join(projectRoot, INNER_LOOP_DIR);
}

/**
 * Returns the absolute path of an inner-loop artifact for a given logical key.
 * Use the keys from FILE_NAMES (e.g. 'lastCommit', 'plan', 'conflictsHtml').
 *
 * @param {string} projectRoot
 * @param {keyof typeof FILE_NAMES} key
 * @returns {string}
 */
function innerLoopPath(projectRoot, key) {
  const fileName = FILE_NAMES[key];
  if (!fileName) throw new Error(`innerLoopPath: unknown key '${key}'`);
  return path.join(innerLoopDir(projectRoot), fileName);
}

/**
 * Creates `<projectRoot>/docs/inner-loop/` if it doesn't exist. Idempotent.
 * Callers should invoke this once before any write to an inner-loop artifact.
 *
 * @param {string} projectRoot
 * @returns {string} The absolute inner-loop dir path
 */
function ensureInnerLoopDir(projectRoot) {
  const dir = innerLoopDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Path to the Git-integration manifest at the project root.
 * NOT under docs/inner-loop/ — see file header comment for rationale.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function gitIntegrationManifestPath(projectRoot) {
  if (!projectRoot) throw new Error('gitIntegrationManifestPath: projectRoot is required');
  return path.join(projectRoot, '.git-integration-manifest.json');
}

/**
 * Resolves the project root for an inner-loop helper, centralising the
 * deprecation policy for the legacy "guess the root from cwd" behaviour.
 *
 * Passing `--project-root` explicitly is the supported path: it guarantees
 * artifacts land under the intended `<projectRoot>/docs/inner-loop/` and never
 * pollute an unrelated ancestor that happens to match a project heuristic.
 *
 * Migration runway:
 *   - Today: if `projectRoot` is absent, emit a one-line deprecation WARN to
 *     stderr and fall back to `fallbackResolver()` (or cwd).
 *   - After RUNWAY_HARD_ERROR_DATE: callers should flip this to a hard error.
 *     The date is surfaced in the warning so operators can plan.
 *
 * @param {string|null|undefined} projectRoot  The explicitly-provided root, if any.
 * @param {object} [options]
 * @param {string} [options.caller]            Helper name, for the warning text.
 * @param {() => (string|null)} [options.fallbackResolver]  Legacy resolver (e.g. findProjectRoot(cwd)).
 * @param {(msg: string) => void} [options._warn]  DI hook for tests.
 * @returns {string} The resolved project root.
 */
const RUNWAY_HARD_ERROR_DATE = '2026-07-13'; // 30-day runway from 2026-06-13

function requireProjectRoot(projectRoot, { caller = 'inner-loop helper', fallbackResolver = null, _warn = null } = {}) {
  if (projectRoot) return projectRoot;
  const fallback = typeof fallbackResolver === 'function' ? fallbackResolver() : null;
  const target = fallback || process.cwd();
  const warn = typeof _warn === 'function' ? _warn : (m) => process.stderr.write(m);
  warn(
    `[DEPRECATION WARN] ${caller}: --project-root was not provided; falling back to ` +
    `'${target}'. This fallback becomes a hard error after ${RUNWAY_HARD_ERROR_DATE}. ` +
    `Pass --project-root <path> explicitly to keep artifacts out of an unintended ancestor.\n`
  );
  return target;
}

module.exports = {
  INNER_LOOP_DIR,
  FILE_NAMES,
  innerLoopDir,
  innerLoopPath,
  ensureInnerLoopDir,
  gitIntegrationManifestPath,
  requireProjectRoot,
  RUNWAY_HARD_ERROR_DATE,
};
