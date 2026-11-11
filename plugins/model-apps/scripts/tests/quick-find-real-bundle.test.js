'use strict';
// Quick Find columns, end to end through the REAL vendored SDK over an in-memory savedqueries
// table: the one default Quick Find view is found, the declared list is written only when it
// differs, the view's template conditions survive, and every refusal sends nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRowTableServer } = require('./helpers/row-table-server.js');
const { fakePublication } = require('./helpers/feature-ports.js');
const {
  validateQuickFindSpec,
  checkSearchRequest,
  expectedQuickFindProjection,
  planQuickFind,
  applyQuickFind,
} = require('../lib/quick-find.js');

const QF_ID = '11111111-0000-4000-8000-000000000004';
const ACTIVE_ID = '11111111-0000-4000-8000-000000000000';
const LAYOUT = '<grid name="resultset" object="1" jump="name" select="1" icon="1" preview="1"><row name="result" id="accountid"><cell name="name" width="300" /></row></grid>';
const fetchXml = (find) => '<fetch version="1.0" mapping="logical"><entity name="account"><attribute name="name" /><attribute name="accountid" />'
  + '<filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter>'
  + `<filter type="or" isquickfindfields="1">${find}</filter></entity></fetch>`;
const NAME_ONLY = fetchXml('<condition attribute="name" operator="like" value="{0}" />');
const ATTRIBUTES = {
  account: [
    { LogicalName: 'name', AttributeType: 'String' },
    { LogicalName: 'emailaddress1', AttributeType: 'String' },
    { LogicalName: 'accountnumber', AttributeType: 'String' },
    { LogicalName: 'exchangerate', AttributeType: 'Decimal' },
  ],
};

function server(rows) {
  const srv = createRowTableServer({ tables: { savedqueries: 'savedqueryid' }, attributes: ATTRIBUTES });
  for (const r of rows) {
    srv.seed('savedqueries', { description: '', returnedtypecode: 'account', layoutxml: LAYOUT, ...r });
  }
  return srv;
}
const quickFindRow = (over = {}) => ({ savedqueryid: QF_ID, name: 'Quick Find Active Accounts', querytype: 4, isdefault: true, fetchxml: NAME_ONLY, ...over });
const activeRow = { savedqueryid: ACTIVE_ID, name: 'Active Accounts', querytype: 0, isdefault: true, fetchxml: '<fetch version="1.0" mapping="logical"><entity name="account"><attribute name="name" /></entity></fetch>' };
const writesOf = (srv) => srv.writes.filter((w) => w.verb !== 'get');

async function run(srv, findColumns, ctx = {}) {
  const sdk = await srv.newSdk();
  const plan = await planQuickFind({ entity: 'account', quickFind: { findColumns }, sdk }, ctx);
  const result = await applyQuickFind(plan, { sdk }, ctx);
  return { plan, result };
}

test('the declared list is written to the one default Quick Find view, its template condition kept, and the view publish queued', async () => {
  const srv = server([activeRow, quickFindRow()]);
  const publication = fakePublication();
  const { plan, result } = await run(srv, ['name', 'emailaddress1'], { publication });
  assert.equal(plan.viewId, QF_ID);
  assert.deepEqual(result.saved.map((s) => s.id), [QF_ID]);
  assert.equal(writesOf(srv).length, 1);
  assert.match(writesOf(srv)[0].url, new RegExp(`savedqueries\\(${QF_ID}\\)`));
  const xml = srv.rowOf('savedqueries', QF_ID).fetchxml;
  assert.match(xml, /<condition attribute="statecode" operator="eq" value="0" \/>/, 'the template condition survives');
  assert.match(xml, /isquickfindfields="1"><condition attribute="name" operator="like" value="\{0\}" \/><condition attribute="emailaddress1" operator="like" value="\{0\}" \/>/);
  assert.deepEqual(publication.queued, [{ type: 'view', id: QF_ID, table: 'account' }]);
  assert.deepEqual(result.pendingPublish, [{ key: 'account/quickFind', scope: { type: 'view', id: QF_ID, table: 'account' } }]);
  assert.equal(srv.rowOf('savedqueries', ACTIVE_ID).fetchxml.includes('isquickfindfields'), false, 'the ordinary view is untouched');

  // A second build with the same declaration (any letter case) sends nothing and publishes nothing.
  srv.clearLog();
  const again = fakePublication();
  const second = await run(srv, ['Name', 'EmailAddress1'], { publication: again });
  assert.deepEqual(second.result.unchanged.map((u) => u.id), [QF_ID]);
  assert.equal(writesOf(srv).length, 0);
  assert.deepEqual(again.queued, []);
});

test('zero or several default Quick Find views are refused without a guess or a write', async () => {
  for (const [rows, code] of [
    [[activeRow], 'quick-find-view-not-found'],
    [[activeRow, quickFindRow({ isdefault: false })], 'quick-find-view-not-found'],
    [[quickFindRow(), quickFindRow({ savedqueryid: '11111111-0000-4000-8000-000000000005', name: 'Second Quick Find' })], 'quick-find-view-ambiguous'],
  ]) {
    const srv = server(rows);
    const { result } = await run(srv, ['name', 'emailaddress1']);
    assert.deepEqual(result.refused.map((r) => r.code), [code]);
    assert.deepEqual(result.saved, []);
    assert.equal(writesOf(srv).length, 0);
  }
});

test('a find filter the list cannot represent is refused and left exactly as stored', async () => {
  const nested = fetchXml('<condition attribute="name" operator="like" value="{0}" /><filter type="and"><condition attribute="accountnumber" operator="like" value="{0}" /></filter>');
  const srv = server([quickFindRow({ fetchxml: nested })]);
  const { result } = await run(srv, ['name']);
  assert.deepEqual(result.refused.map((r) => r.code), ['quick-find-filter-unsupported']);
  assert.equal(writesOf(srv).length, 0);
  assert.equal(srv.rowOf('savedqueries', QF_ID).fetchxml, nested);
});

test('a NEW column whose type has no search template is refused by the SDK before anything is sent', async () => {
  const srv = server([quickFindRow()]);
  const { result } = await run(srv, ['name', 'exchangerate']);
  assert.deepEqual(result.refused.map((r) => [r.code, r.rules]), [['quick-find-rejected', ['view-find-column-type-unsupported']]]);
  assert.equal(writesOf(srv).length, 0);
  assert.equal(srv.rowOf('savedqueries', QF_ID).fetchxml, NAME_ONLY);
});

test('an empty list is destructive: refused without approval, written with it', async () => {
  const srv = server([quickFindRow()]);
  const refused = await run(srv, []);
  assert.deepEqual(refused.result.refused.map((r) => r.code), ['quick-find-empty-not-authorized']);
  assert.equal(writesOf(srv).length, 0);

  const approved = await run(srv, [], { authorizedDestructive: new Set(['account/quickFind']) });
  assert.equal(approved.plan.operations[0].destructive, true);
  assert.deepEqual(approved.result.saved.map((s) => s.id), [QF_ID]);
  assert.equal(writesOf(srv).length, 1);
});

test('a shorter list is marked destructive in the plan (it removes a find column)', async () => {
  const srv = server([quickFindRow({ fetchxml: fetchXml('<condition attribute="name" operator="like" value="{0}" /><condition attribute="accountnumber" operator="like" value="{0}" />') })]);
  const { plan, result } = await run(srv, ['name']);
  assert.equal(plan.operations[0].destructive, true);
  assert.deepEqual(result.saved.map((s) => s.id), [QF_ID]);
  assert.doesNotMatch(srv.rowOf('savedqueries', QF_ID).fetchxml, /accountnumber" operator/);
});

test('no quickFind declared: nothing is read and nothing is written', async () => {
  const srv = server([quickFindRow()]);
  const sdk = await srv.newSdk();
  srv.clearLog();
  const plan = await planQuickFind({ entity: 'account', quickFind: undefined, sdk });
  const result = await applyQuickFind(plan, { sdk });
  assert.deepEqual(result, { saved: [], unchanged: [], pendingPublish: [], refused: [], unknown: [], managedBindings: [] });
  assert.equal(srv.reads.length, 0);
});

test('validation: duplicates, non-names, a non-boolean searchEnabled and changeTrackingEnabled:false are errors', () => {
  const errs = validateQuickFindSpec({ quickFind: { findColumns: ['name', 'NAME', 'a b'] }, searchEnabled: 'yes', changeTrackingEnabled: false });
  assert.deepEqual(errs.map((e) => e.path), [
    'entities[].quickFind.findColumns[1]',
    'entities[].quickFind.findColumns[2]',
    'entities[].searchEnabled',
    'entities[].changeTrackingEnabled',
  ]);
  assert.deepEqual(validateQuickFindSpec({ quickFind: { findColumns: ['name'] }, searchEnabled: true, changeTrackingEnabled: true }), []);
  assert.deepEqual(validateQuickFindSpec({ name: 'plain table' }), [], 'an ordinary table declares nothing');
});

test('search on an untracked table needs changeTrackingEnabled:true stated; tracking is never inferred', () => {
  const untracked = { changeTrackingEnabled: false, canEnableSearch: true };
  assert.equal(checkSearchRequest('account', { searchEnabled: true }, untracked).code, 'search-needs-change-tracking');
  assert.equal(checkSearchRequest('account', { searchEnabled: true, changeTrackingEnabled: true }, untracked), null);
  assert.equal(checkSearchRequest('account', { searchEnabled: true }, { changeTrackingEnabled: true, canEnableSearch: true }), null);
  assert.equal(checkSearchRequest('account', { searchEnabled: true }, { changeTrackingEnabled: true, canEnableSearch: false }).code, 'search-not-allowed');
  assert.equal(checkSearchRequest('account', { searchEnabled: true }, undefined).code, 'search-table-unreadable');
  assert.equal(checkSearchRequest('account', { searchEnabled: false }, undefined), null, 'turning search off needs nothing');
  assert.deepEqual(expectedQuickFindProjection('account', { quickFind: { findColumns: ['Name'] }, searchEnabled: true, changeTrackingEnabled: true }), {
    table: 'account', findColumns: ['name'], searchEnabled: true, changeTrackingEnabled: true,
  });
});

// Quick Find alone — a table the build does not create, so the default-view enrichment never publishes
// it — still makes its saved list live: the scope is the Quick Find view itself, which the build's view
// publisher publishes at once without the publish phase, or owes to that phase with it.
const { buildPublishPaths } = require('./helpers/feature-ports.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { enrichesDefaultViews } = require('../lib/sdk-build.js');
const tablePublishes = (srv, table) => srv.writes.filter((w) => /PublishXml/.test(w.url) && JSON.stringify(w.body).includes(`<entity>${table}</entity>`)).length;

for (const publish of [false, true]) {
  test(`Quick Find alone on an existing table is published exactly once (publish phase ${publish ? 'in' : 'not in'} the run)`, async () => {
    const declaredTable = { schemaName: 'account', existing: true, quickFind: { findColumns: ['name', 'emailaddress1'] } };
    assert.equal(enrichesDefaultViews({}, declaredTable), false, 'no enrichment publish covers this table');
    const srv = server([activeRow, quickFindRow()]);
    const sdk = await srv.newSdk();
    const paths = buildPublishPaths({ sdk, client: srv.httpClient, publish, barrier: createPublicationBarrier() });
    const plan = await planQuickFind({ entity: 'account', quickFind: declaredTable.quickFind, sdk }, {});
    const result = await applyQuickFind(plan, { sdk }, {});
    assert.equal((await paths.settle('Quick Find on account', result)).ok, true);
    assert.equal(tablePublishes(srv, 'account'), publish ? 0 : 1, 'without the publish phase the view is published at once');
    assert.deepEqual([...paths.owed.keys()], publish ? ['account'] : [], 'with it, the table is owed to that phase');
    await paths.publishPhase();
    assert.equal(tablePublishes(srv, 'account'), 1);
  });
}

test('a Quick Find write whose outcome is unknown keeps its table unpublished for the rest of the run', async () => {
  const srv = server([activeRow, quickFindRow()]);
  const sdk = await srv.newSdk();
  const lost = new Proxy(sdk, { get(t, p) {
    if (p === 'pushArtifact') return async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); };
    return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
  } });
  const barrier = createPublicationBarrier();
  const paths = buildPublishPaths({ sdk, client: srv.httpClient, publish: false, barrier });
  const plan = await planQuickFind({ entity: 'account', quickFind: { findColumns: ['name', 'emailaddress1'] }, sdk }, {});
  const result = await applyQuickFind(plan, { sdk: lost }, {});
  assert.deepEqual(result.unknown.map((u) => u.code), ['quick-find-write-unknown']);
  assert.deepEqual(result.pendingPublish, [{ key: 'account/quickFind', scope: { type: 'view', id: QF_ID, table: 'account' }, withheld: true }]);
  assert.equal((await paths.settle('Quick Find on account', result)).ok, false);
  await paths.publishReconciled('view', ACTIVE_ID, 'account', 'view Active Accounts');
  assert.equal(tablePublishes(srv, 'account'), 0);
  assert.deepEqual(barrier.withheld().map((w) => [w.table, w.skipped]), [['account', ['view Active Accounts']]]);
});