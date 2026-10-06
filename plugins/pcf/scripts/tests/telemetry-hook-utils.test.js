'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { PLUGIN_ROOT } = require('./helpers/telemetry-fixtures.js');

function utils() {
  const file = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'pcf-hook-utils.js');
  assert.ok(fs.existsSync(file), 'pcf telemetry needs its own skill-discovery helpers');
  return require(file);
}

test('tracked PCF skills are discovered from installed SKILL.md files, excluding telemetry', () => {
  const ownUtils = utils();
  const skills = path.join(PLUGIN_ROOT, 'skills');
  const expected = fs.readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'telemetry'
      && fs.existsSync(path.join(skills, entry.name, 'SKILL.md')))
    .map((entry) => entry.name).sort();
  assert.deepEqual(Object.keys(ownUtils.TRACKED_SKILLS).sort(), expected);
  assert.equal(Object.getPrototypeOf(ownUtils.TRACKED_SKILLS), null);
  assert.ok(ownUtils.TRACKED_SKILLS.pcf);
  assert.equal(ownUtils.TRACKED_SKILLS.telemetry, undefined);
});

test('skill detection accepts host spellings and rejects other plugins and inherited keys', () => {
  const ownUtils = utils();
  for (const value of ['pcf', '/pcf', 'pcf:pcf', '/pcf:pcf', ' PCF:PCF ']) {
    assert.equal(ownUtils.detectTrackedSkill(value), 'pcf', value);
  }
  for (const value of [null, {}, '', 'other-plugin:pcf', 'telemetry', 'pcf:telemetry', 'constructor', '__proto__', 'toString']) {
    assert.equal(ownUtils.detectTrackedSkill(value), null);
  }
});

test('skill input detection handles the known host field names', () => {
  const ownUtils = utils();
  for (const field of ['skill', 'skill_name', 'skillName', 'name', 'commandName', 'command']) {
    assert.equal(ownUtils.getTrackedSkillFromToolInput({ [field]: 'pcf:pcf' }), 'pcf', field);
  }
  assert.equal(ownUtils.getTrackedSkillFromToolInput(null), null);
  assert.equal(ownUtils.getTrackedSkillFromToolInput({ skill: 'other-plugin:foo' }), null);
});

test('hook utilities read the bundled plugin version and reuse the UTF-8 stream reader', async () => {
  const ownUtils = utils();
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(ownUtils.readPluginVersion(), manifest.version);
  const source = Buffer.from('{"skill":"pcf:pcf"}', 'utf8');
  assert.equal(await ownUtils.readUtf8Stream(Readable.from([source.subarray(0, 8), source.subarray(8)])), source.toString('utf8'));
});
