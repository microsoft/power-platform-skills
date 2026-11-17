'use strict';
// The environment's table list is read by four callers besides list-tables.js, and each turns what it reads into a decision:
//
//   sdk-teardown.js   the table step: is it a system table to leave alone, or a custom one to delete
//   entity-provision  findExistingTable (the build's data-model phase, and the dry run's plan): reuse the table, or create it
//   sdk-build.js      the business process flow's name check: does a table already hold the name the flow derives
//   verify-model-app  the verifier's catalog: is each declared table there, or missing
//
// The SDK's findTables() reads a 2xx answer with no `value` list as "no tables" (`body.value ?? []`), and a sign-in or proxy page, `{}` and `null` are such answers. lib/maker-sdk.js now holds the one read
// to being a list (lib/collection-answers.js), so each caller meets a failure — TABLES_UNREADABLE — where it used to meet an empty environment. These tests run the REAL bundle and the REAL HTTP client over a
// fake that records every request, and each caller's own code on top; every one of them drew the wrong conclusion before. `{ "value": [] }` is still an empty answer, and on the normal path the same
// requests go out in the same order as when the bundle's own factory makes the SDK.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const bundle = require('../vendor/cds-maker-sdk.cjs');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../lib/maker-sdk.js');
const { runTeardown } = require('../lib/sdk-teardown.js');
const { findExistingTable, provisionDataModel, BuildHalt } = require('../lib/entity-provision.js');
// An apply that names no app folder and no workspace gets an app folder of its own: it holds its build lease in its workspace (helpers/own-app-folder.js).
const { inOwnFolder } = require('./helpers/own-app-folder.js');
const { runSdkBuild: runSdkBuildInPlace, annotateLivePlan, planFor } = require('../lib/sdk-build.js');
const runSdkBuild = inOwnFolder(runSdkBuildInPlace);
const { verifySpec } = require('../lib/verify-spec.js');
const { readerFor } = require('../verify-model-app.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');

const ORIGIN = 'https://contoso.crm.dynamics.com';
const TABLE_LIST = 'GET /EntityDefinitions?$select=LogicalName,SchemaName,EntitySetName,DisplayName,IsCustomEntity';
const NARROW = (logical) => `GET /EntityDefinitions(LogicalName='${logical}')?$select=LogicalName,EntitySetName`;
const DELETE_TABLE = (logical) => `DELETE /EntityDefinitions(LogicalName='${logical}')`;

// --- a fake environment over the low-level transport of the plugin's az-token client -----------------------------------------------------------------------------------------------

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const raw = (statusCode, contentType, body) => ({ statusCode, headers: { 'content-type': contentType }, body });
const SIGN_IN = raw(200, 'text/html', '<html><body>Sign in to your account</body></html>');

// What a table list can answer that is no list (each a 2xx).
const NOT_A_LIST = {
  'a sign-in page': SIGN_IN,
  'an empty object': raw(200, 'application/json', '{}'),
  'JSON null': raw(200, 'application/json', 'null'),
  'a value that is no list': raw(200, 'application/json', '{"value":"x"}'),
};

const definition = ({ logicalName, custom = true }) => ({
  LogicalName: logicalName,
  SchemaName: logicalName,
  EntitySetName: `${logicalName}s`,
  IsCustomEntity: custom,
  DisplayName: { UserLocalizedLabel: { Label: logicalName } },
});

// `tables` are the tables the environment holds; `list` answers the table list instead of them (a raw answer); `narrow` answers the one-table definition read instead of the truth;
// `refuseDelete` answers a table delete instead of the platform's 204; `nextPage` answers the read of a continuation link of the table list (`…$skiptoken=…`).
// `org.requests` is every request, in order, as `METHOD /path` below the API root.
function createOrg({ tables = [], list, narrow, deleteAnswer, nextPage } = {}) {
  const org = { tables: new Map(tables.map((table) => [table.logicalName, table])), list, narrow, deleteAnswer, nextPage, requests: [], unexpected: [] };
  org.request = async ({ url, method }) => {
    const parsed = new URL(url);
    const apiPath = decodeURIComponent(parsed.pathname + parsed.search).replace(/^\/api\/data\/v9\.\d/, '');
    org.requests.push(`${method} ${apiPath}`);
    const one = /^\/EntityDefinitions\(LogicalName='([^']+)'\)/.exec(apiPath);
    if (method === 'GET' && /^\/EntityDefinitions\?.*\$skiptoken=/.test(apiPath) && org.nextPage) return org.nextPage;
    if (method === 'GET' && /^\/EntityDefinitions\?/.test(apiPath)) return org.list || json(200, { value: [...org.tables.values()].map(definition) });
    if (method === 'GET' && one && /\/Attributes/.test(apiPath)) return json(200, { value: [] });
    if (method === 'GET' && one) {
      if (org.narrow) return org.narrow;
      return org.tables.has(one[1])
        ? json(200, { LogicalName: one[1], EntitySetName: `${one[1]}s` })
        : json(404, { error: { code: '0x80060888', message: `Resource not found for the segment 'EntityDefinitions(LogicalName='${one[1]}')'.` } });
    }
    if (method === 'DELETE' && one) {
      org.tables.delete(one[1]);
      return org.deleteAnswer || { statusCode: 204, headers: {}, body: '' };
    }
    org.unexpected.push(`${method} ${apiPath}`);
    return json(404, { error: { message: 'not found' } });
  };
  org.writes = () => org.requests.filter((r) => !r.startsWith('GET '));
  return org;
}

// An SDK over `org`, made by `factory`: lib/maker-sdk.js's (the way every script makes one), or the bundle's own, which is what each caller was handed before the table list was held to being a list.
async function makeSdk(t, org, factory = createMakerSdk) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-list-callers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const httpClient = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });
  const sdk = factory({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient });
  await sdk.initWorkspace();
  return sdk;
}

// --- the teardown: the table step ---------------------------------------------------------------------------------------------------------------------------------------------

const WIDGET_SPEC = { entities: [{ schemaName: 'new_widget', primaryAttribute: { schemaName: 'new_name' }, columns: [] }] };
const WIDGET = { logicalName: 'new_widget' };
const tearDown = async (t, org, factory) => runTeardown(WIDGET_SPEC, { apply: true }, { sdk: await makeSdk(t, org, factory), emit: () => {} });

test('TEARDOWN: a custom table is deleted — one read of the table list, then the delete — with the same requests as when the bundle\u2019s own factory made the SDK', async (t) => {
  const viaFactory = createOrg({ tables: [WIDGET] });
  const viaBundle = createOrg({ tables: [WIDGET] });
  const result = await tearDown(t, viaFactory, createMakerSdk);
  const unguarded = await tearDown(t, viaBundle, bundle.createMakerSdk);
  assert.deepStrictEqual([result.ok, result.deleted, result.errors], [true, { table: ['new_widget'] }, []]);
  assert.deepStrictEqual(viaFactory.requests, [TABLE_LIST, DELETE_TABLE('new_widget')]);
  assert.deepStrictEqual(viaFactory.requests, viaBundle.requests);
  assert.deepStrictEqual(result, unguarded);
});

test('TEARDOWN: a system table is left alone, `{ "value": [] }` goes on to the delete, and a refused read fails the step with nothing deleted', async (t) => {
  const system = createOrg({ tables: [{ logicalName: 'new_widget', custom: false }] });
  const left = await tearDown(t, system);
  assert.deepStrictEqual([left.ok, left.deleted, system.requests], [true, {}, [TABLE_LIST]]);
  assert.ok(left.skipped.some((line) => /system table/.test(line)), JSON.stringify(left.skipped));
  // An empty list is an empty answer: nothing proves the table is a system one, and it is not there to be refused either; the delete tolerates its absence.
  const empty = createOrg({ list: json(200, { value: [] }) });
  const goneAlready = await tearDown(t, empty);
  assert.deepStrictEqual([goneAlready.ok, empty.requests], [true, [TABLE_LIST, DELETE_TABLE('new_widget')]]);
  // A refusal of the read says nothing about the table — not that it is gone, not that it is not a system table — so the step fails
  // with the reason and no delete is sent; a re-run once the read answers finishes it.
  const refused = createOrg({ tables: [WIDGET], list: json(403, { error: { message: 'The user is not a member of the organization.' } }) });
  const afterRefusal = await tearDown(t, refused);
  assert.deepStrictEqual([afterRefusal.ok, afterRefusal.deleted, refused.writes()], [false, {}, []]);
  assert.match(afterRefusal.errors[0].message, /^table 'new_widget' was not deleted: the environment's tables could not be read, so whether it is there, and whether it is a system table, is unknown \(HTTP 403 .*The user is not a member of the organization\./);
  assert.ok(refused.tables.has('new_widget'));
});

// The bundled SDK refuses a table list that says it holds more rows than it gave (`@Microsoft.Dynamics.CRM.morerecords` with no link to
// them), and one whose next page could not be read: neither is the whole list, so the table the step is about — here a SYSTEM table,
// listed on the page that was read — is unknown. The step fails closed: no DELETE is sent from half an answer.
const SYSTEM_WIDGET = { ...definition({ logicalName: 'new_widget', custom: false }) };
const INCOMPLETE = {
  'a page that says more rows exist and gives no link to them': { list: json(200, { value: [SYSTEM_WIDGET], '@Microsoft.Dynamics.CRM.morerecords': true }), reason: /more rows exist/ },
  'a page whose next page answers 503': {
    list: json(200, { value: [SYSTEM_WIDGET], '@odata.nextLink': `${ORIGIN}/api/data/v9.0/EntityDefinitions?$select=LogicalName&$skiptoken=2` }),
    nextPage: json(503, { error: { code: '0x80000001', message: 'Service Unavailable' } }),
    reason: /HTTP 503/,
  },
};
for (const [shape, { list, nextPage, reason }] of Object.entries(INCOMPLETE)) {
  test(`TEARDOWN: a table list that is ${shape} fails the step — no DELETE is sent from half an answer`, async (t) => {
    const org = createOrg({ tables: [{ logicalName: 'new_widget', custom: false }], list, nextPage });
    const result = await tearDown(t, org);
    assert.deepStrictEqual([result.ok, result.deleted, org.writes()], [false, {}, []]);
    assert.strictEqual(result.errors[0].step, 'table new_widget');
    assert.match(result.errors[0].message, /^table 'new_widget' was not deleted: the environment's tables could not be read, so whether it is there, and whether it is a system table, is unknown \(/);
    assert.match(result.errors[0].message, reason);
    // The same list read whole lists the table as a system table, which the step leaves alone.
    const whole = createOrg({ tables: [{ logicalName: 'new_widget', custom: false }], list: json(200, { value: [SYSTEM_WIDGET] }) });
    const left = await tearDown(t, whole);
    assert.deepStrictEqual([left.ok, whole.writes()], [true, []]);
  });
}

for (const [shape, answer] of Object.entries(NOT_A_LIST)) {
  test(`TEARDOWN: a table list that is ${shape} is a failed step — nothing is deleted, and nothing is reported deleted`, async (t) => {
    const org = createOrg({ tables: [WIDGET], list: answer });
    const result = await tearDown(t, org);
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.deleted, {}, 'no table is reported deleted');
    assert.deepStrictEqual(org.writes(), [], 'and no delete was sent');
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].step, 'table new_widget');
    assert.match(result.errors[0].message, /^table 'new_widget' was not deleted: The environment's tables could not be read: the platform answered HTTP 200 with .*, which is not a list of tables\./);
    assert.ok(org.tables.has('new_widget'), 'the table is still there');
  });
}

test('TEARDOWN: an environment that answers everything with a sign-in page is not torn down — the delete it would have taken for done is never sent', async (t) => {
  // Measured on the bundle: a DELETE answered with a page is a 2xx, which the SDK takes for done and `tolerateNotFound` for gone, so a teardown that read the table list as "no tables" reported the table deleted.
  const org = createOrg({ tables: [WIDGET], list: SIGN_IN, deleteAnswer: SIGN_IN });
  const result = await tearDown(t, org);
  assert.deepStrictEqual([result.ok, result.deleted, org.writes()], [false, {}, []]);
  assert.match(result.errors[0].message, /not a list of tables/);
});

// --- entity-provision: findExistingTable, the build's data-model phase and the dry run's plan ------------------------------------------------------------------------------------

const inconclusive = raw(200, 'text/html', '<html>Sign in</html>');

test('PROVISION: findExistingTable on an inconclusive narrow read reads the list — a table in it is reused, `{ "value": [] }` is absent — and an answer that is no list stops the build before any create', async (t) => {
  const present = createOrg({ tables: [WIDGET], narrow: inconclusive });
  const hit = await findExistingTable(await makeSdk(t, present), 'new_widget');
  assert.deepStrictEqual([hit.logicalName, hit.entitySetName], ['new_widget', 'new_widgets']);
  assert.deepStrictEqual(present.requests, [NARROW('new_widget'), TABLE_LIST]);
  const empty = createOrg({ list: json(200, { value: [] }), narrow: inconclusive });
  assert.strictEqual(await findExistingTable(await makeSdk(t, empty), 'new_widget'), null);
  for (const [shape, answer] of Object.entries(NOT_A_LIST)) {
    const org = createOrg({ tables: [WIDGET], list: answer, narrow: inconclusive });
    await assert.rejects(findExistingTable(await makeSdk(t, org), 'new_widget'), (err) => {
      assert.ok(err instanceof BuildHalt, shape);
      assert.deepStrictEqual([err.phase, err.code, err.recoverable], ['data-model', 'table-list-unreadable', true], shape);
      assert.match(err.message, /^could not determine whether table 'new_widget' already exists: The environment's tables could not be read: .*not a list of tables\./, shape);
      assert.strictEqual(err.cause.code, 'TABLES_UNREADABLE', shape);
      return true;
    }, shape);
  }
});

test('PROVISION: the one-table read decides without the list when it can — a 404 is absent, a definition is present — and a localized table never falls back to it', async (t) => {
  const absent = createOrg({ list: SIGN_IN });
  assert.strictEqual(await findExistingTable(await makeSdk(t, absent), 'new_widget'), null);
  assert.deepStrictEqual(absent.requests, [NARROW('new_widget')], 'the list is not read, so an unreadable one is not met');
  const present = createOrg({ tables: [WIDGET], list: SIGN_IN });
  assert.deepStrictEqual(await findExistingTable(await makeSdk(t, present), 'new_widget'), { logicalName: 'new_widget', entitySetName: 'new_widgets' });
  assert.deepStrictEqual(present.requests, [NARROW('new_widget')]);
  const localized = createOrg({ tables: [WIDGET], list: SIGN_IN, narrow: inconclusive });
  await assert.rejects(findExistingTable(await makeSdk(t, localized), 'new_widget', { hasLocalizedLabels: true, attempts: 2 }), (err) => err.code === 'table-probe-inconclusive');
  assert.deepStrictEqual(localized.requests, [NARROW('new_widget'), NARROW('new_widget')], 'never the list: it is what makes the platform keep one language');
});

// The data-model phase on a spec of one table. The SDK that WRITES is a spy; the one that READS is the real bundle over the fake.
function dataModelRun(realSdk, created) {
  const runner = {
    run: async (p, l, fn, o = {}) => { try { return await fn(); } catch (e) { if (o.skipIf && o.skipIf(e)) return undefined; throw e; } },
    skip: () => {},
    mapLimit: async (items, _n, fn) => { const out = []; for (const it of items) out.push(await fn(it)); return out; },
  };
  const sdk = {
    createTable: async (o) => { created.push(o.schemaName); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s` }; },
    createColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase() }),
    updateTable: async () => undefined,
  };
  const provision = {
    dataverse: realSdk.dataverse,
    findTables: (...args) => realSdk.findTables(...args),
    findColumns: async () => [],
    fetchEntityMetadata: async (l) => ({ logicalName: l, entitySetName: `${l}s`, relationships: [] }),
    queryRecords: async () => [],
  };
  const spec = {
    solution: { uniqueName: 'contoso', publisherPrefix: 'new' },
    languageCode: 1033,
    entities: [{ schemaName: 'new_widget', displayName: 'Widget', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    relationships: [],
  };
  return () => provisionDataModel({ spec, sdk, provision, runner, preResolvedLanguageCode: 1033 });
}

test('PROVISION: a table list that is no list does not make the build create a table that may exist — and a real list, or an empty one, decides as it always did', async (t) => {
  for (const [shape, answer] of Object.entries(NOT_A_LIST)) {
    const created = [];
    const org = createOrg({ tables: [WIDGET], list: answer, narrow: inconclusive });
    await assert.rejects(dataModelRun(await makeSdk(t, org), created)(), (err) => err instanceof BuildHalt && err.code === 'table-list-unreadable', shape);
    assert.deepStrictEqual(created, [], `${shape}: no create was attempted`);
  }
  const reuse = [];
  await dataModelRun(await makeSdk(t, createOrg({ tables: [WIDGET], narrow: inconclusive })), reuse)();
  assert.deepStrictEqual(reuse, [], 'the table is in the list: reused');
  const create = [];
  await dataModelRun(await makeSdk(t, createOrg({ list: json(200, { value: [] }), narrow: inconclusive })), create)();
  assert.deepStrictEqual(create, ['new_widget'], 'an empty list is an empty environment: created');
});

test('PLAN: the dry run says `unknown` for a table whose list could not be read — not `create` — and keeps `create` for an empty list and `reuse` for a table in it', async (t) => {
  const stateOf = async (org) => {
    const real = await makeSdk(t, org);
    const provision = { dataverse: real.dataverse, findTables: (...args) => real.findTables(...args), findColumns: async () => [], fetchEntityMetadata: async () => ({}), queryRecords: async () => [] };
    const spec = { solution: { uniqueName: 'contoso', publisherPrefix: 'new' }, app: { name: 'Widget App' }, entities: [{ schemaName: 'new_widget', displayName: 'Widget', primaryAttribute: { schemaName: 'new_name' }, columns: [] }] };
    const plan = await annotateLivePlan(planFor(spec, {}), { spec, provision });
    return plan.find((item) => item.key && item.key.kind === 'table' && item.key.entity === 'new_widget');
  };
  for (const [shape, answer] of Object.entries(NOT_A_LIST)) {
    const item = await stateOf(createOrg({ tables: [WIDGET], list: answer, narrow: inconclusive }));
    assert.strictEqual(item.state, 'unknown', shape);
    assert.match(item.stateWhy, /could not determine whether table 'new_widget' already exists: The environment's tables could not be read/, shape);
  }
  assert.strictEqual((await stateOf(createOrg({ list: json(200, { value: [] }), narrow: inconclusive }))).state, 'create');
  assert.strictEqual((await stateOf(createOrg({ tables: [WIDGET], narrow: inconclusive }))).state, 'reuse');
});

// --- the build: a business process flow's name check -------------------------------------------------------------------------------------------------------------------------

const FLOW = {
  name: 'Ticket Handling',
  entity: 'new_ticket',
  stages: [
    { name: 'Triage', steps: [{ name: 'Subject', field: 'new_subject', required: true }] },
    { name: 'Resolve', steps: [{ name: 'Notes', field: 'new_notes' }] },
  ],
};
const flowSpec = () => ({
  solution: { uniqueName: 'BPF', displayName: 'BPF', publisherPrefix: 'new' },
  app: { name: 'BPF App', description: '' },
  entities: [{
    schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets',
    primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
    columns: [{ schemaName: 'new_notes', displayName: 'Notes', type: 'Memo' }],
  }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'new_ticket', title: 'Tickets' }] }] }] },
  businessProcessFlows: [FLOW],
});

// The writing SDK of the build is the simple mock; `provision` answers the flow reads with nothing and, for the table list, is the real bundle over `org`.
async function buildFlow(t, org) {
  const real = await makeSdk(t, org);
  const calls = [];
  const warnings = [];
  const provision = {
    queryRecords: async (entity) => (entity === 'workflow' || entity === 'solution' ? [] : [{ publisherid: 'pub-1' }]),
    findTables: (...args) => real.findTables(...args),
    updateRecord: async () => undefined,
    deleteRecord: async () => undefined,
    createArtifact: (kind, def) => { calls.push(['createArtifact', kind, def.name]); return { id: 'bpf-new' }; },
    updateElement: async () => undefined,
    pushArtifact: async (kind, id) => { calls.push(['pushArtifact', kind, id]); return { id: 'bpf-new', saved: true, publish: { kind: 'notRequested' } }; },
    addSolutionComponent: async () => undefined,
  };
  const { sdk } = makeSimpleMockSdk();
  const outcome = await runSdkBuild(flowSpec(), { sdk, provisionSdk: provision, apply: true, phases: ['business-process-flows'], warn: (message) => warnings.push(message) }).then(() => null, (error) => error);
  return { outcome, calls, warnings };
}

test('BUILD: a flow\u2019s name check says so when the table list could not be read — the flow is still created, as a diagnostic that cannot run never stops a build', async (t) => {
  for (const [shape, answer] of Object.entries(NOT_A_LIST)) {
    const { outcome, calls, warnings } = await buildFlow(t, createOrg({ list: answer }));
    assert.strictEqual(outcome, null, `${shape}: the build goes on`);
    assert.ok(calls.some((c) => c[0] === 'createArtifact'), `${shape}: the flow is created`);
    assert.strictEqual(warnings.length, 1, `${shape}: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /^business process flow "Ticket Handling" on new_ticket: could not check whether a table already holds the name 'new_tickethandling' it derives — The environment's tables could not be read: the platform answered HTTP 200 with [^.]*, which is not a list of tables\. The flow is created anyway; if the create fails over a name already in use, rename the flow\.$/, `${shape}: ${warnings[0]}`);
    assert.ok(!/sign in again|then retry/.test(warnings[0]), 'the advice for a script that stopped is not part of a warning from a build that goes on');
  }
});

test('BUILD: a table that holds the name still stops the flow, an empty list and a refused read say nothing, and the requests are the ones the bundle\u2019s own factory sends', async (t) => {
  const clash = createOrg({ tables: [{ logicalName: 'new_tickethandling' }] });
  const stopped = await buildFlow(t, clash);
  assert.ok(stopped.outcome, 'the table clash halts');
  assert.match(stopped.outcome.message, /the table 'new_tickethandling'/);
  assert.deepStrictEqual(stopped.calls, [], 'and nothing is written');
  const empty = createOrg({ list: json(200, { value: [] }) });
  const fine = await buildFlow(t, empty);
  assert.deepStrictEqual([fine.outcome, fine.warnings, fine.calls.some((c) => c[0] === 'createArtifact')], [null, [], true]);
  assert.deepStrictEqual(empty.requests, [TABLE_LIST]);
  const refused = await buildFlow(t, createOrg({ list: json(403, { error: { message: 'The user is not a member of the organization.' } }) }));
  assert.deepStrictEqual([refused.outcome, refused.warnings, refused.calls.some((c) => c[0] === 'createArtifact')], [null, [], true], 'a failure that is the SDK\u2019s own stays silent, as it was');
});

// --- the verifier: the catalog of tables -----------------------------------------------------------------------------------------------------------------------------------------

const verifyWidget = async (t, org, factory) => {
  const sdk = await makeSdk(t, org, factory);
  return verifySpec(WIDGET_SPEC, readerFor(sdk, 'contoso_app', {}), { concurrency: 1 });
};
const entityCheck = (report) => report.checks.find((c) => c.kind === 'entity' && c.name === 'new_widget');

test('VERIFY: a table list that is no list fails the verify with the reason — it does not report every declared table missing', async (t) => {
  for (const [shape, answer] of Object.entries(NOT_A_LIST)) {
    await assert.rejects(verifyWidget(t, createOrg({ tables: [WIDGET], list: answer })), (err) => {
      assert.strictEqual(err.code, 'TABLES_UNREADABLE', shape);
      assert.match(err.message, /^The environment's tables could not be read: .*not a list of tables\./, shape);
      return true;
    }, shape);
  }
});

test('VERIFY: a table in the list is present, one that is not is missing — an empty list is a verdict — and the requests are the ones the bundle\u2019s own factory sends', async (t) => {
  const viaFactory = createOrg({ tables: [WIDGET] });
  const viaBundle = createOrg({ tables: [WIDGET] });
  const present = await verifyWidget(t, viaFactory, createMakerSdk);
  const unguarded = await verifyWidget(t, viaBundle, bundle.createMakerSdk);
  assert.strictEqual(entityCheck(present).present, true);
  assert.deepStrictEqual(present.checks, unguarded.checks);
  assert.deepStrictEqual(viaFactory.requests, viaBundle.requests);
  assert.strictEqual(viaFactory.requests.filter((r) => r === TABLE_LIST).length, 1, 'one scan of the catalog');
  const empty = await verifyWidget(t, createOrg({ list: json(200, { value: [] }) }));
  assert.strictEqual(entityCheck(empty).present, false, 'an empty environment really has no such table');
  assert.strictEqual(empty.ok, false);
});

test('VERIFY: a failed scan is not kept — the next pass reads the list again', async (t) => {
  const org = createOrg({ tables: [WIDGET], list: SIGN_IN });
  const reader = readerFor(await makeSdk(t, org), 'contoso_app', {});
  await assert.rejects(reader.findTable('new_widget'), (err) => err.code === 'TABLES_UNREADABLE');
  org.list = undefined;
  assert.deepStrictEqual(await reader.findTable('new_widget'), { logicalName: 'new_widget', schemaName: 'new_widget', displayName: 'new_widget', entitySetName: 'new_widgets', isCustom: true });
});
