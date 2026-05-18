const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { addComponentsToSolution, validateComponentsShape } = require('../lib/add-components-to-solution');

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

// --- Input-shape validation (regression guard for PascalCase silent failure)

test('addComponentsToSolution throws upfront when input file uses PascalCase keys', async (t) => {
  // Pre-fix: PascalCase entries silently destructured to undefined fields
  // and produced N HTTP 400 "missing parameters" responses with no upfront
  // signal. Post-fix: the validator aborts with a targeted error before any
  // Dataverse call.
  const componentsFile = writeTempComponents(t, [
    { ComponentId: 'guid-1', ComponentType: 10373 },
    { ComponentId: 'guid-2', ComponentType: 10373 },
  ]);
  await assert.rejects(
    () => addComponentsToSolution({
      envUrl: 'https://org.crm.dynamics.com',
      componentsFile,
      solutionUniqueName: 'X',
      token: 'fake',
    }),
    /PascalCase keys.*camelCase/,
  );
});

test('addComponentsToSolution throws on per-entry missing componentId with index hint', async (t) => {
  const componentsFile = writeTempComponents(t, [
    { componentId: 'guid-good', componentType: 10373 },
    { componentType: 10373 },  // missing componentId
  ]);
  await assert.rejects(
    () => addComponentsToSolution({
      envUrl: 'https://org.crm.dynamics.com',
      componentsFile,
      solutionUniqueName: 'X',
      token: 'fake',
    }),
    /entry \[1\] is missing required field 'componentId'/,
  );
});

test('addComponentsToSolution surfaces a PascalCase hint in per-entry errors', async (t) => {
  // Mixed-case shape — most entries are valid camelCase but one has the
  // capitalised variant. The hint about PascalCase should still appear so
  // the user sees the exact fix for the bad row.
  const componentsFile = writeTempComponents(t, [
    { componentId: 'guid-1', componentType: 10373 },
    { ComponentId: 'guid-bad', ComponentType: 10373 },  // PascalCase
  ]);
  await assert.rejects(
    () => addComponentsToSolution({
      envUrl: 'https://org.crm.dynamics.com',
      componentsFile,
      solutionUniqueName: 'X',
      token: 'fake',
    }),
    /entry \[1\].*PascalCase/,
  );
});

test('validateComponentsShape: valid input returns null', () => {
  const err = validateComponentsShape([
    { componentId: 'a', componentType: 1 },
    { componentId: 'b', componentType: 2, addRequired: true, description: 'desc' },
  ]);
  assert.equal(err, null);
});

test('validateComponentsShape: non-array input is rejected', () => {
  const err = validateComponentsShape({ componentId: 'oops' });
  assert.ok(err instanceof Error);
  assert.match(err.message, /must contain a JSON array/);
});

test('validateComponentsShape: malformed entry (not an object) surfaces index + value', () => {
  const err = validateComponentsShape([
    { componentId: 'a', componentType: 1 },
    'not-an-object',
  ]);
  assert.ok(err instanceof Error);
  assert.match(err.message, /entry \[1\] is not an object/);
});

test('validateComponentsShape: componentType non-number is rejected', () => {
  const err = validateComponentsShape([
    { componentId: 'a', componentType: '10373' },  // string, not number
  ]);
  assert.ok(err instanceof Error);
  assert.match(err.message, /missing required field 'componentType' \(number\)/);
});
