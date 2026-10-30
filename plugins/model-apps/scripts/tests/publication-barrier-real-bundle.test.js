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
const { createFeatureSettlement, remedyFor } = require('../lib/reconcile-common.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');
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

async function setup(publish, barrier = createPublicationBarrier(), { recordBinding } = {}) {
  const srv = createRowTableServer({ tables: { savedqueries: 'savedqueryid', savedqueryvisualizations: 'savedqueryvisualizationid' } });
  const sdk = await srv.newSdk();
  const ctx = { managed: fakeManaged(), creates: passThroughCreates() };
  const paths = buildPublishPaths({ sdk, client: srv.httpClient, publish, barrier, recordBinding });
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

  // The managed-artifacts store's write of a binding fails (a local disk error) after a clean save: the row is
  // saved but its settlement did not finish, so its table must not be published — not even by an obligation a
  // clean sibling created earlier — and the binding is never treated as recorded.
  const bindingStore = () => {
    const store = { fail: false, recorded: [] };
    store.recordBinding = (b) => {
      if (store.fail) throw Object.assign(new Error('binding persistence EIO'), { code: 'EIO' });
      store.recorded.push(b.key);
    };
    return store;
  };
  for (const drain of ['the settle of a halted build', 'every publication path']) {
    test(`binding (${phase}): a binding not recorded after a clean save withholds its table from ${drain}, owed obligations included`, async () => {
      const store = bindingStore();
      const s = await setup(publish, createPublicationBarrier(), { recordBinding: store.recordBinding });
      assert.equal((await s.paths.settle('view account/Earlier view', await s.apply('view', view({ name: 'Earlier view' })))).ok, true);
      assert.equal(s.paths.owed.size, publish ? 1 : 0, 'with the publish phase the earlier view owes the table a publish');
      const mark = s.srv.writes.length;
      const unsettled = await s.apply('view', view({ name: 'Saved but unsettled' }));
      assert.equal(unsettled.refused.length + unsettled.unknown.length, 0);
      assert.equal(unsettled.managedBindings.length, 1);
      assert.equal(unsettled.pendingPublish.length, 1);
      store.fail = true;
      await assert.rejects(s.paths.settle('view account/Saved but unsettled', unsettled), /binding persistence EIO/);
      store.fail = false;
      assert.equal((await s.paths.settle('view account/Sibling view', await s.apply('view', view({ name: 'Sibling view' })))).ok, true);
      if (drain === 'every publication path') await drainAll(s);
      else await s.paths.halt();
      assert.equal(envelopes(s.srv, 'account', mark), 0, 'a table envelope would also ship the row whose binding was not recorded');
      assert.deepEqual(s.barrier.withheld().map((w) => [w.table, w.blockedBy]), [['account', ['view account/Saved but unsettled (its managed binding was not recorded)']]]);
      assert.deepEqual(unsettled.pendingPublish.map((p) => p.withheld), [true]);
      assert.equal(store.recorded.length, 2, 'the earlier and the sibling view are recorded');
      assert.equal(store.recorded.includes(unsettled.managedBindings[0].key), false, 'the failed binding is not treated as recorded');
      assert.equal(unsettled.saved.length, 1, 'the created row is still reported for the solution and undo bookkeeping');
    });
  }

  test(`binding (${phase}): another table is still published once after a binding failure on account`, async () => {
    const store = bindingStore();
    const s = await setup(publish, createPublicationBarrier(), { recordBinding: store.recordBinding });
    store.fail = true;
    await assert.rejects(s.paths.settle('view account/Saved but unsettled', await s.apply('view', view({ name: 'Saved but unsettled' }))), /EIO/);
    store.fail = false;
    assert.equal((await s.paths.settle('view contact/Contacts', await s.apply('view', view({ entity: 'contact', name: 'Contacts' })))).ok, true);
    await drainAll(s, { app: false });
    assert.equal(envelopes(s.srv, 'contact'), 1);
    assert.equal(envelopes(s.srv, 'account'), 0);
    assert.deepEqual(s.barrier.blockedTables(), ['account']);
  });

  test(`binding (${phase}): a run whose bindings are all recorded sends exactly the requests it sends with no store`, async () => {
    const trail = async (store) => {
      const s = await setup(publish, createPublicationBarrier(), { recordBinding: store && store.recordBinding });
      const v = await s.apply('view', view());
      assert.deepEqual(await s.paths.settle('view', v), { ok: true });
      assert.deepEqual(await s.paths.settle('chart', await s.apply('chart', chart())), { ok: true });
      await drainAll(s, { held: ['account'] });
      assert.equal(s.barrier.active, false);
      return s.srv.writes.map((w) => [w.verb, w.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>'), /PublishXml/.test(w.url) ? JSON.stringify(w.body) : '']);
    };
    const store = bindingStore();
    const recorded = await trail(store);
    assert.deepEqual(recorded, await trail(null));
    assert.equal(store.recorded.length, 2, 'one binding recorded for the view and one for the chart');
    assert.ok(recorded.some(([, url]) => /PublishXml/.test(url)), 'the clean run does publish');
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

// The SDK over the plugin's own HTTP client (createAzHttpClient), whose transport is this in-memory
// service — the client the CLI makes, with the barrier's send gate on its transport when `barrier` is given.
const ORG = 'https://contoso.crm.dynamics.com';
const API = `${ORG}/api/data/v9.2`;
const transportOf = (srv) => async ({ url, method, headers, body }) => {
  const verb = String(method).toLowerCase();
  const data = body == null ? undefined : JSON.parse(body);
  const r = verb === 'get' ? await srv.httpClient.get(url)
    : verb === 'patch' ? await srv.httpClient.patch(url, data, headers)
      : verb === 'delete' ? await srv.httpClient.delete(url)
        : await srv.httpClient[verb](url, data);
  return { statusCode: r.status, headers: r.headers || {}, body: r.body === undefined ? '' : JSON.stringify(r.body) };
};
const clientOver = (transport) => createAzHttpClient(ORG, { getToken: () => 'test-token-'.padEnd(64, 'x'), request: transport, sleep: async () => {} });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

// An SDK whose workspace read of artifact `gate.id` pauses inside the SDK's own publish of it, before
// any request is sent (the SDK reads the artifact from its workspace and takes its lock first).
async function pausingSdk(httpClient, gate) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
  const store = createNodeWorkspaceStorage(makeTempDir('barrier-race-'));
  const storage = new Proxy(store, { get(t, p) {
    if (p === 'readText') {
      return async (keys) => {
        if (gate.id && !gate.paused && keys.some((k) => String(k).includes(gate.id))) {
          gate.paused = true;
          gate.entered.resolve();
          await gate.resume.promise;
        }
        return t.readText(keys);
      };
    }
    return typeof t[p] === 'function' ? t[p].bind(t) : t[p];
  } });
  const sdk = createMakerSdk({ workspaceStorage: storage, instanceUrl: ORG, httpClient });
  await sdk.initWorkspace();
  return sdk;
}

// A clean view's immediate publish (no publish phase) is inside the SDK when a sibling view on the same
// table fails after saving. `gated`: the CLI's client, its transport behind the barrier's send gate.
async function raceScenario({ gated, failSibling = true }) {
  const srv = createRowTableServer({ tables: { savedqueries: 'savedqueryid' } });
  const barrier = createPublicationBarrier();
  const transport = transportOf(srv);
  const client = clientOver(gated ? barrier.gateRequest(transport) : transport);
  const gate = { id: null, paused: false, entered: deferred(), resume: deferred() };
  const sdk = await pausingSdk(client, gate);
  const ctx = { managed: fakeManaged(), creates: passThroughCreates() };
  const paths = buildPublishPaths({ sdk, client, publish: false, barrier });
  const apply = async (name, readFails) => {
    const plan = await planViewReconcile({ view: view({ name }), sdk }, ctx);
    return applyViewReconcile(plan, { sdk: readFails ? failingReadBack(sdk) : sdk }, ctx);
  };
  try {
    const good = await apply('Clean sibling', false);
    gate.id = good.saved[0].id;
    const mark = srv.writes.length;
    const inflight = paths.settle('view account/Clean sibling', good);
    await gate.entered.promise;
    const bad = await apply(failSibling ? 'Unreadable sibling' : 'Readable sibling', failSibling);
    // A clean sibling's own publish waits for the workspace the paused publish holds, so it is only
    // awaited after the pause ends; the failing sibling settles (and blocks) while the pause lasts.
    const sibling = paths.settle(`view account/${failSibling ? 'Unreadable' : 'Readable'} sibling`, bad);
    const settled = failSibling ? await sibling : null;
    gate.resume.resolve();
    await inflight;
    return { srv, barrier, settled: settled || await sibling, mark };
  } finally {
    gate.resume.resolve();
  }
}

test('send gate: a publish the SDK is already preparing when a sibling blocks its table is not sent', async () => {
  const { srv, barrier, settled, mark } = await raceScenario({ gated: true });
  assert.equal(settled.ok, false);
  assert.deepEqual(barrier.blockedTables(), ['account']);
  assert.equal(envelopes(srv, 'account', mark), 0, 'the blocked table must not be published after the block');
  assert.deepEqual(barrier.withheld()[0].skipped, ['publish request (checked when sent)']);
});

test('send gate: without a failure the same race publishes both views, through the same requests gated or not', async () => {
  const trail = async (gated) => {
    const { srv, barrier, settled, mark } = await raceScenario({ gated, failSibling: false });
    assert.equal(settled.ok, true);
    assert.equal(barrier.active, false);
    assert.equal(envelopes(srv, 'account', mark), 2);
    return srv.writes.map((w) => [w.verb, w.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>'), /PublishXml/.test(w.url) ? JSON.stringify(w.body) : '']);
  };
  assert.deepEqual(await trail(true), await trail(false));
});

test('send gate: what a publish request is cut to, refused as, or passed through as', async () => {
  const sent = [];
  const transport = (req) => { sent.push(req); return Promise.resolve({ statusCode: 204, headers: {}, body: '' }); };
  const b = createPublicationBarrier();
  const gate = b.gateRequest(transport);
  const publishXml = (xml) => ({ url: `${API}/PublishXml`, method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ParameterXml: xml }) });
  const both = publishXml('<importexportxml><entities><entity>account</entity><entity>contact</entity></entities></importexportxml>');
  await gate(both);
  assert.equal(sent.pop(), both, 'inert: the very request goes to the transport');
  b.block('account', 'view account/x (view-created-unreadable)');
  await gate(both);
  assert.equal(JSON.parse(sent.pop().body).ParameterXml, '<importexportxml><entities><entity>contact</entity></entities></importexportxml>');
  const only = await gate(publishXml('<importexportxml><entities><entity>Account</entity></entities><nodes/></importexportxml>'));
  assert.equal(sent.length, 0, 'nothing left to publish: not sent');
  assert.equal(only.statusCode, 204);
  const withApp = publishXml('<importexportxml><entities><entity>account</entity></entities><appmodules><appmodule>{0a0a0a0a-0000-4000-8000-000000000001}</appmodule></appmodules></importexportxml>');
  await gate(withApp);
  assert.equal(JSON.parse(sent.pop().body).ParameterXml, '<importexportxml><appmodules><appmodule>{0a0a0a0a-0000-4000-8000-000000000001}</appmodule></appmodules></importexportxml>');
  const all = await gate({ url: `${API}/Microsoft.Dynamics.CRM.PublishAllXml`, method: 'POST', headers: {}, body: '{}' });
  assert.equal(all.statusCode, 409);
  assert.equal(JSON.parse(all.body).error.code, 'publication-withheld');
  const batch = await gate({ url: `${API}/$batch`, method: 'POST', headers: {}, body: '--b\r\nPOST PublishXml\r\n\r\n{"ParameterXml":"<importexportxml><entities><entity>account</entity></entities></importexportxml>"}\r\n--b--' });
  assert.equal(batch.statusCode, 409);
  const unreadable = await gate({ url: `${API}/PublishXml`, method: 'POST', headers: {}, body: 'not json' });
  assert.equal(unreadable.statusCode, 409, 'a publish that cannot be read is not sent');
  assert.equal(sent.length, 0);
  const contactOnly = publishXml('<importexportxml><entities><entity>contact</entity></entities></importexportxml>');
  const read = { url: `${API}/savedqueries`, method: 'GET', headers: {}, body: null };
  await gate(contactOnly);
  await gate(read);
  assert.deepEqual(sent, [contactOnly, read], 'a request that names no blocked table goes as it came');
  assert.deepEqual(b.withheld()[0].skipped, ['publish request (checked when sent)']);
});

for (const publish of [false, true]) {
  const phase = publish ? 'with the publish phase' : 'without the publish phase';
  const appPublishes = (srv, from = 0) => srv.writes.slice(from).filter((w) => /PublishXml/.test(w.url) && JSON.stringify(w.body).includes('<appmodule>')).length;

  for (const [what, write] of [
    ['holds a form of', { held: ['account'] }],
    ['adds (navigation) a form of', { held: [], added: ['account'] }],
    ['cannot say what it holds, and may hold a form of', { held: null }],
  ]) {
    test(`app write (${phase}): an app that ${what} a withheld table is not written or published`, async () => {
      const s = await setup(publish);
      assert.equal((await s.paths.settle('view contact', await s.apply('view', view({ entity: 'contact', name: 'Contacts' })))).ok, true);
      const mark = s.srv.writes.length;
      assert.equal((await s.paths.settle('chart account/Withheld chart', await failChart(s))).ok, false);
      await assert.rejects(s.paths.writeApp(write), (err) => err.code === 'publication-withheld' && /the app was not written or published/.test(err.message) && /account/.test(err.message));
      assert.equal(appPublishes(s.srv, mark), 0);
      assert.equal(envelopes(s.srv, 'account', mark), 0);
      assert.ok(s.barrier.withheld()[0].skipped.includes('app write or publish (the app holds or adds a form of the table)'));
    });
  }

  test(`app write (${phase}): an app that neither holds nor adds a form of the withheld table is written as before`, async () => {
    const s = await setup(publish);
    assert.equal((await s.paths.settle('chart account/Withheld chart', await failChart(s))).ok, false);
    const mark = s.srv.writes.length;
    await s.paths.writeApp({ held: ['contact'], added: ['contact'] });
    assert.equal(appPublishes(s.srv, mark), 1);
    assert.equal(envelopes(s.srv, 'account', mark), 0);
    assert.equal(envelopes(s.srv, 'contact', mark), publish ? 1 : 0);
  });

  test(`app write (${phase}): with nothing blocked the app write is unchanged, holdings unread or not`, async () => {
    const s = await setup(publish);
    assert.equal((await s.paths.settle('view', await s.apply('view', view()))).ok, true);
    const mark = s.srv.writes.length;
    await s.paths.writeApp({ held: null, added: ['account'] });
    assert.equal(appPublishes(s.srv, mark), 1);
    assert.equal(s.barrier.checkAppWrite({ added: ['account'], existingApp: true }).ok, true);
  });
}

test('settlement blocks the table before it reports, so a reporting failure cannot leave the row publishable', () => {
  const barrier = createPublicationBarrier();
  const settled = [];
  const bindings = [];
  const settle = createFeatureSettlement({
    barrier,
    settled,
    recordBinding: (b) => bindings.push(b),
    markIncomplete: () => { throw new Error('reporting failed'); },
  });
  const failed = { saved: [{}], managedBindings: [{ kind: 'view', key: 'account/x' }], refused: [], unknown: [{ code: 'view-created-unreadable', message: 'read failed' }],
    pendingPublish: [{ key: 'account/x', scope: { type: 'view', id: '1', table: 'account' }, withheld: true }] };
  assert.throws(() => settle('views', 'view account/x', failed), /reporting failed/);
  assert.deepEqual(barrier.blockedTables(), ['account']);
  assert.deepEqual(bindings, [{ kind: 'view', key: 'account/x' }], 'the binding of the created row is still recorded');
  assert.deepEqual(settled, []);

  const lines = [];
  const report = createFeatureSettlement({ barrier, settled, markIncomplete: (phase, line, detail) => lines.push([phase, line, detail]) });
  const clean = { saved: [{}], managedBindings: [], refused: [], unknown: [], pendingPublish: [{ key: 'contact/y', scope: { type: 'view', id: '2', table: 'contact' } }] };
  assert.deepEqual(report('views', 'view contact/y', clean), { ok: true });
  assert.deepEqual(settled, [{ scope: { type: 'view', id: '2', table: 'contact' }, label: 'view contact/y' }]);
  const drift = { saved: [], managedBindings: [], refused: [{ code: 'view-drift', message: 'changed on the server' }], unknown: [], pendingPublish: [] };
  assert.deepEqual(report('views', 'view contact/z', drift), { ok: false });
  assert.deepEqual(lines, [['views', 'view contact/z: view-drift — changed on the server', { code: 'view-drift', remedy: remedyFor('view-drift') }]]);
  assert.deepEqual(barrier.blockedTables(), ['account'], 'a refusal before anything was written blocks nothing');
  assert.match(remedyFor('chart-adoption-not-authorized'), /adoption approval/);
  assert.match(remedyFor('view-columns-removal-not-authorized'), /destructive approval/);
  assert.match(remedyFor('quick-find-empty-not-authorized'), /destructive approval/);
  assert.equal(remedyFor('view-write-unknown'), 'repair and rerun');
});

test('settlement withholds every pending table of a result whose binding is not recorded, and keeps the failure', () => {
  const barrier = createPublicationBarrier();
  const settled = [];
  const lines = [];
  const recorded = [];
  let fail = true;
  const settle = createFeatureSettlement({
    barrier,
    settled,
    markIncomplete: (phase, line) => lines.push(line),
    recordBinding: (b) => {
      if (fail) throw Object.assign(new Error('binding persistence EIO'), { code: 'EIO' });
      recorded.push(b.key);
    },
  });
  const scope = (table, id) => ({ key: `${table}/${id}`, scope: { type: 'view', id, table } });
  const clean = { saved: [{}, {}], managedBindings: [{ kind: 'view', key: 'account/a' }], refused: [], unknown: [], pendingPublish: [scope('account', '1'), scope('Contact', '2')] };
  assert.throws(() => settle('views', 'view account/a', clean), (err) => err.code === 'EIO');
  assert.deepEqual(barrier.blockedTables(), ['account', 'contact']);
  assert.deepEqual(clean.pendingPublish.map((p) => p.withheld), [true, true]);
  assert.deepEqual(settled, [], 'nothing is scheduled for publication');
  assert.deepEqual(recorded, []);

  // A result that wrote nothing (an unchanged view) has nothing to withhold: the failure still escapes.
  const unchanged = { saved: [], managedBindings: [{ kind: 'view', key: 'lead/u' }], refused: [], unknown: [], pendingPublish: [] };
  assert.throws(() => settle('views', 'view lead/u', unchanged), /binding persistence EIO/);
  assert.deepEqual(barrier.blockedTables(), ['account', 'contact']);

  // A failed result whose binding is not recorded either: blocked and reported once, the binding failure escapes.
  const failed = { saved: [{}], managedBindings: [{ kind: 'chart', key: 'opportunity/c' }], refused: [{ code: 'chart-title-not-stored', message: 'title' }], unknown: [],
    pendingPublish: [{ key: 'opportunity/c', scope: { type: 'chart', id: '3', table: 'opportunity' }, withheld: true }] };
  assert.throws(() => settle('charts', 'chart opportunity/c', failed), /binding persistence EIO/);
  assert.deepEqual(barrier.withheld().find((w) => w.table === 'opportunity').blockedBy, ['chart opportunity/c (chart-title-not-stored)', 'chart opportunity/c (its managed binding was not recorded)']);
  assert.deepEqual(lines, ['chart opportunity/c: chart-title-not-stored — title']);

  // Recorded bindings: the result settles exactly as without a store, and unrelated tables stay publishable.
  fail = false;
  const other = { saved: [{}], managedBindings: [{ kind: 'view', key: 'incident/o' }], refused: [], unknown: [], pendingPublish: [scope('incident', '4')] };
  assert.deepEqual(settle('views', 'view incident/o', other), { ok: true });
  assert.deepEqual(settled, [{ scope: other.pendingPublish[0].scope, label: 'view incident/o' }]);
  assert.equal(other.pendingPublish[0].withheld, undefined);
  assert.deepEqual(recorded, ['incident/o']);
  assert.equal(barrier.blocks('incident'), false);
});