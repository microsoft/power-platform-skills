const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { detect } = require('../lib/ensure-pipelines-host-detect');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-host-detect-'));
}

function mockMakeRequestRouter(routes) {
  return async (args) => {
    for (const r of routes) {
      if (r.match(args.url, args)) return r.respond(args);
    }
    return { statusCode: 599, body: 'no mock for ' + args.url };
  };
}

// Resets makeRequest after a test.
function withMockedHttp(t, routes) {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = mockMakeRequestRouter(routes);
  t.after(() => { helpers.makeRequest = orig; });
}

const SAMPLE_ENV_RESPONSE = {
  name: '0817fd3d-a664-e99a-a758-dd9dc03ceb01',
  location: 'unitedstates',
  properties: {
    displayName: 'PA Staff Pipelines Host',
    environmentSku: 'Production',
    tenantId: '72f988bf-86f1-41af-91ab-2d7cd011db47',
    permissions: { ReadEnvironment: {} },
    linkedEnvironmentMetadata: {
      instanceUrl: 'https://pascalepipelineshost.crm.dynamics.com/',
      instanceApiUrl: 'https://pascalepipelineshost.api.crm.dynamics.com',
      domainName: 'pascalepipelineshost',
    },
  },
};

test('throws when required args are missing', async () => {
  await assert.rejects(() => detect({ token: 't', userId: 'u', bapToken: 'b' }), /--envUrl is required/);
  await assert.rejects(() => detect({ envUrl: 'https://x', userId: 'u', bapToken: 'b' }), /--token .* is required/);
  await assert.rejects(() => detect({ envUrl: 'https://x', token: 't', bapToken: 'b' }), /--userId is required/);
  // bapToken is now optional in auto/pac modes; only required when source=bap
  await assert.rejects(
    () => detect({ envUrl: 'https://x', token: 't', userId: 'u', source: 'bap' }),
    /--bapToken is required/,
  );
});

test('AvailableUsingCustomHost: org-setting bound to a non-Platform env', async (t) => {
  const tmp = makeTmpDir();
  withMockedHttp(t, [
    { match: (u) => u.includes('/GetOrgDbOrgSetting'), respond: () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: '0817fd3d-a664-e99a-a758-dd9dc03ceb01' }) }) },
    { match: (u) => u.includes('/Microsoft.BusinessAppPlatform/environments/'), respond: () => ({ statusCode: 200, body: JSON.stringify(SAMPLE_ENV_RESPONSE) }) },
    { match: (u) => u.includes('/WhoAmI'), respond: () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u' }) }) },
    { match: (u) => u.includes('/solutions'), respond: () => ({ statusCode: 200, body: JSON.stringify({ value: [{ uniquename: 'msdyn_AppDeploymentAnchor', version: '9.1.2026034.260325188' }] }) }) },
  ]);

  const result = await detect({
    envUrl: 'https://org1e98cc97.crm.dynamics.com',
    token: 'dv',
    userId: 'user-1',
    bapToken: 'bap',
    projectRoot: tmp,
    getTokenImpl: () => 'dv-host-token',
  });

  assert.equal(result.resolutionStatus, 'AvailableUsingCustomHost');
  assert.equal(result.finalHostEnvUrl, 'https://pascalepipelineshost.crm.dynamics.com/');
  assert.equal(result.finalHostInstanceApiUrl, 'https://pascalepipelineshost.api.crm.dynamics.com');
  assert.equal(result.isPlatformHost, false);
  assert.equal(result.ready, true);
  assert.equal(result.pipelinesSolutionVersion, '9.1.2026034.260325188');
  assert.equal(result.actionTaken, 'none');
  assert.equal(result.schemaVersion, 2);
});

test('AvailableUsingPlatformHost: bound to PE, no tenant default custom host', async (t) => {
  const tmp = makeTmpDir();
  const peEnv = JSON.parse(JSON.stringify(SAMPLE_ENV_RESPONSE));
  peEnv.properties.environmentSku = 'Platform';

  withMockedHttp(t, [
    { match: (u) => u.includes('/GetOrgDbOrgSetting'), respond: () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: 'pe-guid' }) }) },
    { match: (u) => u.includes('/Microsoft.BusinessAppPlatform/environments/'), respond: () => ({ statusCode: 200, body: JSON.stringify(peEnv) }) },
    { match: (u) => u.includes('/RetrieveSetting'), respond: () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: '' }) }) },
    { match: (u) => u.includes('/WhoAmI'), respond: () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u' }) }) },
    { match: (u) => u.includes('/solutions'), respond: () => ({ statusCode: 200, body: JSON.stringify({ value: [{ version: '9.1' }] }) }) },
  ]);

  const result = await detect({
    envUrl: 'https://x.crm.dynamics.com',
    token: 'dv',
    userId: 'u',
    bapToken: 'bap',
    projectRoot: tmp,
    getTokenImpl: () => 't',
  });

  assert.equal(result.resolutionStatus, 'AvailableUsingPlatformHost');
  assert.equal(result.isPlatformHost, true);
  assert.equal(result.tenantDefaultCustomHostEnvId, null);
  assert.equal(result.ready, true);
});

test('CannotRedirect: bound to PE but tenant default custom host points elsewhere', async (t) => {
  const tmp = makeTmpDir();
  const peEnv = JSON.parse(JSON.stringify(SAMPLE_ENV_RESPONSE));
  peEnv.properties.environmentSku = 'Platform';

  withMockedHttp(t, [
    { match: (u) => u.includes('/GetOrgDbOrgSetting'), respond: () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: 'pe-guid' }) }) },
    { match: (u) => u.includes('/Microsoft.BusinessAppPlatform/environments/'), respond: () => ({ statusCode: 200, body: JSON.stringify(peEnv) }) },
    { match: (u) => u.includes('/RetrieveSetting'), respond: () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: 'different-host-guid' }) }) },
  ]);

  const result = await detect({
    envUrl: 'https://x.crm.dynamics.com',
    token: 'dv',
    userId: 'u',
    bapToken: 'bap',
    projectRoot: tmp,
    getTokenImpl: () => 't',
  });

  assert.equal(result.resolutionStatus, 'CannotRedirect');
  assert.equal(result.tenantDefaultCustomHostEnvId, 'different-host-guid');
  assert.match(result.warnings[0], /CannotRedirect/);
  assert.equal(result.finalHostEnvUrl, 'https://pascalepipelineshost.crm.dynamics.com/');
  assert.equal(result.ready, false); // didn't run verify because we early-returned
});

test('OrgSettingStale: org binding points at env that returns 404 from BAP', async (t) => {
  const tmp = makeTmpDir();
  withMockedHttp(t, [
    { match: (u) => u.includes('/GetOrgDbOrgSetting'), respond: () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: 'deleted-guid' }) }) },
    { match: (u) => u.includes('/Microsoft.BusinessAppPlatform/environments/'), respond: () => ({ statusCode: 404, body: 'Not Found' }) },
  ]);

  const result = await detect({
    envUrl: 'https://x.crm.dynamics.com',
    token: 'dv',
    userId: 'u',
    bapToken: 'bap',
    projectRoot: tmp,
    getTokenImpl: () => 't',
  });

  assert.equal(result.resolutionStatus, 'OrgSettingStale');
  assert.equal(result.finalHostEnvUrl, null);
});

test('NoHost: unbound + tenant has no custom hosts and no PE', async (t) => {
  const tmp = makeTmpDir();
  withMockedHttp(t, [
    { match: (u) => u.includes('/GetOrgDbOrgSetting'), respond: () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: '' }) }) },
  ]);

  const result = await detect({
    envUrl: 'https://x.crm.dynamics.com',
    token: 'dv',
    userId: 'u',
    bapToken: 'bap',
    projectRoot: tmp,
    listImpl: async () => [], // empty tenant
    getTokenImpl: () => 't',
    verifyImpl: async () => ({}),
  });

  assert.equal(result.resolutionStatus, 'NoHost');
  assert.equal(result.finalHostEnvUrl, null);
  assert.deepEqual(result.candidates.existingCustomHosts, []);
  assert.equal(result.candidates.existingPlatformHost, null);
});

test('AvailableUnboundCustomHost: unbound + exactly one Custom Host found', async (t) => {
  const tmp = makeTmpDir();
  withMockedHttp(t, [
    { match: (u) => u.includes('/GetOrgDbOrgSetting'), respond: () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: '' }) }) },
    { match: (u) => u.includes('/WhoAmI'), respond: () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u' }) }) },
    { match: (u) => u.includes('/solutions'), respond: () => ({ statusCode: 200, body: JSON.stringify({ value: [{ version: '9.1' }] }) }) },
  ]);

  const fakeEnvs = [
    {
      name: 'host-id',
      properties: {
        displayName: 'PA Staff Pipelines Host',
        environmentSku: 'Production',
        linkedEnvironmentMetadata: {
          instanceUrl: 'https://pascalepipelineshost.crm.dynamics.com/',
          instanceApiUrl: 'https://pascalepipelineshost.api.crm.dynamics.com',
          domainName: 'pascalepipelineshost',
        },
      },
    },
  ];

  const result = await detect({
    envUrl: 'https://x.crm.dynamics.com',
    token: 'dv',
    userId: 'u',
    bapToken: 'bap',
    projectRoot: tmp,
    listImpl: async () => fakeEnvs,
    getTokenImpl: () => 't',
    verifyImpl: async () => ({ ready: true, pipelinesSolutionVersion: '9.1', checks: { whoami: { skipped: true, ok: true }, solutions: { ok: true, found: true, version: '9.1' } }, warnings: [] }),
  });

  assert.equal(result.resolutionStatus, 'AvailableUnboundCustomHost');
  assert.equal(result.finalHostEnvUrl, 'https://pascalepipelineshost.crm.dynamics.com/');
  assert.equal(result.ready, true);
});

test('cache fast-path: returns immediately when .last-host-check.json is fresh and host probes 200', async (t) => {
  const tmp = makeTmpDir();
  const cached = {
    schemaVersion: 2,
    checkedAt: new Date(Date.now() - 60 * 1000).toISOString(), // 1 min old
    sourceEnvUrl: 'https://x.crm.dynamics.com',
    sourceEnvId: 'src',
    resolutionStatus: 'AvailableUsingCustomHost',
    finalHostEnvUrl: 'https://pascalepipelineshost.crm.dynamics.com/',
    finalHostEnvId: '0817fd3d',
    finalHostInstanceApiUrl: 'https://pascalepipelineshost.api.crm.dynamics.com',
    isPlatformHost: false,
    actionTaken: 'none',
    pipelinesSolutionVersion: '9.1',
    ready: true,
    warnings: [],
    candidates: { existingCustomHosts: [], existingPlatformHost: null, eligibleForAppInstall: [], inaccessibleEnvs: [] },
    telemetry: { correlationId: null },
  };
  fs.writeFileSync(path.join(tmp, '.last-host-check.json'), JSON.stringify(cached));

  let bindingCalled = false;
  withMockedHttp(t, [
    { match: (u) => u.includes('/GetOrgDbOrgSetting'), respond: () => { bindingCalled = true; return { statusCode: 200, body: JSON.stringify({ SettingValue: '' }) }; } },
    { match: (u) => u.includes('/WhoAmI'), respond: () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u' }) }) },
    { match: (u) => u.includes('/solutions'), respond: () => ({ statusCode: 200, body: JSON.stringify({ value: [{ version: '9.1' }] }) }) },
  ]);

  const result = await detect({
    envUrl: 'https://x.crm.dynamics.com',
    token: 'dv',
    userId: 'u',
    bapToken: 'bap',
    projectRoot: tmp,
    getTokenImpl: () => 't',
  });

  assert.equal(result.cacheHit, true);
  assert.equal(result.finalHostEnvUrl, 'https://pascalepipelineshost.crm.dynamics.com/');
  assert.equal(bindingCalled, false, 'cache hit should skip the org-setting probe');
});

test('cache fast-path: bypassed by --no-cache flag', async (t) => {
  const tmp = makeTmpDir();
  const cached = {
    schemaVersion: 2,
    checkedAt: new Date(Date.now() - 60 * 1000).toISOString(),
    sourceEnvUrl: 'https://x.crm.dynamics.com',
    finalHostEnvUrl: 'https://pascalepipelineshost.crm.dynamics.com/',
    ready: true,
  };
  fs.writeFileSync(path.join(tmp, '.last-host-check.json'), JSON.stringify(cached));

  let bindingCalled = false;
  withMockedHttp(t, [
    { match: (u) => u.includes('/GetOrgDbOrgSetting'), respond: () => { bindingCalled = true; return { statusCode: 200, body: JSON.stringify({ SettingValue: '' }) }; } },
  ]);

  await detect({
    envUrl: 'https://x.crm.dynamics.com',
    token: 'dv',
    userId: 'u',
    bapToken: 'bap',
    projectRoot: tmp,
    noCache: true,
    listImpl: async () => [],
    getTokenImpl: () => 't',
    verifyImpl: async () => ({}),
  });

  assert.equal(bindingCalled, true, '--no-cache should force full resolution');
});

test('source: pac — works without --bapToken when source=pac (new tenant scenario)', async (t) => {
  const tmp = makeTmpDir();
  const pacOut = `[
    {"EnvironmentId":"9f930375","EnvironmentUrl":"https://stage1.crm5.dynamics.com/","DisplayName":"Stage-1","Type":"Developer","OrganizationId":"o1"},
    {"EnvironmentId":"6c93b05a","EnvironmentUrl":"https://stage2.crm5.dynamics.com/","DisplayName":"Stage-2","Type":"Developer","OrganizationId":"o2"}
  ]`;
  withMockedHttp(t, [
    // No org binding on dev env
    { match: (u) => u.includes('/GetOrgDbOrgSetting'), respond: () => ({ statusCode: 200, body: JSON.stringify({ SettingValue: '' }) }) },
    // Per-env solutions probes — neither env has Pipelines installed
    { match: (u) => u.includes('/solutions'), respond: () => ({ statusCode: 200, body: JSON.stringify({ value: [] }) }) },
    { match: (u) => u.includes('/WhoAmI'), respond: () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u' }) }) },
  ]);

  const result = await detect({
    envUrl: 'https://stage1.crm5.dynamics.com',
    token: 'dv',
    userId: 'u',
    // NO bapToken — auto/pac mode handles it
    source: 'pac',
    skus: ['Developer'], // Dev/demo tenants: must opt-in to non-Production skus
    projectRoot: tmp,
    pacExecImpl: async () => ({ stdout: pacOut, stderr: '' }),
    getTokenImpl: () => 't',
  });

  // Expected: no Pipelines anywhere → resolutionStatus: NoHost
  assert.equal(result.resolutionStatus, 'NoHost');
  assert.equal(result.actionTaken, 'none');
  assert.ok(Array.isArray(result.candidates.eligibleForAppInstall));
  assert.equal(result.candidates.eligibleForAppInstall.length, 2); // both Stage-1 and Stage-2 eligible
});

test('cache fast-path: stale cache (>24h) is ignored', async (t) => {
  const tmp = makeTmpDir();
  const cached = {
    schemaVersion: 2,
    checkedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString(), // 25h ago
    finalHostEnvUrl: 'https://x.crm.dynamics.com/',
    ready: true,
  };
  fs.writeFileSync(path.join(tmp, '.last-host-check.json'), JSON.stringify(cached));

  let bindingCalled = false;
  withMockedHttp(t, [
    { match: (u) => u.includes('/GetOrgDbOrgSetting'), respond: () => { bindingCalled = true; return { statusCode: 200, body: JSON.stringify({ SettingValue: '' }) }; } },
  ]);

  await detect({
    envUrl: 'https://x.crm.dynamics.com',
    token: 'dv',
    userId: 'u',
    bapToken: 'bap',
    projectRoot: tmp,
    listImpl: async () => [],
    getTokenImpl: () => 't',
    verifyImpl: async () => ({}),
  });

  assert.equal(bindingCalled, true, 'stale cache should fall through to full resolution');
});
