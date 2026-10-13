// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityClient, ProfileTokenProvider, login } from '../src/authentication.mjs';
import { authenticatedFetch } from '../src/http-auth.mjs';
import { resolveConnection } from '../src/configuration.mjs';
import { FakeAz, bound, sample, username, token } from './helpers.mjs';
function state(p) {
  return { current: { ...p },
    async ensureCurrent(p) { assert.deepEqual(p, this.current, 'Profile changed'); },
    async save(p, revision) {
      assert.equal(this.current.Revision, revision, 'Profile changed');
      return this.current = { ...p, Revision: 'new' };
    } };
}
test('profile provider never initiates login and validates revision before/after token', async () => {
  const s = state(bound), az = new FakeAz(), id = new IdentityClient(bound, az);
  const provider = new ProfileTokenProvider(bound, s, id);
  assert.ok(await provider.getToken()); assert.equal(az.calls.some(a => a[0] === 'login'), false);
  s.current.Revision = 'changed'; await assert.rejects(provider.getToken(), /changed/);
});
test('unbound profile fails before subprocess', async () => {
  const az = new FakeAz(), s = state(sample), provider = new ProfileTokenProvider(sample, s, new IdentityClient(sample, az));
  await assert.rejects(provider.getToken(), /No account/); assert.equal(az.calls.length, 0);
});
test('claims failure requests login without changing the profile or starting sign-in', async () => {
  const s = state(bound), az = new FakeAz(), id = new IdentityClient(bound, az), provider = new ProfileTokenProvider(bound, s, id);
  const endpoint = resolveConnection(bound).endpoint;
  let sent = 0;
  const fetch = authenticatedFetch(endpoint, (...args) => provider.getToken(...args), async () => {
    sent++;
    return new Response(null, { status: 401,
      headers: { 'www-authenticate': 'Bearer error="insufficient_claims", claims="private-payload"' } });
  });
  await assert.rejects(fetch(endpoint), { errorCode: 'CLAIMS_LOGIN_REQUIRED' });
  assert.equal(sent, 1);
  assert.deepEqual(s.current, bound);
  assert.equal(az.calls.some(a => a[0] === 'login'), false);
  const saved = await login(bound, s, id, { signIn: true });
  assert.equal(saved.HomeAccountId, bound.HomeAccountId);
  assert.equal(Object.hasOwn(saved, 'AccountUsername'), false);
  assert.equal(JSON.stringify(saved).includes(username), false);
  assert.equal(az.calls.filter(a => a[0] === 'login').length, 1);
  assert.equal(az.calls.some(a => a.includes('--claims-challenge')), false);
});
test('account switch requires explicit consent and wrong tenant never binds', async () => {
  const selected = { ...bound, HomeAccountId: '44444444-4444-4444-4444-444444444444' };
  const s = state(selected), id = new IdentityClient(selected, new FakeAz());
  await assert.rejects(login(selected, s, id), /different account/);
  assert.equal((await login(selected, s, id, { switchAccount: true })).HomeAccountId, bound.HomeAccountId);
  const az = new FakeAz(); az.tenant = '99999999-9999-9999-9999-999999999999';
  await assert.rejects(login(sample, state(sample), new IdentityClient(sample, az), { switchAccount: true }), /tenant/);
});
test('explicit login can replace a warm username pin but only explicit switching saves a different OID', async () => {
  const az = new FakeAz(), s = state(bound), id = new IdentityClient(bound, az);
  await new ProfileTokenProvider(bound, s, id).getToken();
  az.user = 'switched@example.invalid';
  const nextOid = '44444444-4444-4444-4444-444444444444';
  az.tokenOutput = token({ oid: nextOid, unique_name: az.user });
  await assert.rejects(new ProfileTokenProvider(bound, s, id).getToken(), { errorCode: 'ACCOUNT_CHANGED' });
  await assert.rejects(login(bound, s, id), { errorCode: 'ACCOUNT_CHANGED' });
  assert.deepEqual(s.current, bound);
  const saved = await login(bound, s, id, { switchAccount: true });
  assert.equal(saved.HomeAccountId, nextOid);
  assert.equal(Object.hasOwn(saved, 'AccountUsername'), false);
  assert.equal(JSON.stringify(saved).includes(az.user), false);
});
test('revision change during acquisition prevents token escape and stale login', async () => {
  for (const binding of [false, true]) {
    const s = state(bound), az = new FakeAz(); az.afterToken = () => { s.current.Revision = 'changed'; };
    const id = new IdentityClient(bound, az);
    await assert.rejects(binding ? login(bound, s, id) : new ProfileTokenProvider(bound, s, id).getToken(), /changed/);
  }
});
for (const user of [username, 'other@example.invalid'])
test(`cold principal mismatch prevents MCP traffic (same CLI username: ${user === username})`, async () => {
  const az = new FakeAz();
  az.user = user;
  az.tokenOutput = token({ oid: '44444444-4444-4444-4444-444444444444', unique_name: user });
  const provider = new ProfileTokenProvider(bound, state(bound), new IdentityClient(bound, az));
  let sent = 0;
  const endpoint = resolveConnection(bound).endpoint;
  const fetch = authenticatedFetch(endpoint, (...args) => provider.getToken(...args),
    async () => { sent++; return new Response(null, { status: 200 }); }, { transportMode: 'post-only' });
  await assert.rejects(fetch(endpoint, { method: 'POST', body: '{}' }), { errorCode: 'ACCOUNT_CHANGED' });
  assert.equal(sent, 0);
  assert.equal(az.calls.filter(args => args[1] === 'get-access-token').length, 1);
});
