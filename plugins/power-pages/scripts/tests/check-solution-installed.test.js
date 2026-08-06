'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const helpers = require('../lib/validation-helpers');
const { checkSolutionInstalled, sanitizeEnvUrl } = require('../lib/check-solution-installed');

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

// --- sanitizeEnvUrl: trusted token and request destination enforcement ---
//
// The shared validator restricts token resources and authenticated requests to
// known Microsoft Dataverse hosts. getAuthToken also passes the URL as one
// execFileSync argument, so shell metacharacters are never command syntax.

test('sanitizeEnvUrl accepts a plain Dataverse URL and returns just the origin', () => {
  assert.equal(
    sanitizeEnvUrl('https://contoso.crm.dynamics.com'),
    'https://contoso.crm.dynamics.com'
  );
});

test('sanitizeEnvUrl rejects paths, queries, and fragments', () => {
  assert.throws(
    () => sanitizeEnvUrl('https://contoso.crm.dynamics.com/api/data/v9.2/solutions'),
    /without a path or query/,
  );
  assert.throws(
    () => sanitizeEnvUrl('https://contoso.crm.dynamics.com?$top=1'),
    /without a path or query/,
  );
  assert.throws(
    () => sanitizeEnvUrl('https://contoso.crm.dynamics.com#hash'),
    /must not contain a fragment/,
  );
});

test('sanitizeEnvUrl rejects explicit ports', () => {
  assert.throws(
    () => sanitizeEnvUrl('https://contoso.crm.dynamics.com:8443'),
    /must not contain a port/,
  );
  assert.throws(() => sanitizeEnvUrl('https://contoso.crm.dynamics.com:443'), /must not contain a port/);
});

test('sanitizeEnvUrl strips a trailing slash by normalizing to origin', () => {
  assert.equal(
    sanitizeEnvUrl('https://contoso.crm.dynamics.com/'),
    'https://contoso.crm.dynamics.com'
  );
});

test('sanitizeEnvUrl rejects shell-injection payloads embedded in the URL', () => {
  assert.throws(() => sanitizeEnvUrl('https://contoso.crm.dynamics.com/;echo-marker'));
  assert.throws(() => sanitizeEnvUrl('https://contoso.crm.dynamics.com/&echo-marker%PATH%'));
  assert.throws(() => sanitizeEnvUrl('https://contoso\ndynamics.com'), /control characters/);
  assert.throws(() => sanitizeEnvUrl('https://contoso\tdynamics.com'), /control characters/);
});

test('sanitizeEnvUrl rejects non-https protocols', () => {
  assert.throws(() => sanitizeEnvUrl('http://contoso.crm.dynamics.com'),  /must use HTTPS/);
  assert.throws(() => sanitizeEnvUrl('file:///etc/passwd'),               /must use HTTPS/);
  assert.throws(() => sanitizeEnvUrl('javascript:alert(1)'),              /must use HTTPS/);
});

test('sanitizeEnvUrl rejects URLs containing userinfo (credentials)', () => {
  assert.throws(
    () => sanitizeEnvUrl('https://attacker:pwn@contoso.crm.dynamics.com'),
    /must not contain credentials/
  );
  assert.throws(
    () => sanitizeEnvUrl('https://attacker@contoso.crm.dynamics.com'),
    /must not contain credentials/
  );
});

test('sanitizeEnvUrl rejects garbage input', () => {
  assert.throws(() => sanitizeEnvUrl(''),                    /non-empty string/);
  assert.throws(() => sanitizeEnvUrl('   '),                 /not a valid URL/);
  assert.throws(() => sanitizeEnvUrl(null),                  /non-empty string/);
  assert.throws(() => sanitizeEnvUrl(undefined),             /non-empty string/);
  assert.throws(() => sanitizeEnvUrl(42),                    /non-empty string/);
  assert.throws(() => sanitizeEnvUrl('not a url'),           /not a valid URL/);
  assert.throws(() => sanitizeEnvUrl('://broken'),           /not a valid URL/);
});
