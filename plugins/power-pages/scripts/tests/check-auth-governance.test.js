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

function harness(responses = {}, contextOverrides = {}) {
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
      resolveContext() { resolutions++; return context; },
      async callGovernance(args) {
        calls.push(args);
        const response = responses[args.policy];
        if (response instanceof Error) throw response;
        return response === undefined ? { ok: true, statusCode: 200, body: true } : response;
      },
    },
  };
}

const methods = [
  ['facebook', 'isFacebookOAuthEnabled', [ROOT, OAUTH, FACEBOOK]],
  ['google', 'isGoogleOAuthEnabled', [ROOT, OAUTH, 'EnableIdpOAuthGoogle']],
  ['microsoft', 'isMicrosoftOAuthEnabled', [ROOT, OAUTH, 'EnableIdpOAuthMicrosoft']],
  ['oidc', 'isOidcEnabled', [ROOT, 'EnableProtocolOpenIdConnect']],
  ['saml', 'isSamlEnabled', [ROOT, 'EnableProtocolSAML20']],
  ['ws-federation', 'isWsFederationEnabled', [ROOT, 'EnableProtocolWsFederation']],
  ['local', 'isLocalLoginEnabled', [ROOT, 'EnableAuthenticationLocalLogin']],
];

for (const [provider, wrapper, policies] of methods) {
  test(`${wrapper} reads only its complete dependency chain`, async () => {
    const h = harness();
    assert.equal(await checker[wrapper](options, h.dependencies), true);
    assert.deepEqual(h.calls.map((call) => call.policy), policies);
    assert.equal(h.resolutions, 1);
    for (const call of h.calls) {
      assert.equal(call.op, 'getPortal');
      assert.equal(call.envId, envId);
      assert.equal(call.portalId, portalId);
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
      assert.equal(await checker[wrapper](options, h.dependencies), false);
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
  h.dependencies.callGovernance = (args) => {
    h.calls.push(args);
    return new Promise((resolve) => pending.push(resolve));
  };
  const promise = checker.checkAuthGovernance({ ...options, providers: ['facebook', 'google', 'facebook'] }, h.dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.calls.map((call) => call.policy), [ROOT, OAUTH, FACEBOOK, 'EnableIdpOAuthGoogle']);
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

test('only boolean and exact text boolean primitives are accepted', async () => {
  for (const [body, status] of [[true, 'enabled'], [false, 'blocked'], ['true', 'enabled'], [' false\n', 'blocked']]) {
    const result = await checker.checkAuthGovernance(options, harness({ [FACEBOOK]: { ok: true, statusCode: 200, body } }).dependencies);
    assert.equal(result.status, status);
  }
  for (const body of [null, undefined, 0, 1, '', 'True', '"true"', 'Enabled', 'All', 'None',
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
    await assert.rejects(checker.isFacebookOAuthEnabled(options, h.dependencies), (error) => {
      assert.ok(error instanceof checker.AuthGovernanceVerificationError);
      assert.equal(error.code, 'AuthGovernanceUnverified');
      assert.equal(error.result.status, 'unverified');
      return true;
    });
  }
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
});

test('known disabled parents are retained when another read cannot be verified', async () => {
  const h = harness({
    [ROOT]: { ok: true, statusCode: 200, body: false },
    [FACEBOOK]: { ok: false, statusCode: 404 },
  });
  const result = await checker.checkAuthGovernance(options, h.dependencies);
  assert.equal(result.status, 'unverified');
  assert.match(result.message, /Also disabled for this portal:\n- External authentication/);
  assert.match(result.message, /Facebook OAuth.*HTTP 404/);
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
    assert.match(result.message, /tenant/);
    assert.match(result.message, /No governance requests were sent/);
    assert.ok(!JSON.stringify(result).includes(String(h.context.token)));
  }
});

test('every provider wrapper applies the same missing/mismatched tenant guard', async () => {
  for (const [, wrapper] of methods) {
    for (const [target, overrides] of [
      [{ ...options, tenantId: undefined }, {}],
      [options, { tenantId: portalId }],
      [options, { tenantId: undefined }],
      [options, { token: testToken(portalId) }],
    ]) {
      const h = harness({}, overrides);
      await assert.rejects(checker[wrapper](target, h.dependencies), (error) => {
        assert.ok(error instanceof checker.AuthGovernanceVerificationError);
        assert.equal(error.code, 'AuthGovernanceUnverified');
        assert.equal(error.result.allowed, false);
        assert.equal(error.result.status, 'unverified');
        assert.doesNotMatch(error.message, /PRIVATE_TEST_TOKEN/);
        return true;
      });
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
  const invalid = spawnSync(process.execPath, [script, '--envId', 'invalid'], spawnOptions);
  assert.equal(invalid.status, 1);
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
  assert.equal(invalidTenant.status, 1);
  assert.match(invalidTenant.stderr, /tenantId.*must be/);
});

async function invokeCli(h, flags) {
  const script = require.resolve('../check-auth-governance');
  const realRequire = createRequire(script);
  let output;
  let completion;
  const sandbox = {
    module: { exports: {} },
    process: { argv: ['node', script, ...flags] },
    require(name) {
      if (name === './lib/power-platform-api') {
        return {
          ...realRequire(name),
          resolveContext: h.dependencies.resolveContext,
          emitJson(result) { output = JSON.parse(JSON.stringify(result)); },
          runCli(_module, main) { completion = main(); },
        };
      }
      if (name === '../skills/manage-governance/scripts/governance-transport') {
        return { callGovernance: h.dependencies.callGovernance };
      }
      return realRequire(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), sandbox, { filename: script });
  await completion;
  return { output, exitCode: sandbox.process.exitCode };
}

test('CLI emits the complete decision and exits 0/1/2 for enabled/blocked/unverified', async () => {
  for (const [response, status, exitCode] of [
    [{ ok: true, statusCode: 200, body: true }, 'enabled', 0],
    [{ ok: true, statusCode: 200, body: false }, 'blocked', 1],
    [{ ok: false, statusCode: 404 }, 'unverified', 2],
  ]) {
    const h = harness({ [FACEBOOK]: response });
    const { output, exitCode: actualExit } = await invokeCli(h, [
      '--tenantId', tenantId, '--envId', envId, '--portalId', portalId, '--providers', 'facebook',
    ]);
    assert.equal(actualExit, exitCode);
    assert.equal(output.status, status);
    assert.equal(output.allowed, exitCode === 0);
    assert.equal(output.envId, envId);
    assert.equal(output.tenantId, tenantId);
    assert.equal(output.portalId, portalId);
    assert.equal(output.policies.length, 3);
    assert.equal(h.resolutions, 1);
    assert.doesNotMatch(JSON.stringify(output), /PRIVATE_TEST_TOKEN/);
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
    assert.equal(h.calls.length, 0);
    assert.ok(output.providers.every((provider) => provider.status === 'unverified'));
    assert.ok(!JSON.stringify(output).includes(h.context.token));
  }
});

test('setup-auth gates provider walkthroughs, provisioning, UI generation, and settings', () => {
  const root = path.resolve(__dirname, '..', '..');
  const skill = fs.readFileSync(path.join(root, 'skills', 'setup-auth', 'SKILL.md'), 'utf8');
  const selection = skill.indexOf('**Before provider-specific follow-ups:**');
  assert.ok(selection > 0 && selection < skill.indexOf('**For "Facebook"**'));
  assert.match(skill.slice(selection, selection + 750), /smart-inference and `keep-only`/);
  assert.match(skill.slice(skill.indexOf('#### 2.1.2'), skill.indexOf('#### 2.1.2') + 800), /rerun it immediately before configuring a real IdP/);
  assert.match(skill.slice(skill.indexOf('## Phase 3:'), skill.indexOf('## Phase 3:') + 900), /Rerun the governance preflight/);
  assert.match(skill.slice(skill.indexOf('## Phase 5:'), skill.indexOf('## Phase 5:') + 700), /Rerun the governance preflight/);
  assert.match(skill.slice(skill.indexOf('#### 8.1 Create Site Settings'), skill.indexOf('#### 8.1 Create Site Settings') + 700), /Stop on blocked\/unverified/);
  assert.match(skill.slice(skill.indexOf('#### 8.4 Ask to Deploy'), skill.indexOf('#### 8.4 Ask to Deploy') + 1400), /Deploy only when all selected providers are allowed/);
  const reference = fs.readFileSync(path.join(root, 'skills', 'setup-auth', 'references', 'governance-preflight.md'), 'utf8');
  assert.match(reference, /Stop the entire selected batch before mutation/);
  assert.match(reference, /does not invoke or re-enable/);
  assert.match(reference, /not a visitor-side runtime filter/);
  assert.match(skill, /pass `--tenantId` on every check/);
  assert.match(reference, /--tenantId "<TENANT_ID>"/);
  assert.match(reference, /Do not infer it from the current Azure CLI\s+account/);
  assert.doesNotMatch(reference, /\*\*Known gap:\*\*/);
});

// Keep these IDs aligned with the maker-facing 66-case plan. These cases run
// sequentially against injected reads, never by toggling a live portal policy.
async function numberedDecision(t, id, h, target, status, blocked = []) {
  const result = await checker.checkAuthGovernance(target, h.dependencies);
  const actualBlocked = result.providers.flatMap((provider) => provider.blockedPolicies.map((item) => item.policy));
  t.diagnostic(JSON.stringify({
    caseId: id, verification: 'mocked checker', expected: status, actual: result.status,
    expectedBlocked: blocked, actualBlocked, reads: h.calls.map((call) => call.policy),
    message: result.message,
  }));
  assert.equal(result.status, status);
  assert.equal(result.allowed, status === 'enabled');
  assert.deepEqual(actualBlocked, blocked);
  assert.ok(h.calls.every((call) => call.op === 'getPortal' && call.body === undefined));
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
  const [, wrapper, policies] = methods.find((method) => method[0] === provider);
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
      assert.deepEqual(h.calls.map((call) => call.policy), policies);
      assert.deepEqual(result.providers[0].blockedPolicies.map((item) => item.policy), blocked);
      assert.equal(await checker[wrapper](options, h.dependencies), expected === 'enabled');
    });
  }
}

for (const [group, provider] of ['oidc', 'saml', 'ws-federation', 'local'].entries()) {
  const [, , policies] = methods.find((method) => method[0] === provider);
  for (const [index, states] of [[true, true], [true, false], [false, true], [false, false]].entries()) {
    const id = 25 + group * 4 + index;
    const blocked = policies.filter((_, position) => !states[position]);
    test(`Case ${id}: ${provider}, External/method=${states.map((state) => state ? 'E' : 'D').join('/')}`, async (t) => {
      const responses = Object.fromEntries(policies.map((policy, position) => [policy, { ok: true, statusCode: 200, body: states[position] }]));
      const h = harness(responses);
      const result = await numberedDecision(t, id, h, { ...options, providers: [provider] }, blocked.length ? 'blocked' : 'enabled', blocked);
      assert.deepEqual(h.calls.map((call) => call.policy), policies);
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
    assert.ok(!h.calls.some((call) => call.policy === unrelated));
  });
}

test('Case 44: non-OAuth methods ignore disabled OAuth', async (t) => {
  for (const provider of ['oidc', 'saml', 'ws-federation', 'local']) {
    const h = harness({ [OAUTH]: { ok: true, statusCode: 200, body: false } });
    await numberedDecision(t, 44, h, { ...options, providers: [provider] }, 'enabled');
    assert.ok(!h.calls.some((call) => call.policy === OAUTH));
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
    assert.ok(h.calls.every((call) => call.op === 'getPortal'));
  }
});

test('Case 53: disabled and unreadable requirements are reported separately', async (t) => {
  const h = harness({
    [ROOT]: { ok: true, statusCode: 200, body: false },
    [FACEBOOK]: { ok: false, statusCode: 403 },
  });
  const result = await numberedDecision(t, 53, h, options, 'unverified', [ROOT]);
  assert.deepEqual(result.providers[0].verificationErrors.map((item) => item.policy), [FACEBOOK]);
  assert.match(result.message, /Also disabled for this portal:\n- External authentication/);
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
  h.dependencies.callGovernance = (args) => {
    h.calls.push(args);
    return new Promise((resolve) => pending.push(resolve));
  };
  const promise = checker.checkAuthGovernance({ ...options, providers: ['facebook', 'google', 'microsoft'] }, h.dependencies);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 5);
  assert.equal(h.calls.filter((call) => call.policy === ROOT).length, 1);
  assert.equal(h.calls.filter((call) => call.policy === OAUTH).length, 1);
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
});

test('Case 63: keep-only newly surfaced providers have a documented preflight gate [instruction check only]', (t) => {
  const { skill, reference } = workflowSources();
  const start = skill.indexOf('- **`keep-only`**');
  assert.ok(start >= 0);
  assert.match(skill.slice(start, start + 600), /run the governance preflight for every existing provider being surfaced\/regenerated/);
  assert.match(reference, /including\s+existing providers in keep-only\/keep-and-add mode/);
  t.diagnostic(JSON.stringify({ caseId: 63, verification: 'instruction check only', actual: 'gate present; full skill execution not exercised' }));
});

test('Case 64: a late blocker preserves earlier artifacts and reports earlier work [instruction check only]', (t) => {
  const { skill, reference } = workflowSources();
  assert.match(reference, /If earlier stages already changed files, report those changes accurately/);
  assert.match(skill, /preserve existing settings and disclose any earlier generated files/);
  assert.match(skill, /Stop on blocked\/unverified results and leave earlier local artifacts intact/);
  t.diagnostic(JSON.stringify({ caseId: 64, verification: 'instruction check only', actual: 'preservation/reporting instructions present; full skill execution not exercised' }));
});

test('Case 65: policy writes, deletion, overrides, and partial configuration are prohibited [instruction check only]', (t) => {
  const { reference } = workflowSources();
  assert.match(reference, /Stop the entire selected batch before mutation/);
  assert.match(reference, /Never silently remove providers, partially configure the allowed\s+subset, delete existing settings, enable governance, or offer an override/);
  t.diagnostic(JSON.stringify({ caseId: 65, verification: 'instruction check only', actual: 'no-write/no-partial-setup contract present; full skill execution not exercised' }));
});

test('Case 66: result messages and wrapper errors never expose raw secrets', async (t) => {
  const h = harness({
    [FACEBOOK]: {
      ok: false, statusCode: 403,
      body: { secret: 'PRIVATE_TEST_TOKEN' },
      error: { code: 'PRIVATE_TEST_TOKEN', message: 'PRIVATE_TEST_TOKEN' },
    },
  });
  await numberedDecision(t, 66, h, options, 'unverified');
  await assert.rejects(checker.isFacebookOAuthEnabled(options, h.dependencies), (error) => {
    assert.doesNotMatch(error.message, /PRIVATE_TEST_TOKEN/);
    assert.doesNotMatch(JSON.stringify(error.result), /PRIVATE_TEST_TOKEN/);
    return true;
  });
});
