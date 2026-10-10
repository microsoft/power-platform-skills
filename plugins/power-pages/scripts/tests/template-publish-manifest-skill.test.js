'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const skill = fs.readFileSync(path.join(__dirname, '../../skills/create-site/SKILL.md'), 'utf8');

test('selected solution publication metadata reaches variant download', () => {
  assert.match(skill, /--solutionSettingsJson '<JSON\.stringify\(SELECTED_TEMPLATE\.solutions \|\| \[\]\)>'/);
  assert.match(skill, /CURRENT_TEMPLATE_SOLUTION\.publishChanges/);
});

test('template import uses the PAC wrapper and manifest publish flag', () => {
  const packing = skill.indexOf('scripts/pack-template-solution.js');
  const importing = skill.indexOf('scripts/import-template-solution.js');
  const provisioning = skill.indexOf('scripts/provision-template-site.js');
  assert.ok(packing !== -1 && importing > packing && provisioning > importing);
  assert.match(skill, /--publishChanges "<CURRENT_TEMPLATE_SOLUTION\.publishChanges>"/);
  assert.match(skill, /pac solution import --publish-changes/);
  assert.match(skill, /run_in_background: true/);
  assert.match(skill, /Importing solution <CURRENT_TEMPLATE_SOLUTION\.uniqueName>/);
  assert.match(skill, /other pending customizations/);
});

test('template install has no second publication phase', () => {
  assert.doesNotMatch(skill, /publish-template-customizations/);
  assert.doesNotMatch(skill, /TEMPLATE_PUBLICATION_/);
  assert.doesNotMatch(skill, /Publish template customizations/);
  assert.doesNotMatch(skill, /publication-scope|publication-failed/);
});

test('template import failure updates browser status before telemetry and recovery', () => {
  const failure = skill.indexOf('If the import wrapper returns `ok: false`');
  const status = skill.indexOf('{ "state": "failed", "phase": "solution"', failure);
  const telemetry = skill.indexOf('--eventName template_import_failure', failure);
  const recovery = skill.indexOf('gate: create-site:1.5.import-failed', failure);
  assert.ok(failure !== -1 && status > failure && telemetry > status && recovery > telemetry);
});

test('template seed task is skipped whenever no seed workstream launches', () => {
  assert.match(skill, /user skips sample data, mark \*\*Apply template seed data\*\* as skipped/);
  assert.match(skill, /Fetch\/plan failures[\s\S]*mark \*\*Apply template seed data\*\* as skipped/);
  assert.match(skill, /Mark \*\*Apply template seed data\*\* as `completed` only when its background workstream ran; otherwise mark it skipped/);
});
