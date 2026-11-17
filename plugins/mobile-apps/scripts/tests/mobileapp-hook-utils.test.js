'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

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

test('hook manifest registers start telemetry surfaces only', t => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.hooks).sort(), ['PreToolUse', 'UserPromptSubmit']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile hook modes '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'hooks'));
  // Substitute only the hook body to verify the registered command calls start
  // with the correct mode, without PAC enrichment or telemetry transmission.
  fs.writeFileSync(path.join(root, 'hooks/run-telemetry.js'),
    'module.exports = { start(mode) { console.log(JSON.stringify({ mode })); } };');
  const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
  for (const [event, mode] of [['PreToolUse', 'pretool'], ['UserPromptSubmit', 'prompt']]) {
    const groups = manifest.hooks[event];
    assert.equal(groups.length, 1);
    assert.equal(groups[0].hooks.length, 1);
    const command = groups[0].hooks[0].command;
    const args = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-Command', command]
      : ['-c', command];
    const result = spawnSync(shell, args, {
      env: { ...process.env, PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: '' },
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { mode });
  }
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

test('prompt detection accepts the observed interactive Copilot invocation prefix', () => {
  const prefix = 'The user explicitly invoked the "/mobile-app:create-mobile-app" skill. Follow its instructions now.\n\n';
  const wrapper = '<skill-context name="create-mobile-app">\nredacted instructions';
  assert.equal(getTrackedSkillFromPrompt(prefix + wrapper), 'create-mobile-app');
  assert.equal(getTrackedSkillFromPrompt(prefix.replace('mobile-app:', '') + wrapper), 'create-mobile-app');
  assert.equal(getTrackedSkillFromPrompt(prefix + '<skill-context name="deploy">'), null);
  assert.equal(getTrackedSkillFromPrompt(prefix.replace('mobile-app:', 'other-plugin:') + wrapper), null);
  assert.equal(getTrackedSkillFromPrompt('please read this: ' + prefix + wrapper), null);
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