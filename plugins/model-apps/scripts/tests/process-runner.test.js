'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const runner = require('../lib/process-runner.js');
const { clockStartedWith } = require('./helpers/started-clock.js');

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

// ── a launcher that only forwards ──────────────────────────────────────────────────────────────────────────────────────────────
// The Windows MSI installs pac as a two-line pac.cmd beside a native pac.launcher.exe. Run through cmd.exe, a `%` or a double quote in an argument cannot reach pac
// unchanged (and is refused for that reason), so such a launcher is recognised by its EXACT text and its program is started directly, with every argument as given.
const MSI_LAUNCHER = '@echo off\r\n"%~dp0pac.launcher.exe" %*\r\n';

test('forwardedProgram recognises a launcher that only starts the program beside it with %*, and nothing that does more or less', () => {
  const present = new Set(['C:\\Pac\\pac.cmd', 'C:\\Pac\\pac.launcher.exe']);
  const forwarded = (text, options = {}) => runner.forwardedProgram('C:\\Pac\\pac.cmd', { readFile: () => text, exists: (p) => present.has(p), ...options });
  for (const text of [
    MSI_LAUNCHER,
    '@echo off\n"%~dp0pac.launcher.exe" %*\n',
    '@echo off\r\n"%~dp0pac.launcher.exe" %*',
    '\uFEFF@echo off\r\n"%~dp0pac.launcher.exe" %*\r\n',
    '@ECHO OFF\r\n@"%~dp0pac.launcher.exe" %*\r\n',
    '"%~dp0pac.launcher.exe" %*\r\n',
    'echo off\r\n"%~dp0pac.launcher.exe"   %*\r\n\r\n',
  ]) assert.strictEqual(forwarded(text), 'C:\\Pac\\pac.launcher.exe', JSON.stringify(text));
  // Blank lines — nothing but spaces and tabs — are no-ops to cmd.exe, wherever they stand; so are leading and trailing spaces on a line and the case of the words.
  for (const text of [
    '\r\n\r\n@echo off\r\n\r\n"%~dp0pac.launcher.exe" %*\r\n\r\n',
    '  \t\r\n@echo off  \r\n \t \r\n  "%~dp0pac.launcher.exe" %*  \t\r\n',
    '@Echo   Off\r\n"%~DP0pac.launcher.exe" %*\r\n',
    '\uFEFF\r\n"%~dp0pac.launcher.exe" %*\r\n',
  ]) assert.strictEqual(forwarded(text), 'C:\\Pac\\pac.launcher.exe', JSON.stringify(text));
  // Whatever the program is named, the text alone decides: every file is there, and none of these is a launcher that only forwards.
  for (const text of [
    '@echo off\r\nset PAC_X=1\r\n"%~dp0pac.launcher.exe" %*\r\n',
    '@echo off\r\n"%~dp0pac.launcher.exe" %* & echo done\r\n',
    '@echo off\r\n"%~dp0pac.launcher.exe" %1 %2\r\n',
    '@echo off\r\n"%~dp0pac.launcher.exe" --verbose %*\r\n',
    '@echo off\r\n"%~dp0pac.launcher.exe" %*\r\nexit /b 1\r\n',
    '@echo off\r\ncall "%~dp0pac.launcher.exe" %*\r\n',
    '@echo off\r\n"%~dp0bin\\pac.launcher.exe" %*\r\n',
    '@echo off\r\n"%~dp0..\\pac.launcher.exe" %*\r\n',
    '@echo off\r\n"C:\\Tools\\pac.launcher.exe" %*\r\n',
    '@echo off\r\n"%~dp0pac.cmd" %*\r\n',
    '@echo off\r\n"%~dp0pac.launcher.exe" ^%*\r\n',
    '',
  ]) assert.strictEqual(forwarded(text, { exists: () => true }), null, JSON.stringify(text));
  // The lines are cmd.exe's, not the regular expression's: `echo off "…"` on ONE line is the ECHO command with an argument — cmd.exe prints it and starts nothing — so a text that
  // only LOOKS like a forwarder is not one, whatever separates its words; nor is anything that is not exactly an optional `@echo off` line and then the one forwarding line.
  for (const text of [
    '@echo off "%~dp0pac.launcher.exe" %*\r\n',
    '@echo off "%~dp0pac.launcher.exe" %*',
    'echo off   "%~dp0pac.launcher.exe" %*\n',
    '@echo off\t"%~dp0pac.launcher.exe" %*\r\n',
    '@echo off & "%~dp0pac.launcher.exe" %*\r\n',
    '@echo off && "%~dp0pac.launcher.exe" %*\r\n',
    '@echo off ^\r\n"%~dp0pac.launcher.exe" %*\r\n',
    '@echo off\r\n"%~dp0pac.launcher.exe" %*^\r\n',
    '@echo on\r\n"%~dp0pac.launcher.exe" %*\r\n',
    '@echo off.\r\n"%~dp0pac.launcher.exe" %*\r\n',
    '@echo,off\r\n"%~dp0pac.launcher.exe" %*\r\n',
    '@echo off\r\n@echo off\r\n"%~dp0pac.launcher.exe" %*\r\n',
    '"%~dp0pac.launcher.exe" %*\r\n@echo off\r\n',
    '"%~dp0pac.launcher.exe" %*\r\n"%~dp0pac.launcher.exe" %*\r\n',
    '@echo off\r\n"%~dp0pac.launcher.exe" %*\r\n:end\r\n',
    '@echo off\r\nREM a comment\r\n"%~dp0pac.launcher.exe" %*\r\n',
    '@echo off\r\r"%~dp0pac.launcher.exe" %*\r\n',
    '@echo off\r"%~dp0pac.launcher.exe" %*\r\n',
    '@echo off\n\u00a0\n"%~dp0pac.launcher.exe" %*\n',
    '@echo off\r\n"%~dp0pac.launcher.exe" %*\u0000\r\n',
    '@echo off\r\n"%~dp0pac.launcher.exe" %*\f\r\n',
  ]) assert.strictEqual(forwarded(text, { exists: () => true }), null, JSON.stringify(text));
  assert.strictEqual(forwarded(MSI_LAUNCHER + ' '.repeat(2000), { exists: () => true }), null, 'a launcher this simple is a few dozen bytes: a large file is not one');
  assert.strictEqual(forwarded(MSI_LAUNCHER, { exists: (p) => p === 'C:\\Pac\\pac.cmd' }), null, 'the program it names has to be there');
  assert.strictEqual(forwarded(MSI_LAUNCHER, { readFile: () => { throw new Error('EACCES'); }, exists: () => true }), null, 'a launcher that cannot be read is not recognised');
});

test('a launcher that only forwards is started as its program, so a % or a double quote reaches it unchanged — and a batch file that does anything else keeps the checked route and its refusals', () => {
  const present = new Set(['C:\\Pac\\pac.cmd', 'C:\\Pac\\pac.launcher.exe']);
  const options = { platform: 'win32', env: winEnv('C:\\Pac'), exists: (p) => present.has(p), readFile: () => MSI_LAUNCHER };
  const args = ['connection', 'list', 'https://contoso.sharepoint.com/sites/Team%20Site', '100%', '%PATH%', 'a "quoted" value', 'x\\"y', 'Hello!', 'a & b | c', ''];
  const inv = runner.invocation('pac', args, options);
  assert.strictEqual(inv.file, 'C:\\Pac\\pac.launcher.exe');
  assert.deepStrictEqual(inv.args, args);
  assert.deepStrictEqual(inv.options, { shell: false, windowsHide: true });
  for (const text of ['@echo off\r\nset PAC_X=1\r\n"%~dp0pac.launcher.exe" %*\r\n', '@echo off\r\n"%~dp0pac.launcher.exe" %1 %2\r\n']) {
    assert.throws(() => runner.invocation('pac', ['a', '100%'], { ...options, readFile: () => text }), (e) => e.code === 'EARGUMENT' && /cannot pass "100%" to pac\.cmd/.test(e.message), text);
  }
  assert.throws(() => runner.invocation('pac', ['100%'], { ...options, exists: (p) => p === 'C:\\Pac\\pac.cmd' }), (e) => e.code === 'EARGUMENT', 'no program beside it: the checked route');
  // Only a batch file is looked into: a native pac.exe is started as it always was, and so is anything that is not on Windows.
  assert.strictEqual(runner.invocation('pac', ['100%'], { platform: 'win32', env: winEnv('C:\\Pac'), exists: (p) => p === 'C:\\Pac\\pac.exe', readFile: () => { throw new Error('not read'); } }).file, 'C:\\Pac\\pac.exe');
  assert.strictEqual(runner.invocation('pac', ['100%'], { platform: 'linux', env: { PATH: '/opt/pac' }, exists: (p) => p === '/opt/pac/pac', readFile: () => { throw new Error('not read'); } }).file, '/opt/pac/pac');
});

test('through the runner, an MSI-shaped pac.cmd hands every argument to its native program unchanged — a % and a double quote included — and no command inside one runs', { skip: process.platform !== 'win32' }, () => {
  const dir = scratch('process-runner-msi-');
  const program = path.join(dir, 'report-arguments.js');
  // node.exe stands in for pac.launcher.exe: the preload answers before node looks for the script its first argument would name (which is why that argument is a plain word).
  fs.writeFileSync(program, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(0);\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'pac.cmd'), MSI_LAUNCHER, 'utf8');
  fs.copyFileSync(process.execPath, path.join(dir, 'pac.launcher.exe'));
  const marker = path.join(dir, 'MARKER');
  // Inside double quotes NODE_OPTIONS reads a backslash as an escape, which JSON.stringify's doubled backslashes satisfy.
  const env = { ...process.env, Path: dir, PATH: dir, NODE_OPTIONS: `--require=${JSON.stringify(program)}` };
  const values = [
    'https://contoso.sharepoint.com/sites/Team%20Site',
    '100%',
    '%PATH%',
    '%PATH%!x',
    'a "quoted" value',
    'x\\"y',
    'C:\\dir with space\\',
    `a & echo x> ${marker}`,
    'a | b < c > d ^ e ( f )',
    'Hello!',
    '東京 page',
    '',
  ];
  const out = runner.runSync('pac', ['check', ...values], { encoding: 'utf8', timeout: 30000, env }, { env });
  assert.deepStrictEqual(JSON.parse(out), values);
  assert.ok(!fs.existsSync(marker), 'no command other than the program ran');
});

// What cmd.exe makes of `@echo off "%~dp0x.exe" %*` on ONE line is the ECHO command with arguments: it prints them and starts nothing. A runner that read the text as a forwarder would
// start x.exe itself — running a program the batch file never ran, with arguments (a `%`) that the checked route refuses — so the real launcher decides, not a lookalike.
test('a one-line `@echo off "%~dp0x.exe" %*` is the ECHO command, not a forwarder: through the runner it starts nothing — as under cmd.exe — and keeps the refusal of a %', { skip: process.platform !== 'win32' }, () => {
  const dir = scratch('process-runner-echo-');
  const marker = path.join(dir, 'RAN');
  const payload = path.join(dir, 'payload.cjs');
  fs.writeFileSync(payload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'the native program ran');\n`, 'utf8');
  fs.copyFileSync(process.execPath, path.join(dir, 'not-pac.exe'));
  fs.writeFileSync(path.join(dir, 'pac.cmd'), '@echo off "%~dp0not-pac.exe" %*\r\n', 'utf8');
  const env = { ...process.env, Path: dir, PATH: dir };

  assert.strictEqual(runner.forwardedProgram(path.join(dir, 'pac.cmd')), null, 'the file is not recognised as a forwarder');
  // An argument cmd.exe can carry: the launcher runs under cmd.exe, which echoes its words — the program is never started.
  const echoed = runner.spawnResultSync('pac', [payload, 'plain'], { encoding: 'utf8', timeout: 30000, env }, { env });
  assert.strictEqual(echoed.error, undefined);
  assert.strictEqual(echoed.status, 0);
  assert.match(echoed.stdout, /^off "[^"]*not-pac\.exe" /, 'cmd.exe printed what the line says');
  assert.ok(!fs.existsSync(marker), 'the program beside the launcher was not started');
  // The `%` the checked route refuses: it is refused, and still nothing runs.
  const refused = runner.spawnResultSync('pac', [payload, '100%'], { encoding: 'utf8', timeout: 30000, env }, { env });
  assert.strictEqual(refused.error && refused.error.code, 'EARGUMENT');
  assert.ok(!fs.existsSync(marker), 'nothing ran for the refused argument either');
});

// ── killProcessTree ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A call that ran out of time must end the process it started AND everything under it. On Windows pac is often a `pac.cmd` shim — cmd.exe, which
// runs pac.exe — and ending the shim alone leaves the stalled pac running. The kill goes through the runner (taskkill resolved to an absolute path,
// never from the current directory) and never throws: the caller is already handling a failure.
const fakeChild = (pid) => {
  const killed = [];
  return { pid, killed, kill: (signal) => { killed.push(signal); return true; } };
};

test('killProcessTree ends the Windows tree with taskkill /T /F, and asks the process itself to die as well', () => {
  const runs = [];
  const child = fakeChild(4242);
  runner.killProcessTree(child, { platform: 'win32', run: (name, args, options) => { runs.push({ name, args, options }); return { status: 0 }; } });
  assert.deepStrictEqual(runs.map((r) => [r.name, r.args]), [['taskkill', ['/pid', '4242', '/T', '/F']]]);
  assert.strictEqual(runs[0].options.stdio, 'ignore');
  assert.ok(runs[0].options.timeout > 0, 'taskkill itself is bounded');
  assert.deepStrictEqual(child.killed, ['SIGKILL'], 'a tree kill that missed the process cannot leave it running');
});

// A recording `ps` for the POSIX tree kill: the `-A` listing is `rows` (pid, parent pid, start time), and `ps -o lstart= -p <pid>` answers with
// `now[pid]` when given (a process that started at another time, or `null` for one that is gone), else with the listing's own start time.
function fakePs(rows, now = {}) {
  const runs = [];
  const listing = rows.map(([pid, ppid, started]) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)}${started ? ` ${started}` : ''}`).join('\n');
  const run = (name, args, options) => {
    runs.push({ name, args, options });
    if (args[0] === '-A') return { status: 0, stdout: `${listing}\n` };
    const pid = Number(args[args.indexOf('-p') + 1]);
    const answer = Object.prototype.hasOwnProperty.call(now, pid) ? now[pid] : (rows.find(([p]) => p === pid) || [])[2];
    return answer == null ? { status: 1, stdout: '' } : { status: 0, stdout: `${answer}\n` };
  };
  return { runs, run };
}

test('killProcessTree kills a POSIX process and every descendant ps lists under it — and nothing else', () => {
  //    PID  PPID STARTED      (the `=` after each name in `-o pid=,ppid=,lstart=` leaves no header line)
  const ps = fakePs([
    [1, 0, 'Mon Oct 12 08:00:00 2026'], [100, 1, 'Mon Oct 12 08:00:01 2026'], [4242, 100, 'Mon Oct 12 09:12:30 2026'],
    [5000, 4242, 'Mon Oct 12 09:12:31 2026'], [5001, 5000, 'Mon Oct 12 09:12:32 2026'], [5002, 4242, 'Mon Oct  5 09:12:33 2026'],
    [7000, 100, 'Mon Oct 12 09:12:34 2026'],
  ]);
  const killedPids = [];
  const child = fakeChild(4242);
  runner.killProcessTree(child, { platform: 'linux', run: ps.run, kill: (pid, signal) => { killedPids.push([pid, signal]); } });
  assert.deepStrictEqual(ps.runs[0].args, ['-A', '-o', 'pid=,ppid=,lstart='], 'one listing, with each process\'s start time');
  assert.strictEqual(ps.runs[0].options.encoding, 'utf8');
  assert.deepStrictEqual(killedPids.map(([pid]) => pid).sort(), [5000, 5001, 5002], 'the grandchild too; not the parent, its sibling or init');
  assert.ok(killedPids.every(([, signal]) => signal === 'SIGKILL'), 'a stalled process may ignore SIGTERM');
  assert.deepStrictEqual(child.killed, ['SIGKILL']);
  // The grandchild goes before the child it hangs from is gone for good: deepest first, so no process is orphaned into init half-killed.
  assert.ok(killedPids.findIndex(([pid]) => pid === 5001) < killedPids.findIndex(([pid]) => pid === 5000));
  // Each one is looked at again just before its signal, by itself: the pid must still name the process the listing saw. The order is the listing's
  // breadth-first walk reversed (4242's children 5000 and 5002, then 5000's child 5001), so 5001 comes before the 5000 it hangs from.
  assert.deepStrictEqual(ps.runs.slice(1).map((r) => r.args), [5001, 5002, 5000].map((pid) => ['-o', 'lstart=', '-p', String(pid)]));
});

// The listing is a moment old by the time each descendant is signalled. One that exited since can have its pid given to an unrelated process, and
// SIGKILL by that number would end it — so a pid that now names a process that started at another time, or names none, is left alone.
test('killProcessTree does not signal a descendant whose pid now names another process, or none — only one that is still the same', () => {
  const ps = fakePs(
    [[4242, 100, 'Mon Oct 12 09:12:30 2026'], [5000, 4242, 'Mon Oct 12 09:12:31 2026'], [5001, 4242, 'Mon Oct 12 09:12:32 2026'], [5002, 4242, 'Mon Oct 12 09:12:33 2026']],
    { 5000: 'Mon Oct 12 09:14:02 2026', 5002: null },
  );
  const killed = [];
  const child = fakeChild(4242);
  runner.killProcessTree(child, { platform: 'linux', run: ps.run, kill: (pid) => killed.push(pid) });
  assert.deepStrictEqual(killed, [5001], '5000 now started later (its pid was given out again) and 5002 is gone');
  assert.deepStrictEqual(child.killed, ['SIGKILL'], 'the child itself is still ended');
  // A recheck that throws, or a listing that printed no start time (a ps that ignored lstart), signals nothing but the child either.
  for (const run of [
    (name, args) => (args[0] === '-A' ? { status: 0, stdout: ' 4242 100 Mon Oct 12 09:12:30 2026\n 5000 4242 Mon Oct 12 09:12:31 2026\n' } : (() => { throw new Error('spawn ps ENOENT'); })()),
    (name, args) => (args[0] === '-A' ? { status: 0, stdout: ' 4242 100\n 5000 4242\n' } : { status: 0, stdout: '' }),
  ]) {
    const other = fakeChild(4242);
    const signalled = [];
    assert.doesNotThrow(() => runner.killProcessTree(other, { platform: 'linux', run, kill: (pid) => signalled.push(pid) }));
    assert.deepStrictEqual(signalled, []);
    assert.deepStrictEqual(other.killed, ['SIGKILL']);
  }
});

test('startTimes reads each pid\'s start time from a ps listing as one-spaced text, and none from a line without one', () => {
  const text = ['    1     0 Mon Oct 12 08:00:00 2026', ' 4242   100 Mon Oct  5 09:12:30 2026  ', '\t5000\t4242', 'PID PPID STARTED', ''].join('\r\n');
  const started = runner.startTimes(text);
  assert.strictEqual(started.get(1), 'Mon Oct 12 08:00:00 2026');
  assert.strictEqual(started.get(4242), 'Mon Oct 5 09:12:30 2026', 'runs of spaces are one, as the recheck reads them');
  assert.strictEqual(started.has(5000), false);
  assert.strictEqual(runner.startTimes(undefined).size, 0);
  // The same listing still gives the tree.
  assert.deepStrictEqual(runner.descendantPids(100, text), [4242, 5000]);
});

test('killProcessTree still ends the process when taskkill or ps fails, throws or is absent, and never throws', () => {
  for (const [platform, run] of [
    ['win32', () => ({ status: 128, stdout: '' })],
    ['win32', () => { throw new Error('spawn taskkill ENOENT'); }],
    ['win32', () => ({ status: null, error: new Error('timed out') })],
    ['linux', () => ({ status: 1, stdout: '' })],
    ['linux', () => { throw new Error('spawn ps ENOENT'); }],
    ['linux', () => ({ status: 0, stdout: 'not a process listing' })],
  ]) {
    const child = fakeChild(4242);
    const kills = [];
    assert.doesNotThrow(() => runner.killProcessTree(child, { platform, run, kill: (pid) => kills.push(pid) }));
    assert.deepStrictEqual(child.killed, ['SIGKILL'], `${platform}: the process itself is killed`);
    assert.deepStrictEqual(kills, [], `${platform}: nothing else is guessed at`);
  }
  // A process that is already gone, or one whose kill throws, is not an error either.
  const gone = { pid: 4242, kill: () => { throw new Error('ESRCH'); } };
  assert.doesNotThrow(() => runner.killProcessTree(gone, { platform: 'linux', run: () => ({ status: 0, stdout: '' }), kill: () => { throw new Error('ESRCH'); } }));
});

// A child that has already exited can no longer be named by its pid: 'exit' comes before 'close' when a process the child started still holds its pipes — the case a call that runs out
// of time is stopped in — and the number can belong to another process by then, so a tree kill by it could end that one and everything it started. No tool is run against such a child.
test('killProcessTree does not end a tree by the pid of a child that has already exited — it only asks the child to die', () => {
  for (const [what, exited] of [['exited with a code', { exitCode: 0 }], ['exited non-zero', { exitCode: 1 }], ['ended by a signal', { exitCode: null, signalCode: 'SIGTERM' }]]) {
    for (const platform of ['win32', 'linux']) {
      const child = { ...fakeChild(4242), ...exited };
      const runs = [];
      const kills = [];
      assert.doesNotThrow(() => runner.killProcessTree(child, { platform, run: (...a) => { runs.push(a); return { status: 0, stdout: ' 4243 4242\n' }; }, kill: (pid) => kills.push(pid) }));
      assert.deepStrictEqual(runs, [], `${what}, ${platform}: no taskkill, no ps`);
      assert.deepStrictEqual(kills, [], `${what}, ${platform}: no process is signalled by that number`);
      assert.deepStrictEqual(child.killed, ['SIGKILL'], `${what}, ${platform}: the child is still asked to die`);
    }
  }
  // A child that is running — a ChildProcess reports null for both until it exits — is ended as before.
  for (const platform of ['win32', 'linux']) {
    const child = { ...fakeChild(4242), exitCode: null, signalCode: null };
    const runs = [];
    runner.killProcessTree(child, { platform, run: (name, ...rest) => { runs.push(name); return { status: 0, stdout: '' }; } });
    assert.deepStrictEqual(runs, [platform === 'win32' ? 'taskkill' : 'ps'], platform);
  }
});

test('killProcessTree leaves a real child that has exited alone, and ends one that is still running', async () => {
  const { spawn } = require('node:child_process');
  const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => exited.once('exit', resolve));
  assert.notStrictEqual(exited.exitCode, null, 'the child has exited');
  const runs = [];
  runner.killProcessTree(exited, { run: (...a) => { runs.push(a); return { status: 0, stdout: '' }; }, kill: (pid) => runs.push(['kill', pid]) });
  assert.deepStrictEqual(runs, [], 'its pid is not used');
  // One that is running gets the tree kill — through a recording runner, so no real process tree is touched — and is itself killed.
  const running = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    assert.strictEqual(running.exitCode, null);
    const started = [];
    runner.killProcessTree(running, { run: (name, ...rest) => { started.push(name); return { status: 0, stdout: '' }; }, kill: () => {} });
    assert.strictEqual(started.length, 1, 'the tool was run for the running child');
    await new Promise((resolve) => running.once('exit', resolve));
    assert.ok(running.signalCode === 'SIGKILL' || running.exitCode !== null, 'and the child was ended');
  } finally {
    try { running.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

test('killProcessTree asks only the child to die when it never started (no pid), and runs nothing', () => {
  for (const pid of [undefined, null, 0, -1, 'x']) {
    const child = fakeChild(pid);
    const runs = [];
    runner.killProcessTree(child, { platform: 'win32', run: (...a) => { runs.push(a); return { status: 0 }; } });
    assert.deepStrictEqual(runs, [], `pid ${String(pid)}`);
    assert.deepStrictEqual(child.killed, ['SIGKILL'], `pid ${String(pid)}`);
  }
  assert.doesNotThrow(() => runner.killProcessTree(null));
  assert.doesNotThrow(() => runner.killProcessTree({ pid: 5 }));
});

// taskkill.exe is in System32. A PATH without that folder (a service, a CI runner, a stripped-down shell) would make the lookup find nothing, and the kill would then end only the
// shim, leaving the stalled pac running. The one lookup is therefore made with System32 first on PATH — which also means no earlier folder can stand in for taskkill.
test('killProcessTree looks taskkill up with the System32 folder first on PATH, whatever PATH it is given, and leaves the caller\'s environment alone', () => {
  const system32 = 'C:\\Windows\\System32';
  for (const [what, env, first] of [
    ['a PATH without System32', { PATH: 'C:\\tools;C:\\other', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, system32],
    ['a differently cased Path, which Node would also have passed on', { Path: 'C:\\tools', SystemRoot: 'D:\\Win' }, 'D:\\Win\\System32'],
    ['a ComSpec in another folder', { PATH: 'C:\\tools', ComSpec: 'E:\\Sys\\cmd.exe' }, 'E:\\Sys'],
    ['no PATH at all', { SystemRoot: 'C:\\Windows' }, system32],
  ]) {
    const given = JSON.stringify(env);
    const seen = [];
    runner.killProcessTree(fakeChild(4242), { platform: 'win32', env, run: (name, args, options, deps) => { seen.push({ name, deps }); return { status: 0 }; } });
    assert.strictEqual(seen.length, 1, what);
    const lookupPath = seen[0].deps.env.PATH;
    assert.ok(lookupPath === first || lookupPath.startsWith(`${first};`), `${what}: PATH is ${lookupPath}`);
    assert.strictEqual(Object.keys(seen[0].deps.env).filter((k) => k.toUpperCase() === 'PATH').length, 1, `${what}: one spelling of PATH reaches the lookup`);
    assert.strictEqual(JSON.stringify(env), given, `${what}: the environment it was given is not modified`);
  }
  // The folders the caller had stay on PATH, after System32.
  const seen = [];
  runner.killProcessTree(fakeChild(4242), { platform: 'win32', env: { PATH: 'C:\\tools;C:\\other', ComSpec: `${system32}\\cmd.exe` }, run: (n, a, o, deps) => { seen.push(deps.env.PATH); return { status: 0 }; } });
  assert.deepStrictEqual(seen, [`${system32};C:\\tools;C:\\other`]);
});

test('killProcessTree finds taskkill in System32 through the runner\'s own lookup even when PATH has no such folder, and hides its window', () => {
  // The real lookup (invocation), fed what killProcessTree passes it, over a file system where taskkill exists only in System32.
  const exists = (p) => p === 'C:\\Windows\\System32\\taskkill.exe';
  const options = [];
  let resolved = null;
  runner.killProcessTree(fakeChild(4242), {
    platform: 'win32',
    env: { PATH: 'C:\\tools;C:\\other', SystemRoot: 'C:\\Windows' },
    run: (name, args, opts, deps) => {
      options.push(opts);
      resolved = runner.invocation(name, args, { ...deps, platform: 'win32', exists });
      return { status: 0 };
    },
  });
  assert.ok(resolved, 'taskkill was found');
  assert.strictEqual(resolved.file, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepStrictEqual(resolved.args, ['/pid', '4242', '/T', '/F']);
  assert.strictEqual(options[0].windowsHide, true, 'no console window opens for the kill');
  assert.strictEqual(resolved.options.windowsHide, true);
  // A folder that is earlier on PATH cannot stand in for it.
  const planted = (p) => p === 'C:\\tools\\taskkill.exe' || p === 'C:\\Windows\\System32\\taskkill.exe';
  let first = null;
  runner.killProcessTree(fakeChild(4242), {
    platform: 'win32',
    env: { PATH: 'C:\\tools', SystemRoot: 'C:\\Windows' },
    run: (name, args, opts, deps) => { first = runner.invocation(name, args, { ...deps, platform: 'win32', exists: planted }).file; return { status: 0 }; },
  });
  assert.strictEqual(first, 'C:\\Windows\\System32\\taskkill.exe');
});

test('killProcessTree\'s POSIX path is left as it was: ps with its own arguments and options, no Windows lookup path, no hidden-window flag', () => {
  const runs = [];
  runner.killProcessTree(fakeChild(4242), { platform: 'linux', env: { PATH: '/usr/bin' }, run: (...a) => { runs.push(a); return { status: 0, stdout: '' }; } });
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0][0], 'ps');
  assert.strictEqual(runs[0].length, 3, 'ps is run with its arguments and options only');
  assert.strictEqual(runs[0][2].windowsHide, undefined);
});

test('killProcessTree still ends the process, and never throws, when the environment it was given cannot be read', () => {
  // The PATH for the lookup is worked out inside the guarded block: an environment that makes that throw must cost the tree kill, not the caller's error handling.
  const child = fakeChild(4242);
  const runs = [];
  assert.doesNotThrow(() => runner.killProcessTree(child, { platform: 'win32', env: null, run: (...a) => { runs.push(a); return { status: 0 }; } }));
  assert.deepStrictEqual(child.killed, ['SIGKILL']);
  assert.deepStrictEqual(runs, [], 'there was no PATH to look taskkill up with');
});

test('descendantPids reads a ps listing: every depth, irregular spacing and CRLF, garbage ignored, a cycle cannot hang it', () => {
  const text = ['  10   1', '\t11\t10', ' 12 11 ', '13   12\r', 'PID PPID', 'x y', '', '  14    99', ' 15   14', ' 20   21', ' 21   20'].join('\r\n');
  assert.deepStrictEqual(runner.descendantPids(10, text).sort((a, b) => a - b), [11, 12, 13]);
  assert.deepStrictEqual(runner.descendantPids(14, text), [15]);
  assert.deepStrictEqual(runner.descendantPids(20, text), [21], 'a pair that name each other as parent ends the walk');
  assert.deepStrictEqual(runner.descendantPids(999, text), []);
  assert.deepStrictEqual(runner.descendantPids(10, ''), []);
  assert.deepStrictEqual(runner.descendantPids(10, undefined), []);
});

// The same two checks, and the ones a real tree answers below, written for a recording runner: `run` and `kill` stand in for taskkill, ps and the signal, so
// no test here can end a process it did not start.
test('killProcessTree on Windows asks taskkill for the whole tree of the process, found beside cmd.exe, and then asks the process itself to die as well', () => {
  const calls = [];
  const child = fakeChild(4321);
  runner.killProcessTree(child, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', Path: 'C:\\elsewhere' },
    run: (name, args, options, deps) => { calls.push({ name, args, options, path: deps.env.PATH }); return { status: 0 }; },
  });
  assert.deepStrictEqual(calls.map((c) => [c.name, c.args]), [['taskkill', ['/pid', '4321', '/T', '/F']]]);
  assert.strictEqual(calls[0].path, 'C:\\Windows\\System32;C:\\elsewhere', 'taskkill is looked for in the directory cmd.exe lives in first, never the current directory');
  assert.strictEqual(calls[0].options.stdio, 'ignore');
  assert.deepStrictEqual(child.killed, ['SIGKILL'], 'a tree kill that missed the process cannot leave it running');
});

test('killProcessTree falls back to the process\'s own kill when taskkill cannot end the tree, off Windows, or with no pid — and never throws', () => {
  const kills = [];
  const child = (pid) => ({ pid, kill: () => { kills.push(pid); } });
  const env = { SystemRoot: 'C:\\Windows', Path: 'C:\\elsewhere' };
  const signalled = [];
  const kill = (pid) => signalled.push(pid);
  runner.killProcessTree(child(1), { platform: 'win32', env, run: () => ({ status: 128 }), kill });
  runner.killProcessTree(child(2), { platform: 'win32', env, run: () => ({ status: null, error: new Error('spawn taskkill ENOENT') }), kill });
  runner.killProcessTree(child(3), { platform: 'win32', env, run: () => { throw new Error('taskkill exploded'); }, kill });
  runner.killProcessTree(child(4), { platform: 'linux', run: () => { throw new Error('spawn ps ENOENT'); }, kill });
  runner.killProcessTree({ kill: () => kills.push('no pid') }, { platform: 'win32', env, run: () => { throw new Error('no pid, no taskkill'); }, kill });
  assert.deepStrictEqual(kills, [1, 2, 3, 4, 'no pid']);
  assert.deepStrictEqual(signalled, [], 'no process is signalled by its number when the tool that lists the tree gave nothing');
  runner.killProcessTree(null);
  runner.killProcessTree(undefined, { platform: 'win32' });
  runner.killProcessTree({ pid: 5, kill: () => { throw new Error('already gone'); } }, { platform: 'linux', run: () => ({ status: 0, stdout: '' }), kill });
  assert.deepStrictEqual(signalled, []);
});

// The premise and the fix, on a real cmd.exe. A batch shim runs its program as cmd.exe's CHILD, exactly as az.cmd runs
// Python, and Node's own kill ends only the cmd.exe it started.
const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Starts `fakecli.cmd` (which runs a node process that records its pid and idles) and waits until that process runs.
async function startShimmedProgram() {
  const dir = scratch('process-runner-tree-');
  const pidFile = path.join(dir, 'program.pid');
  const script = path.join(dir, 'idle.js');
  // The timer is a backstop: whatever a failing test leaves behind ends by itself.
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 120000);\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'fakecli.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  const env = { ...process.env, Path: dir, PATH: dir };
  const wrapper = runner.execFileAsync('fakecli', ['x'], { windowsHide: true }, () => {}, { env });
  let program = 0;
  for (let i = 0; i < 150 && !program; i += 1) {
    await pause(100);
    program = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  }
  assert.ok(program > 0 && processAlive(program), 'the shim started its program');
  assert.notStrictEqual(program, wrapper.pid, 'which is a different process from the cmd.exe Node started');
  return { wrapper, program };
}

test('Node\'s own kill of a batch shim leaves the program the shim started running (why killProcessTree exists)', { skip: process.platform !== 'win32' }, async () => {
  const { wrapper, program } = await startShimmedProgram();
  try {
    wrapper.kill();
    await pause(1500);
    assert.ok(processAlive(program), 'only the cmd.exe wrapper was ended');
  } finally {
    try { process.kill(program); } catch { /* already gone */ }
  }
});

test('killProcessTree ends a batch shim AND the program it started (real cmd.exe)', { skip: process.platform !== 'win32' }, async () => {
  const { wrapper, program } = await startShimmedProgram();
  try {
    runner.killProcessTree(wrapper);
    for (let i = 0; i < 50 && processAlive(program); i += 1) await pause(100);
    assert.ok(!processAlive(program), 'the program the shim started is gone too');
  } finally {
    try { process.kill(program); } catch { /* already gone */ }
  }
});

// The same on Linux and macOS, with the real `ps`: the tree is listed with each process's start time and every descendant is read again before its
// signal, so this also proves that `ps -A -o pid=,ppid=,lstart=` and `ps -o lstart= -p <pid>` print a process's start time the same way there.
test('killProcessTree ends a real POSIX child and the grandchild it started, through the real ps', { skip: process.platform === 'win32' }, async () => {
  const { spawn, spawnSync } = require('node:child_process');
  // A zombie still answers `kill -0` until something reaps it, so a process counts as running only while ps lists it in a state other than Z.
  const running = (pid) => {
    const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    return r.status === 0 && !/^\s*Z/.test(r.stdout);
  };
  const script = "const { spawn } = require('node:child_process');"
    + "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });"
    + "process.stdout.write(g.pid + '\\n'); setTimeout(() => {}, 60000);";
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let grandchild = 0;
  try {
    grandchild = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; const m = /(\d+)\n/.exec(out); if (m) resolve(Number(m[1])); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error('the child exited before it reported its grandchild')));
    });
    assert.ok(running(grandchild), 'the grandchild runs');
    runner.killProcessTree(child);
    for (let i = 0; i < 100 && running(grandchild); i += 1) await pause(100);
    assert.ok(!running(grandchild), 'the grandchild was ended with the child');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    if (grandchild) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ } }
  }
});

// ── spawnResultTree ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// spawnResultSync's asynchronous twin, for a call that may have to be ENDED: the same result, but one that outlasts its timeout has its whole tree ended
// before the call settles — spawnSync ends only the process it started, which for a batch launcher is the cmd.exe, not the program the launcher runs.
const NODE_NAME = path.basename(process.execPath, path.extname(process.execPath));
const nodeEnv = () => ({ ...process.env, Path: path.dirname(process.execPath), PATH: path.dirname(process.execPath) });
// A process ended by SIGKILL can stay listed for a moment as a zombie until it is reaped: gone means gone within a short wait.
async function goneWithin(pid, ms) {
  for (const until = Date.now() + ms; processAlive(pid) && Date.now() < until;) await pause(50);
  return !processAlive(pid);
}

test('spawnResultTree reports a call that finished on its own the way spawnResultSync does — and a launch failure through error, never by rejecting', async () => {
  const env = nodeEnv();
  assert.deepStrictEqual(
    await runner.spawnResultTree(NODE_NAME, ['-e', "process.stdout.write('out'); process.stderr.write('err')"], { timeout: 30000 }, { env }),
    { status: 0, signal: null, stdout: 'out', stderr: 'err' }
  );
  const failed = await runner.spawnResultTree(NODE_NAME, ['-e', "process.stderr.write('bad'); process.exitCode = 3"], { timeout: 30000 }, { env });
  assert.deepStrictEqual([failed.status, failed.stderr, 'error' in failed], [3, 'bad', false]);
  const bytes = await runner.spawnResultTree(NODE_NAME, ['-e', "process.stdout.write('b')"], { encoding: 'buffer' }, { env });
  assert.ok(Buffer.isBuffer(bytes.stdout) && bytes.stdout.toString() === 'b');
  const missing = await runner.spawnResultTree('no-such-program-anywhere', [], {}, { env });
  assert.deepStrictEqual([missing.status, missing.error.code], [null, 'ENOENT']);
  const refused = await runner.spawnResultTree('pac', ['100%'], {}, { platform: 'win32', env: winEnv('C:\\Pac'), exists: (p) => p === 'C:\\Pac\\pac.cmd', readFile: () => '@echo off\r\nset PAC_X=1\r\n' });
  assert.deepStrictEqual([refused.status, refused.error.code], [null, 'EARGUMENT']);
});

// A caller that lends a path to the program it starts — a workspace made for pac — has to know the program's process id as soon as it exists: a run killed after that leaves the
// program running (POSIX), and the record of who has the workspace (lib/temp-workspace.js lendWorkspace) must name it by then.
test('spawnResultTree tells `onSpawn` the process id of the program it started, as soon as it is started — before the call settles — and never for a program that could not be started', async () => {
  const env = nodeEnv();
  const heard = [];
  let settled = false;
  const running = runner.spawnResultTree(NODE_NAME, ['-e', "process.stdout.write(String(process.pid))"], { timeout: 30000, onSpawn: (pid) => heard.push([pid, settled]) }, { env });
  const result = await running;
  settled = true;
  assert.strictEqual(heard.length, 1, 'once');
  assert.strictEqual(heard[0][1], false, 'before the call settled');
  assert.strictEqual(String(heard[0][0]), result.stdout, 'the process id the program printed is the one it was told: the program itself, not a launcher');
  // A program that cannot be started has no process id: nothing is reported, and the failure comes as it always did.
  const none = [];
  const missing = await runner.spawnResultTree('no-such-program-anywhere', [], { onSpawn: (pid) => none.push(pid) }, { env });
  assert.deepStrictEqual([none, missing.error.code], [[], 'ENOENT']);
  const refused = await runner.spawnResultTree('pac', ['100%'], { onSpawn: (pid) => none.push(pid) }, { platform: 'win32', env: winEnv('C:\\Pac'), exists: (p) => p === 'C:\\Pac\\pac.cmd', readFile: () => '@echo off\r\nset PAC_X=1\r\n' });
  assert.deepStrictEqual([none, refused.error.code], [[], 'EARGUMENT']);
  // A listener that throws changes nothing about the call; options without one are as they were.
  const quiet = await runner.spawnResultTree(NODE_NAME, ['-e', "process.stdout.write('out')"], { onSpawn: () => { throw new Error('a listener that fails'); } }, { env });
  assert.deepStrictEqual({ ...quiet }, { status: 0, signal: null, stdout: 'out', stderr: '' });
  assert.deepStrictEqual(await runner.spawnResultTree(NODE_NAME, ['-e', "process.stdout.write('out')"], { onSpawn: 'not a function' }, { env }), { status: 0, signal: null, stdout: 'out', stderr: '' });
});

test('spawnResultTree does not hand `onSpawn` on to the program it starts as an option of the spawn', async () => {
  const seen = [];
  const childProcess = require('node:child_process');
  const spawnReal = childProcess.spawn;
  childProcess.spawn = (file, args, options) => { seen.push(options); return spawnReal(file, args, options); };
  try {
    await runner.spawnResultTree(NODE_NAME, ['-e', ''], { onSpawn: () => {} }, { env: nodeEnv() });
  } finally {
    childProcess.spawn = spawnReal;
  }
  assert.strictEqual(seen.length, 1);
  assert.ok(!('onSpawn' in seen[0]), Object.keys(seen[0]).join(', '));
});

test('spawnResultTree ends a call that outlasts its timeout: the process is gone when it settles, what it wrote before is kept, and the error is ETIMEDOUT', async () => {
  const dir = scratch('process-runner-deadline-');
  const running = path.join(dir, 'running.txt');
  const script = path.join(dir, 'idle.js');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(running)}, String(process.pid)); process.stdout.write(String(process.pid)); setTimeout(() => {}, 120000);\n`, 'utf8');
  const started = Date.now();
  const result = await runner.spawnResultTree(NODE_NAME, [script], { timeout: 1000 }, { env: nodeEnv(), clock: clockStartedWith(running) });
  const pid = Number(result.stdout);
  try {
    assert.ok(pid > 0, `what it wrote before it was ended is in the result: ${JSON.stringify(result.stdout)}`);
    assert.deepStrictEqual([result.status, result.error && result.error.code], [null, 'ETIMEDOUT']);
    assert.ok(Date.now() - started < 60000, 'it settled when the process was ended, not at the 120 s the process would have run');
    assert.strictEqual(await goneWithin(pid, 10000), true, 'the process is no longer running');
    // What the caller may claim: the pipes closed after the kill, so nothing the call started still holds them.
    assert.deepStrictEqual([result.error.containment, result.error.pid], ['confirmed', pid], 'the ending is confirmed, and names the process the call started');
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('spawnResultTree ends a call that writes past maxBuffer, as spawnSync reports it — ENOBUFS — with the process gone', async () => {
  const script = "process.stderr.write(String(process.pid) + '\\n'); const chunk = 'x'.repeat(65536); setInterval(() => process.stdout.write(chunk), 5);";
  const result = await runner.spawnResultTree(NODE_NAME, ['-e', script], { timeout: 60000, maxBuffer: 100000 }, { env: nodeEnv() });
  const pid = Number(result.stderr.split('\n')[0]);
  try {
    assert.deepStrictEqual([result.status, result.error && result.error.code], [null, 'ENOBUFS']);
    assert.ok(pid > 0);
    assert.strictEqual(await goneWithin(pid, 10000), true, 'the process that was flooding the pipe is no longer running');
    assert.strictEqual(result.error.containment, 'confirmed');
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('spawnResultTree ends a batch launcher AND the program it started (real cmd.exe) — the program a spawnSync timeout would leave running', { skip: process.platform !== 'win32' }, async () => {
  const dir = scratch('process-runner-tree-call-');
  const pidFile = path.join(dir, 'program.pid');
  const script = path.join(dir, 'idle.js');
  // The timer is a backstop: whatever a failing test leaves behind ends by itself.
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => process.exit(0), 120000);\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'fakecli.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  const result = await runner.spawnResultTree('fakecli', ['x'], { timeout: 1000 }, { env: { ...process.env, Path: dir, PATH: dir }, clock: clockStartedWith(pidFile) });
  const program = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  try {
    assert.strictEqual(result.error && result.error.code, 'ETIMEDOUT');
    assert.ok(program > 0, 'the launcher started its program');
    assert.strictEqual(await goneWithin(program, 10000), true, 'the program the launcher started is gone, not left running');
    assert.strictEqual(result.error.containment, 'confirmed', 'and the call says its tree was ended, which is what happened');
  } finally {
    try { process.kill(program, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('spawnResultTree gives a process that survives the kill a grace period for its pipes to close, then settles without it — saying the ending is NOT confirmed — and asks for the kill once', async () => {
  // The deadline and the grace period are timers this test fires by hand, so nothing waits in real time.
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { timer.cleared = true; },
  };
  const asked = [];
  const run = runner.spawnResultTree(NODE_NAME, ['-e', 'setTimeout(() => {}, 120000)'], { timeout: 1234 }, { env: nodeEnv(), clock, killTree: (child) => asked.push(child) });
  try {
    assert.deepStrictEqual(timers.map((t) => t.ms), [1234], 'the deadline is the caller\'s timeout');
    timers[0].fn();
    timers[0].fn();
    assert.strictEqual(asked.length, 1, 'the tree is asked to end once, however often the deadline fires');
    assert.deepStrictEqual(timers.map((t) => t.ms), [1234, 5000], 'a process that outlives the kill is waited for 5 s and no longer');
    timers[1].fn();
    const result = await run;
    assert.deepStrictEqual([result.status, result.signal, result.error.code], [null, 'SIGKILL', 'ETIMEDOUT']);
    assert.deepStrictEqual([result.error.containment, result.error.pid], ['unconfirmed', asked[0].pid], 'the pipes never closed: a process the call started may still be running');
    assert.ok(timers.every((t) => t.cleared), 'settling clears both timers');
  } finally {
    for (const child of asked) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
});

test('spawnResultTree settles when a process the call started still holds the pipes of a child that has already exited — and says the survivor is NOT stopped, with the survivor really running', async () => {
  // The child starts a grandchild that inherits its pipes, reports the grandchild's pid and exits: 'exit' comes at once and 'close' only when the grandchild lets go. The grandchild is
  // detached because libuv on Windows ends everything a process started when that process exits, which would close the pipes at once.
  const dir = scratch('process-runner-held-pipes-');
  const reported = path.join(dir, 'reported.txt');
  const script = path.join(dir, 'parent.js');
  fs.writeFileSync(script, [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
    `process.stdout.write(String(g.pid), () => { require('node:fs').writeFileSync(${JSON.stringify(reported)}, String(process.pid)); process.exit(0); });`,
  ].join('\n'), 'utf8');
  // The deadline counts from the report; the grace period that follows is a fraction of a second instead of 5 s.
  const gated = clockStartedWith(reported);
  let timers = 0;
  const clock = { setTimeout: (fn, ms) => gated.setTimeout(fn, (timers += 1) === 1 ? ms : 500), clearTimeout: gated.clearTimeout };
  const result = await runner.spawnResultTree(NODE_NAME, [script], { timeout: 1000 }, { env: nodeEnv(), clock });
  const grandchild = Number(result.stdout);
  try {
    assert.ok(grandchild > 0, `what it wrote is in the result: ${JSON.stringify(result.stdout)}`);
    assert.strictEqual(result.error && result.error.code, 'ETIMEDOUT');
    // The claim is the point: the survivor was not ended, so the call must not say it was.
    assert.strictEqual(processAlive(grandchild), true, 'the process the call started is STILL RUNNING when the call settles');
    assert.deepStrictEqual([result.error.containment, result.error.pid], ['unconfirmed', Number(fs.readFileSync(reported, 'utf8'))], 'and the call says so, naming the process it started — the one that has exited');
  } finally {
    try { process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ }
  }
});

test('a process whose call settled while something it started still holds the pipes can exit on its own — the pipes are let go, not waited for', () => {
  const { spawnSync } = require('node:child_process');
  const dir = scratch('process-runner-exit-');
  const reported = path.join(dir, 'reported.txt');
  const parent = path.join(dir, 'parent.js');
  fs.writeFileSync(parent, [
    "const { spawn } = require('node:child_process');",
    "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
    `process.stdout.write(String(g.pid), () => { require('node:fs').writeFileSync(${JSON.stringify(reported)}, '1'); process.exit(0); });`,
  ].join('\n'), 'utf8');
  // The program that makes the call, and then does nothing: it ends when nothing it holds is left open — which is the point.
  const driver = path.join(dir, 'driver.js');
  fs.writeFileSync(driver, [
    `const runner = require(${JSON.stringify(require.resolve('../lib/process-runner.js'))});`,
    `const gated = require(${JSON.stringify(require.resolve('./helpers/started-clock.js'))}).clockStartedWith(${JSON.stringify(reported)});`,
    'let timers = 0;',
    'const clock = { setTimeout: (fn, ms) => gated.setTimeout(fn, (timers += 1) === 1 ? ms : 300), clearTimeout: gated.clearTimeout };',
    `const env = { ...process.env, Path: ${JSON.stringify(path.dirname(process.execPath))}, PATH: ${JSON.stringify(path.dirname(process.execPath))} };`,
    `runner.spawnResultTree(${JSON.stringify(NODE_NAME)}, [${JSON.stringify(parent)}], { timeout: 500 }, { env, clock }).then((r) => {`,
    '  console.log(JSON.stringify({ code: r.error && r.error.code, grandchild: Number(r.stdout) }));',
    '});',
  ].join('\n'), 'utf8');
  const run = spawnSync(process.execPath, [driver], { encoding: 'utf8', timeout: 30000 });
  let grandchild = 0;
  try {
    const said = JSON.parse(String(run.stdout).trim().split('\n').pop() || '{}');
    grandchild = said.grandchild || 0;
    assert.strictEqual(said.code, 'ETIMEDOUT', run.stderr);
    assert.deepStrictEqual([run.status, run.signal], [0, null], 'the process ended by itself, not by the 30 s the test allows');
  } finally {
    try { process.kill(grandchild, 'SIGKILL'); } catch { /* already gone */ }
  }
});
