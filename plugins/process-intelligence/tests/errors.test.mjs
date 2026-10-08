// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IdentityClient } from '../src/authentication.mjs';
import { AzureCliProcess, runProcess, windowsUtility } from '../src/process.mjs';
import { StateStore, defaultStateRoot } from '../src/state.mjs';
import { authenticatedFetch } from '../src/http-auth.mjs';
import { FakeAz, bound, oid, username, token } from './helpers.mjs';
const code = expected => error => error.errorCode === expected;
test('authentication failures have safe error codes without extra CLI calls', async () => {
  for (const [field, value, expected] of [['version', '2.53.0', 'AZ_CLI_UNSUPPORTED'], ['tenant', 'wrong', 'TENANT_MISMATCH'],
    ['cloud', 'AzureUSGovernment', 'CLOUD_MISMATCH'], ['user', 'other@example.invalid', 'TOKEN_INVALID'],
    ['tokenOutput', token({ oid: '44444444-4444-4444-4444-444444444444' }), 'ACCOUNT_CHANGED'],
    ['tokenOutput', '{}', 'TOKEN_INVALID'], ['tokenError', 'AADSTS65001 private', 'AADSTS_FAILURE']]) {
    const az = new FakeAz(); az[field] = value;
    await assert.rejects(new IdentityClient(bound, az).silent(oid), code(expected));
  }
  const az = new FakeAz();
  const identity = new IdentityClient(bound, az);
  await identity.silent(oid); await identity.silent(oid);
  assert.equal(az.calls.length, 10);
  // Cold username disagreement is a token/CLI mismatch; a warm username change
  // violates the verified RAM pin before another credential is acquired.
  az.user = 'other@example.invalid';
  await assert.rejects(identity.silent(oid), code('ACCOUNT_CHANGED'));
  assert.equal(az.calls.filter(args => args[1] === 'get-access-token').length, 1);
  az.user = username;
  az.tokenOutput = token({}, Math.floor(Date.now() / 1000) - 1);
  await assert.rejects(identity.silent(oid, true), code('TOKEN_EXPIRED'));
});
test('process, state, endpoint and claims failures expose stable safe categories', async t => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'pm origins '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['unapproved.exe', 'icacls.exe', 'whoami.exe', 'powershell.exe']) {
    assert.throws(() => windowsUtility(name), code('CLI_EXECUTION_FAILED'));
  }
  assert.throws(() => defaultStateRoot('win32', {}, ''), code('STATE_ACCESS_DENIED'));
  await assert.rejects(new StateStore(root).load('missing'), code('PROFILE_MISSING'));
  await assert.rejects(new AzureCliProcess({ executable: path.join(root, 'missing') }).run(['version']), code('AZ_CLI_NOT_FOUND'));
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }), code('CLI_TIMEOUT'));
  // Keep the fixture alive so this asserts overflow after successful cleanup, not a taskkill exit race.
  await assert.rejects(runProcess(process.execPath, ['-e', "console.log('x'.repeat(10000));setInterval(()=>{},1000)"], { outputLimit: 10 }), code('CLI_OUTPUT_LIMIT'));
  const endpoint = 'https://fixture.example/mcp';
  await assert.rejects(authenticatedFetch(endpoint, async () => 'synthetic',
    async () => new Response(null, { status: 401,
      headers: { 'www-authenticate': 'Bearer error="insufficient_claims"' } }))(endpoint),
  code('CLAIMS_LOGIN_REQUIRED'));
  await assert.rejects(authenticatedFetch(endpoint, async () => assert.fail('no token'))('https://other.example/'), code('ENDPOINT_REJECTED'));
  for (const status of [401, 302, 403])
    await assert.rejects(authenticatedFetch(endpoint, async () => 'synthetic', async () => new Response('', { status }))(endpoint),
      code(status === 302 ? 'REDIRECT_BLOCKED' : 'HTTP_FAILURE'));
});
