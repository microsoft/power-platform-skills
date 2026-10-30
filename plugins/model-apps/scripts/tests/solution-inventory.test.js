'use strict';
// Solution inventory (lib/solution-inventory.js, `solutions.js inspect`): over the REAL bundle and a recording fake
// transport. Pinned: every request is a GET and is counted; an artifact the SDK reads is listed by kind, id and name and
// never by value; a table held with all its subcomponents is `notExpanded`, not silently "complete"; a component the SDK
// cannot map is `skipped` as unsupported and one whose read failed is `skipped` as failed and fails the result; without
// --include-artifacts only the solution row is read.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { inspectFromFlags } = require('../solutions.js');
const { SUPPORTED_KINDS } = require('../lib/solution-inventory.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const SOLUTION_ID = '44444444-4444-4444-4444-444444444444';
const ID = (n) => `aaaaaaaa-0000-0000-0000-00000000000${n}`;

function fakeOrg({ solutionFound = true } = {}) {
  const requests = [];
  const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const typeCodes = { uxagentproject: 10100, connectionreference: 10101, customapi: 10102, customapirequestparameter: 10103, customapiresponseproperty: 10104 };
  const request = async ({ url, method }) => {
    const u = decodeURIComponent(url).replace(ORIGIN, '');
    requests.push(`${method} ${u}`);
    if (method !== 'GET') return json(500, { error: { code: 'unexpected', message: 'not a GET' } });
    if (u.startsWith('/api/data/v9.0/solutions?')) {
      return json(200, { value: solutionFound ? [{
        solutionid: SOLUTION_ID, uniquename: 'ContosoTickets', friendlyname: 'Contoso Tickets', version: '1.2.0.0', ismanaged: false,
        publisherid: { publisherid: '55555555-5555-5555-5555-555555555555', uniquename: 'contoso', customizationprefix: 'contoso', customizationoptionvalueprefix: 10000 },
      }] : [] });
    }
    const def = /EntityDefinitions\(LogicalName='([a-z_]+)'\)/.exec(u);
    if (def) return json(200, { ObjectTypeCode: typeCodes[def[1]] });
    if (u.startsWith('/api/data/v9.0/solutioncomponents?')) {
      return json(200, { value: [
        { objectid: ID(1), componenttype: 1, rootcomponentbehavior: 0 },
        { objectid: ID(2), componenttype: 1, rootcomponentbehavior: 1 },
        { objectid: ID(3), componenttype: 380 },
        { objectid: ID(4), componenttype: 60 },
      ] });
    }
    if (u.startsWith(`/api/data/v9.0/environmentvariabledefinitions(${ID(3)})`)) {
      return json(200, { environmentvariabledefinitionid: ID(3), schemaname: 'contoso_ApiBase', displayname: 'API base', type: 100000000, defaultvalue: 'SENTINEL-value', environmentvariabledefinition_environmentvariablevalue: [{ environmentvariablevalueid: ID(5), value: 'SENTINEL-current' }] });
    }
    return json(404, { error: { code: '0x80040217', message: 'Does not exist' } });
  };
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'x'.repeat(48), request, sleep: async () => {} });
  return { requests, client };
}

test('--include-artifacts lists what the SDK read, what it did not expand and what failed, by GET only', async () => {
  const org = fakeOrg();
  const result = await inspectFromFlags({ env: ORIGIN, solution: 'ContosoTickets', 'include-artifacts': true }, org.client);
  assert.deepEqual(result.solution, { solutionId: SOLUTION_ID, uniqueName: 'ContosoTickets', friendlyName: 'Contoso Tickets', version: '1.2.0.0', isManaged: false, publisherUniqueName: 'contoso' });
  const inv = result.inventory;
  assert.deepEqual(inv.supportedKinds, SUPPORTED_KINDS);
  assert.equal(inv.supportedKinds.length, 14);
  assert.deepEqual(inv.artifacts, [{ kind: 'environmentVariable', id: ID(3), name: 'API base' }]);
  assert.deepEqual(inv.byKind, { environmentVariable: 1 });
  assert.deepEqual(inv.notExpanded, [{ componentId: ID(1) }], 'the table held with all subcomponents is reported, not expanded');
  assert.equal(inv.skipped.length, 1);
  assert.equal(inv.skipped[0].componentId, ID(4));
  assert.equal(inv.skipped[0].reason, 'failed');
  assert.equal(inv.skipped[0].error.statusCode, 404);
  assert.equal(inv.complete, false);
  assert.ok(inv.limits.some((l) => /not a list of everything the solution owns/.test(l)));
  assert.equal(result.ok, false, 'a failed component read means the inventory is known to be short');
  assert.equal(JSON.stringify(result).includes('SENTINEL'), false, 'no value leaves the inventory');
  assert.ok(org.requests.every((r) => r.startsWith('GET ')));
  assert.equal(result.cost.gets, org.requests.length);
  assert.equal(result.cost.refusedWrites, 0);
});

test('without --include-artifacts only the solution row is read', async () => {
  const org = fakeOrg();
  const result = await inspectFromFlags({ env: ORIGIN, solution: 'ContosoTickets' }, org.client);
  assert.equal(result.ok, true);
  assert.equal(result.inventory, undefined);
  assert.equal(org.requests.length, 1);
  assert.equal(result.cost.gets, 1);
});

test('a solution that does not exist is a failed result, not an empty inventory', async () => {
  const org = fakeOrg({ solutionFound: false });
  const result = await inspectFromFlags({ env: ORIGIN, solution: 'Missing', 'include-artifacts': true }, org.client);
  assert.equal(result.ok, false);
  assert.equal(result.inventory, undefined);
  assert.equal(typeof result.error.code, 'string');
  assert.equal(org.requests.length, 1);
});

test('the CLI has one read-only verb and refuses anything else', () => {
  const script = path.join(__dirname, '..', 'solutions.js');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const args of [
    ['--env', ORIGIN, '--solution', 'S'],
    ['delete', '--env', ORIGIN, '--solution', 'S'],
    ['inspect', '--env', ORIGIN],
    ['inspect', '--env', ORIGIN, '--solution', 'S', '--include-artifacts', 'yes'],
    ['inspect', '--env', ORIGIN, '--solution', 'S', '--apply'],
  ]) {
    const r = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 1, args.join(' '));
  }
});
