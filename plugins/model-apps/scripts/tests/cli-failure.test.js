'use strict';
// How a CLI child failed (lib/cli-failure.js), and what the token path makes of it.
//
// A slow Azure CLI used to come back as `null`, like every other failure: check-auth reported the
// installed CLI as missing, and every token read said "run az login". The kinds are proven here on
// Node's REAL error shapes — a fake `az` that outlives its budget, run through the process runner —
// because a stub that throws "a timeout" only proves what the stub's author believed Node does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AZ_TIMEOUT_ENV, MIN_AZ_TIMEOUT_MS, MAX_AZ_TIMEOUT_MS, azTimeoutMs, cliFailureKind, azTimeoutAdvice } = require('../lib/cli-failure.js');
const runner = require('../lib/process-runner.js');
const auth = require('../lib/dataverse-auth.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

// A fake `az` on its own PATH that prints `print` after `delayMs`, or exits 1 when `fail` is set.
function fakeAz({ delayMs = 0, print = 'fake-token', fail = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-failure-'));
  dirs.push(dir);
  const script = path.join(dir, 'az.js');
  fs.writeFileSync(script, `setTimeout(() => { ${fail ? "process.stderr.write('ERROR: Please run az login'); process.exit(1);" : `process.stdout.write(${JSON.stringify(print)});`} }, ${delayMs});\n`);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'az.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(dir, 'az'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  const env = { ...process.env, Path: dir, PATH: dir };
  return {
    exec: (name, args, options) => runner.runSync(name, args, options, { env }),
    execFile: (name, args, options, cb) => runner.execFileAsync(name, args, options, cb, { env }),
  };
}

const withBudget = async (ms, fn) => {
  const saved = process.env[AZ_TIMEOUT_ENV];
  process.env[AZ_TIMEOUT_ENV] = String(ms);
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env[AZ_TIMEOUT_ENV];
    else process.env[AZ_TIMEOUT_ENV] = saved;
  }
};

test('azTimeoutMs: 60 s by default, or the environment override within 1 s..15 min', () => {
  assert.strictEqual(azTimeoutMs({}), 60000);
  assert.strictEqual(azTimeoutMs({ [AZ_TIMEOUT_ENV]: '120000' }), 120000);
  for (const bad of ['', 'abc', '999', '900001', '1.5', '-5000']) assert.strictEqual(azTimeoutMs({ [AZ_TIMEOUT_ENV]: bad }), 60000, bad);
});

test('cliFailureKind reads each shape Node gives a failed child', () => {
  assert.strictEqual(cliFailureKind(null), null);
  assert.strictEqual(cliFailureKind(Object.assign(new Error('spawnSync az ETIMEDOUT'), { code: 'ETIMEDOUT' })), 'timeout');
  assert.strictEqual(cliFailureKind(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null })), 'timeout');
  assert.strictEqual(cliFailureKind(Object.assign(new Error('spawn az ENOENT: not found on PATH'), { code: 'ENOENT' })), 'missing');
  assert.strictEqual(cliFailureKind(new Error('spawn az ENOENT')), 'missing');
  // Output past maxBuffer also kills the child — but that is not the CLI being slow.
  assert.strictEqual(cliFailureKind(Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' })), 'failed');
  assert.strictEqual(cliFailureKind(Object.assign(new Error('Command failed: az'), { code: 1 })), 'failed');
  assert.match(azTimeoutAdvice('az account show', 60000), /`az account show` did not answer within 60 s[\s\S]*POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS=120000/);
});

// The advice names a budget to set. Doubling the 15-minute maximum suggested 1800000, which azTimeoutMs rejects — so
// following the advice put the budget back to 60 s. Every suggestion must be one the parser accepts and longer than the
// budget that ran out; at the maximum, the advice must stop suggesting more time.
test('azTimeoutAdvice suggests only a budget azTimeoutMs accepts, and none once the budget is the maximum', () => {
  for (const ms of [1000, 60000, 120000, 449999, 450000, 600000, 899999]) {
    const m = /POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS=(\d+)/.exec(azTimeoutAdvice('az account show', ms));
    assert.ok(m, `${ms}: a budget is suggested`);
    const suggested = Number(m[1]);
    assert.ok(suggested > ms && suggested <= MAX_AZ_TIMEOUT_MS, `${ms} -> ${suggested}`);
    assert.strictEqual(azTimeoutMs({ [AZ_TIMEOUT_ENV]: m[1] }), suggested, `${ms}: the suggested ${suggested} is accepted, not replaced by the default`);
  }
  assert.match(azTimeoutAdvice('az account show', 450000), /=900000\./, 'capped at the maximum');
  const atMax = azTimeoutAdvice('az account show', MAX_AZ_TIMEOUT_MS);
  assert.doesNotMatch(atMax, /POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS=\d/, 'no larger budget to suggest');
  assert.match(atMax, /did not answer within 900 s\. That is already the longest POWER_PLATFORM_SKILLS_AZ_TIMEOUT_MS allows \(15 min\)[\s\S]*run `az account show` yourself/);
  assert.strictEqual(azTimeoutMs({ [AZ_TIMEOUT_ENV]: String(MAX_AZ_TIMEOUT_MS) }), MAX_AZ_TIMEOUT_MS);
  assert.strictEqual(azTimeoutMs({ [AZ_TIMEOUT_ENV]: String(MIN_AZ_TIMEOUT_MS) }), MIN_AZ_TIMEOUT_MS);
});

test('a token read that outlives its budget is recorded as a timeout, and the message says so', async () => {
  await withBudget(1000, async () => {
    const origin = 'https://contoso-slow-sync.crm.dynamics.com';
    const slow = fakeAz({ delayMs: 4000 });
    assert.strictEqual(auth.getAuthToken(origin, { exec: slow.exec, fresh: true }), null);
    assert.strictEqual(auth.tokenFailureKind(origin), 'timeout');
    assert.match(auth.tokenFailureMessage(origin, 'run az login'), /Could not get an Azure CLI token for https:\/\/contoso-slow-sync\.crm\.dynamics\.com: `az account get-access-token` did not answer within 1 s/);

    const asyncOrigin = 'https://contoso-slow-async.crm.dynamics.com';
    assert.strictEqual(await auth.getAuthTokenAsync(asyncOrigin, { execFile: slow.execFile, fresh: true }), null);
    assert.strictEqual(auth.tokenFailureKind(asyncOrigin), 'timeout');

    // Every caller that throws on a missing token words it from the same record.
    await assert.rejects(
      auth.dataverseRequest(origin, 'GET', 'WhoAmI', null, { getToken: () => null, request: async () => { throw new Error('no request expected'); } }),
      /did not answer within 1 s/,
    );
    const pre = await auth.preflightAuth(origin, { getToken: () => null, request: async () => { throw new Error('no request expected'); } });
    assert.strictEqual(pre.ok, false);
    assert.match(pre.error, /did not answer within 1 s/);
    assert.doesNotMatch(pre.error, /sign-in problem/);
  });
});

test('a CLI that answers, refuses, or is absent is not called slow', async () => {
  await withBudget(30000, async () => {
    const origin = 'https://contoso-quick.crm.dynamics.com';
    assert.strictEqual(auth.getAuthToken(origin, { exec: fakeAz({ fail: true }).exec, fresh: true }), null);
    assert.strictEqual(auth.tokenFailureKind(origin), 'failed');
    assert.strictEqual(auth.tokenFailureMessage(origin, 'run az login'), 'run az login', 'a refusal keeps the sign-in advice');

    const missingEnv = { ...process.env, Path: os.tmpdir(), PATH: os.tmpdir() };
    assert.strictEqual(auth.getAuthToken(origin, { exec: (n, a, o) => runner.runSync(n, a, o, { env: missingEnv }), fresh: true }), null);
    assert.strictEqual(auth.tokenFailureKind(origin), 'missing');
    assert.match(auth.tokenFailureMessage(origin, 'x'), /not on PATH/);

    // An answer clears the record, so an earlier failure never colours a later message.
    assert.strictEqual(auth.getAuthToken(origin, { exec: fakeAz({ print: 'token-1' }).exec, fresh: true }), 'token-1');
    assert.strictEqual(auth.tokenFailureKind(origin), null);
    assert.strictEqual(await auth.getAuthTokenAsync('https://contoso-quick-async.crm.dynamics.com', { execFile: fakeAz({ print: 'token-2' }).execFile, fresh: true }), 'token-2');
    assert.strictEqual(auth.tokenFailureKind('https://contoso-quick-async.crm.dynamics.com'), null);

    // An az that answers with no token is a failure, not a timeout; so is a launch that throws instead of calling back
    // (Node's execFile can, synchronously) — read by the same rule as a launch failure reported through the callback.
    const empty = 'https://contoso-empty-async.crm.dynamics.com';
    assert.strictEqual(await auth.getAuthTokenAsync(empty, { execFile: fakeAz({ print: '' }).execFile, fresh: true }), null);
    assert.strictEqual(auth.tokenFailureKind(empty), 'failed');
    const thrown = 'https://contoso-thrown-async.crm.dynamics.com';
    const throwing = () => { throw Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' }); };
    assert.strictEqual(await auth.getAuthTokenAsync(thrown, { execFile: throwing, fresh: true }), null);
    assert.strictEqual(auth.tokenFailureKind(thrown), 'missing');
  });
});

// ── The time one `pac model genpage` call may take ────────────────────────────────────────────────────────────────────────────────
// A page upload once stalled for 17 minutes — no CPU, no network — until someone killed the process, and the build then finished. So a pac call waits a bounded time:
// generous, because a real upload of a large page is slow and a slow call is not a stalled one (3 min to list or download, 10 min to upload), and overridable for a
// machine or an environment that is slower than that.
const { PAC_TIMEOUT_ENV, DEFAULT_PAC_READ_TIMEOUT_MS, DEFAULT_PAC_UPLOAD_TIMEOUT_MS, MIN_PAC_TIMEOUT_MS, MAX_PAC_TIMEOUT_MS, pacTimeoutMs, pacLongerTimeoutMs, pacTimeoutAdvice } = require('../lib/cli-failure.js');

test('pacTimeoutMs: 3 min to list or download, 10 min to upload, or the environment override within 1 s..60 min for any of them', () => {
  assert.strictEqual(DEFAULT_PAC_READ_TIMEOUT_MS, 180000);
  assert.strictEqual(DEFAULT_PAC_UPLOAD_TIMEOUT_MS, 600000);
  for (const kind of ['list', 'download']) assert.strictEqual(pacTimeoutMs(kind, {}), 180000, kind);
  assert.strictEqual(pacTimeoutMs('upload', {}), 600000);
  for (const kind of ['list', 'download', 'upload']) {
    assert.strictEqual(pacTimeoutMs(kind, { [PAC_TIMEOUT_ENV]: '45000' }), 45000, `${kind}: the override applies to every kind`);
    assert.strictEqual(pacTimeoutMs(kind, { [PAC_TIMEOUT_ENV]: String(MIN_PAC_TIMEOUT_MS) }), MIN_PAC_TIMEOUT_MS, `${kind}: the minimum`);
    assert.strictEqual(pacTimeoutMs(kind, { [PAC_TIMEOUT_ENV]: String(MAX_PAC_TIMEOUT_MS) }), MAX_PAC_TIMEOUT_MS, `${kind}: the maximum`);
  }
  assert.strictEqual(MAX_PAC_TIMEOUT_MS, 3600000);
  // An unusable value keeps the default for the kind rather than failing the run (the same rule as the Azure CLI budget).
  for (const bad of ['', 'abc', '999', '3600001', '1.5', '-5000', '0']) {
    assert.strictEqual(pacTimeoutMs('list', { [PAC_TIMEOUT_ENV]: bad }), 180000, bad);
    assert.strictEqual(pacTimeoutMs('upload', { [PAC_TIMEOUT_ENV]: bad }), 600000, bad);
  }
  assert.strictEqual(pacTimeoutMs('upload'), pacTimeoutMs('upload', process.env), 'the process environment by default');
});

test('pacLongerTimeoutMs suggests only a budget pacTimeoutMs accepts, and none once the budget is the maximum', () => {
  for (const ms of [1000, 45000, 180000, 600000, 1799999, 1800000, 3599999]) {
    const longer = pacLongerTimeoutMs(ms);
    assert.ok(longer > ms && longer <= MAX_PAC_TIMEOUT_MS, `${ms} -> ${longer}`);
    assert.strictEqual(pacTimeoutMs('upload', { [PAC_TIMEOUT_ENV]: String(longer) }), longer, `${ms}: ${longer} is accepted, not replaced by the default`);
  }
  assert.strictEqual(pacLongerTimeoutMs(1000), 300000, 'at least five minutes');
  assert.strictEqual(pacLongerTimeoutMs(600000), 1200000, 'otherwise double');
  assert.strictEqual(pacLongerTimeoutMs(MAX_PAC_TIMEOUT_MS), null, 'nothing larger would be read');
});

test('pacTimeoutAdvice names the call and its budget, suggests only a budget pacTimeoutMs accepts, and none once the budget is the maximum', () => {
  assert.match(pacTimeoutAdvice('pac model genpage upload', 600000), /`pac model genpage upload` did not finish within 600 s and was stopped[\s\S]*POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS=1200000/);
  for (const ms of [1000, 45000, 180000, 600000, 1799999, 1800000, 3599999]) {
    const m = /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS=(\d+)/.exec(pacTimeoutAdvice('pac model genpage list', ms));
    assert.ok(m, `${ms}: a budget is suggested`);
    const suggested = Number(m[1]);
    assert.ok(suggested > ms && suggested <= MAX_PAC_TIMEOUT_MS, `${ms} -> ${suggested}`);
    assert.strictEqual(pacTimeoutMs('list', { [PAC_TIMEOUT_ENV]: m[1] }), suggested, `${ms}: the suggested ${suggested} is accepted, not replaced by the default`);
  }
  const atMax = pacTimeoutAdvice('pac model genpage upload', MAX_PAC_TIMEOUT_MS);
  assert.doesNotMatch(atMax, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS=\d/, 'no larger budget to suggest');
  assert.match(atMax, /did not finish within 3600 s and was stopped\. That is already the longest POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS allows \(60 min\)/);
});

// A command a message tells the user — or the agent — to paste: a path under a Windows profile folder often has a space ("C:\Users\Dev User\..."), and a path from an
// untrusted checkout can hold shell syntax (`x;rm -rf ~;.tsx`, `$(…)`, backticks). It must reach the program the command runs as exactly ONE argument that no shell
// reads anything in — in the shells the skill's commands are written for, PowerShell and the POSIX shells — or not be written into the command at all.
test('commandArg writes a plain value bare, quotes everything else in single quotes, and has no spelling for what a shell cannot pass on unchanged', () => {
  const { commandArg, commandArgOrPlaceholder } = require('../lib/cli-failure.js');
  for (const plain of ['out/overview.tsx', 'page.tsx', 'C:/Users/Dev/page.tsx', 'café/página-1_v2.tsx', 'a:b']) {
    assert.strictEqual(commandArg(plain), plain, `${plain}: written bare`);
  }
  assert.strictEqual(commandArg(42), '42', 'a value that is not a string is written as its text');
  const quoted = {
    'C:\\Users\\Dev\\page.tsx': 'a backslash escapes in a POSIX shell',
    'C:\\Users\\Dev User\\page.tsx': 'white space splits',
    'my page.tsx': 'white space splits',
    'a\tb.tsx': 'a tab splits too',
    'x;echo INJECTED;.tsx': 'a semicolon ends the command',
    'x$(echo INJECTED).tsx': 'command substitution',
    'x`echo INJECTED`.tsx': 'backticks (PowerShell\'s escape, a POSIX substitution)',
    'a|b': 'a pipe', 'a&b': 'an ampersand', 'a>b': 'a redirect', '*.tsx': 'a glob', '#x.tsx': 'a comment', '~/x.tsx': 'a home expansion',
    'a,b.tsx': 'an array in PowerShell', '@x.tsx': 'splatting in PowerShell', '-x.tsx': 'a leading dash reads as a flag', '{a}.tsx': 'a brace',
    '$HOME.tsx': 'a variable', 'a!b.tsx': 'history expansion', 'a%b%.tsx': 'a percent',
    'x\\': 'a final backslash with no white space: Windows PowerShell does not wrap the value in quotes',
    'a b\\x.tsx': 'white space with a backslash that is not the last character',
    'a\u201Cb\u201D.tsx': 'PowerShell\'s curly double quotes: literal inside single quotes, passed on as they are',
    '--%x': 'only the exact value is PowerShell\'s stop-parsing token', ' --%': 'nor is it with white space around it',
  };
  for (const [value, why] of Object.entries(quoted)) {
    assert.strictEqual(commandArg(value), `'${value}'`, `${JSON.stringify(value)} (${why}): single-quoted`);
  }
  const none = {
    "it's.tsx": 'a single quote', 'it\u2019s.tsx': 'one PowerShell reads as a single quote', 'it\u2018s.tsx': 'one PowerShell reads as a single quote',
    'it\u201As.tsx': 'one PowerShell reads as a single quote', 'it\u201Bs.tsx': 'one PowerShell reads as a single quote',
    'a\nb.tsx': 'a line break', 'a\rb.tsx': 'a carriage return', 'a\u0000b.tsx': 'a control character', 'a\u0085b.tsx': 'a next-line character',
    'a\u2028b.tsx': 'a line separator', 'a\u2029b.tsx': 'a paragraph separator',
    'x"y.tsx': 'Windows PowerShell drops a double quote on its way to a program',
    'C:\\Users\\Dev User\\': 'Windows PowerShell quotes a value with white space, and the program reads its final \\" as an escaped quote',
    'a\u3000b\\': 'any white space, not only a space, makes Windows PowerShell quote the value',
    '': 'Windows PowerShell passes an empty value as no argument at all',
    '--%': 'PowerShell\'s stop-parsing token, dropped even when quoted',
  };
  for (const [value, why] of Object.entries(none)) {
    assert.strictEqual(commandArg(value), null, `${JSON.stringify(value)} (${why}): no spelling`);
    const { arg, note } = commandArgOrPlaceholder(value, '<file>');
    assert.strictEqual(arg, '<file>');
    assert.strictEqual(note, `<file> is ${JSON.stringify(value)}; it is not written into the command because no way of writing it reaches the command unchanged in both PowerShell and a POSIX shell.`);
  }
  assert.deepStrictEqual(commandArgOrPlaceholder('my page.tsx', '<file>'), { arg: "'my page.tsx'", note: '' });
});

// The claim above, checked against real shells and a real program: every spelling goes, the way the advice is pasted, into a command that runs node, and node's
// argv must be exactly the values — each one argument, unchanged — with nothing in them run. Printing a value from inside the shell would not do: Windows PowerShell
// changes an argument only on its way to a native program. Every shell found is used: Windows PowerShell (always there on Windows) and PowerShell 7 (pwsh) when it is
// installed; elsewhere sh, and bash, zsh and pwsh when they are installed.
test('commandArg\'s spellings reach a program run from a real shell as exactly the value, and nothing in them runs', () => {
  const { commandArg } = require('../lib/cli-failure.js');
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const values = ['C:\\Users\\Dev User\\page.tsx', 'x;echo INJECTED;.tsx', 'x$(echo INJECTED).tsx', 'x`echo INJECTED`.tsx', 'x"y.tsx', 'a|b', 'a&b', '*.tsx', '#x', '~/x', 'a,b', '@x',
    '-x', '{a}', '$HOME', '${HOME}', 'a!b', 'a%PATH%b', 'café page.tsx', 'a\tb', 'x\\', 'x\\\\y', 'a b\\x', 'a\u201Cb\u201D', '--%x', ' --%', '\'unused', '', '--%',
    'C:\\Users\\Dev User\\'].filter((v) => commandArg(v) !== null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-arg-'));
  try {
    const probe = path.join(dir, 'argv.js');
    fs.writeFileSync(probe, "require('node:fs').writeFileSync(process.env.COMMAND_ARG_OUT, JSON.stringify(process.argv.slice(2)));\n", 'utf8');
    const program = [process.execPath, probe].map(commandArg);
    assert.ok(program.every((arg) => arg !== null), `node and the probe have a spelling: ${program}`);
    const windows = process.platform === 'win32';
    const shells = windows ? ['powershell.exe', 'pwsh'] : ['sh', 'bash', 'zsh', 'pwsh'];
    const required = windows ? 'powershell.exe' : 'sh';
    const ran = [];
    for (const shell of shells) {
      const powershell = shell === 'powershell.exe' || shell === 'pwsh';
      const name = shell.replace(/\W/g, '');
      const script = path.join(dir, `probe-${name}.${powershell ? 'ps1' : 'sh'}`);
      // `&` runs a quoted program path in PowerShell. Windows PowerShell reads a script as UTF-8 only with a BOM.
      fs.writeFileSync(script, `${powershell ? '\uFEFF& ' : ''}${program.join(' ')} ${values.map(commandArg).join(' ')}\n`, 'utf8');
      const out = path.join(dir, `argv-${name}.json`);
      const args = powershell ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] : [script];
      const r = spawnSync(shell, args, { encoding: 'utf8', env: { ...process.env, COMMAND_ARG_OUT: out } });
      if (r.error && r.error.code === 'ENOENT' && shell !== required) continue;
      assert.ifError(r.error);
      assert.strictEqual(r.status, 0, `${shell}: ${r.stderr}`);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), values, `${shell}: node got each value as one argument, unchanged`);
      assert.doesNotMatch(r.stdout, /INJECTED/, `${shell}: no command in a value ran`);
      ran.push(shell);
    }
    assert.ok(ran.includes(required), `ran in ${ran.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// What commandArg refuses, run through the same shells: each value it has no spelling for does NOT arrive unchanged when single-quoted — so refusing it is
// needed, not just cautious. Windows only: the POSIX shells pass every one of them on; it is Windows PowerShell's command line (and, for `--%`, both PowerShells)
// that changes them.
test('a value commandArg has no spelling for is one a real Windows shell does not pass on unchanged when single-quoted', { skip: process.platform !== 'win32' && 'the values are changed on Windows' }, () => {
  const { commandArg } = require('../lib/cli-failure.js');
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-arg-none-'));
  try {
    // The probe writes the arguments after its first to the file its first names, so one script can run it once per value (a `--%` acts only on its own line).
    const probe = path.join(dir, 'argv.js');
    fs.writeFileSync(probe, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n", 'utf8');
    const values = ['x"y.tsx', 'C:\\Users\\Dev User\\', 'a\u3000b\\', '', '--%'];
    // Each value between two markers, so a dropped value shows as two neighbours.
    const lines = values.map((value, i) => {
      assert.strictEqual(commandArg(value), null, JSON.stringify(value));
      return `& ${commandArg(process.execPath)} ${commandArg(probe)} ${commandArg(path.join(dir, `argv-${i}.json`))} '<' '${value}' '>'`;
    });
    const script = path.join(dir, 'probe.ps1');
    fs.writeFileSync(script, `\uFEFF${lines.join('\n')}\n`, 'utf8');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' });
    assert.ifError(r.error);
    values.forEach((value, i) => {
      const got = JSON.parse(fs.readFileSync(path.join(dir, `argv-${i}.json`), 'utf8'));
      assert.notDeepStrictEqual(got, ['<', value, '>'], `${JSON.stringify(value)} arrives unchanged, so commandArg could spell it`);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
