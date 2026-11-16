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

test('template prerequisites require consent and verification before import or provisioning', () => {
  const consent = skill.indexOf('List every application in `SELECTED_TEMPLATE.prerequisiteApplications`');
  const install = skill.indexOf('pac application install --environment "<environmentUrl>" --application-name "<name>"');
  const verify = skill.indexOf('pac application list --environment "<environmentUrl>" --installState Installed');
  const pack = skill.indexOf('node "${PLUGIN_ROOT}/scripts/pack-template-solution.js"');
  const provision = skill.indexOf('node "${PLUGIN_ROOT}/scripts/provision-template-site.js"');
  assert.ok(consent !== -1 && install > consent && verify > install && pack > verify && provision > pack);
  assert.match(skill, /PowerPages_PartnerPortal_V2/);
  assert.match(skill, /stop before solution import, site creation, or seed data/);
  assert.match(skill, /do not automatically retry or undo it/);
});
