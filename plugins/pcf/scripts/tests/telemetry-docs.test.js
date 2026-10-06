'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PLUGIN_ROOT } = require('./helpers/telemetry-fixtures.js');

const REPO_ROOT = path.resolve(PLUGIN_ROOT, '..', '..');
const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');

function telemetrySection(file) {
  const text = read(PLUGIN_ROOT, file);
  const section = /^## Telemetry[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text);
  assert.ok(section, `${file} must disclose PCF telemetry`);
  return section[1];
}

test('PCF README discloses default-on shared-tenant telemetry and only approved base fields', () => {
  const section = telemetrySection('README.md');
  assert.match(section, /enabled.*default-on/i);
  assert.match(section, /no first-run prompt/i);
  assert.match(section, /shares model-apps.*tenant/i);
  assert.match(section, /routing.*model-apps/i);
  assert.match(section, /geo.*no.*fallback/i);
  assert.match(section, /sovereign.*stamp/i);
  assert.doesNotMatch(section, /ships disabled|provisioned.*would send/i);
  for (const field of [
    'skill_started', 'pluginName', 'pluginVersion', 'sessionId', 'correlationId',
    'osName', 'osVersion', 'nodeVersion', 'orgId', 'tenantId', 'pacCliVersion', 'aiAgentName', 'aiAgentVersion', 'skillName',
  ]) assert.ok(section.includes(field), `approved field missing from disclosure: ${field}`);
  assert.match(section, /PAC is signed in/i);
  assert.match(section, /no (?:signed-in )?user object (?:ID|identifier)/i);
  assert.match(section, /no `?eventInfo`?/i);
  for (const forbidden of ['paths', 'prompts', 'tool inputs', 'Dataverse URLs', 'credentials', 'usernames', 'hostnames']) {
    assert.ok(section.includes(forbidden), `never-sent category missing: ${forbidden}`);
  }
});

test('PCF README explains both opt-outs, local mirror and retention', () => {
  const section = telemetrySection('README.md');
  assert.match(section, /\/pcf:telemetry off/);
  assert.match(section, /POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT=1/);
  assert.match(section, /highest precedence/i);
  assert.match(section, /~\/\.power-platform-skills\/telemetry\/pcf\/sessions\/<sessionId>\/events\.jsonl/);
  assert.match(section, /even after.*transmission opt-out/i);
  assert.match(section, /14 days/);
  assert.match(section, /10 MB/);
  assert.doesNotMatch(read(PLUGIN_ROOT, 'README.md'), /hard-disabled in this release/i);
});

test('PCF contributor guidance pins live shared-tenant routing and same-PR key rotations', () => {
  const section = telemetrySection('AGENTS.md');
  assert.match(section, /PcfAIPlugin/);
  assert.match(section, /base fields only/i);
  assert.match(section, /live.*shared.*tenant/i);
  assert.match(section, /model-apps.*ikey\.json.*copy.*pcf.*same PR/i);
  assert.match(section, /validate-plugin-copies\.js/);
  assert.match(section, /eventInfo.*privacy review/i);
  assert.doesNotMatch(section, /Enable checklist|staged.*hard-disabled/i);
  assert.match(section, /byte-identical/i);
});

test('root contributor guidance describes the sole key-sharing exception and transmitting PCF', (t) => {
  const file = path.join(REPO_ROOT, 'AGENTS.md');
  if (!fs.existsSync(file)) { t.skip('repository guidance not installed with plugin'); return; }
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^Current adopters:.*`pcf`.*transmitting.*model-apps.*tenant/m);
  assert.match(text, /sole.*exception.*model-apps.*pcf/i);
  assert.match(text, /SHARED_KEY_GROUPS/);
  assert.match(text, /validate-plugin-copies\.js/);
  assert.doesNotMatch(text, /Keys are never exempt/);
});

test('the shared adopter table pins enabled PCF and its separable base-only shared tenant', (t) => {
  const file = path.join(REPO_ROOT, 'shared', 'telemetry', 'README.md');
  if (!fs.existsSync(file)) { t.skip('shared source not installed with plugin'); return; }
  const row = fs.readFileSync(file, 'utf8').split('\n').find((line) => /^\| PCF \|/.test(line));
  assert.ok(row, 'the adopter table must include PCF');
  assert.match(row, /disabled: false/);
  assert.match(row, /shares Model Apps.*tenant.*keys/i);
  assert.match(row, /routes.*model-apps/i);
  assert.match(row, /PcfAIPlugin/);
  assert.match(row, /pluginName: "pcf"/);
  assert.match(row, /base fields only/i);
  assert.match(row, /orgId.*tenantId.*PAC is signed in/i);
  assert.match(row, /no.*user object ID/i);
});

test('Model Apps guidance keeps PCF shared-tenant key rotations synchronized', (t) => {
  const file = path.join(REPO_ROOT, 'plugins', 'model-apps', 'AGENTS.md');
  if (!fs.existsSync(file)) { t.skip('model-apps source is not present in an installed plugin'); return; }
  assert.match(fs.readFileSync(file, 'utf8'), /pcf.*verbatim copy.*ikey\.json.*same tenant.*rotation.*both.*copy check/i);
});

test('PCF changelog records enabled telemetry on the model-apps tenant', () => {
  const text = read(PLUGIN_ROOT, 'CHANGELOG.md');
  assert.match(text, /### Added[\s\S]*^- .*telemetry.*enabled.*model-apps.*tenant/m);
});

test('PCF capability evidence states usage telemetry is enabled', () => {
  const text = read(PLUGIN_ROOT, path.join('docs', 'pcf-capabilities.md'));
  assert.match(text, /usage telemetry.*enabled/i);
  assert.doesNotMatch(text, /usage telemetry.*ships disabled/i);
});
