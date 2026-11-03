'use strict';
// Declared dashboards on the managed settlement (lib/dashboard-reconcile.js), through the real maker SDK bundle, the
// plugin's real HTTP client and the run's real publication barrier, over a fake Dataverse that keeps a saved and a
// published layer per systemform row (helpers/managed-wire.js). Each test counts what reaches the wire: the content
// writes (POST/PATCH systemforms) and the PublishXml requests, by dashboard id.
const fs = require('node:fs');
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
const { settleDeclaredDashboard, publishDeclaredDashboard, dashboardKey, projectDashboard, preservationMatches, committedProjectionInput, committedDeclaration, canonicalDeclaration, validateDeclaredDashboard } = require('../lib/dashboard-reconcile.js');
const { createAttemptSendObserver, publishManagedScope } = require('../lib/managed-feature-contract.js');
const { LAYER_READERS } = require('../lib/managed-layer-readers.js');
// The $select of the publication read of a systemform's saved layer (systemform-published.js), with and without its
// root fields; the SDK's own fetch selects more, so a probe that injects between the two reads can tell them apart.
const PUBLICATION_SELECTS = new Set(['formid,name,description,formxml', 'formid,name,description,formxml,type,objecttypecode']);

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

// The build-wide send observer is installed on the client every send goes through (the build installs it once for the
// run); `observer: false` is a run without it.
async function world({ observer = true, platform } = {}) {
  const wire = createManagedWire(platform ? { platform } : undefined);
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
  provisionedLanguages: async () => w.wire.languages(),
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
  assert.equal(group.publication.desiredSha256, (await LAYER_READERS.dashboard(w.sdk.dataverse, group)).savedSha256, 'the debt records the hash the shared dashboard layer reader answers');

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
  // A managed cell's own attributes the spec does not author: proved like its parameters, not only its control's.
  ['the managed cell\'s showlabel changed', 'create-completion-required', (xml) => xml.replace(/(<cell\b[^>]*\bid="\{aaaaaaaa-0000-4000-8000-000000000001\}"[^>]*>)/, (cell) => cell.replace('showlabel="false"', 'showlabel="true"'))],
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

// --- Recovery and provenance: the preflight on every path, a create resumed or continued under its catalog id, the send
// observer, typed adoption consent, and a root create acknowledged only by this run's own answer.

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
  const first = committedDeclaration(w.store.readGroup('dashboard', 'ops').committed);
  assert.equal(first.tiles[0].name, undefined, 'an omitted field stays absent');
  const authored = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open cases' }], { dashboardId: DID });
  const next = await rerun(w);
  const writes = contentWrites(w.wire).length;
  assert.equal((await settle(next, authored)).result.committed, true, 'the authorship change is recorded');
  assert.equal(contentWrites(w.wire).length, writes, 'no content write');
  assert.deepEqual(committedDeclaration(next.store.readGroup('dashboard', 'ops').committed).tiles[0].name, 'Open cases', 'kept as authored');
  assert.deepEqual((await settle(await rerun(w), authored)).result, { noop: true });
});

test('a recovery under a spec changed since the send commits the ORIGINAL declaration, and the next run applies the new spec', async () => {
  const { w, d } = await crashedAfterSave();
  const later = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open later' }], { dashboardId: DID });
  const next = await rerun(w);
  assert.deepEqual((await settle(next, later)).result, { committed: true, recovered: true });
  assert.deepEqual(committedDeclaration(next.store.readGroup('dashboard', 'ops').committed), canonicalDeclaration(d), 'the declaration it was sent with, not today\'s spec and not unknown');
  assert.match(w.wire.saved.get(DID).formxml, /Open now/, 'the recovery sent nothing');
  const after = await rerun(w);
  assert.equal((await settle(after, later)).result.committed, true);
  assert.match(w.wire.saved.get(DID).formxml, /Open later/);
  assert.deepEqual(committedDeclaration(after.store.readGroup('dashboard', 'ops').committed).tiles[0].name, 'Open later');
});

test('the committed declaration keeps authored free text as written: it reads back as a spec entry the shape validator accepts, absent fields still absent', async () => {
  const w = await world();
  const d = declared([{ key: 'frame', type: 'iframe', url: 'https://contoso.example/report?mode=summary&title=<Q1 & Q2>', name: 'Report «Q1»' }], { description: 'Maker-authored description <b>bold</b>' });
  assert.equal((await settle(w, d)).result.committed, true);
  const group = w.store.readGroup('dashboard', 'ops').committed;
  const declaration = committedDeclaration(group);
  assert.deepEqual(declaration, { reconcile: 'declared', name: 'Ops', description: d.description, tiles: [{ key: 'frame', type: 'iframe', name: 'Report «Q1»', url: d.tiles[0].url }] }, 'authored values, nothing added');
  assert.deepEqual(validateDeclaredDashboard(declaration), [], 'it is a valid declared dashboard');
  assert.equal(declaration.tiles[0].url, d.tiles[0].url);
  assert.equal(declaration.description, d.description);
  assert.equal('dashboardId' in declaration || 'colspan' in declaration.tiles[0], false, 'an absent field stays absent');
  declaration.tiles[0].url = 'changed';
  assert.equal(committedDeclaration(w.store.readGroup('dashboard', 'ops').committed).tiles[0].url, d.tiles[0].url, 'the read-back is a copy');
  assert.deepEqual((await settle(await rerun(w), d)).result, { noop: true }, 'the stored declaration equals the spec');
});

test('a recovery under a changed spec reads the ORIGINAL declaration from the attempt and commits it, never null', async () => {
  const { w, d } = await crashedAfterSave();
  assert.deepEqual(w.store.readGroup('dashboard', 'ops').pending.declaration, canonicalDeclaration(d), 'the attempt recorded the declaration before the send');
  const changed = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID, description: 'New declaration, not the interrupted one' });
  const next = await rerun(w);
  assert.deepEqual((await settle(next, changed)).result, { committed: true, recovered: true });
  const kept = committedDeclaration(next.store.readGroup('dashboard', 'ops').committed);
  assert.notEqual(kept, null);
  assert.deepEqual(kept, canonicalDeclaration(d), 'the original declaration');
  assert.equal(kept.description, undefined, 'the original authored no description');
  const after = await rerun(w);
  assert.equal((await settle(after, changed)).result.committed, true, 'the next run applies the new spec');
  assert.equal(w.wire.saved.get(DID).description, 'New declaration, not the interrupted one');
  assert.deepEqual(committedDeclaration(after.store.readGroup('dashboard', 'ops').committed), canonicalDeclaration(changed));
});

test('a declared dashboard whose free text carries a credential is refused before anything is written or sent', async () => {
  const w = await world();
  const d = declared([{ key: 'frame', type: 'iframe', url: 'https://contoso.example/report?access_token=abc123def456', name: 'Report' }]);
  assert.equal(await codeOf(settle(w, d)), 'managed-declaration-refused');
  assert.equal(w.wire.writes().length, 0, 'nothing sent');
  const g = w.store.readGroup('dashboard', 'ops');
  assert.equal(g.committed, null);
  assert.equal(g.pending, null, 'no attempt recorded');
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

// The read-only projection verify and hydrate share with the proof (projectDashboard), called as documented — one
// input object: over a fresh read of what was settled it reproduces the committed proof, and it sees the non-authored
// and layout drift the proof refuses.
const freshRead = async (w, id) => { await w.sdk.fetchArtifact('dashboard', id, { overwrite: true }); return await w.sdk.getArtifact('dashboard', id); };
const projectCommitted = async (w, id) => {
  const group = w.store.readGroup('dashboard', 'ops').committed;
  const input = committedProjectionInput(group);
  const out = projectDashboard(await freshRead(w, id), { ...input, languageCode: w.sdk.languageCode });
  const certified = out.invalid.length === 0 && out.missing.length === 0 && out.duplicated.length === 0 &&
    out.semanticSha256 === group.proof.semanticSha256 && out.preservationSha256 === group.proof.preservationSha256;
  return { group, input, out, certified };
};
test('the shared read-only projection reproduces the committed proof of a created and an adopted dashboard, and sees a non-authored or layout change', async () => {
  const made = await world();
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases' }]);
  const id = (await settle(made, d)).id;
  const c = await projectCommitted(made, id);
  assert.equal(c.input.seedIds.length, 2, 'the create commit keeps its catalog seed ids, so the projection checks the seed');
  assert.equal(c.certified, true);

  const w = await world();
  putExisting(w.wire);
  await settle(w, declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID }));
  const a = await projectCommitted(w, DID);
  assert.deepEqual(a.input.seedIds, []);
  assert.equal(a.certified, true);
  const row = w.wire.saved.get(DID);
  for (const change of [
    (xml) => xml.replace('<RecordsPerPage>8</RecordsPerPage>', '<RecordsPerPage>42</RecordsPerPage>'),
    (xml) => { const rows = xml.match(/<row>.*?<\/row>/g); return xml.replace(rows.join(''), [...rows].reverse().join('')); },
    (xml) => xml.replace(/<cell\b[^>]*\bid="\{aaaaaaaa-0000-4000-8000-000000000001\}"[^>]*>/, (cell) => cell.replace('showlabel="false"', 'showlabel="true"')),
  ]) {
    const was = row.formxml;
    row.formxml = change(was);
    assert.notEqual(row.formxml, was);
    const b = await projectCommitted(w, DID);
    assert.equal(b.out.semanticSha256, a.group.proof.semanticSha256, 'the authored projection is unchanged');
    assert.notEqual(b.out.preservationSha256, a.group.proof.preservationSha256, 'the change outside the declaration is seen');
    assert.equal(b.certified, false);
    row.formxml = was;
  }
});

// On create the platform saves an empty caption on each tab and section the dashboard was sent without (the wire's
// `emptyContainerCaptions`). That caption is the platform's, not a change: the create settles and the projection certifies
// with it there or not. A caption the maker gives a tab, with text, is outside the declaration and is still seen.
test('the empty tab and section captions the platform adds on create are no change; a tab caption with text is', async () => {
  const w = await world({ platform: { emptyContainerCaptions: true } });
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases' }]);
  const out = await settle(w, d);
  assert.deepEqual(out.result, { committed: true, recovered: false });
  const row = w.wire.saved.get(out.id);
  const was = row.formxml;
  assert.match(was, /<tab\b[^>]*><labels><label description="" languagecode="1033" \/><\/labels>/);
  assert.match(was, /<section\b[^>]*><labels><label description="" languagecode="1033" \/><\/labels>/);
  const c = await projectCommitted(w, out.id);
  assert.equal(c.certified, true);
  // A proof an earlier build of this release committed hashed the layout with the empty captions kept; it still matches, and
  // only it or the current hash does.
  assert.notEqual(c.out.rawPreservationSha256, c.out.preservationSha256);
  assert.equal(preservationMatches(c.out, c.out.rawPreservationSha256), true);
  assert.equal(preservationMatches(c.out, c.group.proof.preservationSha256), true);
  assert.equal(preservationMatches(c.out, 'f'.repeat(64)), false);
  // The same dashboard read without the empty captions is the same dashboard.
  row.formxml = was.replace(/<labels><label description="" languagecode="1033" \/><\/labels>/g, '');
  assert.equal((await projectCommitted(w, out.id)).certified, true);
  // A tab caption with text, or a caption in a second attribute, is the maker's.
  for (const change of [
    (xml) => xml.replace(/(<tab\b[^>]*><labels><label description=")(")/, '$1Maker tab$2'),
    (xml) => xml.replace(/(<section\b[^>]*><labels><label description="" languagecode="1033")/, '$1 maker="yes"'),
  ]) {
    row.formxml = change(was);
    assert.notEqual(row.formxml, was);
    const b = await projectCommitted(w, out.id);
    assert.equal(b.out.semanticSha256, c.group.proof.semanticSha256, 'the authored projection is unchanged');
    assert.notEqual(b.out.preservationSha256, c.group.proof.preservationSha256, 'the change outside the declaration is seen');
    assert.equal(b.certified, false);
  }
  row.formxml = was;
});

// Someone's edit lands on the saved row after this build's send and before its proof reads it back: `change` rewrites the
// stored FormXML once, at the first saved-layer read after a write to the row. Answers whether it was applied.
function changeBetweenSendAndProof(w, change) {
  const state = { sent: false, injected: false };
  w.wire.script((e) => {
    if (e.method !== 'GET' && /^systemforms/i.test(e.path)) state.sent = true;
    if (state.sent && !state.injected && e.method === 'GET' && /RetrieveUnpublished/.test(e.path)) {
      const id = (/systemforms\(([^)]+)\)/i.exec(e.path) || [])[1];
      const row = id && w.wire.saved.get(id.toLowerCase());
      if (row) { const was = row.formxml; row.formxml = change(was); state.injected = row.formxml !== was; }
    }
    return false;
  }, {});
  return state;
}
const caption = (lcid, text) => `<label description="${text}" languagecode="${lcid}" />`;
const withTabCaption = (lcid, text) => (xml) => xml.replace(/(<tab\b[^>]*><labels>(?:<label [^>]*\/>)*)(<\/labels>)/, `$1${caption(lcid, text)}$2`);
const withCellCaption = (controlId, lcid, text) => (xml) => xml.replace(
  new RegExp(`(<cell\\b[^>]*><labels>(?:<label [^>]*\\/>)*)(<\\/labels><control\\b[^>]*\\bid="\\{${controlId}\\}")`, 'i'), `$1${caption(lcid, text)}$2`);
const TWO_LANGUAGES = { emptyContainerCaptions: true, secondLanguage: 3082 };
const refusedUnbound = async (w, d, name = '') => {
  assert.equal(await codeOf(settle(w, d)), 'create-completion-required', name);
  assert.equal(w.store.readGroup('dashboard', 'ops').committed, null, 'nothing is certified or bound');
  assert.equal(w.wire.publishes().length, 0, 'nothing is published');
};

// The proof holds the saved row as read, never the publication view (comparableSavedFormXml), which sets aside a caption
// in a language the published read does not return: a caption with text typed on a tab between the send and the proof
// is someone's edit in any language — the base one, the organization's second one (3082) or a third (1036).
for (const lcid of [1033, 3082, 1036]) {
  test(`a tab caption with text in language ${lcid}, typed between the send and the proof, is not certified, bound or published`, async () => {
    const w = await world({ platform: TWO_LANGUAGES });
    const state = changeBetweenSendAndProof(w, withTabCaption(lcid, 'Maker-owned tab'));
    await refusedUnbound(w, declared([{ key: 'open', type: 'list', view: 'Open cases' }]));
    assert.equal(state.injected, true);
  });
}

// The captions of the cell that holds control `controlId`, as [languagecode, description] pairs in document order.
function cellCaptions(xml, controlId) {
  const m = new RegExp(`<cell\\b[^>]*><labels>((?:<label [^>]*\\/>)*)<\\/labels><control\\b[^>]*\\bid="\\{${controlId}\\}"`, 'i').exec(xml);
  assert.ok(m, `a captioned cell holds ${controlId}`);
  return [...m[1].matchAll(/<label description="([^"]*)" languagecode="(\d+)" \/>/g)].map((x) => [Number(x[2]), x[1]]);
}
const tileIds = (w) => w.store.readGroup('dashboard', 'ops').committed.records.filter((r) => r.kind === 'dashboard-tile').map((r) => [r.key, r.id]);

// In an organization of more than one language the platform gives a new tile's cell, in each provisioned language it does
// not carry, a caption with text of its own (the wire's `secondLanguage`: "Platform caption", live "Work Orders" beside
// "By Priority"), which no rule could tell from a maker's. So the write sends each tile it creates with its caption in every
// provisioned language, each with the declared text: the platform has nothing to add, and the stored cell is what was sent.
test('a two-language create sends each new tile its caption in both languages; the stored row is what was sent, and it settles', async () => {
  const w = await world({ platform: TWO_LANGUAGES });
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', name: 'Authored tile' }, { key: 'all', type: 'list', view: 'All cases' }]);
  const out = await settle(w, d);
  assert.deepEqual(out.result, { committed: true, recovered: false });
  const xml = w.wire.saved.get(out.id).formxml;
  const names = { 'ops/open': 'Authored tile', 'ops/all': 'All cases' };
  for (const [key, id] of tileIds(w)) assert.deepEqual(cellCaptions(xml, id), [[1033, names[key]], [3082, names[key]]], key);
  assert.ok(!xml.includes('Platform caption'), 'the platform had no caption of its own to add');
  const sent = contentWrites(w.wire).map((e) => JSON.stringify(e.body)).join('\n');
  assert.match(sent, /Authored tile\\" languagecode=\\"3082\\"/, 'the caption in the second language is in the send itself');
  assert.equal((await projectCommitted(w, out.id)).certified, true);
});

// An adoption with an append: the appended tile gets its caption in both languages; the existing tiles keep the caption
// the platform gave them before (read with the dashboard, compared as read), and a caption typed on any cell after the send
// is refused.
test('a two-language adoption with an append sends the new tile its caption in both languages; a caption typed on any cell is refused', async () => {
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }, { key: 'mine', type: 'list', view: 'My cases' }], { dashboardId: DID });
  const w = await world({ platform: TWO_LANGUAGES });
  putExisting(w.wire);
  assert.deepEqual((await settle(w, d)).result, { committed: true, recovered: false });
  const xml = w.wire.saved.get(DID).formxml;
  const mine = tileIds(w).find(([key]) => key === 'ops/mine')[1];
  assert.deepEqual(cellCaptions(xml, mine), [[1033, 'My cases'], [3082, 'My cases']]);
  assert.deepEqual(cellCaptions(xml, C_FOREIGN), [[1033, 'Foreign'], [3082, 'Platform caption']], 'a foreign tile is as the platform keeps it');
  assert.deepEqual(cellCaptions(xml, C_OPEN), [[1033, 'Open now'], [3082, 'Platform caption']], 'the pinned tile: the SDK renames it in its own language only');
  for (const [target, lcid] of [[C_OPEN, 1036], [C_FOREIGN, 1036], [mine, 3082], [mine, 1036]]) {
    const v = await world({ platform: TWO_LANGUAGES });
    putExisting(v.wire);
    const state = changeBetweenSendAndProof(v, (x) => withCellCaption(target, lcid, 'Maker')(x));
    await refusedUnbound(v, d, `${target} ${lcid}`);
    assert.equal(state.injected, true, target);
  }
});

// Someone types on a new tile's caption between the send and the proof: whatever the language — the base one, the
// organization's second one, a third or two more — and whatever the shape, the stored cell is not the one sent, so it is
// not certified, bound or published. Nothing is set aside on a tile cell.
for (const [name, change] of [
  ['a second caption with text in the second language', (labels) => labels + caption(3082, 'Maker second')],
  ['the second-language caption sent, retyped', (labels) => labels.replace(caption(3082, 'Authored tile'), caption(3082, 'Maker second'))],
  ['a caption with text in a third language', (labels) => labels + caption(1036, 'Maker third')],
  ['captions in two more languages', (labels) => labels + caption(1036, 'Maker third') + caption(1041, 'Maker fourth')],
  ['a caption without a description', (labels) => `${labels}<label languagecode="1036" />`],
  ['the base-language caption retyped', (labels) => labels.replace(caption(1033, 'Authored tile'), caption(1033, 'Maker base'))],
]) {
  test(`a new tile's caption changed between the send and the proof is refused, nothing bound or published: ${name}`, async () => {
    const w = await world({ platform: TWO_LANGUAGES });
    const state = changeBetweenSendAndProof(w, (xml) => xml.replace(/(<cell\b[^>]*><labels>)((?:<label [^>]*\/>)*)(<\/labels>)/, (all, pre, labels, post) => pre + change(labels) + post));
    await refusedUnbound(w, declared([{ key: 'open', type: 'list', view: 'Open cases', name: 'Authored tile' }]), name);
    assert.equal(state.injected, true, name);
  });
}

// A recovery compares the stored row with the same model, captions in every language included.
test('a two-language append whose commit was lost is recovered over the captions it sent; a caption typed on the pinned tile meanwhile is refused', async () => {
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }, { key: 'mine', type: 'list', view: 'My cases' }], { dashboardId: DID });
  for (const typed of [null, withCellCaption(C_OPEN, 1036, 'Maker')]) {
    const { failing, deps } = failNextStoreWrite();
    const w = await world({ platform: TWO_LANGUAGES });
    w.store = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier: w.barrier, deps }).store;
    putExisting(w.wire);
    assert.ok(await codeOf(settle(w, d, { ensureMembership: async () => { failing.armed = true; } })), 'the commit failed');
    assert.equal(w.store.readGroup('dashboard', 'ops').committed, null);
    if (typed) {
      const row = w.wire.saved.get(DID);
      const was = row.formxml;
      row.formxml = typed(was);
      assert.notEqual(row.formxml, was, 'the stimulus applies');
    }
    const next = await rerun(w);
    if (!typed) {
      assert.deepEqual((await settle(next, d)).result, { committed: true, recovered: true });
      const mine = tileIds(next).find(([key]) => key === 'ops/mine')[1];
      assert.deepEqual(cellCaptions(w.wire.saved.get(DID).formxml, mine), [[1033, 'My cases'], [3082, 'My cases']]);
      continue;
    }
    assert.equal(await codeOf(settle(next, d)), 'create-completion-required');
    assert.equal(next.store.readGroup('dashboard', 'ops').committed, null);
    assert.equal(w.wire.publishes().length, 0);
  }
});

// The languages are read before a write that creates a tile; one that cannot be read stops the dashboard before anything
// is sent. A write that creates no tile does not need them.
test('a write that creates a tile stops before it is sent when the languages cannot be read; one that creates none goes on', async () => {
  for (const [name, provisionedLanguages] of [
    ['no reader', undefined], ['an unread answer', async () => null], ['an empty list', async () => []],
    ['a reader that throws', async () => { throw new Error('offline'); }], ['an unusable list', async () => ['es']],
  ]) {
    for (const existing of [false, true]) {
      const w = await world({ platform: TWO_LANGUAGES });
      if (existing) putExisting(w.wire);
      const d = existing
        ? declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }, { key: 'mine', type: 'list', view: 'My cases' }], { dashboardId: DID })
        : declared([{ key: 'open', type: 'list', view: 'Open cases' }]);
      assert.equal(await codeOf(settle(w, d, { provisionedLanguages })), 'dashboard-languages-unreadable', name);
      assert.equal(contentWrites(w.wire).length, 0, `${name}: nothing sent`);
      assert.equal(w.store.readGroup('dashboard', 'ops').committed, null);
    }
  }
  const w = await world({ platform: TWO_LANGUAGES });
  putExisting(w.wire);
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
  assert.deepEqual((await settle(w, d, { provisionedLanguages: async () => null })).result, { committed: true, recovered: false });
});

// In an organization of one language the send is the SDK's own, byte for byte: the hashes of the systemforms bodies of a
// create and of an adoption with an append are the ones the release before per-language captions sent.
test('a single-language create and append send exactly what they sent before per-language captions', async () => {
  const sha = (body) => require('node:crypto').createHash('sha256').update(typeof body === 'string' ? body : JSON.stringify(body)).digest('hex');
  const create = await world({ platform: { emptyContainerCaptions: true } });
  await settle(create, declared([{ key: 'open', type: 'list', view: 'Open cases' }, { key: 'all', type: 'list', view: 'All cases' }]));
  assert.deepEqual(contentWrites(create.wire).map((e) => `${e.method} ${sha(e.body)}`), ['POST fe8fc5a5b968b2d41ffd09e87f14d8990552cc99243f322c54de925f6c794160']);
  const append = await world({ platform: { emptyContainerCaptions: true } });
  putExisting(append.wire);
  await settle(append, declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }, { key: 'mine', type: 'list', view: 'My cases' }], { dashboardId: DID }));
  assert.deepEqual(contentWrites(append.wire).map((e) => `${e.method} ${sha(e.body)}`), ['PATCH 282ac6081ff826e574471500e4290b0c090f5baaf6c92081588f604ee8c70c58']);
});

// The empty caption the platform puts on a tab or section is set aside on EVERY tab and section, an existing dashboard's
// included: it carries no visible content. Here it appears on an adopted dashboard's existing tab between the send and the
// proof, and the adoption settles.
test('an empty caption on an existing tab, appearing between the send and the proof, is no change', async () => {
  const w = await world();
  putExisting(w.wire);
  const row = w.wire.saved.get(DID);
  row.formxml = row.formxml.replace(/(<tab\b[^>]*>)<labels>(?:<label [^>]*\/>)*<\/labels>/, '$1');
  w.wire.published.set(DID, { ...row });
  const state = changeBetweenSendAndProof(w, (xml) => xml.replace(/(<tab\b[^>]*>)/, '$1<labels><label description="" languagecode="1033" /></labels>'));
  const out = await settle(w, declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'New name' }], { dashboardId: DID }));
  assert.equal(state.injected, true);
  assert.deepEqual(out.result, { committed: true, recovered: false });
});
test('the shared projection refuses what the proof refuses: a table-scoped or non-Standard root, a duplicated seed', async () => {
  for (const [change, code] of [[{ objecttypecode: 'incident' }, 'dashboard-scope-unsupported'], [{ type: 10 }, 'dashboard-interactive-unsupported']]) {
    const w = await world();
    putExisting(w.wire);
    const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
    await settle(w, d);
    Object.assign(w.wire.saved.get(DID), change);
    const p = await projectCommitted(w, DID);
    assert.deepEqual(p.out.invalid, [code]);
    assert.equal(p.certified, false);
    assert.notEqual(p.out.semanticSha256, p.group.proof.semanticSha256, 'the root as read is in the hash');
    assert.equal(await codeOf(settle(await rerun(w), d)), code);
  }

  const w = await world();
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases' }]);
  const id = (await settle(w, d)).id;
  const row = w.wire.saved.get(id);
  const tab = row.formxml.match(/<tab\b[\s\S]*?<\/tab>/)[0];
  row.formxml = row.formxml.replace('</tabs>', tab.replace(/<rows>[\s\S]*?<\/rows>/g, '<rows />') + '</tabs>');
  const p = await projectCommitted(w, id);
  assert.deepEqual([p.out.invalid, p.out.missing], [['dashboard-seed-not-in-place'], ['seed']]);
  assert.equal(p.certified, false);
});

// A create acknowledged by its own answer whose commit then failed: the attempt stays pending, its root acknowledged.
async function strandedAttempt(w, d) {
  const { failing, deps } = failNextStoreWrite();
  w.store = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier: w.barrier, deps }).store;
  assert.equal(await codeOf(settle(w, d, { ensureMembership: async () => { failing.armed = true; } })), 'managed-binding-write-failed');
  const pending = w.store.readGroup('dashboard', 'ops').pending;
  assert.ok(pending);
  return pending;
}
const seedOf = (d, id) => {
  const { childIds } = catalogFor(d).reserveChildren('dashboard', 'ops', { actualRootId: id, children: [
    { locator: 'tab', childKind: 'dashboardSeedTab', keyParts: ['seed-tab'] }, { locator: 'section', childKind: 'dashboardSeedSection', keyParts: ['seed-section'] },
  ] });
  return [childIds.tab, childIds.section];
};

test('a created dashboard recovered after its commit failed: a foreign row or a duplicated seed added since stops it, nothing bound or published', async () => {
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases' }]);
  const changes = [
    ['', (xml) => xml],
    ['a foreign row after the tiles', (xml) => xml.replace('</rows>', `<row>${X.otherCustomControl(`{${C_FOREIGN}}`, 'NEW FOREIGN TILE', 'dddddddd-0000-4000-8000-000000000001')}</row></rows>`)],
    // Before the tiles, so the planned tiles are still the trailing cells: only the seed-only rule sees it.
    ['a foreign row before the tiles', (xml) => xml.replace(/<rows>/, `<rows><row>${X.otherCustomControl(`{${C_FOREIGN}}`, 'NEW FOREIGN TILE', 'dddddddd-0000-4000-8000-000000000001')}</row>`)],
    ['a duplicated seed tab', (xml) => xml.replace('</tabs>', xml.match(/<tab\b[\s\S]*?<\/tab>/)[0].replace(/<rows>[\s\S]*?<\/rows>/g, '<rows />') + '</tabs>')],
  ];
  for (const [what, change] of changes) {
    const w = await world();
    const pending = await strandedAttempt(w, d);
    assert.equal(pending.acknowledgedRoot, true, 'the create was acknowledged by its own answer');
    const id = pending.root.id;
    const row = w.wire.saved.get(id);
    const before = row.formxml;
    row.formxml = change(before);
    if (what) assert.notEqual(row.formxml, before, `the stimulus applies: ${what}`);
    const next = await rerun(w);
    const managed = pending.expected.children.map(({ key, id: cid }) => ({ key, id: cid }));
    const p = projectDashboard(await freshRead(next, id), { managed, seedIds: seedOf(d, id), languageCode: next.sdk.languageCode });
    if (!what) {
      assert.deepEqual([p.invalid, p.missing, p.duplicated], [[], [], []]);
      assert.deepEqual((await settle(next, d, { approvals: {} })).result, { committed: true, recovered: true }, 'the control: an untouched create is bound');
      continue;
    }
    assert.equal(await codeOf(settle(next, d, { approvals: {} })), 'create-completion-required', what);
    assert.equal(next.store.readGroup('dashboard', 'ops').committed, null, what);
    assert.equal(await codeOf(publish(next, 'ops', id)), 'managed-settlement-pending', what);
    assert.equal(w.wire.publishes(id).length, 0, what);
    if (what === 'a duplicated seed tab') assert.deepEqual([p.invalid, p.missing], [['dashboard-seed-not-in-place'], ['seed']]);
  }
});

test('a commit lost after the save, then the managed rows reordered or the appended tiles swapped: nothing bound or published', async () => {
  // Reordering two trailing managed rows that were there before the send.
  const OTHER_CONTROL = 'c1c1c1c1-0000-4000-8000-000000000003';
  let w = await world();
  w.wire.putForm({ formid: DID, name: 'Ops', description: 'Cases', type: 0, objecttypecode: 'none', formxml: X.dashboardXml([
    [X.otherCustomControl(`{${C_FOREIGN}}`, 'Foreign', 'dddddddd-0000-4000-8000-000000000001')],
    [X.nativeGrid(`{${C_OPEN}}`, 'Open cases', OPEN)],
    [X.nativeGrid(`{${OTHER_CONTROL}}`, 'All cases', ALL)],
  ]), istabletenabled: false }, { publishedToo: true });
  let d = declared([
    { key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' },
    { key: 'all', type: 'list', view: 'All cases', componentId: OTHER_CONTROL },
  ], { dashboardId: DID });
  await strandedAttempt(w, d);
  let row = w.wire.saved.get(DID);
  const rows = row.formxml.match(/<row>[\s\S]*?<\/row>/g);
  assert.equal(rows.length, 3);
  row.formxml = row.formxml.replace(rows.join(''), [rows[0], rows[2], rows[1]].join(''));
  let next = await rerun(w);
  assert.equal(await codeOf(settle(next, d)), 'create-completion-required');
  assert.equal(w.wire.publishes(DID).length, 0);

  // Two tiles appended to a maker's dashboard, then swapped: the cut of the append binds their order. The control
  // (unswapped) is bound.
  for (const swap of [false, true]) {
    w = await world();
    putExisting(w.wire);
    d = declared([
      { key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN },
      { key: 'all', type: 'list', view: 'All cases' }, { key: 'mine', type: 'list', view: 'My cases' },
    ], { dashboardId: DID });
    const pending = await strandedAttempt(w, d);
    const [cAll, cMine] = ['ops/all', 'ops/mine'].map((k) => pending.expected.children.find((c) => c.key === k).id);
    row = w.wire.saved.get(DID);
    const cells = row.formxml.match(/<cell\b[\s\S]*?<\/cell>/g);
    const cellOf = (cid) => cells.find((x) => x.toLowerCase().includes(cid));
    assert.ok(cellOf(cAll) && cellOf(cMine), 'both tiles were appended');
    if (swap) row.formxml = row.formxml.replace(cellOf(cAll), '\u0000').replace(cellOf(cMine), cellOf(cAll)).replace('\u0000', cellOf(cMine));
    next = await rerun(w);
    if (!swap) {
      assert.deepEqual((await settle(next, d)).result, { committed: true, recovered: true });
      continue;
    }
    assert.equal(await codeOf(settle(next, d)), 'create-completion-required');
    assert.equal(w.wire.publishes(DID).length, 0);
  }
});

test('the proof and the publication hash are one saved snapshot: a change between the two reads stops the settle', async () => {
  // After this run's own write: the proof's SDK read and the publication read straddle someone's edit.
  for (const afterWrite of [true, false]) {
    const w = await world();
    putExisting(w.wire);
    let ownWrite = false;
    let injected = false;
    w.wire.script((e) => {
      if ((e.method === 'PATCH' || e.method === 'POST') && /^systemforms/.test(e.path)) ownWrite = true;
      const u = new URL(e.url);
      if ((ownWrite || !afterWrite) && !injected && e.method === 'GET' && /RetrieveUnpublished/.test(e.path) && PUBLICATION_SELECTS.has(u.searchParams.get('$select'))) {
        const row = w.wire.saved.get(DID);
        row.formxml = row.formxml.replace('<RecordsPerPage>8</RecordsPerPage>', '<RecordsPerPage>42</RecordsPerPage>');
        injected = true;
      }
      return false;
    }, {});
    const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
    const code = await codeOf(settle(w, d));
    assert.equal(injected, true, 'the edit lands between the SDK read and the publication read');
    if (afterWrite) {
      assert.equal(code, 'create-completion-required', 'publication authority is never granted for a saved row the proof did not project');
    } else {
      assert.equal(code, 'dashboard-unreadable', 'the plan is never built across two snapshots');
      assert.equal(contentWrites(w.wire).length, 0, 'nothing was sent');
    }
    assert.equal(w.store.readGroup('dashboard', 'ops').committed, null);
    await w.sdk.publishArtifact('dashboard', DID).catch(() => undefined);
    assert.equal(w.wire.publishes(DID).length, 0);
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

// What the plan models the send to store (the SDK's own serializer and reader) is the whole of what the proof holds the
// stored row to: a non-authored attribute of a cell the send appended, or of the seed a create wrote, that differs
// after the send is someone's edit, and is never bound or published.
const toggleShowlabel = (tag) => (/\bshowlabel="/.test(tag)
  ? tag.replace(/\bshowlabel="([^"]*)"/, (_, value) => `showlabel="${value === 'true' ? 'false' : 'true'}"`)
  : tag.replace(/>$/, ' showlabel="true">'));
for (const created of [false, true]) {
  test(`a non-authored attribute changed after the send on a newly ${created ? 'created' : 'appended'} tile's cell stops the recovery; nothing bound or published`, async () => {
    const w = await world();
    if (!created) putExisting(w.wire);
    const d = created
      ? declared([{ key: 'all', type: 'list', view: 'All cases' }])
      : declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN }, { key: 'all', type: 'list', view: 'All cases' }], { dashboardId: DID });
    const pending = await strandedAttempt(w, d);
    const id = pending.root.id;
    const childId = pending.expected.children.find((c) => c.key === 'ops/all').id;
    const row = w.wire.saved.get(id);
    const cell = row.formxml.match(/<cell\b[\s\S]*?<\/cell>/g).find((c) => c.toLowerCase().includes(childId));
    const changed = cell.replace(/<cell\b[^>]*>/, toggleShowlabel);
    assert.notEqual(changed, cell);
    row.formxml = row.formxml.replace(cell, changed);
    const next = await rerun(w);
    assert.equal(await codeOf(settle(next, d)), 'create-completion-required', 'the appended cell is proved whole, not only its id and parameters');
    assert.equal(next.store.readGroup('dashboard', 'ops').committed, null);
    await publish(next, 'ops', id).catch(() => undefined);
    assert.equal(w.wire.publishes(id).length, 0);
  });
}

test('a changed attribute of the catalog seed tab after a create stops the recovery: the seed is proved whole, not only its shape', async () => {
  const w = await world();
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases' }]);
  const pending = await strandedAttempt(w, d);
  const id = pending.root.id;
  const row = w.wire.saved.get(id);
  const oldTag = row.formxml.match(/<tab\b[^>]*>/)[0];
  const newTag = toggleShowlabel(oldTag);
  assert.notEqual(newTag, oldTag);
  row.formxml = row.formxml.replace(oldTag, newTag);
  const next = await rerun(w);
  assert.equal(await codeOf(settle(next, d)), 'create-completion-required');
  assert.equal(next.store.readGroup('dashboard', 'ops').committed, null);
  await publish(next, 'ops', id).catch(() => undefined);
  assert.equal(w.wire.publishes(id).length, 0);
});

test('an append into an existing empty section commits, and an append the SDK would reshape is refused before any write', async () => {
  // `<rows></rows>`: the SDK's parser marks it empty; the append fills it and the marker goes. That is the append itself.
  const w = await world();
  w.wire.putForm({ formid: DID, name: 'Ops', description: 'Cases', type: 0, objecttypecode: 'none', formxml: X.dashboardXml([]) }, { publishedToo: true });
  const d = declared([{ key: 'all', type: 'list', view: 'All cases' }], { dashboardId: DID });
  assert.equal(await codeOf(settle(w, d)), null, 'the append into an empty section is proved and bound');
  assert.equal(contentWrites(w.wire).length, 1);
  assert.ok(w.wire.saved.get(DID).formxml.includes(ALL));
  assert.ok(w.store.readGroup('dashboard', 'ops').committed);
  assert.equal((await projectCommitted(w, DID)).certified, true, 'verify and hydrate certify what the proof bound');

  // A row with no control: the SDK drops it when it appends, so the append would lose the maker's row.
  const e = await world();
  e.wire.putForm({ formid: DID, name: 'Ops', description: 'Cases', type: 0, objecttypecode: 'none', formxml: X.dashboardXml([[]]) }, { publishedToo: true });
  assert.equal(await codeOf(settle(e, d)), 'dashboard-layout-unsupported');
  assert.equal(contentWrites(e.wire).length, 0, 'refused before the send, never stranded after it');
});

test('the root type and table come from the same saved read as the content: a type or table change between the proof reads stops the settle', async () => {
  for (const change of [{ objecttypecode: 'incident' }, { type: 10 }]) {
    const w = await world();
    putExisting(w.wire);
    let written = false;
    let injected = false;
    w.wire.script((e) => {
      if (e.method === 'PATCH' && /^systemforms/.test(e.path)) written = true;
      if (written && !injected && e.method === 'GET' && /RetrieveUnpublished/.test(e.path) && PUBLICATION_SELECTS.has(new URL(e.url).searchParams.get('$select'))) {
        Object.assign(w.wire.saved.get(DID), change);
        injected = true;
      }
      return false;
    }, {});
    const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
    const code = await codeOf(settle(w, d));
    assert.equal(injected, true, 'the change lands between the SDK read and the publication read');
    assert.equal(code, 'dashboard-stored-mismatch', 'the root is judged on the saved row the publication hash is of');
    assert.equal(w.store.readGroup('dashboard', 'ops').committed, null);
    await publish(w, 'ops', DID).catch(() => undefined);
    assert.equal(w.wire.publishes(DID).length, 0);
  }
});

// The SDK writes a renamed tile's name to the label of its own language and, when the cell has none, ADDS one, keeping
// every other label: the cell's fallback-language label stays, and is proved.
test('a tile rename commits whether or not the cell has a label in the SDK language, and every other label is kept', async () => {
  for (const [lcid, labels, kept] of [
    [1036, '<label description="English" languagecode="1033" /><label description="Francais" languagecode="1036" />', 'description="English"'],
    [1033, '<label description="Francais" languagecode="1036" />', 'description="Francais"'],
  ]) {
    const w = await world();
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(makeTempDir('dash-lang-')), instanceUrl: ENV, languageCode: lcid, httpClient: clientOver(w.wire, { barrier: w.barrier, observer: w.observer }) });
    await sdk.initWorkspace();
    assert.equal(sdk.languageCode, lcid);
    w.sdk = sdk;
    putExisting(w.wire);
    for (const layer of [w.wire.saved, w.wire.published]) {
      const row = layer.get(DID);
      row.formxml = row.formxml.replace(/(<cell\b[^>]*>)<labels>[\s\S]*?<\/labels>/, `$1<labels>${labels}</labels>`);
    }
    const d = declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
    assert.equal(await codeOf(settle(w, d)), null, `LCID ${lcid}: the SDK's own name write is recognized`);
    const cell = w.wire.saved.get(DID).formxml.match(/<cell\b[\s\S]*?<\/cell>/)[0];
    assert.ok(cell.includes(kept), 'the other-language label is kept');
    assert.ok(cell.includes('description="Open now"'));
    const c = await projectCommitted(w, DID);
    assert.equal(c.certified, true, 'verify and hydrate reproduce the proof');
    if (lcid === 1036) {
      const wrong = projectDashboard(await freshRead(w, DID), { ...c.input, languageCode: 1033 });
      assert.notEqual(wrong.preservationSha256, c.group.proof.preservationSha256, 'another language cannot certify this proof');
    }
  }
});
test('a send the SDK would not store as declared is refused before it is sent: a span wider than the seed section on a create', async () => {
  // The catalog seed's section has 2 columns, and the SDK clamps an appended cell's colspan to them.
  const w = await world();
  const d = declared([{ key: 'open', type: 'list', view: 'Open cases', colspan: 3 }]);
  assert.equal(await codeOf(settle(w, d)), 'dashboard-layout-unsupported');
  assert.equal(contentWrites(w.wire).length, 0, 'nothing sent, nothing stranded');
  const g = w.store.readGroup('dashboard', 'ops');
  assert.deepEqual([g.committed, g.pending], [null, null], 'no attempt was opened');
});

// The dashboard row's name is part of what the proof binds. A create proves the name it was created with; an existing
// dashboard keeps its live name, which the spec's name only looked up. A rename landing after the send is never
// certified as this build's change, nor published.
const existingOps = () => declared([{ key: 'open', type: 'list', view: 'Open cases', componentId: C_OPEN, name: 'Open now' }], { dashboardId: DID });
for (const created of [false, true]) {
  test(`a commit lost after the save, then the ${created ? 'created' : 'existing'} dashboard renamed: nothing bound or published`, async () => {
    const w = await world();
    if (!created) putExisting(w.wire);
    const d = created ? declared([{ key: 'open', type: 'list', view: 'Open cases' }]) : existingOps();
    const pending = await strandedAttempt(w, d);
    const id = pending.root.id;
    assert.equal(w.wire.saved.get(id).name, 'Ops');
    w.wire.saved.get(id).name = 'MAKER TITLE AFTER THE SEND';
    const next = await rerun(w);
    assert.equal(await codeOf(settle(next, d)), 'create-completion-required');
    const g = next.store.readGroup('dashboard', 'ops');
    assert.equal(g.committed, null);
    assert.ok(g.pending, 'the attempt and its proof are kept');
    await publish(next, 'ops', id).catch(() => undefined);
    assert.equal(w.wire.publishes(id).length, 0);
  });
}

test('a dashboard renamed between the proof reads is not bound or published; a live name the spec does not use is kept', async () => {
  const w = await world();
  putExisting(w.wire);
  let written = false;
  let injected = false;
  w.wire.script((e) => {
    if (e.method === 'PATCH' && /^systemforms/.test(e.path)) written = true;
    if (written && !injected && e.method === 'GET' && /RetrieveUnpublished/.test(e.path) && PUBLICATION_SELECTS.has(new URL(e.url).searchParams.get('$select'))) {
      w.wire.saved.get(DID).name = 'MAKER TITLE DURING PROOF';
      injected = true;
    }
    return false;
  }, {});
  assert.equal(await codeOf(settle(w, existingOps())), 'create-completion-required');
  assert.equal(injected, true, 'the rename lands between the SDK read and the publication read');
  assert.equal(w.store.readGroup('dashboard', 'ops').committed, null);
  await publish(w, 'ops', DID).catch(() => undefined);
  assert.equal(w.wire.publishes(DID).length, 0);

  // The spec's name finds a dashboard; it does not rename one: a pinned dashboard with another live name commits with it.
  const k = await world();
  putExisting(k.wire);
  for (const layer of [k.wire.saved, k.wire.published]) layer.get(DID).name = 'Operations board';
  assert.equal(await codeOf(settle(k, existingOps())), null);
  assert.equal(k.wire.saved.get(DID).name, 'Operations board');
  assert.equal((await projectCommitted(k, DID)).certified, true);
});

test('the shared projection does not certify a dashboard renamed after its commit', async () => {
  const w = await world();
  const id = (await settle(w, declared([{ key: 'open', type: 'list', view: 'Open cases' }]))).id;
  await publish(w, 'ops', id);
  assert.equal((await projectCommitted(w, id)).certified, true);
  w.wire.saved.get(id).name = 'MAKER TITLE AFTER COMMIT';
  const p = await projectCommitted(w, id);
  assert.equal(p.out.preservationSha256, p.group.proof.preservationSha256, 'the layout is unchanged');
  assert.notEqual(p.out.semanticSha256, p.group.proof.semanticSha256, 'the name as read is in the hash');
  assert.equal(p.certified, false);
});

// The group's originalDeclaration — the declaration its attempt recorded before the send — is the one authority:
// committedDeclaration and the no-op check read it, never a declaration copy in the consumer state.
const rewriteGroup = (w, mutate) => {
  const data = JSON.parse(fs.readFileSync(w.store.file, 'utf8'));
  mutate(data.groups.find((g) => g.family === 'dashboard' && g.key === 'ops'));
  fs.writeFileSync(w.store.file, JSON.stringify(data, null, 2));
};
test('the committed declaration is read from the group\'s original declaration, never from a copy in the consumer state', async () => {
  const d = existingOps();
  const stale = canonicalDeclaration({ ...d, description: 'A STALE COPY' });

  const w = await world();
  putExisting(w.wire);
  await settle(w, d);
  rewriteGroup(w, (g) => { g.consumerState.declaration = stale; });
  const next = await rerun(w);
  const group = next.store.readGroup('dashboard', 'ops').committed;
  assert.deepEqual(group.consumerState.declaration, stale, 'the two differ on disk');
  assert.deepEqual(committedDeclaration(group), canonicalDeclaration(d), 'read from originalDeclaration');
  assert.deepEqual((await settle(next, d)).result, { noop: true }, 'the no-op check compares the original declaration');

  const k = await world();
  putExisting(k.wire);
  await settle(k, d);
  rewriteGroup(k, (g) => { g.originalDeclaration = stale; g.consumerState.declaration = canonicalDeclaration(d); });
  const again = await rerun(k);
  assert.deepEqual(committedDeclaration(again.store.readGroup('dashboard', 'ops').committed), stale);
  const writes = contentWrites(k.wire).length;
  assert.equal((await settle(again, d)).result.committed, true, 'a differing original declaration is rebound, whatever the copy says');
  assert.equal(contentWrites(k.wire).length, writes, 'without a content write');
  assert.deepEqual(committedDeclaration(again.store.readGroup('dashboard', 'ops').committed), canonicalDeclaration(d));
});

test('the declaration is not copied into the consumer state: an authored URL on the environment\'s own host commits and reads back', async () => {
  const w = await world();
  const url = 'https://contoso.crm.dynamics.com/WebResources/contoso_/report.htm?mode=summary';
  const d = declared([{ key: 'frame', type: 'iframe', url, name: 'Report' }]);
  assert.equal(await codeOf(settle(w, d)), null, 'committed after its send, not stranded');
  const group = w.store.readGroup('dashboard', 'ops').committed;
  assert.equal('declaration' in group.consumerState, false, 'the consumer state keeps only what was proved');
  assert.equal(committedDeclaration(group).tiles[0].url, url);
});

test('a recovery whose recorded declaration no longer hashes to the attempt\'s declaration hash is refused: nothing is bound or published', async () => {
  const { w, d } = await crashedAfterSave();
  const data = JSON.parse(fs.readFileSync(w.store.file, 'utf8'));
  const attempt = data.attempts.find((a) => a.family === 'dashboard' && a.key === 'ops');
  attempt.declaration = canonicalDeclaration({ ...d, description: 'NOT THE DECLARATION IT WAS PLANNED WITH' });
  fs.writeFileSync(w.store.file, JSON.stringify(data, null, 2));
  const next = await rerun(w);
  assert.equal(await codeOf(settle(next, d)), 'create-completion-required');
  assert.equal(next.store.readGroup('dashboard', 'ops').committed, null, 'nothing was bound');
  assert.equal(w.wire.publishes(DID).length, 0, 'nothing was published');
});

// A dashboard's binding is settled for its original declaration and nothing else restores it: a committed group or an
// attempt that lacks it is refused before anything is read, sent, committed or published; nothing is migrated.
const failureOf = async (p) => { try { await p; } catch (e) { return e; } return null; };
const categoryOf = (e) => e && ((e.cause && e.cause.category) || e.category);

test('missing authority: a committed group without its original declaration is refused, not rebuilt from today\'s spec', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = existingOps();
  await settle(w, d);
  rewriteGroup(w, (g) => { delete g.originalDeclaration; g.consumerState.declaration = canonicalDeclaration(d); });
  const next = await rerun(w);
  assert.equal(committedDeclaration(next.store.readGroup('dashboard', 'ops').committed), null, 'a consumer-state copy is not the original');
  const before = fs.readFileSync(w.store.file, 'utf8');
  const writes = w.wire.writes().length;
  const requests = w.wire.log.length;
  const err = await failureOf(settle(next, d, { approvals: {} }));
  assert.equal(err && err.code, 'create-completion-required');
  assert.equal(categoryOf(err), 'dashboard-declaration-missing');
  assert.equal(w.wire.log.length, requests, 'refused before anything is read');
  assert.equal(fs.readFileSync(w.store.file, 'utf8'), before, 'the binding store is unchanged');
  assert.equal(w.wire.writes().length, writes, 'nothing sent');
});

test('missing authority: an interrupted attempt without its recorded declaration is neither committed nor published, and stays pending', async () => {
  const { w, d } = await crashedAfterSave();
  const data = JSON.parse(fs.readFileSync(w.store.file, 'utf8'));
  delete data.attempts.find((a) => a.family === 'dashboard' && a.key === 'ops').declaration;
  fs.writeFileSync(w.store.file, JSON.stringify(data, null, 2));
  const next = await rerun(w);
  const token = next.store.readGroup('dashboard', 'ops').pending.token;
  const before = fs.readFileSync(w.store.file, 'utf8');
  const writes = w.wire.writes().length;
  const requests = w.wire.log.length;
  const err = await failureOf(settle(next, { ...d, description: 'TODAY IS NOT THE LOST INPUT' }));
  assert.equal(err && err.code, 'create-completion-required');
  assert.equal(categoryOf(err), 'dashboard-declaration-missing');
  assert.equal(w.wire.log.length, requests, 'refused before anything is read');
  assert.equal(fs.readFileSync(w.store.file, 'utf8'), before, 'the binding store is unchanged');
  const g = next.store.readGroup('dashboard', 'ops');
  assert.equal(g.committed, null, 'nothing was bound');
  assert.equal(g.pending.token, token, 'the attempt and its token are kept');
  assert.notEqual(await codeOf(publish(next, 'ops', DID)), null, 'its publish is refused');
  assert.equal(w.wire.writes().length, writes, 'nothing sent');
  assert.equal(w.wire.publishes(DID).length, 0);
});

test('missing authority: the publication adapter refuses a committed group without its original declaration and sends nothing', async () => {
  const w = await world();
  putExisting(w.wire);
  await settle(w, existingOps());
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'owed', 'its own write is owed a publish');
  rewriteGroup(w, (g) => { delete g.originalDeclaration; });
  const next = await rerun(w);
  const err = await failureOf(publish(next, 'ops', DID));
  assert.equal(categoryOf(err), 'dashboard-declaration-missing');
  assert.equal(w.wire.publishes(DID).length, 0);
  assert.equal(next.barrier.checkAppWrite({ existingApp: true, held: [], heldDashboards: [DID] }).ok, false, 'the scope stays fenced for the run');
});

// A publish an earlier run may have sent is confirmed read-only by the settlement itself (its client and the
// registered layer readers) before a requested change is prepared, so the run can proceed without resending it.
test('debt: a requested change first confirms a completed earlier publication read-only, then writes once and never republishes', async () => {
  const { failing, deps } = failNextStoreWrite();
  const w = await world();
  w.store = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier: w.barrier, deps }).store;
  putExisting(w.wire);
  const d = existingOps();
  await settle(w, d);
  const sdk = Object.create(w.sdk);
  sdk.publishArtifact = async (...a) => { const answer = await w.sdk.publishArtifact(...a); failing.armed = true; return answer; };
  assert.notEqual(await codeOf(publishDeclaredDashboard({ store: w.store, barrier: w.barrier, sdk, key: 'ops', id: DID })), null, 'the confirmation write failed after the publish');
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'dispatching');
  const before = contentWrites(w.wire).length;
  const next = await rerun(w);
  const out = await settle(next, { ...d, description: 'New declaration after the completed publication' });
  assert.equal(out.result.committed, true);
  assert.equal(contentWrites(w.wire).length, before + 1, 'one PATCH for the requested change');
  assert.equal(contentWrites(w.wire).slice(-1)[0].method, 'PATCH');
  assert.equal(w.wire.publishes(DID).length, 1, 'the earlier publish is not repeated');
});

test('carry: a lost answer to a scope publish that only carried the dashboard stops a requested change, and nothing is sent', async () => {
  const w = await world();
  putExisting(w.wire);
  const d = existingOps();
  await settle(w, d);
  await publish(w, 'ops', DID);
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'confirmed');
  const carrying = await rerun(w);
  w.wire.script((e) => e.method === 'POST' && /^PublishXml$/.test(e.path), { statusCode: 503, body: { error: { code: '0x80040216', message: 'gateway' } }, unapplied: true });
  const carried = await codeOf(publishManagedScope({
    store: carrying.store, barrier: carrying.barrier, client: carrying.sdk.dataverse, scope: { type: 'dashboard', id: DID }, groups: [], carry: true,
    publish: async () => {
      await carrying.sdk.fetchArtifact('dashboard', DID);
      const answer = await carrying.sdk.publishArtifact('dashboard', DID);
      // The SDK answers a failed publish as data; a carry callback must propagate it.
      if (answer.publish && answer.publish.kind === 'failed') throw answer.publish.error;
    },
  }));
  assert.equal(carried, 'managed-publication-unconfirmed');
  const next = await rerun(w);
  const writes = w.wire.writes().length;
  const refused = await failureOf(settle(next, { ...d, description: 'Not over the carried send' }));
  assert.equal(refused && refused.code, 'managed-publication-unconfirmed');
  assert.equal(w.wire.writes().length, writes, 'nothing sent');
  // What the wiring shows the maker comes from these fields, never from the message: on the settle's halt they are on
  // its cause; the publication adapter's own refusal carries them itself.
  const approval = `publication-risk:dashboard:${DID}`;
  assert.equal(refused.cause.approval, approval);
  assert.ok(refused.cause.dispatchToken && refused.cause.remedy);
  const direct = await failureOf(publish(await rerun(w), 'ops', DID));
  assert.equal(direct && direct.code, 'managed-publication-unconfirmed');
  assert.deepEqual([direct.approval, direct.dispatchToken, direct.remedy], [approval, refused.cause.dispatchToken, refused.cause.remedy]);
  assert.equal(w.wire.writes().length, writes, 'nothing sent');
});

// The SDK answers a failed publish by value, not by a throw:
//   { type: 'dashboard', id, shipped: false, publish: { kind: 'failed', error } }
// A 503 can come back after the service applied the PublishXml, so the adapter must not read that answer as a
// success (the helper would then confirm the layers and admit the app) nor as a request that never started.
const failPublishXml = (wire, { applied }) => wire.script((e) => e.method === 'POST' && /^PublishXml$/.test(e.path),
  { statusCode: 503, body: { error: { code: '0x80040216', message: 'gateway' } }, unapplied: !applied });
const causes = (e) => { const chain = []; for (let c = e; c && chain.length < 8; c = c.cause) chain.push(c); return chain; };
const admitted = (w) => w.barrier.checkAppWrite({ existingApp: true, held: [], heldDashboards: [DID] }).ok;

for (const applied of [false, true]) {
  test(`a publish the SDK answers as failed stays unconfirmed and fenced, with the SDK error kept (the service ${applied ? 'applied' : 'did not apply'} it)`, async () => {
    const first = await world();
    putExisting(first.wire);
    await settle(first, existingOps());
    assert.equal(first.store.readGroup('dashboard', 'ops').committed.publication.state, 'owed');
    const w = await rerun(first);
    failPublishXml(w.wire, { applied });
    let answer;
    const sdk = Object.create(w.sdk);
    sdk.publishArtifact = async (...a) => { answer = await w.sdk.publishArtifact(...a); return answer; };
    const err = await failureOf(publishDeclaredDashboard({ store: w.store, barrier: w.barrier, sdk, key: 'ops', id: DID }));
    assert.equal(answer.shipped, false);
    assert.equal(answer.publish.kind, 'failed');
    assert.equal(err && err.code, 'managed-publication-unconfirmed', 'a failed SDK answer is not a publish success');
    assert.ok(causes(err).includes(answer.publish.error), 'the SDK error stays in the cause chain');
    assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'unconfirmed', 'not recorded as confirmed, nor as a publish that never started');
    assert.equal(admitted(w), false, 'the app is not admitted over it');
    assert.equal(w.wire.publishes(DID).length, 1);
    if (applied) {
      const next = await rerun(w);
      assert.equal((await publish(next, 'ops', DID)).sent, false, 'a later read settles the changed layer without a resend');
      assert.equal(next.store.readGroup('dashboard', 'ops').committed.publication.state, 'confirmed');
      assert.equal(w.wire.publishes(DID).length, 1);
    }
  });
}

test('a failed SDK answer returned to the scope publication is refused there as unconfirmed, never confirmed', async () => {
  const first = await world();
  putExisting(first.wire);
  await settle(first, existingOps());
  const w = await rerun(first);
  failPublishXml(w.wire, { applied: true });
  const code = await codeOf(publishManagedScope({
    store: w.store, barrier: w.barrier, client: w.sdk.dataverse, scope: { type: 'dashboard', id: DID }, groups: [{ family: 'dashboard', key: 'ops' }],
    publish: async () => { await w.sdk.fetchArtifact('dashboard', DID); return w.sdk.publishArtifact('dashboard', DID); },
  }));
  assert.equal(code, 'managed-publication-unconfirmed');
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'unconfirmed');
  assert.equal(admitted(w), false);
});

test('an SDK answer the adapter does not know is handed to the scope publication unchanged, which keeps it unconfirmed', async () => {
  const first = await world();
  putExisting(first.wire);
  await settle(first, existingOps());
  const w = await rerun(first);
  let answer;
  const sdk = Object.create(w.sdk);
  sdk.publishArtifact = async (...a) => {
    const real = await w.sdk.publishArtifact(...a);
    answer = { ...real, publish: { kind: 'deferred' } };
    return answer;
  };
  const err = await failureOf(publishDeclaredDashboard({ store: w.store, barrier: w.barrier, sdk, key: 'ops', id: DID }));
  assert.equal(err && err.code, 'managed-publication-unconfirmed');
  assert.ok(causes(err).some((c) => c.answer === answer), 'the scope publication judged the SDK answer itself');
  assert.equal(w.store.readGroup('dashboard', 'ops').committed.publication.state, 'unconfirmed');
  assert.equal(admitted(w), false);
  assert.equal(w.wire.publishes(DID).length, 1);
});

// The store reserves room for an attempt's completion before its send, and a completion that outgrows the reservation
// can be refused after the change is saved. A large dashboard (about 1.2 KiB per tile) outgrows the store's default,
// so the plan must ask for enough: every store write from the send to the commit has to fit in what was reserved.
test('a dashboard with hundreds of tiles reserves, before its send, every byte its completion adds to the binding store', async () => {
  const writes = [];
  const deps = { writeFileAtomic: (p, text) => { writes.push(text); return writeFileAtomic(p, text); } };
  const w = await world();
  w.store = openManagedContext({ workspaceDir: w.dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier: w.barrier, deps }).store;
  const tiles = Array.from({ length: 300 }, (_, i) => ({ key: `tile_${i}`, type: 'iframe', url: `https://contoso.example/report/${i}`, name: `Report ${i}` }));
  const out = await settle(w, declared(tiles));
  assert.equal(out.result.committed, true);
  const attemptOf = (text) => (JSON.parse(text).attempts || []).find((a) => a.family === 'dashboard');
  const sending = writes.findIndex((text) => { const a = attemptOf(text); return a && a.phase === 'sending'; });
  assert.ok(sending > 0, 'the attempt was prepared, then marked sending');
  const before = Buffer.byteLength(writes[sending - 1], 'utf8');
  const growth = Math.max(...writes.slice(sending).map((text) => Buffer.byteLength(text, 'utf8'))) - before;
  const reserved = attemptOf(writes[sending]).completionReserve.bytes;
  assert.ok(growth > 300 * 1024, `the completion is large enough to matter (${growth} bytes)`);
  assert.ok(reserved >= growth, `reserved ${reserved} bytes for a completion that adds ${growth}`);
  assert.equal(attemptOf(writes[writes.length - 1]), undefined, 'committed: no attempt left');
});
