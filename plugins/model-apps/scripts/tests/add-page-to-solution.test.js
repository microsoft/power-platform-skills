'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'add-page-to-solution.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('adds appmodule (80) with required components', () => {
  assert.match(scriptSrc, /APPMODULE_COMPONENT_TYPE\s*=\s*80/);
  assert.match(scriptSrc, /addComponent\([^)]*APPMODULE_COMPONENT_TYPE,\s*true\)/);
});

test('adds connection references by confirmed component type', () => {
  assert.match(scriptSrc, /connectionreferences\?\$filter=connectionreferencelogicalname/);
  assert.match(scriptSrc, /CONNECTION_REFERENCE_COMPONENT_TYPE\s*=\s*10158/);
});

test('adds the GenPage uxagentproject explicitly (type 10372)', () => {
  assert.match(scriptSrc, /UXAGENTPROJECT_COMPONENT_TYPE\s*=\s*10372/);
  assert.match(scriptSrc, /flags\['page-ids'\]/);
});

test('missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

// --- Wire-level packaging contract ------------------------------------------
//
// These drive main() with a stubbed dataverseRequest and assert the ACTUAL sequence of
// AddSolutionComponent calls. The component type codes are live-verified values that are not
// locally obvious, and getting one wrong produces a solution that imports with unbound
// connectors — a failure that only shows up in the TARGET environment, long after this ran.

const { loadCli } = require('./helpers/cli-harness.js');

function harness({ argv, refLookup = () => ({ status: 200, data: { value: [{ connectionreferenceid: 'cr-1' }] } }) }) {
  const calls = [];
  const emitted = [];
  const authStub = {
    parseArgs: require('../lib/dataverse-auth.js').parseArgs,
    validateFlags: require('../lib/dataverse-auth.js').validateFlags,
    ensureOk: (res, what) => {
      if (!res || res.status < 200 || res.status >= 300) throw new Error(`${what} failed: ${res && res.status}`);
    },
    emitResult: (ok, payload) => { emitted.push({ ok, payload }); },
    dataverseRequest: async (envUrl, method, pathOrAction, body) => {
      calls.push({ envUrl, method, path: pathOrAction, body });
      if (method === 'GET') return refLookup(pathOrAction);
      return { status: 204, data: {} };
    },
  };
  const cli = loadCli(scriptPath, { requires: { './lib/dataverse-auth': authStub }, argv });
  return { cli, calls, emitted };
}

const ENV = 'https://contoso.crm.dynamics.com';

test('packages appmodule, each page, and each connection reference with the right component types', async () => {
  const { cli, calls, emitted } = harness({
    argv: [ENV, 'sol', 'app-1', '--page-ids', 'p1,p2', '--connection-refs', 'new_sp'],
  });
  await cli.main();

  const adds = calls.filter((c) => c.path === 'AddSolutionComponent');
  // appmodule (80) with AddRequiredComponents=true pulls the sitemap + appmodulecomponent.
  assert.deepEqual(
    { ComponentId: adds[0].body.ComponentId, ComponentType: adds[0].body.ComponentType, AddRequiredComponents: adds[0].body.AddRequiredComponents },
    { ComponentId: 'app-1', ComponentType: 80, AddRequiredComponents: true }
  );
  // Each GenPage is added EXPLICITLY as uxagentproject (10372) — it does not travel with the app.
  assert.deepEqual(adds.slice(1, 3).map((c) => [c.body.ComponentId, c.body.ComponentType, c.body.AddRequiredComponents]),
    [['p1', 10372, true], ['p2', 10372, true]]);
  // The connection reference resolves by logical name, then is added as 10158 WITHOUT required
  // components (371 is msdyn_Connector and fails with a MetadataCache error).
  assert.deepEqual([adds[3].body.ComponentId, adds[3].body.ComponentType, adds[3].body.AddRequiredComponents],
    ['cr-1', 10158, false]);
  assert.equal(emitted[0].ok, true);
  assert.deepEqual(emitted[0].payload.added.map((a) => a.type),
    ['appmodule', 'uxagentproject', 'uxagentproject', 'connectionreference']);
});

test('the appmodule is packaged BEFORE any page or connection reference', async () => {
  // Order is load-bearing: adding a uxagentproject to a solution the app is not yet in produces a
  // solution whose page has no owning app.
  const { cli, calls } = harness({ argv: [ENV, 'sol', 'app-1', '--page-ids', 'p1', '--connection-refs', 'new_sp'] });
  await cli.main();
  const types = calls.filter((c) => c.path === 'AddSolutionComponent').map((c) => c.body.ComponentType);
  assert.equal(types[0], 80, 'appmodule must be first');
  assert.ok(types.indexOf(10372) < types.indexOf(10158), 'pages before connection references');
});

test('a connection reference that does not exist fails the run instead of packaging a partial solution', async () => {
  const { cli, emitted } = harness({
    argv: [ENV, 'sol', 'app-1', '--connection-refs', 'new_missing'],
    refLookup: () => ({ status: 200, data: { value: [] } }),
  });
  await cli.main();
  assert.equal(emitted[0].ok, false);
  assert.match(String(emitted[0].payload.message || emitted[0].payload), /new_missing.*not found/);
});

test('a connection reference logical name with a quote is OData-escaped, not injected', async () => {
  const seen = [];
  const { cli } = harness({
    argv: [ENV, 'sol', 'app-1', '--connection-refs', "new_o'brien"],
    refLookup: (p) => { seen.push(p); return { status: 200, data: { value: [{ connectionreferenceid: 'cr-9' }] } }; },
  });
  await cli.main();
  // OData escapes a single quote by DOUBLING it; an unescaped quote would terminate the literal
  // and make the $filter a syntax error (or worse, a different filter).
  assert.match(seen[0], /connectionreferencelogicalname eq 'new_o''brien'/);
});

test('no --connection-refs packages the app and pages only', async () => {
  const { cli, calls, emitted } = harness({ argv: [ENV, 'sol', 'app-1', '--page-ids', 'p1'] });
  await cli.main();
  assert.equal(calls.filter((c) => c.method === 'GET').length, 0, 'no connection-reference lookup');
  assert.deepEqual(emitted[0].payload.added.map((a) => a.type), ['appmodule', 'uxagentproject']);
});

test('a failing AddSolutionComponent surfaces as a failure, not a silent partial success', async () => {
  const calls = [];
  const emitted = [];
  const authStub = {
    parseArgs: require('../lib/dataverse-auth.js').parseArgs,
    validateFlags: require('../lib/dataverse-auth.js').validateFlags,
    ensureOk: (res, what) => {
      if (!res || res.status < 200 || res.status >= 300) throw new Error(`${what} failed: ${res && res.status}`);
    },
    emitResult: (ok, payload) => { emitted.push({ ok, payload }); },
    dataverseRequest: async (envUrl, method, p, body) => {
      calls.push({ method, p, body });
      // Fail on the SECOND add (the page), after the app already succeeded.
      return calls.length === 2 ? { status: 400, data: { error: { message: 'bad' } } } : { status: 204, data: {} };
    },
  };
  const cli = loadCli(scriptPath, {
    requires: { './lib/dataverse-auth': authStub },
    argv: [ENV, 'sol', 'app-1', '--page-ids', 'p1'],
  });
  await cli.main();
  assert.equal(emitted[0].ok, false, 'a mid-sequence failure must not report ok:true');
});

test('the live-verified component type codes are pinned', () => {
  const {
    APPMODULE_COMPONENT_TYPE,
    UXAGENTPROJECT_COMPONENT_TYPE,
    CONNECTION_REFERENCE_COMPONENT_TYPE,
    escapeODataString,
  } = require(scriptPath);
  assert.equal(APPMODULE_COMPONENT_TYPE, 80);
  assert.equal(UXAGENTPROJECT_COMPONENT_TYPE, 10372);
  // NOT 371 (msdyn_Connector) — that value fails with "entity ... not found in MetadataCache".
  assert.equal(CONNECTION_REFERENCE_COMPONENT_TYPE, 10158);
  assert.equal(escapeODataString("a'b'c"), "a''b''c");
});
