#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const VALIDATOR = path.join(REPO_ROOT, 'scripts', 'validate-plugin-copies.js');
const MODEL_APPS_ROOT = path.join(REPO_ROOT, 'plugins', 'model-apps');

function formatFindings(findings) {
  return findings.map((finding) => `${finding.kind}: ${finding.source} -> ${finding.copy}\n  Fix: ${finding.fix}`).join('\n');
}

test('bundled model-apps copies match the root validator contract', (t) => {
  if (!fs.existsSync(VALIDATOR)) {
    t.skip('scripts/validate-plugin-copies.js not present (installed plugin, not a repo checkout)');
    return;
  }
  if (!fs.existsSync(MODEL_APPS_ROOT)) {
    t.skip('plugins/model-apps not present (installed plugin, not a repo checkout)');
    return;
  }
  const { COPY_SETS, checkCopySets } = require(VALIDATOR);
  const set = COPY_SETS.filter((copySet) => copySet.name === 'pcf-from-model-apps');
  const result = checkCopySets({ repoRoot: REPO_ROOT, sets: set });
  assert.equal(result.ok, true, `pcf copy drifted from model-apps — refresh the listed files from their sources:\n${formatFindings(result.findings)}`);
});
