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
