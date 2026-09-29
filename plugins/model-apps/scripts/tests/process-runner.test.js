'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runner = require('../lib/process-runner.js');

const scratchDirs = [];
const scratch = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
};
// Best effort: Windows can hold a just-exited executable (the copied node.exe below) open for a moment,
// and a cleanup error would fail the whole file rather than any test in it.
test.after(() => {
  for (const d of scratchDirs) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* left in the OS temp dir */ }
  }
});

const winEnv = (Path, extra = {}) => ({ Path, PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS', SystemRoot: 'C:\\Windows', ...extra });

test('resolveExecutable skips relative PATH entries and never looks in the current directory', () => {
  const seen = [];
  const exists = (p) => { seen.push(p); return false; };
  assert.strictEqual(runner.resolveExecutable('az', { platform: 'win32', env: winEnv('.;tools;;C:\\bin'), exists }), null);
  assert.ok(seen.every((p) => p.startsWith('C:\\bin\\')), `only the absolute entry is probed: ${seen}`);
  seen.length = 0;
  assert.strictEqual(runner.resolveExecutable('git', { platform: 'linux', env: { PATH: ':.:bin:/usr/bin' }, exists }), null);
  assert.deepStrictEqual(seen, ['/usr/bin/git']);
});

test('resolveExecutable follows PATH order, then PATHEXT order, and ignores script extensions', () => {
  const files = new Set(['C:\\b\\pac.cmd', 'C:\\b\\pac.exe', 'C:\\c\\pac.exe', 'C:\\a\\az.js']);
  const exists = (p) => files.has(p);
  const env = winEnv('C:\\a;C:\\b;C:\\c');
  assert.strictEqual(runner.resolveExecutable('pac', { platform: 'win32', env, exists }), 'C:\\b\\pac.exe');
  assert.strictEqual(runner.resolveExecutable('az', { platform: 'win32', env, exists }), null, '.JS is not something the runner will start');
});

test('invocation starts a native executable directly, with its arguments untouched', () => {
  const exists = (p) => p === 'C:\\tools\\pac.exe';
  const inv = runner.invocation('pac', ['model', 'genpage', 'upload', '--name', 'a "b" & 50%!'], { platform: 'win32', env: winEnv('C:\\tools'), exists });
  assert.strictEqual(inv.file, 'C:\\tools\\pac.exe');
  assert.deepStrictEqual(inv.args, ['model', 'genpage', 'upload', '--name', 'a "b" & 50%!']);
  assert.strictEqual(inv.options.shell, false);
  assert.strictEqual(inv.options.windowsVerbatimArguments, undefined);
});

test('invocation runs a batch shim through an absolute cmd.exe with a checked command line', () => {
  const exists = (p) => p === 'C:\\Program Files\\CLI2\\wbin\\az.cmd';
  const env = winEnv('C:\\Program Files\\CLI2\\wbin', { ComSpec: 'cmd.exe' });
  const inv = runner.invocation('az', ['account', 'get-access-token', '--resource', 'https://contoso.crm.dynamics.com', '--query', 'accessToken'], { platform: 'win32', env, exists });
  assert.strictEqual(inv.file, 'C:\\Windows\\System32\\cmd.exe', 'a relative ComSpec is not trusted');
  assert.deepStrictEqual(inv.args, ['/d', '/s', '/v:off', '/c',
    '""C:\\Program Files\\CLI2\\wbin\\az.cmd" account get-access-token --resource https://contoso.crm.dynamics.com --query accessToken"']);
  assert.strictEqual(inv.options.shell, false);
  assert.strictEqual(inv.options.windowsVerbatimArguments, true);
  assert.strictEqual(inv.options.env.NoDefaultCurrentDirectoryInExePath, '1');
});

test('a batch shim refuses what cmd.exe would reinterpret, before anything starts', () => {
  const exists = (p) => p === 'C:\\bin\\az.cmd';
  const opts = { platform: 'win32', env: winEnv('C:\\bin'), exists };
  for (const bad of ['a"b', '100%', '%PATH%', 'line\nbreak', 'tab\there', 'nul\u0000']) {
    assert.throws(() => runner.invocation('az', ['--x', bad], opts), (e) => e.code === 'EARGUMENT', JSON.stringify(bad));
  }
  assert.throws(() => runner.invocation('missing', [], opts), (e) => e.code === 'ENOENT');
});

test('! passes a shim that leaves delayed expansion off, and is refused by one that turns it on', () => {
  const exists = (p) => p === 'C:\\bin\\pac.cmd';
  const plain = { platform: 'win32', env: winEnv('C:\\bin'), exists, readFile: () => '@"%~dp0pac.exe" %*\r\n' };
  const inv = runner.invocation('pac', ['--name', 'Hello!', 'C:\\Users\\hello!\\page.tsx'], plain);
  assert.ok(inv.args[4].endsWith(' --name "Hello!" "C:\\Users\\hello!\\page.tsx""'), inv.args[4]);
  const expanding = { ...plain, readFile: () => '@setlocal EnableDelayedExpansion\r\n@"%~dp0pac.exe" %*\r\n' };
  assert.throws(() => runner.invocation('pac', ['--name', 'Hello!'], expanding), (e) => e.code === 'EARGUMENT' && /for this one/.test(e.message));
  const unreadable = { ...plain, readFile: () => { throw new Error('EACCES'); } };
  assert.throws(() => runner.invocation('pac', ['--name', 'Hello!'], unreadable), (e) => e.code === 'EARGUMENT');
  assert.doesNotThrow(() => runner.invocation('pac', ['--name', 'Hello'], unreadable), 'the shim is only read when an argument has a !');
});

test('when an env object spells PATH twice, resolution reads the one Node passes the child', () => {
  // Node sends a Windows child the lexicographically first spelling: `PATH` sorts before `Path`.
  const env = { Path: 'C:\\old', PATH: 'C:\\new', PATHEXT: '.CMD' };
  assert.strictEqual(runner.envValue(env, 'PATH', 'win32'), 'C:\\new');
  const exists = (p) => p === 'C:\\old\\npm.cmd' || p === 'C:\\new\\npm.cmd';
  assert.strictEqual(runner.resolveExecutable('npm', { platform: 'win32', env, exists }), 'C:\\new\\npm.cmd');
  assert.strictEqual(runner.envValue({ Path: 'C:\\only' }, 'PATH', 'win32'), 'C:\\only');
  assert.strictEqual(runner.envValue({ Path: 'x' }, 'PATH', 'linux'), undefined, 'POSIX names are case-sensitive');
});
test('withPathFirst puts a directory first on the path the child will actually receive', () => {
  // Windows: every spelling collapses into one PATH carrying the value Node would pass.
  const win = runner.withPathFirst({ Path: 'C:\\old', PATH: 'C:\\sys', X: '1' }, 'C:\\node20', 'win32');
  assert.deepStrictEqual(win, { X: '1', PATH: 'C:\\node20;C:\\sys' });
  assert.deepStrictEqual(runner.withPathFirst({ Path: 'C:\\sys' }, 'C:\\node20', 'win32'), { PATH: 'C:\\node20;C:\\sys' });
  // POSIX: Path and PATH are different variables; only PATH changes.
  const posix = runner.withPathFirst({ Path: '/not-the-path', PATH: '/usr/bin' }, '/opt/node20/bin', 'linux');
  assert.deepStrictEqual(posix, { Path: '/not-the-path', PATH: '/opt/node20/bin:/usr/bin' });
  assert.deepStrictEqual(runner.withPathFirst({}, '/opt/node20/bin', 'linux'), { PATH: '/opt/node20/bin' });
});
test('a batch shim whose own path cmd.exe would expand is refused', () => {
  for (const dir of ['C:\\100%\\bin', 'C:\\wow!\\bin']) {
    const exists = (p) => p === `${dir}\\az.cmd`;
    assert.throws(() => runner.invocation('az', ['--version'], { platform: 'win32', env: winEnv(dir), exists }), (e) => e.code === 'EARGUMENT', dir);
  }
});

test('cmdArgument quotes what needs quoting and doubles a trailing backslash run', () => {
  assert.strictEqual(runner.cmdArgument('{user:user.name,tenantId:tenantId}'), '{user:user.name,tenantId:tenantId}');
  assert.strictEqual(runner.cmdArgument('Order Detail'), '"Order Detail"');
  assert.strictEqual(runner.cmdArgument('a&b|c<d>e^f(g)'), '"a&b|c<d>e^f(g)"');
  assert.strictEqual(runner.cmdArgument('C:\\out dir\\'), '"C:\\out dir\\\\"');
  assert.strictEqual(runner.cmdArgument(''), '""');
  assert.strictEqual(runner.cmdArgument('x"y'), null);
});

test('caller options are merged under the invocation, so a shell cannot be turned back on', () => {
  const exists = (p) => p === 'C:\\bin\\az.cmd';
  const inv = runner.invocation('az', ['--version'], { platform: 'win32', env: winEnv('C:\\bin'), exists });
  const merged = runner.withOptions(inv, { shell: true, windowsVerbatimArguments: false, encoding: 'utf8', env: { X: '1' } });
  assert.strictEqual(merged.shell, false);
  assert.strictEqual(merged.windowsVerbatimArguments, true);
  assert.strictEqual(merged.encoding, 'utf8');
  assert.deepStrictEqual(merged.env, { X: '1', NoDefaultCurrentDirectoryInExePath: '1' }, 'a caller env is kept, with the lookup guard added');
  const native = runner.invocation('az', [], { platform: 'linux', env: { PATH: '/usr/bin' }, exists: (p) => p === '/usr/bin/az' });
  assert.deepStrictEqual(runner.withOptions(native, { shell: '/bin/sh', env: { X: '1' } }), { shell: false, windowsHide: true, env: { X: '1' } });
});

test('spawnResultSync reports a command missing from PATH the way spawnSync reports a launch failure', () => {
  const r = runner.spawnResultSync('nope', [], {}, { platform: 'linux', env: { PATH: '/x' }, exists: () => false });
  assert.strictEqual(r.status, null);
  assert.strictEqual(r.error.code, 'ENOENT');
  assert.match(r.error.message, /spawn nope ENOENT/);
});
test('execFileAsync reports an unresolvable command through its callback, asynchronously', async () => {
  let sync = true;
  const err = await new Promise((resolve) => {
    runner.execFileAsync('nope', [], {}, (e) => resolve({ e, sync }), { platform: 'linux', env: { PATH: '/x' }, exists: () => false });
    sync = false;
  });
  assert.strictEqual(err.e.code, 'ENOENT');
  assert.strictEqual(err.sync, false);
});

// The real thing: a batch shim that forwards %* to node, exactly as az.cmd and npm.cmd do, reached
// through the runner. Every accepted value must arrive byte-for-byte, and nothing may run besides it.
test('a batch shim receives accepted arguments unchanged through a real cmd.exe', { skip: process.platform !== 'win32' }, () => {
  const dir = scratch('process-runner-shim-');
  const script = path.join(dir, 'argv.js');
  fs.writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'fakecli.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  const marker = path.join(dir, 'MARKER');
  const env = { ...process.env, Path: dir, PATH: dir };
  const values = [
    'https://contoso.crm.dynamics.com',
    '{user:user.name,tenantId:tenantId}',
    'Order Detail',
    `a & echo x> ${marker}`,
    'a | b < c > d ^ e ( f )',
    'C:\\Users\\Power User\\download\\',
    '東京 page',
    '',
    'trailing space ',
    'Hello!',
    'C:\\Users\\hello!\\page.tsx',
  ];
  const out = runner.runSync('fakecli', [...values, 'after'], { encoding: 'utf8', timeout: 30000 }, { env });
  assert.deepStrictEqual(JSON.parse(out), [...values, 'after']);
  assert.ok(!fs.existsSync(marker), 'no command other than the shim ran');
});

test('a native executable receives any argument unchanged through the runner', { skip: process.platform !== 'win32' }, () => {
  const dir = scratch('process-runner-native-');
  fs.copyFileSync(process.execPath, path.join(dir, 'fakenode.exe'));
  const env = { ...process.env, Path: dir, PATH: dir };
  const values = ['a "quoted" value', '100% & more!', 'C:\\dir with space\\', 'x\\"y'];
  const out = runner.runSync('fakenode', ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values], { encoding: 'utf8', timeout: 30000 }, { env });
  assert.deepStrictEqual(JSON.parse(out), values);
});
