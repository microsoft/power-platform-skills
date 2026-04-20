const test = require('node:test');
const assert = require('node:assert/strict');

const { createSolution } = require('../lib/create-solution');

test('createSolution throws when required args are missing', async () => {
  await assert.rejects(
    () => createSolution({ envUrl: 'https://org.crm.dynamics.com', token: 'tok', uniqueName: 'X' }),
    /--friendlyName.*--version.*--publisherId/
  );
});

test('createSolution extracts solutionId from OData-EntityId header on 204', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 204,
    body: '',
    headers: {
      'odata-entityid': 'https://org.crm.dynamics.com/api/data/v9.2/solutions(aabbccdd-1234-5678-abcd-000000000001)',
    },
  });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await createSolution({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    uniqueName: 'MyPortal',
    friendlyName: 'My Portal',
    version: '1.0.0.0',
    publisherId: 'pub-id-001',
  });

  assert.equal(result.solutionId, 'aabbccdd-1234-5678-abcd-000000000001');
  assert.equal(result.uniqueName, 'MyPortal');
  assert.equal(result.created, true);
});

test('createSolution handles 409 by returning existing solution ID', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  let callCount = 0;
  helpers.makeRequest = async ({ url }) => {
    callCount++;
    if (callCount === 1) {
      return { statusCode: 409, body: '{}', headers: {} };
    }
    // Re-query returns existing solution
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [{
          solutionid: 'existing-sol-id',
          uniquename: 'MyPortal',
          version: '1.0.0.0',
          ismanaged: false,
        }],
      }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await createSolution({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    uniqueName: 'MyPortal',
    friendlyName: 'My Portal',
    version: '1.0.0.0',
    publisherId: 'pub-id-001',
  });

  assert.equal(result.solutionId, 'existing-sol-id');
  assert.equal(result.created, false);
});
