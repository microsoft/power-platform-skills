const test = require('node:test');
const assert = require('node:assert/strict');

// Unit tests for verify-alm-prerequisites.js
// Network calls are not made; this tests argument parsing and error paths
// that don't require live Dataverse connectivity.

const { verifyAlmPrerequisites } = require('../lib/verify-alm-prerequisites');

test('verifyAlmPrerequisites throws when PAC CLI returns no URL and no --envUrl given', async (t) => {
  // Mock getEnvironmentUrl to return null
  const helpers = require('../lib/validation-helpers');
  const original = helpers.getEnvironmentUrl;
  helpers.getEnvironmentUrl = () => null;
  t.after(() => { helpers.getEnvironmentUrl = original; });

  await assert.rejects(
    () => verifyAlmPrerequisites({}),
    /PAC CLI is not authenticated/
  );
});

test('verifyAlmPrerequisites throws when Azure CLI token acquisition fails', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origToken = helpers.getAuthToken;
  helpers.getAuthToken = () => null;
  t.after(() => {
    helpers.getAuthToken = origToken;
  });

  // Provide envUrl explicitly so PAC CLI check is bypassed
  await assert.rejects(
    () => verifyAlmPrerequisites({ envUrl: 'https://org.crm.dynamics.com' }),
    /Azure CLI is not logged in/
  );
});

test('verifyAlmPrerequisites throws on 401 WhoAmI response', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origEnv = helpers.getEnvironmentUrl;
  const origToken = helpers.getAuthToken;
  const origReq = helpers.makeRequest;

  helpers.getEnvironmentUrl = () => 'https://org.crm.dynamics.com';
  helpers.getAuthToken = () => 'fake-token';
  helpers.makeRequest = async () => ({ statusCode: 401, body: 'Unauthorized' });

  t.after(() => {
    helpers.getEnvironmentUrl = origEnv;
    helpers.getAuthToken = origToken;
    helpers.makeRequest = origReq;
  });

  await assert.rejects(
    () => verifyAlmPrerequisites({ envUrl: 'https://org.crm.dynamics.com' }),
    /Authentication failed/
  );
});

test('verifyAlmPrerequisites returns envUrl, userId, organizationId on success', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origToken = helpers.getAuthToken;
  const origReq = helpers.makeRequest;

  helpers.getAuthToken = () => 'header.eyJ0aWQiOiJ0ZXN0LXRlbmFudCJ9.sig';
  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ UserId: 'user-1', OrganizationId: 'org-1' }),
  });

  t.after(() => {
    helpers.getAuthToken = origToken;
    helpers.makeRequest = origReq;
  });

  const result = await verifyAlmPrerequisites({ envUrl: 'https://org.crm.dynamics.com' });
  assert.equal(result.envUrl, 'https://org.crm.dynamics.com');
  assert.equal(result.userId, 'user-1');
  assert.equal(result.organizationId, 'org-1');
  assert.ok(result.token);
});

// --- --expectedEnvUrl: hard-stop on ambient PAC env drift (Gap C) ---

test('verifyAlmPrerequisites HARD-STOPS when resolved PAC env != expectedEnvUrl', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origEnv = helpers.getEnvironmentUrl;
  // PAC drifted to prod; the project targets dev.
  helpers.getEnvironmentUrl = () => 'https://org-prod.crm.dynamics.com';
  t.after(() => { helpers.getEnvironmentUrl = origEnv; });

  await assert.rejects(
    () => verifyAlmPrerequisites({ expectedEnvUrl: 'https://org-dev.crm.dynamics.com' }),
    /Environment mismatch.*org-prod.*targets.*org-dev/s,
  );
});

test('verifyAlmPrerequisites passes the env assertion when origins match (slash/case/path ignored)', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origEnv = helpers.getEnvironmentUrl;
  const origToken = helpers.getAuthToken;
  const origReq = helpers.makeRequest;
  helpers.getEnvironmentUrl = () => 'https://Org-Dev.crm.dynamics.com';   // mixed case, no trailing slash
  helpers.getAuthToken = () => 'tok';
  helpers.makeRequest = async () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u', OrganizationId: 'o' }) });
  t.after(() => {
    helpers.getEnvironmentUrl = origEnv;
    helpers.getAuthToken = origToken;
    helpers.makeRequest = origReq;
  });

  // Expected URL differs only by case + trailing slash → same origin → no throw.
  const res = await verifyAlmPrerequisites({ expectedEnvUrl: 'https://org-dev.crm.dynamics.com/' });
  assert.equal(res.envUrl, 'https://Org-Dev.crm.dynamics.com');
});

test('parseArgs captures --expectedEnvUrl', () => {
  const { parseArgs } = require('../lib/verify-alm-prerequisites');
  const a = parseArgs(['node', 'x', '--expectedEnvUrl', 'https://dev.crm.dynamics.com', '--require-manifest']);
  assert.equal(a.expectedEnvUrl, 'https://dev.crm.dynamics.com');
  assert.equal(a.requireManifest, true);
  assert.equal(parseArgs(['node', 'x']).expectedEnvUrl, null);
});

// --- sameEnvOrigin / envOrigin robustness (no false hard-stop on garbage/bare host) ---

test('sameEnvOrigin: true/false for parseable URLs; null (indeterminate) for unparseable', () => {
  const { sameEnvOrigin } = require('../lib/verify-alm-prerequisites');
  assert.equal(sameEnvOrigin('https://a.crm.dynamics.com', 'https://A.crm.dynamics.com/api/data/v9.2'), true);
  assert.equal(sameEnvOrigin('https://a.crm.dynamics.com', 'https://b.crm.dynamics.com'), false);
  // Bare host (no scheme) on the expected side must still match a scheme-prefixed resolved URL.
  assert.equal(sameEnvOrigin('https://dev.crm.dynamics.com', 'dev.crm.dynamics.com'), true);
  // Unparseable / empty / unsubstituted placeholder → null (caller must NOT hard-stop).
  assert.equal(sameEnvOrigin('https://dev.crm.dynamics.com', ''), null);
  assert.equal(sameEnvOrigin('https://dev.crm.dynamics.com', '{CONFIGURED_ENV_URL}'), null);
  assert.equal(sameEnvOrigin('https://dev.crm.dynamics.com', null), null);
});

test('verifyAlmPrerequisites does NOT hard-stop when expectedEnvUrl is an unsubstituted placeholder', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const origEnv = helpers.getEnvironmentUrl;
  const origToken = helpers.getAuthToken;
  const origReq = helpers.makeRequest;
  helpers.getEnvironmentUrl = () => 'https://dev.crm.dynamics.com';
  helpers.getAuthToken = () => 'tok';
  helpers.makeRequest = async () => ({ statusCode: 200, body: JSON.stringify({ UserId: 'u', OrganizationId: 'o' }) });
  t.after(() => {
    helpers.getEnvironmentUrl = origEnv;
    helpers.getAuthToken = origToken;
    helpers.makeRequest = origReq;
  });
  // A SKILL that fails to resolve {CONFIGURED_ENV_URL} would pass the literal — must
  // NOT block the run (the assertion is skipped on an unparseable expected value).
  const res = await verifyAlmPrerequisites({ expectedEnvUrl: '{CONFIGURED_ENV_URL}' });
  assert.equal(res.envUrl, 'https://dev.crm.dynamics.com');
});
