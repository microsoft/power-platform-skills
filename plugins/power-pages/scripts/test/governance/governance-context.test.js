'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  applyHostOverride,
  applyEnvOverride,
  resolveHostOverride,
  resolveRing,
  getRing,
  loadConfig,
  resetConfigCache,
  resolveTargetEnv,
  resourceForHost,
  isTruthyFlag,
  DEFAULT_RINGS,
  RINGS,
  TIP_GATEWAY_HOST,
  PROD_GATEWAY_HOST,
} = require('../../../skills/manage-governance/scripts/governance-context');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function shippedRingKey() {
  resetConfigCache();
  return loadConfig().activeRing || 'TIP';
}

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

test('resolveRing: app-settings.json decides the active ring', () => {
  const expected = shippedRingKey();
  assert.equal(resolveRing({}), expected);
  assert.equal(resolveRing({ PP_GOV_PROD: '0' }), expected);
});

test('resolveRing: ring env vars no longer override app-settings.json', () => {
  const expected = shippedRingKey();
  assert.equal(resolveRing({ PP_GOV_PROD: '1' }), expected);
  assert.equal(resolveRing({ PP_GOV_PROD: 'true' }), expected);
  assert.equal(resolveRing({ PP_GOV_RING: 'prod' }), expected);
  assert.equal(resolveRing({ PP_GOV_RING: 'production' }), expected);
});

test('resolveHostOverride: default host follows the configured ring', () => {
  const expected =
    shippedRingKey() === 'Prod' ? 'https://api.powerplatform.com' : TIP_GATEWAY_HOST;
  assert.equal(resolveHostOverride({}, 'https://api.powerplatform.com'), expected);
});

test('resolveHostOverride: PP_GOV_TIP_HOST only matters when TIP is the configured ring', () => {
  const custom = 'https://api.custom-ring.powerplatform.com';
  const expected = shippedRingKey() === 'Prod' ? 'x' : custom;
  assert.equal(resolveHostOverride({ PP_GOV_TIP_HOST: custom + '/' }, 'x'), expected);
});

test('resolveHostOverride: Prod ring uses the signed-in prod host', () => {
  const expectedWithProdApiHost =
    shippedRingKey() === 'Prod' ? 'https://api.gov.powerplatform.microsoft.us' : TIP_GATEWAY_HOST;
  assert.equal(
    resolveHostOverride({}, 'https://api.gov.powerplatform.microsoft.us'),
    expectedWithProdApiHost
  );
  const expectedWithoutProdApiHost =
    shippedRingKey() === 'Prod' ? PROD_GATEWAY_HOST : TIP_GATEWAY_HOST;
  assert.equal(resolveHostOverride({}, undefined), expectedWithoutProdApiHost);
});

test('resolveHostOverride: explicit PP_GOV_API_HOST outranks the configured ring host', () => {
  const explicit = 'https://api.example-ring.powerplatform.com';
  assert.equal(
    resolveHostOverride({ PP_GOV_API_HOST: explicit + '//' }, 'x'),
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

test('configured ring host + env override compose correctly', () => {
  const ctx = {
    baseUrl: 'https://api.powerplatform.com/powerpages/environments/env-a',
    apiHost: 'https://api.powerplatform.com',
    environmentId: 'env-a',
  };
  applyHostOverride(ctx, resolveHostOverride({}, ctx.apiHost));
  applyEnvOverride(ctx, 'env-b');
  const expectedHost =
    shippedRingKey() === 'Prod'
      ? 'https://api.powerplatform.com'
      : 'https://api.preprod.powerplatform.com';
  assert.equal(
    ctx.baseUrl,
    `${expectedHost}/powerpages/environments/env-b`
  );
});

// --- Single-switch config (app-settings.json) coverage --------------------

test('DEFAULT_RINGS carry both gateway AND bap routing per ring', () => {
  // TIP: preprod gateway + device-code, TIP BAP via REST.
  assert.equal(DEFAULT_RINGS.TIP.gatewayHost, 'https://api.preprod.powerplatform.com');
  assert.equal(DEFAULT_RINGS.TIP.tokenStrategy, 'device-code');
  assert.equal(DEFAULT_RINGS.TIP.bapStrategy, 'rest');
  assert.equal(DEFAULT_RINGS.TIP.bapHost, 'https://tip1.api.bap.microsoft.com');
  // Prod: prod gateway + az, prod BAP via the pac CLI shim.
  assert.equal(DEFAULT_RINGS.Prod.gatewayHost, 'https://api.powerplatform.com');
  assert.equal(DEFAULT_RINGS.Prod.tokenStrategy, 'az');
  assert.equal(DEFAULT_RINGS.Prod.bapStrategy, 'pac');
  assert.equal(DEFAULT_RINGS.Prod.bapHost, 'https://api.bap.microsoft.com');
});

test('getRing returns the merged ring object for the config-selected switch', () => {
  const expected = shippedRingKey();
  const expectedBapStrategy = expected === 'Prod' ? 'pac' : 'rest';
  assert.equal(getRing({}).label, expected);
  assert.equal(getRing({}).bapStrategy, expectedBapStrategy);
  assert.equal(getRing({}, 'Prod').label, 'Prod');
  assert.equal(getRing({}, 'Prod').bapStrategy, 'pac');
});

test('resolveRing: config.activeRing decides the ring even when env vars disagree', () => {
  const cfg = loadConfig(writeFixture({ activeRing: 'Prod' }));
  assert.equal(cfg.activeRing, 'Prod');
  // The shipped app-settings.json remains authoritative; ring env vars are ignored.
  const expected = shippedRingKey();
  assert.equal(resolveRing({ PP_GOV_RING: 'tip' }), expected);
  assert.equal(resolveRing({ PP_GOV_PROD: '1' }), expected);
});

test('loadConfig normalizes activeRing aliases and merges ring overrides', () => {
  const p = writeFixture({
    activeRing: 'test', // alias → TIP
    targetEnv: '  a5ff24b0-0000  ',
    rings: {
      TIP: { bapHost: 'https://tip1.api.bap.microsoft.com/', gatewayHost: 'https://custom.preprod/' },
    },
  });
  const cfg = loadConfig(p);
  assert.equal(cfg.activeRing, 'TIP');
  assert.equal(cfg.targetEnv, 'a5ff24b0-0000'); // trimmed
  // Trailing slashes stripped on hosts.
  assert.equal(cfg.rings.TIP.bapHost, 'https://tip1.api.bap.microsoft.com');
  assert.equal(cfg.rings.TIP.gatewayHost, 'https://custom.preprod');
  // Unspecified fields fall back to defaults.
  assert.equal(cfg.rings.TIP.tokenStrategy, 'device-code');
  assert.equal(cfg.rings.Prod.gatewayHost, DEFAULT_RINGS.Prod.gatewayHost);
});

test('loadConfig fails open to defaults on a missing/invalid file', () => {
  const missing = path.join(os.tmpdir(), `pp-gov-nope-${Date.now()}.json`);
  const cfg = loadConfig(missing);
  assert.equal(cfg.rings.TIP.gatewayHost, DEFAULT_RINGS.TIP.gatewayHost);
  assert.equal(cfg.activeRing, null); // no file → no explicit ring → default path
  // Invalid JSON also fails open.
  const bad = writeFixtureRaw('{ not json');
  const cfg2 = loadConfig(bad);
  assert.equal(cfg2.rings.Prod.bapHost, DEFAULT_RINGS.Prod.bapHost);
});

test('loadConfig accepts legacy `host` as gatewayHost alias', () => {
  const cfg = loadConfig(writeFixture({ rings: { Prod: { host: 'https://legacy.prod' } } }));
  assert.equal(cfg.rings.Prod.gatewayHost, 'https://legacy.prod');
});

test('resolveTargetEnv: PP_GOV_ENV_ID overrides the file targetEnv', () => {
  assert.equal(resolveTargetEnv({ PP_GOV_ENV_ID: 'env-from-var' }), 'env-from-var');
  // With neither set, the shipped app-settings.json targetEnv is empty → null.
  resetConfigCache();
  assert.equal(resolveTargetEnv({}), null);
});

// Write a temp app-settings.json fixture and return its path. Kept local to the
// test so cases can exercise loadConfig's file path without touching the shipped
// config. Each fixture is uniquely named so parallel runs don't collide.
let fixtureSeq = 0;
function writeFixture(obj) {
  return writeFixtureRaw(JSON.stringify(obj));
}
function writeFixtureRaw(text) {
  const p = path.join(os.tmpdir(), `pp-gov-cfg-${process.pid}-${fixtureSeq++}.json`);
  fs.writeFileSync(p, text);
  return p;
}
