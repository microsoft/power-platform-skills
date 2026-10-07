// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { run } from '../src/cli.mjs';
import { StateStore } from '../src/state.mjs';
import { sample, bound, claim, username, assertProfileBytes, FakeAz, removedClouds } from './helpers.mjs';
async function setup(t) {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), 'pm-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(path.join(dir, 'state')), cli = new FakeAz(), stdout = new PassThrough(), stderr = new PassThrough();
  let out = '', err = ''; stdout.on('data', b => { out += b; }); stderr.on('data', b => { err += b; });
  return { store, cli, stdout, stderr, terminalAvailable: true, get out() { return out; }, get err() { return err; } };
}
test('config and local diagnostics never acquire tokens or print private identifiers', async t => {
  const f = await setup(t);
  assert.equal(await run(['config', '--profile', 'sample', '--cloud', 'Public', '--tenant', sample.TenantId, '--environment', sample.EnvironmentId], f), 0);
  assert.equal(f.cli.calls.length, 0);
  assert.equal(await run(['diagnostics', '--profile', 'sample'], f), 0);
  assert.equal(f.cli.calls.some(a => a.includes('get-access-token')), false);
  for (const secret of [sample.EnvironmentId, sample.TenantId, username]) assert.equal(f.err.includes(secret), false);
  assert.equal(f.out, ''); assert.match(f.err, /tokenAcquired.*false/);
  assert.match(f.err, /"transportMode":"post-only"/);
  assertProfileBytes(await readFile(f.store.file('sample'), 'utf8'), null);
});
test('cold local diagnostics disclose that bound OID is not verified and never acquire a token', async t => {
  const f = await setup(t);
  await f.store.save(bound);
  const before = await readFile(f.store.file('sample'), 'utf8');
  f.cli.user = 'another-user@example.invalid';
  assert.equal(await run(['diagnostics', '--profile', 'sample'], f), 0, f.err);
  const result = JSON.parse(f.err);
  assert.equal(result.state, 'account-selected');
  assert.equal(result.sessionCheckScope, 'cloud-tenant-user-shape');
  assert.equal(result.boundAccountVerified, false);
  assert.equal(result.tokenAcquired, false);
  assert.equal(f.cli.calls.some(args => args[1] === 'get-access-token'), false);
  assert.equal(await readFile(f.store.file('sample'), 'utf8'), before);
  assert.doesNotMatch(f.err, /another-user|fixture@example|33333333/);
});
for (const args of [['diagnostics'], ['diagnostics', '--remote', 'true'], ['login'], ['serve']])
test(`malformed stored OID stops ${args.join(' ')} before Azure CLI or HTTP`, async t => {
  const f = await setup(t);
  await f.store.save(bound);
  const file = f.store.file('sample');
  const content = JSON.stringify({ ...await f.store.load('sample'), HomeAccountId: 'not-an-oid' });
  await writeFile(file, content);
  let fetches = 0;
  const fetchImpl = async () => { fetches++; throw new Error('Unexpected fixture HTTP request'); };
  assert.equal(await run([...args, '--profile', 'sample'], {
    ...f, stdin: new PassThrough(), fetchImpl, signal: AbortSignal.timeout(15000)
  }), 2, f.err);
  assert.match(f.err, /account selection.*OID GUID or null/);
  assert.doesNotMatch(f.err, /not-an-oid|account-selected|TOKEN_ACQUIRED/);
  assert.equal(f.out, '');
  assert.deepEqual(f.cli.calls, []);
  assert.equal(fetches, 0);
  assert.equal(await readFile(file, 'utf8'), content);
});
test('offline config persists canonical environment IDs without acquiring credentials', async t => {
  const f = await setup(t);
  for (const prefix of ['', 'Default', 'Legacy', 'Primary']) {
    const environment = prefix.toLowerCase() + sample.EnvironmentId.replaceAll('-', '').toUpperCase();
    assert.equal(await run(['config', '--profile', 'sample', '--cloud', 'Public',
      '--tenant', sample.TenantId, '--environment', environment], f), 0, f.err);
    const saved = JSON.parse(await readFile(path.join(f.store.root, 'sample.json'), 'utf8'));
    assert.equal(saved.EnvironmentId, (prefix ? prefix + '-' : '') + sample.EnvironmentId);
    assert.equal(saved.TenantId, sample.TenantId);
  }
  assert.equal(f.cli.calls.length, 0);
  assert.equal(f.out, '');
  assert.equal(f.err.includes(sample.EnvironmentId), false);
});
for (const Cloud of removedClouds) test(`removed cloud ${Cloud} fails before CLI, HTTP or state changes`, async t => {
  const f = await setup(t);
  await f.store.save(bound);
  const file = f.store.file('sample');
  const original = await readFile(file, 'utf8');
  let fetches = 0;
  const fetchImpl = async () => { fetches++; throw new Error('Unexpected fixture HTTP request'); };
  const options = { ...f, stdin: new PassThrough(), fetchImpl };
  for (const name of ['new', 'sample']) {
    assert.equal(await run(['config', '--profile', name, '--cloud', Cloud,
      '--tenant', sample.TenantId, '--environment', sample.EnvironmentId], options), 2, f.err);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual(await readdir(f.store.root), ['sample.json']);
  }
  const content = JSON.stringify({ ...JSON.parse(original), Cloud });
  await writeFile(file, content);
  for (const args of [['diagnostics'], ['diagnostics', '--remote', 'true'], ['login'], ['logout'], ['serve']]) {
    // Bound each invocation independently rather than sharing a cumulative timeout.
    assert.equal(await run([...args, '--profile', 'sample'], {
      ...options, signal: AbortSignal.timeout(15000)
    }), 2, f.err);
    assert.equal(await readFile(file, 'utf8'), content);
  }
  assert.match(f.err, /Choose Public, Gcc, GccHigh, DoD or Mooncake\./);
  assert.equal(f.out, '');
  assert.deepEqual(f.cli.calls, []);
  assert.equal(fetches, 0);
  assert.deepEqual(await readdir(f.store.root), ['sample.json']);
});
test('help lists only the five accepted cloud options', async t => {
  const f = await setup(t);
  assert.equal(await run(['--help'], f), 0);
  assert.match(f.err, /^Cloud values: Public, Gcc, GccHigh, DoD or Mooncake\.$/m);
  assert.doesNotMatch(f.err, /\btip[12]\b/i);
  assert.deepEqual(f.cli.calls, []);
});
test('strict command options reject old client/browser flags and ambiguous boolean values', async t => {
  const f = await setup(t);
  for (const args of [
    ['config', '--profile', 'sample', '--client-id', 'ignored'], ['login', '--profile', 'sample', '--browser', 'true'],
    ['login', '--profile', 'sample', '--redirect-uri', 'anything'], ['login', '--profile', 'sample', '--sign-in', 'yes'],
    ['serve'], ['serve', '--profile', '../escape'], ['serve', '--profile', 'sample', '--profile', 'sample'],
    ['logout', '--profile'], ['unknown']
  ]) assert.equal(await run(args, f), 2, args.join(' '));
  assert.equal(f.cli.calls.length, 0); assert.equal(f.out, '');
});
test('terminal-only login binds current CLI session and logout changes only plugin profile', async t => {
  const f = await setup(t); await f.store.save(sample);
  assert.equal(await run(['login', '--profile', 'sample'], { ...f, terminalAvailable: false }), 3);
  assert.equal(f.cli.calls.length, 0);
  assert.equal(await run(['login', '--profile', 'sample'], f), 0);
  assert.equal(f.cli.calls.some(a => a[0] === 'login'), false);
  assertProfileBytes(await readFile(f.store.file('sample'), 'utf8'), bound.HomeAccountId);
  const calls = f.cli.calls.length, old = await f.store.load('sample');
  assert.equal(await run(['logout', '--profile', 'sample'], f), 0);
  assert.equal(f.cli.calls.length, calls);
  const current = await f.store.load('sample');
  assert.equal(current.HomeAccountId, null); assert.notEqual(current.Revision, old.Revision);
  assert.deepEqual(await readdir(f.store.root), ['sample.json']);
  assertProfileBytes(await readFile(f.store.file('sample'), 'utf8'), null);
});
test('explicit sign-in is the only command that opens UI', async t => {
  const f = await setup(t); await f.store.save(sample);
  assert.equal(await run(['serve', '--profile', 'sample'], f), 3); assert.equal(f.cli.calls.length, 0);
  assert.equal(await run(['login', '--profile', 'sample', '--sign-in', 'true'], f), 0);
  assert.equal(f.cli.calls.filter(a => a[0] === 'login').length, 1);
});
test('serving monitor invalidates old profile and does not silently rebind', async t => {
  const f = await setup(t), stdin = new PassThrough(); await f.store.save(bound);
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const running = run(['serve', '--profile', 'sample'], {
    ...f, stdin, onReady: ready, signal: AbortSignal.timeout(15000)
  });
  // Change an active session, not a profile whose startup is still running.
  // The existing readiness seam avoids a machine-speed race.
  await Promise.race([started, running.then(code => assert.fail(`Serve exited before readiness: ${code}`))]);
  await f.store.save(sample);
  assert.equal(await running, 130);
  assert.match(f.err, /changed/); assert.equal(f.cli.calls.length, 0); assert.equal(f.out, '');
});
test('help and cancellation use stderr and stable exit codes', async t => {
  const f = await setup(t);
  assert.equal(await run(['--help'], f), 0); assert.equal(await run([], f), 2);
  assert.equal(await run(['serve', '--profile', 'sample'], { ...f, signal: AbortSignal.abort() }), 130);
  assert.match(f.err, /Node.js 22\/24/); assert.equal(f.out, '');
});

test('claims challenge reports the policy problem without persisting it or starting sign-in', async t => {
  const f = await setup(t);
  await f.store.save(bound);
  const before = await readFile(f.store.file('sample'));
  let sent = 0;
  assert.equal(await run(['diagnostics', '--profile', 'sample', '--remote', 'true'], {
    ...f, fetchImpl: async () => {
      sent++;
      return new Response(null, { status: 401, headers: {
        'www-authenticate': `Bearer error="insufficient_claims", claims="${Buffer.from(claim).toString('base64')}"`
      } });
    }
  }), 3, f.err);
  assert.match(f.err, /Conditional Access.*CAE/);
  assert.match(f.err, /login --profile NAME --sign-in true/);
  assert.equal(sent, 1);
  assert.deepEqual(await readFile(f.store.file('sample')), before);
  assert.deepEqual(await readdir(f.store.root), ['sample.json']);
  assert.equal(f.cli.calls.some(args => args[0] === 'login'), false);
  assert.equal(f.out, '');
  assert.doesNotMatch(f.err, /acrs|c1|fixture@example|11111111|aaaaaaaa|2\.80/);
  assert.equal(await run(['login', '--profile', 'sample', '--sign-in', 'true'], f), 0, f.err);
  assert.ok(f.cli.calls.every(args => !args.includes('--claims-challenge')));
  assert.deepEqual(await readdir(f.store.root), ['sample.json']);
});

test('login cannot overwrite a newer profile published during token acquisition', async t => {
  const f = await setup(t);
  await f.store.save(bound);
  const runCli = f.cli.run.bind(f.cli);
  let current;
  f.cli.run = async (args, options) => {
    const result = await runCli(args, options);
    if (args.includes('get-access-token')) current = await f.store.save(sample);
    return result;
  };
  assert.equal(await run(['login', '--profile', 'sample', '--sign-in', 'true'], f), 3, f.err);
  assert.deepEqual(await f.store.load('sample'), current);
  assert.doesNotMatch(f.err, /TOKEN_ACQUIRED/);
});
