#!/usr/bin/env node
/**
 * validate-git-configure.js — PostToolUse hook validator.
 *
 * Checks that the `git-configure` skill completed successfully by verifying
 * `docs/inner-loop/last-git-configure.json` was written with the required
 * fields for the mode that ran, AND that the project-root
 * `.git-integration-manifest.json` is consistent with the marker (so the
 * SKILL.md cannot silently forget to update the manifest after a successful
 * Dataverse mutation).
 *
 * Four modes have distinct success contracts:
 *   • setup       — fresh bind; manifest must exist with marker's
 *                   org/project/repo/branch.
 *   • switch-branch — manifest's `branch` must equal marker's `newBranch`,
 *                     and `oldBranch !== newBranch` (no-op switch is a fail).
 *   • rebind      — manifest must exist; manifest's org/project/repo must
 *                   match marker's NEW coords (not the OLD ones the
 *                   rebind disconnected from).
 *   • disconnect  — manifest's binding must be CLEARED (file deleted or
 *                   `bound:false`). A leftover binding means the manifest
 *                   wasn't reconciled after `DisconnectFromGit`.
 *
 * Blocks when:
 *   - The marker exists but is not valid JSON
 *   - `skill` field is missing or != 'git-configure'
 *   - `mode` is not one of the 4 valid modes
 *   - `status` is "failed"
 *   - Required-for-mode fields are missing
 *   - The mode-specific manifest cross-check fails
 *
 * Gracefully approves when:
 *   - No project root found
 *   - No marker file found (skill wasn't run in this session)
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  runValidation, findProjectRoot, block, approve,
} = require('../../../scripts/lib/validation-helpers');
const { gitConfigurePath, FILE_NAMES } = require('../../../scripts/lib/git-configure-paths');
const { gitIntegrationManifestPath } = require('../../../scripts/lib/inner-loop-paths');

const VALID_MODES = new Set(['setup', 'switch-branch', 'rebind', 'disconnect']);

const COMMON_REQUIRED = ['skill', 'mode', 'ranAt', 'envUrl', 'status'];

const PER_MODE_REQUIRED = Object.freeze({
  setup:           ['organization', 'project', 'repository', 'branch', 'gitFolder', 'bindingType'],
  'switch-branch': ['organization', 'project', 'repository', 'oldBranch', 'newBranch', 'gitFolder'],
  rebind:          ['organization', 'project', 'repository', 'branch', 'gitFolder',
                    'oldOrganization', 'oldProject', 'oldRepository'],
  disconnect:      ['organization', 'project', 'repository', 'branch', 'gitFolder'],
});

function stripRefsPrefix(b) {
  if (typeof b !== 'string') return b;
  return b.replace(/^refs\/heads\//, '');
}

/**
 * Cross-check the project-root manifest matches what the marker claims.
 * Returns null when consistent, or a `block()`-able reason string.
 */
function crossCheckManifest(marker, manifestPath) {
  const mode = marker.mode;
  const manifestExists = fs.existsSync(manifestPath);

  // Disconnect mode: manifest must be ABSENT or have bound:false.
  if (mode === 'disconnect') {
    if (!manifestExists) return null;  // file removed = correct
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      return `.git-integration-manifest.json is not valid JSON after disconnect: ${e.message}`;
    }
    if (manifest && manifest.bound === true) {
      return (
        'Disconnect succeeded on the platform but .git-integration-manifest.json still ' +
        `reports bound:true (organization "${manifest.organization || '?'}"). ` +
        'Delete the manifest file or set bound:false to reconcile.'
      );
    }
    return null;
  }

  // All other modes: manifest MUST exist after the run.
  if (!manifestExists) {
    return (
      'Skill reports success but .git-integration-manifest.json is missing at the project root. ' +
      `${mode} mode must write the manifest so subsequent inner-loop skills can detect the binding.`
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return `.git-integration-manifest.json is not valid JSON: ${e.message}`;
  }

  // For switch-branch: manifest.branch must equal marker.newBranch.
  if (mode === 'switch-branch') {
    const expected = stripRefsPrefix(marker.newBranch);
    const actual = stripRefsPrefix(manifest.branch);
    if (expected && actual && expected !== actual) {
      return (
        `.git-integration-manifest.json branch ("${manifest.branch}") does not match ` +
        `last-git-configure.json newBranch ("${marker.newBranch}"). ` +
        'The manifest was not updated alongside the platform switch — re-run /power-pages:git-configure to reconcile.'
      );
    }
    return null;
  }

  // For setup / rebind: manifest's org/project/repo/branch must match marker.
  if (mode === 'setup' || mode === 'rebind') {
    const fields = ['organization', 'project', 'repository'];
    for (const f of fields) {
      if (marker[f] && manifest[f] && marker[f] !== manifest[f]) {
        return (
          `.git-integration-manifest.json ${f} ("${manifest[f]}") does not match ` +
          `last-git-configure.json ${f} ("${marker[f]}"). The manifest is stale.`
        );
      }
    }
    const expectedBranch = stripRefsPrefix(marker.branch);
    const actualBranch = stripRefsPrefix(manifest.branch);
    if (expectedBranch && actualBranch && expectedBranch !== actualBranch) {
      return (
        `.git-integration-manifest.json branch ("${manifest.branch}") does not match ` +
        `last-git-configure.json branch ("${marker.branch}"). The manifest is stale.`
      );
    }
  }
  return null;
}

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const markerPath = gitConfigurePath(projectRoot, 'lastGitConfigure');
  if (!fs.existsSync(markerPath)) return approve();

  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (e) {
    return block(`validate-git-configure: ${FILE_NAMES.lastGitConfigure} is not valid JSON: ${e.message}`);
  }

  if (marker.skill !== 'git-configure') {
    return block(
      `validate-git-configure: ${FILE_NAMES.lastGitConfigure} has skill="${marker.skill}", expected "git-configure". ` +
      'A different skill is overwriting this marker — investigate.',
    );
  }

  if (!VALID_MODES.has(marker.mode)) {
    return block(
      `validate-git-configure: mode="${marker.mode}" is not one of [${[...VALID_MODES].join(', ')}].`,
    );
  }

  const required = [...COMMON_REQUIRED, ...(PER_MODE_REQUIRED[marker.mode] || [])];
  const missing = required.filter((k) => {
    const v = marker[k];
    return v === null || v === undefined || v === '';
  });
  if (missing.length > 0) {
    return block(
      `validate-git-configure: ${FILE_NAMES.lastGitConfigure} (mode=${marker.mode}) is missing required fields: ${missing.join(', ')}`,
    );
  }

  if (marker.status === 'failed') {
    return block(
      `validate-git-configure: ${FILE_NAMES.lastGitConfigure} reports status=failed. ` +
      'Re-run /power-pages:git-configure after resolving the issue.',
    );
  }

  // No-op switch-branch is always a fail.
  if (marker.mode === 'switch-branch'
      && stripRefsPrefix(marker.oldBranch) === stripRefsPrefix(marker.newBranch)) {
    return block(
      `validate-git-configure: oldBranch ("${marker.oldBranch}") equals newBranch ("${marker.newBranch}") — no-op switch. ` +
      'Re-run /power-pages:git-configure with a different target branch.',
    );
  }

  const manifestPath = gitIntegrationManifestPath(projectRoot);
  const xcheckErr = crossCheckManifest(marker, manifestPath);
  if (xcheckErr) {
    return block('validate-git-configure: ' + xcheckErr);
  }

  approve();
});
