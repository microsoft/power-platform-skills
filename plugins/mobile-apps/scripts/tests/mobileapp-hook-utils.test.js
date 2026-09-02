'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  TRACKED_SKILL_NAMES,
  detectTrackedSkill,
  getTrackedSkillFromPrompt,
  getTrackedSkillFromToolInput,
  isInvocable,
  readInvocationMetadata,
} = require('../lib/mobileapp-hook-utils');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');

test('discovers every invocable top-level skill without tracking direct-read helpers', () => {
  const expected = fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => isInvocable(
      readInvocationMetadata(path.join(SKILLS_DIR, entry.name, 'SKILL.md')),
    ))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual([...TRACKED_SKILL_NAMES].sort(), expected);
  assert.ok(TRACKED_SKILL_NAMES.includes('create-mobile-app'));
  assert.ok(TRACKED_SKILL_NAMES.includes('deploy'));
  assert.ok(TRACKED_SKILL_NAMES.includes('assign-offline-profile'));
  assert.ok(TRACKED_SKILL_NAMES.includes('preview-offline-scope'));
  assert.ok(TRACKED_SKILL_NAMES.includes('telemetry'));
  assert.equal(TRACKED_SKILL_NAMES.includes('add-camera'), false);
  assert.equal(TRACKED_SKILL_NAMES.includes('add-table-to-offline-profile'), false);
});

test('hook manifest registers start telemetry surfaces only', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.hooks).sort(), ['PreToolUse', 'UserPromptSubmit']);
  const pretoolCommand = manifest.hooks.PreToolUse[0].hooks[0].command;
  const promptCommand = manifest.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(pretoolCommand, /run-telemetry\.js.+start\('pretool'\)/);
  assert.match(promptCommand, /run-telemetry\.js.+start\('prompt'\)/);
});

test('accepts every tracked skill in bare and qualified forms regardless of cwd', () => {
  for (const skillName of TRACKED_SKILL_NAMES) {
    assert.equal(detectTrackedSkill(`/${skillName}`), skillName);
    assert.equal(detectTrackedSkill(`/mobile-app:${skillName}`), skillName);
    assert.equal(getTrackedSkillFromPrompt(`/${skillName}`), skillName);
    assert.equal(getTrackedSkillFromPrompt(`/mobile-app:${skillName}`), skillName);
    assert.equal(getTrackedSkillFromToolInput({ skill: skillName }), skillName);
    assert.equal(
      getTrackedSkillFromToolInput({ skill: `mobile-app:${skillName}` }),
      skillName,
    );
  }
});

test('does not attribute another plugin command to mobile-app', () => {
  assert.equal(detectTrackedSkill('/code-apps:deploy'), null);
  assert.equal(getTrackedSkillFromPrompt('/power-pages:setup-datamodel'), null);
  assert.equal(getTrackedSkillFromToolInput({ skill: 'other-plugin:report-issue' }), null);
});

test('prompt detection requires an explicit leading slash command', () => {
  assert.equal(getTrackedSkillFromPrompt('/mobile-app:deploy now'), 'deploy');
  assert.equal(getTrackedSkillFromPrompt('  /deploy now'), 'deploy');
  assert.equal(getTrackedSkillFromPrompt('please run /mobile-app:deploy'), null);
  assert.equal(getTrackedSkillFromPrompt('mobile-app:deploy'), null);
});

test('prompt detection accepts Copilot manual skill-context wrappers', () => {
  assert.equal(
    getTrackedSkillFromPrompt('<skill-context name="add-connector">\nredacted instructions'),
    'add-connector',
  );
  assert.equal(
    getTrackedSkillFromPrompt('<skill-context name="create-mobile-app">\nredacted instructions'),
    'create-mobile-app',
  );
  assert.equal(getTrackedSkillFromPrompt('<skill-context name="not-mobile">'), null);
  assert.equal(
    getTrackedSkillFromPrompt('text before <skill-context name="add-connector">'),
    null,
  );
});

test('reads known host tool-input field variants', () => {
  assert.equal(getTrackedSkillFromToolInput({ skill: 'deploy' }), 'deploy');
  assert.equal(getTrackedSkillFromToolInput({ skill_name: 'mobile-app:debug-app' }), 'debug-app');
  assert.equal(
    getTrackedSkillFromToolInput({ command: '/mobile-app:preview-screens now' }),
    'preview-screens',
  );
});

test('rejects prototype names and malformed input', () => {
  assert.equal(detectTrackedSkill('toString'), null);
  assert.equal(detectTrackedSkill('__proto__'), null);
  assert.equal(getTrackedSkillFromToolInput(null), null);
  assert.equal(getTrackedSkillFromPrompt(null), null);
});