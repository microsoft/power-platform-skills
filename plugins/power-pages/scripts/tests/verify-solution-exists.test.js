const test = require('node:test');
const assert = require('node:assert/strict');

const { verifySolutionExists } = require('../lib/verify-solution-exists');

test('verifySolutionExists throws when --envUrl is missing', async () => {
  await assert.rejects(
    () => verifySolutionExists({ uniqueName: 'TestSolution', token: 'tok' }),
    /--envUrl is required/
  );
});

test('verifySolutionExists throws when --uniqueName is missing', async () => {
  await assert.rejects(
    () => verifySolutionExists({ envUrl: 'https://org.crm.dynamics.com', token: 'tok' }),
    /--uniqueName is required/
  );
});

test('verifySolutionExists returns found:false when solution does not exist', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({ value: [] }),
  });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await verifySolutionExists({
    envUrl: 'https://org.crm.dynamics.com',
    uniqueName: 'NoSuchSolution',
    token: 'fake',
  });

  assert.equal(result.found, false);
  assert.equal(result.uniqueName, 'NoSuchSolution');
});

test('verifySolutionExists returns found:true with solution details', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 200,
    body: JSON.stringify({
      value: [{
        solutionid: 'sol-id-123',
        uniquename: 'MyPortalSolution',
        version: '1.0.0.2',
        ismanaged: false,
      }],
    }),
  });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await verifySolutionExists({
    envUrl: 'https://org.crm.dynamics.com',
    uniqueName: 'MyPortalSolution',
    token: 'fake',
  });

  assert.equal(result.found, true);
  assert.equal(result.solutionId, 'sol-id-123');
  assert.equal(result.version, '1.0.0.2');
  assert.equal(result.isManaged, false);
});

test('verifySolutionExists throws on 401', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 401, body: 'Unauthorized' });
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => verifySolutionExists({ envUrl: 'https://org.crm.dynamics.com', uniqueName: 'X', token: 'fake' }),
    /Authentication failed/
  );
});
