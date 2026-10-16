'use strict';
// lib/table-publish.js: the tables a spec names, the tables the build publishes before the app, the PublishXml that publishes them, and the read of
// which of the spec's forms, views and charts are saved but not published. How the build uses them (the order against the app's publish, what a
// halted build says) is pinned in sdk-build.test.js, publish-scope-real-bundle.test.js and publish-halt-warning.test.js; these cases pin the pieces.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  specTables, appWriteTables, preAppTables, readAppFormChartTables, describePreAppRefusal, describeUnreadAppComponents,
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

// --- appWriteTables ----------------------------------------------------------------------------------------------------------
//
// The tables whose Main forms the build's own write of the app adds to the app. The SDK enumerates the active Main forms of the tables of the sitemap's
// Entity subareas, and only those (publish-scope-real-bundle.test.js runs the real SDK to pin that), so these are the navigation's tables: from the spec,
// because the forms the write is about to add cannot be read from the app's component list before it.

test("appWriteTables: the tables of the navigation's entity entries, lower-cased, once each, in the order the navigation gives them", () => {
  const spec = {
    entities: [{ schemaName: 'new_declared_only' }],
    forms: [{ entity: 'new_form_only' }],
    app: { tables: ['new_hidden'] },
    pages: [{ key: 'overview', dataSources: ['new_page_ds'] }],
    appShell: { areas: [{ groups: [{ subAreas: [
      { entity: 'New_Ticket', title: 'Tickets' }, { entity: 'new_task' }, { page: 'overview', title: 'Overview' }, { dashboard: 'Home' }, { url: 'https://contoso.example' }, { entity: 'new_ticket' },
    ] }, { subAreas: [{ entity: 'new_note' }] }] }] },
  };
  assert.deepStrictEqual(appWriteTables(spec, undefined), ['new_ticket', 'new_task', 'new_note'], 'not a page, a dashboard, a link, a declared table, an `app.tables` pin or a page\u2019s data source');
});

test('appWriteTables: an entry that names a page, a dashboard or a link is not a table entry even when it also names a table, as the build writes the sitemap', () => {
  // appDef reads a dashboard before a page, a page before a url, and anything else is a table.
  const spec = { appShell: { areas: [{ groups: [{ subAreas: [{ entity: 'new_a', page: 'p' }, { entity: 'new_b', dashboard: 'd' }, { entity: 'new_c', url: 'https://contoso.example' }, { entity: 'new_d' }] }] }] } };
  assert.deepStrictEqual(appWriteTables(spec), ['new_d']);
});

test('appWriteTables: a Main-form list restricts a table to the forms it names, and a table counts only if at least one of its forms will be in the app', () => {
  const spec = { appShell: { areas: [{ groups: [{ subAreas: [{ entity: 'new_listed' }, { entity: 'new_empty' }, { entity: 'new_unlisted' }] }] }] } };
  const lists = { new_listed: ['33333333-0000-4000-8000-000000000001'], new_empty: [] };
  assert.deepStrictEqual(appWriteTables(spec, lists), ['new_listed', 'new_unlisted'], 'a table with a list of forms adds them, one with an empty list adds none, one with no list adds its active Main forms');
  assert.deepStrictEqual(appWriteTables(spec, {}), ['new_listed', 'new_empty', 'new_unlisted'], 'no restriction at all');
  assert.deepStrictEqual(appWriteTables(spec, undefined), ['new_listed', 'new_empty', 'new_unlisted'], 'the spec has no Main-form list');
  assert.deepStrictEqual(appWriteTables(spec, { NEW_EMPTY: [] }), ['new_listed', 'new_empty', 'new_unlisted'], 'the resolved list is keyed by lower-case names, as resolveMainForms makes it');
});

test('appWriteTables: a spec of any shape names none, and a name that cannot be a table\u2019s is left out', () => {
  for (const spec of [undefined, null, {}, 'x', { appShell: null }, { appShell: { areas: 'nope' } }, { appShell: { areas: [null, { groups: null }, { groups: [null, { subAreas: [null, {}, { entity: 5 }] }] }] } }]) {
    assert.deepStrictEqual(appWriteTables(spec, undefined), [], JSON.stringify(spec));
  }
  assert.deepStrictEqual(appWriteTables({ appShell: { areas: [{ groups: [{ subAreas: [{ entity: 'x</entity><entity>y' }, { entity: 'two words' }, { entity: '' }, { entity: 'new_ok' }] }] }] } }, 'nope'), ['new_ok']);
});

// --- preAppTables ------------------------------------------------------------------------------------------------------------
//
// The tables the build publishes before the app are the ones the app's publish would otherwise leave a saved label on: the tables whose existing
// views and forms the build reconciled (what the SDK's own publish of them covered), the tables of the charts it wrote, the tables whose Main forms its
// own write of the app adds, and the tables whose forms or charts the app is proven to hold. `specTables` is the wider list the spec names, which a
// halted build reads.
const sorted = (list) => [...list].sort();

test('preAppTables: the tables the build reconciled, the tables of the charts it wrote, the tables its write of the app adds forms of and the tables whose forms or charts the app holds, once each, in name order', () => {
  assert.deepStrictEqual(
    preAppTables({ reconciled: ['new_view', 'New_Form'], charted: ['new_chart', 'new_form'], added: ['new_nav', 'new_view'], held: new Set(['new_retained', 'new_view']) }),
    ['new_chart', 'new_form', 'new_nav', 'new_retained', 'new_view'],
  );
  assert.deepStrictEqual(preAppTables({ reconciled: new Set(['new_b', 'new_a']), added: new Set(['new_c']) }), ['new_a', 'new_b', 'new_c'], 'the order does not depend on which reconcile finished first');
});

test('preAppTables: what the app holds is optional: without it the request names what the build changed and what its write of the app adds', () => {
  assert.deepStrictEqual(preAppTables({ reconciled: ['new_b'], charted: ['new_a'] }), ['new_a', 'new_b']);
  assert.deepStrictEqual(preAppTables({ reconciled: ['new_b'], charted: ['new_a'], held: undefined }), ['new_a', 'new_b']);
  assert.deepStrictEqual(preAppTables({ reconciled: ['new_b'], charted: ['new_a'], added: ['new_nav'], held: undefined }), ['new_a', 'new_b', 'new_nav'], 'what the write adds needs no proof from the server');
  assert.deepStrictEqual(preAppTables({ reconciled: ['new_b'], charted: ['new_a'], held: ['new_held'] }), ['new_a', 'new_b'], 'a list is not a Set: nothing was proven');
});

test('preAppTables: nothing changed, added or held is no table, and a name that cannot be a table\u2019s is left out', () => {
  assert.deepStrictEqual(preAppTables(), []);
  assert.deepStrictEqual(preAppTables({}), []);
  assert.deepStrictEqual(preAppTables({ reconciled: ['x</entity><entity>y', 'two words', '', 5], charted: [null], added: ['9starts_with_digit'], held: new Set(['9starts_with_digit']) }), []);
});

// --- readAppFormChartTables --------------------------------------------------------------------------------------------------
//
// The tables whose forms or charts an existing app is PROVEN to hold: the app's component list on the server, and the table of each form and chart in
// it, looked up in the SAVED layer (the component list is the saved layer's, so a form a maker added to the app and never published is in it). A table
// component alone, or a view, proves nothing about a form or a chart, so neither is read. The read counts only when it is complete and unambiguous.

const APP_ID = '22222222-0000-4000-8000-000000000001';
const LAYER_ID = '22222222-0000-4000-8000-000000000002';
const guid = (n) => `33333333-0000-4000-8000-${String(n).padStart(12, '0')}`;
// An SDK double for the reads of what an app holds: the app's layer, its components by type, a table component's metadata and the table of a view,
// form or chart component. `tables` maps a logical name to its MetadataId; `assets` maps `<componenttype>` to { id: table }; `reads` keeps every
// request; `shape(type, rows)` changes the rows the platform answers a lookup of a component's table with; `shapeList(type, rows)` changes the rows its component list
// answers with; `failLookup` is a component type whose lookup the platform refuses.
// The lookup is the SAVED layer's, as the build makes it:
//   GET /systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode&$filter=formid eq <id> or formid eq <id>
// A PLAIN read of the record (`queryRecords` of its entity) answers the published layer only, so a record never published has no row in it. The double
// fails that read loudly, so a regression to it shows as itself and not as a quiet hole.
function appSdk({ tables = {}, assets = {}, layer = true, failType, failLookup, shape = (type, rows) => rows, shapeList = (type, rows) => rows } = {}) {
  const tableOf = { 26: ['savedquery', 'savedqueryid', 'returnedtypecode'], 59: ['savedqueryvisualization', 'savedqueryvisualizationid', 'primaryentitytypecode'], 60: ['systemform', 'formid', 'objecttypecode'] };
  const collections = { savedqueries: 26, savedqueryvisualizations: 59, systemforms: 60 };
  const reads = [];
  return {
    reads,
    dataverse: {
      get: async (url) => {
        reads.push(url);
        if (url.startsWith('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) {
          return layer ? { status: 200, body: { value: [{ appmoduleid: APP_ID, appmoduleidunique: LAYER_ID, componentstate: 1 }] } } : { status: 500, body: { error: { message: 'the platform refused' } } };
        }
        const saved = /^\/(savedqueries|savedqueryvisualizations|systemforms)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?\$select=[^&]+&\$filter=(.*)$/.exec(url);
        if (saved) {
          const type = collections[saved[1]];
          if (type === failLookup) return { status: 500, body: { error: { message: 'the platform refused the lookup' } } };
          const [, idField, tableField] = tableOf[type];
          return { status: 200, body: { value: shape(type, Object.entries(assets[type] || {}).filter(([id]) => saved[2].includes(id)).map(([id, table]) => ({ [idField]: id, [tableField]: table }))) } };
        }
        const name = Object.keys(tables).find((logical) => url.includes(`EntityDefinitions(${tables[logical]})`));
        return name ? { status: 200, body: { LogicalName: name, IsCustomEntity: true } } : { status: 404, body: null };
      },
    },
    queryRecords: async (set, options) => {
      const filter = (options && options.filter) || '';
      reads.push(`${set}: ${filter}`);
      if (set === 'appmodulecomponent') {
        const type = Number((/componenttype eq (\d+)/.exec(filter) || [])[1]);
        if (type === failType) throw new Error(`type ${type} could not be read`);
        if (type === 1) return Object.values(tables).map((objectid) => ({ objectid, componenttype: 1 }));
        return shapeList(type, Object.keys(assets[type] || {}).map((objectid) => ({ objectid, componenttype: type })));
      }
      throw new Error(`a plain read of ${set} answers the published layer only: a record the app holds that was never published has no row in it`);
    },
  };
}
// The collections the lookups of the tables went to, in order, and the ids each asked about.
const lookupsOf = (sdk) => sdk.reads.filter((read) => /^\/(savedqueries|savedqueryvisualizations|systemforms)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)/.test(read));
const askedIn = (url) => [...url.matchAll(/ eq (33333333-[0-9a-f-]{27})/g)].map((m) => m[1]);

test('readAppFormChartTables: the tables of the forms and charts the app holds, lower-cased, and of its forms alone; a dashboard is no table', async () => {
  const sdk = appSdk({
    tables: { Contoso_Table: guid(1), contoso_other: guid(2) },
    assets: { 26: { [guid(10)]: 'contoso_view' }, 59: { [guid(11)]: 'Contoso_Chart', [guid(14)]: 'contoso_both' }, 60: { [guid(12)]: 'contoso_form', [guid(13)]: 'none', [guid(15)]: 'CONTOSO_BOTH' } },
  });
  const read = await readAppFormChartTables(sdk, APP_ID);
  assert.strictEqual(read.ok, true);
  assert.deepStrictEqual(sorted(read.tables), ['contoso_both', 'contoso_chart', 'contoso_form']);
  assert.deepStrictEqual(sorted(read.forms), ['contoso_both', 'contoso_form'], 'which of them the app holds a FORM of: a chart is not one');
  assert.ok(!read.tables.has('contoso_table') && !read.tables.has('contoso_other'), 'a table the app holds as a component is not proven to hold a form or a chart of it');
  assert.ok(!read.tables.has('contoso_view'), 'nor is a table of which it holds only a view (a page\u2019s pinned default view, say)');
});

test('readAppFormChartTables: it reads the form and chart components and their tables, and nothing else: no table metadata, no view', async () => {
  const sdk = appSdk({ tables: { contoso_table: guid(1) }, assets: { 26: { [guid(10)]: 'contoso_view' }, 59: { [guid(11)]: 'contoso_chart' }, 60: { [guid(12)]: 'contoso_form' } } });
  await readAppFormChartTables(sdk, APP_ID);
  assert.deepStrictEqual(sdk.reads.filter((read) => read.startsWith('appmodulecomponent:')).map((read) => Number((/componenttype eq (\d+)/.exec(read) || [])[1])), [59, 60]);
  assert.deepStrictEqual(lookupsOf(sdk).map((read) => read.split('/')[1]), ['savedqueryvisualizations', 'systemforms']);
  assert.ok(!sdk.reads.some((read) => read.includes('EntityDefinitions')), 'a table component is never resolved to its table');
});

test('readAppFormChartTables: the tables are looked up in the SAVED layer, so a form or chart the app holds that was never published is identified', async () => {
  // The double answers the saved layer only and fails a plain read: a record never published is no row in the published layer.
  const sdk = appSdk({ assets: { 59: { [guid(11)]: 'contoso_chart_draft' }, 60: { [guid(12)]: 'contoso_form_draft' } } });
  const read = await readAppFormChartTables(sdk, APP_ID);
  assert.strictEqual(read.ok, true, read.reason);
  assert.deepStrictEqual(sorted(read.tables), ['contoso_chart_draft', 'contoso_form_draft']);
  assert.deepStrictEqual(lookupsOf(sdk), [
    `/savedqueryvisualizations/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=savedqueryvisualizationid,primaryentitytypecode&$filter=savedqueryvisualizationid eq ${guid(11)}`,
    `/systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode&$filter=formid eq ${guid(12)}`,
  ]);
});

test('readAppFormChartTables: components are looked up twenty to a request, and every answer counts', async () => {
  const ids = Array.from({ length: 46 }, (_, i) => guid(100 + i));
  const sdk = appSdk({ assets: { 60: Object.fromEntries(ids.map((id, i) => [id, i % 2 ? 'contoso_odd' : 'contoso_even'])) } });
  const read = await readAppFormChartTables(sdk, APP_ID);
  assert.deepStrictEqual(lookupsOf(sdk).map((url) => askedIn(url).length), [20, 20, 6]);
  assert.deepStrictEqual([...read.tables].sort(), ['contoso_even', 'contoso_odd']);
});

test('readAppFormChartTables: a component nothing identifies makes the whole read incomplete, and a partial list is never handed back', async () => {
  const assets = { 59: { [guid(11)]: 'contoso_chart' }, 60: { [guid(12)]: 'contoso_form', [guid(13)]: 'contoso_unresolved' } };
  // The component list names two forms and the lookup of their tables answers one: a stale component, a record the caller cannot read.
  const missing = await readAppFormChartTables(appSdk({ assets, shape: (type, rows) => (type === 60 ? rows.filter((r) => r.formid !== guid(13)) : rows) }), APP_ID);
  assert.strictEqual(missing.ok, false);
  assert.match(missing.reason, /^tables derived from app component type 60 could not be fully identified \(no systemform record answered for 33333333-0000-4000-8000-000000000013\)$/);
  assert.strictEqual(missing.tables, undefined, 'what was identified is not offered: a caller that publishes it would be guessing about the rest');
  for (const [what, named] of [['an empty table', ''], ['no table at all', undefined], ['a null table', null]]) {
    const noTable = await readAppFormChartTables(appSdk({ assets, shape: (type, rows) => rows.map((r) => (r.formid === guid(13) ? { formid: r.formid, objecttypecode: named } : r)) }), APP_ID);
    assert.strictEqual(noTable.ok, false, `${what}: a row that names no table identifies nothing`);
  }
  const noId = await readAppFormChartTables(appSdk({ assets, shape: (type, rows) => rows.map((r) => (type === 59 ? { primaryentitytypecode: r.primaryentitytypecode } : r)) }), APP_ID);
  assert.strictEqual(noId.ok, false, 'a row that carries no id cannot be matched to a component');
  assert.match(noId.reason, /^tables derived from app component type 59 could not be fully identified \(no savedqueryvisualization record answered for 33333333-0000-4000-8000-000000000011\)$/);
});

test('readAppFormChartTables: a row for an id the component list never named, or with no readable id, says nothing of this app and adds no table', async () => {
  const assets = { 60: { [guid(12)]: 'contoso_form' } };
  for (const [what, extra] of [
    ['a record the list never named', { formid: guid(90), objecttypecode: 'contoso_lookup' }],
    ['a row with no id', { objecttypecode: 'contoso_lookup' }],
    ['a row whose id is not text', { formid: 12, objecttypecode: 'contoso_lookup' }],
    ['a row with an unreadable id', { formid: '   ', objecttypecode: 'contoso_lookup' }],
    ['a row that is not an object', null],
  ]) {
    const read = await readAppFormChartTables(appSdk({ assets, shape: (type, rows) => [extra, ...rows, extra] }), APP_ID);
    assert.strictEqual(read.ok, true, `${what}: the component that was asked about is identified, so the read is complete`);
    assert.deepStrictEqual(sorted(read.tables), ['contoso_form'], `${what}: the table it names is not the app's`);
    assert.deepStrictEqual(sorted(read.forms), ['contoso_form'], what);
  }
});

test('readAppFormChartTables: an id answered twice with the same table is one record in two layers; with two tables it is an answer that cannot be relied on, and lets neither in', async () => {
  const assets = { 60: { [guid(12)]: 'contoso_form', [guid(13)]: 'contoso_held' } };
  // A record with a saved edit can be answered once per layer, the same table both times, whatever the spelling of the id or the case of the table.
  const layers = await readAppFormChartTables(appSdk({ assets, shape: (type, rows) => [...rows, ...rows.map((r) => ({ formid: `{${r.formid.toUpperCase()}}`, objecttypecode: ` ${r.objecttypecode.toUpperCase()} ` }))] }), APP_ID);
  assert.strictEqual(layers.ok, true, layers.reason);
  assert.deepStrictEqual(sorted(layers.tables), ['contoso_form', 'contoso_held']);
  const conflict = await readAppFormChartTables(appSdk({ assets, shape: (type, rows) => [...rows, { formid: guid(13), objecttypecode: 'contoso_lookup' }] }), APP_ID);
  assert.strictEqual(conflict.ok, false);
  assert.strictEqual(conflict.reason, `tables derived from app component type 60 could not be fully identified (the systemform answer for ${guid(13)} names more than one table)`);
  assert.strictEqual(conflict.tables, undefined, 'neither of the two tables is offered');
  const reversed = await readAppFormChartTables(appSdk({ assets, shape: (type, rows) => [{ formid: guid(13), objecttypecode: 'contoso_lookup' }, ...rows] }), APP_ID);
  assert.strictEqual(reversed.ok, false, 'whichever row comes first');
});

test('readAppFormChartTables: a table that is not a table\u2019s name is no answer, even next to a row that names one: whitespace, a number, two words, a digit first, an object', async () => {
  const assets = { 60: { [guid(12)]: 'contoso_form', [guid(13)]: 'contoso_held' } };
  for (const [what, value, shown] of [
    ['whitespace', '   ', '"   "'], ['a number', 12345, '12345'], ['two words', 'two words', '"two words"'], ['a digit first', '9table', '"9table"'],
    ['a boolean', true, 'true'], ['an object', { LogicalName: 'contoso_held' }, '{"LogicalName":"contoso_held"}'],
  ]) {
    const alone = await readAppFormChartTables(appSdk({ assets, shape: (type, rows) => rows.map((r) => (r.formid === guid(13) ? { ...r, objecttypecode: value } : r)) }), APP_ID);
    assert.strictEqual(alone.ok, false, what);
    assert.strictEqual(alone.reason, `tables derived from app component type 60 could not be fully identified (the systemform answer for ${guid(13)} names no usable table (${shown}))`, what);
    assert.strictEqual(alone.tables, undefined, `${what}: no table is offered, the held one included`);
    const beside = await readAppFormChartTables(appSdk({ assets, shape: (type, rows) => [...rows, { formid: guid(13), objecttypecode: value }] }), APP_ID);
    assert.strictEqual(beside.ok, false, `${what}: a valid row for the same id does not make up for it`);
  }
});

test('readAppFormChartTables: a component of a non-table form (a dashboard answers `none`) is identified', async () => {
  for (const named of ['none', 'None', ' none ']) {
    const read = await readAppFormChartTables(appSdk({ assets: { 60: { [guid(13)]: named } } }), APP_ID);
    assert.deepStrictEqual({ ok: read.ok, tables: [...read.tables] }, { ok: true, tables: [] }, named);
  }
});

test('readAppFormChartTables: a read that failed says which, and an app that cannot be found says so, each with no tables', async () => {
  const partial = await readAppFormChartTables(appSdk({ assets: { 60: { [guid(12)]: 'contoso_form' } }, failType: 59 }), APP_ID);
  assert.strictEqual(partial.ok, false);
  assert.match(partial.reason, /type 59 could not be read/);
  assert.strictEqual(partial.tables, undefined);
  const refused = await readAppFormChartTables(appSdk({ layer: false }), APP_ID);
  assert.strictEqual(refused.ok, false);
  assert.match(refused.reason, /the platform refused/);
  const lookup = await readAppFormChartTables(appSdk({ assets: { 59: { [guid(11)]: 'contoso_chart' }, 60: { [guid(12)]: 'contoso_form' } }, failLookup: 60 }), APP_ID);
  assert.strictEqual(lookup.ok, false, 'the lookup of the forms\u2019 tables is refused: the chart\u2019s table that was identified is not offered alone');
  assert.match(lookup.reason, /^tables derived from app component type 60 could not be read \(the saved systemform records of the app's components: HTTP 500: the platform refused the lookup\)$/, 'which read, without the URL');
  assert.strictEqual(lookup.tables, undefined);
});

test('readAppFormChartTables: every read it rests on, refused, malformed or lost, makes the app unreadable, with a reason and no table offered', async () => {
  const assets = { 59: { [guid(11)]: 'contoso_chart' }, 60: { [guid(12)]: 'contoso_form' } };
  const dataverseModes = {
    refused: () => ({ status: 403, body: { error: { message: 'injected denial' } } }),
    malformed: () => ({ status: 200, body: { value: {} } }),
    lost: () => { throw new Error('injected transport loss'); },
  };
  const queryModes = { refused: () => { throw new Error('HTTP 403: injected denial'); }, malformed: () => ({}), lost: () => { throw new Error('injected transport loss'); } };
  for (const [what, matches] of [['the app\u2019s layer', (url) => url.startsWith('/appmodules/')], ['the lookup of the charts\u2019 tables', (url) => url.startsWith('/savedqueryvisualizations/')], ['the lookup of the forms\u2019 tables', (url) => url.startsWith('/systemforms/')]]) {
    for (const [mode, answer] of Object.entries(dataverseModes)) {
      const sdk = appSdk({ assets });
      const get = sdk.dataverse.get;
      sdk.dataverse.get = async (url) => (matches(url) ? answer() : get(url));
      const read = await readAppFormChartTables(sdk, APP_ID);
      assert.strictEqual(read.ok, false, `${what} ${mode}`);
      assert.ok(read.reason && read.tables === undefined && read.forms === undefined, `${what} ${mode}: a reason and no table`);
    }
  }
  for (const type of [59, 60]) {
    for (const [mode, answer] of Object.entries(queryModes)) {
      const sdk = appSdk({ assets });
      const query = sdk.queryRecords;
      sdk.queryRecords = async (set, options) => (set === 'appmodulecomponent' && new RegExp(`componenttype eq ${type}\\b`).test(options.filter) ? answer() : query(set, options));
      const read = await readAppFormChartTables(sdk, APP_ID);
      assert.strictEqual(read.ok, false, `the component list of type ${type} ${mode}`);
      assert.ok(read.reason && read.tables === undefined, `the component list of type ${type} ${mode}: a reason and no table`);
    }
  }
});

test('readAppFormChartTables: a row of the component list that cannot be placed makes the app unreadable, whatever else the list holds, and no table is offered', async () => {
  const assets = { 59: { [guid(11)]: 'contoso_chart' }, 60: { [guid(12)]: 'contoso_form', [guid(13)]: 'contoso_held' } };
  // The held form's component is replaced by a row that stands for nothing the build can place, so without the check the list would read as one component short.
  const without = (type, rows) => rows.filter((row) => row.objectid !== guid(13));
  for (const [what, type, damaged, reason] of [
    ['a null row', 60, null, 'row 2 is not a record'],
    ['an objectid that is only braces', 60, { objectid: '{}', componenttype: 60 }, 'row 2 has an objectid that is no GUID ("{}")'],
    ['a component type that is text', 60, { objectid: guid(13), componenttype: 'bad' }, 'row 2 has component type "bad", not 60'],
    ['a row with no objectid', 60, { componenttype: 60 }, 'row 2 has no objectid'],
    ['a null row in the chart list', 59, null, 'row 2 is not a record'],
  ]) {
    const shapeList = (listType, rows) => (listType === type ? [...without(listType, rows), damaged] : rows);
    const read = await readAppFormChartTables(appSdk({ assets, shapeList }), APP_ID);
    assert.strictEqual(read.ok, false, what);
    assert.strictEqual(read.reason, `app component type ${type} could not be read (the component list holds 1 row it cannot place: ${reason})`, what);
    assert.ok(read.tables === undefined && read.forms === undefined, `${what}: the rest of the list is not offered as if it were the whole`);
  }
  const whole = await readAppFormChartTables(appSdk({ assets, shapeList: (type, rows) => rows.map((row) => ({ ...row, objectid: `{${row.objectid.toUpperCase()}}`, componenttype: String(row.componenttype) })) }), APP_ID);
  assert.strictEqual(whole.ok, true, 'a list that can be placed — braces, capitals, a type spelled as text — is read as before');
  assert.deepStrictEqual(sorted(whole.tables), ['contoso_chart', 'contoso_form', 'contoso_held']);
});

test('readAppFormChartTables: no app, no client, a client that throws: none of them throws', async () => {
  assert.strictEqual((await readAppFormChartTables(appSdk(), undefined)).ok, false);
  assert.deepStrictEqual(await readAppFormChartTables(undefined, APP_ID), { ok: false, reason: 'no client to read the app with' });
  assert.deepStrictEqual(await readAppFormChartTables({}, APP_ID), { ok: false, reason: 'no client to read the app with' });
  const down = await readAppFormChartTables({ dataverse: { get: async () => { throw new Error('socket hang up'); } } }, APP_ID);
  assert.strictEqual(down.ok, false);
  assert.match(down.reason, /socket hang up/);
});

// --- describePreAppRefusal / describeUnreadAppComponents ---------------------------------------------------------------------

test('describePreAppRefusal: says the protection did not apply, and reports what this build saved and the risk to a form the app holds as separate concerns', () => {
  const text = describePreAppRefusal({
    reason: 'PublishXml answered HTTP 400',
    tables: ['new_note', 'new_nav', 'new_extra'],
    saved: new Map([['new_note', ['chart Notes By Kind']]]),
    described: new Map([['new_note', new Set(['Notes By Kind'])]]),
    forms: new Set(['new_nav', 'new_extra']),
  });
  assert.match(text, /^could not publish tables new_note, new_nav, new_extra before the app \(PublishXml answered HTTP 400\), so the app's publish will come first and the protection the build gives what is saved on them did not apply\./);
  assert.match(text, /This build saved the description of chart Notes By Kind on new_note; it goes out with the build's final publish, after the app's\./);
  assert.match(text, /Whether the app's publish holds back a chart's description saved before it has not been measured\./);
  assert.match(text, /The app holds forms of new_nav, new_extra: a label someone saved on a form there and did not publish may stay unpublished once the app is published/);
  assert.match(text, /a later publish of the table does not release it/, 'what the earlier measurement says');
  assert.match(text, /may have to be saved again and then published with its table before the app\./, 'a recovery that is a hedge, not a promise');
  assert.match(text, /Publish those tables in Power Apps before the app is next published, or run the build again once the cause is cleared: it sends this request first again\.$/);
  assert.ok(!/someone saved on their forms/.test(text));
  assert.ok(!/forms of [^:]*new_note/.test(text), 'a table the app holds no form of carries no form risk');
});

test('describePreAppRefusal: a table that carries this build\u2019s write AND a form the app holds gets both, neither hiding the other', () => {
  const text = describePreAppRefusal({
    reason: 'x', tables: ['new_stats'], saved: new Map([['new_stats', ['chart By Kind']]]), described: new Map([['new_stats', new Set(['By Kind'])]]), forms: new Set(['new_stats']),
  });
  assert.match(text, /This build saved the description of chart By Kind on new_stats; it goes out/);
  assert.match(text, /The app holds forms of new_stats: a label someone saved on a form there and did not publish may stay unpublished/);
  assert.match(text, /not been measured/);
  assert.match(text, /may have to be saved again/);
});

test('describePreAppRefusal: a table whose Main forms the build\u2019s own write of the app adds is worded "or adds", and one the app already holds a form of is not', () => {
  const text = describePreAppRefusal({ reason: 'x', tables: ['new_nav', 'new_held', 'new_plain'], forms: new Set(['new_held']), added: ['new_nav', 'new_held'] });
  assert.match(text, /The app holds, or this build's write of it adds, forms of new_nav, new_held: a label someone saved on a form there and did not publish may stay unpublished/);
  assert.ok(!/forms of [^:]*new_plain/.test(text), 'a table the app holds no form of and the build adds none to carries no form risk');
  const heldOnly = describePreAppRefusal({ reason: 'x', tables: ['new_held'], forms: new Set(['new_held']), added: ['new_held'] });
  assert.match(heldOnly, /The app holds forms of new_held: a label/, 'a table that is both held and added is held: the plain wording');
  assert.ok(!/or this build's write/.test(heldOnly));
  const addedOnly = describePreAppRefusal({ reason: 'x', tables: ['new_nav'], added: new Set(['new_nav']) });
  assert.match(addedOnly, /The app holds, or this build's write of it adds, forms of new_nav: a label/, 'with nothing proven held, and the build\u2019s additions given as a Set');
  assert.ok(!/this build's write of it adds/.test(describePreAppRefusal({ reason: 'x', tables: ['new_a'], added: undefined, forms: undefined })), 'nothing added, nothing said');
});

test('describePreAppRefusal: only what applies is said', () => {
  const own = describePreAppRefusal({ reason: 'x', tables: ['new_a'], saved: new Map([['new_a', ['view A', 'form B']]]) });
  assert.match(own, /^could not publish table new_a before the app \(x\), so .* what is saved on it did not apply\. This build saved view A, form B on new_a; they go out with the build's final publish/);
  assert.ok(!/chart's description/.test(own), 'no chart, no claim about a chart');
  assert.ok(!/The app holds forms of/.test(own), 'no form is known to be held');
  const held = describePreAppRefusal({ reason: 'x', tables: ['new_a'], forms: new Set(['new_a']) });
  assert.ok(!/This build saved/.test(held));
  assert.match(held, /The app holds forms of new_a: a label someone saved/);
  assert.match(held, /Publish that table in Power Apps/);
  const chartOnly = describePreAppRefusal({ reason: 'x', tables: ['new_a'] });
  assert.ok(!/This build saved|The app holds forms/.test(chartOnly), 'a table the build wrote nothing on and holds no form of gets the plain statement and the advice');
  assert.match(chartOnly, /did not apply\. Publish that table in Power Apps before the app is next published/);
  assert.strictEqual(describePreAppRefusal({ reason: 'x', tables: [] }), null);
});

test('describeUnreadAppComponents: says which proof failed and what was published anyway, and recommends no publication of a table it could not prove', () => {
  const text = describeUnreadAppComponents({ reason: 'app component type 60 could not be read (HTTP 500)', added: ['new_nav'] });
  assert.match(text, /^could not tell which tables the forms and charts the app already holds belong to \(app component type 60 could not be read \(HTTP 500\)\), so before the app's own publish it published only the tables this build changed and the navigation's tables, whose Main forms its own write of the app adds\./);
  assert.match(text, /Any other table the app holds a form or chart of \(one a maker added to it in the designer, say\) was not published first: a label someone saved on a form there and did not publish may stay unpublished once the app is published/);
  assert.match(text, /a later publish of the table does not release it, as measured for forms\), so one that does not show may have to be saved again\./);
  assert.match(text, /Run the build again once the cause is cleared: it then publishes the tables whose forms or charts the app holds before the app's own publish\.$/);
  assert.ok(!/publish (that|those|these|the) tables? in Power Apps/i.test(text), 'nothing tells a maker to publish a table the build could not prove is the app\u2019s');
  assert.ok(!/new_/.test(text), 'and no table is named, the navigation\u2019s included');
});

test('describeUnreadAppComponents: a build whose write adds no form says it published only what it changed, and claims nothing of the navigation', () => {
  for (const added of [undefined, [], new Set()]) {
    const text = describeUnreadAppComponents({ reason: 'x', added });
    assert.match(text, /^could not tell which tables the forms and charts the app already holds belong to \(x\), so before the app's own publish it published only the tables this build changed\. Any other table/, String(added));
    assert.ok(!/navigation/.test(text), 'no table is said to have been published that was not');
  }
  assert.match(describeUnreadAppComponents({ reason: 'x', added: new Set(['new_nav']) }), /and the navigation's tables, whose Main forms its own write of the app adds/, 'a Set of the tables, as well as a list');
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
