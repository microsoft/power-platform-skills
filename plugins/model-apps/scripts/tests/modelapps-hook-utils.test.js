const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRACKED_SKILLS,
  TRACKED_SKILL_NAMES,
  detectTrackedSkill,
  getTrackedSkillFromToolInput,
  getValidatorScript,
} = require('../lib/modelapps-hook-utils');

test('discovers genpage and report-issue as tracked skills', () => {
  assert.ok(TRACKED_SKILLS.genpage, 'genpage should be tracked');
  assert.ok(TRACKED_SKILLS['report-issue'], 'report-issue should be tracked');
  assert.ok(TRACKED_SKILL_NAMES.includes('genpage'));
});

test('excludes the telemetry control skill from tracking (never self-emits)', () => {
  // Even once skills/telemetry exists, it must not be tracked.
  assert.equal(TRACKED_SKILLS.telemetry, undefined);
  assert.equal(TRACKED_SKILL_NAMES.includes('telemetry'), false);
});

test('null-prototype map does not report inherited keys as skills', () => {
  assert.equal(detectTrackedSkill('toString'), null);
  assert.equal(detectTrackedSkill('constructor'), null);
  assert.equal(detectTrackedSkill('__proto__'), null);
});

test('detectTrackedSkill normalizes slash and plugin prefixes', () => {
  assert.equal(detectTrackedSkill('genpage'), 'genpage');
  assert.equal(detectTrackedSkill('/genpage'), 'genpage');
  assert.equal(detectTrackedSkill('model-apps:genpage'), 'genpage');
  assert.equal(detectTrackedSkill('/model-apps:genpage'), 'genpage');
  assert.equal(detectTrackedSkill('GENPAGE'), 'genpage');
});

test('detectTrackedSkill finds a model-apps:<skill> token embedded in text', () => {
  assert.equal(detectTrackedSkill('please run model-apps:report-issue now'), 'report-issue');
});

test('detectTrackedSkill returns null for unknown or non-string input', () => {
  assert.equal(detectTrackedSkill('not-a-real-skill'), null);
  assert.equal(detectTrackedSkill(null), null);
  assert.equal(detectTrackedSkill(42), null);
});

test('getTrackedSkillFromToolInput probes known fields', () => {
  assert.equal(getTrackedSkillFromToolInput({ skill: 'genpage' }), 'genpage');
  assert.equal(getTrackedSkillFromToolInput({ name: '/model-apps:genpage' }), 'genpage');
  assert.equal(getTrackedSkillFromToolInput({ command: 'model-apps:report-issue' }), 'report-issue');
});

test('getTrackedSkillFromToolInput falls back to serialized scan', () => {
  assert.equal(getTrackedSkillFromToolInput({ nested: { x: 'model-apps:genpage' } }), 'genpage');
});

test('getTrackedSkillFromToolInput returns null for non-objects / no match', () => {
  assert.equal(getTrackedSkillFromToolInput(null), null);
  assert.equal(getTrackedSkillFromToolInput('genpage'), null);
  assert.equal(getTrackedSkillFromToolInput({ skill: 'unknown' }), null);
});

test('getValidatorScript returns null when a skill has no validator', () => {
  // genpage currently ships no skills/genpage/scripts/validate*.js.
  assert.equal(getValidatorScript('genpage'), null);
  assert.equal(getValidatorScript('nope'), null);
});
