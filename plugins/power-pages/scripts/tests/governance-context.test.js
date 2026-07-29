'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  applyHostOverride,
  applyEnvOverride,
  resolveHostOverride,
  resolveRing,
  resourceForHost,
  isTruthyFlag,
  RINGS,
  TIP_GATEWAY_HOST,
  PROD_GATEWAY_HOST,
} = require('../../skills/manage-governance/scripts/governance-context');

test('RINGS registry: central source of truth for host + token strategy', () => {
  assert.equal(RINGS.TIP.host, 'https://api.preprod.powerplatform.com');
  assert.equal(RINGS.TIP.tokenStrategy, 'device-code');
  assert.equal(RINGS.TIP.hostEnv, 'PP_GOV_TIP_HOST');
  assert.equal(RINGS.Prod.host, 'https://api.powerplatform.com');
  assert.equal(RINGS.Prod.tokenStrategy, 'az');
  // Named host constants must stay in sync with the registry.
  assert.equal(TIP_GATEWAY_HOST, RINGS.TIP.host);
  assert.equal(PROD_GATEWAY_HOST, RINGS.Prod.host);
});

test('TIP_GATEWAY_HOST is the Preprod host, distinct from prod', () => {
  // api.tip.powerplatform.com does NOT resolve — Preprod is api.preprod...
  assert.equal(TIP_GATEWAY_HOST, 'https://api.preprod.powerplatform.com');
  assert.equal(PROD_GATEWAY_HOST, 'https://api.powerplatform.com');
  assert.notEqual(TIP_GATEWAY_HOST, PROD_GATEWAY_HOST);
});

test('isTruthyFlag accepts the dotnet-style truthy spellings', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(isTruthyFlag(v), true, `expected "${v}" truthy`);
  }
  for (const v of ['0', 'false', 'no', 'off', '', undefined, null]) {
    assert.equal(isTruthyFlag(v), false, `expected "${v}" falsy`);
  }
});

test('resolveRing: TIP is the default (no env vars set)', () => {
  assert.equal(resolveRing({}), 'TIP');
  assert.equal(resolveRing({ PP_GOV_PROD: '0' }), 'TIP');
});

test('resolveRing: PP_GOV_PROD truthy escapes to Prod', () => {
  assert.equal(resolveRing({ PP_GOV_PROD: '1' }), 'Prod');
  assert.equal(resolveRing({ PP_GOV_PROD: 'true' }), 'Prod');
});

test('resolveRing: explicit PP_GOV_RING wins over PP_GOV_PROD', () => {
  assert.equal(resolveRing({ PP_GOV_RING: 'prod' }), 'Prod');
  assert.equal(resolveRing({ PP_GOV_RING: 'production' }), 'Prod');
  assert.equal(resolveRing({ PP_GOV_RING: 'tip', PP_GOV_PROD: '1' }), 'TIP');
  assert.equal(resolveRing({ PP_GOV_RING: 'preprod', PP_GOV_PROD: '1' }), 'TIP');
});

test('resolveHostOverride: TIP default resolves to the Preprod host', () => {
  assert.equal(resolveHostOverride({}, 'https://api.powerplatform.com'), TIP_GATEWAY_HOST);
});

test('resolveHostOverride: PP_GOV_TIP_HOST overrides the default TIP host', () => {
  const custom = 'https://api.custom-ring.powerplatform.com';
  assert.equal(resolveHostOverride({ PP_GOV_TIP_HOST: custom + '/' }, 'x'), custom);
});

test('resolveHostOverride: Prod ring uses the signed-in prod host', () => {
  assert.equal(
    resolveHostOverride({ PP_GOV_PROD: '1' }, 'https://api.gov.powerplatform.microsoft.us'),
    'https://api.gov.powerplatform.microsoft.us'
  );
  // Falls back to the public prod host when no prod host is provided.
  assert.equal(resolveHostOverride({ PP_GOV_PROD: '1' }, undefined), PROD_GATEWAY_HOST);
});

test('resolveHostOverride: explicit PP_GOV_API_HOST outranks ring + PP_GOV_PROD', () => {
  const explicit = 'https://api.example-ring.powerplatform.com';
  assert.equal(
    resolveHostOverride({ PP_GOV_API_HOST: explicit + '//', PP_GOV_PROD: '1' }, 'x'),
    explicit
  );
});

test('resourceForHost appends exactly one trailing slash (the token audience)', () => {
  assert.equal(resourceForHost('https://api.preprod.powerplatform.com'), 'https://api.preprod.powerplatform.com/');
  assert.equal(resourceForHost('https://api.preprod.powerplatform.com///'), 'https://api.preprod.powerplatform.com/');
});

test('applyHostOverride rewrites only scheme+authority, preserving the env path', () => {
  const ctx = {
    baseUrl: 'https://api.powerplatform.com/powerpages/environments/env-123',
    apiHost: 'https://api.powerplatform.com',
  };
  applyHostOverride(ctx, TIP_GATEWAY_HOST);
  assert.equal(
    ctx.baseUrl,
    'https://api.preprod.powerplatform.com/powerpages/environments/env-123'
  );
  assert.equal(ctx.apiHost, TIP_GATEWAY_HOST);
});

test('applyHostOverride strips trailing slashes from the override host', () => {
  const ctx = {
    baseUrl: 'https://api.powerplatform.com/powerpages/environments/env-123',
    apiHost: 'https://api.powerplatform.com',
  };
  applyHostOverride(ctx, 'https://api.preprod.powerplatform.com///');
  assert.equal(
    ctx.baseUrl,
    'https://api.preprod.powerplatform.com/powerpages/environments/env-123'
  );
  assert.equal(ctx.apiHost, 'https://api.preprod.powerplatform.com');
});

test('applyEnvOverride swaps the env id segment and leaves the host intact', () => {
  const ctx = {
    baseUrl: 'https://api.preprod.powerplatform.com/powerpages/environments/old-env',
    environmentId: 'old-env',
  };
  applyEnvOverride(ctx, 'new-env');
  assert.equal(
    ctx.baseUrl,
    'https://api.preprod.powerplatform.com/powerpages/environments/new-env'
  );
  assert.equal(ctx.environmentId, 'new-env');
});

test('default TIP host + env override compose (host switched, then env id swapped)', () => {
  const ctx = {
    baseUrl: 'https://api.powerplatform.com/powerpages/environments/env-a',
    apiHost: 'https://api.powerplatform.com',
    environmentId: 'env-a',
  };
  applyHostOverride(ctx, resolveHostOverride({}, ctx.apiHost));
  applyEnvOverride(ctx, 'env-b');
  assert.equal(
    ctx.baseUrl,
    'https://api.preprod.powerplatform.com/powerpages/environments/env-b'
  );
});
