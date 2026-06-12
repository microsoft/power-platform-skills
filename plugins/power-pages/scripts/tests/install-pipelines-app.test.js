const test = require('node:test');
const assert = require('node:assert/strict');

const {
  installPipelinesApp,
  discoverPackage,
  isTerminalSucceeded,
  PIPELINES_PACKAGE_UNIQUE_NAMES,
  PIPELINES_SOLUTION_UNIQUE_NAME,
} = require('../lib/install-pipelines-app');

const noSleep = async () => {};
const fakePacOk = () => ({ ok: true, command: 'pac mock', stdout: 'Installed' });
const fakePacFail = () => ({ ok: false, error: 'pac not on PATH' });

function makeMockResponder(routes) {
  return async (args) => {
    for (const r of routes) {
      if (r.match(args.url, args)) return r.respond(args);
    }
    return { statusCode: 599, body: 'no mock for ' + args.url };
  };
}

function withMockedHttp(t, routes) {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = makeMockResponder(routes);
  t.after(() => { helpers.makeRequest = orig; });
}

// Reusable mock data
const ENV_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PACKAGE_NAME = 'msdyn_AppDeploymentAnchor';
const INSTANCE_API_URL = 'https://orgxxx.api.crm.dynamics.com';
const LOCATION_HEADER = 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/lifecycleOperations/op-install-1?api-version=2022-03-01-preview';

const PACKAGE_LIST_INSTALLED = {
  value: [
    {
      name: 'msdyn_AppDeploymentAnchor',
      properties: {
        uniqueName: 'msdyn_AppDeploymentAnchor',
        applicationName: 'Power Platform Pipelines',
        state: 'Installed',
      },
    },
  ],
};

const PACKAGE_LIST_AVAILABLE = {
  value: [
    {
      name: 'msdyn_AppDeploymentAnchor',
      properties: {
        uniqueName: 'msdyn_AppDeploymentAnchor',
        applicationName: 'Power Platform Pipelines',
        state: 'Available',
      },
    },
  ],
};

const SOLUTION_QUERY_HIT = {
  value: [{ uniquename: 'msdyn_AppDeploymentAnchor', version: '9.1.2026034.260325188' }],
};

// ── Constants ─────────────────────────────────────────────────────────────────

test('PIPELINES_PACKAGE_UNIQUE_NAMES contains msdyn_AppDeploymentAnchor as the primary entry', () => {
  assert.equal(PIPELINES_PACKAGE_UNIQUE_NAMES[0], 'msdyn_AppDeploymentAnchor');
});

test('PIPELINES_SOLUTION_UNIQUE_NAME matches the post-install Dataverse probe target', () => {
  assert.equal(PIPELINES_SOLUTION_UNIQUE_NAME, 'msdyn_AppDeploymentAnchor');
});

test('isTerminalSucceeded recognises both "Succeeded" and "Installed" terminal states', () => {
  assert.equal(isTerminalSucceeded('Succeeded'), true);
  assert.equal(isTerminalSucceeded('Installed'), true);
  assert.equal(isTerminalSucceeded('installing'), false);
  assert.equal(isTerminalSucceeded(''), false);
});

// ── Required-args guard ───────────────────────────────────────────────────────

test('throws when bapToken is missing', async () => {
  await assert.rejects(
    () => installPipelinesApp({ envId: ENV_ID }),
    /--bapToken is required/,
  );
});

test('throws when envId is missing', async () => {
  await assert.rejects(
    () => installPipelinesApp({ bapToken: 't' }),
    /--envId is required/,
  );
});

// ── Discovery + idempotent path ───────────────────────────────────────────────

test('discoverPackage finds the package by uniqueName', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_INSTALLED) }),
    },
  ]);
  const pkg = await discoverPackage({ bapToken: 'fake', envId: ENV_ID, apiVersion: '2022-03-01-preview', bapBase: 'https://api.bap.microsoft.com', correlationId: 'cid-1' });
  assert.ok(pkg, 'package should be found');
  assert.equal(pkg.uniqueName, 'msdyn_AppDeploymentAnchor');
  assert.equal(pkg.state, 'Installed');
});

test('idempotent path: package already Installed → returns alreadyInstalled=true with no install POST', async (t) => {
  let postCalled = false;
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_INSTALLED) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => { postCalled = true; return { statusCode: 599, body: 'should not be called' }; },
    },
  ]);
  const result = await installPipelinesApp({
    bapToken: 'fake',
    envId: ENV_ID,
    sleepImpl: noSleep,
  });
  assert.equal(result.status, 'Succeeded');
  assert.equal(result.alreadyInstalled, true);
  assert.equal(result.installPath, 'cached');
  assert.equal(postCalled, false, 'install POST should be skipped when discovery shows Installed');
});

// ── BAP install POST → Succeeded sync (200) ───────────────────────────────────

test('200 sync install: returns alreadyInstalled=false, installPath=bap', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({
        statusCode: 200,
        body: JSON.stringify({ properties: { provisioningState: 'Succeeded' } }),
      }),
    },
  ]);
  const result = await installPipelinesApp({
    bapToken: 'fake',
    envId: ENV_ID,
    sleepImpl: noSleep,
  });
  assert.equal(result.status, 'Succeeded');
  assert.equal(result.alreadyInstalled, false);
  assert.equal(result.installPath, 'bap');
  assert.equal(result.packageUniqueName, 'msdyn_AppDeploymentAnchor');
});

// ── BAP install POST → 202 + Location poll → Installed ────────────────────────

test('202 + Location poll → Installed terminal state', async (t) => {
  let pollCount = 0;
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: LOCATION_HEADER, 'retry-after': '1' },
        body: JSON.stringify({ properties: { provisioningState: 'Installing' } }),
      }),
    },
    {
      match: (u, args) => u === LOCATION_HEADER && args.method === 'GET',
      respond: () => {
        pollCount++;
        if (pollCount === 1) {
          return { statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Installing' } }) };
        }
        return { statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Installed' } }) };
      },
    },
  ]);
  const result = await installPipelinesApp({
    bapToken: 'fake',
    envId: ENV_ID,
    sleepImpl: noSleep,
  });
  assert.equal(result.status, 'Succeeded');
  assert.equal(result.alreadyInstalled, false);
  assert.equal(result.installPath, 'bap');
  assert.equal(result.pollAttempts, 2);
});

// ── 409 Conflict (already in progress) → idempotent path ──────────────────────

test('409 Conflict on install POST → treat as already-installed (idempotent)', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({ statusCode: 409, body: '{"error":{"code":"AlreadyInProgress"}}' }),
    },
  ]);
  const result = await installPipelinesApp({
    bapToken: 'fake',
    envId: ENV_ID,
    sleepImpl: noSleep,
  });
  assert.equal(result.alreadyInstalled, true);
  assert.equal(result.installPath, 'cached');
});

// ── PAC fallback paths ────────────────────────────────────────────────────────

test('403 on install POST → PAC fallback when allowPacFallback=true', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({ statusCode: 403, body: 'Forbidden' }),
    },
  ]);
  const result = await installPipelinesApp({
    bapToken: 'fake',
    envId: ENV_ID,
    sleepImpl: noSleep,
    pacFallbackImpl: fakePacOk,
  });
  assert.equal(result.status, 'Succeeded');
  assert.equal(result.installPath, 'pac');
  assert.match(result.pacFallbackReason, /403/);
});

test('5xx on install POST → PAC fallback', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({ statusCode: 503, body: 'Service Unavailable' }),
    },
  ]);
  const result = await installPipelinesApp({
    bapToken: 'fake',
    envId: ENV_ID,
    sleepImpl: noSleep,
    pacFallbackImpl: fakePacOk,
  });
  assert.equal(result.installPath, 'pac');
  assert.match(result.pacFallbackReason, /503/);
});

test('Transport error on install POST → PAC fallback', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({ error: 'getaddrinfo ENOTFOUND' }),
    },
  ]);
  const result = await installPipelinesApp({
    bapToken: 'fake',
    envId: ENV_ID,
    sleepImpl: noSleep,
    pacFallbackImpl: fakePacOk,
  });
  assert.equal(result.installPath, 'pac');
});

test('PAC fallback failure surfaces both BAP and PAC errors in the message', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({ statusCode: 403, body: 'Forbidden' }),
    },
  ]);
  await assert.rejects(
    () => installPipelinesApp({
      bapToken: 'fake',
      envId: ENV_ID,
      sleepImpl: noSleep,
      pacFallbackImpl: fakePacFail,
    }),
    /BAP install failed and PAC fallback failed.*BAP=403.*PAC=pac not on PATH/s,
  );
});

test('--no-pac-fallback honored: 403 throws without trying PAC', async (t) => {
  let pacCalled = false;
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({ statusCode: 403, body: 'Forbidden' }),
    },
  ]);
  await assert.rejects(
    () => installPipelinesApp({
      bapToken: 'fake',
      envId: ENV_ID,
      allowPacFallback: false,
      sleepImpl: noSleep,
      pacFallbackImpl: () => { pacCalled = true; return { ok: true }; },
    }),
    /BAP applicationPackages install failed/,
  );
  assert.equal(pacCalled, false);
});

test('403 on discovery LIST → falls straight through to PAC fallback when allowed', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 403, body: 'Forbidden' }),
    },
    {
      // Should still POST to install — package name falls back to the constant
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({ statusCode: 403, body: 'Forbidden' }),
    },
  ]);
  const result = await installPipelinesApp({
    bapToken: 'fake',
    envId: ENV_ID,
    sleepImpl: noSleep,
    pacFallbackImpl: fakePacOk,
  });
  assert.equal(result.installPath, 'pac');
  assert.equal(result.packageUniqueName, 'msdyn_AppDeploymentAnchor');
});

// ── Verification probe ───────────────────────────────────────────────────────

test('post-install verification: solutions probe returns version on success', async (t) => {
  let pollCount = 0;
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: LOCATION_HEADER, 'retry-after': '1' },
        body: JSON.stringify({ properties: { provisioningState: 'Installing' } }),
      }),
    },
    {
      match: (u, args) => u === LOCATION_HEADER && args.method === 'GET',
      respond: () => {
        pollCount++;
        return { statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Installed' } }) };
      },
    },
    {
      match: (u, args) => u.startsWith(INSTANCE_API_URL) && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(SOLUTION_QUERY_HIT) }),
    },
  ]);
  const result = await installPipelinesApp({
    bapToken: 'fake',
    envId: ENV_ID,
    instanceApiUrl: INSTANCE_API_URL,
    hostToken: 'host-fake',
    sleepImpl: noSleep,
  });
  assert.equal(result.status, 'Succeeded');
  assert.equal(result.pipelinesSolutionVersion, '9.1.2026034.260325188');
});

test('verification: missing instanceApiUrl/hostToken skips probe (not a failure)', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_INSTALLED) }),
    },
  ]);
  const result = await installPipelinesApp({
    bapToken: 'fake',
    envId: ENV_ID,
    sleepImpl: noSleep,
  });
  // No verification probe when instanceApiUrl/hostToken not provided — just succeed.
  assert.equal(result.status, 'Succeeded');
  assert.equal(result.pipelinesSolutionVersion, null);
});

// ── Polling timeout ───────────────────────────────────────────────────────────

test('polling timeout: synthetic now() advances past deadline', async (t) => {
  let nowMs = 1000;
  const advance = (delta) => { nowMs += delta; };
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: LOCATION_HEADER, 'retry-after': '5' },
        body: JSON.stringify({ properties: { provisioningState: 'Installing' } }),
      }),
    },
    {
      match: (u, args) => u === LOCATION_HEADER && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Installing' } }) }),
    },
  ]);
  await assert.rejects(
    () => installPipelinesApp({
      bapToken: 'fake',
      envId: ENV_ID,
      timeoutSec: 30,
      sleepImpl: async (ms) => { advance(ms); },
      nowImpl: () => nowMs,
    }),
    /timed out after 30s/,
  );
});

test('Failed terminal state during polling → throws with state in message', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.includes('/applicationPackages?') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify(PACKAGE_LIST_AVAILABLE) }),
    },
    {
      match: (u, args) => u.includes('/install?') && args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: LOCATION_HEADER, 'retry-after': '1' },
        body: JSON.stringify({ properties: { provisioningState: 'Installing' } }),
      }),
    },
    {
      match: (u, args) => u === LOCATION_HEADER && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Failed' } }) }),
    },
  ]);
  await assert.rejects(
    () => installPipelinesApp({
      bapToken: 'fake',
      envId: ENV_ID,
      sleepImpl: noSleep,
    }),
    /ended with state "Failed"/,
  );
});
