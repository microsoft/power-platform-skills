// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from 'node:assert/strict';

export const sample = { Name: 'sample', Cloud: 'Public', TenantId: '11111111-1111-1111-1111-111111111111',
  EnvironmentId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeff', Audience: null, HomeAccountId: null, Revision: '' };
export const oid = '33333333-3333-3333-3333-333333333333', username = 'fixture@example.invalid';
export const bound = { ...sample, HomeAccountId: oid };
export const claim = '{"access_token":{"acrs":{"value":"c1"}}}';
export function assertProfileBytes(bytes, accountId) {
  const saved = JSON.parse(bytes);
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(sample).sort());
  assert.equal(saved.HomeAccountId, accountId);
  assert.equal(bytes.includes('AccountUsername'), false);
  assert.equal(bytes.includes(username), false);
  assert.doesNotMatch(bytes, /accessToken|refresh_token/);
}
export function token(overrides = {}, expires = Math.floor(Date.now() / 1000) + 3600) {
  const payload = { tid: sample.TenantId, oid, aud: 'https://api.powerplatform.com',
    appid: '04b07795-8ddb-461a-bbee-02f9e1bf7b46', unique_name: username, scp: 'delegated.fixture', exp: expires, ...overrides };
  return JSON.stringify({ accessToken: 'eyJhbGciOiJSUzI1NiJ9.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.fixture',
    tokenType: 'Bearer', tenant: sample.TenantId, expires_on: expires, expiresOn: 'invalid-local-time' });
}
export class FakeAz {
  calls = []; version = '2.80.0'; cloud = 'AzureCloud'; authority = 'https://login.microsoftonline.com/';
  tenant = sample.TenantId; user = username; userType = 'user'; tokenOutput; tokenError; afterToken;
  async run(args, { signal } = {}) {
    signal?.throwIfAborted();
    this.calls.push(args);
    let stdout;
    if (args[0] === 'version') stdout = JSON.stringify({ 'azure-cli': this.version });
    else if (args[0] === 'cloud') stdout = JSON.stringify({ name: this.cloud, endpoints: { activeDirectory: this.authority } });
    else if (args[0] === 'login') stdout = '';
    else if (args[1] === 'show') stdout = JSON.stringify({ tenantId: this.tenant, environmentName: this.cloud,
      user: { name: this.user, type: this.userType } });
    else if (args[1] === 'get-access-token') {
      this.afterToken?.();
      if (this.tokenError) return { code: 1, stdout: '', stderr: this.tokenError };
      stdout = this.tokenOutput ?? token();
    } else throw new Error('Unexpected test command');
    return { code: 0, stdout, stderr: '' };
  }
}
