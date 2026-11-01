'use strict';
// Declared dashboards on the managed settlement (lib/dashboard-reconcile.js), through the real maker SDK bundle, the
// plugin's real HTTP client and the run's real publication barrier, over a fake Dataverse that keeps a saved and a
// published layer per systemform row (helpers/managed-wire.js). Each test counts what reaches the wire: the content
// writes (POST/PATCH systemforms) and the PublishXml requests, by dashboard id.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createManagedWire, sdkOver, clientOver } = require('./helpers/managed-wire.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const X = require('./helpers/dashboard-formxml.js');
const { openManagedContext } = require('../lib/managed-bindings.js');
const { writeFileAtomic } = require('../lib/apply-snapshot-store.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { createIntentCatalog } = require('../lib/creates-catalog.js');
const { environmentFingerprint } = require('../lib/page-ownership-records.js');
const { dashboardTileOpts, dashboardComponent } = require('../lib/sdk-build.js');
const { settleDeclaredDashboard, publishDeclaredDashboard, dashboardKey, projectDashboard, committedProjectionInput } = require('../lib/dashboard-reconcile.js');
const { createAttemptSendObserver } = require('../lib/managed-feature-contract.js');
const { systemFormLayerSha256 } = require('../lib/systemform-published.js');
const { canonicalJson } = require('../lib/reconcile-common.js');
// A free-text field of the committed declaration is kept as its sha256 (dashboard-reconcile.js HASHED_FIELDS).
const textSha = (s) => require('node:crypto').createHash('sha256').update(canonicalJson(String(s))).digest('hex');

const ENV = 'https://contoso.crm.dynamics.com';
const APP = 'contoso_app';
const SOL = 'contoso_solution';
const FP = environmentFingerprint(ENV);
const OPEN = '66666666-0000-4000-8000-000000000001';
const ALL = '66666666-0000-4000-8000-000000000002';
const MINE = '66666666-0000-4000-8000-000000000003';
const DID = '55555555-0000-4000-8000-000000000001';
const OTHER = '55555555-0000-4000-8000-000000000009';
const C_OPEN = 'c1c1c1c1-0000-4000-8000-000000000001';
const C_FOREIGN = 'c1c1c1c1-0000-4000-8000-000000000002';
const spec = { views: [{ entity: 'incident', name: 'Open cases' }, { entity: 'incident', name: 'All cases' }, { entity: 'incident', name: 'My cases' }] };
const built = { created: { views: { 'incident|Open cases': OPEN, 'incident|All cases': ALL, 'incident|My cases': MINE }, charts: {} } };
const resolveTile = (tile) => dashboardTileOpts(spec, tile, built);

const halt = (phase, label, code, { cause } = {}) => Object.assign(new Error(`${label}: ${code}`), { phase, code, cause, retry: 'never' });
const codeOf = async (p) => { try { await p; } catch (e) { return e.code; } return null; };
const contentWrites = (wire) => wire.writes().filter((e) => /^systemforms/i.test(e.path));
// The binding store's next file write fails once, when `failing.armed` is set: a crash at that persistence boundary.
function failNextStoreWrite() {
  const failing = { armed: false };
  const deps = {
    writeFileAtomic: (p, text) => {
      if (failing.armed) { failing.armed = false; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
      return writeFileAtomic(p, text);
    },
  };
  return { failing, deps };
}
const catalogFor = (d) => createIntentCatalog([{ catalogKind: 'dashboard', key: dashboardKey(d), scope: { kind: 'solution', solution: SOL }, declaration: { scopeType: 'Standard', name: d.name } }]);
const declared = (tiles, extra = {}) => ({ name: 'Ops', reconcile: 'declared', tiles, ...extra });

// The build-wide send observer is installed on the client every send goes through (the wiring stream installs it in
// build-model-app.js); `observer: false` is a run without it.
async function world({ observer = true } = {}) {
  const wire = createManagedWire();
  const barrier = createPublicationBarrier();
  const obs = observer ? createAttemptSendObserver() : null;
  const { sdk } = await sdkOver(wire, { barrier, observer: obs });
  const dir = makeTempDir('dash-settle-');
  const { store } = openManagedContext({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier });
  return { wire, barrier, sdk, dir, store, observer: obs };
}

// A new run over the same workspace and wire: a fresh barrier, observer, SDK and store handle, as the next build opens them.
async function rerun(w, { observer = true } = {}) {
  const barrier = createPublicationBarrier();
  const obs = observer ? createAttemptSendObserver() : null;
  const { sdk } = await sdkOver(w.wire, { barrier, observer: obs });
  const { store } = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier });
  return { ...w, barrier, sdk, store, observer: obs };
}

// The maker's typed adoption approval of `dashboard:ops` is given unless a test passes its own `approvals`.
const ADOPT = { adopt: new Set(['dashboard:ops']) };
const settle = (w, dashboard, extra = {}) => settleDeclaredDashboard({
  dashboard, catalog: catalogFor(dashboard), sdk: w.sdk, store: w.store, barrier: w.barrier, halt, resolveTile, toComponent: dashboardComponent,
  ensureMembership: async () => undefined, ctx: { appUniqueName: APP, environmentFingerprint: FP }, approvals: ADOPT,
  ...(w.observer ? { sendObserver: w.observer } : {}), ...extra,
});
const publish = (w, key, id) => publishDeclaredDashboard({ store: w.store, barrier: w.barrier, sdk: w.sdk, key, id });

// A maker's dashboard: one bound-able list tile and one foreign custom control, published.
function putExisting(wire, { label = 'Open cases', description = 'Cases' } = {}) {
  const xml = X.dashboardXml([[X.nativeGrid(`{${C_OPEN}}`, label, OPEN)], [X.otherCustomControl(`{${C_FOREIGN}}`, 'Foreign', 'dddddddd-0000-4000-8000-000000000001')]]);
  return wire.putForm({ formid: DID, name: 'Ops', description, type: 0, objecttypecode: 'none', formxml: xml, istabletenabled: false }, { publishedToo: true });
}

test('a missing declared dashboard is created under its catalog id with catalog seed and tile ids, bound whole, published once by its own id; a rerun sends nothing', async () => {
  const w = await world();
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases' }, { key: 'all', type: 'list', view: 'All cases' }]);
  const catalog = catalogFor(d);
  const id = catalog.identityFor('dashboard', 'ops').derivedId;
  const ids = catalog.reserveChildren('dashboard', 'ops', { children: [
    { locator: 't', childKind: 'dashboardSeedTab', keyParts: ['seed-tab'] }, { locator: 's', childKind: 'dashboardSeedSection', keyParts: ['seed-section'] },
    { locator: 'open', childKind: 'dashboardControl', keyParts: ['open', 'control'] }, { locator: 'all', childKind: 'dashboardControl', keyParts: ['all', 'control'] },
  ] }).childIds;
  const out = await settle(w, d);
  assert.deepEqual(out.result, { committed: true, recovered: false });
  assert.equal(out.id, id);
  const xml = w.wire.saved.get(id).formxml.toLowerCase();
  for (const k of ['t', 's', 'open', 'all']) assert.ok(xml.includes(ids[k]), `the stored dashboard carries the catalog id of ${k}`);
  const group = w.store.readGroup('dashboard', 'ops').committed;
  assert.deepEqual(group.records.map((r) => `${r.kind}:${r.key}:${r.id}:${r.origin}`).sort(), [
    `dashboard-tile:ops/all:${ids.all}:created`, `dashboard-tile:ops/open:${ids.open}:created`, `dashboard:ops:${id}:created`,
  ]);
  assert.deepEqual(group.consumerState.seedIds, [ids.t, ids.s]);
  assert.equal(group.publication.state, 'owed');
  assert.equal(group.publication.desiredSha256, systemFormLayerSha256(w.wire.saved.get(id)), 'the debt records the hash the shared dashboard layer reader answers');

  const pub = await publish(w, 'ops', id);
  assert.equal(pub.sent, true);
  assert.equal(w.wire.publishes().length, 1);
  assert.match(w.wire.publishes()[0].body.ParameterXml, new RegExp(`^<importexportxml><dashboards><dashboard>${id}</dashboard></dashboards></importexportxml>$`, 'i'), 'one scope: its own id only');

  const next = await rerun(w);
  const before = w.wire.writes().length;
  assert.deepEqual((await settle(next, d)).result, { noop: true });
  assert.equal((await publish(next, 'ops', id)).sent, false);
  assert.equal(w.wire.writes().length, before, 'an unchanged, published dashboard sends no write and no publish');
});

test('an adopted dashboard: the pinned keyed tile is edited in place, a new tile is appended under catalog ids, the foreign tile and the omitted parts stay byte-identical; one scoped publish', async () => {
  const w = await world();
  putExisting(w.wire);
  const foreignCell = () => /<cell[^>]*>(?:(?!<\/cell>).)*c1c1c1c1-0000-4000-8000-000000000002(?:(?!<\/cell>).)*<\/cell>/i.exec(w.wire.saved.get(DID).formxml)[0];
  const foreignBefore = foreignCell();
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }, { key: 'mine', type: 'list', view: 'My cases' }], { dashboardId: DID });
  const added = catalogFor(d).reserveChildren('dashboard', 'ops', { actualRootId: DID, children: [
    { locator: 'c', childKind: 'dashboardControl', keyParts: ['mine', 'control'] }, { locator: 'cell', childKind: 'dashboardCell', keyParts: ['mine', 'cell'] },
  ] }).childIds;
  const out = await settle(w, d);
  assert.deepEqual(out.result, { committed: true, recovered: false });
  const xml = w.wire.saved.get(DID).formxml;
  assert.match(xml, /description="Open now"/, 'the keyed tile is renamed in place');
  assert.ok(xml.toLowerCase().includes(added.c) && xml.toLowerCase().includes(added.cell), 'the new tile carries its catalog control and cell ids');
  assert.equal(foreignCell(), foreignBefore, 'the foreign tile is byte-identical');
  assert.match(xml, /<RecordsPerPage>8<\/RecordsPerPage>/, 'a per-tile default the spec never authored is kept');
  assert.equal(contentWrites(w.wire).length, 1, 'one content write');
  const group = w.store.readGroup('dashboard', 'ops').committed;
  // A tile appended to a dashboard this build did not create is `adopted`: `created` is kept for a root create this
  // run's own answer acknowledged (the store refuses it otherwise).
  assert.deepEqual(group.records.map((r) => `${r.kind}:${r.key}:${r.id}:${r.origin}`).sort(), [
    `dashboard-tile:ops/mine:${added.c}:adopted`, `dashboard-tile:ops/open:${C_OPEN}:adopted`, `dashboard:ops:${DID}:adopted`,
  ]);
  assert.equal((await publish(w, 'ops', DID)).sent, true);
  assert.equal(w.wire.publishes(DID).length, 1);
  assert.equal(w.wire.publishes().length, 1);

  // The next run with the same spec: nothing to write and nothing owed.
  const next = await rerun(w);
  const writes = w.wire.writes().length;
  assert.deepEqual((await settle(next, d)).result, { noop: true });
  assert.equal((await publish(next, 'ops', DID)).sent, false);
  assert.equal(w.wire.writes().length, writes);

  // A tile the spec stops declaring is not deleted. The declaration changed, so the group is rebound to it with no write.
  const fewer = await rerun(w);
  const omitted = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  const contentBefore = contentWrites(w.wire).length;
  assert.deepEqual((await settle(fewer, omitted)).result, { committed: true, recovered: false });
  assert.equal(contentWrites(w.wire).length, contentBefore, 'no content write');
  assert.ok(w.wire.saved.get(DID).formxml.toLowerCase().includes(added.c), 'the omitted tile is still on the dashboard');
  assert.equal((await publish(fewer, 'ops', DID)).sent, false, 'nothing new to publish');
});

test('a settled dashboard whose published layer is stale for reasons not its own: a no-op, and nothing is published', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN }], { dashboardId: DID });
  await settle(w, d);
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'not-needed', 'a rebind with no content write owes nothing');
  w.wire.published.set(DID, { ...w.wire.published.get(DID), formxml: '<form old="1"/>' });
  const next = await rerun(w);
  const writes = contentWrites(w.wire).length;
  assert.deepEqual((await settle(next, d)).result, { noop: true });
  assert.equal(contentWrites(w.wire).length, writes, 'no content write');
  assert.equal((await publish(next, 'ops', DID)).sent, false);
  assert.equal(w.wire.publishes(DID).length, 0, 'a stale published layer is not this build\'s debt');
});

test('an owed publication the group already holds: the rerun is a no-op, then one scoped publish and no content write', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  await settle(w, d);
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'owed');
  const next = await rerun(w);
  const writes = contentWrites(w.wire).length;
  assert.deepEqual((await settle(next, d)).result, { noop: true });
  assert.equal((await publish(next, 'ops', DID)).sent, true);
  assert.equal(contentWrites(w.wire).length, writes, 'no content write');
  assert.equal(w.wire.publishes(DID).length, 1);
});

// Each refusal is a coded stop before any write: no content write, no publish of the dashboard by any path, and no
// app write that holds it.
const refusals = [
  ['a table-scoped dashboard', 'dashboard-scope-unsupported', (w) => { putExisting(w.wire); w.wire.saved.get(DID).objecttypecode = 'account'; }, {}],
  ['a non-Standard dashboard', 'dashboard-interactive-unsupported', (w) => { putExisting(w.wire); w.wire.saved.get(DID).type = 10; }, {}],
  ['two tiles pinned to one control', 'dashboard-spec-invalid', (w) => putExisting(w.wire), { tiles: [{ key: 'a', type: 'list', view: 'Open cases', componentId: C_OPEN }, { key: 'b', type: 'list', view: 'All cases', componentId: C_OPEN }] }],
  ['a type replacement', 'dashboard-tile-type-change', (w) => putExisting(w.wire), { tiles: [{ key: 'open', type: 'iframe', url: 'https://contoso.example', componentId: C_OPEN }] }],
  ['a pinned tile that is not there', 'dashboard-tile-pinned-not-found', (w) => putExisting(w.wire), { tiles: [{ key: 'open', type: 'list', view: 'Open cases', componentId: 'c1c1c1c1-0000-4000-8000-0000000000ff' }] }],
  ['an unreadable published row', 'dashboard-published-unreadable', (w) => {
    putExisting(w.wire);
    w.wire.script((e) => e.method === 'GET' && /^systemforms\([^)]+\)$/i.test(e.path) && /name,description,formxml/.test(decodeURIComponent(e.url)), { statusCode: 403, body: { error: { code: '0x80040220', message: 'denied' } } });
  }, {}],
  ['a dirty workspace copy', 'create-completion-required', async (w) => {
    putExisting(w.wire);
    await w.sdk.fetchArtifact('dashboard', DID, { overwrite: true });
    await w.sdk.updateElement('dashboard', DID, '/description', 'unsent');
  }, {}],
  ['an unsettled creation record', 'dashboard-creation-record-unsettled', (w) => putExisting(w.wire), { retainedCreationIds: [DID] }],
];
for (const [what, code, arrange, opts] of refusals) {
  test(`refused before any write: ${what} (${code}); the dashboard is withheld from every publish`, async () => {
    const w = await world();
    w.wire.putForm({ formid: OTHER, name: 'Other', type: 0, objecttypecode: 'none', formxml: '<form o="1"/>' });
    await arrange(w);
    const tiles = opts.tiles || [{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Renamed' }];
    const d = declared(tiles, { dashboardId: DID, description: 'Changed' });
    assert.equal(await codeOf(settle(w, d, opts.retainedCreationIds ? { retainedCreationIds: opts.retainedCreationIds } : {})), code);
    assert.equal(contentWrites(w.wire).length, 0, 'nothing was written');
    assert.equal(w.store.readGroup('dashboard', 'ops').committed, null, 'nothing was bound');
    await w.sdk.fetchArtifact('dashboard', DID).catch(() => undefined);
    await w.sdk.publishArtifact('dashboard', DID).catch(() => undefined);
    assert.equal(w.wire.publishes(DID).length, 0, 'no path publishes it');
    assert.equal(w.barrier.checkAppWrite({ held: new Set(), existingApp: true, heldDashboards: [DID] }).ok, false, 'no app write that holds it');
    await w.sdk.fetchArtifact('dashboard', OTHER);
    await w.sdk.publishArtifact('dashboard', OTHER);
    assert.equal(w.wire.publishes(OTHER).length, 1, 'an unrelated dashboard still publishes');
  });
}

test('a recorded tile that is gone is never re-added; a description clear needs the destructive approval', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN }], { dashboardId: DID });
  await settle(w, d);
  const cleared = { ...d, description: '' };
  const next = await rerun(w);
  assert.equal(await codeOf(settle(next, cleared)), 'dashboard-description-clear-not-authorized');
  const approved = await rerun(w);
  assert.equal((await settle(approved, cleared, { approvals: { destructive: new Set(['dashboard:ops']) } })).result.committed, true);
  assert.equal(w.wire.saved.get(DID).description, '');

  const row = w.wire.saved.get(DID);
  row.formxml = X.dashboardXml([[X.otherCustomControl(`{${C_FOREIGN}}`, 'Foreign', 'dddddddd-0000-4000-8000-000000000001')]]);
  const gone = await rerun(w);
  const writes = contentWrites(w.wire).length;
  assert.equal(await codeOf(settle(gone, cleared, { approvals: { overwrite: true, destructive: true } })), 'dashboard-tile-missing');
  assert.equal(contentWrites(w.wire).length, writes, 'nothing written, whatever the approvals');
});

test('a dashboard found by name is adopted only with the adopt approval; without it nothing is written', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }]);
  assert.equal(await codeOf(settle(w, d, { resolvedId: DID, approvals: {} })), 'dashboard-adoption-not-authorized');
  assert.equal(contentWrites(w.wire).length, 0);
  const next = await rerun(w);
  const out = await settle(next, d, { resolvedId: DID, approvals: { adopt: new Set(['dashboard:ops']) } });
  assert.equal(out.result.committed, true);
  assert.equal(out.id, DID);
  assert.equal(contentWrites(w.wire).length, 1);
});

// The store write that commits the group fails once, after the dashboard was saved: the run that saved it publishes
// nothing, and the next run either proves what it finds and binds it without a content write, or, if the row changed
// in between, binds nothing.
async function crashedAfterSave() {
  const { failing, deps } = failNextStoreWrite();

  const w = await world();
  const { store } = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier: w.barrier, deps });
  w.store = store;
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  assert.ok(await codeOf(settle(w, d, { ensureMembership: async () => { failing.armed = true; } })), 'the commit failed');
  assert.match(w.wire.saved.get(DID).formxml, /Open now/, 'the content was saved');
  assert.equal(w.store.readGroup('dashboard', 'ops').committed, null, 'nothing was bound');
  assert.equal(await codeOf(publish(w, 'ops', DID)), 'managed-settlement-pending', 'the managed publish stops on the unproved attempt');
  await w.sdk.publishArtifact('dashboard', DID).catch(() => undefined);
  assert.equal(w.wire.publishes(DID).length, 0, 'no path publishes it');
  return { w, d };
}

test('a commit lost after the save: the next run proves the saved row and binds it with no content write', async () => {
  const { w, d } = await crashedAfterSave();
  const writes = contentWrites(w.wire).length;
  const next = await rerun(w);
  assert.equal(w.wire.publishes(DID).length, 0);
  assert.deepEqual((await settle(next, d)).result, { committed: true, recovered: true });
  assert.equal(contentWrites(w.wire).length, writes, 'no content write');
  assert.deepEqual(next.store.readGroup('dashboard', 'ops').committed.records.map((r) => r.origin).sort(), ['adopted', 'adopted']);
  assert.equal((await publish(next, 'ops', DID)).sent, true);
});

// What a maker may change between the lost commit and the next run, and the stop the proof answers with.
const changedSince = [
  ['the keyed tile relabelled', 'create-completion-required', (xml) => xml.replace('description="Open now"', 'description="Someone else"')],
  ['the keyed tile moved to another cell', 'dashboard-stored-mismatch', (xml) => xml.replace('{aaaaaaaa-0000-4000-8000-000000000001}', '{aaaaaaaa-0000-4000-8000-0000000000ee}')],
  ['the foreign tile edited', 'create-completion-required', (xml) => xml.replace('<Mode>compact</Mode>', '<Mode>full</Mode>')],
  // Parts the spec does not author on a MANAGED tile, and the foreign layout, are preserved too.
  ['the managed list\'s RecordsPerPage changed', 'create-completion-required', (xml) => xml.replace('<RecordsPerPage>8</RecordsPerPage>', '<RecordsPerPage>42</RecordsPerPage>')],
  ['the two rows reversed', 'create-completion-required', (xml) => { const rows = xml.match(/<row>.*?<\/row>/g); return xml.replace(rows.join(''), [...rows].reverse().join('')); }],
];
for (const [what, code, change] of changedSince) test(`a commit lost after the save, then ${what}: ${code}, nothing bound, nothing published`, async () => {
  const { w, d } = await crashedAfterSave();
  const row = w.wire.saved.get(DID);
  const xml = change(row.formxml);
  assert.notEqual(xml, row.formxml, 'the stimulus applies');
  row.formxml = xml;
  const next = await rerun(w);
  assert.equal(await codeOf(settle(next, d)), code);
  assert.equal(next.store.readGroup('dashboard', 'ops').committed, null);
  assert.equal(await codeOf(publish(next, 'ops', DID)), 'managed-settlement-pending');
  await next.sdk.publishArtifact('dashboard', DID).catch(() => undefined);
  assert.equal(w.wire.publishes(DID).length, 0);
  assert.equal(next.barrier.checkAppWrite({ held: new Set(), existingApp: true, heldDashboards: [DID] }).ok, false);
});

test('the publish adapter: a layer read that fails is a hold for the run, nothing is sent and it is not retried', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  await settle(w, d);
  w.wire.script((e) => e.method === 'GET' && /^systemforms\([^)]+\)$/i.test(e.path), { statusCode: 403, body: { error: { code: '0x80040220', message: 'denied' } } });
  const out = await publish(w, 'ops', DID);
  assert.equal(out.held, true);
  assert.equal(out.sent, false);
  assert.equal((await publish(w, 'ops', DID)).sent, false, 'a second call in the run does not send either');
  await w.sdk.publishArtifact('dashboard', DID).catch(() => undefined);
  assert.equal(w.wire.publishes(DID).length, 0);
});

test('an update whose commit is lost leaves the committed tile baseline on disk as it was; the next run proves and binds the new one', async () => {
  const { failing, deps } = failNextStoreWrite();

  const w = await world();
  w.store = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier: w.barrier, deps }).store;
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  await settle(w, d);
  const before = JSON.parse(JSON.stringify(w.store.readGroup('dashboard', 'ops').committed));
  const renamed = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open later' }], { dashboardId: DID });
  const update = await rerun(w);
  update.store = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier: update.barrier, deps }).store;
  assert.ok(await codeOf(settle(update, renamed, { ensureMembership: async () => { failing.armed = true; } })));
  assert.match(w.wire.saved.get(DID).formxml, /Open later/, 'the content was saved');
  const onDisk = (await rerun(w)).store.readGroup('dashboard', 'ops');
  assert.deepEqual(onDisk.committed, before, 'the committed root and tile baseline are unchanged on disk');
  const writes = contentWrites(w.wire).length;
  const next = await rerun(w);
  assert.deepEqual((await settle(next, renamed)).result, { committed: true, recovered: true });
  assert.equal(contentWrites(w.wire).length, writes, 'no content write');
  const tile = next.store.readGroup('dashboard', 'ops').committed.records.find((r) => r.key === 'ops/open');
  assert.notEqual(tile.intentSha256, before.records.find((r) => r.key === 'ops/open').intentSha256, 'the proved baseline replaces the old one whole');
});

test('a bound dashboard whose creation record still retains its id: its owed publication is withheld, no app write may hold it, another dashboard publishes', async () => {
  const w = await world();
  putExisting(w.wire);
  w.wire.putForm({ formid: OTHER, name: 'Other', type: 0, objecttypecode: 'none', formxml: '<form o="1"/>' });
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  await settle(w, d);
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'owed', 'publication debt is owed');
  const next = await rerun(w);
  assert.equal(await codeOf(settle(next, d, { retainedCreationIds: [DID] })), 'dashboard-creation-record-unsettled');
  const out = await publish(next, 'ops', DID).catch((e) => ({ sent: false, code: e.code }));
  assert.equal(out.sent, false);
  await next.sdk.fetchArtifact('dashboard', DID);
  await next.sdk.publishArtifact('dashboard', DID).catch(() => undefined);
  assert.equal(w.wire.publishes(DID).length, 0, 'zero PublishXml names it');
  assert.equal(next.barrier.checkAppWrite({ held: new Set(), existingApp: true, heldDashboards: [DID] }).ok, false);
  await next.sdk.fetchArtifact('dashboard', OTHER);
  await next.sdk.publishArtifact('dashboard', OTHER);
  assert.equal(w.wire.publishes(OTHER).length, 1);
});

test('a maker edit saved after the settle and before the publish: the publish is not sent and no path publishes the dashboard in the run', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  await settle(w, d);
  const row = w.wire.saved.get(DID);
  row.formxml = row.formxml.replace('<Mode>compact</Mode>', '<Mode>full</Mode>');
  const out = await publish(w, 'ops', DID).catch((e) => ({ sent: false, code: e.code }));
  assert.equal(out.sent, false);
  await w.sdk.publishArtifact('dashboard', DID).catch(() => undefined);
  assert.equal(w.wire.publishes(DID).length, 0, 'the maker edit is not put live');
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'owed', 'the debt stays owed');
});

test('a publish that names other targets than the dashboard is not sent, and the dashboard is withheld for the rest of the run', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  await settle(w, d);
  // A defective publish path: it asks for every customization instead of its one dashboard.
  const wide = { ...w.sdk, dataverse: w.sdk.dataverse, fetchArtifact: async () => undefined, publishArtifact: async () => w.sdk.dataverse.post('/PublishAllXml', {}) };
  await publishDeclaredDashboard({ store: w.store, barrier: w.barrier, sdk: wide, key: 'ops', id: DID }).catch((e) => e);
  assert.equal(w.wire.log.filter((e) => /PublishAllXml/i.test(e.path)).length, 0, 'the wide publish is not sent');
  await w.sdk.publishArtifact('dashboard', DID).catch(() => undefined);
  assert.equal(w.wire.publishes(DID).length, 0, 'no later path publishes the dashboard in the run');
});

test('a save whose answer is lost holds the dashboard for the run: no publish by any path, no app write that holds it; the next run proves it', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  w.wire.script((e) => e.method === 'PATCH' && /^systemforms\(/i.test(e.path), { error: 'socket hang up' });
  assert.ok(await codeOf(settle(w, d)), 'the run stops');
  assert.match(w.wire.saved.get(DID).formxml, /Open now/, 'the save did land');
  await w.sdk.fetchArtifact('dashboard', DID).catch(() => undefined);
  await w.sdk.publishArtifact('dashboard', DID).catch(() => undefined);
  assert.equal(w.wire.publishes(DID).length, 0, 'held: no path publishes it');
  assert.equal(w.barrier.checkAppWrite({ held: new Set(), existingApp: true, heldDashboards: [DID] }).ok, false);
  const writes = contentWrites(w.wire).length;
  const next = await rerun(w);
  assert.deepEqual((await settle(next, d)).result, { committed: true, recovered: true });
  assert.equal(contentWrites(w.wire).length, writes, 'no second content write');
});

test('a change that cannot be prepared sends nothing and still withholds the dashboard\'s earlier owed publish for the run', async () => {
  const { failing, deps } = failNextStoreWrite();

  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  await settle(w, d);
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'owed');
  const next = await rerun(w);
  next.store = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier: next.barrier, deps }).store;
  const writes = contentWrites(w.wire).length;
  failing.armed = true;
  assert.ok(await codeOf(settle(next, declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open later' }], { dashboardId: DID }))));
  assert.equal(contentWrites(w.wire).length, writes, 'nothing sent');
  await next.sdk.fetchArtifact('dashboard', DID);
  await next.sdk.publishArtifact('dashboard', DID).catch(() => undefined);
  assert.equal(w.wire.publishes(DID).length, 0, 'the earlier owed publish does not ship in this run');
  assert.equal(next.barrier.checkAppWrite({ held: new Set(), existingApp: true, heldDashboards: [DID] }).ok, false);
});

// --- Recovery and provenance (the S0 recovery seams: preflight on every path, resumeCreate, the send observer, typed
// adoption consent, an acknowledged root create only from this run's own answer).

const refusedCreate = { statusCode: 400, body: { error: { code: '0x80040203', message: 'refused' } }, unapplied: true };
const isCreate = (e) => e.method === 'POST' && /^systemforms$/i.test(e.path);

for (const observed of [false, true]) {
  test(`a create the service refused is ${observed ? 'continued (its send window proves it unsent)' : 'resumed (its root reads absent)'} by the next run under the same catalog id: one root`, async () => {
    const w = await world({ observer: observed });
    const d = declared([{ key: 'open', type: 'list', view: 'Open cases' }]);
    const id = catalogFor(d).identityFor('dashboard', 'ops').derivedId;
    w.wire.script(isCreate, refusedCreate);
    assert.ok(await codeOf(settle(w, d)), 'the refused create stops the run');
    assert.equal(w.wire.saved.has(id), false, 'nothing was created');
    assert.equal(w.store.readGroup('dashboard', 'ops').pending.phase, 'sending');
    const next = await rerun(w, { observer: observed });
    const out = await settle(next, d);
    assert.deepEqual(out.result, { committed: true, recovered: true, [observed ? 'continued' : 'resumed']: true });
    assert.equal(out.id, id);
    assert.equal(w.wire.log.filter(isCreate).length, 2, 'the same create, sent again once');
    assert.ok(w.wire.saved.has(id), 'the one root, under its catalog id');
    const group = next.store.readGroup('dashboard', 'ops').committed;
    assert.deepEqual(group.records.map((r) => r.origin), ['created', 'created'], 'this run\'s own create answer acknowledged it');
  });
}

test('a create whose answer was lost: the next run binds it only with the typed adoption approval, and never sends it again', async () => {
  const w = await world();
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases' }]);
  const id = catalogFor(d).identityFor('dashboard', 'ops').derivedId;
  w.wire.script(isCreate, { error: 'socket hang up' });
  assert.ok(await codeOf(settle(w, d)), 'the lost answer stops the run');
  assert.ok(w.wire.saved.has(id), 'the create did land');
  // The client may send the create again after the lost answer; the wire answers that one with the duplicate-key 412.
  const creates = w.wire.log.filter(isCreate).length;
  const next = await rerun(w);
  assert.equal(await codeOf(settle(next, d, { approvals: {} })), 'managed-adoption-required');
  assert.equal(next.store.readGroup('dashboard', 'ops').committed, null, 'nothing bound');
  const kept = next.store.readGroup('dashboard', 'ops').pending;
  assert.ok(kept && kept.expected && kept.expected.rootId === id, 'the attempt and its expected proof are kept for the approved run');
  const approved = await rerun(w);
  assert.deepEqual((await settle(approved, d)).result, { committed: true, recovered: true });
  assert.equal(w.wire.log.filter(isCreate).length, creates, 'no later run sends a create');
  assert.deepEqual(approved.store.readGroup('dashboard', 'ops').committed.records.map((r) => r.origin), ['adopted', 'adopted']);
});

test('a pinned dashboard is not the maker\'s consent to manage it: a write to it needs the typed adoption approval', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  assert.equal(await codeOf(settle(w, d, { approvals: {} })), 'dashboard-adoption-not-authorized');
  assert.equal(contentWrites(w.wire).length, 0);
  assert.equal(w.store.readGroup('dashboard', 'ops').committed, null);
});

test('a pinned dashboard with no history whose published layer is stale: bound with nothing owed, nothing published', async () => {
  const w = await world();
  putExisting(w.wire);
  w.wire.published.set(DID, { ...w.wire.published.get(DID), formxml: '<form old="1"/>' });
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN }], { dashboardId: DID });
  assert.equal((await settle(w, d)).result.committed, true);
  assert.equal(contentWrites(w.wire).length, 0);
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'not-needed');
  assert.equal((await publish(w, 'ops', DID)).sent, false);
  assert.equal(w.wire.publishes(DID).length, 0, 'someone else\'s draft is not put live');
});

test('a foreign edit saved after the settle and publish: the rerun rebinds it and publishes nothing', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  await settle(w, d);
  assert.equal((await publish(w, 'ops', DID)).sent, true);
  const row = w.wire.saved.get(DID);
  row.formxml = row.formxml.replace('<Mode>compact</Mode>', '<Mode>full</Mode>');
  const next = await rerun(w);
  const writes = contentWrites(w.wire).length;
  await settle(next, d);
  assert.equal(contentWrites(w.wire).length, writes, 'no content write');
  const out = await publish(next, 'ops', DID).catch((e) => ({ sent: false, code: e.code }));
  assert.equal(out.sent, false);
  assert.equal(w.wire.publishes(DID).length, 1, 'the foreign draft is not published');
});

test('an attempt with no content write recovered while the published layer is stale: nothing is owed or published', async () => {
  const { failing, deps } = failNextStoreWrite();
  const w = await world();
  w.store = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier: w.barrier, deps }).store;
  putExisting(w.wire);
  w.wire.published.set(DID, { ...w.wire.published.get(DID), formxml: '<form old="1"/>' });
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN }], { dashboardId: DID });
  assert.ok(await codeOf(settle(w, d, { ensureMembership: async () => { failing.armed = true; } })), 'the commit failed');
  const next = await rerun(w);
  assert.equal((await settle(next, d)).result.recovered, true);
  assert.equal(next.store.readGroup('dashboard', 'ops').committed.publication.state, 'not-needed');
  assert.equal((await publish(next, 'ops', DID)).sent, false);
  assert.equal(w.wire.publishes(DID).length, 0);
});

test('a commit lost after the save, then a creation record that retains two ids: the recovery stops, nothing is bound, neither id is published', async () => {
  const { w, d } = await crashedAfterSave();
  const RETAINED = '55555555-0000-4000-8000-000000000007';
  w.wire.putForm({ formid: RETAINED, name: 'Ops 2', type: 0, objecttypecode: 'none', formxml: '<form r="1"/>' });
  const next = await rerun(w);
  assert.equal(await codeOf(settle(next, d, { retainedCreationIds: [DID, RETAINED] })), 'dashboard-creation-record-unsettled');
  assert.equal(next.store.readGroup('dashboard', 'ops').committed, null, 'nothing bound');
  for (const id of [DID, RETAINED]) {
    await next.sdk.fetchArtifact('dashboard', id).catch(() => undefined);
    await next.sdk.publishArtifact('dashboard', id).catch(() => undefined);
    assert.equal(w.wire.publishes(id).length, 0, `no path publishes ${id}`);
  }
  assert.equal(next.barrier.checkAppWrite({ held: new Set(), existingApp: true, heldDashboards: [RETAINED] }).ok, false, 'no app write that holds it');
});

test('a commit lost after the save, then unsent edits in the next run\'s workspace copy: the recovery stops and the copy keeps them', async () => {
  const { w, d } = await crashedAfterSave();
  const next = await rerun(w);
  await next.sdk.fetchArtifact('dashboard', DID, { overwrite: true });
  await next.sdk.updateElement('dashboard', DID, '/description', 'UNSENT MAKER TEXT');
  let err = null;
  try { await settle(next, d); } catch (e) { err = e; }
  assert.equal(err && err.code, 'create-completion-required');
  assert.equal(err.cause && err.cause.category, 'workspace-copy-unsent-edits');
  assert.equal((await next.sdk.getArtifact('dashboard', DID)).description, 'UNSENT MAKER TEXT', 'the unsent text is still in the copy');
  assert.equal(next.store.readGroup('dashboard', 'ops').committed, null);
  // The identical rerun stops the same way: the copy is the maker's to save or discard.
  assert.equal(await codeOf(settle(next, d)), 'create-completion-required');
  assert.equal((await next.sdk.getArtifact('dashboard', DID)).description, 'UNSENT MAKER TEXT');
});

test('the committed declaration is the canonical one: authoring a field the live row already has rebinds without a content write', async () => {
  const w = await world();
  putExisting(w.wire);
  const omitted = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN }], { dashboardId: DID });
  await settle(w, omitted);
  const first = w.store.readGroup('dashboard', 'ops').committed.consumerState.declaration;
  assert.equal(first.tiles[0].name, undefined, 'an omitted field stays absent');
  const authored = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open cases' }], { dashboardId: DID });
  const next = await rerun(w);
  const writes = contentWrites(w.wire).length;
  assert.equal((await settle(next, authored)).result.committed, true, 'the authorship change is recorded');
  assert.equal(contentWrites(w.wire).length, writes, 'no content write');
  assert.deepEqual(next.store.readGroup('dashboard', 'ops').committed.consumerState.declaration.tiles[0].name, { sha256: textSha('Open cases') });
  assert.deepEqual((await settle(await rerun(w), authored)).result, { noop: true });
});

test('a recovery under a spec changed since the send records the declaration unknown, and the next run applies the new spec', async () => {
  const { w } = await crashedAfterSave();
  const later = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open later' }], { dashboardId: DID });
  const next = await rerun(w);
  assert.deepEqual((await settle(next, later)).result, { committed: true, recovered: true });
  assert.equal(next.store.readGroup('dashboard', 'ops').committed.consumerState.declaration, null, 'not today\'s spec');
  assert.match(w.wire.saved.get(DID).formxml, /Open now/, 'the recovery sent nothing');
  const after = await rerun(w);
  assert.equal((await settle(after, later)).result.committed, true);
  assert.match(w.wire.saved.get(DID).formxml, /Open later/);
  assert.deepEqual(after.store.readGroup('dashboard', 'ops').committed.consumerState.declaration.tiles[0].name, { sha256: textSha('Open later') });
});

test('a publish whose confirmation write failed after the send: the next run confirms it from the layers and sends no second PublishXml', async () => {
  const { failing, deps } = failNextStoreWrite();
  const w = await world();
  w.store = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier: w.barrier, deps }).store;
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  await settle(w, d);
  const sdk = Object.create(w.sdk);
  sdk.publishArtifact = async (...a) => { const r = await w.sdk.publishArtifact(...a); failing.armed = true; return r; };
  assert.ok(await codeOf(publishDeclaredDashboard({ store: w.store, barrier: w.barrier, sdk, key: 'ops', id: DID })), 'the confirmation write failed');
  assert.equal(w.wire.publishes(DID).length, 1);
  const next = await rerun(w);
  assert.deepEqual((await settle(next, d)).result, { noop: true });
  const out = await publish(next, 'ops', DID);
  assert.equal(out.sent, false);
  assert.deepEqual(out.confirmed, [{ family: 'dashboard', key: 'ops' }]);
  assert.equal(w.wire.publishes(DID).length, 1, 'no second PublishXml');
  assert.equal(next.store.readGroup('dashboard', 'ops').committed.publication.state, 'confirmed');
});

// The read-only projection verify and hydrate share with the proof (projectDashboard): over a fresh read of what was
// settled it reproduces the committed proof, and it sees the non-authored and layout drift the proof refuses.
test('the shared read-only projection reproduces the committed proof of a created and an adopted dashboard, and sees a non-authored or layout change', async () => {
  const fresh = async (w, id) => { await w.sdk.fetchArtifact('dashboard', id, { overwrite: true }); return await w.sdk.getArtifact('dashboard', id); };
  const project = async (w, id) => {
    const group = w.store.readGroup('dashboard', 'ops').committed;
    const { managed, preservesLayout } = committedProjectionInput(group);
    return { group, preservesLayout, out: projectDashboard(await fresh(w, id), managed, { preservesLayout }) };
  };
  const made = await world();
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases' }]);
  const id = (await settle(made, d)).id;
  const c = await project(made, id);
  assert.equal(c.preservesLayout, false, 'the create preserved nothing');
  assert.deepEqual([c.out.semanticSha256, c.out.preservationSha256], [c.group.proof.semanticSha256, c.group.proof.preservationSha256]);

  const w = await world();
  putExisting(w.wire);
  await settle(w, declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID }));
  const a = await project(w, DID);
  assert.equal(a.preservesLayout, true);
  assert.deepEqual([a.out.semanticSha256, a.out.preservationSha256, a.out.missing, a.out.duplicated], [a.group.proof.semanticSha256, a.group.proof.preservationSha256, [], []]);
  const row = w.wire.saved.get(DID);
  for (const change of [
    (xml) => xml.replace('<RecordsPerPage>8</RecordsPerPage>', '<RecordsPerPage>42</RecordsPerPage>'),
    (xml) => { const rows = xml.match(/<row>.*?<\/row>/g); return xml.replace(rows.join(''), [...rows].reverse().join('')); },
  ]) {
    const was = row.formxml;
    row.formxml = change(was);
    assert.notEqual(row.formxml, was);
    const b = await project(w, DID);
    assert.equal(b.out.semanticSha256, a.group.proof.semanticSha256, 'the authored projection is unchanged');
    assert.notEqual(b.out.preservationSha256, a.group.proof.preservationSha256, 'the change outside the declaration is seen');
    row.formxml = was;
  }
});

// The workspace copy is a file: three SDK instances open the same workspace directory in turn, as three builds would.
test('a recovery never overwrites unsent edits on disk: a fresh SDK reads them before and after the stopped recovery', async () => {
  const wire = createManagedWire();
  const sdkDir = makeTempDir('dash-sdk-');
  const dir = makeTempDir('dash-settle-');
  const { failing, deps } = failNextStoreWrite();
  const open = async (faults = false) => {
    const barrier = createPublicationBarrier();
    const observer = createAttemptSendObserver();
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(sdkDir), instanceUrl: ENV, httpClient: clientOver(wire, { barrier, observer }) });
    await sdk.initWorkspace();
    const { store } = openManagedContext({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier, ...(faults ? { deps } : {}) });
    return { wire, barrier, sdk, dir, store, observer };
  };
  putExisting(wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  const first = await open(true);
  assert.ok(await codeOf(settle(first, d, { ensureMembership: async () => { failing.armed = true; } })), 'the commit failed after the save');
  await first.sdk.updateElement('dashboard', DID, '/description', 'DURABLE UNSENT MAKER TEXT');
  const second = await open();
  assert.equal((await second.sdk.getArtifact('dashboard', DID)).description, 'DURABLE UNSENT MAKER TEXT', 'the edit is on disk');
  assert.equal(await codeOf(settle(second, d)), 'create-completion-required');
  const third = await open();
  assert.equal((await third.sdk.getArtifact('dashboard', DID)).description, 'DURABLE UNSENT MAKER TEXT', 'the recovery did not overwrite the file');
  assert.equal(third.store.readGroup('dashboard', 'ops').committed, null);
});