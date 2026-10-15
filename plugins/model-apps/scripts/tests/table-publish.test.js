'use strict';
// lib/table-publish.js: the tables a spec names, the PublishXml that publishes them, and the read of which of their forms, views and
// charts are saved but not published. How the build uses them (the order against the app's publish, what a halted build says) is pinned in
// sdk-build.test.js and publish-halt-warning.test.js; these cases pin the pieces.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  specTables, specAppTables, preAppTables, readAppHeldTables, describePreAppRefusal, describeUnreadAppTables,
  tableList, publishTablesXml, readSavedNotPublished, describeSavedNotPublished,
} = require('../lib/table-publish.js');

// --- tableList ---------------------------------------------------------------------------------------------------------------

test('tableList: every name up to the limit, then how many were left out', () => {
  assert.strictEqual(tableList([], 3), '');
  assert.strictEqual(tableList(['a'], 3), 'a');
  assert.strictEqual(tableList(['a', 'b', 'c'], 3), 'a, b, c');
  assert.strictEqual(tableList(['a', 'b', 'c', 'd'], 3), 'a, b, c and 1 more');
  assert.strictEqual(tableList(['a', 'b', 'c', 'd', 'e', 'f'], 3), 'a, b, c and 3 more');
});

// --- specTables --------------------------------------------------------------------------------------------------------------

test("specTables: the declared tables, then what only the spec's other sections name, lower-cased and once each, in the order the spec gives them", () => {
  const spec = {
    entities: [{ schemaName: 'New_Ticket' }, { schemaName: 'new_task', existing: true }, { schemaName: 'new_ticket' }],
    forms: [{ entity: 'new_form_only' }],
    views: [{ entity: 'NEW_TASK' }, { entity: 'new_view_only' }],
    charts: [{ entity: 'new_chart_only' }],
    app: { tables: ['New_Hidden', 'new_ticket'] },
    appShell: { areas: [{ groups: [{ subAreas: [{ entity: 'new_nav_only' }, { page: 'overview' }, { dashboard: 'Home' }, { url: 'https://contoso.example' }] }] }] },
  };
  assert.deepStrictEqual(specTables(spec), ['new_ticket', 'new_task', 'new_form_only', 'new_view_only', 'new_chart_only', 'new_hidden', 'new_nav_only']);
});

test('specTables: an `existing` table is named like any other, and a spec with no tables names none', () => {
  assert.deepStrictEqual(specTables({ entities: [{ schemaName: 'account', existing: true }] }), ['account']);
  for (const empty of [undefined, null, {}, { entities: [] }, { entities: 'nope', forms: [null, {}, { entity: 5 }], app: { tables: 'nope' }, appShell: { areas: [null, { groups: [null, {}] }] } }]) {
    assert.deepStrictEqual(specTables(empty), []);
  }
});

test("specTables: only names that can be a table's logical name reach a request body", () => {
  // The names go into an XML body, so one that is not an identifier is left out rather than escaped: the platform has no such table.
  const spec = { entities: [{ schemaName: 'new_ok' }, { schemaName: 'x</entity><entity>y' }, { schemaName: 'two words' }, { schemaName: '' }, { schemaName: '9starts_with_digit' }, { schemaName: 'R\u00e9s' }] };
  assert.deepStrictEqual(specTables(spec), ['new_ok']);
});

test("specTables: a page's data sources are named too, declared or not: validation only lints a standard table", () => {
  const spec = {
    entities: [{ schemaName: 'new_ticket' }],
    pages: [{ key: 'overview', dataSources: ['Account', 'new_ticket'] }, { key: 'other', dataSources: ['contact', 5, null, 'two words'] }, { key: 'none' }, null, { dataSources: 'nope' }],
  };
  assert.deepStrictEqual(specTables(spec), ['new_ticket', 'account', 'contact']);
  assert.deepStrictEqual(specTables({ pages: 'nope' }), []);
});

// --- specAppTables and preAppTables ------------------------------------------------------------------------------------------
//
// The tables the build publishes before the app are the ones the app's publish would otherwise leave a saved label on: the tables whose
// forms, views and charts the app holds or is about to hold, and the ones the build itself changed. `specTables` is the wider list the
// spec names, which a halted build reads; a table that is only declared, or the target of a lookup column, is not the app's.
function scopeSpec() {
  return {
    entities: [
      { schemaName: 'new_form' }, { schemaName: 'new_view' }, { schemaName: 'new_chart' }, { schemaName: 'new_declared', existing: true },
      { schemaName: 'new_nav' }, { schemaName: 'new_pinned' },
    ],
    relationships: [{ type: 'OneToMany', referenced: 'new_declared', referencing: 'new_form', lookup: { schemaName: 'new_DeclaredId' } }],
    forms: [{ entity: 'new_form' }],
    views: [{ entity: 'new_view' }],
    charts: [{ entity: 'new_chart' }],
    app: { tables: ['new_pinned'] },
    appShell: { areas: [{ groups: [{ subAreas: [{ entity: 'new_nav' }, { page: 'overview' }, { dashboard: 'Home' }] }] }] },
    pages: [{ key: 'overview', dataSources: ['account'] }],
  };
}
const sorted = (list) => [...list].sort();

test('specAppTables: the navigation, app.tables and the tables of the pages\u2019 default views are the app\u2019s; a declaration and a lookup target are not', () => {
  assert.deepStrictEqual(sorted(specAppTables(scopeSpec(), { newApp: false })), ['account', 'new_nav', 'new_pinned']);
  assert.deepStrictEqual(sorted(specAppTables(scopeSpec())), ['account', 'new_nav', 'new_pinned'], 'an existing app is the default');
});

test('specAppTables: a new app is created holding the forms, views and charts the spec authors, so their tables are its too', () => {
  assert.deepStrictEqual(sorted(specAppTables(scopeSpec(), { newApp: true })), ['account', 'new_chart', 'new_form', 'new_nav', 'new_pinned', 'new_view']);
  for (const empty of [undefined, null, {}, { entities: [{ schemaName: 'new_a' }], relationships: [{ referenced: 'new_b' }] }]) {
    assert.deepStrictEqual(specAppTables(empty, { newApp: true }), []);
  }
});

test('preAppTables: a first build names the tables its new app is about to hold, in the spec\u2019s order, and not a table that is only declared', () => {
  const { tables, undetermined } = preAppTables({ spec: scopeSpec(), reconciled: [], charted: [], existingApp: false });
  assert.deepStrictEqual(tables, ['new_form', 'new_view', 'new_chart', 'new_nav', 'new_pinned', 'account']);
  assert.deepStrictEqual(undetermined, [], 'a new app holds nothing on the server that the spec does not say');
});

test('preAppTables: a rebuild adds the tables the build reconciled and the tables of the charts it wrote, and leaves the rest undetermined until the app\u2019s components are read', () => {
  const { tables, undetermined } = preAppTables({ spec: scopeSpec(), reconciled: ['New_Form', 'new_view'], charted: ['new_chart'], existingApp: true });
  assert.deepStrictEqual(tables, ['new_form', 'new_view', 'new_chart', 'new_nav', 'new_pinned', 'account']);
  assert.deepStrictEqual(undetermined, ['new_declared']);
  const bare = preAppTables({ spec: scopeSpec(), reconciled: [], charted: [], existingApp: true });
  assert.deepStrictEqual(bare.tables, ['new_nav', 'new_pinned', 'account'], 'a table with a spec form is not the app\u2019s on a rebuild unless the build reconciled it or the app holds it');
  assert.deepStrictEqual(bare.undetermined, ['new_form', 'new_view', 'new_chart', 'new_declared']);
});

test('preAppTables: of the spec\u2019s tables, the ones the app holds on the server are added \u2014 and nothing the spec does not name', () => {
  const held = new Set(['new_declared', 'new_view', 'elsewhere']);
  const { tables, undetermined } = preAppTables({ spec: scopeSpec(), reconciled: ['new_form'], charted: [], existingApp: true, held });
  assert.deepStrictEqual(tables, ['new_form', 'new_view', 'new_declared', 'new_nav', 'new_pinned', 'account']);
  assert.ok(!tables.includes('elsewhere'));
  assert.deepStrictEqual(undetermined, []);
});

test('preAppTables: a table the build reconciled is named even where the spec does not', () => {
  const { tables } = preAppTables({ spec: { entities: [{ schemaName: 'new_a' }] }, reconciled: ['new_b', 'NEW_B'], charted: ['new_c'], existingApp: true });
  assert.deepStrictEqual(tables, ['new_b', 'new_c'], 'the spec\u2019s declaration alone is not enough, and the others follow the spec\u2019s own tables');
});

// --- readAppHeldTables -------------------------------------------------------------------------------------------------------

const APP_ID = '22222222-0000-4000-8000-000000000001';
const LAYER_ID = '22222222-0000-4000-8000-000000000002';
const guid = (n) => `33333333-0000-4000-8000-${String(n).padStart(12, '0')}`;
// An SDK double for the reads of what an app holds: the app's layer, its components by type, a table component's metadata and the table of
// a view, form or chart component. `tables` maps a logical name to its MetadataId; `assets` maps `<componenttype>` to { id: table }.
function appSdk({ tables = {}, assets = {}, layer = true, failType } = {}) {
  const tableOf = { 26: ['savedquery', 'savedqueryid', 'returnedtypecode'], 59: ['savedqueryvisualization', 'savedqueryvisualizationid', 'primaryentitytypecode'], 60: ['systemform', 'formid', 'objecttypecode'] };
  return {
    dataverse: {
      get: async (url) => {
        if (url.startsWith('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) {
          return layer ? { status: 200, body: { value: [{ appmoduleid: APP_ID, appmoduleidunique: LAYER_ID, componentstate: 1 }] } } : { status: 500, body: { error: { message: 'the platform refused' } } };
        }
        const name = Object.keys(tables).find((logical) => url.includes(`EntityDefinitions(${tables[logical]})`));
        return name ? { status: 200, body: { LogicalName: name, IsCustomEntity: true } } : { status: 404, body: null };
      },
    },
    queryRecords: async (set, options) => {
      const filter = (options && options.filter) || '';
      if (set === 'appmodulecomponent') {
        const type = Number((/componenttype eq (\d+)/.exec(filter) || [])[1]);
        if (type === failType) throw new Error(`type ${type} could not be read`);
        if (type === 1) return Object.values(tables).map((objectid) => ({ objectid, componenttype: 1 }));
        return Object.keys(assets[type] || {}).map((objectid) => ({ objectid, componenttype: type }));
      }
      const entry = Object.entries(tableOf).find(([, [name]]) => name === set);
      const [, [, idField, tableField]] = entry;
      const type = Number(entry[0]);
      return Object.entries(assets[type] || {}).filter(([id]) => filter.includes(id)).map(([id, table]) => ({ [idField]: id, [tableField]: table }));
    },
  };
}

test('readAppHeldTables: the tables the app holds as components and the tables of the views, forms and charts it holds', async () => {
  const sdk = appSdk({ tables: { Contoso_Table: guid(1), contoso_other: guid(2) }, assets: { 26: { [guid(10)]: 'contoso_view' }, 59: { [guid(11)]: 'contoso_chart' }, 60: { [guid(12)]: 'contoso_form', [guid(13)]: 'none' } } });
  const read = await readAppHeldTables(sdk, APP_ID);
  assert.strictEqual(read.ok, true);
  assert.deepStrictEqual(sorted(read.tables), ['contoso_chart', 'contoso_form', 'contoso_other', 'contoso_table', 'contoso_view'], 'lower-cased; a dashboard (`none`) is no table');
});

test('readAppHeldTables: what could not be read is said, and what was read is kept', async () => {
  const sdk = appSdk({ tables: { contoso_table: guid(1) }, assets: { 60: { [guid(12)]: 'contoso_form' } }, failType: 59 });
  const partial = await readAppHeldTables(sdk, APP_ID);
  assert.strictEqual(partial.ok, false);
  assert.match(partial.reason, /type 59 could not be read/);
  assert.deepStrictEqual(sorted(partial.tables), ['contoso_form', 'contoso_table'], 'the tables that were proven are still the app\u2019s');
  const refused = await readAppHeldTables(appSdk({ layer: false }), APP_ID);
  assert.strictEqual(refused.ok, false);
  assert.match(refused.reason, /the platform refused/);
  assert.deepStrictEqual([...refused.tables], []);
});

test('readAppHeldTables: no app, no client, a client that throws: none of them throws', async () => {
  assert.strictEqual((await readAppHeldTables(appSdk(), undefined)).ok, false);
  assert.deepStrictEqual(await readAppHeldTables(undefined, APP_ID), { ok: false, reason: 'no client to read the app with', tables: new Set() });
  assert.deepStrictEqual(await readAppHeldTables({}, APP_ID), { ok: false, reason: 'no client to read the app with', tables: new Set() });
  const down = await readAppHeldTables({ dataverse: { get: async () => { throw new Error('socket hang up'); } } }, APP_ID);
  assert.strictEqual(down.ok, false);
  assert.match(down.reason, /socket hang up/);
});

// --- describePreAppRefusal / describeUnreadAppTables -------------------------------------------------------------------------

test('describePreAppRefusal: says the protection did not apply, and separates what this build saved from a table it did not touch', () => {
  const text = describePreAppRefusal({
    reason: 'PublishXml answered HTTP 400',
    tables: ['new_note', 'new_nav', 'new_extra'],
    saved: new Map([['new_note', ['chart Notes By Kind']]]),
    described: new Map([['new_note', new Set(['Notes By Kind'])]]),
  });
  assert.match(text, /^could not publish tables new_note, new_nav, new_extra before the app \(PublishXml answered HTTP 400\), so the app's publish will come first and the protection the build gives what is saved on them did not apply\./);
  assert.match(text, /This build saved the description of chart Notes By Kind on new_note; it goes out with the build's final publish, after the app's\./);
  assert.match(text, /Whether the app's publish holds back a chart's description saved before it has not been measured\./);
  assert.match(text, /new_nav, new_extra are held by the app and the build changed nothing on them: a label someone saved on a form there and did not publish may stay unpublished once the app is published/);
  assert.match(text, /a later publish of the table does not release it/, 'what the earlier measurement says');
  assert.match(text, /may have to be saved again and then published with its table before the app\./, 'a recovery that is a hedge, not a promise');
  assert.match(text, /Publish those tables in Power Apps before the app is next published, or run the build again once the cause is cleared: it sends this request first again\.$/);
  assert.ok(!/someone saved on their forms/.test(text));
});

test('describePreAppRefusal: only what applies is said', () => {
  const own = describePreAppRefusal({ reason: 'x', tables: ['new_a'], saved: new Map([['new_a', ['view A', 'form B']]]) });
  assert.match(own, /^could not publish table new_a before the app \(x\), so .* what is saved on it did not apply\. This build saved view A, form B on new_a; they go out with the build's final publish/);
  assert.ok(!/chart's description/.test(own), 'no chart, no claim about a chart');
  assert.ok(!/held by the app and the build changed nothing/.test(own));
  const untouched = describePreAppRefusal({ reason: 'x', tables: ['new_a'] });
  assert.ok(!/This build saved/.test(untouched));
  assert.match(untouched, /new_a is held by the app and the build changed nothing on it/);
  assert.match(untouched, /Publish that table in Power Apps/);
  assert.strictEqual(describePreAppRefusal({ reason: 'x', tables: [] }), null);
});

test('describeUnreadAppTables: names the tables left out, and says nothing it has not checked', () => {
  const text = describeUnreadAppTables({ reason: 'HTTP 500', tables: ['new_a', 'new_b'] });
  assert.match(text, /^could not read which of the spec's tables the app already holds \(HTTP 500\), so new_a, new_b were left out of the publish before the app's own\./);
  assert.match(text, /if the app holds that form/);
  assert.match(text, /Publish those tables in Power Apps first, or run the build again once the cause is cleared\.$/);
  assert.match(describeUnreadAppTables({ reason: 'x', tables: ['new_a'] }), /so new_a was left out/);
  assert.strictEqual(describeUnreadAppTables({ reason: 'x', tables: [] }), null);
});

// --- publishTablesXml --------------------------------------------------------------------------------------------------------

function recordingClient(answer) {
  const requests = [];
  return { requests, post: async (url, body) => { requests.push([url, body]); return answer ? answer(url, body) : { status: 204, body: null }; } };
}

test('publishTablesXml: one PublishXml names every table, and nothing else', async () => {
  const client = recordingClient();
  assert.deepStrictEqual(await publishTablesXml(client, ['new_ticket', 'new_task']), { ok: true });
  assert.deepStrictEqual(client.requests, [['/PublishXml', { ParameterXml: '<importexportxml><entities><entity>new_ticket</entity><entity>new_task</entity></entities></importexportxml>' }]]);
});

test('publishTablesXml: no tables is nothing to publish, and sends nothing', async () => {
  const client = recordingClient();
  assert.deepStrictEqual(await publishTablesXml(client, []), { ok: true });
  assert.deepStrictEqual(client.requests, []);
});

test('publishTablesXml: a name is escaped, so no table can add an element to the body', async () => {
  const client = recordingClient();
  await publishTablesXml(client, ['new_a', 'x</entity><entity>y', 'p&q']);
  assert.strictEqual(client.requests[0][1].ParameterXml, '<importexportxml><entities><entity>new_a</entity><entity>x&lt;/entity&gt;&lt;entity&gt;y</entity><entity>p&amp;q</entity></entities></importexportxml>');
});

test('publishTablesXml: a refusal, a lost answer and a missing client are each reported by value, never thrown', async () => {
  assert.deepStrictEqual(await publishTablesXml(recordingClient(() => ({ status: 500, body: null })), ['new_a']), { ok: false, reason: 'PublishXml answered HTTP 500' });
  assert.deepStrictEqual(await publishTablesXml(recordingClient(() => ({ status: 429, body: { error: { message: 'Rate limit exceeded' } } })), ['new_a']), { ok: false, reason: 'PublishXml answered HTTP 429: Rate limit exceeded' });
  assert.deepStrictEqual(await publishTablesXml(recordingClient(() => undefined), ['new_a']), { ok: false, reason: 'PublishXml answered HTTP undefined' });
  assert.deepStrictEqual(await publishTablesXml(recordingClient(() => { throw new Error('socket hang up'); }), ['new_a']), { ok: false, reason: 'socket hang up' });
  assert.deepStrictEqual(await publishTablesXml(undefined, ['new_a']), { ok: false, reason: 'no client to publish with' });
  assert.deepStrictEqual(await publishTablesXml({}, ['new_a']), { ok: false, reason: 'no client to publish with' });
});

// --- readSavedNotPublished ---------------------------------------------------------------------------------------------------

const COLLECTIONS = { savedqueries: ['savedqueryid', 'returnedtypecode'], systemforms: ['formid', 'objecttypecode'], savedqueryvisualizations: ['savedqueryvisualizationid', 'primaryentitytypecode'] };
const row = (collection, id, name, table, componentstate) => ({ [COLLECTIONS[collection][0]]: id, name, [COLLECTIONS[collection][1]]: table, componentstate });

// A client that answers the three saved-layer reads from `rows` ({ collection: [row] }), keeping every URL it was asked for.
function layersClient(rows, { answer, pageSize } = {}) {
  const urls = [];
  return {
    urls,
    get: async (url) => {
      urls.push(url);
      if (answer) { const override = answer(url); if (override) return override; }
      const m = /^\/(\w+)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?(.*)$/.exec(url);
      if (!m) return { status: 404, body: null };
      const wanted = [...m[2].matchAll(/ eq '([^']*)'/g)].map((x) => x[1]);
      const [, tableField] = COLLECTIONS[m[1]];
      const found = (rows[m[1]] || []).filter((r) => wanted.includes(r[tableField]));
      if (!pageSize) return { status: 200, body: { value: found } };
      const skip = Number((/skiptoken=(\d+)/.exec(url) || [])[1] || 0);
      const more = skip + pageSize < found.length;
      return { status: 200, body: { value: found.slice(skip, skip + pageSize), ...(more ? { '@odata.nextLink': `${url.split('&$skiptoken')[0]}&$skiptoken=${skip + pageSize}` } : {}) } };
    },
  };
}

test('readSavedNotPublished: asks each collection for the saved layer of the tables, and keeps the records whose state is not published', async () => {
  const client = layersClient({
    savedqueries: [row('savedqueries', 'v1', 'Open Tickets', 'new_ticket', 1), row('savedqueries', 'v2', 'Active Tickets', 'new_ticket', 0)],
    systemforms: [row('systemforms', 'f1', 'Ticket', 'new_ticket', 1), row('systemforms', 'f2', 'Task', 'new_task', 1), row('systemforms', 'f3', 'Other', 'account', 1)],
    savedqueryvisualizations: [row('savedqueryvisualizations', 'c1', 'By Area', 'new_ticket', 1)],
  });
  const read = await readSavedNotPublished(client, ['new_ticket', 'new_task']);
  assert.strictEqual(read.ok, true);
  assert.deepStrictEqual([...read.byTable], [
    ['new_ticket', [{ kind: 'view', name: 'Open Tickets' }, { kind: 'form', name: 'Ticket' }, { kind: 'chart', name: 'By Area' }]],
    ['new_task', [{ kind: 'form', name: 'Task' }]],
  ], "the tables in the spec's order, each one's views, then forms, then charts; a published record and a table the spec does not name are left out");
  assert.deepStrictEqual(client.urls, [
    "/savedqueries/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=savedqueryid,name,returnedtypecode,componentstate&$filter=returnedtypecode eq 'new_ticket' or returnedtypecode eq 'new_task'",
    "/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,name,objecttypecode,componentstate&$filter=objecttypecode eq 'new_ticket' or objecttypecode eq 'new_task'",
    "/savedqueryvisualizations/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=savedqueryvisualizationid,name,primaryentitytypecode,componentstate&$filter=primaryentitytypecode eq 'new_ticket' or primaryentitytypecode eq 'new_task'",
  ]);
});

test('readSavedNotPublished: a record answered in both layers is one record, and a deletion nobody published is a change too', async () => {
  const client = layersClient({
    savedqueries: [row('savedqueries', 'v1', 'Open Tickets', 'new_ticket', 0), row('savedqueries', 'v1', 'Open Tickets', 'new_ticket', 1), row('savedqueries', 'v9', 'Old View', 'new_ticket', 3)],
    systemforms: [row('systemforms', 'f2', 'Gone', 'new_ticket', 2)],
  });
  const read = await readSavedNotPublished(client, ['new_ticket']);
  assert.deepStrictEqual(read.byTable.get('new_ticket'), [{ kind: 'view', name: 'Old View', deleted: true }, { kind: 'view', name: 'Open Tickets' }], 'by name; componentstate 2 is a deletion that is already published');
});

test('readSavedNotPublished: a record with no name is named by its id, and the same record is not listed twice', async () => {
  const client = layersClient({ systemforms: [{ formid: 'f1', name: null, objecttypecode: 'new_ticket', componentstate: 1 }, { formid: 'f1', name: null, objecttypecode: 'new_ticket', componentstate: 1 }] });
  assert.deepStrictEqual((await readSavedNotPublished(client, ['new_ticket'])).byTable.get('new_ticket'), [{ kind: 'form', name: 'f1' }]);
});

test('readSavedNotPublished: tables go twenty to a request, and a long answer is followed to its last page', async () => {
  const tables = Array.from({ length: 45 }, (_, i) => `new_t${i}`);
  const client = layersClient({ savedqueries: tables.map((t, i) => row('savedqueries', `v${i}`, `View ${i}`, t, 1)) }, { pageSize: 7 });
  const read = await readSavedNotPublished(client, tables);
  assert.strictEqual(read.ok, true);
  assert.strictEqual(read.byTable.size, 45, "every table's record arrives, across the pages and the chunks");
  const firsts = client.urls.filter((u) => !/skiptoken/.test(u));
  assert.strictEqual(firsts.length, 9, '3 requests of at most 20 tables for each of the 3 collections');
  assert.ok(firsts.every((u) => (u.match(/ eq '/g) || []).length <= 20));
  assert.ok(client.urls.some((u) => /skiptoken=7/.test(u)), 'the continuation was followed');
});

test('readSavedNotPublished: nothing saved and unpublished is an answer, not a failure', async () => {
  const read = await readSavedNotPublished(layersClient({ savedqueries: [row('savedqueries', 'v1', 'Open Tickets', 'new_ticket', 0)] }), ['new_ticket']);
  assert.deepStrictEqual(read, { ok: true, byTable: new Map() });
});

test('readSavedNotPublished: a read that cannot be relied on says why, and never an empty list', async () => {
  const tables = ['new_ticket'];
  const refused = await readSavedNotPublished(layersClient({}, { answer: () => ({ status: 500, body: { error: { code: '0x80040E14', message: 'internal error' } } }) }), tables);
  assert.deepStrictEqual(refused, { ok: false, reason: 'the saved views: HTTP 500: internal error' }, 'the platform\u2019s words, without the request URL');
  const absolute = await readSavedNotPublished({
    apiUrl: (p) => `https://contoso.crm.dynamics.com/api/data/v9.0${p}`,
    get: async () => ({ status: 400, body: { error: { message: 'The function is not supported: savedquery' } } }),
  }, ['new_ticket', 'new_task']);
  assert.deepStrictEqual(absolute, { ok: false, reason: 'the saved views: HTTP 400: The function is not supported: savedquery' }, 'a message with a colon of its own survives');
  const bare = await readSavedNotPublished({ apiUrl: (p) => `https://contoso.crm.dynamics.com/api/data/v9.0${p}`, get: async () => ({ status: 503, body: null }) }, tables);
  assert.deepStrictEqual(bare, { ok: false, reason: 'the saved views: HTTP 503' });
  const thrown = await readSavedNotPublished({ get: async () => { throw new Error('socket hang up'); } }, tables);
  assert.deepStrictEqual(thrown, { ok: false, reason: 'socket hang up' });
  // An answer that carries no state cannot say what is published: its rows would all look fine.
  const stateless = await readSavedNotPublished(layersClient({ savedqueries: [{ savedqueryid: 'v1', name: 'Open Tickets', returnedtypecode: 'new_ticket' }] }), tables);
  assert.strictEqual(stateless.ok, false);
  assert.match(stateless.reason, /^the saved views: the answer names no saved or published state/);
  const malformed = await readSavedNotPublished(layersClient({}, { answer: () => ({ status: 200, body: { nope: true } }) }), tables);
  assert.strictEqual(malformed.ok, false);
  assert.match(malformed.reason, /^the saved views: no readable result set/);
  assert.deepStrictEqual(await readSavedNotPublished(undefined, tables), { ok: false, reason: 'no client to read with' });
  assert.deepStrictEqual(await readSavedNotPublished({}, tables), { ok: false, reason: 'no client to read with' });
});

test('readSavedNotPublished: a reason too long to read is cut', async () => {
  const read = await readSavedNotPublished({ get: async () => { throw new Error(`boom ${'x'.repeat(1000)}`); } }, ['new_ticket']);
  assert.strictEqual(read.ok, false);
  assert.ok(read.reason.length <= 301, `${read.reason.length} characters`);
  assert.match(read.reason, /^boom x+\u2026$/);
});

// A row the read cannot place is not a row that is published. The answers of the three collections are read one after the other, so a row
// that cannot be classified, however late, must make the whole read unreadable: a list that left it out would read as the whole list.
const unfiltered = (valueByCollection) => ({
  get: async (url) => {
    const collection = /^\/(\w+)\//.exec(url)[1];
    return { status: 200, body: { value: valueByCollection[collection] || [] } };
  },
});
const VISIBLE_VIEW = { savedqueryid: 'v1', returnedtypecode: 'new_ticket', name: 'Visible View', componentstate: 1 };
const FORM = { formid: 'f1', objecttypecode: 'new_ticket', name: 'Hidden Form', componentstate: 1 };
for (const [what, bad, pattern] of [
  ['a form with no table field', { formid: 'f1', name: 'Hidden Form', componentstate: 1 }, /^the saved forms: a record has no objecttypecode/],
  ['a form whose table field is blank', { ...FORM, objecttypecode: '  ' }, /^the saved forms: a record has no objecttypecode/],
  ['a form whose table field is not text', { ...FORM, objecttypecode: 7 }, /^the saved forms: a record has no objecttypecode/],
  ['a form with no id', { name: 'Same', objecttypecode: 'new_ticket', componentstate: 1 }, /^the saved forms: a record has no formid/],
  ['a form with a blank id', { ...FORM, formid: '' }, /^the saved forms: a record has no formid/],
  ['a form whose state is a word', { ...FORM, componentstate: 'unknown' }, /^the saved forms: .*componentstate 'unknown'/],
  ['a form whose state is a number that is no state', { ...FORM, componentstate: 7 }, /^the saved forms: .*componentstate 7/],
  ['a form whose state is not a whole number', { ...FORM, componentstate: 1.5 }, /^the saved forms: .*componentstate 1\.5/],
  ['a form whose state is true', { ...FORM, componentstate: true }, /^the saved forms: .*componentstate true/],
  ['a form whose state is blank', { ...FORM, componentstate: '' }, /^the saved forms: .*componentstate ''/],
]) {
  test(`readSavedNotPublished: ${what}, answered after a valid record, makes the whole read unreadable`, async () => {
    const read = await readSavedNotPublished(unfiltered({ savedqueries: [VISIBLE_VIEW], systemforms: [bad] }), ['new_ticket']);
    assert.strictEqual(read.ok, false, JSON.stringify(read));
    assert.match(read.reason, pattern);
    assert.strictEqual(read.byTable, undefined, 'no list at all: the view that was read is not the whole answer');
    const said = describeSavedNotPublished(read, ['new_ticket']);
    assert.match(said, /could not be read/);
    assert.ok(!/Visible View/.test(said), 'nothing is listed');
    assert.match(said, /publish these tables in Power Apps: new_ticket\.$/);
  });
}

test('readSavedNotPublished: a bad record in the same collection as a valid one is just as unreadable', async () => {
  const read = await readSavedNotPublished(unfiltered({ savedqueries: [VISIBLE_VIEW, { savedqueryid: 'v2', name: 'No Table', componentstate: 1 }] }), ['new_ticket']);
  assert.strictEqual(read.ok, false);
  assert.match(read.reason, /^the saved views: a record has no returnedtypecode/);
});

test('readSavedNotPublished: records that can be placed are kept apart, and a record of another table or a published one is left out without a word', async () => {
  const read = await readSavedNotPublished(unfiltered({
    savedqueries: [
      VISIBLE_VIEW,
      { savedqueryid: 'v2', returnedtypecode: 'new_ticket', name: 'Same Name', componentstate: 1 },
      { savedqueryid: 'v3', returnedtypecode: 'new_ticket', name: 'Same Name', componentstate: 1 },
      { savedqueryid: 'v4', returnedtypecode: 'new_ticket', name: 'Published', componentstate: 0 },
      { savedqueryid: 'v5', returnedtypecode: 'account', name: 'Elsewhere', componentstate: 1 },
      { savedqueryid: 'v6', returnedtypecode: 'new_ticket', name: 'Text State', componentstate: '1' },
    ],
  }), ['new_ticket']);
  assert.strictEqual(read.ok, true);
  assert.deepStrictEqual(read.byTable.get('new_ticket'), [
    { kind: 'view', name: 'Same Name' }, { kind: 'view', name: 'Same Name' }, { kind: 'view', name: 'Text State' }, { kind: 'view', name: 'Visible View' },
  ], 'two records of one name and two ids are two records; a state that arrives as text is a state');
});

test('readSavedNotPublished: no tables is nothing to read', async () => {
  const client = layersClient({});
  assert.deepStrictEqual(await readSavedNotPublished(client, []), { ok: true, byTable: new Map() });
  assert.deepStrictEqual(client.urls, []);
});

// --- describeSavedNotPublished -----------------------------------------------------------------------------------------------

test('describeSavedNotPublished: names what is saved and not published, table by table, and what was not read', () => {
  const byTable = new Map([
    ['new_ticket', [{ kind: 'view', name: 'Open Tickets' }, { kind: 'chart', name: 'By Area' }]],
    ['new_task', [{ kind: 'form', name: 'Task' }, { kind: 'view', name: 'Old View', deleted: true }]],
  ]);
  assert.strictEqual(describeSavedNotPublished({ ok: true, byTable }, ['new_ticket', 'new_task', 'new_note']),
    "forms, views and charts saved but not published on the spec's tables \u2014 new_ticket: view Open Tickets, chart By Area; new_task: form Task, view Old View (deleted). "
    + "Run the build again with --publish, or publish those tables in Power Apps: a table's publish ships everything saved on it, whoever saved it. Columns and other kinds of change were not read.");
});

test('describeSavedNotPublished: nothing found says nothing', () => {
  assert.strictEqual(describeSavedNotPublished({ ok: true, byTable: new Map() }, ['new_ticket']), null);
  assert.strictEqual(describeSavedNotPublished(undefined, ['new_ticket']), null);
  assert.strictEqual(describeSavedNotPublished({ ok: false, reason: 'x' }, []), null, 'a read that failed on no tables has nothing to name');
});

test('describeSavedNotPublished: a list too long to read is cut, and says how much was left out', () => {
  const items = Array.from({ length: 9 }, (_, i) => ({ kind: 'view', name: `V${i}` }));
  const byTable = new Map(Array.from({ length: 13 }, (_, i) => [`new_t${i}`, items]));
  const text = describeSavedNotPublished({ ok: true, byTable }, [...byTable.keys()]);
  assert.match(text, /new_t0: view V0, view V1, view V2, view V3, view V4, view V5 and 3 more;/, 'six items to a table');
  assert.match(text, /new_t9: .*; and 3 more tables\./, 'ten tables');
  assert.ok(!/new_t10/.test(text));
});

test('describeSavedNotPublished: a read that failed says so, and names the tables to publish', () => {
  assert.strictEqual(describeSavedNotPublished({ ok: false, reason: 'HTTP 500' }, ['new_ticket', 'new_task']),
    "which forms, views and charts on the spec's tables are saved but not published could not be read (HTTP 500). "
    + 'Run the build again with --publish, or publish these tables in Power Apps: new_ticket, new_task.');
  const many = Array.from({ length: 30 }, (_, i) => `new_t${i}`);
  assert.match(describeSavedNotPublished({ ok: false, reason: 'x' }, many), /: new_t0, .*new_t19 and 10 more\.$/, 'twenty tables');
});
