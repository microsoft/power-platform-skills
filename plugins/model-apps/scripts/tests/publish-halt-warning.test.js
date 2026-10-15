'use strict';
// What a build that stops before its publish phase says it left saved and not live.
//
// A table's publish ships everything saved on that table, whoever saved it, so when the one a halted build sends fails, what is not live
// is not only what the build deferred: it is every form, view and chart saved on the table. The build deferred some of them (the views and
// forms it reconciled, the default views it enriched) and created others, which no publish was owed for; a maker may have saved more.
// The warning used to name what was deferred, and nothing at all when nothing was. It now reads the saved layer of the spec's tables and
// names what that holds that is not published, or says that it could not read it and which tables to publish.
//
// The first half drives the REAL vendored SDK against the stateful fake Dataverse (helpers/fake-dataverse.js), so the line is compared with
// the rows the platform actually holds unpublished (`fake.unpublished()`); the second half drives the CLI wiring (build-model-app.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild, settleOwedPublishes } = require('../lib/sdk-build.js');
const { STAGES } = require('../lib/stages.js');
const { buildModelApp } = require('../build-model-app.js');
const { createFakeDataverse } = require('./helpers/fake-dataverse.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ORIGIN = 'https://contoso.crm.dynamics.com';
const ENTITIES = {
  new_ticket: { attributes: { new_name: 'String', new_code: 'String', new_area: 'String', new_extra: 'String' } },
  new_task: { attributes: { new_name: 'String', new_due: 'String' } },
  new_note: { attributes: { new_name: 'String' } },
};
const TABLES = ['new_ticket', 'new_task', 'new_note'];
const PHASES = ['views', 'charts', 'forms', 'publish'];
const KIND = { savedqueries: 'view', systemforms: 'form', savedqueryvisualizations: 'chart' };

// Ticket and Task have a view and a form each, Ticket a chart. Note is a table the spec only names: nothing in the spec changes it.
function specFor({ ticketColumns = ['new_code', 'new_area'], viewColumns = ['new_name', 'new_code'] } = {}) {
  const table = (schemaName, displayName, pluralName, columns) => ({ schemaName, displayName, pluralName, existing: true, primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns });
  return {
    $schemaVersion: '1.0',
    solution: { uniqueName: 'ContosoSD', displayName: 'Contoso SD', publisherPrefix: 'new' },
    app: { name: 'Support Desk', uniqueName: 'new_supportdesk' },
    entities: [
      table('new_ticket', 'Ticket', 'Tickets', ticketColumns.map((c) => ({ schemaName: c, displayName: c, type: 'Text' }))),
      table('new_task', 'Task', 'Tasks', [{ schemaName: 'new_due', displayName: 'Due', type: 'Text' }]),
      table('new_note', 'Note', 'Notes', []),
    ],
    views: [
      { entity: 'new_ticket', name: 'Open Tickets', columns: viewColumns },
      { entity: 'new_task', name: 'My Tasks', columns: ['new_name', 'new_due'] },
    ],
    charts: [{ entity: 'new_ticket', name: 'By Area', chartType: 'Pie', groupBy: 'new_area', measure: 'count' }],
    forms: [{ entity: 'new_ticket', name: 'Ticket', layout: 'auto' }, { entity: 'new_task', name: 'Task', layout: 'auto' }],
  };
}
// The same spec with a new Ticket column and a new column on its view: the view is saved, and the form needs a push, so a refused form write
// halts the build in the forms phase with the view's publish owed.
const changedSpec = () => specFor({ ticketColumns: ['new_code', 'new_area', 'new_extra'], viewColumns: ['new_name', 'new_code', 'new_area'] });

function scenario(fakeOptions = {}) {
  const fake = createFakeDataverse({ entities: ENTITIES, ...fakeOptions });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-halt-'));
  dirs.push(dir);
  const sdkOver = async () => {
    const real = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient: fake.httpClient });
    await real.initWorkspace();
    return real;
  };
  // A build that completes (and so publishes) over the same workspace and environment.
  async function build(spec) {
    const sdk = await sdkOver();
    return runSdkBuild(spec, { sdk, apply: true, publish: true, phases: PHASES, warn: () => {} });
  }
  // A maker's save in the Maker portal that nobody published: the row moves on, its published version stays.
  const makerSaves = (collection, name) => { fake.rows(collection).find((r) => r.data.name === name).version += 1; };
  // A form a maker saved and never published, on a table the build does not touch: the platform lists it as a saved record of that table.
  const makerCreatesForm = async (table, name) => {
    const response = await fake.httpClient.post(`${ORIGIN}/api/data/v9.0/systemforms`, { formid: randomUUID(), name, objecttypecode: table, type: 2 });
    assert.ok(response.status < 300, `the fake accepted the form: ${response.status}`);
  };
  return { fake, sdkOver, build, makerSaves, makerCreatesForm };
}

const halts = (promise) => promise.then(() => null, (e) => e);
const FORM_WRITES_DOWN = (req) => (req.method === 'PATCH' && /^\/systemforms\(/.test(req.path) && req.body && req.body.formxml ? 500 : undefined);
const FORM_CREATES_DOWN = (req) => (req.method === 'POST' && req.path === '/systemforms' ? 500 : undefined);
const PUBLISH_XML_DOWN = (req) => (req.method === 'POST' && req.path === '/PublishXml' ? 500 : undefined);

// `view Open Tickets` for each record the platform holds unpublished, in a stable order.
const notLive = (fake) => fake.unpublished().map((r) => `${KIND[r.kind]} ${r.name}`).sort();
// The items a warning names, whatever table they are listed under: `... \u2014 new_ticket: view A, chart B; new_task: form C. Run the build again ...`.
function listedIn(line) {
  const body = /\u2014 (.*?)\. Run the build again/.exec(line);
  assert.ok(body, `a list of what is saved but not published: ${line}`);
  return body[1].split('; ').flatMap((part) => part.slice(part.indexOf(': ') + 2).split(', ')).sort();
}
const READS = (fake, mark = 0) => fake.requests.slice(mark).filter((e) => /RetrieveUnpublishedMultiple/.test(e.path));

// --------------------------------------------------------------------------------------------- with the real SDK

test('a build that stops having deferred nothing still names the views and the chart it created and never published', async () => {
  const s = scenario();
  s.fake.failWritesWhen(FORM_CREATES_DOWN);
  const sdk = await s.sdkOver();
  const halted = await halts(runSdkBuild(specFor(), { sdk, apply: true, publish: true, phases: PHASES }));
  s.fake.failWritesWhen(null);
  assert.ok(halted && halted.phase === 'forms', String(halted));
  assert.strictEqual(halted.owedPublishes, undefined, 'the views and the chart were created, so no publish was deferred for them');
  assert.deepStrictEqual(notLive(s.fake), ['chart By Area', 'view My Tasks', 'view Open Tickets'], 'they are saved, and not live');

  const warnings = [];
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w), { tables: TABLES });
  assert.strictEqual(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /^the build stopped before its publish phase; forms, views and charts saved but not published on the spec's tables \u2014 new_ticket: view Open Tickets, chart By Area; new_task: view My Tasks\. /);
  assert.deepStrictEqual(listedIn(warnings[0]), notLive(s.fake), 'what the line names is exactly what the platform holds unpublished');
  assert.strictEqual(READS(s.fake).length, 3, 'one read of the saved layer for each of views, forms and charts');
});

test('when settling the publish a halted build owes fails, the warning names everything saved on the table, not only what was deferred', async () => {
  const s = scenario();
  await s.build(specFor());
  assert.deepStrictEqual(notLive(s.fake), [], 'everything is live to begin with');
  s.makerSaves('savedqueryvisualizations', 'By Area'); // a change nobody published, on a chart this build never touches
  s.fake.failWritesWhen(FORM_WRITES_DOWN);
  const sdk = await s.sdkOver();
  const halted = await halts(runSdkBuild(changedSpec(), { sdk, apply: true, publish: true, phases: PHASES }));
  assert.ok(halted && halted.phase === 'forms', String(halted));
  assert.ok(halted.owedPublishes.some(([, , names]) => (names || []).includes('view Open Tickets')), 'the view the reconcile saved is owed');

  s.fake.failWritesWhen(PUBLISH_XML_DOWN);
  const warnings = [];
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w), { tables: TABLES });
  s.fake.failWritesWhen(null);
  const failed = warnings.filter((w) => /FAILED/.test(w));
  assert.ok(failed.length >= 1 && failed.every((w) => /^the build stopped before its publish phase; publish /.test(w)), 'the lines about the publishes are what they were');
  assert.ok(failed.every((w) => !/By Area/.test(w)), 'they name only what was deferred');
  const saved = warnings.find((w) => /saved but not published on the spec's tables/.test(w));
  assert.ok(saved, warnings.join('\n'));
  assert.deepStrictEqual(listedIn(saved), notLive(s.fake));
  assert.deepStrictEqual(listedIn(saved), ['chart By Area', 'view Open Tickets'], 'the maker\u2019s chart is named with the view the build saved');
  assert.strictEqual(warnings.indexOf(saved), warnings.length - 1, 'after the lines about the publishes');
});

test('a halted build whose owed publishes went through names only what is still saved and not published: a table it never touched', async () => {
  const s = scenario();
  await s.build(specFor());
  await s.makerCreatesForm('new_note', 'Note Main'); // saved by a maker, never published, on a table the spec only names
  s.fake.failWritesWhen(FORM_WRITES_DOWN);
  const sdk = await s.sdkOver();
  const halted = await halts(runSdkBuild(changedSpec(), { sdk, apply: true, publish: true, phases: PHASES }));
  s.fake.failWritesWhen(null);
  assert.ok(halted && halted.owedPublishes.length >= 1);
  assert.ok(notLive(s.fake).includes('view Open Tickets') && notLive(s.fake).includes('form Note Main'), `saved and not live: ${notLive(s.fake)}`);

  const warnings = [];
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w), { tables: TABLES });
  assert.deepStrictEqual(notLive(s.fake), ['form Note Main'], 'the owed publish made the tables the build saved live');
  assert.strictEqual(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /\u2014 new_note: form Note Main\. Run the build again with --publish, or publish those tables in Power Apps: /);
  assert.deepStrictEqual(listedIn(warnings[0]), notLive(s.fake));
});

test('a halted build that has nothing saved and not published says nothing more than it did', async () => {
  const s = scenario();
  await s.build(specFor());
  s.fake.failWritesWhen(FORM_WRITES_DOWN);
  const sdk = await s.sdkOver();
  const halted = await halts(runSdkBuild(changedSpec(), { sdk, apply: true, publish: true, phases: PHASES }));
  s.fake.failWritesWhen(null);
  const warnings = [];
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w), { tables: TABLES });
  assert.deepStrictEqual(notLive(s.fake), [], 'the settle published everything the build saved');
  assert.deepStrictEqual(warnings, []);
});

test('when the saved layer cannot be read, the warning says so and names the tables to publish, never a list it could not check', async () => {
  const s = scenario();
  s.fake.failWritesWhen(FORM_CREATES_DOWN);
  const sdk = await s.sdkOver();
  const halted = await halts(runSdkBuild(specFor(), { sdk, apply: true, publish: true, phases: PHASES }));
  s.fake.failWritesWhen(null);
  s.fake.failUnpublishedReads(true);
  const warnings = [];
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w), { tables: TABLES });
  assert.strictEqual(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /^the build stopped before its publish phase; which forms, views and charts on the spec's tables are saved but not published could not be read \(the saved views: HTTP 500: simulated failure\)\. Run the build again with --publish, or publish these tables in Power Apps: new_ticket, new_task, new_note\.$/);
  assert.ok(!/Open Tickets/.test(warnings[0]), 'nothing is claimed about what could not be read');
});

test('settling without the spec\u2019s tables reads nothing and says what it always said', async () => {
  const s = scenario();
  s.fake.failWritesWhen(FORM_CREATES_DOWN);
  const sdk = await s.sdkOver();
  const halted = await halts(runSdkBuild(specFor(), { sdk, apply: true, publish: true, phases: PHASES }));
  s.fake.failWritesWhen(null);
  const mark = s.fake.mark();
  const warnings = [];
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w));
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w), {});
  await settleOwedPublishes(sdk, halted.owedPublishes, (w) => warnings.push(w), { tables: [] });
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(READS(s.fake, mark), []);
});

test('a settle with no warning callback and no client still never throws', async () => {
  await settleOwedPublishes({ dataverse: { get: async () => { throw new Error('down'); } } }, [], undefined, { tables: TABLES });
  await settleOwedPublishes({}, [], () => assert.fail('a client-less SDK has nothing to read and nothing to say'), { tables: TABLES });
  await settleOwedPublishes(null, [], () => assert.fail('no SDK, nothing'), { tables: TABLES });
});

// ---------------------------------------------------------------------------------------------- the CLI wiring

const TRANSIENT = 'CustomizationLockException: try again later';
const quietState = { collision: { appExists: false, solutionExists: false }, forms: [], sitemap: null };
const desk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8'));
const DESK_TABLES = ['new_customer', 'new_ticket', 'new_comment'];
const owing = (message, owedPublishes) => Object.defineProperties(new Error(message), { owedPublishes: { value: owedPublishes } });

// What the platform answers for the saved layer of each collection, by the `$filter` the build asks with; every URL asked is kept.
function platformLayers(saved = {}, { status = 200 } = {}) {
  const urls = [];
  const tableField = { savedqueries: 'returnedtypecode', systemforms: 'objecttypecode', savedqueryvisualizations: 'primaryentitytypecode' };
  return {
    urls,
    get: async (url) => {
      urls.push(url);
      const m = /^\/(savedqueries|systemforms|savedqueryvisualizations)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?(.*)$/.exec(url);
      if (!m) return { status: 404, body: null };
      if (status !== 200) return { status, body: { error: { message: 'the platform refused' } } };
      const wanted = [...m[2].matchAll(/ eq '([^']*)'/g)].map((x) => x[1]);
      return { status: 200, body: { value: (saved[m[1]] || []).filter((r) => wanted.includes(r[tableField[m[1]]])) } };
    },
  };
}
const savedRow = (collection, name, table) => ({ name, [{ savedqueries: 'returnedtypecode', systemforms: 'objecttypecode', savedqueryvisualizations: 'primaryentitytypecode' }[collection]]: table, [{ savedqueries: 'savedqueryid', systemforms: 'formid', savedqueryvisualizations: 'savedqueryvisualizationid' }[collection]]: randomUUID(), componentstate: 1 });

function cliSdk(dataverse) {
  const published = [];
  return { published, sdk: { dataverse, publishArtifact: async (type, id) => { published.push(`${type} ${id}`); return { type, id, shipped: true, publish: { kind: 'verified' } }; } } };
}
async function runCli({ attempts, dataverse, opts = {}, warn = true }) {
  const { sdk, published } = cliSdk(dataverse);
  let n = 0;
  const runBuild = async () => { const outcome = attempts[Math.min(n, attempts.length - 1)]; n += 1; if (outcome instanceof Error) throw outcome; return outcome; };
  const warnings = [];
  const deps = { sdk, provisionSdk: sdk, runBuild, discoverOpDiffState: async () => quietState, ...(warn ? { warn: (m) => warnings.push(String(m)) } : {}) };
  const settled = await buildModelApp(desk, { apply: true, publish: true, env: 'https://x', retryDelayMs: 0, ...opts }, deps).then((r) => ({ result: r }), (error) => ({ error }));
  return { ...settled, warnings, published, attempts: n };
}

test('a build that halts for good names what the spec\u2019s tables hold saved and not published, once, after it settled what it owed', async () => {
  const dataverse = platformLayers({ savedqueries: [savedRow('savedqueries', 'Open Tickets', 'new_ticket')], systemforms: [savedRow('systemforms', 'Comment Card', 'new_comment')], savedqueryvisualizations: [savedRow('savedqueryvisualizations', 'Elsewhere', 'account')] });
  const { error, warnings, published } = await runCli({ attempts: [owing('bad request', [['view', 'v1', ['view Open Tickets']]])], dataverse });
  assert.match(error.message, /bad request/, 'the halt is what the run reports');
  assert.deepStrictEqual(published, ['view v1'], 'the owed publish was sent first');
  assert.strictEqual(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /^the build stopped before its publish phase; forms, views and charts saved but not published on the spec's tables \u2014 new_ticket: view Open Tickets; new_comment: form Comment Card\. /, 'in the spec\u2019s order; a record of another table is not named');
  assert.strictEqual(dataverse.urls.length, 3, 'three reads, one per collection');
  for (const url of dataverse.urls) for (const table of DESK_TABLES) assert.ok(url.includes(`'${table}'`), `${url} asks about ${table}`);
});

test('a transient halt that is retried reads nothing; the halt that ends the retries is reported once, not once per attempt', async () => {
  const recovered = platformLayers();
  const ok = await runCli({ attempts: [new Error(TRANSIENT), { ok: true, created: {}, skipped: { layout: [] } }], dataverse: recovered });
  assert.ok(ok.result && ok.result.ok, 'the retry succeeded');
  assert.deepStrictEqual(recovered.urls, []);
  assert.deepStrictEqual(ok.warnings, []);

  const dataverse = platformLayers({ savedqueries: [savedRow('savedqueries', 'Open Tickets', 'new_ticket')] });
  const exhausted = await runCli({ attempts: [new Error(TRANSIENT)], dataverse });
  assert.strictEqual(exhausted.attempts, 4, 'the first attempt and three retries');
  assert.strictEqual(exhausted.warnings.length, 1, exhausted.warnings.join('\n'));
  assert.strictEqual(dataverse.urls.length, 3);
});

test('when the saved layer cannot be read the run says so and names the spec\u2019s tables', async () => {
  const dataverse = platformLayers({}, { status: 500 });
  const { error, warnings } = await runCli({ attempts: [new Error('bad request')], dataverse });
  assert.match(error.message, /bad request/);
  assert.strictEqual(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /could not be read \(the saved views: HTTP 500: the platform refused\)\. Run the build again with --publish, or publish these tables in Power Apps: new_customer, new_ticket, new_comment\.$/);
});

test('nothing is read where there is no publish phase to have stopped before, or nothing was written', async () => {
  const none = platformLayers({ savedqueries: [savedRow('savedqueries', 'Open Tickets', 'new_ticket')] });
  const without = await runCli({ attempts: [new Error('bad request')], dataverse: none, opts: { publish: false } });
  assert.match(without.error.message, /bad request/);
  const dry = await runCli({ attempts: [new Error('bad request')], dataverse: none, opts: { apply: false } });
  assert.match(dry.error.message, /bad request/);
  const staged = await runCli({ attempts: [new Error('bad request')], dataverse: none, opts: { phases: STAGES.data } });
  assert.match(staged.error.message, /bad request/);
  const preflight = await runCli({ attempts: [Object.assign(new Error('refused before writing'), { phase: 'preflight' })], dataverse: none });
  assert.match(preflight.error.message, /refused before writing/);
  assert.deepStrictEqual(none.urls, []);
  for (const run of [without, dry, staged, preflight]) assert.deepStrictEqual(run.warnings, []);
});

test('an SDK with no client to read with, or no warning callback, changes nothing about a halted build', async () => {
  const { error, warnings } = await runCli({ attempts: [new Error('bad request')], dataverse: undefined });
  assert.match(error.message, /bad request/);
  assert.deepStrictEqual(warnings, []);
  const silent = await runCli({ attempts: [new Error('bad request')], dataverse: platformLayers({ savedqueries: [savedRow('savedqueries', 'Open Tickets', 'new_ticket')] }), warn: false });
  assert.match(silent.error.message, /bad request/);
});
