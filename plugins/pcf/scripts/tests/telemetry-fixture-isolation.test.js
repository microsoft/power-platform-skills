'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempRoot, runHook, isolatedEnv, writeConfig } = require('./helpers/telemetry-fixtures.js');

for (const [label, overrides] of [
  ['missing fake HTTPS probe', () => ({ POWER_PLATFORM_SKILLS_FAKE_HTTPS: '' })],
  ['blank fake HTTPS probe', () => ({ POWER_PLATFORM_SKILLS_FAKE_HTTPS: ' ' })],
  ['missing temporary config directory', () => ({ POWER_PLATFORM_SKILLS_CONFIG_DIR: '' })],
  ['real-home config directory', () => ({
    POWER_PLATFORM_SKILLS_CONFIG_DIR: path.join(os.homedir(), '.power-platform-skills'),
  })],
  ['probe outside the temporary config directory', (root) => ({
    POWER_PLATFORM_SKILLS_FAKE_HTTPS: path.join(root, 'outside-probe.json'),
  })],
]) {
  test(`fixture refuses to spawn a telemetry hook with ${label}`, (t) => {
    const root = tempRoot(t);
    // Malformed input keeps a guard-regression check harmless; the fixture must
    // reject the unsafe environment before spawning the hook.
    assert.throws(() => runHook('run-skill-pretool-telemetry.js', root, root, {
      payload: '{not json',
      envOverrides: overrides(root),
    }), /(?:fake HTTPS probe|temporary config directory)/i);
  });
}

test('fixture permits a hook only with its temporary config and fake HTTPS probe', (t) => {
  const root = tempRoot(t);
  const { configDir, probe } = runHook('run-skill-pretool-telemetry.js', root, root, {
    payload: '{not json',
  });
  assert.equal(configDir, path.join(root, 'config'));
  assert.equal(probe, path.join(configDir, 'probe.json'));
  assert.deepEqual(fs.readdirSync(configDir), []);
});

test('dispatcher preload preserves a non-default platform temp directory across the minimal environment', (t) => {
  const root = tempRoot(t);
  const alternateTemp = path.join(root, 'alternate-temp');
  const fallbackTemp = path.join(root, 'fallback-temp');
  const configDir = path.join(alternateTemp, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(fallbackTemp);
  const dispatcher = path.join(root, 'emit-dispatcher.js');
  // This child only reports its temp directory; it cannot emit an event or POST.
  fs.writeFileSync(dispatcher, "process.stdout.write(JSON.stringify({ tempDir: require('node:os').tmpdir() }));\n");
  const preload = path.join(__dirname, 'helpers', 'telemetry-offline-preload.js');
  const driver = [
    "const cp = require('node:child_process');",
    "const spawn = cp.spawn;",
    // Node implicitly inherits TEMP on Windows. A distinct fallback models
    // platforms that do not inherit TMPDIR, without needing another OS runner.
    `const fallbackTemp = ${JSON.stringify(fallbackTemp)};`,
    "cp.spawn = (command, args, options) => spawn(command, args, { ...options, env: { ...options.env,",
    "  TEMP: options.env.TEMP || fallbackTemp, TMP: options.env.TMP || fallbackTemp,",
    "  TMPDIR: options.env.TMPDIR || fallbackTemp } });",
    `require(${JSON.stringify(preload)});`,
    "const env = Object.fromEntries(['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'APPDATA',",
    "  'POWER_PLATFORM_SKILLS_CONFIG_DIR', 'POWER_PLATFORM_SKILLS_FAKE_HTTPS', 'POWER_PLATFORM_SKILLS_IKEY_JSON']",
    "  .map(key => [key, process.env[key] || '']));",
    `const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(dispatcher)}], { env, stdio: ['ignore', 'pipe', 'pipe'] });`,
    "child.stdout.on('data', data => process.stdout.write(data));",
    "child.stderr.on('data', data => process.stderr.write(data));",
    "child.on('close', code => { process.exitCode = code === null ? 1 : code; });",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', driver], {
    encoding: 'utf8', timeout: 10_000, shell: false,
    env: isolatedEnv(configDir, root, {
      POWER_PLATFORM_SKILLS_IKEY_JSON: writeConfig(root),
      TEMP: alternateTemp, TMP: alternateTemp, TMPDIR: alternateTemp,
    }),
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(JSON.parse(result.stdout).tempDir, alternateTemp);
});
