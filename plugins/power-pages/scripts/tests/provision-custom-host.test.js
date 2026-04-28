const test = require('node:test');
const assert = require('node:assert/strict');

const {
  provisionCustomHost,
  extractProvisioningState,
  isTerminalSucceeded,
  isTerminalFailed,
  readRetryAfterSec,
  TEMPLATE_NAME,
} = require('../lib/provision-custom-host');

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

test('TEMPLATE_NAME constant is D365_ProjectHost', () => {
  assert.equal(TEMPLATE_NAME, 'D365_ProjectHost');
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

test('throws when required args are missing', async () => {
  await assert.rejects(
    () => provisionCustomHost({ displayName: 'X', region: 'unitedstates' }),
    /--bapToken is required/,
  );
  await assert.rejects(
    () => provisionCustomHost({ bapToken: 't', region: 'unitedstates' }),
    /--displayName is required/,
  );
  await assert.rejects(
    () => provisionCustomHost({ bapToken: 't', displayName: 'X' }),
    /--region is required/,
  );
});

test('happy path — 202 → Creating → Succeeded with linkedEnvironmentMetadata captured', async (t) => {
  let pollCount = 0;
  withMockedHttp(t, [
    {
      match: (u, args) => u.endsWith('/environments?api-version=2021-04-01') && args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/lifecycleOperations/op-1?api-version=2021-04-01', 'retry-after': '1' },
        body: JSON.stringify({
          name: 'env-guid-1',
          properties: {
            displayName: 'Test Host',
            environmentSku: 'Production',
            provisioningState: 'Creating',
          },
        }),
      }),
    },
    {
      match: (u, args) => u.includes('/lifecycleOperations/op-1') && args.method === 'GET',
      respond: () => {
        pollCount++;
        if (pollCount === 1) {
          return {
            statusCode: 200,
            headers: { 'retry-after': '1' },
            body: JSON.stringify({ name: 'env-guid-1', properties: { provisioningState: 'Creating' } }),
          };
        }
        return {
          statusCode: 200,
          body: JSON.stringify({
            name: 'env-guid-1',
            properties: {
              provisioningState: 'Succeeded',
              environmentSku: 'Production',
              displayName: 'Test Host',
              linkedEnvironmentMetadata: {
                instanceUrl: 'https://testhost.crm.dynamics.com/',
                instanceApiUrl: 'https://testhost.api.crm.dynamics.com',
              },
            },
          }),
        };
      },
    },
  ]);

  const result = await provisionCustomHost({
    bapToken: 'fake',
    displayName: 'Test Host',
    region: 'unitedstates',
    sleepImpl: noSleep,
  });

  assert.equal(result.status, 'Succeeded');
  assert.equal(result.envId, 'env-guid-1');
  assert.equal(result.instanceUrl, 'https://testhost.crm.dynamics.com/');
  assert.equal(result.instanceApiUrl, 'https://testhost.api.crm.dynamics.com');
  assert.equal(result.displayName, 'Test Host');
  assert.equal(result.environmentSku, 'Production');
  assert.equal(result.provisioningState, 'Succeeded');
  assert.equal(result.pollAttempts, 2);
  assert.match(result.correlationId, /^[0-9a-f]{8}-/);
});

test('reuses provided correlationId when --correlationId is passed', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: (args) => {
        assert.equal(args.headers['x-ms-correlation-id'], 'my-cid-123');
        return {
          statusCode: 200,
          body: JSON.stringify({ name: 'e1', properties: { provisioningState: 'Succeeded', linkedEnvironmentMetadata: { instanceApiUrl: 'https://e1.api.crm.dynamics.com' } } }),
        };
      },
    },
  ]);

  const result = await provisionCustomHost({
    bapToken: 'fake', displayName: 'X', region: 'unitedstates',
    correlationId: 'my-cid-123',
    sleepImpl: noSleep,
  });
  assert.equal(result.correlationId, 'my-cid-123');
});

test('200 sync — env already provisioned returns immediately without polling', async (t) => {
  let pollCount = 0;
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({
        statusCode: 200,
        body: JSON.stringify({
          name: 'env-sync',
          properties: {
            provisioningState: 'Succeeded',
            environmentSku: 'Production',
            linkedEnvironmentMetadata: {
              instanceUrl: 'https://sync.crm.dynamics.com/',
              instanceApiUrl: 'https://sync.api.crm.dynamics.com',
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

  const result = await provisionCustomHost({
    bapToken: 'fake', displayName: 'X', region: 'unitedstates',
    sleepImpl: noSleep,
  });
  assert.equal(result.status, 'Succeeded');
  assert.equal(result.pollAttempts, 0);
  assert.equal(pollCount, 0, 'no polling expected when 200 + Succeeded synchronously');
});

test('403 → throws with admin-role guidance', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({ statusCode: 403, body: 'Forbidden' }),
    },
  ]);

  await assert.rejects(
    () => provisionCustomHost({ bapToken: 'fake', displayName: 'X', region: 'unitedstates', sleepImpl: noSleep }),
    /403.*admin/,
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
    () => provisionCustomHost({ bapToken: 'fake', displayName: 'X', region: 'unitedstates', sleepImpl: noSleep }),
    /401.*not authenticated/,
  );
});

test('400 BadRequest → throws with body', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({ statusCode: 400, body: '{"error":{"code":"InvalidRegion","message":"region not valid"}}' }),
    },
  ]);

  await assert.rejects(
    () => provisionCustomHost({ bapToken: 'fake', displayName: 'X', region: 'pluto', sleepImpl: noSleep }),
    /unexpected status 400.*InvalidRegion/,
  );
});

test('Failed terminal state → throws', async (t) => {
  let pollCount = 0;
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: 'https://api.bap.microsoft.com/op-failed', 'retry-after': '1' },
        body: JSON.stringify({ name: 'e1', properties: { provisioningState: 'Creating' } }),
      }),
    },
    {
      match: (u, args) => u.includes('op-failed') && args.method === 'GET',
      respond: () => {
        pollCount++;
        return { statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Failed' } }) };
      },
    },
  ]);

  await assert.rejects(
    () => provisionCustomHost({ bapToken: 'fake', displayName: 'X', region: 'unitedstates', sleepImpl: noSleep }),
    /ended with state "Failed"/,
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
        headers: { location: 'https://api.bap.microsoft.com/op-stuck', 'retry-after': '5' },
        body: JSON.stringify({ name: 'e1', properties: { provisioningState: 'Creating' } }),
      }),
    },
    {
      match: (u, args) => u.includes('op-stuck') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Creating' } }) }),
    },
  ]);

  await assert.rejects(
    () => provisionCustomHost({
      bapToken: 'fake', displayName: 'X', region: 'unitedstates',
      timeoutSec: 30,
      sleepImpl: async (ms) => { advance(ms); },
      nowImpl: () => nowMs,
    }),
    /timed out after 30s/,
  );
});

test('captures Location header in result for diagnostics', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: 'https://api.bap.microsoft.com/lifecycleOperations/abc', 'retry-after': '1' },
        body: JSON.stringify({ name: 'e1', properties: { provisioningState: 'Creating' } }),
      }),
    },
    {
      match: (u, args) => u.includes('/lifecycleOperations/abc') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Succeeded', linkedEnvironmentMetadata: { instanceApiUrl: 'https://e1.api.crm.dynamics.com' } } }) }),
    },
  ]);

  const result = await provisionCustomHost({ bapToken: 'fake', displayName: 'X', region: 'unitedstates', sleepImpl: noSleep });
  assert.equal(result.locationHeader, 'https://api.bap.microsoft.com/lifecycleOperations/abc');
});

test('falls back to env GET when lifecycle op response lacks linkedEnvironmentMetadata', async (t) => {
  withMockedHttp(t, [
    {
      match: (u, args) => u.endsWith('/environments?api-version=2021-04-01') && args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: 'https://api.bap.microsoft.com/op-1', 'retry-after': '1' },
        body: JSON.stringify({ name: 'env-id-x', properties: { provisioningState: 'Creating' } }),
      }),
    },
    {
      match: (u, args) => u.includes('/op-1') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Succeeded' } }) }),
    },
    {
      match: (u, args) => u.includes('/environments/env-id-x') && args.method === 'GET',
      respond: () => ({ statusCode: 200, body: JSON.stringify({ name: 'env-id-x', properties: { environmentSku: 'Production', linkedEnvironmentMetadata: { instanceUrl: 'https://x.crm.dynamics.com/', instanceApiUrl: 'https://x.api.crm.dynamics.com' } } }) }),
    },
  ]);

  const result = await provisionCustomHost({ bapToken: 'fake', displayName: 'X', region: 'unitedstates', sleepImpl: noSleep });
  assert.equal(result.status, 'Succeeded');
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
    () => provisionCustomHost({ bapToken: 'fake', displayName: 'X', region: 'unitedstates', sleepImpl: noSleep }),
    /BAP env-create POST failed/,
  );
});

test('5xx during polling is treated as transient — keeps polling', async (t) => {
  let pollCount = 0;
  withMockedHttp(t, [
    {
      match: (u, args) => args.method === 'POST',
      respond: () => ({
        statusCode: 202,
        headers: { location: 'https://api.bap.microsoft.com/op-flaky', 'retry-after': '1' },
        body: JSON.stringify({ name: 'e1', properties: { provisioningState: 'Creating' } }),
      }),
    },
    {
      match: (u, args) => u.includes('op-flaky') && args.method === 'GET',
      respond: () => {
        pollCount++;
        if (pollCount === 1) return { statusCode: 503, body: 'Service Unavailable' };
        if (pollCount === 2) return { statusCode: 502, body: 'Bad Gateway' };
        return { statusCode: 200, body: JSON.stringify({ properties: { provisioningState: 'Succeeded', linkedEnvironmentMetadata: { instanceApiUrl: 'https://e1.api.crm.dynamics.com' } } }) };
      },
    },
  ]);

  const result = await provisionCustomHost({
    bapToken: 'fake', displayName: 'X', region: 'unitedstates',
    sleepImpl: noSleep,
  });
  assert.equal(result.status, 'Succeeded');
  assert.equal(pollCount, 3);
});
