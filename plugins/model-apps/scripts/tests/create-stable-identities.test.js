'use strict';
// Stable create identities (`createIdentity: "stable-v1"`) for declared views and charts, through the real engine
// (lib/sdk-build.js runSdkBuild), the real vendored SDK and the fake Dataverse org: the create is sent with the id the spec
// derives, the binding is kept in the managed binding store, and a rerun from the same or a fresh workspace binds that row
// instead of creating a second one. A spec without the field builds exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { validateAppSpec, CREATE_IDENTITY_STABLE } = require('../lib/app-spec.js');
const { lintAppSpec } = require('../lib/spec-lint.js');
const { ACTIVATION_VALUE } = require('../lib/creates-identity.js');
const { createStableCreates } = require('../lib/creates-stable-build.js');
const { createPassthroughCreates } = require('../lib/creates-passthrough.js');
const { openManagedBindings, PREFIX } = require('../lib/managed-bindings.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { buildModelApp } = require('../build-model-app.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ENTITIES = { contoso_item: { attributes: { contoso_name: 'String', contoso_code: 'String', contoso_kind: 'Picklist' } } };
const SOLUTION = 'ContosoStable';
const APP = 'contoso_stableids';

function makeSpec(extra = {}) {
  return {
    solution: { uniqueName: SOLUTION, displayName: 'Contoso Stable', publisherPrefix: 'contoso' },
    app: { name: 'Stable Ids', uniqueName: APP },
    entities: [{
      schemaName: 'contoso_item', displayName: 'Item', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
      columns: [{ schemaName: 'contoso_code', displayName: 'Code', type: 'Text' }],
    }],
    views: [{ entity: 'contoso_item', name: 'Declared Items', reconcile: 'declared', columns: ['contoso_name', 'contoso_code'] }],
    charts: [{ entity: 'contoso_item', name: 'By Kind', chartType: 'Pie', groupBy: 'contoso_kind', reconcile: 'declared' }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
    ...extra,
  };
}
const stableSpec = (extra) => makeSpec({ createIdentity: 'stable-v1', ...extra });
const VIEW_KEY = 'contoso_item/Declared Items';
const CHART_KEY = 'contoso_item/By Kind';

// The ids the spec alone derives (no store, no SDK): what the first create must be sent with, in every workspace.
function derived(spec) {
  const s = createStableCreates({ spec, sdk: null, store: null, basePort: createPassthroughCreates() });
  return { view: s.identityFor('view', VIEW_KEY).id, chart: s.identityFor('chart', CHART_KEY).id };
}

function newDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-stable-ids-'));
  dirs.push(dir);
  return dir;
}

const storeFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(PREFIX)) : []);
const storeOf = (org, dir, barrier = null) => openManagedBindings({ workspaceDir: dir, environment: org.origin, appUniqueName: APP, solutionUniqueName: SOLUTION, barrier });

// One build over a fresh SDK on `dir`, as the CLI's durable workspace is reused by a re-run.
async function build(org, dir, spec, opts = {}) {
  const sdk = opts.sdk || createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
  if (!opts.sdk) await sdk.initWorkspace();
  const mark = org.calls.length;
  let out;
  let err;
  try {
    out = await runSdkBuild(spec, { sdk, apply: true, publish: false, workspaceDir: dir, appDir: dir, env: org.origin, warn: () => {}, phases: ['views', 'charts'], ...opts, sdk });
  } catch (e) {
    err = e;
  }
  const calls = org.calls.slice(mark);
  return { out, err, sdk, calls, writes: calls.filter((c) => c.method !== 'GET'), tablePublishes: org.tablePublishes(mark) };
}

// The CLI applies only a full build; its engine is narrowed to the two phases these tests are about (every other phase is covered elsewhere).
const viewsAndCharts = (s, o) => runSdkBuild(s, { ...o, phases: ['views', 'charts'] });

const creates = (r, collection) => r.writes.filter((c) => c.method === 'POST' && c.path.startsWith(`/${collection}`));

// --- grammar --------------------------------------------------------------------------------------------------------------------

test('the grammar takes createIdentity absent or exactly the one value the identity module activates on', () => {
  assert.equal(CREATE_IDENTITY_STABLE, ACTIVATION_VALUE, 'the grammar and the identity module name one value');
  const errorsOf = (spec) => validateAppSpec(spec).errors.filter((e) => /createIdentity/.test(e));
  assert.deepEqual(errorsOf(makeSpec()), []);
  assert.deepEqual(errorsOf(stableSpec({ minimumPluginVersion: '2.21.0' })), []);
  for (const bad of ['stable-v2', 'Stable-V1', true, null, '', 1]) {
    const errors = errorsOf(makeSpec({ createIdentity: bad }));
    assert.equal(errors.length, 1, JSON.stringify(bad));
    assert.match(errors[0], /^create-identity-invalid: createIdentity must be "stable-v1" or absent/);
  }
  const floor = (spec) => lintAppSpec(spec).warnings.filter((w) => /when using createIdentity/.test(w));
  assert.equal(floor(stableSpec()).length, 1, 'no floor: older plugins ignore the field');
  assert.equal(floor(stableSpec({ minimumPluginVersion: '2.20.0' })).length, 1);
  assert.deepEqual(floor(stableSpec({ minimumPluginVersion: '2.21.0' })), []);
  assert.deepEqual(floor(makeSpec()), []);
});

// --- the engine -------------------------------------------------------------------------------------------------------------------

test('a stable view and chart are created once at the derived ids, bound in the store, and a rerun binds them with no write', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec();
  const ids = derived(spec);
  const first = await build(org, dir, spec);
  assert.equal(first.err, undefined, first.err && first.err.message);
  assert.equal(first.out.created.views['contoso_item|Declared Items'], ids.view);
  assert.equal(first.out.created.charts['contoso_item|By Kind'], ids.chart);
  assert.equal(creates(first, 'savedqueries').length, 1);
  assert.equal(creates(first, 'savedqueryvisualizations').length, 1);
  assert.equal(storeFiles(dir).length, 1, 'the bindings are kept in one store file');
  const store = storeOf(org, dir);
  for (const [kind, key, id] of [['view', VIEW_KEY, ids.view], ['chart', CHART_KEY, ids.chart]]) {
    const g = store.readGroup(kind, key);
    assert.equal(g.pending, null, `${kind}: no attempt is left pending`);
    assert.equal(g.committed.root.id, id);
    assert.equal(g.committed.records[0].origin, 'created', `${kind}: the acknowledged create is recorded as created`);
  }
  const bytes = fs.readFileSync(path.join(dir, storeFiles(dir)[0]), 'utf8');

  // A new process over the same workspace: the same ids, nothing sent, and the store unchanged.
  const again = await build(org, dir, spec);
  assert.equal(again.err, undefined, again.err && again.err.message);
  assert.deepEqual(again.writes, []);
  assert.equal(storeOf(org, dir).readGroup('view', VIEW_KEY).committed.root.id, ids.view);
  assert.equal(fs.readFileSync(path.join(dir, storeFiles(dir)[0]), 'utf8'), bytes);
});

test('a fresh workspace on the same environment finds the rows at the derived ids and adopts them; no second create is sent', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const spec = stableSpec();
  const ids = derived(spec);
  const first = await build(org, newDir(), spec);
  assert.equal(first.err, undefined, first.err && first.err.message);

  const dir = newDir();
  const fresh = await build(org, dir, spec);
  assert.equal(fresh.err, undefined, fresh.err && fresh.err.message);
  assert.equal(creates(fresh, 'savedqueries').length, 0, 'the view at the derived id is bound, not created again');
  assert.equal(creates(fresh, 'savedqueryvisualizations').length, 0);
  assert.equal(org.fake.rows('savedqueries').filter((r) => r.data.name === 'Declared Items').length, 1);
  const store = storeOf(org, dir);
  assert.equal(store.readGroup('view', VIEW_KEY).committed.root.id, ids.view);
  assert.equal(store.readGroup('view', VIEW_KEY).committed.records[0].origin, 'adopted', 'nothing proves this workspace made the row');
  assert.equal(store.readGroup('chart', CHART_KEY).committed.records[0].origin, 'adopted');
});

test('a spec without createIdentity is unchanged: a fresh id per workspace, no store file, and the same requests', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const spec = makeSpec();
  const ids = derived(stableSpec());
  const dir = newDir();
  const r = await build(org, dir, spec);
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.notEqual(r.out.created.views['contoso_item|Declared Items'], ids.view);
  assert.notEqual(r.out.created.charts['contoso_item|By Kind'], ids.chart);
  assert.deepEqual(storeFiles(dir), []);
  // Control: the same build with the field sends the same requests in the same order, at other ids.
  const org2 = createFakeBuildOrg({ entities: ENTITIES });
  const s = await build(org2, newDir(), stableSpec());
  assert.equal(s.err, undefined, s.err && s.err.message);
  const shape = (x) => x.writes.map((c) => `${c.method} ${c.path.replace(/\([0-9a-f-]{36}\)/gi, '(<id>)')}`);
  assert.deepEqual(shape(s), shape(r));
});

test('a local copy with an edit the server has not seen stops the stable item before any write, keeps the bytes, and stops again', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec({ charts: [] });
  const ids = derived(stableSpec());
  const first = await build(org, dir, spec);
  assert.equal(first.err, undefined, first.err && first.err.message);

  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
  await sdk.initWorkspace();
  await sdk.fetchArtifact('view', ids.view);
  await sdk.updateElement('view', ids.view, '/description', 'An edit the server has not seen');
  const snapshot = () => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile() && !String(f).includes('.lease'))
    .sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  const before = snapshot();
  for (let run = 0; run < 2; run += 1) {
    const r = await build(org, dir, spec);
    assert.ok(r.err, `run ${run}: the build stops`);
    assert.match(r.err.message, /create-completion-required/);
    assert.deepEqual(r.writes, [], `run ${run}: nothing is written`);
    assert.deepEqual(snapshot(), before, `run ${run}: the workspace bytes are unchanged`);
  }
});

test('an attempt an earlier run left pending holds its table until this build proves it, then the hold ends', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec({ charts: [] });
  const ids = derived(stableSpec());
  // An earlier run marked the create as sending and lost the answer after the row was stored.
  const first = await build(org, newDir(), spec);
  assert.equal(first.err, undefined, first.err && first.err.message);
  storeOf(org, dir).prepareAttempt({
    family: 'view', key: VIEW_KEY, baseGeneration: null, root: { kind: 'view', key: VIEW_KEY, id: ids.view },
    expected: { proofVersion: 1, proofSchema: 'view-v1', rootId: ids.view, baseProofSha256: null, sentProjectionSha256: 'a'.repeat(64), preservationSha256: 'a'.repeat(64), baseObservation: null, children: [] },
    knownScopes: [{ type: 'table', table: 'contoso_item' }], declarationSha256: 'b'.repeat(64),
  });

  const barrier = createPublicationBarrier();
  const r = await build(org, dir, spec, { publicationBarrier: barrier });
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.equal(creates(r, 'savedqueries').length, 0, 'the row the lost answer made is bound, not created again');
  const g = storeOf(org, dir).readGroup('view', VIEW_KEY);
  assert.equal(g.pending, null);
  assert.equal(g.committed.root.id, ids.view);
  assert.equal(barrier.allow('contoso_item', 'after the proof'), true, 'the proved attempt no longer holds its table');

  // Control: the same pending attempt, opened on a barrier with no build to prove it, holds the table.
  const held = createPublicationBarrier();
  const dir2 = newDir();
  storeOf(org, dir2).prepareAttempt({
    family: 'view', key: VIEW_KEY, baseGeneration: null, root: { kind: 'view', key: VIEW_KEY, id: ids.view },
    expected: { proofVersion: 1, proofSchema: 'view-v1', rootId: ids.view, baseProofSha256: null, sentProjectionSha256: 'a'.repeat(64), preservationSha256: 'a'.repeat(64), baseObservation: null, children: [] },
    knownScopes: [{ type: 'table', table: 'contoso_item' }], declarationSha256: 'b'.repeat(64),
  });
  require('../lib/managed-bindings.js').openManagedContext({ workspaceDir: dir2, environment: org.origin, appUniqueName: APP, solutionUniqueName: SOLUTION, barrier: held });
  assert.equal(held.allow('contoso_item', 'no proof'), false);
});

test('a store the build cannot trust halts before any write: managed-binding-store-unreadable, never retried', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec();
  const first = await build(org, dir, spec);
  assert.equal(first.err, undefined, first.err && first.err.message);
  const file = path.join(dir, storeFiles(dir)[0]);
  fs.writeFileSync(file, '{ "not": "a store"');
  const r = await build(org, dir, spec);
  assert.equal(r.err && r.err.code, 'managed-binding-store-unreadable', r.err && r.err.stack);
  assert.equal(r.err.transient, false);
  assert.deepEqual(r.writes, []);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "not": "a store"');

  // The CLI opens the same store once, through the same opener, and halts the same way.
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
  await sdk.initWorkspace();
  const mark = org.calls.length;
  let cliErr;
  let cliOut;
  try {
    // The CLI validates the spec first; its chart's Choice column is not declared in this spec, so the CLI is given the view alone.
    cliOut = await buildModelApp(stableSpec({ charts: [] }), { apply: true, env: org.origin, workspaceDir: dir, appDir: dir, retryDelayMs: 0 }, { sdk, provisionSdk: sdk, runBuild: viewsAndCharts, warn: () => {}, log: () => {} });
  } catch (e) {
    cliErr = e;
  }
  assert.equal(cliErr && cliErr.code, 'managed-binding-store-unreadable', JSON.stringify(cliOut));
  assert.deepEqual(org.calls.slice(mark).filter((c) => c.method !== 'GET'), []);
});

test('the CLI hands every attempt the one store it opened, and a stable view is created once at its derived id', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec({ charts: [] });
  const ids = derived(stableSpec());
  const seen = [];
  const runBuild = (s, o) => { seen.push(o.bindingGroups); return viewsAndCharts(s, o); };
  for (let run = 0; run < 2; run += 1) {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
    await sdk.initWorkspace();
    const mark = org.calls.length;
    const out = await buildModelApp(spec, { apply: true, env: org.origin, workspaceDir: dir, appDir: dir, retryDelayMs: 0 }, { sdk, provisionSdk: sdk, runBuild, warn: () => {}, log: () => {} });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const posts = org.calls.slice(mark).filter((c) => c.method === 'POST' && c.path.startsWith('/savedqueries'));
    assert.equal(posts.length, run === 0 ? 1 : 0, `run ${run}`);
  }
  assert.equal(seen.length, 2);
  assert.ok(seen.every((g) => g && g.store), 'each invocation hands its attempt the store it opened');
  assert.equal(storeOf(org, dir).readGroup('view', VIEW_KEY).committed.root.id, ids.view);
});
