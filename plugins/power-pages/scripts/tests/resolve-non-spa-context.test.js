const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveNonSpaContext,
} = require('../../skills/create-site/scripts/resolve-non-spa-context');

const ENVIRONMENT_URL = 'https://contoso.crm.dynamics.com';
const ENVIRONMENT_ID = '11111111-1111-1111-1111-111111111111';
const ORGANIZATION_ID = '22222222-2222-2222-2222-222222222222';

function dependencies(overrides = {}) {
  return {
    getEnvironmentUrl: () => ENVIRONMENT_URL,
    getPacAuthInfo: () => ({ environmentId: ENVIRONMENT_ID, cloud: 'Public' }),
    getAuthToken: () => 'secret-token',
    makeRequest: async ({ url }) => {
      if (url.endsWith('/WhoAmI')) {
        return {
          statusCode: 200,
          body: JSON.stringify({ UserId: 'user-id', OrganizationId: ORGANIZATION_ID }),
        };
      }
      if (url.includes(`/organizations(${ORGANIZATION_ID})`)) {
        return {
          statusCode: 200,
          body: JSON.stringify({ languagecode: 1033 }),
        };
      }
      if (url.includes('/languagelocale?')) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            value: [{
              localeid: 1033,
              name: 'English (United States)',
              code: 'en-US',
              language: 'English',
              region: 'United States',
            }],
          }),
        };
      }
      throw new Error(`Unexpected request URL: ${url}`);
    },
    ...overrides,
  };
}

test('returns non-secret non-SPA creation context', async () => {
  const requests = [];
  const deps = dependencies();
  const request = deps.makeRequest;
  deps.makeRequest = async (options) => {
    requests.push(options);
    return request(options);
  };

  const result = await resolveNonSpaContext(deps);
  assert.deepEqual(result, {
    environmentUrl: ENVIRONMENT_URL,
    environmentId: ENVIRONMENT_ID,
    organizationId: ORGANIZATION_ID,
    organizationBaseLanguageLcid: 1033,
    organizationBaseLanguage: {
      lcid: 1033,
      name: 'English (United States)',
      code: 'en-US',
      language: 'English',
      region: 'United States',
    },
    cloud: 'Public',
  });
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
  assert.equal(requests.length, 3);
  assert.match(requests[1].url, /organizations\(22222222-2222-2222-2222-222222222222\)/);
  assert.match(requests[1].url, /\?\$select=languagecode$/);
  assert.match(requests[2].url, /\/languagelocale\?/);
  assert.match(requests[2].url, /localeid%20eq%201033/);
});

test('fails when PAC does not resolve an environment', async () => {
  await assert.rejects(
    () => resolveNonSpaContext(dependencies({ getPacAuthInfo: () => null })),
    /Power Platform CLI is not signed in/,
  );
});

test('fails when Azure CLI cannot acquire a token', async () => {
  await assert.rejects(
    () => resolveNonSpaContext(dependencies({ getAuthToken: () => null })),
    /Azure CLI token is unavailable/,
  );
});

test('fails closed on WhoAmI authorization errors', async () => {
  await assert.rejects(
    () =>
      resolveNonSpaContext(
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
      resolveNonSpaContext(
        dependencies({
          makeRequest: async () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u' }) }),
        }),
      ),
    /did not return OrganizationId/,
  );
});

test('fails closed when the organization base language cannot be read', async () => {
  const deps = dependencies();
  const request = deps.makeRequest;
  deps.makeRequest = async (options) => {
    if (options.url.includes('/organizations(')) {
      return { statusCode: 403, body: '{}' };
    }
    return request(options);
  };

  await assert.rejects(
    () => resolveNonSpaContext(deps),
    /organization language request returned HTTP 403/,
  );
});

test('fails when the organization base language is missing or invalid', async () => {
  const deps = dependencies();
  const request = deps.makeRequest;
  deps.makeRequest = async (options) => {
    if (options.url.includes('/organizations(')) {
      return { statusCode: 200, body: JSON.stringify({ languagecode: 0 }) };
    }
    return request(options);
  };

  await assert.rejects(
    () => resolveNonSpaContext(deps),
    /positive integer languagecode/,
  );
});

test('fails closed when language locale display metadata cannot be read', async () => {
  const deps = dependencies();
  const request = deps.makeRequest;
  deps.makeRequest = async (options) => {
    if (options.url.includes('/languagelocale?')) {
      return { statusCode: 403, body: '{}' };
    }
    return request(options);
  };

  await assert.rejects(
    () => resolveNonSpaContext(deps),
    /language locale request returned HTTP 403/,
  );
});

test('fails when the base LCID has no named active language locale', async () => {
  const deps = dependencies();
  const request = deps.makeRequest;
  deps.makeRequest = async (options) => {
    if (options.url.includes('/languagelocale?')) {
      return { statusCode: 200, body: JSON.stringify({ value: [] }) };
    }
    return request(options);
  };

  await assert.rejects(
    () => resolveNonSpaContext(deps),
    /did not return display metadata for LCID 1033/,
  );
});
