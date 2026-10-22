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

test('discovers connection-reference component type from environment metadata', () => {
  assert.match(scriptSrc, /connectionreferences\?\$filter=connectionreferencelogicalname/);
  assert.match(scriptSrc, /EntityDefinitions\(LogicalName=/);
  assert.match(scriptSrc, /CONNECTION_REFERENCE_LOGICAL_NAME\s*=\s*'connectionreference'/);
});

test('discovers the GenPage component type from environment metadata', () => {
  assert.match(scriptSrc, /UXAGENTPROJECT_LOGICAL_NAME\s*=\s*'uxagentproject'/);
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

// Dataverse returns a connectionreferenceid as a GUID; it is the id sent to AddSolutionComponent.
const CR1 = '44444444-4444-4444-8444-444444444444';
const CR9 = '55555555-5555-4555-8555-555555555555';

function defaultLookup(requestPath) {
  if (requestPath.includes("EntityDefinitions(LogicalName='uxagentproject')")) {
    return { status: 200, data: { ObjectTypeCode: 10372 } };
  }
  if (requestPath.includes("EntityDefinitions(LogicalName='connectionreference')")) {
    return { status: 200, data: { ObjectTypeCode: 10158 } };
  }
  return { status: 200, data: { value: [{ connectionreferenceid: CR1 }] } };
}

function harness({ argv, refLookup = defaultLookup }) {
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
const APP = '11111111-1111-4111-8111-111111111111';
const P1 = '22222222-2222-4222-8222-222222222222';
const P2 = '33333333-3333-4333-8333-333333333333';

test('packages appmodule, each page, and each connection reference with the right component types', async () => {
  const { cli, calls, emitted } = harness({
    argv: [ENV, 'sol', APP, '--page-ids', `${P1},${P2}`, '--connection-refs', 'new_sp'],
  });

  await cli.main();

  const adds = calls.filter((c) => c.path === 'AddSolutionComponent');
  // appmodule (80) with AddRequiredComponents=true pulls the sitemap + appmodulecomponent.
  assert.deepEqual(
    { ComponentId: adds[0].body.ComponentId, ComponentType: adds[0].body.ComponentType, AddRequiredComponents: adds[0].body.AddRequiredComponents },
    { ComponentId: APP, ComponentType: 80, AddRequiredComponents: true }
  );
  // Each GenPage is added EXPLICITLY as uxagentproject (10372) — it does not travel with the app.
  assert.deepEqual(adds.slice(1, 3).map((c) => [c.body.ComponentId, c.body.ComponentType, c.body.AddRequiredComponents]),
    [[P1, 10372, true], [P2, 10372, true]]);
  // The connection reference resolves by logical name, then is added as 10158 WITHOUT required
  // components (371 is msdyn_Connector and fails with a MetadataCache error).
  assert.deepEqual([adds[3].body.ComponentId, adds[3].body.ComponentType, adds[3].body.AddRequiredComponents],
    [CR1, 10158, false]);
  assert.equal(emitted[0].ok, true);
  assert.deepEqual(emitted[0].payload.added.map((a) => a.type),
    ['appmodule', 'uxagentproject', 'uxagentproject', 'connectionreference']);
});

test('discovers environment-specific component types for GenPages and connection references', async () => {
  const { cli, calls } = harness({
    argv: [ENV, 'sol', APP, '--page-ids', P1, '--connection-refs', 'new_sp'],
    refLookup: (requestPath) => {
      if (requestPath.includes("EntityDefinitions(LogicalName='uxagentproject')")) {
        return { status: 200, data: { ObjectTypeCode: 10380 } };
      }
      if (requestPath.includes("EntityDefinitions(LogicalName='connectionreference')")) {
        return { status: 200, data: { ObjectTypeCode: 10162 } };
      }
      return { status: 200, data: { value: [{ connectionreferenceid: CR1 }] } };
    },
  });

  await cli.main();

  const adds = calls.filter((c) => c.path === 'AddSolutionComponent');
  assert.equal(adds[1].body.ComponentType, 10380);
  assert.equal(adds[2].body.ComponentType, 10162);
});

test('the appmodule is packaged BEFORE any page or connection reference', async () => {
  // Order is load-bearing: adding a uxagentproject to a solution the app is not yet in produces a
  // solution whose page has no owning app.
  const { cli, calls } = harness({ argv: [ENV, 'sol', APP, '--page-ids', P1, '--connection-refs', 'new_sp'] });
  await cli.main();
  const types = calls.filter((c) => c.path === 'AddSolutionComponent').map((c) => c.body.ComponentType);
  assert.equal(types[0], 80, 'appmodule must be first');
  assert.ok(types.indexOf(10372) < types.indexOf(10158), 'pages before connection references');
});

test('a connection reference that does not exist fails the run instead of packaging a partial solution', async () => {
  const { cli, calls, emitted } = harness({
    argv: [ENV, 'sol', APP, '--connection-refs', 'new_missing'],
    refLookup: (requestPath) =>
      requestPath.includes("EntityDefinitions(LogicalName='connectionreference')")
        ? { status: 200, data: { ObjectTypeCode: 10158 } }
        : { status: 200, data: { value: [] } },
  });
  await cli.main();
  assert.equal(emitted[0].ok, false);
  assert.match(String(emitted[0].payload.message || emitted[0].payload), /new_missing.*not found/);
  assert.equal(
    calls.filter((call) => call.path === 'AddSolutionComponent').length,
    0,
    'missing connection references must be validated before any solution mutation',
  );
});

test('all requested connection references are validated before adding the app or pages', async () => {
  const { cli, calls, emitted } = harness({
    argv: [ENV, 'sol', APP, '--page-ids', `${P1},${P2}`, '--connection-refs', 'new_missing'],
    refLookup: (requestPath) => {
      if (requestPath.includes("EntityDefinitions(LogicalName='uxagentproject')")) {
        return { status: 200, data: { ObjectTypeCode: 10372 } };
      }
      if (requestPath.includes("EntityDefinitions(LogicalName='connectionreference')")) {
        return { status: 200, data: { ObjectTypeCode: 10158 } };
      }
      return { status: 200, data: { value: [] } };
    },
  });
  await cli.main();
  assert.equal(emitted[0].ok, false);
  assert.match(String(emitted[0].payload.message || emitted[0].payload), /new_missing.*not found/);
  assert.deepEqual(
    calls.filter((call) => call.path === 'AddSolutionComponent'),
    [],
    'a failed connection-reference lookup must leave app and pages unmodified',
  );
});

// The looked-up id is the ComponentId of the connection reference's AddSolutionComponent, and it comes from
// a response — so, like the ids on the command line, it must be a GUID before anything is written. A
// response whose id is `not-a-guid` (a damaged or mocked reply, say) used to go on to add the app, the
// pages, and then fail at the reference, leaving the solution half-packaged.
const MALFORMED_REFERENCE_IDS = ['not-a-guid', `{${CR1}}`, `${CR1}\nBAD`, `${CR1}-0`, ' ', 42, { id: CR1 }];

function connectionReferenceLookup(idFor) {
  return (requestPath) => {
    if (requestPath.includes("EntityDefinitions(LogicalName='uxagentproject')")) return { status: 200, data: { ObjectTypeCode: 10372 } };
    if (requestPath.includes("EntityDefinitions(LogicalName='connectionreference')")) return { status: 200, data: { ObjectTypeCode: 10158 } };
    return { status: 200, data: { value: [{ connectionreferenceid: idFor(requestPath) }] } };
  };
}

test('a connection reference whose looked-up id is not a GUID refuses the run with zero writes', async () => {
  for (const id of MALFORMED_REFERENCE_IDS) {
    const { cli, calls, emitted } = harness({
      argv: [ENV, 'sol', APP, '--page-ids', `${P1},${P2}`, '--connection-refs', 'new_sp'],
      refLookup: connectionReferenceLookup(() => id),
    });
    await cli.main();
    const shown = JSON.stringify(id);
    assert.equal(emitted.length, 1, shown);
    assert.equal(emitted[0].ok, false, shown);
    assert.match(String(emitted[0].payload.message), /new_sp.*not a GUID/, shown);
    assert.deepEqual(calls.filter((c) => c.method !== 'GET'), [], `${shown}: no app, page or reference POST`);
  }
});

test('a malformed id on a later connection reference still leaves the solution untouched', async () => {
  const { cli, calls, emitted } = harness({
    argv: [ENV, 'sol', APP, '--page-ids', P1, '--connection-refs', 'new_first,new_second'],
    refLookup: connectionReferenceLookup((p) => (p.includes("'new_second'") ? 'not-a-guid' : CR1)),
  });
  await cli.main();
  assert.equal(emitted[0].ok, false);
  assert.match(String(emitted[0].payload.message), /new_second.*not a GUID/);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET'), [], 'the valid first reference is not added either');
});

test('control: upper- and lower-case GUID reference ids are packaged verbatim', async () => {
  const upper = CR1.toUpperCase();
  const { cli, calls, emitted } = harness({
    argv: [ENV, 'sol', APP, '--connection-refs', 'new_first,new_second'],
    refLookup: connectionReferenceLookup((p) => (p.includes("'new_second'") ? upper : CR9)),
  });
  await cli.main();
  assert.equal(emitted[0].ok, true);
  assert.deepEqual(calls.filter((c) => c.path === 'AddSolutionComponent').map((c) => [c.body.ComponentType, c.body.ComponentId]),
    [[80, APP], [10158, CR9], [10158, upper]]);
});

test('a connection reference logical name with a quote is OData-escaped, not injected', async () => {
  const seen = [];
  const { cli } = harness({
    argv: [ENV, 'sol', APP, '--connection-refs', "new_o'brien"],
    refLookup: (p) => {
      if (p.includes("EntityDefinitions(LogicalName='connectionreference')")) {
        return { status: 200, data: { ObjectTypeCode: 10158 } };
      }
      seen.push(p);
      return { status: 200, data: { value: [{ connectionreferenceid: CR9 }] } };
    },
  });
  await cli.main();
  // OData escapes a single quote by DOUBLING it; an unescaped quote would terminate the literal
  // and make the $filter a syntax error (or worse, a different filter).
  assert.match(seen[0], /connectionreferencelogicalname eq 'new_o''brien'/);
});

test('no --connection-refs packages the app and pages only', async () => {
  const { cli, calls, emitted } = harness({ argv: [ENV, 'sol', APP, '--page-ids', P1] });
  await cli.main();
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1, 'only the page component-type lookup runs');
  assert.deepEqual(emitted[0].payload.added.map((a) => a.type), ['appmodule', 'uxagentproject']);
});

test('a failing AddSolutionComponent surfaces as a failure, not a silent partial success', async () => {
  const calls = [];
  const emitted = [];
  let addCalls = 0;
  const authStub = {
    parseArgs: require('../lib/dataverse-auth.js').parseArgs,
    validateFlags: require('../lib/dataverse-auth.js').validateFlags,
    ensureOk: (res, what) => {
      if (!res || res.status < 200 || res.status >= 300) throw new Error(`${what} failed: ${res && res.status}`);
    },
    emitResult: (ok, payload) => { emitted.push({ ok, payload }); },
    dataverseRequest: async (envUrl, method, p, body) => {
      calls.push({ method, p, body });
      if (method === 'GET') return { status: 200, data: { ObjectTypeCode: 10372 } };
      // Fail on the SECOND add (the page), after the app already succeeded.
      addCalls += 1;
      return addCalls === 2 ? { status: 400, data: { error: { message: 'bad' } } } : { status: 204, data: {} };
    },
  };
  const cli = loadCli(scriptPath, {
    requires: { './lib/dataverse-auth': authStub },
    argv: [ENV, 'sol', APP, '--page-ids', P1],
  });
  await cli.main();
  assert.equal(emitted[0].ok, false, 'a mid-sequence failure must not report ok:true');
  assert.deepEqual(
    calls.filter((call) => call.p === 'AddSolutionComponent').map((call) => call.body.ComponentType),
    [80, 10372],
    'the app add succeeds before the page add fails',
  );
});

// Ids are checked as GUIDs before ANYTHING is read or written. A malformed page id used to reach
// Dataverse only at its own AddSolutionComponent — after the app had been added — leaving the solution
// holding the app without its page.
test('a malformed page or app id refuses the run before any request', async () => {
  for (const [argv, named] of [
    [[ENV, 'sol', APP, '--page-ids', `${P1},not-a-guid`], /page id 'not-a-guid'/],
    [[ENV, 'sol', 'app-1', '--page-ids', P1], /app id 'app-1'/],
    [[ENV, 'sol', APP, '--page-ids', `{${P1}}`], /page id '\{/],
  ]) {
    const { cli, calls, emitted } = harness({ argv });
    await cli.main();
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].ok, false);
    assert.match(emitted[0].payload.message, named);
    assert.match(emitted[0].payload.message, /Nothing was added to sol/);
    assert.deepEqual(calls, [], 'no metadata read and no AddSolutionComponent');
  }
});

test('a page id or connection reference given twice is added once', async () => {
  const { cli, calls, emitted } = harness({ argv: [ENV, 'sol', APP, '--page-ids', `${P1},${P1.toUpperCase()},${P2}`, '--connection-refs', 'new_sp,NEW_SP'] });
  await cli.main();
  const adds = calls.filter((c) => c.path === 'AddSolutionComponent').map((c) => [c.body.ComponentType, c.body.ComponentId]);
  assert.deepEqual(adds, [[80, APP], [10372, P1], [10372, P2], [10158, CR1]]);
  assert.equal(calls.filter((c) => c.method === 'GET' && /connectionreferences\?/.test(c.path)).length, 1, 'one lookup per reference');
  assert.equal(emitted[0].ok, true);
});

test('the stable app component type and dynamic entity names are pinned', () => {
  const {
    APPMODULE_COMPONENT_TYPE,
    UXAGENTPROJECT_LOGICAL_NAME,
    CONNECTION_REFERENCE_LOGICAL_NAME,
  } = require(scriptPath);
  assert.equal(APPMODULE_COMPONENT_TYPE, 80);
  assert.equal(UXAGENTPROJECT_LOGICAL_NAME, 'uxagentproject');
  assert.equal(CONNECTION_REFERENCE_LOGICAL_NAME, 'connectionreference');
});
