'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const checker = require('../check-auth-governance');
const { CLOUD_TO_API } = require('../lib/validation-helpers');

const tenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const envId = '11111111-1111-1111-1111-111111111111';
const portalId = '22222222-2222-2222-2222-222222222222';
const websiteRecordId = '33333333-3333-3333-3333-333333333333';
const ROOT = 'EnableExternalAuthProviders';
const OAUTH = 'EnableProtocolOpenAuth';
const FACEBOOK = 'EnableIdpOAuthFacebook';
const options = { tenantId, envId, portalId, websiteRecordId, providers: ['facebook'] };

function testToken(tenant) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ tid: tenant, canary: 'PRIVATE_TEST_TOKEN' })).toString('base64url');
  return `${header}.${payload}.test-signature`;
}

function requestedPolicy(call) {
  return policyFromRequest(call, `/websites/${portalId}/governance/`);
}

function policyFromRequest(call, prefix) {
  assert.equal(call.method, 'GET');
  assert.equal(call.body, undefined);
  assert.ok(call.path.startsWith(prefix), `Expected a policy read for the confirmed host: ${call.path}`);
  const policy = call.path.slice(prefix.length);
  assert.match(policy, /^Enable[A-Za-z0-9]+$/);
  return policy;
}

function harness(responses = {}, contextOverrides = {}, scope = 'portal') {
  const context = {
    tenantId,
    environmentId: envId,
    apiHost: CLOUD_TO_API.Public,
    baseUrl: `${CLOUD_TO_API.Public}/powerpages/environments/${envId}`,
    token: testToken(tenantId),
    ...contextOverrides,
  };
  const calls = [];
  let resolutions = 0;
  return {
    context, calls,
    get resolutions() { return resolutions; },
    dependencies: {
      async sleep() {},
      resolveContext() { resolutions++; return context; },
      async request(args) {
        calls.push(args);
        const policy = scope === 'environment'
          ? policyFromRequest(args, '/governance/') : requestedPolicy(args);
        const response = responses[policy];
        if (response instanceof Error) throw response;
        return response === undefined
          ? { ok: true, statusCode: 200, body: scope === 'environment' ? 'All' : true } : response;
      },
    },
  };
}

const providerPolicies = {
  facebook: [ROOT, OAUTH, FACEBOOK],
  google: [ROOT, OAUTH, 'EnableIdpOAuthGoogle'],
  microsoft: [ROOT, OAUTH, 'EnableIdpOAuthMicrosoft'],
  oidc: [ROOT, 'EnableProtocolOpenIdConnect'],
  saml: [ROOT, 'EnableProtocolSAML20'],
  'ws-federation': [ROOT, 'EnableProtocolWsFederation'],
  local: [ROOT, 'EnableAuthenticationLocalLogin'],
};

const environmentOptions = { ...options, portalId: null, scope: 'environment' };

test('environment scope reads the complete deduplicated provider graph without a host ID', async () => {
  const h = harness({}, {}, 'environment');
  const providers = ['entra-id', ...Object.keys(providerPolicies)];
  const result = await checker.checkAuthGovernance({ ...environmentOptions, providers }, h.dependencies);
  assert.equal(result.allowed, true);
  assert.equal(result.scope, 'environment');
  assert.equal(result.portalId, null);
  assert.equal(h.resolutions, 1);
  assert.deepEqual(h.calls.map((call) => policyFromRequest(call, '/governance/')),
    [...new Set(Object.values(providerPolicies).flat())]);
  assert.match(result.message, /allowed by environment governance/);
  assert.deepEqual(result.providers[0].blockedPolicies, []);
});

test('new-host environment scopes allow All/Exclude and block None/Include, including known aliases', async () => {
  for (const [body, enabled] of [
    ['All', true], [' AllSites ', true], ['EXCLUDE', true], ['ExcludeSites', true],
    ['ExcludedSites', true], ['AllSitesExceptExcluded', true],
    ['None', false], [' Include ', false], ['IncludeSites', false], ['IncludedSites', false],
  ]) {
    for (const policy of providerPolicies.facebook) {
      const h = harness({ [policy]: { ok: true, statusCode: 200, body } }, {}, 'environment');
      const result = await checker.checkAuthGovernance(environmentOptions, h.dependencies);
      assert.equal(result.allowed, enabled, `${policy}: ${body}`);
      assert.equal(result.canContinue, enabled);
      assert.equal(result.status, enabled ? 'enabled' : 'blocked');
      assert.deepEqual(result.providers[0].blockedPolicies.map((item) => item.policy), enabled ? [] : [policy]);
    }
  }
});

test('environment scope never interprets booleans, unknown envelopes, or unset/404 as policy decisions', async () => {
  for (const response of [
    ...[true, false, 'true', 'false', '', null, undefined, {}, { value: 'All' }, ['All'], 'future-scope', 1]
      .map((body) => ({ ok: true, statusCode: 200, body })),
    { ok: false, statusCode: 404 },
  ]) {
    const h = harness({ [FACEBOOK]: response }, {}, 'environment');
    const result = await checker.checkAuthGovernance(environmentOptions, h.dependencies);
    assert.equal(result.status, 'unverified');
    assert.equal(result.allowed, false);
    assert.equal(result.canContinue, false);
    assert.deepEqual(result.providers[0].blockedPolicies, []);
    assert.equal(result.providers[0].verificationErrors.length, 1);
    assert.match(result.message, /environment governance could not be verified/);
  }
});

test('environment scope preserves bounded retries, unavailable warnings, and known-block precedence', async () => {
  for (const statusCode of [403, 405, 501, 429, 503, 0]) {
    for (const blocked of [false, true]) {
      const h = harness({
        [FACEBOOK]: { ok: false, statusCode },
        ...(blocked ? { [ROOT]: { ok: true, statusCode: 200, body: 'None' } } : {}),
      }, {}, 'environment');
      const result = await checker.checkAuthGovernance(environmentOptions, h.dependencies);
      assert.equal(result.status, 'unverified');
      assert.equal(result.allowed, false);
      assert.equal(result.canContinue, !blocked);
      assert.equal(h.resolutions, 1);
      const attempts = h.calls.filter((call) => call.path.endsWith(`/${FACEBOOK}`)).length;
      assert.equal(attempts, [429, 503, 0].includes(statusCode) ? 3 : 1);
      assert.match(result.message, blocked ? /^Your administrator has restricted/ : /^Warning:.*environment governance/);
    }
  }
});

test('environment checks retain tenant, token, environment, and cloud guards', async () => {
  for (const overrides of [
    { tenantId: portalId }, { token: testToken(portalId) },
    { environmentId: portalId }, { apiHost: 'https://untrusted.example' },
  ]) {
    const h = harness({}, overrides, 'environment');
    const result = await checker.checkAuthGovernance(environmentOptions, h.dependencies);
    assert.equal(result.canContinue, false);
    assert.equal(result.status, 'unverified');
    assert.equal(h.calls.length, 0);
  }
  const h = harness({}, {}, 'environment');
  const result = await checker.checkAuthGovernance({ ...environmentOptions, tenantId: undefined }, h.dependencies);
  assert.equal(result.canContinue, false);
  assert.equal(h.resolutions, 0);
  assert.equal(h.calls.length, 0);
});

test('environment mode is explicit and cannot override a supplied host ID', async () => {
  for (const target of [
    { ...options, portalId: null },
    { ...options, scope: 'environment' },
    { ...environmentOptions, scope: 'invalid' },
  ]) {
    const h = harness();
    await assert.rejects(checker.checkAuthGovernance(target, h.dependencies), TypeError);
    assert.equal(h.resolutions, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('workforce Entra-only setup needs no governance target, authentication, or policy reads', async () => {
  const h = harness();
  h.dependencies.resolveContext = () => { assert.fail('Workforce Entra must not resolve governance authentication'); };
  const result = await checker.checkAuthGovernance({ providers: ['entra-id', 'entra-id'] }, h.dependencies);
  assert.equal(result.allowed, true);
  assert.equal(result.status, 'enabled');
  assert.deepEqual(result.policies, []);
  assert.deepEqual(result.providers.map((item) => item.provider), ['entra-id']);
  assert.deepEqual(result.providers[0].blockedPolicies, []);
  assert.deepEqual(result.providers[0].verificationErrors, []);
  assert.equal(result.tenantId, null);
  assert.equal(result.envId, null);
  assert.equal(result.portalId, null);
  assert.match(result.message, /Microsoft Entra ID setup is independent/);
  assert.doesNotMatch(result.message, /allowed by portal governance/);
  assert.equal(h.calls.length, 0);
});

test('retained workforce Entra does not add OIDC checks when adding Google', async () => {
  for (const response of [
    { ok: true, statusCode: 200, body: false },
    { ok: false, statusCode: 403 },
  ]) {
    const h = harness({ EnableProtocolOpenIdConnect: response });
    const result = await checker.checkAuthGovernance(
      { ...options, providers: ['entra-id', 'google'] }, h.dependencies
    );
    assert.equal(result.allowed, true);
    assert.deepEqual(result.providers.map((item) => item.provider), ['entra-id', 'google']);
    assert.deepEqual(h.calls.map(requestedPolicy), [ROOT, OAUTH, 'EnableIdpOAuthGoogle']);
    assert.equal(h.resolutions, 1);
  }
});

test('mixed batches preserve Entra exemption without bypassing governed restrictions or tenant guards', async () => {
  for (const [responses, contextOverrides, expected, reads] of [
    [{ [ROOT]: { ok: true, statusCode: 200, body: false } }, {}, 'blocked', 3],
    [{ EnableIdpOAuthGoogle: { ok: false, statusCode: 403 } }, {}, 'unverified', 3],
    [{}, { tenantId: portalId }, 'unverified', 0],
  ]) {
    const h = harness(responses, contextOverrides);
    const result = await checker.checkAuthGovernance(
      { ...options, providers: ['entra-id', 'google'] }, h.dependencies
    );
    assert.equal(result.allowed, false);
    assert.equal(result.status, expected);
    assert.equal(result.providers[0].allowed, true);
    assert.deepEqual(result.providers[0].blockedPolicies, []);
    assert.deepEqual(result.providers[0].verificationErrors, []);
    assert.equal(h.calls.length, reads);
    assert.doesNotMatch(result.message, /Microsoft Entra ID/);
  }
  const h = harness();
  await assert.rejects(checker.checkAuthGovernance({ providers: ['entra-id', 'google'] }, h.dependencies), TypeError);
  assert.equal(h.resolutions, 0);
  assert.equal(h.calls.length, 0);
});

test('Entra External ID remains governed as OIDC alongside exempt workforce Entra', async () => {
  for (const policy of [ROOT, 'EnableProtocolOpenIdConnect']) {
    const h = harness({ [policy]: { ok: true, statusCode: 200, body: false } });
    const result = await checker.checkAuthGovernance(
      { ...options, providers: ['entra-id', 'oidc'] }, h.dependencies
    );
    assert.equal(result.status, 'blocked');
    assert.equal(result.providers[0].allowed, true);
    assert.equal(result.providers[1].allowed, false);
    assert.deepEqual(result.providers[1].blockedPolicies.map((item) => item.policy), [policy]);
    assert.deepEqual(h.calls.map(requestedPolicy), [ROOT, 'EnableProtocolOpenIdConnect']);
  }
});

for (const [provider, policies] of Object.entries(providerPolicies)) {
  test(`${provider} reads only its complete dependency chain`, async () => {
    const h = harness();
    const result = await checker.checkAuthGovernance({ ...options, providers: [provider] }, h.dependencies);
    assert.equal(result.allowed, true);
    assert.deepEqual(h.calls.map(requestedPolicy), policies);
    assert.equal(h.resolutions, 1);
    for (const call of h.calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.context.environmentId, envId);
      assert.strictEqual(call.context, h.context);
      assert.equal(call.body, undefined);
    }
  });

  test(`${provider} is blocked when any required policy is disabled`, async () => {
    for (const policy of policies) {
      const h = harness({ [policy]: { ok: true, statusCode: 200, body: false } });
      const result = await checker.checkAuthGovernance({ ...options, providers: [provider] }, h.dependencies);
      assert.equal(result.allowed, false);
      assert.equal(result.status, 'blocked');
      assert.deepEqual(result.providers[0].blockedPolicies.map((item) => item.policy), [policy]);
      assert.equal(result.message.split('\n\n')[0],
        `Your administrator has restricted the use of ${result.providers[0].blockedPolicies[0].label} for this website. Contact your administrator if you need this setting enabled.`);
    }
  });
}

test('Facebook messages list all and only disabled requirements for every combination', async () => {
  const policies = [ROOT, OAUTH, FACEBOOK];
  for (let mask = 1; mask < 8; mask++) {
    const disabled = policies.filter((_, index) => mask & (1 << index));
    const responses = Object.fromEntries(disabled.map((policy) => [policy, { ok: true, statusCode: 200, body: false }]));
    const result = await checker.checkAuthGovernance(options, harness(responses).dependencies);
    const message = result.message;
    assert.equal(result.status, 'blocked');
    assert.equal(message.split('\n\n')[0],
      `Your administrator has restricted the use of ${result.providers[0].blockedPolicies.map((item) => item.label).join(', ')} for this website. Contact your administrator if you need this setting enabled.`);
    assert.doesNotMatch(message, /Enabled requirements|Disabled requirements|https:|Manage >|Once updated/);
    assert.match(message, /read-only check made no provider settings or login-page changes/);
    for (const policy of policies) assert.ok(!message.includes(policy));
    assert.deepEqual(result.providers[0].blockedPolicies.map((item) => item.policy), disabled);
  }
});

test('OIDC blocker omits supplementary guidance but retains structured policy states', async () => {
  const policy = 'EnableProtocolOpenIdConnect';
  const result = await checker.checkAuthGovernance(
    { ...options, providers: ['oidc'] },
    harness({ [policy]: { ok: true, statusCode: 200, body: false } }).dependencies
  );
  assert.equal(result.message,
    'Your administrator has restricted the use of OpenID Connect protocol for this website. Contact your administrator if you need this setting enabled.\n\n' +
    'This read-only check made no provider settings or login-page changes.');
  assert.deepEqual(result.policies.map((item) => [item.policy, item.state]), [[ROOT, 'enabled'], [policy, 'disabled']]);
});

test('sovereign blockers omit admin links and configuration navigation', async () => {
  for (const apiHost of new Set(Object.values(CLOUD_TO_API).filter((host) => host !== CLOUD_TO_API.Public))) {
    const h = harness({ [FACEBOOK]: { ok: true, statusCode: 200, body: false } }, {
      apiHost, baseUrl: `${apiHost}/powerpages/environments/${envId}`,
    });
    const result = await checker.checkAuthGovernance(options, h.dependencies);
    assert.equal(result.status, 'blocked');
    assert.doesNotMatch(result.message, /https:|Manage >/);
  }
});

test('batch starts all unique parent/child reads in parallel with one context', { timeout: 3000 }, async () => {
  const h = harness();
  const pending = [];
  h.dependencies.request = (args) => {
    h.calls.push(args);
    return new Promise((resolve) => pending.push(resolve));
  };
  const promise = checker.checkAuthGovernance({ ...options, providers: ['facebook', 'google', 'facebook'] }, h.dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls.map(requestedPolicy), [ROOT, OAUTH, FACEBOOK, 'EnableIdpOAuthGoogle']);
  assert.equal(h.resolutions, 1);
  for (const resolve of pending) resolve({ ok: true, statusCode: 200, body: true });
  const result = await promise;
  assert.equal(result.allowed, true);
  assert.deepEqual(result.providers.map((item) => item.provider), ['facebook', 'google']);
});

test('reads are fresh for each invocation, never persistently cached', async () => {
  const responses = {};
  const h = harness(responses);
  assert.equal((await checker.checkAuthGovernance(options, h.dependencies)).allowed, true);
  responses[ROOT] = { ok: true, statusCode: 200, body: false };
  assert.equal((await checker.checkAuthGovernance(options, h.dependencies)).status, 'blocked');
  assert.equal(h.calls.length, 6);
  assert.equal(h.resolutions, 2);
});

test('only boolean and case-insensitive text boolean primitives are accepted', async () => {
  for (const [body, status] of [
    [true, 'enabled'], [false, 'blocked'], ['true', 'enabled'], [' false\n', 'blocked'],
    ['True', 'enabled'], ['False', 'blocked'], [' \tTRUE\r\n', 'enabled'], ['fAlSe', 'blocked'],
  ]) {
    const result = await checker.checkAuthGovernance(options, harness({ [FACEBOOK]: { ok: true, statusCode: 200, body } }).dependencies);
    assert.equal(result.status, status);
  }
  for (const body of [null, undefined, 0, 1, '', '"true"', '"True"', 'true false', 'true\nfalse', 'Enabled', 'All', 'None',
    'Include', 'Exclude', {}, [], { enabled: true }, { value: true }, { IncludedSites: [portalId] }]) {
    const result = await checker.checkAuthGovernance(options, harness({ [FACEBOOK]: { ok: true, statusCode: 200, body } }).dependencies);
    assert.equal(result.status, 'unverified');
    assert.equal(result.allowed, false);
    assert.equal(result.providers[0].blockedPolicies.length, 0);
    assert.match(result.message, /Facebook setup stopped because portal governance could not be verified/);
    assert.equal(result.providers[0].verificationErrors[0].error.code, 'UnknownResponse');
  }
});

test('HTTP, permission, timeout, and thrown failures are unverified and do not disclose raw errors', async () => {
  const failures = [0, 400, 401, 403, 404, 429, 500, 503].map((statusCode) => ({
    ok: false, statusCode, body: { token: 'PRIVATE_TEST_TOKEN' },
    error: { code: 'PRIVATE_TEST_TOKEN', message: 'PRIVATE_TEST_TOKEN' },
  }));
  failures.push(new Error('PRIVATE_TEST_TOKEN'), null, {}, { ok: true, statusCode: 404, body: true });
  for (const failure of failures) {
    const h = harness({ [FACEBOOK]: failure });
    const result = await checker.checkAuthGovernance(options, h.dependencies);
    assert.equal(result.status, 'unverified');
    assert.equal(result.allowed, false);
    assert.equal(result.providers[0].blockedPolicies.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_TOKEN/);
    assert.doesNotMatch(result.message, /allow this portal|manage\/portals\/settings/);
  }
});

test('transient reads recover with bounded backoff without repeating successful parents or resolving auth again', async () => {
  for (const statusCode of [0, 429, 500, 502, 503, 504, 599]) {
    const h = harness();
    const waits = [];
    let attempts = 0;
    h.dependencies.sleep = async (ms) => { waits.push(ms); };
    h.dependencies.request = async (args) => {
      h.calls.push(args);
      if (requestedPolicy(args) === FACEBOOK && ++attempts < 3) return { ok: false, statusCode };
      return { ok: true, statusCode: 200, body: true };
    };
    const result = await checker.checkAuthGovernance(options, h.dependencies);
    assert.equal(result.status, 'enabled');
    assert.equal(result.allowed, true);
    assert.equal(result.canContinue, true);
    assert.deepEqual(waits, [500, 1000]);
    assert.equal(h.calls.filter((call) => requestedPolicy(call) === FACEBOOK).length, 3);
    assert.equal(h.calls.filter((call) => requestedPolicy(call) === ROOT).length, 1);
    assert.equal(h.calls.filter((call) => requestedPolicy(call) === OAUTH).length, 1);
    assert.equal(h.resolutions, 1);
  }
});

test('exhausted transient reads warn and continue without claiming policy approval', async () => {
  for (const statusCode of [0, 429, 500, 503]) {
    const h = harness({ [FACEBOOK]: { ok: false, statusCode } });
    const waits = [];
    h.dependencies.sleep = async (ms) => { waits.push(ms); };
    const result = await checker.checkAuthGovernance(options, h.dependencies);
    assert.equal(result.status, 'unverified');
    assert.equal(result.allowed, false);
    assert.equal(result.canContinue, true);
    assert.equal(result.providers[0].canContinue, true);
    assert.equal(result.providers[0].verificationErrors[0].error.code, 'ReadUnavailable');
    assert.equal(h.calls.filter((call) => requestedPolicy(call) === FACEBOOK).length, 3);
    assert.deepEqual(waits, [500, 1000]);
    assert.match(result.message, /Warning:.*could not be verified/);
    assert.match(result.message, /Continue setup with this warning/);
    assert.match(result.message, /runtime governance still applies/);
    assert.match(result.message, /sign-in methods may not work/);
    assert.doesNotMatch(result.message, /setup stopped|setup is allowed/);
  }
});

test('403 and unsupported endpoint statuses warn without retry; unexplained 404 and other failures still stop', async () => {
  for (const [response, canContinue] of [
    [{ ok: false, statusCode: 403 }, true],
    [{ ok: false, statusCode: 405 }, true],
    [{ ok: false, statusCode: 501 }, true],
    [{ ok: false, statusCode: 401 }, false],
    [{ ok: false, statusCode: 404 }, false],
    [{ ok: false, statusCode: 400 }, false],
    [{ ok: false, statusCode: 0, error: { code: 'ContextError' } }, false],
    [{ ok: false, statusCode: '503' }, false],
    [{ ok: true, statusCode: 503 }, false],
    [{ ok: true, statusCode: 200, body: { enabled: true } }, false],
    [null, false], [{}, false], [new Error('PRIVATE_TEST_TOKEN'), false],
  ]) {
    const h = harness({ [FACEBOOK]: response });
    h.dependencies.sleep = async () => { assert.fail('This failure must not be retried'); };
    const result = await checker.checkAuthGovernance(options, h.dependencies);
    assert.equal(result.status, 'unverified');
    assert.equal(result.allowed, false);
    assert.equal(result.canContinue, canContinue);
    assert.equal(h.calls.length, 3);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_TOKEN/);
  }
});

test('recognized thrown network errors retry but never disclose raw exception details', async () => {
  const failure = new Error('PRIVATE_TEST_TOKEN');
  failure.code = 'ETIMEDOUT';
  const h = harness({ [FACEBOOK]: failure });
  const result = await checker.checkAuthGovernance(options, h.dependencies);
  assert.equal(result.canContinue, true);
  assert.equal(result.allowed, false);
  assert.equal(h.calls.filter((call) => requestedPolicy(call) === FACEBOOK).length, 3);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_TOKEN/);
});

test('known restrictions or non-continuable errors prevent warning-based continuation across the batch', async () => {
  for (const otherResponse of [
    { ok: true, statusCode: 200, body: false },
    { ok: false, statusCode: 404 },
    { ok: true, statusCode: 200, body: 'not-a-boolean' },
  ]) {
    const h = harness({
      [FACEBOOK]: { ok: false, statusCode: 503 },
      EnableIdpOAuthGoogle: otherResponse,
    });
    const result = await checker.checkAuthGovernance(
      { ...options, providers: ['facebook', 'google', 'entra-id'] }, h.dependencies
    );
    assert.equal(result.status, 'unverified');
    assert.equal(result.providers[0].canContinue, true);
    assert.equal(result.canContinue, false);
    assert.doesNotMatch(result.message, /Continue setup with this warning/);
  }
  const h = harness();
  let attempts = 0;
  h.dependencies.request = async (args) => {
    if (requestedPolicy(args) === FACEBOOK) {
      return ++attempts === 1 ? { ok: false, statusCode: 503 } : { ok: true, statusCode: 200, body: false };
    }
    return { ok: true, statusCode: 200, body: true };
  };
  const result = await checker.checkAuthGovernance(options, h.dependencies);
  assert.equal(result.status, 'blocked');
  assert.equal(result.canContinue, false);
  assert.equal(attempts, 2);
});

test('mixed selections stop as a batch and retain enabled, blocked, and unverified diagnostics', async () => {
  const h = harness({
    [FACEBOOK]: { ok: true, statusCode: 200, body: false },
    EnableIdpOAuthGoogle: { ok: false, statusCode: 403 },
  });
  const result = await checker.checkAuthGovernance({ ...options, providers: ['facebook', 'google', 'oidc'] }, h.dependencies);
  assert.equal(result.allowed, false);
  assert.equal(result.status, 'unverified');
  assert.deepEqual(result.providers.map((item) => item.status), ['blocked', 'unverified', 'enabled']);
  assert.ok(result.message.startsWith('Your administrator has restricted the use of Facebook OAuth for this website.'));
  assert.doesNotMatch(result.message, /setup is allowed/);
});

test('known disabled parents are retained when another read cannot be verified', async () => {
  const h = harness({
    [ROOT]: { ok: true, statusCode: 200, body: false },
    [FACEBOOK]: { ok: false, statusCode: 403 },
  });
  const result = await checker.checkAuthGovernance(options, h.dependencies);
  assert.equal(result.status, 'unverified');
  const restriction = 'Your administrator has restricted the use of External authentication for this website. Contact your administrator if you need this setting enabled.';
  assert.equal(result.message.split('\n\n')[0], restriction);
  assert.equal(result.providers[0].message, result.message);
  assert.match(result.message, /Facebook OAuth.*HTTP 403/);
  assert.doesNotMatch(result.message, /Also disabled|\(EnableExternalAuthProviders\)/);
});

test('denied batch summaries never start with an enabled provider or an unknown policy', async () => {
  for (const providers of [
    ['google', 'facebook', 'oidc'], ['oidc', 'google', 'facebook'], ['facebook', 'oidc', 'google'],
  ]) {
    for (const oidcResponse of [{ ok: true, statusCode: 200, body: true }, { ok: false, statusCode: 403 }]) {
      const h = harness({
        [FACEBOOK]: { ok: true, statusCode: 200, body: false },
        EnableProtocolOpenIdConnect: oidcResponse,
      });
      const result = await checker.checkAuthGovernance({ ...options, providers }, h.dependencies);
      assert.equal(result.allowed, false);
      assert.equal(result.status, oidcResponse.ok ? 'blocked' : 'unverified');
      assert.equal(result.message.split('\n\n')[0],
        'Your administrator has restricted the use of Facebook OAuth for this website. Contact your administrator if you need this setting enabled.');
      assert.doesNotMatch(result.message, /setup is allowed|Enabled requirements|https:/);
      assert.equal(result.providers.find((item) => item.provider === 'google').allowed, true);
      if (!oidcResponse.ok) assert.match(result.message, /OpenID Connect protocol.*HTTP 403/);
    }
  }
});

test('shared disabled parents appear once in batch messages and unknown-only batches do not claim restrictions', async () => {
  const disabled = harness({ [ROOT]: { ok: true, statusCode: 200, body: false } });
  const result = await checker.checkAuthGovernance({ ...options, providers: ['google', 'facebook'] }, disabled.dependencies);
  assert.equal(result.status, 'blocked');
  assert.equal((result.message.match(/External authentication/g) || []).length, 1);
  const unknown = harness({ [FACEBOOK]: { ok: false, statusCode: 403 } });
  const unverified = await checker.checkAuthGovernance({ ...options, providers: ['google', 'facebook'] }, unknown.dependencies);
  assert.equal(unverified.status, 'unverified');
  assert.doesNotMatch(unverified.message, /Your administrator has restricted|setup is allowed/);
  assert.match(unverified.message, /Facebook OAuth.*HTTP 403/);
});

test('invalid target identities and providers fail before resolving auth or reading policies', async () => {
  for (const changes of [
    { tenantId: 'invalid' }, { tenantId: true }, { tenantId: '00000000-0000-0000-0000-000000000000' },
    { envId: undefined }, { envId: 'bad' }, { portalId: true }, { portalId: '00000000-0000-0000-0000-000000000000' },
    { portalId: websiteRecordId }, { websiteRecordId: 'bad' }, { providers: [] }, { providers: ['unknown'] },
    { providers: ['__proto__'] }, { providers: 'facebook' }, { providers: [null] },
  ]) {
    const h = harness();
    await assert.rejects(checker.checkAuthGovernance({ ...options, ...changes }, h.dependencies), TypeError);
    assert.equal(h.resolutions, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('context errors and environment/cloud/base URL mismatches stop before reads', async () => {
  for (const changes of [
    { error: 'PRIVATE_TEST_TOKEN' }, { token: '' }, { environmentId: portalId },
    { apiHost: 'https://api.preprod.powerplatform.com' },
    { baseUrl: `${CLOUD_TO_API.Public}/powerpages/environments/${portalId}` },
    { baseUrl: 'https://untrusted.example' },
  ]) {
    const h = harness({}, changes);
    const result = await checker.checkAuthGovernance(options, h.dependencies);
    assert.equal(result.status, 'unverified');
    assert.equal(result.canContinue, false);
    assert.equal(h.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_TOKEN/);
  }
  const h = harness();
  h.dependencies.resolveContext = () => { throw new Error('PRIVATE_TEST_TOKEN'); };
  const result = await checker.checkAuthGovernance(options, h.dependencies);
  assert.equal(result.status, 'unverified');
  assert.equal(h.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_TOKEN/);
});

test('explicit contexts reuse auth and preserve each sovereign cloud host', async () => {
  for (const apiHost of Object.values(CLOUD_TO_API)) {
    const h = harness({}, { apiHost, baseUrl: `${apiHost}/powerpages/environments/${envId}` });
    const result = await checker.checkAuthGovernance({ ...options, context: h.context }, h.dependencies);
    assert.equal(result.allowed, true);
    assert.equal(h.resolutions, 0);
    assert.ok(h.calls.every((call) => call.context.apiHost === apiHost));
  }
});

test('matching tenants accept case differences without weakening the dependency checks', async () => {
  const h = harness({}, { tenantId: tenantId.toUpperCase(), token: testToken(tenantId.toUpperCase()) });
  const result = await checker.checkAuthGovernance({ ...options, tenantId: tenantId.toUpperCase() }, h.dependencies);
  assert.equal(result.allowed, true);
  assert.equal(h.calls.length, 3);
  assert.equal(h.resolutions, 1);
});

test('missing expected owning tenant stops before authentication and never defaults to the current tenant', async () => {
  for (const expected of [undefined, null, '']) {
    const h = harness();
    const result = await checker.checkAuthGovernance({ ...options, tenantId: expected }, h.dependencies);
    assert.equal(result.allowed, false);
    assert.equal(result.status, 'unverified');
    assert.match(result.message, /portal owning tenant ID is required/);
    assert.equal(result.canContinue, false);
    assert.equal(h.resolutions, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('account/token tenants must both be available and match the confirmed owner before any reads', async () => {
  for (const overrides of [
    { tenantId: undefined }, { tenantId: null }, { tenantId: '' }, { tenantId: true },
    { tenantId: 'malformed' }, { tenantId: portalId },
    { token: testToken(portalId) }, { token: testToken(undefined) }, { token: testToken('malformed') },
    { token: 'opaque-token' }, { token: 'header.not-json.signature' },
  ]) {
    const h = harness({}, overrides);
    const result = await checker.checkAuthGovernance(options, h.dependencies);
    assert.equal(result.status, 'unverified');
    assert.equal(result.allowed, false);
    assert.equal(result.providers[0].blockedPolicies.length, 0);
    assert.equal(h.calls.length, 0);
    assert.equal(h.resolutions, 1);
    assert.equal(result.canContinue, false);
    assert.match(result.message, /tenant/);
    assert.match(result.message, /No governance requests were sent/);
    assert.ok(!JSON.stringify(result).includes(String(h.context.token)));
  }
});

test('every governed provider applies the same missing/mismatched tenant guard', async () => {
  for (const provider of Object.keys(providerPolicies)) {
    for (const [target, overrides] of [
      [{ ...options, tenantId: undefined }, {}],
      [options, { tenantId: portalId }],
      [options, { tenantId: undefined }],
      [options, { token: testToken(portalId) }],
    ]) {
      const h = harness({}, overrides);
      const result = await checker.checkAuthGovernance({ ...target, providers: [provider] }, h.dependencies);
      assert.equal(result.allowed, false);
      assert.equal(result.canContinue, false);
      assert.equal(result.status, 'unverified');
      assert.doesNotMatch(result.message, /PRIVATE_TEST_TOKEN/);
      assert.equal(h.calls.length, 0);
    }
  }
});

test('CLI import/help/invalid-input paths are offline and import-safe', () => {
  const script = require.resolve('../check-auth-governance');
  const spawnOptions = {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: '1' },
  };
  const imported = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(script)})`], spawnOptions);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
  const help = spawnSync(process.execPath, [script, '--help'], spawnOptions);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Read-only, setup-time gate/);
  assert.match(help.stdout, /--tenantId/);
  const entra = spawnSync(process.execPath, [script, '--providers', 'entra-id'], spawnOptions);
  assert.equal(entra.status, 0, entra.stderr);
  const entraResult = JSON.parse(entra.stdout);
  assert.equal(entraResult.allowed, true);
  assert.deepEqual(entraResult.policies, []);
  assert.match(entraResult.message, /Microsoft Entra ID setup is independent/);
  const invalid = spawnSync(process.execPath, [script, '--envId', 'invalid', '--providers', 'facebook'], spawnOptions);
  assert.equal(invalid.status, 3);
  assert.match(invalid.stderr, /envId must be/);
  const missingTenant = spawnSync(process.execPath, [
    script, '--envId', envId, '--portalId', portalId, '--providers', 'facebook',
  ], spawnOptions);
  assert.equal(missingTenant.status, 2, missingTenant.stderr);
  assert.equal(JSON.parse(missingTenant.stdout).status, 'unverified');
  assert.match(JSON.parse(missingTenant.stdout).message, /portal owning tenant ID is required/);
  const invalidTenant = spawnSync(process.execPath, [
    script, '--tenantId', 'invalid', '--envId', envId, '--portalId', portalId, '--providers', 'facebook',
  ], spawnOptions);
  assert.equal(invalidTenant.status, 3);
  assert.match(invalidTenant.stderr, /tenantId.*must be/);
});

async function invokeCli(h, flags, emit = (result) => JSON.parse(JSON.stringify(result))) {
  const script = require.resolve('../check-auth-governance');
  const realRequire = createRequire(script);
  let output;
  let stderr = '';
  let completion;
  const sandbox = {
    module: { exports: {} },
    process: {
      argv: ['node', script, ...flags],
      stderr: { write(text) { stderr += text; } },
    },
    require(name) {
      if (name === './lib/power-platform-api') {
        return {
          ...realRequire(name),
          resolveContext: h.dependencies.resolveContext,
          request: h.dependencies.request,
          emitJson(result) { output = emit(result); },
          runCli(_module, main) { completion = main(); },
        };
      }
      if (name.includes('manage-governance')) throw new Error('Checker must not load archived governance modules');
      if (name === 'node:timers/promises') return { setTimeout: h.dependencies.sleep };
      return realRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), sandbox, { filename: script });
  await completion;
  return { output, stderr, exitCode: sandbox.process.exitCode };
}

test('environment CLI routes explicit scope without portalId and preserves decision exit codes', async () => {
  for (const [response, exitCode, canContinue] of [
    [{ ok: true, statusCode: 200, body: 'Exclude' }, 0, true],
    [{ ok: true, statusCode: 200, body: 'Include' }, 1, false],
    [{ ok: false, statusCode: 404 }, 2, false],
    [{ ok: false, statusCode: 403 }, 2, true],
  ]) {
    const h = harness({ [FACEBOOK]: response }, {}, 'environment');
    const result = await invokeCli(h, [
      '--scope', 'environment', '--tenantId', tenantId, '--envId', envId, '--providers', 'facebook',
    ]);
    assert.equal(result.exitCode, exitCode, result.stderr);
    assert.equal(result.output.scope, 'environment');
    assert.equal(result.output.portalId, null);
    assert.equal(result.output.canContinue, canContinue);
    assert.equal(h.resolutions, 1);
    assert.ok(h.calls.every((call) => call.path.startsWith('/governance/')));
    assert.doesNotMatch(JSON.stringify(result.output), /PRIVATE_TEST_TOKEN/);
  }
  const h = harness();
  const invalid = await invokeCli(h, [
    '--scope', 'environment', '--tenantId', tenantId, '--envId', envId,
    '--portalId', portalId, '--providers', 'facebook',
  ]);
  assert.equal(invalid.exitCode, 3);
  assert.match(invalid.stderr, /do not supply portalId/);
  assert.equal(h.resolutions, 0);
  assert.equal(h.calls.length, 0);
});

test('CLI usage errors exit 3 without claiming a governance restriction or sending requests', async () => {
  for (const flags of [
    [], ['--providers', 'unsupported'],
    ['--envId', envId, '--portalId', websiteRecordId, '--websiteRecordId', websiteRecordId, '--providers', 'facebook'],
  ]) {
    const h = harness();
    const { output, stderr, exitCode } = await invokeCli(h, flags);
    assert.equal(exitCode, 3);
    assert.equal(output, undefined);
    assert.match(stderr, /Select one or more providers|Power Platform host ID/);
    assert.doesNotMatch(stderr, /Your administrator has restricted/);
    assert.equal(h.resolutions, 0);
    assert.equal(h.calls.length, 0);
  }
});

test('CLI unexpected failures exit 3 and redact raw exception messages', async () => {
  for (const error of [new Error('PRIVATE_TEST_TOKEN'), new TypeError('PRIVATE_TEST_TOKEN')]) {
    const { output, stderr, exitCode } = await invokeCli(harness(), ['--providers', 'entra-id'], () => { throw error; });
    assert.equal(exitCode, 3);
    assert.equal(output, undefined);
    assert.match(stderr, /check failed unexpectedly/);
    assert.doesNotMatch(stderr, /PRIVATE_TEST_TOKEN|Your administrator has restricted/);
  }
});

test('CLI emits the complete decision and exits 0/1/2 for enabled/blocked/unverified', async () => {
  for (const [response, status, exitCode, canContinue] of [
    [{ ok: true, statusCode: 200, body: true }, 'enabled', 0, true],
    [{ ok: true, statusCode: 200, body: false }, 'blocked', 1, false],
    [{ ok: false, statusCode: 404 }, 'unverified', 2, false],
    [{ ok: false, statusCode: 403 }, 'unverified', 2, true],
    [{ ok: false, statusCode: 503 }, 'unverified', 2, true],
  ]) {
    const h = harness({ [FACEBOOK]: response });
    const { output, exitCode: actualExit } = await invokeCli(h, [
      '--tenantId', tenantId, '--envId', envId, '--portalId', portalId, '--providers', 'facebook',
    ]);
    assert.equal(actualExit, exitCode);
    assert.equal(output.status, status);
    assert.equal(output.allowed, exitCode === 0);
    assert.equal(output.canContinue, canContinue);
    assert.equal(output.envId, envId);
    assert.equal(output.tenantId, tenantId);
    assert.equal(output.portalId, portalId);
    assert.equal(output.policies.length, 3);
    assert.equal(h.resolutions, 1);
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE_TEST_TOKEN/);
  }
});

test('CLI denied batches use restriction-first messages and retain fail-closed exit codes', async () => {
  for (const [responses, providers, exitCode, label] of [
    [{ [FACEBOOK]: { ok: true, statusCode: 200, body: false } }, 'google,facebook', 1, 'Facebook OAuth'],
    [{ [ROOT]: { ok: true, statusCode: 200, body: false }, [FACEBOOK]: { ok: false, statusCode: 403 } },
      'facebook', 2, 'External authentication'],
  ]) {
    const { output, exitCode: actualExit } = await invokeCli(harness(responses), [
      '--tenantId', tenantId, '--envId', envId, '--portalId', portalId, '--providers', providers,
    ]);
    assert.equal(actualExit, exitCode);
    assert.equal(output.allowed, false);
    assert.equal(output.canContinue, false);
    assert.equal(output.message.split('\n\n')[0],
      `Your administrator has restricted the use of ${label} for this website. Contact your administrator if you need this setting enabled.`);
    assert.doesNotMatch(output.message, /setup is allowed|Also disabled/);
    if (exitCode === 2) assert.match(output.message, /HTTP 403/);
    else assert.equal(output.providers[0].allowed, true);
  }
});

test('CLI tenant mismatch/unavailability exits 2 with zero governance requests', async () => {
  for (const overrides of [{ tenantId: portalId }, { tenantId: undefined }, { token: testToken(portalId) }]) {
    const h = harness({}, overrides);
    const { output, exitCode } = await invokeCli(h, [
      '--tenantId', tenantId, '--envId', envId, '--portalId', portalId, '--providers', 'facebook,google',
    ]);
    assert.equal(exitCode, 2);
    assert.equal(output.allowed, false);
    assert.equal(output.status, 'unverified');
    assert.equal(output.tenantId, tenantId);
    assert.equal(output.canContinue, false);
    assert.equal(h.calls.length, 0);
    assert.ok(output.providers.every((provider) => provider.status === 'unverified'));
    assert.ok(!JSON.stringify(output).includes(h.context.token));
  }
});

test('setup-auth checks activated targets before walkthroughs and after final deployment selection', () => {
  const { skill, reference, deploySkill } = workflowSources();
  const selection = skill.indexOf('**Before provider-specific follow-ups:**');
  assert.ok(selection > 0 && selection < skill.indexOf('**For "Facebook"**'));
  const initial = skill.slice(selection, skill.indexOf('**Blocked-message presentation:**'));
  assert.match(initial, /smart-inference and `keep-only`/);
  assert.match(initial, /initial.*check once/);
  assert.match(initial, /reuse an initial result already obtained for the same unchanged context/);
  const deploy = skill.slice(skill.indexOf('#### 8.4 Ask to Deploy'), skill.indexOf('#### 8.5'));
  assert.match(deploy, /Invoke `\/deploy-site` with the complete provider selection and retained activation\/target context/);
  assert.match(deploy, /after final environment confirmation and before upload/);
  assert.match(deploy, /Rerun the shared preflight there, not against an environment that may change/);
  assert.match(deploy, /Deploy only when batch `canContinue: true`/);
  const confirm = deploySkill.slice(deploySkill.indexOf('## Phase 3: Confirm Environment'),
    deploySkill.indexOf('## Phase 4:'));
  assert.ok(confirm.indexOf('**Conditional setup-auth handoff:**') > confirm.indexOf('Verify the switch'));
  assert.match(confirm, /after\s+the final environment confirmation and before any upload \(including retries\)/);
  assert.match(confirm, /never reuse another environment's host ID or\s+initial policy result/);
  assert.match(confirm, /Workforce Entra-only and unrelated standalone deployments do\s+not acquire this governance gate/);
  assert.match(reference, /Stop the entire selected batch before mutation/);
  assert.match(reference, /does not invoke or re-enable/);
  assert.match(reference, /not a visitor-side runtime filter/);
  assert.match(skill, /pass `--tenantId` on every check/);
  assert.match(reference, /--tenantId "<TENANT_ID>"/);
  assert.match(reference, /Do not infer it from the current Azure CLI\s+account/);
  assert.doesNotMatch(reference, /\*\*Known gap:\*\*/);
});

test('setup-auth consistently distinguishes exempt workforce Entra from governed Entra External ID', () => {
  const root = path.resolve(__dirname, '..', '..');
  const skill = fs.readFileSync(path.join(root, 'skills', 'setup-auth', 'SKILL.md'), 'utf8');
  const reference = fs.readFileSync(path.join(root, 'skills', 'setup-auth', 'references', 'governance-preflight.md'), 'utf8');
  const principles = skill.slice(skill.indexOf('## Core Principles'), skill.indexOf('**Initial request:**'));
  assert.match(principles, /Skip all governance preflights\/rechecks and their target\/tenant\/Azure CLI prerequisites for Entra-only setup/);
  assert.match(principles, /Microsoft Entra External ID is distinct and remains governed as OIDC/);
  assert.match(principles, /This exemption applies to every gate below/);
  const selection = skill.slice(skill.indexOf('**Before provider-specific follow-ups:**'), skill.indexOf('**Blocked-message presentation:**'));
  assert.match(selection, /workforce Entra -> exempt `entra-id`; Entra External ID -> governed `oidc`/);
  assert.match(reference, /workforce Microsoft Entra ID -> `entra-id` \(no required policies\)/);
  assert.match(reference, /legacy `Authentication\/OpenIdConnect\/AzureAD\/\*` settings/);
  assert.match(reference, /Preserve the existing Entra settings and normal\s+auth service, claims mapping, login UI, and role-based UI behavior/);
  assert.doesNotMatch(reference, /including Entra External ID and workforce Entra/);
});

test('generation stages reuse the initial decision instead of repeating reads and retain warnings', () => {
  const { skill, reference } = workflowSources();
  const stages = [
    ['#### 2.1.2', '## Phase 3:'],
    ['## Phase 3:', '## Phase 4:'],
    ['## Phase 5:', '## Phase 6:'],
    ['#### 8.1 Create Site Settings', '#### 8.2'],
  ];
  for (const [startHeading, endHeading] of stages) {
    const start = skill.indexOf(startHeading);
    const end = skill.indexOf(endHeading, start + startHeading.length);
    assert.ok(start >= 0 && end > start, `${startHeading} must have bounded content`);
    const section = skill.slice(start, end);
    assert.match(section, /Reuse the initial governance preflight result/);
    assert.match(section, /unavailable-read warning/);
    assert.match(section, /Check lifecycle for context invalidation/);
    assert.doesNotMatch(section, /Rerun the governance preflight|rerun it immediately before/);
  }
  assert.match(reference, /three total\s+attempts/);
  assert.match(reference, /500 ms.*1000 ms/);
  assert.match(reference, /Do not add a separate continuation prompt/);
  assert.match(reference, /Do not infer\s+that a 404 means an unsupported endpoint/);
  assert.match(reference, /Use the batch `canContinue` and `message`/);
  assert.doesNotMatch(skill, /stop on any non-allowed result|Stop on blocked\/unverified|If blocked\/unverified/);
});

test('two-check lifecycle invalidates changed or uncertain context and preserves artifacts on a late stop', () => {
  const { skill, reference } = workflowSources();
  const start = reference.indexOf('## Check lifecycle');
  const end = reference.indexOf('## Reads and decisions', start);
  assert.ok(start >= 0 && end > start);
  const lifecycle = reference.slice(start, end);
  assert.match(lifecycle, /two check points/);
  assert.match(lifecycle, /Initial check:.*After selecting all providers, before provider-specific/);
  assert.match(lifecycle, /Deployment check:.*After deployment consent, pass the complete provider/);
  assert.match(lifecycle, /After its final\s+environment confirmation and before upload, run a fresh preflight/);
  assert.match(lifecycle, /Never reuse the initial result for deployment/);
  assert.match(lifecycle, /If the user does not deploy, no deployment check is needed/);
  assert.match(lifecycle, /smart-inference, keep-only, and normal selection paths share this same initial\s+check/);
  assert.match(lifecycle, /Do not repeat inventory, CLI authentication resolution,\s+or policy reads solely because a phase changes, a consent prompt is answered,\s+or an ordinary pause\/resume occurs/);
  assert.match(lifecycle, /Retain `canContinue`, `allowed`, and the warning/);
  assert.match(lifecycle, /when activation status changes or when the target, owning tenant,\s+account\/cloud context, or selected provider instances change/);
  assert.match(lifecycle, /if the result or context is missing or uncertain, recheck instead/);
  assert.match(lifecycle, /Do not persist tokens, create an on-disk cache, or reuse results across\s+independent setup runs/);
  assert.match(lifecycle, /Workforce Entra-only setup remains exempt from both check points/);
  assert.match(lifecycle, /preserve all\s+earlier local artifacts and report what was already changed/);
  assert.match(lifecycle, /Do not deploy, automatically roll back, or claim that the\s+whole run made no changes/);
  assert.match(skill, /retain its result for the converging Phase 2.1 path rather than checking again/);
  assert.doesNotMatch(reference, /immediately before each later mutation stage/);
});

test('governed-provider target instructions distinguish activation, failed discovery, and sign-in recovery', () => {
  const { skill, reference } = workflowSources();
  const prerequisites = skill.slice(skill.indexOf('> **Prerequisites:**'), skill.indexOf('## Workflow'));
  assert.match(prerequisites, /governance preflight needs a confirmed environment and PAC\/Azure CLI sign-in/);
  assert.match(prerequisites, /Deployment alone does not establish activation or a host `portalId`/);
  assert.match(prerequisites, /Workforce Entra-only setup is exempt/);
  const recovery = reference.slice(reference.indexOf('### Governed-provider prerequisites and recovery'),
    reference.indexOf('Run from the project'));
  assert.match(recovery, /Verify a previously obtained `portalId` without a matching activation receipt/);
  assert.match(recovery, /match the project's\s+`websiteRecordId` and deployed URL when available/);
  assert.match(recovery, /Successful, complete inventory has no matching host.*\/activate-site/);
  assert.match(recovery, /after activation, refresh inventory before retrying setup/);
  assert.match(recovery, /Inventory read fails, returns an error, or is partial\/incomplete.*do not claim the site is inactive/);
  assert.match(recovery, /Confirm pagination completed before concluding no host exists/);
  assert.match(recovery, /Multiple matching hosts or uncertain activation history.*HostIdentityUnresolved.*local preparation only/);
  assert.match(recovery, /Conflicting IDs\/URLs\/tenant\/environment\/cloud, or a known failed\/obsolete host.*Stop remote changes/);
  assert.match(recovery, /If PAC is not signed in/);
  assert.match(recovery, /If Azure CLI sign-in is missing/);
  assert.match(recovery, /Never switch accounts or environments automatically/);
  assert.match(recovery, /Workforce Entra-only setup skips this entire governance-specific prerequisite/);
  assert.match(recovery, /Do not\s+activate a site automatically/);
  assert.match(recovery, /warning-and-continue rule to bypass an unverified deployment\s+destination or a known target conflict/);
});

test('failed host discovery permits warned local preparation without weakening checker decisions', () => {
  const { skill, reference } = workflowSources();
  const discovery = reference.slice(reference.indexOf('### Discovery unavailable: local preparation only'),
    reference.indexOf("Run from the project's signed-in PAC environment:"));
  const outcome = discovery.match(/```json\s+([\s\S]*?)\s+```/);
  assert.ok(outcome, 'The workflow must retain an explicit discovery outcome');
  assert.deepEqual(JSON.parse(outcome[1]), {
    status: 'unverified', allowed: false, canContinue: true,
    reason: 'HostLookupUnavailable', continuation: 'local-only',
  });
  assert.match(discovery, /workflow decisions, not checker responses or a new CLI\s+mode/);
  assert.match(discovery, /Do not select environment scope merely because\s+discovery failed/);
  assert.match(discovery, /Use `HostIdentityUnresolved` instead\s+when no unique host or reliable activation history/);
  assert.match(discovery, /Never\s+trust partial inventory/);
  assert.match(discovery, /at most three\s+inventory attempts/);
  assert.match(discovery, /do not retry permissions, invalid pagination, or malformed\s+responses automatically/);
  assert.match(discovery, /Show this warning once before continuing/);
  assert.match(discovery, /only local settings\/code\/UI generation\s+and non-mutating guidance/);
  assert.match(discovery, /not\s+governance approval or permission for remote IdP provisioning, deployment, or\s+activation/);
  assert.match(discovery, /Never downgrade a verified restriction/);
  assert.match(discovery, /a checker's `canContinue: false` to this\s+outcome/);
  assert.match(skill, /Carry its discovery warning through\s+all local generation phases without repeatedly prompting or retrying discovery/);
  const provision = skill.slice(skill.indexOf('#### 2.1.2'), skill.indexOf('#### 2.2'));
  assert.match(provision, /An initial `continuation: "local-only"`/);
  assert.match(provision, /Defer configure-for-you\s+provisioning until target verification/);
});

test('deployment never reuses local-only permission and distinguishes unavailable inventory from unresolved destination', () => {
  const { reference, deploySkill } = workflowSources();
  const discovery = reference.slice(reference.indexOf('### Discovery unavailable: local preparation only'),
    reference.indexOf("Run from the project's signed-in PAC environment:"));
  assert.match(discovery, /discard the initial local-only continuation and retry discovery\s+after final environment selection/);
  assert.match(discovery, /verify the exact local website record in `pac pages list`/);
  assert.match(discovery, /Missing website records, failed destination verification,\s+multiple host matches, unresolved activation history, and known target conflicts\s+stop deployment, not local preparation/);
  assert.match(discovery, /deployment destination and\s+activation history are verified but only host inventory remains unavailable/);
  assert.match(discovery, /`canContinue: true` for this fresh deployment preflight/);
  assert.match(discovery, /Normal deployment consent is still required/);
  assert.match(discovery, /Apply actual\s+checker results unchanged/);
  const handoff = deploySkill.slice(deploySkill.indexOf('**Conditional setup-auth handoff:**'),
    deploySkill.indexOf('## Phase 4:'));
  assert.match(handoff, /Never reuse an\s+initial `continuation: "local-only"` as deployment approval/);
  assert.match(handoff, /Stop on unverified destination,\s+multiple host matches, unresolved history, known target conflicts/);
  assert.match(handoff, /Do not substitute environment governance for failed host\s+discovery or override a verified restriction/);
});

test('activated target resolution reuses only aligned receipts and falls back for missing host IDs', () => {
  const { reference } = workflowSources();
  const target = reference.slice(reference.indexOf('### Confirm the target'),
    reference.indexOf('Run from the project'));
  assert.match(target, /`docs\/alm\/last-activate.json`/);
  assert.match(target, /`websiteHostId`/);
  assert.match(target, /website record ID matches the local project, its environment ID\/URL matches\s+the confirmed target/);
  assert.match(target, /current `pac auth who` context is a connection check, not proof of where the\s+site was deployed/);
  assert.match(target, /use it as `portalId` without a\s+mandatory inventory read/);
  assert.match(target, /stale\/deleted host's\s+404 stops verification, not an environment-scope fallback/);
  assert.match(target, /If no usable host ID is available, confirm the intended environment explicitly/);
  assert.match(target, /Only a result without `error` establishes a complete inventory/);
});

test('never-activated targets confirm the PAC environment and use checked environment scope', () => {
  const { skill, reference, deploySkill } = workflowSources();
  const skip = reference.slice(reference.indexOf('**Confirmed never activated:**'),
    reference.indexOf('For both scopes, PAC'));
  assert.match(skip, /user confirms this project site has never\s+been activated and no conflicting activation evidence exists/);
  assert.match(skip, /check environment-level governance using\s+`--scope environment` without `--portalId`/);
  assert.match(skip, /There is no unchecked continuation/);
  assert.match(skip, /Missing receipts, missing IDs, unreachable URLs, and failed lookups do not prove/);
  const target = reference.slice(reference.indexOf('### Confirm the target'),
    reference.indexOf('Run from the project'));
  assert.match(target, /read `pac auth who` and present its\s+environment name, URL, and ID as a candidate/);
  assert.match(target, /same confirmation pattern\s+as `\/deploy-site`/);
  assert.match(target, /`pac org list`/);
  assert.match(target, /pac org select --environment/);
  assert.match(target, /Verify the exact\s+local website record ID is present in `pac pages list`/);
  const lifecycle = reference.slice(reference.indexOf('## Check lifecycle'),
    reference.indexOf('## Reads and decisions'));
  assert.match(lifecycle, /If the site has since been\s+activated, resolve its host and run the live portal check before upload/);
  assert.match(lifecycle, /Never reuse an environment-scope result after activation/);
  assert.match(skill, /Neither path bypasses governance or the normal consent gates/);
  assert.match(deploySkill, /For confirmed never-provisioned targets, run environment-level governance/);
  assert.doesNotMatch(skill, /not-checked|continue normal setup without a governance notice/);
});

// Keep these IDs aligned with the maker-facing 66-case plan. These cases run
// sequentially against injected reads, never by toggling a live portal policy.
async function numberedDecision(t, id, h, target, status, blocked = []) {
  const result = await checker.checkAuthGovernance(target, h.dependencies);
  const actualBlocked = result.providers.flatMap((provider) => provider.blockedPolicies.map((item) => item.policy));
  t.diagnostic(JSON.stringify({
    caseId: id, verification: 'mocked checker', expected: status, actual: result.status,
    expectedBlocked: blocked, actualBlocked, reads: h.calls.map(requestedPolicy),
    message: result.message,
  }));
  assert.equal(result.status, status);
  assert.equal(result.allowed, status === 'enabled');
  assert.deepEqual(actualBlocked, blocked);
  assert.ok(h.calls.every((call) => call.method === 'GET' && call.body === undefined));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TEST_TOKEN/);
  if (h.context.token) assert.ok(!JSON.stringify(result).includes(h.context.token));
  return result;
}

const socialStates = [
  [true, false, true],
  [true, true, true],
  [true, true, false],
  [true, false, false],
  [false, true, true],
  [false, true, false],
  [false, false, true],
  [false, false, false],
];
for (const [group, provider] of ['google', 'facebook', 'microsoft'].entries()) {
  const policies = providerPolicies[provider];
  for (const [index, states] of socialStates.entries()) {
    const id = group * 8 + index + 1;
    const blocked = policies.filter((_, position) => !states[position]);
    const expected = blocked.length ? 'blocked' : 'enabled';
    test(`Case ${String(id).padStart(2, '0')}: ${provider}, External/OAuth/provider=${states.map((state) => state ? 'E' : 'D').join('/')}`, async (t) => {
      const responses = Object.fromEntries(policies.map((policy, position) => [policy, { ok: true, statusCode: 200, body: states[position] }]));
      // Case 1 explicitly includes Facebook enabled, as in the user's example.
      // It must neither be read nor change the Google result.
      if (id === 1) responses[FACEBOOK] = { ok: true, statusCode: 200, body: true };
      const h = harness(responses);
      const result = await numberedDecision(t, id, h, { ...options, providers: [provider] }, expected, blocked);
      assert.deepEqual(h.calls.map(requestedPolicy), policies);
      assert.deepEqual(result.providers[0].blockedPolicies.map((item) => item.policy), blocked);
    });
  }
}

for (const [group, provider] of ['oidc', 'saml', 'ws-federation', 'local'].entries()) {
  const policies = providerPolicies[provider];
  for (const [index, states] of [[true, true], [true, false], [false, true], [false, false]].entries()) {
    const id = 25 + group * 4 + index;
    const blocked = policies.filter((_, position) => !states[position]);
    test(`Case ${id}: ${provider}, External/method=${states.map((state) => state ? 'E' : 'D').join('/')}`, async (t) => {
      const responses = Object.fromEntries(policies.map((policy, position) => [policy, { ok: true, statusCode: 200, body: states[position] }]));
      const h = harness(responses);
      const result = await numberedDecision(t, id, h, { ...options, providers: [provider] }, blocked.length ? 'blocked' : 'enabled', blocked);
      assert.deepEqual(h.calls.map(requestedPolicy), policies);
      assert.deepEqual(result.providers[0].blockedPolicies.map((item) => item.policy), blocked);
    });
  }
}

for (const [id, provider, unrelated] of [
  [41, 'google', FACEBOOK],
  [42, 'facebook', 'EnableIdpOAuthGoogle'],
  [43, 'microsoft', 'EnableProtocolOpenIdConnect'],
]) {
  test(`Case ${id}: ${provider} ignores disabled unrelated policy ${unrelated}`, async (t) => {
    const h = harness({ [unrelated]: { ok: true, statusCode: 200, body: false } });
    await numberedDecision(t, id, h, { ...options, providers: [provider] }, 'enabled');
    assert.ok(!h.calls.some((call) => requestedPolicy(call) === unrelated));
  });
}

test('Case 44: non-OAuth methods ignore disabled OAuth', async (t) => {
  for (const provider of ['oidc', 'saml', 'ws-federation', 'local']) {
    const h = harness({ [OAUTH]: { ok: true, statusCode: 200, body: false } });
    await numberedDecision(t, 44, h, { ...options, providers: [provider] }, 'enabled');
    assert.ok(!h.calls.some((call) => requestedPolicy(call) === OAUTH));
  }
});

for (const [id, statuses] of [[45, [401]], [46, [403]], [47, [404]], [48, [429]], [49, [500, 503]]]) {
  test(`Case ${id}: HTTP ${statuses.join('/')} is unverified, not disabled`, async (t) => {
    for (const statusCode of statuses) {
      for (const policy of [ROOT, OAUTH, FACEBOOK]) {
        const h = harness({ [policy]: { ok: false, statusCode } });
        const result = await numberedDecision(t, id, h, options, 'unverified');
        assert.equal(result.providers[0].verificationErrors[0].error.statusCode, statusCode);
        assert.match(result.message, /could not be verified/);
        if (statusCode === 401 || statusCode === 403) assert.match(result.message, /permissions/);
        if (statusCode === 404) assert.match(result.message, /host ID and API availability/);
      }
    }
  });
}

test('Case 50: timeout, network failure, and thrown error stop verification', async (t) => {
  for (const failure of [
    { ok: false, statusCode: 0, error: { code: 'NetworkError', message: 'timeout PRIVATE_TEST_TOKEN' } },
    { ok: false, statusCode: 0, error: { code: 'NetworkError', message: 'connection refused' } },
    new Error('PRIVATE_TEST_TOKEN'),
  ]) {
    await numberedDecision(t, 50, harness({ [FACEBOOK]: failure }), options, 'unverified');
  }
});

test('Case 51: empty, malformed, and unexpected portal responses stop verification', async (t) => {
  for (const body of [null, '', 'not-json', '{"enabled":', {}, [], { enabled: true }, { value: true }, 1]) {
    const h = harness({ [FACEBOOK]: { ok: true, statusCode: 200, body } });
    const result = await numberedDecision(t, 51, h, options, 'unverified');
    assert.equal(result.providers[0].verificationErrors[0].error.code, 'UnknownResponse');
  }
});

test('Case 52: environment scopes are never interpreted as portal booleans', async (t) => {
  for (const body of ['All', 'None', 'Include', 'Exclude']) {
    const h = harness({ [FACEBOOK]: { ok: true, statusCode: 200, body } });
    await numberedDecision(t, 52, h, options, 'unverified');
    assert.ok(h.calls.every((call) => call.method === 'GET'));
  }
});

test('Case 53: disabled and unreadable requirements are reported separately', async (t) => {
  const h = harness({
    [ROOT]: { ok: true, statusCode: 200, body: false },
    [FACEBOOK]: { ok: false, statusCode: 403 },
  });
  const result = await numberedDecision(t, 53, h, options, 'unverified', [ROOT]);
  assert.deepEqual(result.providers[0].verificationErrors.map((item) => item.policy), [FACEBOOK]);
  assert.ok(result.message.startsWith('Your administrator has restricted the use of External authentication for this website.'));
});

test('Case 54: mismatched environment stops before policy reads', async (t) => {
  const h = harness({}, { environmentId: portalId });
  await numberedDecision(t, 54, h, options, 'unverified');
  assert.equal(h.calls.length, 0);
});

test('Case 55: invalid IDs and using the website-record ID as host are rejected', async (t) => {
  for (const changes of [
    { envId: 'invalid' }, { portalId: '00000000-0000-0000-0000-000000000000' },
    { portalId: websiteRecordId }, { websiteRecordId: 'invalid' },
  ]) {
    const h = harness();
    await assert.rejects(checker.checkAuthGovernance({ ...options, ...changes }, h.dependencies), TypeError);
    assert.equal(h.resolutions, 0);
    assert.equal(h.calls.length, 0);
  }
  t.diagnostic(JSON.stringify({ caseId: 55, verification: 'mocked checker', actual: 'input rejected before authentication or reads' }));
});

test('Case 56: incorrect API host or base URL stops before reads', async (t) => {
  for (const overrides of [
    { apiHost: 'https://untrusted.example' },
    { baseUrl: `${CLOUD_TO_API.Public}/powerpages/environments/${portalId}` },
  ]) {
    const h = harness({}, overrides);
    await numberedDecision(t, 56, h, options, 'unverified');
    assert.equal(h.calls.length, 0);
  }
});

test('Case 57: unavailable CLI authentication stops before reads', async (t) => {
  const h = harness({}, { error: 'PRIVATE_TEST_TOKEN' });
  await numberedDecision(t, 57, h, options, 'unverified');
  assert.equal(h.calls.length, 0);
});

test('Case 58: expected tenant mismatch must stop before policy reads', async (t) => {
  const h = harness({}, { tenantId: portalId });
  const result = await checker.checkAuthGovernance({ ...options, tenantId: websiteRecordId }, h.dependencies);
  t.diagnostic(JSON.stringify({
    caseId: 58, verification: 'mocked checker', expected: 'unverified with zero reads',
    actual: result.status, readCount: h.calls.length, message: result.message,
  }));
  assert.equal(result.status, 'unverified');
  assert.equal(result.allowed, false);
  assert.equal(h.calls.length, 0);
  assert.match(result.message, /Authentication tenant mismatch/);
});

test('Case 59: all-enabled provider batch shares parents and starts reads concurrently', { timeout: 3000 }, async (t) => {
  const h = harness();
  const pending = [];
  h.dependencies.request = (args) => {
    h.calls.push(args);
    return new Promise((resolve) => pending.push(resolve));
  };
  const promise = checker.checkAuthGovernance({ ...options, providers: ['facebook', 'google', 'microsoft'] }, h.dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 5);
  assert.equal(h.calls.filter((call) => requestedPolicy(call) === ROOT).length, 1);
  assert.equal(h.calls.filter((call) => requestedPolicy(call) === OAUTH).length, 1);
  for (const resolve of pending) resolve({ ok: true, statusCode: 200, body: true });
  const result = await promise;
  assert.equal(result.allowed, true);
  assert.equal(h.resolutions, 1);
  t.diagnostic(JSON.stringify({
    caseId: 59, verification: 'mocked checker', expected: 'enabled, five concurrent unique reads',
    actual: result.status, readCount: h.calls.length, resolutions: h.resolutions,
  }));
});

test('Case 60: one blocked or unreadable provider denies the whole selected batch', async (t) => {
  for (const [body, status] of [[{ ok: true, statusCode: 200, body: false }, 'blocked'], [{ ok: false, statusCode: 403 }, 'unverified']]) {
    const h = harness({ [FACEBOOK]: body });
    const result = await numberedDecision(t, 60, h, { ...options, providers: ['facebook', 'google'] }, status, status === 'blocked' ? [FACEBOOK] : []);
    assert.deepEqual(result.providers.map((item) => item.provider), ['facebook', 'google']);
    assert.equal(result.providers[1].allowed, true);
    assert.equal(result.allowed, false);
  }
});

test('Case 61: a policy change after approval is detected by the next fresh check', async (t) => {
  const responses = {};
  const h = harness(responses);
  await numberedDecision(t, 61, h, options, 'enabled');
  responses[OAUTH] = { ok: true, statusCode: 200, body: false };
  await numberedDecision(t, 61, h, options, 'blocked', [OAUTH]);
  assert.equal(h.calls.length, 6);
  assert.equal(h.resolutions, 2);
});

test('Case 62: a resumed check resolves context again and rejects target drift', async (t) => {
  const h = harness();
  await numberedDecision(t, 62, h, options, 'enabled');
  h.context.environmentId = portalId;
  await numberedDecision(t, 62, h, options, 'unverified');
  assert.equal(h.resolutions, 2);
  assert.equal(h.calls.length, 3);
});

function workflowSources() {
  const root = path.resolve(__dirname, '..', '..');
  return {
    skill: fs.readFileSync(path.join(root, 'skills', 'setup-auth', 'SKILL.md'), 'utf8'),
    reference: fs.readFileSync(path.join(root, 'skills', 'setup-auth', 'references', 'governance-preflight.md'), 'utf8'),
    deploySkill: fs.readFileSync(path.join(root, 'skills', 'deploy-site', 'SKILL.md'), 'utf8'),
  };
}

test('blocked-message instructions omit supplementary guidance unless requested and disclose earlier changes', () => {
  const { skill, reference } = workflowSources();
  assert.match(skill, /Blocked-message presentation/);
  const approvedMessage = 'Your administrator has restricted the use of [authentication Protocol/Provider] for this website. Contact your administrator if you need this setting enabled.';
  assert.ok(skill.includes(approvedMessage));
  assert.ok(reference.includes(approvedMessage));
  assert.match(skill, /Apply this format at every later preflight gate/);
  assert.match(skill, /Do not append policy-state summaries/);
  assert.match(skill, /unless the user explicitly asks for those details/);
  assert.match(reference, /unless the user explicitly asks for those details/);
  assert.match(reference, /read-only recheck made no additional changes/);
  assert.match(reference, /never suggest enabling a policy as a substitute for verification/);
  assert.match(reference, /portals\[\]\.portalId/);
  assert.match(reference, /Denied batch\s+messages must omit enabled-provider success messages/);
});

test('Case 63: keep-only newly surfaced providers have a documented preflight gate [instruction check only]', (t) => {
  const { skill, reference } = workflowSources();
  const start = skill.indexOf('- **`keep-only`**');
  assert.ok(start >= 0);
  const keepOnly = skill.slice(start, skill.indexOf('- **`keep-and-add`**', start));
  assert.match(keepOnly, /run the initial governance preflight for every existing provider being surfaced\/regenerated once/);
  assert.match(reference, /including\s+existing providers in keep-only\/keep-and-add mode/);
  t.diagnostic(JSON.stringify({ caseId: 63, verification: 'instruction check only', actual: 'gate present; full skill execution not exercised' }));
});

test('Case 64: a late blocker preserves earlier artifacts and reports earlier work [instruction check only]', (t) => {
  const { skill, reference } = workflowSources();
  assert.match(reference, /If earlier stages already changed files, report those changes accurately/);
  assert.match(skill, /preserve existing settings and disclose any earlier generated files/);
  assert.match(skill, /Stop when batch `canContinue: false` and leave earlier local artifacts intact/);
  t.diagnostic(JSON.stringify({ caseId: 64, verification: 'instruction check only', actual: 'preservation/reporting instructions present; full skill execution not exercised' }));
});

test('Case 65: policy writes, deletion, overrides, and partial configuration are prohibited [instruction check only]', (t) => {
  const { reference } = workflowSources();
  assert.match(reference, /Stop the entire selected batch before mutation/);
  assert.match(reference, /Never silently remove providers, partially configure the allowed\s+subset, delete existing settings, enable governance, or offer an override/);
  t.diagnostic(JSON.stringify({ caseId: 65, verification: 'instruction check only', actual: 'no-write/no-partial-setup contract present; full skill execution not exercised' }));
});

test('Case 66: result messages never expose raw secrets', async (t) => {
  const h = harness({
    [FACEBOOK]: {
      ok: false, statusCode: 403,
      body: { secret: 'PRIVATE_TEST_TOKEN' },
      error: { code: 'PRIVATE_TEST_TOKEN', message: 'PRIVATE_TEST_TOKEN' },
    },
  });
  await numberedDecision(t, 66, h, options, 'unverified');
});
