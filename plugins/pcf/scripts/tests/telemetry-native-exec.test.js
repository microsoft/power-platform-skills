'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib', 'telemetry', 'lib');

function nativeExec() {
  const file = path.join(LIB, 'native-exec.js');
  assert.ok(fs.existsSync(file), 'pcf must bundle the audited native-exec module');
  return require(file);
}

test('telemetry resolves PAC only from absolute PATH entries, never cwd', () => {
  const { resolveNative } = nativeExec();
  const probed = [];
  const exists = (file) => { probed.push(file); return false; };
  assert.equal(resolveNative('pac', { platform: 'win32', env: { Path: '.;tools;;C:\\bin' }, exists }), null);
  assert.deepEqual(probed, ['C:\\bin\\pac.com', 'C:\\bin\\pac.exe']);
  probed.length = 0;
  assert.equal(resolveNative('pac', { platform: 'linux', env: { PATH: ':.:bin:/usr/bin' }, exists }), null);
  assert.deepEqual(probed, ['/usr/bin/pac']);
});

test('telemetry never runs a Windows PAC batch shim, regardless of PATHEXT', () => {
  const { resolveNative } = nativeExec();
  const files = new Set(['C:\\a\\pac.cmd', 'C:\\b\\pac.com', 'C:\\b\\pac.exe']);
  assert.equal(resolveNative('pac', {
    platform: 'win32',
    env: { Path: 'C:\\a;C:\\b', PATHEXT: '.CMD;.BAT' },
    exists: (file) => files.has(file),
  }), 'C:\\b\\pac.com');
});

test('telemetry reads the PATH spelling Node forwards to a Windows child', () => {
  const { resolveNative } = nativeExec();
  assert.equal(resolveNative('pac', {
    platform: 'win32',
    env: { Path: 'C:\\old', PATH: 'C:\\new' },
    exists: (file) => file === 'C:\\new\\pac.exe' || file === 'C:\\old\\pac.exe',
  }), 'C:\\new\\pac.exe');
});

test('telemetry reports a missing native tool without spawning anything', () => {
  const { runNative } = nativeExec();
  assert.throws(() => runNative('pac', ['auth', 'who'], {}, {
    platform: 'linux', env: { PATH: '/nowhere' }, exists: () => false,
  }), (error) => error.code === 'ENOENT');
});

test('telemetry enrichment uses only the audited native-exec entry point', () => {
  nativeExec();
  for (const file of ['pac-auth.js', 'agent-info.js']) {
    const source = fs.readFileSync(path.join(LIB, file), 'utf8');
    assert.doesNotMatch(source, /require\(["'](?:node:)?child_process["']\)/);
    assert.match(source, /require\("\.\/native-exec"\)/);
  }
});

test('a planted cwd executable cannot replace the PATH executable on Windows', {
  skip: process.platform !== 'win32',
}, (t) => {
  const { runNative } = nativeExec();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcf-telemetry-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const tools = path.join(root, 'tools');
  fs.mkdirSync(project);
  fs.mkdirSync(tools);
  fs.copyFileSync(process.execPath, path.join(project, 'nativeprobe.exe'));
  const previousCwd = process.cwd();
  try {
    process.chdir(project);
    const deps = { env: { Path: tools, PATHEXT: '.EXE' } };
    assert.throws(() => runNative('nativeprobe', ['-p', 'process.execPath'], { encoding: 'utf8' }, deps),
      (error) => error.code === 'ENOENT');
    fs.copyFileSync(process.execPath, path.join(tools, 'nativeprobe.exe'));
    const stdout = runNative('nativeprobe', ['-p', 'process.execPath'], {
      encoding: 'utf8', timeout: 30_000,
    }, deps);
    assert.equal(String(stdout).trim(), path.join(tools, 'nativeprobe.exe'));
  } finally {
    process.chdir(previousCwd);
  }
});
