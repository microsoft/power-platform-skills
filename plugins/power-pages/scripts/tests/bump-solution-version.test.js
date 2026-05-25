'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bumpSolutionVersion,
  bumpPatchSegment,
} = require('../lib/bump-solution-version');

test('bumpPatchSegment increments the 4th segment', () => {
  assert.equal(bumpPatchSegment('1.0.0.2'), '1.0.0.3');
  assert.equal(bumpPatchSegment('2.7.13.99'), '2.7.13.100');
  assert.equal(bumpPatchSegment('1.0.0.9'), '1.0.0.10'); // not lexical
});

test('bumpPatchSegment pads missing trailing segments with zero', () => {
  assert.equal(bumpPatchSegment('1'), '1.0.0.1');
  assert.equal(bumpPatchSegment('1.0'), '1.0.0.1');
  assert.equal(bumpPatchSegment('1.2.3'), '1.2.3.1');
});

test('bumpPatchSegment rejects more than 4 segments', () => {
  assert.throws(() => bumpPatchSegment('1.0.0.0.0'), /more than 4 segments/);
});

test('bumpPatchSegment rejects non-numeric or negative segments', () => {
  assert.throws(() => bumpPatchSegment('1.0.0.a'), /not a non-negative integer/);
  assert.throws(() => bumpPatchSegment('1.0.-1.0'), /not a non-negative integer/);
  assert.throws(() => bumpPatchSegment(''), /version is required/);
  assert.throws(() => bumpPatchSegment(null), /version is required/);
});

test('bumpSolutionVersion requires envUrl and one of uniqueName/solutionId', async () => {
  await assert.rejects(
    () => bumpSolutionVersion({ uniqueName: 'Foo', token: 't' }),
    /--envUrl is required/
  );
  await assert.rejects(
    () => bumpSolutionVersion({ envUrl: 'https://org.crm.dynamics.com', token: 't' }),
    /--uniqueName or --solutionId is required/
  );
});

test('bumpSolutionVersion resolves by uniqueName, PATCHes, returns { previous, next }', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (req) => {
    calls.push(req);
    if (req.method === 'PATCH') {
      return { statusCode: 204, body: '', headers: {} };
    }
    // GET solutions list (verifySolutionExists)
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [{
          solutionid: 'sol-1234',
          uniquename: 'ContosoSite',
          version: '1.0.0.2',
          ismanaged: false,
        }],
      }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await bumpSolutionVersion({
    envUrl: 'https://org.crm.dynamics.com',
    uniqueName: 'ContosoSite',
    token: 'fake',
  });

  assert.equal(result.bumped, true);
  assert.equal(result.solutionId, 'sol-1234');
  assert.equal(result.uniqueName, 'ContosoSite');
  assert.equal(result.previous, '1.0.0.2');
  assert.equal(result.next, '1.0.0.3');

  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'PATCH call must have been made');
  assert.ok(patch.url.includes('solutions(sol-1234)'));
  assert.equal(patch.headers['If-Match'], '*');
  assert.equal(JSON.parse(patch.body).version, '1.0.0.3');
});

test('bumpSolutionVersion resolves by solutionId via direct GET', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (req) => {
    calls.push(req);
    if (req.method === 'PATCH') return { statusCode: 204, body: '', headers: {} };
    // GET solutions(<id>)
    return {
      statusCode: 200,
      body: JSON.stringify({
        solutionid: 'sol-1234',
        uniquename: 'ContosoSite',
        version: '2.0.0.5',
      }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await bumpSolutionVersion({
    envUrl: 'https://org.crm.dynamics.com',
    solutionId: 'sol-1234',
    token: 'fake',
  });

  assert.equal(result.previous, '2.0.0.5');
  assert.equal(result.next, '2.0.0.6');
  assert.equal(calls[0].method || 'GET', 'GET');
  assert.ok(calls[0].url.includes('solutions(sol-1234)'));
});

test('bumpSolutionVersion --dryRun does not PATCH and returns bumped:false', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (req) => {
    calls.push(req);
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [{ solutionid: 'sol-1234', uniquename: 'X', version: '1.0.0.7', ismanaged: false }],
      }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  const result = await bumpSolutionVersion({
    envUrl: 'https://org.crm.dynamics.com',
    uniqueName: 'X',
    token: 'fake',
    dryRun: true,
  });

  assert.equal(result.bumped, false);
  assert.equal(result.previous, '1.0.0.7');
  assert.equal(result.next, '1.0.0.8');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('bumpSolutionVersion surfaces 404 on unknown solutionId', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async () => ({ statusCode: 404, body: '{}' });
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => bumpSolutionVersion({
      envUrl: 'https://org.crm.dynamics.com',
      solutionId: 'sol-missing',
      token: 'fake',
    }),
    /not found/
  );
});

test('bumpSolutionVersion surfaces non-204 PATCH responses', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  helpers.makeRequest = async (req) => {
    if (req.method === 'PATCH') {
      return { statusCode: 412, body: '{"error":{"message":"version mismatch"}}' };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        value: [{ solutionid: 'sol-1234', uniquename: 'X', version: '1.0.0.0', ismanaged: false }],
      }),
    };
  };
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => bumpSolutionVersion({
      envUrl: 'https://org.crm.dynamics.com',
      uniqueName: 'X',
      token: 'fake',
    }),
    /Version PATCH returned 412/
  );
});

test('bumpSolutionVersion surfaces unknown uniqueName before any PATCH', async (t) => {
  const helpers = require('../lib/validation-helpers');
  const orig = helpers.makeRequest;
  const calls = [];
  helpers.makeRequest = async (req) => {
    calls.push(req);
    // verifySolutionExists returns empty value array
    return { statusCode: 200, body: JSON.stringify({ value: [] }) };
  };
  t.after(() => { helpers.makeRequest = orig; });

  await assert.rejects(
    () => bumpSolutionVersion({
      envUrl: 'https://org.crm.dynamics.com',
      uniqueName: 'Nope',
      token: 'fake',
    }),
    /not found in/
  );
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});
