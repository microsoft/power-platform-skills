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

// --- sanitizeEnvUrl: defense against command injection via --envUrl ---
//
// The output of sanitizeEnvUrl is passed to helpers.getAuthToken, which
// interpolates it into `az account get-access-token --resource "${url}"`
// via execSync (a shell command). If we didn't sanitize, an attacker who
// could pass a malicious --envUrl on the CLI could execute arbitrary
// shell commands.

test('sanitizeEnvUrl accepts a plain Dataverse URL and returns just the origin', () => {
  assert.equal(
    sanitizeEnvUrl('https://contoso.crm.dynamics.com'),
    'https://contoso.crm.dynamics.com'
  );
});

test('sanitizeEnvUrl strips path, query, and fragment from the URL', () => {
  assert.equal(
    sanitizeEnvUrl('https://contoso.crm.dynamics.com/api/data/v9.2/solutions?$top=1#hash'),
    'https://contoso.crm.dynamics.com'
  );
});

test('sanitizeEnvUrl preserves an explicit port', () => {
  assert.equal(
    sanitizeEnvUrl('https://contoso.crm.dynamics.com:8443/some/path'),
    'https://contoso.crm.dynamics.com:8443'
  );
});

test('sanitizeEnvUrl strips a trailing slash by normalizing to origin', () => {
  assert.equal(
    sanitizeEnvUrl('https://contoso.crm.dynamics.com/'),
    'https://contoso.crm.dynamics.com'
  );
});

test('sanitizeEnvUrl rejects shell-injection payloads embedded in the URL', () => {
  // The whole point of using URL.origin is that these characters are stripped
  // (in path/query/fragment) or rejected by URL parsing (in host).
  // Verify a few representative payloads no longer make it through.

  // Path-position payload: URL parses fine, but origin throws away the path.
  assert.equal(
    sanitizeEnvUrl('https://contoso.crm.dynamics.com/"; rm -rf ~; echo "'),
    'https://contoso.crm.dynamics.com'
  );

  // Query-position payload: same story.
  assert.equal(
    sanitizeEnvUrl('https://contoso.crm.dynamics.com?x="; rm -rf ~; echo "'),
    'https://contoso.crm.dynamics.com'
  );

  // Newline in the URL — WHATWG URL parsing strips ASCII tabs and newlines
  // per spec, so a newline-laced URL gets normalized to a safe origin rather
  // than carrying the newline downstream. This is the behavior we want — a
  // newline in a shell command argument can be used to break out of a quoted
  // string.
  assert.equal(
    sanitizeEnvUrl('https://contoso\ndynamics.com'),
    'https://contosodynamics.com'
  );
  assert.doesNotMatch(sanitizeEnvUrl('https://contoso\tdynamics.com'), /\s/);
});

test('sanitizeEnvUrl rejects non-https protocols', () => {
  assert.throws(() => sanitizeEnvUrl('http://contoso.crm.dynamics.com'),  /must use https/);
  assert.throws(() => sanitizeEnvUrl('file:///etc/passwd'),               /must use https/);
  assert.throws(() => sanitizeEnvUrl('javascript:alert(1)'),              /must use https/);
});

test('sanitizeEnvUrl rejects URLs containing userinfo (credentials)', () => {
  assert.throws(
    () => sanitizeEnvUrl('https://attacker:pwn@contoso.crm.dynamics.com'),
    /must not contain userinfo/
  );
  assert.throws(
    () => sanitizeEnvUrl('https://attacker@contoso.crm.dynamics.com'),
    /must not contain userinfo/
  );
});

test('sanitizeEnvUrl rejects garbage input', () => {
  assert.throws(() => sanitizeEnvUrl(''),                    /non-empty string/);
  assert.throws(() => sanitizeEnvUrl('   '),                 /non-empty string/);
  assert.throws(() => sanitizeEnvUrl(null),                  /non-empty string/);
  assert.throws(() => sanitizeEnvUrl(undefined),             /non-empty string/);
  assert.throws(() => sanitizeEnvUrl(42),                    /non-empty string/);
  assert.throws(() => sanitizeEnvUrl('not a url'),           /not a valid URL/);
  assert.throws(() => sanitizeEnvUrl('://broken'),           /not a valid URL/);
});
