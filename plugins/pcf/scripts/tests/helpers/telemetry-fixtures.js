'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'telemetry');
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_ID = '33333333-3333-4333-8333-333333333333';
const USER = 'maker@contoso.example';
const FAKE_REGIONS = Object.fromEntries(
  ['internal', 'us', 'eu', 'gov', 'high', 'dod', 'mooncake'].map((region, index) => [region, {
    instrumentation_key: `00000000-0000-0000-0000-000000000000-000${index}`,
    collector_url: `https://${region}.example.invalid/OneCollector/1.0/`,
  }]),
);
const FAKE_CONFIG = { disabled: false, event_stream_name: 'event', default_region: 'us', regions: FAKE_REGIONS };
const TEST_ROOTS = new Set();

function tempRoot(t, prefix = 'pcf-telemetry-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TEST_ROOTS.add(root);
  t.after(() => {
    TEST_ROOTS.delete(root);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}

function seedRegion(configDir, region = 'eu') {
  const cache = path.join(configDir, 'region-cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, `${ORG_ID}.json`),
    JSON.stringify({ region, expiresAt: Date.now() + 60_000 }));
}

function writeConfig(root, cfg = FAKE_CONFIG) {
  const dir = path.join(root, 'override');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ikey.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  // The override still exercises the real resolver. The mandatory preload owns
  // network blocking and dispatcher completion for both shipped and fake configs.
  fs.writeFileSync(path.join(dir, 'resolver.js'),
    `module.exports = require(${JSON.stringify(path.join(TELEMETRY_DIR, 'resolver.js'))});\n`);
  return file;
}

function waitForJson(file, timeout = 5000, jsonLines = false) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8').trim();
      try {
        return jsonLines ? text.split('\n').map((line) => JSON.parse(line)) : JSON.parse(text);
      } catch {
        // A detached writer can have created the file before finishing its line.
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.fail(`dispatcher did not finish writing ${path.basename(file)}`);
}

function waitForDispatcher(configDir) {
  assert.deepEqual(waitForJson(path.join(configDir, 'dispatcher-exited.json')), { exited: true });
  assert.equal(fs.existsSync(path.join(configDir, 'blocked-network.jsonl')), false,
    'a caught network error must still fail the offline test');
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertHookIsolation(env, expectedConfigDir) {
  const configDir = env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const probe = env.POWER_PLATFORM_SKILLS_FAKE_HTTPS;
  assert.ok(typeof configDir === 'string' && configDir.trim() && path.isAbsolute(configDir),
    'hook tests require a temporary config directory');
  if (expectedConfigDir) {
    assert.equal(path.resolve(configDir), path.resolve(expectedConfigDir),
      'hook tests must use their own temporary config directory');
  }
  assert.ok(fs.existsSync(configDir) && fs.statSync(configDir).isDirectory(),
    'hook tests require an existing temporary config directory');
  const physicalConfigDir = fs.realpathSync(configDir);
  assert.ok(inside(fs.realpathSync(os.tmpdir()), physicalConfigDir),
    'hook tests require a temporary config directory, never the real home');
  assert.ok(typeof probe === 'string' && probe.trim() && path.isAbsolute(probe),
    'hook tests require a fake HTTPS probe path');
  assert.ok(fs.existsSync(path.dirname(probe)), 'fake HTTPS probe parent must exist');
  const physicalProbe = fs.existsSync(probe) ? fs.realpathSync(probe)
    : path.join(fs.realpathSync(path.dirname(probe)), path.basename(probe));
  assert.ok(inside(physicalConfigDir, physicalProbe),
    'fake HTTPS probe must stay inside the temporary config directory');
}

function isolatedEnv(configDir, toolsDir, extra = {}) {
  const env = {
    ...process.env,
    NODE_OPTIONS: '',
    POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    POWER_PLATFORM_SKILLS_IKEY_JSON: '',
    POWER_PLATFORM_SKILLS_IKEY: '',
    POWER_PLATFORM_SKILLS_COLLECTOR: '',
    POWER_PLATFORM_SKILLS_CLOUD: '',
    POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT: '',
    POWER_PLATFORM_SKILLS_FAKE_HTTPS: path.join(configDir, 'probe.json'),
    PCF_DISABLE_HOOKS: '',
    AI_AGENT_NAME: 'OfflineTestAgent',
    AI_AGENT_VERSION: '1.0.0',
    ...extra,
  };
  // Node forwards the lexicographically first PATH spelling on Windows. Drop
  // every inherited spelling so neither hooks nor children can find real PAC.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') delete env[key];
  }
  env.PATH = toolsDir;
  return env;
}

function writePacStub(dir) {
  fs.mkdirSync(dir);
  const marker = path.join(dir, 'started.txt');
  const banner = [
    `Tenant Id: ${TENANT_ID}`,
    `Organization Id: ${ORG_ID}`,
    'Cloud: Public',
    `Entra ID Object Id: ${OBJECT_ID}`,
    `User: ${USER}`,
  ];
  if (process.platform === 'win32') {
    // native-exec intentionally rejects .cmd shims. A small native executable
    // exercises the real parser and proves whether PAC ran, without credentials.
    const windows = process.env.SystemRoot || 'C:\\Windows';
    const compiler = ['Framework64', 'Framework'].map((arch) =>
      path.join(windows, 'Microsoft.NET', arch, 'v4.0.30319', 'csc.exe')).find(fs.existsSync);
    assert.ok(compiler, 'Windows hook tests need the .NET Framework C# compiler for a native offline PAC stub');
    const source = path.join(dir, 'pac.cs');
    const executable = path.join(dir, 'pac.exe');
    fs.writeFileSync(source, [
      'using System;',
      'using System.IO;',
      'class OfflinePac {',
      '  static int Main(string[] args) {',
      `    File.AppendAllText(${JSON.stringify(marker)}, "started\\n");`,
      '    if (Array.IndexOf(args, "--version") >= 0) Console.WriteLine("Version: 9.9.9");',
      `    else Console.WriteLine(${JSON.stringify(banner.join('\n'))});`,
      '    return 0;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const result = spawnSync(compiler, ['/nologo', '/t:exe', `/out:${executable}`, source], {
      encoding: 'utf8', timeout: 30_000, shell: false,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } else {
    const script = [
      '#!/bin/sh',
      `printf '%s\\n' started >> '${marker}'`,
      'case " $* " in',
      "  *' --version '*) printf '%s\\n' 'Version: 9.9.9' ;;",
      `  *) printf '%s\\n' '${banner.join('\n')}' ;;`,
      'esac',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'pac'), script, { mode: 0o755 });
  }
  return marker;
}

function runHook(hookName, root, toolsDir, {
  payload, ikeyPath = '', optOut = '', killSwitch = '', envOverrides = {},
}) {
  assert.ok(TEST_ROOTS.has(root), 'hook tests require a registered temporary config directory root');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const env = isolatedEnv(configDir, toolsDir, {
    POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
    POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT: optOut,
    PCF_DISABLE_HOOKS: killSwitch,
    ...envOverrides,
  });
  // Validate after overrides and before spawn, even for malformed/kill-switch
  // cases: enabling the shipped config must never make a forgotten seam unsafe.
  assertHookIsolation(env, configDir);
  const audit = process.env.PCF_TELEMETRY_TEST_SPAWN_AUDIT;
  if (audit) {
    assert.ok(path.isAbsolute(audit) && inside(fs.realpathSync(os.tmpdir()), path.resolve(audit)),
      'fixture spawn audit must stay in a temporary directory');
    fs.appendFileSync(audit, JSON.stringify({
      hookName, configDir, probe: env.POWER_PLATFORM_SKILLS_FAKE_HTTPS, guarded: true,
    }) + '\n');
  }
  const preload = path.join(__dirname, 'telemetry-offline-preload.js');
  const result = spawnSync(process.execPath, ['--require', preload, path.join(PLUGIN_ROOT, 'hooks', hookName)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15_000,
    env,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout, '', 'telemetry must not interfere with the host protocol');
  assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(path.join(configDir, 'blocked-network.jsonl')), false,
    'a hook must not attempt real network I/O');
  return { configDir, probe: path.join(configDir, 'probe.json') };
}

module.exports = {
  PLUGIN_ROOT, TELEMETRY_DIR, ORG_ID, TENANT_ID, OBJECT_ID, USER,
  FAKE_CONFIG, FAKE_REGIONS, tempRoot, seedRegion, writeConfig,
  waitForJson, waitForDispatcher, assertHookIsolation, isolatedEnv, writePacStub, runHook,
};
