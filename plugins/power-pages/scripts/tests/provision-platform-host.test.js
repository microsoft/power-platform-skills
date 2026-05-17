const test = require('node:test');
const assert = require('node:assert/strict');

const {
  provisionPlatformHost,
  extractProvisioningState,
  isTerminalSucceeded,
  isTerminalFailed,
  readRetryAfterSec,
  TEMPLATE_NAME,
  ENVIRONMENT_SKU,
} = require('../lib/provision-platform-host');

const noSleep = async () => {};

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

test('TEMPLATE_NAME constant is D365_1stPartyAdminApps', () => {
  assert.equal(TEMPLATE_NAME, 'D365_1stPartyAdminApps');
});

test('ENVIRONMENT_SKU constant is Platform', () => {
  assert.equal(ENVIRONMENT_SKU, 'Platform');
});

test('throws when bapToken is missing', async () => {
  await assert.rejects(
    () => provisionPlatformHost({}),
    /--bapToken is required/,
  );
});

test('endpoint URL targets /environments/getOrCreate (BAP environments RP)', async (t) => {
  // Regression guard: the prior test asserted `/getOrCreate` (no `/environments/`
  // prefix) — that path returns 404 from BAP. The correct endpoint is
  // `/providers/Microsoft.BusinessAppPlatform/environments/getOrCreate`, same
  // base as the rest of the BAP environments RP. Confirmed live against a
  // tenant where the existing PE (`PlatformEnv-unitedstates`,
  // envId 8916a7c4-8c4c-e041-ad42-aa9980ff6810) was only reachable via the
  // `/environments/` prefix.
  let capturedUrl = null;
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: (args) => {
        capturedUrl = args.url;
        return {
          statusCode: 200,
          body: JSON.stringify({
            name: 'pe-existing',
            properties: {
              provisioningState: 'Succeeded',
              environmentSku: 'Platform',
              displayName: 'Default-tenant-Pipelines',
              linkedEnvironmentMetadata: { instanceApiUrl: 'https://pe.api.crm.dynamics.com' },
            },
          }),
        };
      },
    },
  ]);

  await provisionPlatformHost({ bapToken: 'fake', sleepImpl: noSleep });

  assert.ok(capturedUrl, 'URL should be captured');
  assert.match(capturedUrl, /\/providers\/Microsoft\.BusinessAppPlatform\/environments\/getOrCreate\?api-version=2021-04-01$/,
    'endpoint must target /environments/getOrCreate — BAP returns 404 without the /environments/ prefix');
});

test('200 + Succeeded — idempotent existing PE returns alreadyExisted=true', async (t) => {
  let pollCount = 0;
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({
        statusCode: 200,
        body: JSON.stringify({
          name: 'pe-existing-guid',
          properties: {
            provisioningState: 'Succeeded',
            environmentSku: 'Platform',
            displayName: 'Default-Contoso-Pipelines',
            linkedEnvironmentMetadata: {
              instanceUrl: 'https://existing.crm.dynamics.com/',
              instanceApiUrl: 'https://existing.api.crm.dynamics.com',
            },
          },
        }),
      }),
    },
    {
      match: () => true,
      respond: () => { pollCount++; return { statusCode: 200, body: '{}' }; },
    },
  ]);

  const result = await provisionPlatformHost({
    bapToken: 'fake',
    sleepImpl: noSleep,
  });

  assert.equal(result.status, 'Succeeded');
  assert.equal(result.alreadyExisted, true,
    '200 + Succeeded means tenant already had a PE; alreadyExisted must be true');
  assert.equal(result.pollAttempts, 0, 'no polling expected on 200 idempotent path');
  assert.equal(pollCount, 0);
  assert.equal(result.envId, 'pe-existing-guid');
  assert.equal(result.instanceUrl, 'https://existing.crm.dynamics.com/');
  assert.equal(result.instanceApiUrl, 'https://existing.api.crm.dynamics.com');
  assert.equal(result.displayName, 'Default-Contoso-Pipelines');
  assert.equal(result.environmentSku, 'Platform');
});

test('202 → poll → Succeeded — newly provisioned PE returns alreadyExisted=false', async (t) => {
  let pollCount = 0;
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: {
          location: 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/lifecycleOperations/op-pe-1?api-version=2021-04-01',
          'retry-after': '1',
        },
        body: JSON.stringify({
          name: 'pe-new-guid',
          properties: {
            provisioningState: 'Creating',
            environmentSku: 'Platform',
            displayName: 'Default-Tenant-Pipelines',
          },
        }),
      }),
    },
    {
      match: (u, args) => u.includes('/lifecycleOperations/op-pe-1') && args.method === 'GET',
      respond: () => {
        pollCount++;
        if (pollCount === 1) {
          return {
            statusCode: 200,
            headers: { 'retry-after': '1' },
            body: JSON.stringify({ name: 'pe-new-guid', properties: { provisioningState: 'Creating' } }),
          };
        }
        return {
          statusCode: 200,
          body: JSON.stringify({
            name: 'pe-new-guid',
            properties: {
              provisioningState: 'Succeeded',
              environmentSku: 'Platform',
              displayName: 'Default-Tenant-Pipelines',
              linkedEnvironmentMetadata: {
                instanceUrl: 'https://newpe.crm.dynamics.com/',
                instanceApiUrl: 'https://newpe.api.crm.dynamics.com',
              },
            },
          }),
        };
      },
    },
  ]);

  const result = await provisionPlatformHost({
    bapToken: 'fake',
    sleepImpl: noSleep,
  });

  assert.equal(result.status, 'Succeeded');
  assert.equal(result.alreadyExisted, false,
    '202 + poll → Succeeded means tenant did NOT have a PE; alreadyExisted must be false');
  assert.equal(result.envId, 'pe-new-guid');
  assert.equal(result.instanceUrl, 'https://newpe.crm.dynamics.com/');
  assert.equal(result.instanceApiUrl, 'https://newpe.api.crm.dynamics.com');
  assert.equal(result.displayName, 'Default-Tenant-Pipelines');
  assert.equal(result.environmentSku, 'Platform');
  assert.equal(result.pollAttempts, 2);
  assert.match(result.correlationId, /^[0-9a-f]{8}-/);
});

test('request body contains exactly Platform SKU + D365_1stPartyAdminApps template', async (t) => {
  let capturedBody = null;
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: (args) => {
        try { capturedBody = JSON.parse(args.body); } catch { capturedBody = args.body; }
        return {
          statusCode: 200,
          body: JSON.stringify({
            properties: {
              provisioningState: 'Succeeded',
              linkedEnvironmentMetadata: { instanceApiUrl: 'https://e.api.crm.dynamics.com' },
            },
          }),
        };
      },
    },
  ]);

  await provisionPlatformHost({ bapToken: 'fake', sleepImpl: noSleep });

  assert.equal(capturedBody.properties.environmentSku, 'Platform',
    'getOrCreate request body must specify Platform SKU');
  assert.equal(capturedBody.properties.linkedEnvironmentMetadata.templates[0], 'D365_1stPartyAdminApps',
    'getOrCreate request body must use the D365_1stPartyAdminApps template');
  assert.equal(capturedBody.properties.location, undefined,
    'getOrCreate body must NOT include location — BAP picks tenant home geo');
  assert.equal(capturedBody.properties.displayName, undefined,
    'getOrCreate body must NOT include displayName — BAP picks default name');
  assert.equal(capturedBody.properties.databaseType, undefined,
    'getOrCreate body must NOT include databaseType — implicit for Platform SKU');
});

test('reuses provided correlationId when --correlationId is passed', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: (args) => {
        assert.equal(args.headers['x-ms-correlation-id'], 'pe-cid-456');
        return {
          statusCode: 200,
          body: JSON.stringify({ name: 'e1', properties: { provisioningState: 'Succeeded', linkedEnvironmentMetadata: { instanceApiUrl: 'https://e1.api.crm.dynamics.com' } } }),
        };
      },
    },
  ]);

  const result = await provisionPlatformHost({
    bapToken: 'fake',
    correlationId: 'pe-cid-456',
    sleepImpl: noSleep,
  });
  assert.equal(result.correlationId, 'pe-cid-456');
});

test('403 → throws WITHOUT admin-role guidance (PE provisioning does not require admin)', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({ statusCode: 403, body: '{"error":{"code":"TenantPolicyDisallows","message":"Platform Host provisioning is disabled by tenant policy"}}' }),
    },
  ]);

  await assert.rejects(
    () => provisionPlatformHost({ bapToken: 'fake', sleepImpl: noSleep }),
    (err) => {
      assert.match(err.message, /403/);
      assert.match(err.message, /tenant policy|az logout/i);
      assert.doesNotMatch(err.message, /Global \/ Power Platform \/ Dynamics admin/,
        'PE getOrCreate must NOT reuse the Custom Host admin-required copy');
      return true;
    },
  );
});

test('401 → throws with reauth guidance', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({ statusCode: 401, body: 'Unauthorized' }),
    },
  ]);

  await assert.rejects(
    () => provisionPlatformHost({ bapToken: 'fake', sleepImpl: noSleep }),
    /401.*not authenticated/,
  );
});

test('400 BadRequest → throws with body', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({ statusCode: 400, body: '{"error":{"code":"InvalidArgument","message":"bad body"}}' }),
    },
  ]);

  await assert.rejects(
    () => provisionPlatformHost({ bapToken: 'fake', sleepImpl: noSleep }),
    /unexpected status 400.*InvalidArgument/,
  );
});

test('Failed terminal state during polling → throws', async (t) => {
  let pollCount = 0;
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: 'https://api.bap.microsoft.com/op-pe-failed', 'retry-after': '1' },
        body: JSON.stringify({ name: 'e1', properties: { provisioningState: 'Creating' } }),
      }),
    },
    {
      match: (u, args) => u.includes('op-pe-failed') && args.method === 'GET',
      respond: () => {
        pollCount++;
        return { statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Failed' } }) };
      },
    },
  ]);

  await assert.rejects(
    () => provisionPlatformHost({ bapToken: 'fake', sleepImpl: noSleep }),
    /Platform Host provisioning ended with state "Failed"/,
  );
  assert.equal(pollCount, 1);
});

test('polling timeout — synthetic now() advances past deadline', async (t) => {
  let nowMs = 1000;
  const advance = (delta) => { nowMs += delta; };
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: 'https://api.bap.microsoft.com/op-pe-stuck', 'retry-after': '5' },
        body: JSON.stringify({ name: 'e1', properties: { provisioningState: 'Creating' } }),
      }),
    },
    {
      match: (u, args) => u.includes('op-pe-stuck') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Creating' } }) }),
    },
  ]);

  await assert.rejects(
    () => provisionPlatformHost({
      bapToken: 'fake',
      timeoutSec: 30,
      sleepImpl: async (ms) => { advance(ms); },
      nowImpl: () => nowMs,
    }),
    /Platform Host provisioning timed out after 30s/,
  );
});

test('captures Location header in result for diagnostics', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: 'https://api.bap.microsoft.com/lifecycleOperations/pe-loc', 'retry-after': '1' },
        body: JSON.stringify({ name: 'e1', properties: { provisioningState: 'Creating' } }),
      }),
    },
    {
      match: (u, args) => u.includes('/lifecycleOperations/pe-loc') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Succeeded', linkedEnvironmentMetadata: { instanceApiUrl: 'https://e1.api.crm.dynamics.com' } } }) }),
    },
  ]);

  const result = await provisionPlatformHost({ bapToken: 'fake', sleepImpl: noSleep });
  assert.equal(result.locationHeader, 'https://api.bap.microsoft.com/lifecycleOperations/pe-loc');
  assert.equal(result.alreadyExisted, false);
});

test('falls back to env GET when lifecycle op response lacks linkedEnvironmentMetadata', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.endsWith('/getOrCreate?api-version=2021-04-01') && args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: 'https://api.bap.microsoft.com/op-pe-x', 'retry-after': '1' },
        body: JSON.stringify({ name: 'pe-id-x', properties: { provisioningState: 'Creating' } }),
      }),
    },
    {
      match: (u, args) => u.includes('/op-pe-x') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Succeeded' } }) }),
    },
    {
      match: (u, args) => u.includes('/environments/pe-id-x') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify({ name: 'pe-id-x', properties: { environmentSku: 'Platform', displayName: 'Default-Tenant-Pipelines', linkedEnvironmentMetadata: { instanceUrl: 'https://x.crm.dynamics.com/', instanceApiUrl: 'https://x.api.crm.dynamics.com' } } }) }),
    },
  ]);

  const result = await provisionPlatformHost({ bapToken: 'fake', sleepImpl: noSleep });
  assert.equal(result.status, 'Succeeded');
  assert.equal(result.alreadyExisted, false);
  assert.equal(result.instanceUrl, 'https://x.crm.dynamics.com/');
  assert.equal(result.instanceApiUrl, 'https://x.api.crm.dynamics.com');
});

test('transport error during POST is surfaced clearly', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({ error: 'getaddrinfo ENOTFOUND' }),
    },
  ]);

  await assert.rejects(
    () => provisionPlatformHost({ bapToken: 'fake', sleepImpl: noSleep }),
    /BAP getOrCreate POST failed/,
  );
});

test('5xx during polling is treated as transient — keeps polling', async (t) => {
  let pollCount = 0;
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: 'https://api.bap.microsoft.com/op-pe-flaky', 'retry-after': '1' },
        body: JSON.stringify({ name: 'e1', properties: { provisioningState: 'Creating' } }),
      }),
    },
    {
      match: (u, args) => u.includes('op-pe-flaky') && args.method === 'GET',
      respond: () => {
        pollCount++;
        if (pollCount === 1) return { statusCode: 503, body: 'Service Unavailable' };
        if (pollCount === 2) return { statusCode: 502, body: 'Bad Gateway' };
        return { statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Succeeded', linkedEnvironmentMetadata: { instanceApiUrl: 'https://e1.api.crm.dynamics.com' } } }) };
      },
    },
  ]);

  const result = await provisionPlatformHost({
    bapToken: 'fake',
    sleepImpl: noSleep,
  });
  assert.equal(result.status, 'Succeeded');
  assert.equal(result.alreadyExisted, false);
  assert.equal(pollCount, 3);
});

test('extractProvisioningState handles multiple lifecycle-op response shapes', () => {
  assert.equal(extractProvisioningState({ properties: { provisioningState: 'Succeeded' } }), 'Succeeded');
  assert.equal(extractProvisioningState({ state: 'Running' }), 'Running');
  assert.equal(extractProvisioningState({ status: { code: 'Succeeded' } }), 'Succeeded');
  assert.equal(extractProvisioningState({ status: 'Failed' }), 'Failed');
  assert.equal(extractProvisioningState({}), null);
  assert.equal(extractProvisioningState(null), null);
});

test('isTerminalSucceeded / isTerminalFailed are case-insensitive', () => {
  assert.equal(isTerminalSucceeded('Succeeded'), true);
  assert.equal(isTerminalSucceeded('succeeded'), true);
  assert.equal(isTerminalSucceeded('Creating'), false);
  assert.equal(isTerminalFailed('Failed'), true);
  assert.equal(isTerminalFailed('Canceled'), true);
  assert.equal(isTerminalFailed('Cancelled'), true);
  assert.equal(isTerminalFailed('Succeeded'), false);
});

test('readRetryAfterSec parses numeric headers; ignores invalid values', () => {
  assert.equal(readRetryAfterSec({ 'retry-after': '15' }), 15);
  assert.equal(readRetryAfterSec({ 'Retry-After': '20' }), 20);
  assert.equal(readRetryAfterSec({ 'retry-after': 'soon' }), null);
  assert.equal(readRetryAfterSec({}), null);
  assert.equal(readRetryAfterSec(null), null);
});
