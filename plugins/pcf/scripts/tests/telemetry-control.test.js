'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  PLUGIN_ROOT, FAKE_CONFIG, tempRoot, writeConfig, isolatedEnv,
} = require('./helpers/telemetry-fixtures.js');

const CLI = path.join(PLUGIN_ROOT, 'scripts', 'telemetry-config.js');

function run(t, args = [], extra = {}, root = tempRoot(t)) {
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: isolatedEnv(configDir, root, extra),
  });
  return { ...result, root, configDir };
}

test('PCF telemetry status reports the shipped build ON without writing anything', (t) => {
  const result = run(t, ['--action', 'status']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Telemetry \(pcf\): ON/);
  assert.doesNotMatch(result.stdout, /DISABLED|UNPROVISIONED/);
  assert.match(result.stdout, /no (?:signed-in )?user object (?:ID|identifier)/i);
  assert.deepEqual(fs.readdirSync(result.configDir), []);
});

test('PCF telemetry CLI defaults to status', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Telemetry \(pcf\): ON/);
  assert.deepEqual(fs.readdirSync(result.configDir), []);
});

for (const action of ['on', 'off']) {
  test(`telemetry ${action} merge-writes only the PCF preference and reports the live state`, (t) => {
    const root = tempRoot(t);
    const configDir = path.join(root, 'config');
    fs.mkdirSync(configDir);
    const existing = { setting: 'keep', telemetry: { 'example-plugin': 'off' } };
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(existing));
    const result = run(t, ['--action', action], {}, root);
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8'));
    assert.deepEqual(actual, { setting: 'keep', telemetry: { 'example-plugin': 'off', pcf: action } });
    assert.match(result.stdout, new RegExp(`Telemetry \\(pcf\\): ${action.toUpperCase()}`));
    assert.deepEqual(fs.readdirSync(configDir), ['config.json']);
  });
}

test('an explicitly disabled config still reports hard-off without local writes', (t) => {
  const root = tempRoot(t);
  const result = run(t, ['--action', 'status'], {
    POWER_PLATFORM_SKILLS_IKEY_JSON: writeConfig(root, { ...FAKE_CONFIG, disabled: true }),
  }, root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DISABLED in this build/);
  assert.match(result.stdout, /nothing is sent or logged/i);
  assert.deepEqual(fs.readdirSync(result.configDir), []);
});

test('a provisioned status honours the highest-precedence PCF environment opt-out', (t) => {
  const root = tempRoot(t);
  const ikeyPath = writeConfig(root);
  const result = run(t, ['--action', 'on'], {
    POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
    POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT: '1',
  }, root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preference.*ON/i);
  assert.match(result.stdout, /environment opt-out/i);
  assert.match(result.stdout, /nothing is transmitted/i);
  assert.match(result.stdout, /mirror.*still written/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(result.configDir, 'config.json'), 'utf8')).telemetry.pcf, 'on');
});

test('an enabled config with placeholder keys is reported as unprovisioned, not ON', (t) => {
  const root = tempRoot(t);
  const cfg = { ...FAKE_CONFIG, regions: { us: {
    instrumentation_key: 'PLACEHOLDER_REPLACE_BEFORE_SHIPPING',
    collector_url: 'https://example.invalid/',
  } } };
  const result = run(t, ['--action', 'status'], { POWER_PLATFORM_SKILLS_IKEY_JSON: writeConfig(root, cfg) }, root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /UNPROVISIONED/);
  assert.match(result.stdout, /nothing is sent or logged/i);
  assert.deepEqual(fs.readdirSync(result.configDir), []);
});

test('telemetry controls reject invalid actions and unknown flags with usage', (t) => {
  for (const args of [['--action', 'maybe'], ['--unknown'], ['--action']]) {
    const result = run(t, args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /USAGE/);
    assert.deepEqual(fs.readdirSync(result.configDir), []);
  }
});

test('telemetry preference write errors are explicit, not success-shaped fallbacks', (t) => {
  const root = tempRoot(t);
  const blockedDir = path.join(root, 'not-a-directory');
  fs.writeFileSync(blockedDir, 'blocked');
  const result = run(t, ['--action', 'off'], { POWER_PLATFORM_SKILLS_CONFIG_DIR: blockedDir }, root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not update.*telemetry/i);
});

test('the telemetry skill is installable and discloses its live shared-tenant controls', () => {
  const file = path.join(PLUGIN_ROOT, 'skills', 'telemetry', 'SKILL.md');
  assert.ok(fs.existsSync(file), 'pcf needs an installed telemetry control skill');
  const skill = fs.readFileSync(file, 'utf8');
  assert.match(skill, /^name: telemetry$/m);
  assert.match(skill, /^allowed-tools: Bash, execute$/m);
  assert.match(skill, /pcf telemetry/i);
  assert.match(skill, /\$\{PLUGIN_ROOT\}\/skills\/telemetry\/telemetry-workflow\.md/);
  // Changing telemetry must stay a local action. The plugin update check runs `git fetch`,
  // so the control skill must not start with it, unlike the authoring skills.
  assert.doesNotMatch(skill, /check-version\.js/, 'the telemetry control path must not make a network call');
  const workflow = fs.readFileSync(path.join(path.dirname(file), 'telemetry-workflow.md'), 'utf8');
  assert.match(workflow, /\$\{PLUGIN_ROOT\}\/scripts\/telemetry-config\.js/);
  assert.match(workflow, /enabled.*default-on/i);
  assert.match(workflow, /shares model-apps.*tenant/i);
  assert.match(workflow, /status.*(?:actual|real|effective)/i);
  assert.doesNotMatch(workflow, /ships disabled|provisioned release/i);
  assert.match(workflow, /POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT=1/);
  assert.match(workflow, /no (?:signed-in )?user object (?:ID|identifier)/i);
});

test('telemetry hook registration preserves the existing PCF write-safety guard', () => {
  const { hooks } = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const guard = hooks.PreToolUse.find((entry) => entry.matcher === 'Write|Edit|MultiEdit');
  assert.ok(guard);
  assert.equal(guard.hooks.length, 1);
  assert.match(guard.hooks[0].command, /validate-write-safety\.js/);
  assert.equal(guard.hooks[0].timeout, 10);
  const pretool = hooks.PreToolUse.find((entry) => entry.matcher === 'Skill|skill');
  assert.ok(pretool, 'PCF skill invocations must have a telemetry pretool hook');
  assert.match(pretool.hooks[0].command, /run-skill-pretool-telemetry\.js/);
  assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /run-user-prompt-telemetry\.js/);
  for (const hook of [pretool.hooks[0], hooks.UserPromptSubmit[0].hooks[0]]) {
    assert.match(hook.command, /process\.env\.PLUGIN_ROOT\|\|process\.env\.CLAUDE_PLUGIN_ROOT/);
    assert.equal(hook.timeout, 30);
  }
});
