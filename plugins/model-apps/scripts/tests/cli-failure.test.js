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
