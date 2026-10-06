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

test('PCF README discloses hard-off, all approved base fields and no user object ID', () => {
  const section = telemetrySection('README.md');
  assert.match(section, /ships disabled/i);
  assert.match(section, /nothing is sent or written/i);
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

test('PCF README explains both opt-outs and the enabled-only local mirror', () => {
  const section = telemetrySection('README.md');
  assert.match(section, /\/pcf:telemetry off/);
  assert.match(section, /POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT=1/);
  assert.match(section, /highest precedence/i);
  assert.match(section, /~\/\.power-platform-skills\/telemetry\/pcf\/sessions\/<sessionId>\/events\.jsonl/);
  assert.match(section, /once enabled/i);
  assert.match(section, /even after.*transmission opt-out/i);
});

test('PCF contributor guidance owns routing, copy refreshes and the four-step enable checklist', () => {
  const section = telemetrySection('AGENTS.md');
  assert.match(section, /PcfAIPlugin/);
  assert.match(section, /base fields only/i);
  assert.match(section, /1\. .*provision.*pcf.*own.*keys/i);
  assert.match(section, /never.*another plugin/i);
  assert.match(section, /2\. .*ikey\.json/i);
  assert.match(section, /3\. .*disabled/i);
  assert.match(section, /4\. .*adopters.*tests/i);
  assert.match(section, /byte-identical/i);
});

test('root contributor guidance lists PCF as staged and disabled', (t) => {
  const file = path.join(REPO_ROOT, 'AGENTS.md');
  if (!fs.existsSync(file)) { t.skip('repository guidance not installed with plugin'); return; }
  assert.match(fs.readFileSync(file, 'utf8'), /^Current adopters:.*`pcf`.*staged.*disabled/m);
});

test('the shared adopter table pins PCF hard-off and separable base-only identity', (t) => {
  const file = path.join(REPO_ROOT, 'shared', 'telemetry', 'README.md');
  if (!fs.existsSync(file)) { t.skip('shared source not installed with plugin'); return; }
  const row = fs.readFileSync(file, 'utf8').split('\n').find((line) => /^\| PCF \|/.test(line));
  assert.ok(row, 'the adopter table must include PCF');
  assert.match(row, /disabled: true/);
  assert.match(row, /staged/i);
  assert.match(row, /PcfAIPlugin/);
  assert.match(row, /base fields only/i);
  assert.match(row, /no.*user object ID/i);
});

test('PCF changelog records staged telemetry as an Added item', () => {
  const text = read(PLUGIN_ROOT, 'CHANGELOG.md');
  assert.match(text, /### Added[\s\S]*^- .*telemetry.*disabled/m);
});

test('PCF capability evidence states telemetry is wired but ships disabled', () => {
  const text = read(PLUGIN_ROOT, path.join('docs', 'pcf-capabilities.md'));
  assert.match(text, /usage telemetry.*wired.*ships disabled/i);
});
