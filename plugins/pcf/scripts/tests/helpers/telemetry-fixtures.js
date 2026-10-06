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

function tempRoot(t, prefix = 'pcf-telemetry-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
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
  // The override loads the REAL pcf resolver, not a stand-in. Block HTTPS before
  // loading it in both the hook and dispatcher: a missing cache must fail this
  // test, never make an Artemis request. POSTs use the shared fake-probe seam.
  fs.writeFileSync(path.join(dir, 'resolver.js'), [
    "require('node:https').request = () => { throw new Error('offline test forbids HTTPS'); };",
    // The local mirror precedes the transmission gate. Wait for the dispatcher
    // to exit before asserting no probe, rather than racing its next instruction.
    `if (require('node:path').basename(process.argv[1] || '') === 'emit-dispatcher.js') process.on('exit', () => require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, 'dispatcher-exited.json'))}, '{"exited":true}'));`,
    `module.exports = require(${JSON.stringify(path.join(TELEMETRY_DIR, 'resolver.js'))});`,
    '',
  ].join('\n'));
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

function waitForDispatcher(ikeyPath) {
  assert.deepEqual(waitForJson(path.join(path.dirname(ikeyPath), 'dispatcher-exited.json')), { exited: true });
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

function runHook(hookName, root, toolsDir, { payload, ikeyPath = '', optOut = '', killSwitch = '' }) {
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'hooks', hookName)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15_000,
    env: isolatedEnv(configDir, toolsDir, {
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
      POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT: optOut,
      PCF_DISABLE_HOOKS: killSwitch,
    }),
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout, '', 'telemetry must not interfere with the host protocol');
  assert.equal(result.stderr, '');
  return { configDir, probe: path.join(configDir, 'probe.json') };
}

module.exports = {
  PLUGIN_ROOT, TELEMETRY_DIR, ORG_ID, TENANT_ID, OBJECT_ID, USER,
  FAKE_CONFIG, FAKE_REGIONS, tempRoot, seedRegion, writeConfig,
  waitForJson, waitForDispatcher, isolatedEnv, writePacStub, runHook,
};
