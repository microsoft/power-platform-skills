#!/usr/bin/env node
/**
 * validate-setup-git-integration.js — PostToolUse hook validator.
 *
 * Shared by BOTH `setup-git-integration` AND `connect-solution-to-git`.
 * The two skills write the same artifacts (`.git-integration-manifest.json`
 * at the project root + `docs/inner-loop/last-setup.json`), so one validator
 * covers them.
 *
 * Checks:
 *   1. `.git-integration-manifest.json` exists at project root
 *   2. Required top-level fields are present
 *   3. `bindingType` is one of "environment" | "solution"
 *   4. When bindingType=solution, `solutionUniqueName` is non-empty
 *   5. `docs/inner-loop/last-setup.json` exists and references the same envUrl
 *
 * Gracefully approves when no project root OR no manifest is found (not a
 * setup-git-integration session).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const {
  runValidation, findProjectRoot, block, approve,
} = require('../../../scripts/lib/validation-helpers');

const REQUIRED_BASE_FIELDS = [
  'bindingType', 'envUrl',
  'organization', 'project', 'repository', 'branch', 'gitFolder',
  'boundAt', 'manifestVersion',
];

runValidation((cwd) => {
  const projectRoot = findProjectRoot(cwd);
  if (!projectRoot) return approve();

  const manifestPath = path.join(projectRoot, '.git-integration-manifest.json');
  if (!fs.existsSync(manifestPath)) return approve();

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { return block(`validate-setup-git-integration: .git-integration-manifest.json is not valid JSON: ${e.message}`); }

  const missing = REQUIRED_BASE_FIELDS.filter((k) => {
    const v = manifest[k];
    return v === null || v === undefined || v === '';
  });
  if (missing.length > 0) {
    return block(
      `validate-setup-git-integration: .git-integration-manifest.json is missing required fields: ${missing.join(', ')}`
    );
  }

  if (manifest.bindingType !== 'environment' && manifest.bindingType !== 'solution') {
    return block(
      `validate-setup-git-integration: .git-integration-manifest.json bindingType must be "environment" or "solution", got "${manifest.bindingType}".`
    );
  }

  if (manifest.bindingType === 'solution') {
    const sun = manifest.solutionUniqueName;
    if (typeof sun !== 'string' || sun.trim() === '') {
      return block(
        'validate-setup-git-integration: bindingType=solution requires a non-empty solutionUniqueName field.'
      );
    }
  }

  // Cross-check last-setup.json (best-effort — absent is OK because plan-inner-loop
  // might be the only thing that ever ran; missing marker isn't fatal)
  const markerPath = path.join(projectRoot, 'docs', 'inner-loop', 'last-setup.json');
  if (fs.existsSync(markerPath)) {
    let marker;
    try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
    catch (e) {
      return block(`validate-setup-git-integration: docs/inner-loop/last-setup.json is not valid JSON: ${e.message}`);
    }
    if (marker.envUrl && marker.envUrl !== manifest.envUrl) {
      return block(
        'validate-setup-git-integration: docs/inner-loop/last-setup.json envUrl does not match the manifest. ' +
        'This usually means a prior binding session was interrupted — re-run setup-git-integration (or connect-solution-to-git).'
      );
    }
  }

  approve();
});
