'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { acquireAdoToken, ADO_ENTRA_RESOURCE_GUID } = require('../lib/acquire-ado-token');

const VALID_AZ = () =>
  JSON.stringify({ token: 'jwt-abc', expiresOn: '2026-06-15T23:00:00Z', tenantId: 'tenant-1' });

test('acquireAdoToken returns the token, tenantId, expiresOn on success (DI)', () => {
  const r = acquireAdoToken({ _execImpl: VALID_AZ });
  assert.equal(r.ok, true);
  assert.equal(r.token, 'jwt-abc');
  assert.equal(r.tenantId, 'tenant-1');
  assert.equal(r.expiresOn, '2026-06-15T23:00:00Z');
  assert.equal(r.source, 'az:acquire');
});

test('acquireAdoToken queries the tenant-invariant ADO resource GUID', () => {
  let seenCmd = '';
  acquireAdoToken({ _execImpl: (cmd) => { seenCmd = cmd; return VALID_AZ(); } });
  assert.ok(seenCmd.includes(ADO_ENTRA_RESOURCE_GUID));
  assert.ok(seenCmd.includes('az account get-access-token'));
});

test('acquireAdoToken surfaces an actionable az-login error when az throws', () => {
  const r = acquireAdoToken({
    _execImpl: () => { const e = new Error('boom'); e.stderr = Buffer.from('Please run az login'); throw e; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /az login/i);
  assert.match(r.error, /Please run az login/);
});

test('acquireAdoToken errors on non-JSON az output', () => {
  const r = acquireAdoToken({ _execImpl: () => 'not json' });
  assert.equal(r.ok, false);
  assert.match(r.error, /non-JSON/);
});

test('acquireAdoToken errors when az returns no accessToken field', () => {
  const r = acquireAdoToken({ _execImpl: () => JSON.stringify({ expiresOn: 'x' }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /no accessToken/);
});

test('acquireAdoToken never echoes the token (no stdout side effect in result keys)', () => {
  const r = acquireAdoToken({ _execImpl: VALID_AZ });
  // The token is only available as r.token for in-memory use; there is no
  // file path, sha, or any persistence affordance in the result shape.
  assert.deepEqual(Object.keys(r).sort(), ['expiresOn', 'ok', 'source', 'tenantId', 'token'].sort());
});
