const test = require('node:test');
const assert = require('node:assert/strict');

const { createEnvVarDefinition, ENV_VAR_TYPES } = require('../lib/create-env-var-definition');

test('ENV_VAR_TYPES exports expected type codes', () => {
  assert.equal(ENV_VAR_TYPES.Secret, 100000003);
  assert.equal(ENV_VAR_TYPES.String, 100000000);
});

test('createEnvVarDefinition throws when required args are missing', async () => {
  await assert.rejects(
    () => createEnvVarDefinition({ envUrl: 'https://org.crm.dynamics.com', token: 'tok' }),
    /--schemaName.*--displayName/
  );
});

test('createEnvVarDefinition extracts definitionId from OData-EntityId header on 204', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 204,
    body: '',
    headers: {
      'odata-entityid': 'https://org.crm.dynamics.com/api/data/v9.2/environmentvariabledefinitions(aaaabbbb-1234-5678-abcd-000000000001)',
    },
  });
  t.after(() => { helpers.makeRequest = orig; });

  const result = await createEnvVarDefinition({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    schemaName: 'con_MySecret',
    displayName: 'My Secret',
  });

  assert.equal(result.definitionId, 'aaaabbbb-1234-5678-abcd-000000000001');
  assert.equal(result.schemaName, 'con_MySecret');
  assert.equal(result.created, true);
});

test('createEnvVarDefinition handles 409 by re-querying existing definition', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  let callCount = 0;
  helpers.makeRequest = async ({ url }) => {
    callCount++;
    if (callCount === 1) {
      // First call = POST → 409
      return { statusCode: 409, body: '{"error":{"code":"0x80040237"}}', headers: {} };
    }
    // Second call = GET to find existing
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [{ environmentvariabledefinitionid: 'existing-def-id', schemaname: 'con_ExistingSecret' }],
      }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await createEnvVarDefinition({
    envUrl: 'https://org.crm.dynamics.com',
    token: 'fake',
    schemaName: 'con_ExistingSecret',
    displayName: 'Existing Secret',
  });

  assert.equal(result.definitionId, 'existing-def-id');
  assert.equal(result.created, false);
});
