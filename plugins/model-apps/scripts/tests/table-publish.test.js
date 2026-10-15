'use strict';
// lib/table-publish.js: the tables a spec names, the PublishXml that publishes them, and the read of which of their forms, views and
// charts are saved but not published. How the build uses them (the order against the app's publish, what a halted build says) is pinned in
// sdk-build.test.js and publish-halt-warning.test.js; these cases pin the pieces.
const test = require('node:test');
const assert = require('node:assert/strict');
const { specTables, tableList, publishTablesXml, readSavedNotPublished, describeSavedNotPublished } = require('../lib/table-publish.js');

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
