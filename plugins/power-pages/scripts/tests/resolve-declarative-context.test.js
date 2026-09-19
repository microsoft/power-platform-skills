const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveDeclarativeContext,
} = require('../../skills/create-site/scripts/resolve-declarative-context');

const ENVIRONMENT_URL = 'https://contoso.crm.dynamics.com';
const ENVIRONMENT_ID = '11111111-1111-1111-1111-111111111111';
const ORGANIZATION_ID = '22222222-2222-2222-2222-222222222222';

function dependencies(overrides = {}) {
  return {
    getEnvironmentUrl: () => ENVIRONMENT_URL,
    getPacAuthInfo: () => ({ environmentId: ENVIRONMENT_ID, cloud: 'Public' }),
    getAuthToken: () => 'secret-token',
    makeRequest: async () => ({
      statusCode: 200,
      body: JSON.stringify({ UserId: 'user-id', OrganizationId: ORGANIZATION_ID }),
    }),
    ...overrides,
  };
}

test('returns non-secret declarative creation context', async () => {
  const result = await resolveDeclarativeContext(dependencies());
  assert.deepEqual(result, {
    environmentUrl: ENVIRONMENT_URL,
    environmentId: ENVIRONMENT_ID,
    organizationId: ORGANIZATION_ID,
    cloud: 'Public',
  });
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

test('fails when PAC does not resolve an environment', async () => {
  await assert.rejects(
    () => resolveDeclarativeContext(dependencies({ getPacAuthInfo: () => null })),
    /Power Platform CLI is not signed in/,
  );
});

test('fails when Azure CLI cannot acquire a token', async () => {
  await assert.rejects(
    () => resolveDeclarativeContext(dependencies({ getAuthToken: () => null })),
    /Azure CLI token is unavailable/,
  );
});

test('fails closed on WhoAmI authorization errors', async () => {
  await assert.rejects(
    () =>
      resolveDeclarativeContext(
        dependencies({
          makeRequest: async () => ({ statusCode: 403, body: '{}' }),
        }),
      ),
    /HTTP 403/,
  );
});

test('fails when WhoAmI omits OrganizationId', async () => {
  await assert.rejects(
    () =>
      resolveDeclarativeContext(
        dependencies({
          makeRequest: async () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u' }) }),
        }),
      ),
    /did not return OrganizationId/,
  );
});
