const test = require('node:test');
const assert = require('node:assert/strict');

const { verifySolutionExists } = require('../lib/verify-solution-exists');

test('verifySolutionExists throws when --envUrl is missing', async () => {
  await assert.rejects(
    () => verifySolutionExists({ uniqueName: 'TestSolution', token: 'tok' }),
    /--envUrl is required/
  );
});

test('verifySolutionExists throws when solution unique name is missing', async () => {
  await assert.rejects(
    () => verifySolutionExists({ envUrl: 'https://org.crm.dynamics.com', token: 'tok' }),
    /--solutionUniqueName is required/
  );
});

test('parseArgs: --solutionUniqueName is the primary flag (no deprecation warning)', () => {
  const { parseArgs } = require('../lib/verify-solution-exists');
  const warns = [];
  const r = parseArgs(['node', 'x', '--envUrl', 'https://o.crm.dynamics.com', '--solutionUniqueName', 'RetailOS'], { warn: (m) => warns.push(m) });
  assert.equal(r.uniqueName, 'RetailOS');
  assert.equal(warns.length, 0, 'primary flag must not warn');
});

test('parseArgs: --uniqueName still works as a deprecated alias and warns', () => {
  const { parseArgs } = require('../lib/verify-solution-exists');
  const warns = [];
  const r = parseArgs(['node', 'x', '--envUrl', 'https://o.crm.dynamics.com', '--uniqueName', 'RetailOS'], { warn: (m) => warns.push(m) });
  assert.equal(r.uniqueName, 'RetailOS', 'alias still resolves the name (backward-compatible)');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /DEPRECATION WARN/);
  assert.match(warns[0], /--solutionUniqueName/);
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
