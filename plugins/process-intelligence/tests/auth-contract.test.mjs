// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityClient } from '../src/authentication.mjs';
import { resolveConnection, profile } from '../src/configuration.mjs';
import { FakeAz, bound, token, removedClouds } from './helpers.mjs';

for (const Cloud of ['Public', 'Gcc', 'GccHigh', 'DoD', 'Mooncake'])
  test(`allowlisted CLI token contract for ${Cloud}`, async () => {
    const selected = { ...bound, Cloud }, resolved = resolveConnection(selected), az = new FakeAz();
    az.cloud = resolved.cliCloud; az.authority = `https://${resolved.authorityHost}/`;
    az.tokenOutput = token({ aud: resolved.resource });
    await new IdentityClient(selected, az).silent(selected.HomeAccountId);
    assert.deepEqual(az.calls.find(a => a[1] === 'get-access-token'), ['account', 'get-access-token', '--tenant',
      selected.TenantId, '--resource', resolved.resource, '--output', 'json', '--only-show-errors']);
  });
test('removed cloud profiles fail validation before invoking authentication', async () => {
  for (const Cloud of removedClouds) {
    const az = new FakeAz();
    await assert.rejects(async () => {
      const selected = profile({ ...bound, Cloud });
      await new IdentityClient(selected, az).silent(selected.HomeAccountId);
    }, error => error.exitCode === 2 && error.errorCode === 'INVALID_CONFIGURATION');
    assert.deepEqual(az.calls, []);
  }
});
for (const version of ['', 'broken', '2.53.9', '2.54', '2.80.0-dev'])
  test(`unsupported CLI version fails before token: ${version}`, async () => {
    const az = new FakeAz(); az.version = version;
    await assert.rejects(new IdentityClient(bound, az).silent(bound.HomeAccountId), /Azure CLI 2.54/);
    assert.equal(az.calls.some(a => a[1] === 'get-access-token'), false);
  });
for (const [field, value] of [
  ['tokenType', null], ['tokenType', 'DPoP'], ['tenant', null], ['tenant', '99999999-9999-9999-9999-999999999999'],
  ['expires_on', null], ['expires_on', 'invalid-local-time'], ['expires_on', -1], ['expires_on', 253402300800],
  ['accessToken', null], ['accessToken', 'private malformed output']
]) test(`invalid token envelope ${field}/${String(value)} is redacted`, async () => {
  const az = new FakeAz(), envelope = JSON.parse(token()); envelope[field] = value; az.tokenOutput = JSON.stringify(envelope);
  await assert.rejects(new IdentityClient(bound, az).silent(bound.HomeAccountId),
    e => !e.message.includes('private malformed output') && /invalid token|expired/.test(e.message));
});
test('Mooncake official authority alias is accepted without resource fallback', async () => {
  const mooncake = { ...bound, Cloud: 'Mooncake' }, az = new FakeAz();
  az.cloud = 'AzureChinaCloud'; az.authority = 'https://login.chinacloudapi.cn/';
  az.tokenOutput = token({ aud: resolveConnection(mooncake).resource }); await new IdentityClient(mooncake, az).silent(bound.HomeAccountId);
  assert.ok(az.calls.find(a => a[1] === 'get-access-token').includes(resolveConnection(mooncake).resource));
});
