'use strict';
// Declared view reconciliation through the REAL vendored SDK over an in-memory savedqueries table:
// joins with aliases, joined-table columns, filters and sort scoped to a join, the declared column
// order, opaque layout attributes and undeclared joins preserved, and every refusal sending nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRowTableServer } = require('./helpers/row-table-server.js');
const { fakeManaged, fakePublication, fakeCreates } = require('./helpers/feature-ports.js');
const {
  isDeclaredView,
  compileViewIntent,
  viewCreateArtifact,
  planViewReconcile,
  applyViewReconcile,
} = require('../lib/view-reconcile.js');

const VID = '22222222-0000-4000-8000-000000000001';
const LAYOUT = '<grid name="resultset" object="2" jump="fullname" select="1" icon="1" preview="1"><row name="result" id="contactid"><cell name="fullname" width="300" disableSorting="1" /><cell name="emailaddress1" width="150" /></row></grid>';
const fetchXml = (filter = '<filter type="and"><condition attribute="statecode" operator="eq" value="0" /></filter>', extra = '') => '<fetch version="1.0" mapping="logical"><entity name="contact"><attribute name="fullname" /><attribute name="emailaddress1" /><attribute name="contactid" />'
  + '<order attribute="fullname" descending="false" />' + filter
  + '<link-entity name="systemuser" from="systemuserid" to="createdby" alias="maker" link-type="outer" visible="false" />' + extra + '</entity></fetch>';

function server(row = {}) {
  const srv = createRowTableServer({ tables: { savedqueries: 'savedqueryid' } });
  srv.seed('savedqueries', { savedqueryid: VID, name: 'Contacts by account', description: '', returnedtypecode: 'contact', querytype: 0, isdefault: false, fetchxml: fetchXml(), layoutxml: LAYOUT, ...row });
  return srv;
}
const writesOf = (srv) => srv.writes;
const declared = (over = {}) => ({
  entity: 'contact',
  name: 'Contacts by account',
  reconcile: 'declared',
  linkEntities: [{ name: 'account', from: 'accountid', to: 'parentcustomerid', alias: 'acct', linkType: 'inner', filters: [{ attr: 'statecode', op: 'eq', value: 0 }] }],
  columns: ['fullname', { name: 'name', relatedEntity: 'acct', width: 180 }, 'emailaddress1'],
  filters: [{ attr: 'name', op: 'like', value: 'A%', relatedEntity: 'acct' }],
  sort: [{ attr: 'name', dir: 'desc', relatedEntity: 'acct' }],
  ...over,
});

async function run(srv, view, ctx = {}) {
  const sdk = await srv.newSdk();
  const plan = await planViewReconcile({ view, sdk }, ctx);
  const result = await applyViewReconcile(plan, { sdk }, ctx);
  return { plan, result, sdk };
}

test('a declared join, joined-table column, scoped filter and scoped sort converge; opaque layout and undeclared joins survive; a rerun sends nothing', async () => {
  const srv = server();
  const publication = fakePublication();
  const managed = fakeManaged();
  const { plan, result } = await run(srv, declared(), { authorizedAdoption: true, publication, managed });
  assert.deepEqual(plan.changed.sort(), ['columns', 'filters', 'linkEntities', 'sort']);
  assert.deepEqual(result.saved.map((s) => s.id), [VID]);
  assert.equal(writesOf(srv).length, 1, 'one PATCH for the whole view');
  const row = srv.rowOf('savedqueries', VID);
  assert.match(row.fetchxml, /<link-entity name="account" from="accountid" to="parentcustomerid" alias="acct" link-type="inner">/);
  assert.match(row.fetchxml, /<condition attribute="name" operator="like" entityname="acct" value="A%" \/>/, 'the filter is scoped to the join');
  assert.match(row.fetchxml, /<order attribute="name" descending="true" entityname="acct" \/>/, 'the sort is scoped to the join');
  assert.match(row.fetchxml, /<link-entity name="systemuser" from="systemuserid" to="createdby" alias="maker" link-type="outer" visible="false"/, 'an undeclared join and its options are kept');
  assert.match(row.layoutxml, /<cell name="fullname" width="300" disableSorting="1" \/><cell name="acct.name" width="180" \/><cell name="emailaddress1" width="150" \/>/, 'declared order; opaque cell attributes kept');
  assert.deepEqual(publication.queued, [{ type: 'view', id: VID, table: 'contact' }]);
  assert.equal(result.managedBindings.length, 1);
  assert.equal(result.managedBindings[0].origin, 'adopted');
  managed.persist(result.managedBindings);

  // A new build: nothing to write, nothing pushed, nothing published — and no approval is needed now.
  srv.clearLog();
  const again = fakePublication();
  const second = await run(srv, declared(), { publication: again, managed });
  assert.equal(second.plan.action, 'noChange');
  assert.deepEqual(second.result.unchanged.map((u) => u.id), [VID]);
  assert.equal(writesOf(srv).length, 0);
  assert.deepEqual(again.queued, []);
});

test('a view this spec does not manage yet needs adoption approval; an explicit viewId pin does not', async () => {
  const srv = server();
  const refused = await run(srv, declared());
  assert.deepEqual(refused.result.refused.map((r) => r.code), ['view-adoption-not-authorized']);
  assert.equal(writesOf(srv).length, 0);
  const pinned = await run(srv, declared({ viewId: `{${VID.toUpperCase()}}` }));
  assert.deepEqual(pinned.result.saved.map((s) => s.id), [VID]);
});

test('an unmanaged view that already matches is not bound without approval, so a later edit still asks', async () => {
  const srv = server();
  await run(srv, declared(), { authorizedAdoption: true });
  const managed = fakeManaged();
  srv.clearLog();
  const same = await run(srv, declared(), { managed });
  assert.equal(same.plan.action, 'noChange');
  assert.deepEqual(same.result.managedBindings, [], 'matching the spec is not an approval to manage it');
  managed.persist(same.result.managedBindings);
  const edit = await run(srv, declared({ description: 'Contacts and their account' }), { managed });
  assert.deepEqual(edit.result.refused.map((r) => r.code), ['view-adoption-not-authorized']);
  assert.equal(writesOf(srv).length, 0);
});

test('a base filter the typed tree cannot represent is refused, not doubled', async () => {
  const multi = fetchXml('<filter type="and"><condition attribute="statecode" operator="eq" value="0" /><condition attribute="gendercode" operator="in"><value>1</value><value>2</value></condition></filter>');
  const srv = server({ fetchxml: multi });
  const { result } = await run(srv, declared(), { authorizedAdoption: true });
  assert.deepEqual(result.refused.map((r) => r.code), ['view-filter-unrepresentable']);
  assert.equal(writesOf(srv).length, 0);
  assert.equal(srv.rowOf('savedqueries', VID).fetchxml, multi);
});

test('a joined-table column the bundle reads without its join blocks a columns write (it would be re-emitted on the base table)', async () => {
  const layout = LAYOUT.replace('</row>', '<cell name="maker.fullname" width="100" /></row>');
  const fx = fetchXml(undefined).replace('visible="false" />', 'visible="false"><attribute name="fullname" /></link-entity>');
  const srv = server({ layoutxml: layout, fetchxml: fx });
  const { result } = await run(srv, declared({ linkEntities: [], filters: [], sort: [], columns: ['fullname'] }), { authorizedAdoption: true, authorizedDestructive: true });
  assert.deepEqual(result.refused.map((r) => r.code), ['view-related-column-unrepresentable']);
  assert.equal(writesOf(srv).length, 0);
});

test('removing a column the view shows needs approval', async () => {
  const srv = server();
  const spec = declared({ linkEntities: [], filters: [], sort: [], columns: ['fullname'] });
  const refused = await run(srv, spec, { authorizedAdoption: true });
  assert.deepEqual(refused.result.refused.map((r) => r.code), ['view-columns-removal-not-authorized']);
  assert.equal(writesOf(srv).length, 0);
  const approved = await run(srv, spec, { authorizedAdoption: true, authorizedDestructive: new Set(['contact/Contacts by account']) });
  assert.equal(approved.plan.operations[0].destructive, true);
  assert.deepEqual(approved.result.saved.map((s) => s.id), [VID]);
  assert.match(srv.rowOf('savedqueries', VID).layoutxml, /<row name="result" id="contactid"><cell name="fullname" width="300" disableSorting="1" \/><\/row>/);
});

test('drift: an owned part changed outside the spec is refused until the overwrite is approved', async () => {
  const srv = server();
  const managed = fakeManaged();
  const first = await run(srv, declared(), { authorizedAdoption: true, managed });
  managed.persist(first.result.managedBindings);
  // Someone re-sorts the view in the designer.
  const row = srv.rowOf('savedqueries', VID);
  row.fetchxml = row.fetchxml.replace('<order attribute="name" descending="true" entityname="acct" />', '<order attribute="fullname" descending="false" />');
  srv.clearLog();
  const refused = await run(srv, declared(), { managed });
  assert.deepEqual(refused.result.refused.map((r) => r.code), ['view-drift']);
  assert.equal(writesOf(srv).length, 0);
  const approved = await run(srv, declared(), { managed, authorizedOverwrite: true });
  assert.deepEqual(approved.result.saved.map((s) => s.id), [VID]);
  assert.match(srv.rowOf('savedqueries', VID).fetchxml, /<order attribute="name" descending="true" entityname="acct" \/>/);
});

test('a missing view is planned as a create whose artifact the bundle accepts with its join; a missing pinned view is refused', async () => {
  const srv = createRowTableServer({ tables: { savedqueries: 'savedqueryid' } });
  const sdk = await srv.newSdk();
  const plan = await planViewReconcile({ view: declared(), sdk });
  assert.equal(plan.action, 'create');
  const created = await sdk.createArtifact('view', plan.createArtifact);
  const pushed = await sdk.pushArtifact('view', created.id);
  assert.equal(pushed.saved, true);
  const post = srv.writes.find((w) => w.verb === 'post');
  assert.match(post.body.fetchxml, /<link-entity name="account" from="accountid" to="parentcustomerid" alias="acct" link-type="inner">/);
  assert.match(post.body.fetchxml, /<entity name="contact">.*<\/link-entity>.*<filter type="and"><condition attribute="statecode" operator="eq" value="0" ?\/>/, 'activeOnly on the base table, as viewDef builds it');

  const pinned = await planViewReconcile({ view: declared({ viewId: '33333333-0000-4000-8000-000000000009' }), sdk });
  assert.deepEqual(pinned.refused.map((r) => r.code), ['view-pinned-not-found']);
});

test('validation: duplicate join names, a scope that names no join, a bad linkType, an unscoped dotted column', () => {
  const { errors } = compileViewIntent({
    entity: 'contact',
    name: 'V',
    reconcile: 'declared',
    linkEntities: [{ name: 'account', from: 'accountid', to: 'parentcustomerid' }, { name: 'account', from: 'accountid', to: 'parentaccountid', linkType: 'left' }],
    columns: ['fullname', { name: 'name', relatedEntity: 'nope' }, 'acct.name'],
    filters: [{ attr: 'name', relatedEntity: 'nope' }],
    sort: [{ attr: 'name', relatedEntity: 'nope' }],
    viewId: 'not-a-guid',
  });
  assert.deepEqual(errors.map((e) => e.path), [
    'views[].viewId',
    'views[].linkEntities[1].linkType',
    'views[].linkEntities[1].alias',
    'views[].columns[1].relatedEntity',
    'views[].columns[2].relatedEntity',
    'views[].filters[0].relatedEntity',
    'views[].sort[0].relatedEntity',
  ]);
});

test('neighbour: a view without reconcile:"declared" stays on the legacy union path', () => {
  assert.equal(isDeclaredView({ entity: 'contact', name: 'V', columns: ['fullname'] }), false);
  assert.equal(isDeclaredView({ entity: 'contact', name: 'V', reconcile: 'declared' }), true);
  // The create artifact is viewDef's shape plus joins: queryType 0, not default, ordered columns.
  const { intent } = compileViewIntent({ entity: 'Contact', name: 'V', columns: ['FullName'], activeOnly: false });
  assert.deepEqual(viewCreateArtifact(intent), {
    name: 'V', description: '', entityLogicalName: 'contact', queryType: 0, isDefault: false,
    columns: [{ name: 'fullname', width: 100, order: 0 }], filters: { type: 'and', conditions: [], groups: [] }, sort: [], linkEntities: [],
  });
});

// A plain view (no join) on account, as the probes in this block use it.
const A = '11111111-0000-4000-8000-000000000001';
const B = '11111111-0000-4000-8000-000000000002';
const plainSpec = { entity: 'account', name: 'Owned view', reconcile: 'declared', activeOnly: false, columns: ['name'] };
const plainRow = (id) => ({ savedqueryid: id, name: plainSpec.name, returnedtypecode: 'account', querytype: 0, isdefault: false, description: '',
  fetchxml: '<fetch><entity name="account"><attribute name="name" /><attribute name="accountid" /></entity></fetch>',
  layoutxml: '<grid name="resultset" object="1" jump="name"><row name="result" id="accountid"><cell name="name" width="100" /></row></grid>' });
const plainServer = (...ids) => {
  const srv = createRowTableServer({ tables: { savedqueries: 'savedqueryid' } });
  for (const id of ids) srv.seed('savedqueries', plainRow(id));
  return srv;
};
const personJoin = { name: 'contact', from: 'contactid', to: 'primarycontactid', alias: 'person', linkType: 'outer' };

test('a bound view is edited by its bound id only: a same-name replacement is never followed, a conflicting pin refuses', async () => {
  const srv = plainServer(A);
  const managed = fakeManaged();
  const first = await run(srv, plainSpec, { managed, authorizedAdoption: true });
  managed.persist(first.result.managedBindings);
  assert.equal(managed.lookup('view', 'account/Owned view').id, A);
  srv.store.get('savedqueries').delete(A);
  srv.seed('savedqueries', plainRow(B));
  srv.clearLog();
  const second = await run(srv, { ...plainSpec, sort: [{ attr: 'name', dir: 'desc' }] }, { managed, authorizedAdoption: true });
  assert.equal(srv.writes.length, 0, 'the same-name replacement is not written');
  assert.deepEqual(second.result.refused.map((r) => r.code), ['view-bound-row-missing']);
  assert.deepEqual(second.result.managedBindings, [], 'the binding is not moved to the replacement');

  const pinned = await run(srv, { ...plainSpec, viewId: B, sort: [{ attr: 'name', dir: 'desc' }] }, { managed, authorizedAdoption: true });
  assert.equal(srv.writes.length, 0);
  assert.deepEqual(pinned.result.refused.map((r) => r.code), ['view-binding-mismatch']);
});

test('two views with the declared name: nothing is chosen and nothing is written', async () => {
  const srv = plainServer(A, B);
  const sdk = await srv.newSdk();
  const ctx = { managed: fakeManaged(), authorizedAdoption: true, creates: fakeCreates() };
  const plan = await planViewReconcile({ view: { ...plainSpec, sort: [{ attr: 'name', dir: 'desc' }] }, sdk }, ctx);
  const result = await applyViewReconcile(plan, { sdk }, ctx);
  assert.equal(srv.writes.length, 0, 'adoption approval is not permission to choose between duplicate names');
  assert.deepEqual(result.refused.map((r) => r.code), ['view-name-ambiguous']);
  assert.equal(ctx.creates.calls.length, 0);
});
test('the first join is added to a view that has none', async () => {
  const srv = plainServer(A);
  const managed = fakeManaged();
  const { result } = await run(srv, { ...plainSpec, linkEntities: [personJoin] }, { managed, authorizedAdoption: true });
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.saved.map((s) => s.parts), [['linkEntities']]);
  assert.match(srv.rowOf('savedqueries', A).fetchxml, /<link-entity name="contact" from="contactid" to="primarycontactid" alias="person" link-type="outer"/);
});

test('ownership changes are edits, not drift: dropping a declared join keeps it; starting to declare a description writes it', async () => {
  const srv = plainServer();
  const joined = plainRow(A);
  joined.fetchxml = joined.fetchxml.replace('</entity>', '<link-entity name="contact" from="contactid" to="primarycontactid" alias="person" link-type="outer" /></entity>');
  srv.seed('savedqueries', joined);
  const managed = fakeManaged();
  const first = await run(srv, { ...plainSpec, linkEntities: [personJoin] }, { managed, authorizedAdoption: true });
  managed.persist(first.result.managedBindings);
  srv.clearLog();
  const next = await run(srv, { ...plainSpec, sort: [{ attr: 'name', dir: 'desc' }] }, { managed });
  assert.deepEqual(next.result.refused, [], 'omitting a formerly declared join is not drift');
  assert.match(srv.rowOf('savedqueries', A).fetchxml, /alias="person"/, 'the join is kept');
  managed.persist(next.result.managedBindings);
  const described = await run(srv, { ...plainSpec, sort: [{ attr: 'name', dir: 'desc' }], description: 'Owned now' }, { managed });
  assert.deepEqual(described.result.refused, []);
  assert.equal(srv.rowOf('savedqueries', A).description, 'Owned now');
  // Neighbour: a part someone else changed IS drift when this run writes it.
  managed.persist(described.result.managedBindings);
  srv.rowOf('savedqueries', A).description = 'Changed elsewhere';
  srv.clearLog();
  const drift = await run(srv, { ...plainSpec, sort: [{ attr: 'name', dir: 'desc' }], description: 'Mine again' }, { managed });
  assert.deepEqual(drift.result.refused.map((r) => r.code), ['view-drift']);
  assert.equal(srv.writes.length, 0);
});

test('a joined-table filter resolves its choice label on the joined table', () => {
  const calls = [];
  const view = { ...plainSpec, linkEntities: [personJoin], filters: [{ attr: 'statecode', op: 'eq', value: 'Open', relatedEntity: 'person' }, { attr: 'industrycode', op: 'in', values: ['Retail'] }] };
  const out = compileViewIntent(view, { resolveValue: (entity, attr, value) => { calls.push([entity, attr, value]); return entity === 'contact' ? 100 : 200; } });
  assert.deepEqual(calls, [['contact', 'statecode', 'Open'], ['account', 'industrycode', 'Retail']]);
  assert.deepEqual(out.intent.filters.conditions, [{ attribute: 'statecode', operator: 'eq', value: '100', entityname: 'person' }]);
});

test('a new declared view is created through the creation port under the reserved id, with a baseline its first edit accepts', async () => {
  const srv = createRowTableServer({ tables: { savedqueries: 'savedqueryid' } });
  const managed = fakeManaged();
  const creates = fakeCreates();
  const view = { entity: 'account', name: 'New view', reconcile: 'declared', activeOnly: false, columns: ['name'] };
  const first = await run(srv, view, { managed, creates });
  assert.deepEqual(first.result.refused, []);
  assert.equal(creates.calls.length, 1);
  assert.deepEqual(creates.calls[0].op, { kind: 'view', key: 'account/New view', identity: ['account', 'New view'], childKeys: [] });
  const id = creates.calls[0].ids.id;
  assert.ok(srv.rowOf('savedqueries', id), 'the row is stored under the id the port reserved');
  assert.deepEqual(first.result.saved.map((s) => [s.id, s.created]), [[id, true]]);
  const [binding] = first.result.managedBindings;
  assert.equal(binding.id, id);
  assert.ok(binding.intentSha256 && binding.partsSha256, 'the created binding records a baseline');
  managed.persist(first.result.managedBindings);
  srv.clearLog();
  const next = await run(srv, { ...view, sort: [{ attr: 'name', dir: 'desc' }] }, { managed, creates });
  assert.deepEqual(next.result.refused, []);
  assert.deepEqual(next.result.saved.map((s) => s.id), [id]);
  assert.equal(creates.calls.length, 1, 'the edit is not another create');
});

test('a view create is refused without the port and while an earlier create is pending; nothing is sent', async () => {
  const view = { entity: 'account', name: 'New view', reconcile: 'declared', activeOnly: false, columns: ['name'] };
  for (const [ctx, code] of [[{}, 'creation-port-unavailable'], [{ creates: fakeCreates({ pendingUnknown: ['account/New view'] }) }, 'creation-pending-unknown']]) {
    const srv = createRowTableServer({ tables: { savedqueries: 'savedqueryid' } });
    const { result } = await run(srv, view, { managed: fakeManaged(), ...ctx });
    assert.deepEqual(result.refused.map((r) => r.code), [code]);
    assert.equal(srv.writes.length, 0);
    assert.deepEqual(result.saved, []);
  }
});
test('a created view that cannot be read back stays unknown and records no guessed baseline; the next run does not create it again', async () => {
  const srv = createRowTableServer({ tables: { savedqueries: 'savedqueryid' } });
  const managed = fakeManaged();
  const creates = fakeCreates();
  const view = { entity: 'account', name: 'New view', reconcile: 'declared', activeOnly: false, columns: ['name'] };
  const sdk = await srv.newSdk();
  const ctx = { managed, creates };
  const plan = await planViewReconcile({ view, sdk }, ctx);
  // Only the read-back after the create fails: the create and its push go through.
  const failingRead = new Proxy(sdk, { get(t, p) {
    if (p === 'fetchArtifact') return async () => { throw new Error('read failed'); };
    return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
  } });
  const result = await applyViewReconcile(plan, { sdk: failingRead }, ctx);
  const id = creates.calls[0].ids.id;
  assert.ok(srv.rowOf('savedqueries', id), 'the view was created');
  assert.deepEqual(result.unknown.map((u) => [u.key, u.code]), [['account/New view', 'view-created-unreadable']]);
  assert.deepEqual(result.managedBindings, [], 'no baseline is recorded from the intent');
  managed.persist(result.managedBindings);
  srv.clearLog();
  const again = await run(srv, view, ctx);
  assert.equal(creates.calls.length, 1, 'the created view is not created a second time');
  assert.ok(!srv.writes.some((w) => w.verb === 'post'), 'no second row is posted');
  // It already matches the spec, so it is reported unchanged, but it is still not bound: binding it needs
  // the maker's adoption decision, which the earlier unknown outcome asked for.
  assert.deepEqual(again.result.unchanged.map((u) => u.id), [id]);
  assert.deepEqual(again.result.managedBindings, []);
});
