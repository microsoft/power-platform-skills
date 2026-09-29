'use strict';
// The bundled shared telemetry library starts pac through native-exec.js: by absolute path from
// PATH, never by bare name. The hooks run in the user's project folder, and Node 20 on Windows looks
// for a bare command name in the working directory before PATH, so a `pac.exe` in a project would
// otherwise run instead of the real one. (This file tests the model-apps copy, which
// telemetry-lib-copy.test.js keeps identical to shared/telemetry/lib.)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib', 'telemetry', 'lib');
const { resolveNative, runNative } = require(path.join(LIB, 'native-exec.js'));

test('resolveNative looks only in absolute PATH entries, never the working directory', () => {
  const probed = [];
  const exists = (p) => { probed.push(p); return false; };
  assert.equal(resolveNative('pac', { platform: 'win32', env: { Path: '.;tools;;C:\\bin' }, exists }), null);
  assert.deepEqual(probed, ['C:\\bin\\pac.com', 'C:\\bin\\pac.exe']);
  probed.length = 0;
  assert.equal(resolveNative('pac', { platform: 'linux', env: { PATH: ':.:bin:/usr/bin' }, exists }), null);
  assert.deepEqual(probed, ['/usr/bin/pac'], 'an empty POSIX entry means the current directory, and is skipped');
});

test('resolveNative tries .com then .exe on Windows whatever PATHEXT says, and never a batch file', () => {
  const files = new Set(['C:\\a\\pac.cmd', 'C:\\b\\pac.com', 'C:\\b\\pac.exe', 'C:\\c\\pac.exe']);
  const exists = (p) => files.has(p);
  const env = { Path: 'C:\\a;C:\\b', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
  assert.equal(resolveNative('pac', { platform: 'win32', env, exists }), 'C:\\b\\pac.com', 'a pac.cmd earlier on PATH is not a native executable');
  // Node's shell-free lookup ignores PATHEXT, so an unusual value must not hide a working pac.exe.
  assert.equal(resolveNative('pac', { platform: 'win32', env: { Path: 'C:\\c', PATHEXT: '.CMD;.BAT' }, exists }), 'C:\\c\\pac.exe');
});

test('a non-executable pac earlier on PATH does not hide a runnable one (macOS/Linux)', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-exec-x-'));
  try {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, 'pac'), '#!/bin/sh\n', { mode: 0o644 });
    fs.writeFileSync(path.join(second, 'pac'), '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(resolveNative('pac', { env: { PATH: `${first}:${second}` } }), path.join(second, 'pac'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the default predicate is what skips a candidate that cannot be run', () => {
  // Platform-independent: the second candidate is chosen when the first is rejected.
  const exists = (p) => p === '/b/pac';
  assert.equal(resolveNative('pac', { platform: 'linux', env: { PATH: '/a:/b' }, exists }), '/b/pac');
});

test('resolveNative reads the PATH spelling Node passes a Windows child', () => {
  const exists = (p) => p === 'C:\\new\\pac.exe' || p === 'C:\\old\\pac.exe';
  assert.equal(resolveNative('pac', { platform: 'win32', env: { Path: 'C:\\old', PATH: 'C:\\new' }, exists }), 'C:\\new\\pac.exe');
});

test('runNative reports a missing tool as ENOENT without starting anything', () => {
  assert.throws(() => runNative('pac', ['auth', 'who'], {}, { platform: 'linux', env: { PATH: '/nowhere' }, exists: () => false }),
    (e) => e.code === 'ENOENT');
});

test('pac-auth and agent-info start pac only through native-exec', () => {
  for (const file of ['pac-auth.js', 'agent-info.js']) {
    const src = fs.readFileSync(path.join(LIB, file), 'utf8');
    assert.doesNotMatch(src, /require\(["'](?:node:)?child_process["']\)/, `${file} must not start processes itself`);
    assert.match(src, /require\("\.\/native-exec"\)/, `${file} must use native-exec`);
  }
});

test('a pac.exe in the working directory is never run (real Windows lookup)', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-exec-'));
  const project = path.join(root, 'project');
  const tools = path.join(root, 'tools');
  fs.mkdirSync(project);
  fs.mkdirSync(tools);
  // A copy of node stands in for a planted pac: if it ran, `-p` would print its own path.
  fs.copyFileSync(process.execPath, path.join(project, 'nativeprobe.exe'));
  const saved = process.cwd();
  try {
    process.chdir(project);
    assert.throws(() => runNative('nativeprobe', ['-p', 'process.execPath'], { encoding: 'utf8' }, { env: { Path: tools, PATHEXT: '.EXE' } }),
      (e) => e.code === 'ENOENT', 'the copy in the working directory must not be found');
    fs.copyFileSync(process.execPath, path.join(tools, 'nativeprobe.exe'));
    const out = runNative('nativeprobe', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 30000 }, { env: { Path: tools, PATHEXT: '.EXE' } });
    assert.equal(String(out).trim(), path.join(tools, 'nativeprobe.exe'), 'the one on PATH runs');
  } finally {
    process.chdir(saved);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left in the OS temp dir */ }
  }
});
