const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { addComponentsToSolution } = require('../lib/add-components-to-solution');

function writeTempComponents(t, components) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-comp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'components.json');
  fs.writeFileSync(filePath, JSON.stringify(components), 'utf8');
  return filePath;
}

test('addComponentsToSolution returns zero counts for empty components file', async (t) => {
  const componentsFile = writeTempComponents(t, []);

  const result = await addComponentsToSolution({
    envUrl: 'https://org.crm.dynamics.com',
    componentsFile,
    solutionUniqueName: 'TestSolution',
    token: 'fake',
  });

  assert.equal(result.total, 0);
  assert.equal(result.success, 0);
  assert.equal(result.failed, 0);
});

test('addComponentsToSolution counts success on 200 response', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 200, body: '{}' });
  t.after(() => { helpers.makeRequest = orig; });

  const componentsFile = writeTempComponents(t, [
    { componentId: 'guid-1', componentType: 10373, description: 'Web Page: Home' },
    { componentId: 'guid-2', componentType: 10373, description: 'Web Page: About' },
  ]);

  const result = await addComponentsToSolution({
    envUrl: 'https://org.crm.dynamics.com',
    componentsFile,
    solutionUniqueName: 'TestSolution',
    token: 'fake',
  });

  assert.equal(result.total, 2);
  assert.equal(result.success, 2);
  assert.equal(result.failed, 0);
  assert.equal(result.failures.length, 0);
});

test('addComponentsToSolution treats already-in-solution error as skipped', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({
    statusCode: 400,
    body: JSON.stringify({ error: { code: '-2147160463', message: 'Component already in the solution' } }),
  });
  t.after(() => { helpers.makeRequest = orig; });

  const componentsFile = writeTempComponents(t, [
    { componentId: 'guid-already', componentType: 10373 },
  ]);

  const result = await addComponentsToSolution({
    envUrl: 'https://org.crm.dynamics.com',
    componentsFile,
    solutionUniqueName: 'TestSolution',
    token: 'fake',
  });

  assert.equal(result.skipped, 1);
  assert.equal(result.failed, 0);
});

test('addComponentsToSolution records failure on unexpected 500 error', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 500, body: 'Internal Server Error' });
  t.after(() => { helpers.makeRequest = orig; });

  const componentsFile = writeTempComponents(t, [
    { componentId: 'guid-fail', componentType: 10373 },
  ]);

  const result = await addComponentsToSolution({
    envUrl: 'https://org.crm.dynamics.com',
    componentsFile,
    solutionUniqueName: 'TestSolution',
    token: 'fake',
  });

  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].componentId, 'guid-fail');
});

test('addComponentsToSolution throws on missing required args', async () => {
  await assert.rejects(
    () => addComponentsToSolution({ solutionUniqueName: 'X', token: 'fake' }),
    /--envUrl is required/
  );
});
