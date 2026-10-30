'use strict';
// The run-wide table publication barrier (lib/publication-barrier.js), through the REAL vendored SDK over
// an in-memory savedqueries/savedqueryvisualizations service. A table publish ships everything saved on
// the table, so once a declared view or chart on a table ends refused or unknown after something was
// saved, no publication path may publish that table again in the run — including the obligations other,
// successful work created BEFORE the failure. Each case counts the PublishXml requests that name the
// table (envelopes, not artifact ids), with and without the publish phase.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRowTableServer } = require('./helpers/row-table-server.js');
const { fakeManaged, passThroughCreates, buildPublishPaths } = require('./helpers/feature-ports.js');
const { createPublicationBarrier, describeWithheld } = require('../lib/publication-barrier.js');
const { planViewReconcile, applyViewReconcile } = require('../lib/view-reconcile.js');
const { planChartReconcile, applyChartReconcile } = require('../lib/chart-reconcile.js');
const { chartDef } = require('../lib/sdk-build.js');

const view = (over = {}) => ({ entity: 'account', name: 'Declared view', activeOnly: false, columns: ['name'], reconcile: 'declared', ...over });
const chart = (over = {}) => ({ entity: 'account', name: 'Declared chart', chartType: 'Column', groupBy: 'statecode', reconcile: 'declared', ...over });
const failingReadBack = (sdk) => new Proxy(sdk, { get(t, p) {
  if (p === 'fetchArtifact') return async () => { throw new Error('read failed'); };
  return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
} });
// A create whose request may have been stored but whose answer was lost (a connection reset).
const lostWrite = (sdk) => new Proxy(sdk, { get(t, p) {
  if (p === 'pushArtifact') return async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); };
  return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
} });
const envelopes = (srv, table, from = 0) => srv.writes.slice(from).filter((w) => /PublishXml/.test(w.url) && JSON.stringify(w.body).includes(`<entity>${table}</entity>`)).length;

async function setup(publish, barrier = createPublicationBarrier()) {
  const srv = createRowTableServer({ tables: { savedqueries: 'savedqueryid', savedqueryvisualizations: 'savedqueryvisualizationid' } });
  const sdk = await srv.newSdk();
  const ctx = { managed: fakeManaged(), creates: passThroughCreates() };
  const paths = buildPublishPaths({ sdk, client: srv.httpClient, publish, barrier });
  const apply = async (kind, wanted, { readFails = false, lost = false } = {}) => {
    const writer = lost ? lostWrite(sdk) : readFails ? failingReadBack(sdk) : sdk;
    if (kind === 'view') {
      const plan = await planViewReconcile({ view: wanted, sdk }, ctx);
      return applyViewReconcile(plan, { sdk: writer }, ctx);
    }
    const plan = await planChartReconcile({ chart: wanted, sdk, chartArtifact: chartDef({}, wanted) }, ctx);
    return applyChartReconcile(plan, { sdk: writer }, ctx);
  };
  return { srv, sdk, paths, barrier, apply };
}

// The two failures: a created view that cannot be read back (unknown) and a created chart whose title
// was not stored (refused). Both saved a row on account.
const failView = (s) => s.apply('view', view({ name: 'Withheld view' }), { readFails: true });
const failChart = (s) => s.apply('chart', chart({ name: 'Withheld chart', title: 'Unsupported title' }));

// `app`: the run writes an app, so the tables before it are published first (and again by the publish phase).
async function drainAll(s, { held = [], app = true } = {}) {
  if (app) await s.paths.beforeApp(held);
  await s.paths.publishPhase();
  await s.paths.halt();
}

for (const publish of [false, true]) {
  const phase = publish ? 'with the publish phase' : 'without the publish phase';

  test(`isolation (${phase}): a sibling view's reconcile publish after a failed view does not publish the table`, async () => {
    const s = await setup(publish);
    // An obligation created before the failure: a clean declared view (owed, or published at once).
    assert.equal((await s.paths.settle('view earlier', await s.apply('view', view({ name: 'Earlier view' })))).ok, true);
    const mark = s.srv.writes.length;
    const bad = await failView(s);
    assert.deepEqual(bad.unknown.map((u) => u.code), ['view-created-unreadable']);
    assert.equal((await s.paths.settle('view account/Withheld view', bad)).ok, false);
    assert.equal((await s.paths.settle('view sibling', await s.apply('view', view({ name: 'Sibling view' })))).ok, true);
    await drainAll(s);
    assert.equal(envelopes(s.srv, 'account', mark), 0, 'a table envelope would also ship the withheld view');
    assert.equal(bad.saved.length, 1, 'the created row is still reported for the solution and undo bookkeeping');
    assert.deepEqual(s.barrier.withheld().map((w) => [w.table, w.blockedBy]), [['account', ['view account/Withheld view (view-created-unreadable)']]]);
  });

  test(`isolation (${phase}): the chart map after a failed chart does not publish the table`, async () => {
    const s = await setup(publish);
    assert.equal((await s.paths.settle('chart earlier', await s.apply('chart', chart({ name: 'Earlier chart' })))).ok, true);
    const mark = s.srv.writes.length;
    const bad = await failChart(s);
    assert.deepEqual(bad.refused.map((r) => r.code), ['chart-title-not-stored']);
    assert.equal((await s.paths.settle('chart account/Withheld chart', bad)).ok, false);
    assert.equal((await s.paths.settle('chart sibling', await s.apply('chart', chart({ name: 'Sibling chart' })))).ok, true);
    await drainAll(s);
    assert.equal(envelopes(s.srv, 'account', mark), 0);
  });

  test(`isolation (${phase}): the tables published before the app leave out a withheld table the app holds`, async () => {
    const s = await setup(publish);
    assert.equal((await s.paths.settle('view earlier', await s.apply('view', view({ name: 'Earlier view' })))).ok, true);
    const mark = s.srv.writes.length;
    assert.equal((await s.paths.settle('chart account/Withheld chart', await failChart(s))).ok, false);
    await s.paths.beforeApp(['account']);
    assert.equal(envelopes(s.srv, 'account', mark), 0);
  });

  test(`isolation (${phase}): tables owed before the failure are not published after it`, async () => {
    const s = await setup(publish);
    const earlier = await s.apply('view', view({ name: 'Earlier view' }));
    assert.equal((await s.paths.settle('view earlier', earlier)).ok, true);
    // The default-view enrichment's deferred publish, owed before the failure.
    if (publish) s.paths.oweTablePublish('account', 'view', earlier.saved[0].id, 'default views of account');
    const mark = s.srv.writes.length;
    assert.equal((await s.paths.settle('chart account/Withheld chart', await failChart(s))).ok, false);
    await drainAll(s);
    assert.equal(envelopes(s.srv, 'account', mark), 0);
  });

  test(`isolation (${phase}): a view the views phase created before the failure is not the publish phase's vehicle for the table`, async () => {
    const s = await setup(publish);
    const created = await s.apply('view', view({ name: 'Earlier view' }));
    s.paths.createdView('account', created.saved[0].id);
    const mark = s.srv.writes.length;
    assert.equal((await s.paths.settle('chart account/Withheld chart', await failChart(s))).ok, false);
    await drainAll(s);
    assert.equal(envelopes(s.srv, 'account', mark), 0);
  });

  for (const kind of ['view', 'chart']) {
    test(`isolation (${phase}): a ${kind} create whose outcome is unknown withholds its table, owed obligations included`, async () => {
      const s = await setup(publish);
      const earlier = await s.apply('view', view({ name: 'Earlier view' }));
      assert.equal((await s.paths.settle('view earlier', earlier)).ok, true);
      s.paths.createdView('account', earlier.saved[0].id);
      const mark = s.srv.writes.length;
      const lost = await s.apply(kind, kind === 'view' ? view({ name: 'Lost' }) : chart({ name: 'Lost' }), { lost: true });
      assert.deepEqual(lost.unknown.map((u) => u.code), [`${kind}-write-unknown`]);
      assert.deepEqual(lost.pendingPublish.map((p) => [p.scope.type, p.scope.table, p.withheld]), [[kind, 'account', true]]);
      assert.equal((await s.paths.settle(`${kind} account/Lost`, lost)).ok, false);
      await drainAll(s);
      assert.equal(envelopes(s.srv, 'account', mark), 0);
      assert.deepEqual(s.barrier.blockedTables(), ['account']);
    });
  }

  test(`neighbour (${phase}): another table is still published once after a failure on account`, async () => {
    const s = await setup(publish);
    assert.equal((await s.paths.settle('chart account/Withheld chart', await failChart(s))).ok, false);
    assert.equal((await s.paths.settle('view contact', await s.apply('view', view({ entity: 'contact', name: 'Contacts' })))).ok, true);
    await drainAll(s, { app: false });
    assert.equal(envelopes(s.srv, 'contact'), 1);
    assert.equal(envelopes(s.srv, 'account'), 0);
  });

  test(`inert (${phase}): a run with no failure sends exactly the requests it sent before the barrier`, async () => {
    const trail = async (barrier) => {
      const s = await setup(publish, barrier);
      const v = await s.apply('view', view());
      s.paths.createdView('account', v.saved[0].id);
      if (publish) s.paths.oweTablePublish('account', 'view', v.saved[0].id, 'default views of account');
      await s.paths.settle('view', v);
      await s.paths.settle('chart', await s.apply('chart', chart()));
      await s.paths.settle('view contact', await s.apply('view', view({ entity: 'contact', name: 'Contacts' })));
      await drainAll(s, { held: ['account', 'contact'] });
      return s.srv.writes.map((w) => [w.verb, w.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>'), /PublishXml/.test(w.url) ? JSON.stringify(w.body) : '']);
    };
    const barrier = createPublicationBarrier();
    const withBarrier = await trail(barrier);
    assert.deepEqual(withBarrier, await trail(null));
    assert.ok(withBarrier.some(([, url]) => /PublishXml/.test(url)), 'the clean run does publish');
    assert.equal(barrier.active, false);
    assert.deepEqual(barrier.withheld(), []);
  });
}

test('a result refused before anything was written blocks nothing; a refused or unknown write that saved does', () => {
  const b = createPublicationBarrier();
  const preWrite = { saved: [], pendingPublish: [], refused: [{ key: 'account/x', code: 'view-drift' }], unknown: [] };
  assert.deepEqual(b.noteResult(preWrite, 'view account/x'), []);
  assert.equal(b.active, false);
  const clean = { saved: [{}], pendingPublish: [{ key: 'k', scope: { type: 'view', id: '1', table: 'account' } }], refused: [], unknown: [] };
  assert.deepEqual(b.noteResult(clean, 'view account/k'), []);
  const lost = { saved: [], pendingPublish: [{ key: 'k', scope: { type: 'chart', id: '2', table: 'Account' }, withheld: true }], refused: [], unknown: [{ code: 'chart-write-unknown' }] };
  assert.deepEqual(b.noteResult(lost, 'chart account/k'), ['account']);
  assert.equal(b.blocks('ACCOUNT'), true);
  assert.equal(b.blocks('contact'), false);
  assert.match(describeWithheld(b.withheld()[0]), /^table account was not published: chart account\/k \(chart-write-unknown\) ended refused or unknown/);
});

test('an owed target noted before the block is withheld when a later attempt settles a halt', () => {
  const b = createPublicationBarrier();
  const target = ['view', 'AAAA-1', ['view Earlier']];
  b.noteTarget('account', target);
  b.noteTarget('contact', ['form', 'bbbb-2']);
  assert.equal(b.allowTarget(target, 'settle after a halt'), true, 'inert before any block');
  b.block('account', 'chart account/Withheld chart (chart-title-not-stored)');
  assert.equal(b.allowTarget(['view', 'aaaa-1'], 'settle after a halt'), false);
  assert.equal(b.allowTarget(['form', 'bbbb-2'], 'settle after a halt'), true);
  assert.equal(b.allowTarget(['view', 'unknown-id'], 'settle after a halt'), true, 'a target never noted is not guessed');
  const list = ['contact', 'account'];
  assert.deepEqual(b.allowTables(list, 'tables published before the app'), ['contact']);
  assert.deepEqual(b.withheld(), [{ table: 'account', blockedBy: ['chart account/Withheld chart (chart-title-not-stored)'], skipped: ['settle after a halt', 'tables published before the app'] }]);
  const inert = createPublicationBarrier();
  assert.equal(inert.allowTables(list, 'x'), list, 'nothing blocked: the very list is answered');
});
