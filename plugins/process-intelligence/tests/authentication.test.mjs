// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityClient, validateIdentity } from '../src/authentication.mjs';
import { sample, bound, oid, username, token, claim, FakeAz } from './helpers.mjs';
test('explicit token args/no subscription/memory cache/forced reacquisition', async () => {
  const az = new FakeAz(), client = new IdentityClient(bound, az);
  const first = await client.silent(oid);
  assert.equal(first.accountId, oid);
  assert.equal((await client.silent(oid)).token, first.token);
  assert.equal(az.calls.filter(a => a[1] === 'get-access-token').length, 1);
  assert.equal(az.calls.filter(a => a[0] === 'account' && a[1] === 'show').length, 4);
  assert.deepEqual(az.calls.find(a => a[1] === 'get-access-token'), ['account', 'get-access-token', '--tenant', sample.TenantId,
    '--resource', 'https://api.powerplatform.com', '--output', 'json', '--only-show-errors']);
  await client.silent(oid, null, true);
  assert.equal(az.calls.filter(a => a[1] === 'get-access-token').length, 2);
  assert.doesNotMatch(String(first), /eyJ/);
});
for (const [field, value] of Object.entries({ cloud: 'AzureUSGovernment', authority: 'https://evil.example/', tenant: 'wrong',
  user: 'other@example.invalid', userType: 'servicePrincipal' })) test(`cached token rejects ${field} drift`, async () => {
  const az = new FakeAz(), client = new IdentityClient(bound, az);
  await client.silent(oid); az[field] = value;
  await assert.rejects(client.silent(oid));
  assert.equal(az.calls.filter(a => a[1] === 'get-access-token').length, 1);
});
for (const [field, value] of Object.entries({ tid: 'wrong', oid: '44444444-4444-4444-4444-444444444444', aud: 'https://management.azure.com',
  appid: 'wrong', unique_name: 'other@example.invalid', scp: '', idtyp: 'app' })) test(`reject token ${field} mismatch`, async () => {
  const az = new FakeAz(); az.tokenOutput = token({ [field]: value });
  await assert.rejects(new IdentityClient(bound, az).silent(oid));
});
for (const value of ['', 'secret', '[]', '{}', '{"accessToken":"secret","expiresOn":"2099-01-01"}']) test(`redact malformed token output ${value}`, async () => {
  const az = new FakeAz(); az.tokenOutput = value;
  await assert.rejects(new IdentityClient(bound, az).silent(oid), error => !String(error).includes('secret'));
});
test('expiry uses UTC/JWT minimum and two minute refresh margin', async () => {
  let now = Date.now();
  const az = new FakeAz(); az.tokenOutput = token({}, Math.floor(now / 1000) + 300);
  const client = new IdentityClient(bound, az, () => now);
  await client.silent(oid); now += 240000; az.tokenOutput = token({}, Math.floor(now / 1000) + 300);
  await client.silent(oid);
  assert.equal(az.calls.filter(a => a[1] === 'get-access-token').length, 2);
  az.tokenOutput = token({ exp: Math.floor(now / 1000) - 1 }, Math.floor(now / 1000) + 300);
  await assert.rejects(client.silent(oid, null, true), /expired/);
  const envelope = JSON.parse(token()); envelope.expires_on = '9223372036854775807'; az.tokenOutput = JSON.stringify(envelope);
  await assert.rejects(client.silent(oid, null, true));
});
test('before/after snapshot race fails before returning token', async () => {
  for (const [field, value] of Object.entries({
    user: 'other@example.invalid', tenant: '44444444-4444-4444-4444-444444444444', cloud: 'AzureUSGovernment'
  })) {
    const az = new FakeAz(); az.afterToken = () => { az[field] = value; };
    await assert.rejects(new IdentityClient(bound, az).silent(oid));
  }
});
test('warm cache still checks the CLI snapshot after acquisition', async () => {
  const az = new FakeAz(), client = new IdentityClient(bound, az);
  await client.silent(oid);
  const run = az.run.bind(az);
  az.run = async (...args) => {
    const output = await run(...args);
    if (args[0][0] === 'account' && args[0][1] === 'show') az.user = 'other@example.invalid';
    return output;
  };
  await assert.rejects(client.silent(oid), { errorCode: 'ACCOUNT_CHANGED' });
  assert.equal(az.calls.filter(args => args[1] === 'get-access-token').length, 1);
});
test('cold OID binding accepts a matching renamed user without changing the profile', async () => {
  const az = new FakeAz(), selected = Object.freeze({ ...bound });
  az.user = 'renamed@example.invalid';
  az.tokenOutput = token({ unique_name: az.user });
  const client = new IdentityClient(selected, az);
  const result = await client.silent(oid);
  assert.equal(result.accountId, oid);
  assert.equal(result.accountUsername, az.user);
  assert.deepEqual(selected, bound);
  assert.equal(JSON.stringify(selected).includes(az.user), false);
  assert.equal(JSON.stringify(result).includes(az.user), false);
  az.user = username;
  await assert.rejects(client.silent(oid), { errorCode: 'ACCOUNT_CHANGED' });
  client.dispose();
  az.tokenOutput = token();
  assert.equal((await new IdentityClient(selected, az).silent(oid)).accountId, oid);
});
for (const invalidation of ['force', 'claims', 'expiry'])
test(`RAM username pin survives ${invalidation} token invalidation`, async () => {
  let now = Date.now();
  const az = new FakeAz(), client = new IdentityClient(bound, az, () => now);
  await client.silent(oid);
  if (invalidation === 'claims') await assert.rejects(client.silent(oid, claim, true), { errorCode: 'CLAIMS_LOGIN_REQUIRED' });
  if (invalidation === 'expiry') now += 3600000;
  az.user = 'other@example.invalid';
  az.tokenOutput = token({ unique_name: az.user }, Math.floor(now / 1000) + 3600);
  await assert.rejects(client.silent(oid, null, invalidation === 'force'), { errorCode: 'ACCOUNT_CHANGED' });
  assert.equal(az.calls.filter(args => args[1] === 'get-access-token').length, 1);
});
test('forced fresh token rejects changed OID even if the CLI username stayed the same', async () => {
  const az = new FakeAz(), client = new IdentityClient(bound, az);
  await client.silent(oid);
  az.tokenOutput = token({ oid: '44444444-4444-4444-4444-444444444444' });
  await assert.rejects(client.silent(oid, null, true), { errorCode: 'ACCOUNT_CHANGED' });
  assert.equal(az.calls.filter(args => args[1] === 'get-access-token').length, 2);
});
test('token-free session check cannot verify a cold OID but checks warm username continuity', async () => {
  const az = new FakeAz(), client = new IdentityClient(bound, az);
  az.user = 'other@example.invalid';
  await client.checkSession();
  assert.equal(az.calls.some(args => args[1] === 'get-access-token'), false);
  az.user = username;
  await client.silent(oid);
  const acquisitions = az.calls.filter(args => args[1] === 'get-access-token').length;
  az.user = 'other@example.invalid';
  await assert.rejects(client.checkSession(), { errorCode: 'ACCOUNT_CHANGED' });
  assert.equal(az.calls.filter(args => args[1] === 'get-access-token').length, acquisitions);
});
test('claims require verified explicit login, never silently omitted', async () => {
  const az = new FakeAz(), client = new IdentityClient(bound, az);
  await assert.rejects(client.silent(oid, claim, true), /conditional-access/);
  assert.equal(az.calls.length, 0);
  await assert.rejects(client.bind(claim, false));
  await client.bind(claim, true);
  const login = az.calls.find(a => a[0] === 'login');
  assert.ok(login.includes('--allow-no-subscriptions'));
  assert.equal(Buffer.from(login[login.indexOf('--claims-challenge') + 1], 'base64').toString(), claim);
  assert.equal(az.calls.some(a => a.includes('set') || a.includes('logout')), false);
});
test('old CLI claims/version and default binding never start UI', async () => {
  const az = new FakeAz(); az.version = '2.54.0';
  const client = new IdentityClient(bound, az);
  await client.bind(); await assert.rejects(client.bind(claim, true), /2.80/);
  assert.equal(az.calls.some(a => a[0] === 'login'), false);
  az.version = '2.53.0'; await assert.rejects(new IdentityClient(bound, az).silent(oid), /2.54/);
});
for (const [error, expected] of [['AADSTS65001 secret', /consent/], ['AADSTS65002 secret', /preauthorization/],
  ['AADSTS700082 secret', /expired/], ['AADSTS50076 secret', /Conditional/], ["run 'az login' secret", /login/],
  ['ConnectionError secret', /transport/], ['AADSTS99999 secret', /authentication/]]) test(`safe error ${error.split(' ')[0]}`, async () => {
  const az = new FakeAz(); az.tokenError = error;
  await assert.rejects(new IdentityClient(bound, az).silent(oid), e => expected.test(e.message) && !String(e).includes('secret'));
});
test('identity switch requires explicit selection and cancellation stays cancellation', async () => {
  const result = await new IdentityClient(sample, new FakeAz()).bind();
  assert.throws(() => validateIdentity({ ...bound, HomeAccountId: 'other' }, result, false));
  validateIdentity({ ...bound, HomeAccountId: 'other' }, result, true);
  await assert.rejects(new IdentityClient(bound, new FakeAz()).silent(oid, null, false, AbortSignal.abort()), { name: 'AbortError' });
});
test('discovery and MCP token audiences never share a memory-cache entry', async () => {
  const az = new FakeAz(), client = new IdentityClient(bound, az);
  assert.equal(typeof client.environmentDiscoveryToken, 'function');
  await client.silent(oid);
  az.tokenOutput = token({ aud: 'https://api.bap.microsoft.com' });
  await client.environmentDiscoveryToken();
  az.tokenOutput = token();
  await client.silent(oid);
  assert.deepEqual(az.calls.filter(args => args[1] === 'get-access-token')
    .map(args => args[args.indexOf('--resource') + 1]),
  ['https://api.powerplatform.com', 'https://api.bap.microsoft.com', 'https://api.powerplatform.com']);
});
test('discovery token acquisition rejects non-Public profiles before CLI calls', async () => {
  const az = new FakeAz(), client = new IdentityClient({ ...bound, Cloud: 'Gcc' }, az);
  assert.equal(typeof client.environmentDiscoveryToken, 'function');
  await assert.rejects(client.environmentDiscoveryToken(), /Public/);
  assert.equal(az.calls.length, 0);
});
