const test = require('node:test');
const assert = require('node:assert/strict');

const {
  API_VERSION,
  normalizeOptions,
  validateOperationLocation,
  provisionWebsite,
} = require('../../skills/activate-site/scripts/activate-site');

const IDS = {
  environmentId: '11111111-1111-1111-1111-111111111111',
  organizationId: '22222222-2222-2222-2222-222222222222',
  websiteRecordId: '33333333-3333-3333-3333-333333333333',
};

function validOptions(overrides = {}) {
  return {
    siteName: 'Contoso Programs',
    subdomain: 'contoso-programs',
    environmentId: IDS.environmentId,
    organizationId: IDS.organizationId,
    cloud: 'Public',
    templateName: 'ProgramRegistration',
    selectedBaseLanguage: '1033',
    ...overrides,
  };
}

test('uses the current documented Create Website API version', () => {
  assert.equal(API_VERSION, '2024-10-01');
});

test('normalizeOptions preserves an allowed template and LCID', () => {
  const result = normalizeOptions(validOptions());
  assert.equal(result.templateName, 'ProgramRegistration');
  assert.equal(result.selectedBaseLanguage, 1033);
});

test('normalizeOptions accepts the Event Portal template identifier', () => {
  const result = normalizeOptions(validOptions({ templateName: 'EventPortal' }));
  assert.equal(result.templateName, 'EventPortal');
});

test('normalizeOptions accepts the Blank page template identifier', () => {
  const result = normalizeOptions(validOptions({ templateName: 'BlankPage' }));
  assert.equal(result.templateName, 'BlankPage');
});

test('normalizeOptions keeps the legacy documented default for code-site activation', () => {
  const result = normalizeOptions(validOptions({ templateName: undefined }));
  assert.equal(result.templateName, 'DefaultPortalTemplate');
});

test('normalizeOptions rejects unsupported template identifiers', () => {
  assert.throws(
    () => normalizeOptions(validOptions({ templateName: 'Friendly Display Name' })),
    /Unsupported --templateName/,
  );
});

test('normalizeOptions rejects malformed resource identifiers and subdomains', () => {
  assert.throws(
    () => normalizeOptions(validOptions({ environmentId: 'not-a-guid' })),
    /environmentId/,
  );
  assert.throws(
    () => normalizeOptions(validOptions({ subdomain: 'Bad Subdomain!' })),
    /subdomain/,
  );
  assert.throws(
    () => normalizeOptions(validOptions({ subdomain: 'a' })),
    /subdomain/,
  );
});

test('validateOperationLocation accepts same-origin paths and adds api-version', () => {
  const initiating =
    `https://api.powerplatform.com/powerpages/environments/${IDS.environmentId}/websites` +
    `?api-version=${API_VERSION}`;
  const result = validateOperationLocation('/operations/abc', initiating);
  assert.equal(new URL(result).origin, 'https://api.powerplatform.com');
  assert.equal(new URL(result).searchParams.get('api-version'), API_VERSION);
});

test('validateOperationLocation rejects a different host', () => {
  const initiating =
    `https://api.powerplatform.com/powerpages/environments/${IDS.environmentId}/websites` +
    `?api-version=${API_VERSION}`;
  assert.throws(
    () => validateOperationLocation('https://api.bap.microsoft.com/operations/abc', initiating),
    /different host/,
  );
});

test('provisionWebsite submits the selected template and returns the created identity', async () => {
  const requests = [];
  const responses = [
    {
      statusCode: 202,
      body: '',
      headers: { 'operation-location': '/operations/abc' },
    },
    {
      statusCode: 200,
      body: JSON.stringify({
        operationStatus: 'OperationComplete',
        websiteUrl: 'https://contoso-programs.powerappsportals.com',
        websiteRecordId: IDS.websiteRecordId,
      }),
      headers: {},
    },
  ];

  const result = await provisionWebsite(validOptions(), {
    getAuthToken: () => 'token',
    makeRequest: async (request) => {
      requests.push(request);
      return responses.shift();
    },
    sleep: async () => {},
    pollIntervalMs: 1,
    maxAttempts: 1,
  });

  assert.equal(result.status, 'Succeeded');
  assert.equal(result.websiteRecordId, IDS.websiteRecordId);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /api-version=2024-10-01/);
  const body = JSON.parse(requests[0].body);
  assert.equal(body.templateName, 'ProgramRegistration');
  assert.equal(body.selectedBaseLanguage, 1033);
  assert.equal(Object.hasOwn(body, 'websiteRecordId'), false);
});

test('provisionWebsite preserves the legacy code-site activation payload', async () => {
  const requests = [];
  const responses = [
    {
      statusCode: 202,
      body: '',
      headers: { 'operation-location': '/operations/code-site' },
    },
    {
      statusCode: 200,
      body: JSON.stringify({ operationStatus: 'OperationComplete' }),
      headers: {},
    },
  ];

  const result = await provisionWebsite(
    validOptions({
      templateName: undefined,
      selectedBaseLanguage: undefined,
      websiteRecordId: IDS.websiteRecordId,
    }),
    {
      getAuthToken: () => 'token',
      makeRequest: async (request) => {
        requests.push(request);
        return responses.shift();
      },
      sleep: async () => {},
      pollIntervalMs: 1,
      maxAttempts: 1,
    },
  );

  const body = JSON.parse(requests[0].body);
  assert.equal(result.status, 'Succeeded');
  assert.equal(body.templateName, 'DefaultPortalTemplate');
  assert.equal(body.selectedBaseLanguage, 1033);
  assert.equal(body.websiteRecordId, IDS.websiteRecordId);
});

test('provisionWebsite preserves resumable state when polling times out', async () => {
  const responses = [
    {
      statusCode: 202,
      body: '',
      headers: { 'Operation-Location': '/operations/abc' },
    },
    {
      statusCode: 200,
      body: JSON.stringify({ operationStatus: 'OperationInProgress' }),
      headers: {},
    },
  ];

  const result = await provisionWebsite(validOptions(), {
    getAuthToken: () => 'token',
    makeRequest: async () => responses.shift(),
    sleep: async () => {},
    pollIntervalMs: 1,
    maxAttempts: 1,
  });

  assert.equal(result.status, 'Running');
  assert.equal(result.websiteRecordId, null);
  assert.match(result.operationLocation, /\/operations\/abc/);
});

test('provisionWebsite resumes an accepted operation without sending another POST', async () => {
  const requests = [];
  const result = await provisionWebsite(
    validOptions({
      operationLocation:
        `https://api.powerplatform.com/powerpages/environments/${IDS.environmentId}` +
        '/operations/abc?api-version=2024-10-01',
    }),
    {
      getAuthToken: () => 'token',
      makeRequest: async (request) => {
        requests.push(request);
        return {
          statusCode: 200,
          body: JSON.stringify({
            operationStatus: 'OperationComplete',
            websiteRecordId: IDS.websiteRecordId,
          }),
          headers: {},
        };
      },
      sleep: async () => {},
      pollIntervalMs: 1,
      maxAttempts: 1,
    },
  );

  assert.equal(result.status, 'Succeeded');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, undefined);
  assert.match(requests[0].url, /\/operations\/abc/);
});

test('provisionWebsite surfaces non-202 service errors', async () => {
  const result = await provisionWebsite(validOptions(), {
    getAuthToken: () => 'token',
    makeRequest: async () => ({
      statusCode: 400,
      body: JSON.stringify({ error: { code: 'InvalidTemplate', message: 'Template unavailable' } }),
      headers: {},
    }),
  });

  assert.equal(result.status, 'Failed');
  assert.equal(result.statusCode, 400);
  assert.equal(result.errorCode, 'InvalidTemplate');
});
