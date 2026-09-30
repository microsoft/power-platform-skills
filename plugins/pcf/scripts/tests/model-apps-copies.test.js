#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const MODEL_APPS_ROOT = path.join(REPO_ROOT, 'plugins', 'model-apps');
const text = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const copiedFiles = [
  ['scripts/lib/process-runner.js', 'scripts/lib/process-runner.js'],
  ['scripts/lib/sdk-http-client.js', 'scripts/lib/sdk-http-client.js'],
  ['scripts/lib/odata.js', 'scripts/lib/odata.js'],
  ['scripts/lib/source-literals.js', 'scripts/lib/source-literals.js'],
  ['scripts/lib/interaction-mode.js', 'scripts/lib/interaction-mode.js'],
  ['scripts/lib/nearest-name.js', 'scripts/lib/nearest-name.js'],
  ['scripts/lib/utf8-stream.js', 'scripts/lib/utf8-stream.js'],
  ['scripts/check-auth.js', 'scripts/check-auth.js'],
  ['scripts/resolve-interaction-mode.js', 'scripts/resolve-interaction-mode.js'],
  ['scripts/vendor/cds-maker-sdk.cjs', 'scripts/vendor/cds-maker-sdk.cjs'],
  ['scripts/vendor/PROVENANCE.json', 'scripts/vendor/PROVENANCE.json'],
  ['scripts/vendor/.gitattributes', 'scripts/vendor/.gitattributes'],
];
test('bundled model-apps verbatim copies match their source', (t) => {
  if (!fs.existsSync(MODEL_APPS_ROOT)) { t.skip('plugins/model-apps not present (installed plugin, not a repo checkout)'); return; }
  const drifted = copiedFiles.filter(([src, dst]) => text(path.join(MODEL_APPS_ROOT, src)) !== text(path.join(PLUGIN_ROOT, dst)));
  assert.deepEqual(drifted.map(([, dst]) => dst), [], 'pcf copy drifted from model-apps — refresh by copying the listed model-apps source file into plugins/pcf');
});
test('dataverse-auth subset retains model-apps function bodies except emitResult', (t) => {
  if (!fs.existsSync(MODEL_APPS_ROOT)) { t.skip('plugins/model-apps not present (installed plugin, not a repo checkout)'); return; }
  const pcf = require(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'dataverse-auth.js'));
  const modelApps = require(path.join(MODEL_APPS_ROOT, 'scripts', 'lib', 'dataverse-auth.js'));
  for (const name of Object.keys(pcf).filter((n) => n !== 'emitResult')) assert.equal(String(pcf[name]), String(modelApps[name]), name + ' drifted from model-apps — refresh the subset body from plugins/model-apps/scripts/lib/dataverse-auth.js');
  assert.notEqual(String(pcf.emitResult), String(modelApps.emitResult), 'pcf emitResult must intentionally differ from model-apps');
  assert.match(String(pcf.emitResult), /ok:\s*false,\s*error/, 'pcf emitResult keeps JSON stdout for Error payloads');
});
test('bundled shared report-issue workflow matches shared source', (t) => {
  const sharedRoot = path.join(REPO_ROOT, 'shared', 'skills', 'report-issue');
  if (!fs.existsSync(sharedRoot)) { t.skip('shared/skills/report-issue not present (installed plugin, not a repo checkout)'); return; }
  assert.equal(text(path.join(sharedRoot, 'report-issue-workflow.md')), text(path.join(PLUGIN_ROOT, 'skills', 'report-issue', 'report-issue-workflow.md')), 'edit shared/skills first, then copy report-issue-workflow.md into plugins/pcf/skills/report-issue');
});
