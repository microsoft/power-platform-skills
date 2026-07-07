#!/usr/bin/env node

// Single source of truth for ALM artifact paths.
//
// Every ALM-only state file (plan context, size estimate, split plan,
// host resolution, env-var snapshot, and the eight `.last-*.json` markers)
// lives under `<projectRoot>/docs/alm/` rather than the project root. This
// keeps the root uncluttered for users who otherwise see ~13 dot-files in
// `git status` after any ALM run.
//
// NOT moved here (intentionally — see CLAUDE.md):
//   - .solution-manifest.json   (referenced by non-ALM skills too)
//   - .datamodel-manifest.json  (written by setup-datamodel, not ALM)
//   - .alm-config.json          (user-authored config dotfile)
//   - .alm-deferred             (project-level opt-out marker)
//   - deployment-settings.json  (Microsoft-standard schema, expected at root)
//   - docs/alm-plan.html, docs/.alm-plan-data.json, docs/alm-migration-plan.md
//     docs/pipeline-setup.md, docs/ci-cd-setup.md (already under docs/)
//
// All callers must require this module instead of inlining `path.join(root, '.last-*.json')`.

const fs = require('fs');
const path = require('path');

const ALM_DIR = 'docs/alm';

const FILE_NAMES = Object.freeze({
  // Plan / decision context (written during plan-alm phases)
  planContext:       'alm-plan-context.json',
  sizeEstimate:      'alm-size-estimate.json',
  splitPlan:         'alm-split-plan.json',
  hostResolution:    'alm-host-resolution.json',
  envVars:           'alm-env-vars.json',

  // Skill-run markers (written when a skill completes)
  lastPipeline:      'last-pipeline.json',
  lastDeploy:        'last-deploy.json',
  lastHostCheck:     'last-host-check.json',
  lastImport:        'last-import.json',
  lastActivate:      'last-activate.json',
  lastTestSite:      'last-test-site.json',
  lastForceLink:     'last-force-link.json',
  lastEnvVars:       'last-env-vars.json',
  lastExport:        'last-export.json',
});

/**
 * Returns the absolute directory path that holds the ALM artifacts.
 * Callers should pass an absolute projectRoot; relative is tolerated.
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function almDir(projectRoot) {
  if (!projectRoot) throw new Error('almDir: projectRoot is required');
  return path.join(projectRoot, ALM_DIR);
}

/**
 * Returns the absolute path of an ALM artifact for a given logical key.
 * Use the keys from FILE_NAMES (e.g. 'lastDeploy', 'planContext').
 *
 * @param {string} projectRoot
 * @param {keyof typeof FILE_NAMES} key
 * @returns {string}
 */
function almPath(projectRoot, key) {
  const fileName = FILE_NAMES[key];
  if (!fileName) throw new Error(`almPath: unknown key '${key}'`);
  return path.join(almDir(projectRoot), fileName);
}

/**
 * Creates `<projectRoot>/docs/alm/` if it doesn't exist. Idempotent.
 * Callers should invoke this once before any write to an ALM artifact.
 *
 * @param {string} projectRoot
 * @returns {string} The absolute ALM dir path
 */
function ensureAlmDir(projectRoot) {
  const dir = almDir(projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The rendered plan + its backing JSON live at the `docs/` ROOT (NOT under
// `docs/alm/`): `docs/alm-plan.html` and `docs/.alm-plan-data.json`. Centralized
// here so the PostToolUse hook, check-alm-plan.js, and refresh-alm-plan-data.js
// can't drift on the path.
const PLAN_DATA_FILE = '.alm-plan-data.json';
const PLAN_HTML_FILE = 'alm-plan.html';

function planDataPath(projectRoot) {
  if (!projectRoot) throw new Error('planDataPath: projectRoot is required');
  return path.join(projectRoot, 'docs', PLAN_DATA_FILE);
}

function planHtmlPath(projectRoot) {
  if (!projectRoot) throw new Error('planHtmlPath: projectRoot is required');
  return path.join(projectRoot, 'docs', PLAN_HTML_FILE);
}

module.exports = {
  ALM_DIR,
  FILE_NAMES,
  PLAN_DATA_FILE,
  PLAN_HTML_FILE,
  almDir,
  almPath,
  ensureAlmDir,
  planDataPath,
  planHtmlPath,
};
