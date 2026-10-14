'use strict';
// lib/pac-fallback.js — how connector.js and solution-settings.js run pac when the SDK refuses: through the process runner, within a time budget,
// with a failure that says why and carries none of pac's own header, and a JSON answer read only when it is exactly what pac prints after its banner.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runPac, pacPayload, pacBudgetMs, pacErrorText, isPacHeaderLine, stopClaim, PAC_BANNER, PAC_READ_TIMEOUT_MS, PAC_IMPORT_TIMEOUT_MS } = require('../lib/pac-fallback.js');
const { spawnResultTree } = require('../lib/process-runner.js');
const { clockStartedWith } = require('./helpers/started-clock.js');

const LABEL = 'pac model genpage list-connector-operations';

// A runner that records what it was asked and answers `result`.
function spawnReturning(result) {
  const calls = [];
  const spawn = (name, args, options) => {
    calls.push({ name, args, options });
    return result;
  };
  return { spawn, calls };
}

// --- the budget -----------------------------------------------------------------------------------------------------------------

test('a read gets three minutes and an import an hour — fixed constants, with no environment variable to tune them', async () => {
  assert.strictEqual(PAC_READ_TIMEOUT_MS, 180000);
  assert.strictEqual(PAC_IMPORT_TIMEOUT_MS, 3600000);
  assert.strictEqual(pacBudgetMs('read'), PAC_READ_TIMEOUT_MS);
  assert.strictEqual(pacBudgetMs('import'), PAC_IMPORT_TIMEOUT_MS);
  assert.strictEqual(pacBudgetMs(undefined), PAC_READ_TIMEOUT_MS, 'a call that names no kind is a read');
  // The variable the genpage calls used to read is gone from the plugin: whatever is set in the environment changes nothing here.
  const saved = process.env.POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS;
  process.env.POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS = '45000';
  try {
    const { spawn, calls } = spawnReturning({ status: 0, stdout: '', stderr: '' });
    await runPac(['x'], { label: LABEL, spawn });
    await runPac(['x'], { label: LABEL, spawn, kind: 'import' });
    assert.deepStrictEqual(calls.map((c) => c.options.timeout), [PAC_READ_TIMEOUT_MS, PAC_IMPORT_TIMEOUT_MS]);
  } finally {
    if (saved === undefined) delete process.env.POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS;
    else process.env.POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS = saved;
  }
});

// --- running pac ----------------------------------------------------------------------------------------------------------------

test('pac is started through the runner with its arguments as given, its output captured, and a time bound and a buffer', async () => {
  const { spawn, calls } = spawnReturning({ status: 0, stdout: 'Connected as maker\n{"a":1}\n', stderr: '' });
  const run = await runPac(['model', 'genpage', 'list-connector-operations', '--environment', 'https://contoso.crm.dynamics.com'], { label: LABEL, spawn });
  assert.deepStrictEqual(run, { ok: true, stdout: 'Connected as maker\n{"a":1}\n', stderr: '' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].name, 'pac', 'a bare name: the runner resolves it to an absolute executable on PATH, never the working directory');
  assert.deepStrictEqual(calls[0].args, ['model', 'genpage', 'list-connector-operations', '--environment', 'https://contoso.crm.dynamics.com']);
  assert.deepStrictEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.strictEqual(calls[0].options.encoding, 'utf8');
  assert.strictEqual(calls[0].options.timeout, PAC_READ_TIMEOUT_MS);
  assert.ok(calls[0].options.maxBuffer >= 16 * 1024 * 1024, 'a large connector\'s answer does not overflow the default 1 MiB buffer');
  assert.ok(!('shell' in calls[0].options), 'the runner owns the shell option');
});

test('an import is given the long budget', async () => {
  const a = spawnReturning({ status: 0, stdout: '', stderr: '' });
  await runPac(['solution', 'import'], { label: 'pac solution import', kind: 'import', spawn: a.spawn });
  assert.strictEqual(a.calls[0].options.timeout, PAC_IMPORT_TIMEOUT_MS);
});

test('the runner may answer asynchronously: a promise of the result is awaited, and a runner that is not given is the one that ends a whole process tree', async () => {
  const run = await runPac(['x'], { label: LABEL, spawn: async () => ({ status: 0, stdout: 'late', stderr: '' }) });
  assert.deepStrictEqual(run, { ok: true, stdout: 'late', stderr: '' });
  // The default: lib/process-runner.js spawnResultTree, which `pac` not being on this PATH reports as a launch failure, never a throw.
  const missing = await runPac(['x'], { label: LABEL, spawn: (name, args, options) => spawnResultTree(name, args, options, { env: { PATH: os.tmpdir() }, platform: process.platform }) });
  assert.strictEqual(missing.failure, 'missing');
});

test('a runPac that is given no runner starts pac through the runner that ends a whole process tree, with the kind\'s budget', async () => {
  // pac-fallback.js takes spawnResultTree from the process runner when it loads, so a copy loaded while the runner's export is a recording stand-in is the one that
  // shows which function the default is.
  const runnerPath = require.resolve('../lib/process-runner.js');
  const modulePath = require.resolve('../lib/pac-fallback.js');
  const runner = require(runnerPath);
  const original = runner.spawnResultTree;
  const calls = [];
  runner.spawnResultTree = async (name, args, options) => { calls.push([name, args, options.timeout]); return { status: 0, stdout: '', stderr: '' }; };
  delete require.cache[modulePath];
  try {
    const fresh = require(modulePath);
    await fresh.runPac(['solution', 'list'], { label: LABEL });
    await fresh.runPac(['solution', 'import'], { label: LABEL, kind: 'import' });
  } finally {
    runner.spawnResultTree = original;
    delete require.cache[modulePath];
  }
  assert.deepStrictEqual(calls, [['pac', ['solution', 'list'], PAC_READ_TIMEOUT_MS], ['pac', ['solution', 'import'], PAC_IMPORT_TIMEOUT_MS]]);
});

test('pac that is not installed fails as "missing", with the way to install it', async () => {
  const { spawn } = spawnReturning({ status: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn pac ENOENT: not found on PATH'), { code: 'ENOENT' }) });
  const run = await runPac(['x'], { label: LABEL, spawn });
  assert.strictEqual(run.ok, false);
  assert.strictEqual(run.failure, 'missing');
  assert.match(run.message, /^`pac model genpage list-connector-operations` could not run: spawn pac ENOENT: not found on PATH\./);
  assert.match(run.message, /dotnet tool install -g Microsoft\.PowerApps\.CLI\.Tool/);
  assert.doesNotMatch(run.message, /exit null/);
});

test('a pac that runs out of its time is "timeout": how long it was given, that it was stopped, and what to do — for an import, that the environment may still be importing', async () => {
  const timedOut = spawnReturning({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: Object.assign(new Error('spawn pac ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  const read = await runPac(['x'], { label: LABEL, spawn: timedOut.spawn });
  assert.strictEqual(read.failure, 'timeout');
  assert.match(read.message, /^`pac model genpage list-connector-operations` did not finish within 180 s and was stopped\./);
  assert.match(read.message, /pac is waiting for a sign-in \(`pac auth list` shows the profile it uses\): run it again\./);
  assert.doesNotMatch(read.message, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS|allow it longer/, 'there is no variable to name: the budget is fixed');
  assert.doesNotMatch(read.message, /still importing/, 'a read has no import to look up');
  const imported = await runPac(['solution', 'import'], { label: 'pac solution import', kind: 'import', spawn: timedOut.spawn });
  assert.strictEqual(imported.failure, 'timeout');
  assert.match(imported.message, /^`pac solution import` did not finish within 3600 s and was stopped\./);
  assert.match(imported.message, /The environment may still be importing the package: look at its import history \(Solutions → History in Maker\) before importing again\./);
  assert.doesNotMatch(imported.message, /run it again/, 'an import that may have landed is not simply run again');
});

test('output past the buffer is "failed", not "missing"', async () => {
  const { spawn } = spawnReturning({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn pac ENOBUFS'), { code: 'ENOBUFS' }) });
  const run = await runPac(['x'], { label: LABEL, spawn });
  assert.strictEqual(run.failure, 'failed');
  assert.match(run.message, /wrote more than 64 MiB of output and was stopped/);
});

// What the message may claim is what the runner confirmed (error.containment, lib/process-runner.js spawnResultTree): "was stopped" only when the pipes closed after the kill.
test('a message says "was stopped" only when the runner confirmed it: with an ending it could not confirm, it says a process pac started may still be running — and names the pid pac was started as', async () => {
  const ended = (code, containment, pid) => spawnReturning({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: Object.assign(new Error(`spawn pac ${code}`), { code, containment, pid }) });
  const unconfirmed = (code) => ended(code, 'unconfirmed', 4242);

  const read = await runPac(['x'], { label: LABEL, spawn: unconfirmed('ETIMEDOUT').spawn });
  assert.strictEqual(read.failure, 'timeout');
  assert.match(read.message, /^`pac model genpage list-connector-operations` did not finish within 180 s and was asked to stop, but a process it started still held its output when the wait for it ended, so it may still be running \(pac was started as process 4242, which has exited; what it started is not known by id\)\./);
  assert.match(read.message, /End any leftover pac process \(`Get-Process pac` on Windows, `ps` elsewhere\) before trying again\./);
  assert.doesNotMatch(read.message, /was stopped/, 'it does not tell the reader the process is gone');
  assert.match(read.message, /pac is waiting for a sign-in/, 'the rest of the read\'s advice stays');

  const imported = await runPac(['solution', 'import'], { label: 'pac solution import', kind: 'import', spawn: unconfirmed('ETIMEDOUT').spawn });
  assert.doesNotMatch(imported.message, /was stopped/);
  assert.match(imported.message, /so it may still be running \(pac was started as process 4242/);
  assert.match(imported.message, /The environment may still be importing the package: look at its import history/, 'a local survivor does not replace the warning about the environment');

  const flooded = await runPac(['x'], { label: LABEL, spawn: unconfirmed('ENOBUFS').spawn });
  assert.strictEqual(flooded.failure, 'failed');
  assert.match(flooded.message, /^`pac model genpage list-connector-operations` wrote more than 64 MiB of output and was asked to stop, but a process it started still held its output[\s\S]*may still be running/);
  assert.match(flooded.message, /End any leftover pac process \(`Get-Process pac` on Windows, `ps` elsewhere\) before trying again\.$/, 'an output that overflowed gives the same advice');
  assert.doesNotMatch(flooded.message, /was stopped/);
  const floodedAndEnded = await runPac(['x'], { label: LABEL, spawn: ended('ENOBUFS', 'confirmed', 4242).spawn });
  assert.match(floodedAndEnded.message, /wrote more than 64 MiB of output and was stopped\.$/, 'a confirmed ending says so and gives no advice to end anything');

  // No pid is known (the process never had one): the sentence still says what is true, and names nothing.
  const noPid = await runPac(['x'], { label: LABEL, spawn: ended('ETIMEDOUT', 'unconfirmed', undefined).spawn });
  assert.match(noPid.message, /so it may still be running\./);
  assert.doesNotMatch(noPid.message, /process \d+/);

  // A confirmed ending, and an error from a runner that does not say (a stand-in, spawnSync), are read as they always were.
  for (const spawn of [ended('ETIMEDOUT', 'confirmed', 4242).spawn, ended('ETIMEDOUT', undefined, undefined).spawn]) {
    const stopped = await runPac(['x'], { label: LABEL, spawn });
    assert.match(stopped.message, /did not finish within 180 s and was stopped\. A stalled call/);
    assert.doesNotMatch(stopped.message, /may still be running|leftover/);
  }
  assert.deepStrictEqual(stopClaim(null), { stopped: true, claim: 'was stopped' });
  assert.strictEqual(stopClaim({ containment: 'unconfirmed' }).stopped, false);
});

test('an argument the runner will not hand to a Windows batch launcher is "refused" — pac is installed, so no install-it advice — with the cause and the way through, and its text goes through the redaction', async () => {
  const refusedText = 'cannot pass "https://contoso.sharepoint.com/sites/My%20Site" to pac.cmd: a Windows batch file cannot receive a double quote, %, a control character unchanged';
  const { spawn } = spawnReturning({ status: null, signal: null, stdout: '', stderr: '', error: Object.assign(new Error(refusedText), { code: 'EARGUMENT' }) });
  const run = await runPac(['x'], { label: LABEL, spawn });
  assert.deepStrictEqual([run.ok, run.failure], [false, 'refused']);
  assert.ok(run.message.startsWith(`\`${LABEL}\` was not run, and nothing was sent to pac: ${refusedText}. `), run.message);
  // The cause is named (a batch launcher cannot carry a double quote, a % or a control character) and so is the way through (pac.exe, or the command run by hand).
  assert.match(run.message, /The launcher is a Windows batch file, which cannot receive a double quote, a % or a control character unchanged\./);
  assert.match(run.message, /Install pac as pac\.exe \(`dotnet tool install -g Microsoft\.PowerApps\.CLI\.Tool`\)/);
  assert.match(run.message, /or run the command yourself in a shell that passes it as it is\.$/);
  assert.doesNotMatch(run.message, /Ensure the PAC CLI is installed/);
  const hidden = await runPac(['x'], { label: LABEL, spawn, redact: (text) => text.replace('My%20Site', '<redacted>') });
  assert.match(hidden.message, /sites\/<redacted>"/);
});

test('a non-zero exit is "failed" with what pac said — stderr first, else stdout — cut to a size a message can carry', async () => {
  const a = await runPac(['x'], { label: LABEL, ...spawnReturning({ status: 2, stdout: 'out text', stderr: 'Access denied\n' }) });
  assert.deepStrictEqual([a.ok, a.failure], [false, 'failed']);
  assert.strictEqual(a.message, `\`${LABEL}\` failed (exit 2): Access denied`);
  const b = await runPac(['x'], { label: LABEL, ...spawnReturning({ status: 1, stdout: 'only stdout', stderr: '' }) });
  assert.strictEqual(b.message, `\`${LABEL}\` failed (exit 1): only stdout`);
  const c = await runPac(['x'], { label: LABEL, ...spawnReturning({ status: 1, stdout: '', stderr: '' }) });
  assert.strictEqual(c.message, `\`${LABEL}\` failed (exit 1)`);
  const long = await runPac(['x'], { label: LABEL, ...spawnReturning({ status: 1, stdout: '', stderr: 'x'.repeat(5000) }) });
  assert.ok(long.message.length < 2200, `${long.message.length}`);
  assert.ok(long.message.endsWith('…'));
});

test('a pac ended by a signal has no exit status, and the message says the signal instead of "exit null"', async () => {
  const run = await runPac(['x'], { label: LABEL, ...spawnReturning({ status: null, signal: 'SIGKILL', stdout: '', stderr: '' }) });
  assert.strictEqual(run.failure, 'failed');
  assert.strictEqual(run.message, `\`${LABEL}\` failed (ended by SIGKILL)`);
  const withExit = await runPac(['x'], { label: LABEL, ...spawnReturning({ status: 3, signal: 'SIGTERM', stdout: '', stderr: '' }) });
  assert.match(withExit.message, /\(exit 3, signal SIGTERM\)/);
});

test('what pac says is passed through the caller\'s redaction before it reaches a message — and before it is cut, so a value cannot be cut in half', async () => {
  const redact = (text) => text.split('s3cr3t-value').join('<redacted>');
  const failed = await runPac(['x'], { label: LABEL, redact, ...spawnReturning({ status: 1, stdout: '', stderr: 'bad value s3cr3t-value for x' }) });
  assert.strictEqual(failed.message, `\`${LABEL}\` failed (exit 1): bad value <redacted> for x`);
  const launch = await runPac(['x'], { label: LABEL, redact, ...spawnReturning({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('cannot pass s3cr3t-value to pac.cmd'), { code: 'EARGUMENT' }) }) });
  assert.ok(!launch.message.includes('s3cr3t-value'), launch.message);
  // The value straddles the cut (2000 characters): redacting first removes it whole; cutting first would leave its first half.
  const straddling = await runPac(['x'], { label: LABEL, redact, ...spawnReturning({ status: 1, stdout: '', stderr: `${'x'.repeat(1990)}s3cr3t-value${'y'.repeat(50)}` }) });
  assert.ok(!straddling.message.includes('s3cr3t'), straddling.message);
});

// --- pac's header, which a failure does not carry --------------------------------------------------------------------------------

// What `pac solution import` printed on a failing run (live capture, PAC CLI 2.12.2; the account and the path are synthetic).
const FAILING_RUN = [
  'Connected as maker@contoso.onmicrosoft.com',
  'Connected to... Contoso Maker',
  'Microsoft PowerPlatform CLI',
  'Version: 2.12.2+ga6b1ffa (.NET 10.0.12)',
  'Online documentation: https://aka.ms/PowerPlatformCLI',
  'Feedback, Suggestions, Issues: https://github.com/microsoft/powerplatform-build-tools/discussions',
  '',
  "Error: Failed to deserialize the deployment settings from the specified file: 'C:\\work\\workflows.json'. Required property 'UserEmail' not found in JSON. Path 'Workflows[0]', line 22, position 5.",
  '',
].join('\r\n');

test('a failure says what pac said, not its header: no signed-in account, no version, no links', async () => {
  const run = await runPac(['x'], { label: 'pac solution import', ...spawnReturning({ status: 1, stdout: FAILING_RUN, stderr: '' }) });
  assert.strictEqual(run.message, "`pac solution import` failed (exit 1): Error: Failed to deserialize the deployment settings from the specified file: 'C:\\work\\workflows.json'. Required property 'UserEmail' not found in JSON. Path 'Workflows[0]', line 22, position 5.");
  for (const header of ['maker@contoso.onmicrosoft.com', 'Contoso Maker', 'PowerPlatform CLI', '2.12.2', 'aka.ms', 'discussions']) {
    assert.ok(!run.message.includes(header), `${header}: ${run.message}`);
  }
  // The same on stderr, and with LF line endings.
  const onStderr = await runPac(['x'], { label: 'pac solution import', ...spawnReturning({ status: 1, stdout: '', stderr: FAILING_RUN.replace(/\r\n/g, '\n') }) });
  assert.strictEqual(onStderr.message, run.message);
});

test('pacErrorText keeps pac\'s own words from the first Error: line on, else what follows the header — and never a header line, however it is spaced', () => {
  assert.strictEqual(pacErrorText(FAILING_RUN), FAILING_RUN.split('\r\n').filter((line) => line.startsWith('Error:'))[0]);
  // Progress before the error is not the error; lines that continue it are.
  assert.strictEqual(pacErrorText('Connected as [maker001]\nStarting Solution Import...\nError: the import failed\n  at step 3\n'), 'Error: the import failed\n  at step 3');
  // No `Error:` line: what pac printed after its header, as it printed it.
  assert.strictEqual(pacErrorText('Connected as maker\n\nAccess denied\n'), 'Access denied');
  assert.strictEqual(pacErrorText('Access denied'), 'Access denied');
  assert.strictEqual(pacErrorText('Connected as maker\nVersion: 1.0\n'), '', 'a header and nothing else is no diagnostic');
  assert.strictEqual(pacErrorText(''), '');
  assert.strictEqual(pacErrorText(null), '');
  // A line that merely looks like part of the header, below the first line that is not, is pac's own text and stays.
  assert.strictEqual(pacErrorText('Access denied\nVersion: 1.0 is too old'), 'Access denied\nVersion: 1.0 is too old');
  assert.strictEqual(pacErrorText('error : lower-case and spaced\n'), 'error : lower-case and spaced');
});

test('the banner is one definition for every pac fallback: a whole line, one word or one bracketed alias, and the other header lines pac prints', () => {
  for (const line of ['Connected as maker@contoso.onmicrosoft.com', 'Connected as [maker001]', 'connected as x']) assert.ok(PAC_BANNER.test(line), line);
  for (const line of ['Connected as [maker001] Warning: failed to retrieve connections.', 'Connected as two words', 'Connected as', 'Not Connected as x']) assert.ok(!PAC_BANNER.test(line), line);
  for (const line of FAILING_RUN.split('\r\n').filter((l) => l && !l.startsWith('Error:'))) assert.ok(isPacHeaderLine(line), line);
  for (const line of ['Error: x', 'Warning: a new version is available', 'Version', 'Solution Imported successfully.', '{"a":1}']) assert.ok(!isPacHeaderLine(line), line);
});

// --- a pac that has to be ended ---------------------------------------------------------------------------------------------------

// A fake pac that is a program started BY its launcher and outliving it — what pac.cmd is on a Windows machine: cmd.exe running pac.exe. The program records its pid and then
// idles for a minute (a backstop: whatever a failing test leaves behind ends by itself), far longer than any wait of the test, so a program that is gone shortly after the call
// settled was ended, not finished.
function installLongRunningPac(dir) {
  const script = path.join(dir, 'slow-pac.js');
  fs.writeFileSync(script, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(path.join(dir, 'pid.txt'))}, String(process.pid));`,
    'setTimeout(() => {}, 60000);',
  ].join('\n'));
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'pac.cmd'), `@"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  } else {
    // A shell that ignores SIGTERM and starts the program as its own child: ending only the process that was started leaves the program running.
    fs.writeFileSync(path.join(dir, 'pac'), `#!/bin/sh\ntrap '' TERM\n"${process.execPath}" "${script}" "$@" &\nwait\n`, 'utf8');
    fs.chmodSync(path.join(dir, 'pac'), 0o755);
  }
  return { started: path.join(dir, 'pid.txt'), pid: () => (fs.existsSync(path.join(dir, 'pid.txt')) ? Number(fs.readFileSync(path.join(dir, 'pid.txt'), 'utf8')) : null) };
}
// Whether a process is running. A process that was killed can stay listed as a zombie until its parent (or init) reaps it, and a zombie still answers `kill -0`: it is not running.
const alive = (pid) => {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === 'win32') return true;
  const listed = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return !(listed.status === 0 && /^\s*Z/.test(listed.stdout));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Gone means gone within a short wait: the kill is asked for before the call settles, and the system may take a moment to finish it.
async function goneWithin(pid, ms) {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await sleep(50);
  return !alive(pid);
}

test('a pac that times out is ended WHOLE before the call settles: the program its launcher started is gone, not left to finish the work', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-fallback-tree-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const pac = installLongRunningPac(dir);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = dir;
  // The budget is a constant of the module (the test above pins it); this stands in for it with a short one, through the same runner, counted from the moment the program runs.
  const spawn = (name, args, options) => spawnResultTree(name, args, { ...options, timeout: 1000 }, { env, clock: clockStartedWith(pac.started) });
  const run = await runPac(['solution', 'import'], { label: 'pac solution import', kind: 'import', spawn });
  assert.deepStrictEqual([run.ok, run.failure], [false, 'timeout']);
  assert.match(run.message, /did not finish within 3600 s and was stopped\. The environment may still be importing the package/);
  const pid = pac.pid();
  assert.ok(Number.isInteger(pid), 'the program ran');
  // The program would run for a minute: gone within seconds of the call's end means it was ended with the call.
  assert.strictEqual(await goneWithin(pid, 10000), true, 'the program the launcher started is no longer running once the call has settled');
});

// The other ending: the process pac was started as has already EXITED, and a process it started — detached, holding pac's output — goes on running. No tree can be walked from a
// launcher that is gone, and its pid is not killed (it may be another process's by then), so the runner cannot end the survivor; what it must not do is say it did.
test('a pac whose launcher exited and left a process running is NOT reported as stopped: the message says a process pac started may still be running, and the survivor is really running', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-fallback-orphan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const reported = path.join(dir, 'reported.txt');
  const survivorFile = path.join(dir, 'survivor.txt');
  const parent = path.join(dir, 'parent.js');
  fs.writeFileSync(parent, [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    // The survivor inherits the pipes, so the call cannot finish by itself; it is detached because libuv on Windows ends what a process started when that process exits.
    // Its timer is a backstop: a survivor a failing test leaves behind ends by itself.
    "const survivor = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
    `fs.writeFileSync(${JSON.stringify(survivorFile)}, String(survivor.pid));`,
    `fs.writeFileSync(${JSON.stringify(reported)}, String(process.pid));`,
    'setTimeout(() => process.exit(0), 100);',
  ].join('\n'), 'utf8');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = path.dirname(process.execPath);
  const gated = clockStartedWith(reported);
  let timers = 0;
  // The deadline counts from the moment the program has reported; the grace period after it — 5 s in the runner — is half a second here.
  const clock = { setTimeout: (fn, ms) => gated.setTimeout(fn, (timers += 1) === 1 ? ms : 500), clearTimeout: gated.clearTimeout };
  const spawn = (name, args, options) => spawnResultTree(path.basename(process.execPath, path.extname(process.execPath)), [parent], { ...options, timeout: 1000 }, { env, clock });
  const readPid = (file) => (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0);
  try {
    const run = await runPac(['solution', 'import'], { label: 'pac solution import', kind: 'import', spawn });
    const launcher = readPid(reported);
    assert.ok(launcher > 0 && readPid(survivorFile) > 0, 'the program ran and started its survivor');
    assert.deepStrictEqual([run.ok, run.failure], [false, 'timeout']);
    assert.strictEqual(alive(readPid(survivorFile)), true, 'the process pac started is STILL RUNNING when the call settles');
    assert.strictEqual(alive(launcher), false, 'and the launcher the message names has exited');
    assert.doesNotMatch(run.message, /was stopped/, 'a process is still running: the message must not say everything was stopped');
    assert.match(run.message, new RegExp(`^\`pac solution import\` did not finish within 3600 s and was asked to stop, but a process it started still held its output when the wait for it ended, so it may still be running \\(pac was started as process ${launcher}, which has exited; what it started is not known by id\\)\\.`));
    assert.match(run.message, /End any leftover pac process/);
    assert.match(run.message, /The environment may still be importing the package/);
  } finally {
    const survivor = readPid(survivorFile);
    if (survivor) { try { process.kill(survivor, 'SIGKILL'); } catch { /* already gone */ } }
  }
});

// --- the JSON pac prints ---------------------------------------------------------------------------------------------------------

test('the JSON is read after pac\'s sign-in banner: with CRLF, with blank lines, bare, and pretty-printed', () => {
  const payload = { operations: [{ name: 'GetItems', summary: 'Get items' }] };
  const line = JSON.stringify(payload);
  assert.deepStrictEqual(pacPayload(`Connected as maker@contoso.onmicrosoft.com\n${line}\n`, LABEL), payload);
  assert.deepStrictEqual(pacPayload(`Connected as [maker001]\r\n${line}\r\n\r\n`, LABEL), payload);
  assert.deepStrictEqual(pacPayload(`\n\nConnected as maker\n\n${line}`, LABEL), payload);
  assert.deepStrictEqual(pacPayload(line, LABEL), payload);
  assert.deepStrictEqual(pacPayload(`Connected as maker\n${JSON.stringify(payload, null, 2)}\n`, LABEL), payload);
});

test('anything but blank lines and the banner before the JSON is refused, naming the line — a warning is not skipped', () => {
  assert.throws(() => pacPayload('Warning: a new version is available\n{"a":1}\n', LABEL), /a line before the JSON is not pac's sign-in banner \(line: "Warning: a new version is available"\)/);
  assert.throws(() => pacPayload('Connected as maker\nSomething else\n{"a":1}', LABEL), /line: "Something else"/);
  // The banner is the whole-line shape (list-connections.js's definition): one that has something joined to it is not skipped.
  assert.throws(() => pacPayload('Connected as maker Warning: x\n{"a":1}', LABEL), /line: "Connected as maker Warning: x"/);
});

test('the lines pac prints beside its banner — the account it is connected to, its name, version and links — are its header too, and are skipped before the JSON', () => {
  const payload = { operations: [] };
  assert.deepStrictEqual(pacPayload(`${FAILING_RUN.split('\r\n').filter((l) => l && !l.startsWith('Error:')).join('\r\n')}\r\n${JSON.stringify(payload)}\r\n`, LABEL), payload);
  assert.deepStrictEqual(pacPayload(`Connected as [maker001]\nConnected to... Contoso Maker\n\n${JSON.stringify(payload)}`, LABEL), payload);
});

test('output that is not exactly one JSON object is refused, never guessed at', () => {
  assert.throws(() => pacPayload('', LABEL), /printed no JSON/);
  assert.throws(() => pacPayload('Connected as maker\n', LABEL), /printed no JSON/);
  assert.throws(() => pacPayload('{"a":1}\nWarning: trailing text\n', LABEL), /what follows the banner is not one JSON value/);
  assert.throws(() => pacPayload('Connected as maker\n{"a":', LABEL), /what follows the banner is not one JSON value/);
  assert.throws(() => pacPayload('Connected as maker\n[1,2]', LABEL), /the JSON is not an object/);
  assert.throws(() => pacPayload('Connected as maker\n{"a":1}{"b":2}', LABEL), /not one JSON value/);
  assert.throws(() => pacPayload(null, LABEL), /printed no JSON/);
  assert.throws(() => pacPayload('Error: the connection was not found', LABEL), /a line before the JSON is not pac's sign-in banner/);
});

test('a refusal names the command, so a reader knows which pac run printed it', () => {
  assert.throws(() => pacPayload('nope', 'pac solution create-settings'), /^Error: `pac solution create-settings` printed output this script could not read/);
});
