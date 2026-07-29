'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');

const {
  buildScope,
  resolveTipConfig,
  decodeJwtExp,
  isTokenFresh,
  cachePath,
  DEFAULT_TIP_HOST,
  DEFAULT_TIP_CLIENT_ID,
  DEFAULT_TIP_TENANT,
} = require('../../skills/manage-governance/scripts/tip-auth');

// Build a JWT whose payload carries the given exp (seconds since epoch). Only
// the payload segment is meaningful here — decodeJwtExp never verifies the sig.
function fakeJwt(exp) {
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'none' })}.${b64url({ exp })}.sig`;
}

test('buildScope resource-qualifies both PP scopes + offline_access', () => {
  assert.equal(
    buildScope('https://api.preprod.powerplatform.com'),
    'https://api.preprod.powerplatform.com/PowerPages.Websites.Read ' +
      'https://api.preprod.powerplatform.com/PowerPages.Websites.Write offline_access'
  );
});

test('buildScope strips a trailing slash off the host before qualifying', () => {
  assert.equal(
    buildScope('https://api.preprod.powerplatform.com/'),
    'https://api.preprod.powerplatform.com/PowerPages.Websites.Read ' +
      'https://api.preprod.powerplatform.com/PowerPages.Websites.Write offline_access'
  );
});

test('resolveTipConfig defaults to the shipped app id + organizations tenant', () => {
  const cfg = resolveTipConfig({});
  assert.equal(cfg.error, undefined);
  assert.equal(cfg.clientId, DEFAULT_TIP_CLIENT_ID);
  assert.equal(cfg.tenantId, DEFAULT_TIP_TENANT);
  assert.equal(cfg.host, DEFAULT_TIP_HOST);
});

test('resolveTipConfig lets env vars override the app id and tenant', () => {
  const cfg = resolveTipConfig({ PP_GOV_TIP_CLIENT_ID: 'abc', PP_GOV_TIP_TENANT: 'tid' });
  assert.equal(cfg.error, undefined);
  assert.equal(cfg.clientId, 'abc');
  assert.equal(cfg.tenantId, 'tid');
  assert.equal(cfg.host, DEFAULT_TIP_HOST);
});

test('resolveTipConfig honors PP_GOV_TIP_HOST and strips trailing slash', () => {
  const cfg = resolveTipConfig({
    PP_GOV_TIP_CLIENT_ID: 'abc',
    PP_GOV_TIP_TENANT: 'tid',
    PP_GOV_TIP_HOST: 'https://api.custom.powerplatform.com/',
  });
  assert.equal(cfg.host, 'https://api.custom.powerplatform.com');
});

test('decodeJwtExp extracts exp from a well-formed token, null otherwise', () => {
  assert.equal(decodeJwtExp(fakeJwt(1790000000)), 1790000000);
  assert.equal(decodeJwtExp('not-a-jwt'), null);
  assert.equal(decodeJwtExp(''), null);
  assert.equal(decodeJwtExp(null), null);
});

test('isTokenFresh is true for a future exp beyond the skew, false when expiring', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(isTokenFresh(fakeJwt(now + 3600), 300), true);
  // Within the 300s skew window -> treated as not fresh (needs renewal).
  assert.equal(isTokenFresh(fakeJwt(now + 100), 300), false);
  assert.equal(isTokenFresh(fakeJwt(now - 10), 300), false);
  assert.equal(isTokenFresh('garbage', 300), false);
});

test('cachePath lives in the OS temp dir', () => {
  assert.ok(cachePath().startsWith(os.tmpdir()));
  assert.ok(cachePath().endsWith('pp-gov-tip-token.json'));
});
