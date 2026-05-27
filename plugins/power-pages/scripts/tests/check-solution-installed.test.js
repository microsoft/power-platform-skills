'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('../lib/validation-helpers');
const { checkSolutionInstalled } = require('../lib/check-solution-installed');

const ENV_URL = 'https://contoso.crm.dynamics.com';
const TOKEN = 'fake-token';
const SOLUTION = 'msdynce_PortalPrivacyExtensions';

function withMockedRequests(t, handler) {
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (opts) => {
    calls.push(opts);
    return handler(opts, calls.length);
  };
  t.after(() => { helpers.makeRequest = orig; });
  return calls;
}

test('rejects missing envUrl, token, solutionName', async () => {
  await assert.rejects(
    () => checkSolutionInstalled({ token: TOKEN, solutionName: SOLUTION }),
    /envUrl is required/
  );
  await assert.rejects(
    () => checkSolutionInstalled({ envUrl: ENV_URL, solutionName: SOLUTION }),
    /token is required/
  );
  await assert.rejects(
    () => checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN }),
    /solutionName is required/
  );
});

test('rejects solution unique names with disallowed characters', async () => {
  await assert.rejects(
    () => checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: 'has space' }),
    /Invalid solution unique name/
  );
  await assert.rejects(
    () => checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: "'; DROP TABLE solutions; --" }),
    /Invalid solution unique name/
  );
  await assert.rejects(
    () => checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: 'name/with/slashes' }),
    /Invalid solution unique name/
  );
});

test('returns installed:true with version when the solution row exists', async (t) => {
  const calls = withMockedRequests(t, () => ({
    statusCode: 200,
    body: JSON.stringify({
      value: [
        { uniquename: SOLUTION, version: '1.0.0.5' },
      ],
    }),
  }));

  const result = await checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: SOLUTION });

  assert.deepEqual(result, { installed: true, solutionName: SOLUTION, version: '1.0.0.5' });
  assert.equal(calls.length, 1);
  // OData query is well-formed: targets /api/data/v9.2/solutions and filters by uniquename
  assert.match(calls[0].url, /\/api\/data\/v9\.2\/solutions/);
  assert.match(calls[0].url, /uniquename%20eq%20'msdynce_PortalPrivacyExtensions'/);
  assert.match(calls[0].url, /\$top=1/);
  assert.match(calls[0].url, /\$select=uniquename,version/);
  // Auth header is the bearer token
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
});

test('returns installed:false when the solutions table has no matching row', async (t) => {
  withMockedRequests(t, () => ({
    statusCode: 200,
    body: JSON.stringify({ value: [] }),
  }));

  const result = await checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: SOLUTION });
  assert.deepEqual(result, { installed: false, solutionName: SOLUTION });
});

test('version field is null when the response row omits it', async (t) => {
  withMockedRequests(t, () => ({
    statusCode: 200,
    body: JSON.stringify({ value: [{ uniquename: SOLUTION }] }),
  }));

  const result = await checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: SOLUTION });
  assert.equal(result.installed, true);
  assert.equal(result.version, null);
});

test('throws with a helpful message on network error', async (t) => {
  withMockedRequests(t, () => ({ error: 'ECONNREFUSED' }));

  await assert.rejects(
    () => checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: SOLUTION }),
    /Solution query failed: ECONNREFUSED/
  );
});

test('throws with auth-specific message on 401', async (t) => {
  withMockedRequests(t, () => ({ statusCode: 401, body: '' }));

  await assert.rejects(
    () => checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: SOLUTION }),
    /Authentication \/ authorization failed \(401\)/
  );
});

test('throws with auth-specific message on 403 (likely missing solutions-table read permission)', async (t) => {
  withMockedRequests(t, () => ({ statusCode: 403, body: '' }));

  await assert.rejects(
    () => checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: SOLUTION }),
    /Authentication \/ authorization failed \(403\)/
  );
});

test('throws on unexpected status code with the response body included', async (t) => {
  withMockedRequests(t, () => ({ statusCode: 500, body: 'Internal Server Error' }));

  await assert.rejects(
    () => checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: SOLUTION }),
    /Unexpected response \(500\): Internal Server Error/
  );
});

test('throws when the response body is not valid JSON', async (t) => {
  withMockedRequests(t, () => ({ statusCode: 200, body: '<html>not json</html>' }));

  await assert.rejects(
    () => checkSolutionInstalled({ envUrl: ENV_URL, token: TOKEN, solutionName: SOLUTION }),
    /Failed to parse Dataverse response as JSON/
  );
});
