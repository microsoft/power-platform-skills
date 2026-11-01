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
const { openManagedBindings, openManagedContext, readManagedManifest, PREFIX } = require('../lib/managed-bindings.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { createAttemptSendObserver } = require('../lib/managed-feature-contract.js');
const { buildModelApp } = require('../build-model-app.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');
const { seedManagedDebt } = require('./helpers/managed-debt.js');
const { verifySpec } = require('../lib/verify-spec.js');

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

// The fake org's client with every request passed through the build's publication barrier, as the CLI's transport is
// (build-model-app.js gates its client with the same barrier it hands the build): a plain publish of a routed or withheld
// table is screened at the send, exactly as in production. The barrier's transport shape is { method, url, headers, body }
// answering { statusCode, headers, body } (lib/dataverse-auth.js makeRequest); the fake's is (url, body, options) answering
// { status, headers, body } with the body parsed. A request the gate rewrote (a partly withheld publish) carries new text.
// With `observer` (managed-feature-contract.js createAttemptSendObserver) the attempt send observer sits INSIDE the gate,
// as build-model-app.js nests it.
function gatedClient(org, barrier, observer = null) {
  const text = (b) => (b == null ? '' : typeof b === 'string' ? b : JSON.stringify(b));
  const transport = async (req) => {
    const m = req.method.toLowerCase();
    let body = req.raw;
    if (req.body !== text(req.raw)) { try { body = JSON.parse(req.body); } catch { body = req.body; } }
    const res = m === 'get' ? await org.httpClient.get(req.url, req.options) : await org.httpClient[m](req.url, body, req.options);
    return { statusCode: res.status, headers: res.headers || {}, body: text(res.body), res };
  };
  const gated = barrier.gateRequest(observer ? observer.wrap(transport) : transport);
  const send = async (method, url, raw, options) => {
    const answer = await gated({ method, url, headers: (options && options.headers) || {}, body: text(raw), raw, options });
    if (answer.res) return answer.res;
    let body = answer.body;
    try { body = body ? JSON.parse(body) : null; } catch { /* kept as text */ }
    return { status: answer.statusCode, headers: answer.headers || {}, body };
  };
  return Object.fromEntries(['get', 'post', 'patch', 'put', 'delete'].map((m) => [m,
    (url, ...args) => (m === 'get' ? send('GET', url, undefined, args[0]) : send(m.toUpperCase(), url, args[0], args[1])),
  ]));
}

// One build over a fresh SDK on `dir`, as the CLI's durable workspace is reused by a re-run.
async function build(org, dir, spec, opts = {}) {
  const barrier = opts.publicationBarrier || createPublicationBarrier();
  const sdk = opts.sdk || createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, opts.sendObserver || null) });
  if (!opts.sdk) await sdk.initWorkspace();
  const mark = org.calls.length;
  let out;
  let err;
  try {
    out = await runSdkBuild(spec, { sdk, apply: true, publish: false, workspaceDir: dir, appDir: dir, env: org.origin, warn: () => {}, phases: ['views', 'charts'], publicationBarrier: barrier, ...opts, sdk });
  } catch (e) {
    err = e;
  }
  const calls = org.calls.slice(mark);
  return { out, err, sdk, calls, writes: calls.filter((c) => c.method !== 'GET'), tablePublishes: org.tablePublishes(mark) };
}

// The CLI applies only a full build; its engine is narrowed to the two phases these tests are about (every other phase is covered elsewhere).
const viewsAndCharts = (s, o) => runSdkBuild(s, { ...o, phases: ['views', 'charts'] });

const creates = (r, collection) => r.writes.filter((c) => c.method === 'POST' && c.path.startsWith(`/${collection}`));

// Everything a build's stop says: its message, its causes and the findings it carries, as one text.
function chainText(err) {
  const out = [];
  const seen = new Set();
  const walk = (e) => {
    if (!e || typeof e !== 'object' || seen.has(e)) return;
    seen.add(e);
    out.push(String(e.message || ''));
    for (const f of Array.isArray(e.findings) ? e.findings : []) out.push(`${f.code}: ${f.message}`);
    walk(e.cause);
  };
  walk(err);
  return out.join('\n');
}

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

test('a fresh workspace on the same environment finds the rows at the derived ids: unbound and untouched without the adoption approval, adopted with it', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const spec = stableSpec();
  const ids = derived(spec);
  const first = await build(org, newDir(), spec);
  assert.equal(first.err, undefined, first.err && first.err.message);

  // A row at the derived id is an observation, not a binding: nothing proves this workspace made it.
  const dir = newDir();
  const fresh = await build(org, dir, spec);
  assert.equal(fresh.err, undefined, fresh.err && fresh.err.message);
  assert.deepEqual(fresh.writes, [], 'an equal row with no approval is left as it is');
  let store = storeOf(org, dir);
  assert.equal(store.readGroup('view', VIEW_KEY).committed, null, 'no binding without the adoption approval');
  assert.equal(store.readGroup('chart', CHART_KEY).committed, null);
  // Nor does it give authority to change the row: an edited declaration without the approval writes nothing.
  const edited = stableSpec();
  edited.views[0].description = 'Edited without the adoption approval';
  edited.charts[0].description = 'Edited without the adoption approval';
  const edit = await build(org, dir, edited);
  assert.ok(edit.err, 'the unbound rows are refused');
  assert.deepEqual(edit.writes, [], 'nothing is overwritten on identity alone');
  store = storeOf(org, dir);
  assert.equal(store.readGroup('view', VIEW_KEY).committed, null);

  const adopted = await build(org, dir, spec, { authorizedAdoption: new Set([`view:${VIEW_KEY}`, `chart:${CHART_KEY}`]) });
  assert.equal(adopted.err, undefined, adopted.err && adopted.err.message);
  assert.equal(creates(adopted, 'savedqueries').length, 0, 'the view at the derived id is bound, not created again');
  assert.equal(creates(adopted, 'savedqueryvisualizations').length, 0);
  assert.equal(org.fake.rows('savedqueries').filter((r) => r.data.name === 'Declared Items').length, 1);
  store = storeOf(org, dir);
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

// A create whose answer was lost after the row was stored: the transport throws after the fake saved it.
function loseNextCreateAnswer(org, collection) {
  const original = org.httpClient.post;
  let lost = false;
  org.httpClient.post = async (url, body, ...rest) => {
    const response = await original(url, body, ...rest);
    if (!lost && new RegExp(`/${collection}(?:\\?|$)`, 'i').test(url)) {
      lost = true;
      throw Object.assign(new Error('response lost after save'), { code: 'ECONNRESET' });
    }
    return response;
  };
  return () => { org.httpClient.post = original; };
}

// The maker's step after a lost create: the build kept the local draft (create-local-draft-kept) and stops on it until the maker
// removes it with the SDK's own local discard. It must be the draft the build reported keeping.
async function removeKeptDraft(run, kind, id) {
  assert.match(String(run.err && run.err.message), /create-local-draft-kept/);
  assert.equal((await readLocalCreateState(run.sdk, kind, id)).state, 'pending');
  await run.sdk.deleteArtifact(kind, id);
}

test('an attempt an earlier run left pending holds its table until this build proves it, then the hold ends', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec({ charts: [] });
  const ids = derived(stableSpec());
  // An earlier run marked the create as sending and lost the answer after the row was stored.
  const restore = loseNextCreateAnswer(org, 'savedqueries');
  const first = await build(org, dir, spec);
  restore();
  assert.ok(first.err, 'the run whose answer was lost stops');
  const pending = storeOf(org, dir).readGroup('view', VIEW_KEY).pending;
  assert.ok(pending, 'and leaves its attempt pending');
  assert.equal(pending.root.id, ids.view);
  // The build kept its local draft (it never removes one); the maker removes it, as the halt says.
  await removeKeptDraft(first, 'view', pending.root.id);

  // Control: the same store, opened on a barrier with no build to prove it, holds the table.
  const held = createPublicationBarrier();
  require('../lib/managed-bindings.js').openManagedContext({ workspaceDir: dir, environment: org.origin, appUniqueName: APP, solutionUniqueName: SOLUTION, barrier: held });
  assert.equal(held.allow('contoso_item', 'no proof'), false);

  // No answer acknowledged the create, so nothing proves this run made the row: the proof alone binds nothing.
  const refused = await build(org, dir, spec, { publicationBarrier: createPublicationBarrier() });
  assert.match(String(refused.err && refused.err.message), /managed-adoption-required/);
  assert.deepEqual(refused.writes, [], 'nothing is sent again');
  assert.ok(storeOf(org, dir).readGroup('view', VIEW_KEY).pending, 'the attempt is kept');

  const barrier = createPublicationBarrier();
  const r = await build(org, dir, spec, { publicationBarrier: barrier, authorizedAdoption: new Set([`view:${VIEW_KEY}`]) });
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.equal(creates(r, 'savedqueries').length, 0, 'the row the lost answer made is bound, not created again');
  const g = storeOf(org, dir).readGroup('view', VIEW_KEY);
  assert.equal(g.pending, null);
  assert.equal(g.committed.root.id, ids.view);
  assert.equal(barrier.blocks('contoso_item'), false, 'the proved attempt no longer holds its table');
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
  // The file is the record of changes not yet proved: the remedy keeps it, never moves, deletes or resets it, and never puts back an older
  // copy — a backup, the build's own included, can miss an attempt or a publish sent after it was made.
  assert.match(r.err.message, /keep this file/i);
  assert.doesNotMatch(r.err.message, /aside|delete|remove the file|reset/i);
  assert.match(r.err.message, /never put back an older copy/i);
  assert.doesNotMatch(r.err.message, /put back the build's own copy/i);
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
    // The CLI's client is gated by the barrier it hands the build (build-model-app.js makeSdk); so is this one.
    const publicationBarrier = createPublicationBarrier();
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, publicationBarrier) });
    await sdk.initWorkspace();
    const mark = org.calls.length;
    const out = await buildModelApp(spec, { apply: true, env: org.origin, workspaceDir: dir, appDir: dir, retryDelayMs: 0 }, { sdk, provisionSdk: sdk, runBuild, publicationBarrier, warn: () => {}, log: () => {} });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    const posts = org.calls.slice(mark).filter((c) => c.method === 'POST' && c.path.startsWith('/savedqueries'));
    assert.equal(posts.length, run === 0 ? 1 : 0, `run ${run}`);
  }
  assert.equal(seen.length, 2);
  assert.ok(seen.every((g) => g && g.store), 'each invocation hands its attempt the store it opened');
  assert.equal(storeOf(org, dir).readGroup('view', VIEW_KEY).committed.root.id, ids.view);
});

// --- recovery, coverage and the managed settlement ------------------------------------------------------------------------------

const workspaceArgs = (org, dir) => ({ workspaceDir: dir, environment: org.origin, appUniqueName: APP, solutionUniqueName: SOLUTION });
const isViewCreate = (url) => /\/savedqueries(?:\?|$)/i.test(url);

for (const acknowledged of [false, true]) test(`a pending attempt${acknowledged ? ' whose create was acknowledged' : ''} is proved by the expectation it recorded, never re-baselined from the current declaration`, async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const spec = stableSpec({ charts: [] });
  spec.views[0].description = 'A later declaration, not the pending expectation';
  assert.equal((await build(org, newDir(), spec)).err, undefined);
  // An attempt whose recorded expectation the row does not hold: the build does not adopt today's row as its proof — also
  // when the create's answer came back and only the commit is missing, where no adoption approval is asked for.
  const dir = newDir();
  seedManagedDebt(workspaceArgs(org, dir), { key: VIEW_KEY, id: derived(stableSpec()).view, table: 'contoso_item', acknowledged });
  const barrier = createPublicationBarrier();
  const r = await build(org, dir, spec, { publicationBarrier: barrier, authorizedAdoption: new Set([`view:${VIEW_KEY}`]) });
  assert.ok(r.err, 'the attempt does not prove');
  const g = storeOf(org, dir).readGroup('view', VIEW_KEY);
  assert.ok(g.pending, 'it stays pending');
  assert.equal(g.committed, null, 'and nothing is committed over it');
  assert.equal(barrier.allow('contoso_item', 'proof check'), false, 'its table stays withheld');
  assert.deepEqual(r.tablePublishes, []);
});

test('a lost create keeps its recorded content expectation when the row and the declaration both change afterwards', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const firstDir = newDir();
  const spec = stableSpec({ charts: [] });
  spec.views[0].description = 'Original intended description';
  const restore = loseNextCreateAnswer(org, 'savedqueries');
  const first = await build(org, firstDir, spec);
  restore();
  const before = storeOf(org, firstDir).readGroup('view', VIEW_KEY);
  assert.ok(before.pending, first.err && first.err.message);
  const id = before.pending.root.id;
  await org.httpClient.patch(`${org.origin}/api/data/v9.2/savedqueries(${id})`, { description: 'Different content after the interruption' });
  const dir = newDir();
  for (const file of storeFiles(firstDir)) fs.copyFileSync(path.join(firstDir, file), path.join(dir, file));
  const changed = structuredClone(spec);
  changed.views[0].description = 'Different content after the interruption';
  const barrier = createPublicationBarrier();
  const r = await build(org, dir, changed, { publicationBarrier: barrier, authorizedAdoption: new Set([`view:${VIEW_KEY}`]) });
  const after = storeOf(org, dir).readGroup('view', VIEW_KEY);
  assert.ok(after.pending, 'the attempt is not retired against later content and a changed declaration');
  assert.deepEqual(after.pending.expected, before.pending.expected, 'its expectation is the one written before the send');
  assert.equal(after.committed, null);
  assert.deepEqual(r.writes, [], 'nothing is sent over it');
  assert.equal(barrier.allow('contoso_item', 'after recovery'), false);
});

test('the attempt is journaled as sending, with its complete expected content, before the create leaves', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const original = org.httpClient.post.bind(org.httpClient);
  const seen = [];
  org.httpClient.post = async (url, body, ...args) => {
    if (isViewCreate(url)) seen.push(storeOf(org, dir).readGroup('view', VIEW_KEY).pending);
    return original(url, body, ...args);
  };
  const r = await build(org, dir, stableSpec({ charts: [] }));
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, 'sending');
  for (const field of ['sentProjectionSha256', 'preservationSha256']) assert.match(String(seen[0].expected[field]), /^[0-9a-f]{64}$/, field);
  assert.equal(seen[0].expected.rootId, derived(stableSpec()).view);
});

test('a table publish whose outcome was not confirmed fences the table in every later build, a new sibling view included', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec({ charts: [] });
  org.refuseNextTablePublish(503);
  const first = await build(org, dir, spec);
  assert.equal(first.tablePublishes.length, 1, 'one publish was sent and answered 503');
  assert.equal(storeOf(org, dir).readGroup('view', VIEW_KEY).committed.publication.state, 'unconfirmed');
  const next = structuredClone(spec);
  next.views.push({ ...next.views[0], name: 'Sibling View' });
  const second = await build(org, dir, next);
  assert.match(String(second.err && second.err.message), /managed-publication-unconfirmed/);
  assert.deepEqual(second.tablePublishes, [], 'the scope is not published again past an unconfirmed send');
});

// A plain publish of a table a confirmed managed view is on owes that view nothing, but it ships the view's saved layer
// again: its dispatch is journaled with the view carried, so a restart after a lost answer neither edits the view nor
// publishes the table again.
for (const observed of [false, true]) {
  test(`a carried table publish whose answer was lost fences the next build: no managed PATCH and no publish${observed ? ' (the attempt send observer inside the barrier)' : ''}`, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const spec = stableSpec({ charts: [] });
    const run = (s) => build(org, dir, s, observed ? { sendObserver: createAttemptSendObserver() } : {});
    const seed = await run(spec);
    assert.equal(seed.err, undefined, seed.err && seed.err.message);
    assert.equal(storeOf(org, dir).readGroup('view', VIEW_KEY).committed.publication.state, 'confirmed');

    const ordinary = makeSpec({ charts: [] });
    ordinary.views[0].name = 'Plain sibling after managed publication';
    org.refuseNextTablePublish(503);
    const carry = await run(ordinary);
    assert.equal(carry.tablePublishes.length, 1, 'the carried publish was sent once and answered 503');
    assert.match(String(carry.err && carry.err.message), /managed-publication-unconfirmed/);
    const carried = storeOf(org, dir).readGroup('view', VIEW_KEY).committed.publication;
    assert.equal(carried.state, 'unconfirmed', 'the carried view is journaled under the lost dispatch');
    assert.ok(carried.carriedFrom, 'it keeps the settled state it was carried from');

    const edit = structuredClone(spec);
    edit.views[0].description = 'New content while the earlier carried publish is uncertain';
    const next = await run(edit);
    const patches = next.writes.filter((c) => c.method === 'PATCH' && /^\/savedqueries\(/.test(c.path));
    assert.equal(patches.length, 0, 'an earlier uncertain carried publish fences a new managed edit before its PATCH');
    assert.deepEqual(next.tablePublishes, [], 'a restart never replays a carried publish whose dispatch was not disproved');
    assert.match(String(next.err && next.err.message), /managed-publication-unconfirmed/);
  });
}

// A failed publish is RETURNED, not thrown, by both the SDK (`{ shipped: false, publish: { kind: 'failed' } }`) and the
// Dataverse client (`{ status: 500 }`). The managed publish callback must turn that into a throw, or the read-back that follows
// would "confirm" a carried view that was live before the send. A 500 may have run, so it is not claimed as never started.
test('a carried publish answered as failed by a returned value, not a throw, is never confirmed', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec({ charts: [] });
  const seed = await build(org, dir, spec);
  assert.equal(seed.err, undefined, seed.err && seed.err.message);

  const barrier = createPublicationBarrier();
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier) });
  await sdk.initWorkspace();
  const sdkPublishes = [];
  const failed = (type, id) => ({ type, id, shipped: false, publish: { kind: 'failed', error: { code: 'publish-failed', message: 'refused' } } });
  sdk.publishArtifact = async (type, id) => { sdkPublishes.push([type, id]); return failed(type, id); };
  sdk.publishArtifacts = async (list) => { sdkPublishes.push(...list.map((x) => [x.type, x.id])); return list.map((x) => failed(x.type, x.id)); };
  const ordinary = makeSpec({ charts: [] });
  ordinary.views[0].name = 'Plain sibling whose table publish is answered as failed';
  org.refuseNextTablePublish(500);
  const r = await build(org, dir, ordinary, { sdk, publicationBarrier: barrier });
  assert.equal(r.tablePublishes.length, 1, 'the routed publish went to PublishXml and was answered 500');
  assert.ok(r.err, 'the build stops');
  assert.deepEqual(sdkPublishes, [], 'a routed table is never published through the SDK, whose failure is a returned value');
  const pub = storeOf(org, dir).readGroup('view', VIEW_KEY).committed.publication;
  assert.equal(pub.state, 'unconfirmed', 'the returned failure is not taken for a success, nor for a request that never started');
  assert.ok(pub.carriedFrom);
});

// An answer the transport lost after the platform applied the request.
function loseNextAnswer(org, method, pattern) {
  const original = org.httpClient[method];
  let lost = false;
  org.httpClient[method] = async (url, ...rest) => {
    const response = await original(url, ...rest);
    if (!lost && pattern.test(url)) {
      lost = true;
      throw Object.assign(new Error('response lost after save'), { code: 'ECONNRESET' });
    }
    return response;
  };
  return () => { org.httpClient[method] = original; };
}

// A publish that paid a view's debt and whose answer was lost after the platform published it: before the next build changes
// that view, it confirms the earlier dispatch read-only with its own client (the published layer now holds the desired hash,
// which it did not before the send), never by sending it again.
test('a lost publish that paid a managed view its debt is confirmed read-only before the next change of that view, never sent again', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec({ charts: [] });
  const restore = loseNextAnswer(org, 'post', /\/PublishXml$/i);
  const first = await build(org, dir, spec);
  restore();
  assert.equal(first.tablePublishes.length, 1, 'the publish reached the platform');
  assert.ok(first.err, 'the run whose answer was lost stops');
  assert.equal(storeOf(org, dir).readGroup('view', VIEW_KEY).committed.publication.state, 'unconfirmed');

  const edit = structuredClone(spec);
  edit.views[0].description = 'A change after the lost publish';
  const mark = org.calls.length;
  const original = org.httpClient.patch;
  const atPatch = [];
  org.httpClient.patch = async (url, ...rest) => {
    if (/\/savedqueries\(/i.test(url)) atPatch.push({ state: storeOf(org, dir).readGroup('view', VIEW_KEY).committed.publication.state, publishes: org.tablePublishes(mark).length });
    return original(url, ...rest);
  };
  try { await build(org, dir, edit); } finally { org.httpClient.patch = original; }
  assert.equal(atPatch.length, 1, 'the change is made once the earlier dispatch is confirmed');
  assert.deepEqual(atPatch[0], { state: 'confirmed', publishes: 0 }, 'confirmed by a read before the PATCH; the earlier publish is not sent again');
});

// An edit of a row the build read first is never a create: its attempt records the row it read as its base observation, before
// the send, so no answer to it (nor a record that claims one) makes the row this workspace's own.
test('an edit records its base observation before the send; a lost edit of an adopted row is bound only with the adoption approval', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const spec = stableSpec({ charts: [] });
  assert.equal((await build(org, newDir(), spec)).err, undefined);
  const dir = newDir();
  const approval = new Set([`view:${VIEW_KEY}`]);
  const edited = structuredClone(spec);
  edited.views[0].description = 'An edit of a row this workspace did not make';
  const original = org.httpClient.patch;
  const seen = [];
  org.httpClient.patch = async (url, ...rest) => {
    if (/\/savedqueries\(/i.test(url)) seen.push(storeOf(org, dir).readGroup('view', VIEW_KEY).pending);
    return original(url, ...rest);
  };
  const restore = loseNextAnswer(org, 'patch', /\/savedqueries\(/i);
  const lost = await build(org, dir, edited, { authorizedAdoption: approval });
  restore();
  org.httpClient.patch = original;
  assert.ok(lost.err, 'the run whose answer was lost stops');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, 'sending');
  assert.ok(seen[0].expected.baseObservation, 'the edit records the row it read as its base');
  assert.match(String(seen[0].expected.baseObservation.savedSha256), /^[0-9a-f]{64}$/);
  const pending = storeOf(org, dir).readGroup('view', VIEW_KEY).pending;
  assert.ok(pending, 'the lost edit stays pending');
  assert.equal(pending.acknowledgedRoot, false);

  const refused = await build(org, dir, edited);
  assert.match(String(refused.err && refused.err.message), /managed-adoption-required/, 'an edit is never a create this workspace can bind without the approval');
  const bound = await build(org, dir, edited, { authorizedAdoption: approval });
  assert.equal(bound.err, undefined, bound.err && bound.err.message);
  assert.deepEqual(bound.writes.filter((c) => c.method === 'PATCH' && /^\/savedqueries\(/.test(c.path)), [], 'the lost edit is proved, not sent again');
  const g = storeOf(org, dir).readGroup('view', VIEW_KEY);
  assert.equal(g.pending, null);
  assert.equal(g.committed.records[0].origin, 'adopted');
});

// A record an older build wrote may claim an acknowledged create on an attempt whose base observation says it edited a row it
// read: the prover takes the store's rule (rootCreateAcknowledged), never the raw flag, so the row is adopted, not 'created'.
test('a pending edit whose record claims an acknowledged create is proved as an adoption, by the store rule rather than the raw flag', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const spec = stableSpec({ charts: [] });
  assert.equal((await build(org, newDir(), spec)).err, undefined);
  const dir = newDir();
  const approval = new Set([`view:${VIEW_KEY}`]);
  const edited = structuredClone(spec);
  edited.views[0].description = 'An edit an older build recorded as a create';
  const restore = loseNextAnswer(org, 'patch', /\/savedqueries\(/i);
  const lost = await build(org, dir, edited, { authorizedAdoption: approval });
  restore();
  assert.ok(lost.err);
  const file = path.join(dir, storeFiles(dir)[0]);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const attempt = data.attempts.find((a) => a.family === 'view' && a.key === VIEW_KEY);
  assert.ok(attempt && attempt.expected.baseObservation, 'an edit attempt with a base observation');
  attempt.acknowledgedRoot = true;
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  assert.equal(storeOf(org, dir).readGroup('view', VIEW_KEY).pending.acknowledgedRoot, true, 'the store accepts the older record');

  const r = await build(org, dir, edited, { authorizedAdoption: approval });
  assert.equal(r.err, undefined, r.err && r.err.message);
  const g = storeOf(org, dir).readGroup('view', VIEW_KEY);
  assert.equal(g.pending, null);
  assert.equal(g.committed.records[0].origin, 'adopted', 'an edit is never recorded as this workspace\'s create');
});

// The intents' `declaration` is the catalog's key-part input (creates-catalog.js identityFor), not a store declaration: a view
// or chart group has no place for one (its consumer state is the baseline alone), so a plan never hands it to prepareAttempt and
// the store commits no originalDeclaration for either. Nothing in the build reads a group's declaration back.
test('a stable view and chart commit with their baseline alone: no declaration is handed to the store, none is committed', async () => {
  const { checkDeclaration, CODES } = require('../lib/managed-bindings.js');
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const r = await build(org, dir, stableSpec());
  assert.equal(r.err, undefined, r.err && r.err.message);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, storeFiles(dir)[0]), 'utf8'));
  assert.equal(raw.groups.length, 2);
  for (const g of raw.groups) {
    assert.equal(g.originalDeclaration, undefined, `${g.family}: no original declaration`);
    assert.deepEqual(Object.keys(g.consumerState), ['baseline'], `${g.family}: its consumer state is the baseline alone`);
  }
  // The store's rule the build relies on: a view or chart declaration would be refused, so none is ever offered.
  for (const i of require('../lib/creates-stable-build.js').stableIntents(stableSpec())) {
    assert.throws(() => checkDeclaration(i.catalogKind, i.key, i.declaration), (e) => e.code === CODES.declarationRefused);
  }
});

test('a build without createIdentity cannot publish a table whose managed view has a draft its store did not prove', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const seed = await build(org, dir, stableSpec({ charts: [] }));
  assert.equal(seed.err, undefined, seed.err && seed.err.message);
  const id = derived(stableSpec()).view;
  await org.httpClient.patch(`${org.origin}/api/data/v9.0/savedqueries(${id})`, { description: 'A maker draft that must not be released with a sibling' });
  const next = makeSpec({ charts: [] });
  next.views[0].name = 'Unprotected sibling';
  const r = await build(org, dir, next);
  assert.match(String(r.err && r.err.message), /create-completion-required/);
  assert.deepEqual(r.tablePublishes, [], 'discovery routes the table through the coverage protocol whatever this spec declares');
  assert.ok(org.fake.unpublished().some((u) => u.id === id), 'the draft stays unpublished');
});

test('a failed solution membership keeps the attempt; the next run finishes the membership at the same id, then commits', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec({ charts: [] });
  const id = derived(stableSpec()).view;
  const stop = org.intercept((c) => c.method === 'POST' && /AddSolutionComponent/.test(c.path), () => ({ status: 503, headers: {}, body: { error: { message: 'membership not added' } } }));
  const first = await build(org, dir, spec);
  stop();
  assert.ok(first.err, 'the membership failed after the create');
  let g = storeOf(org, dir).readGroup('view', VIEW_KEY);
  assert.ok(g.pending, 'the attempt is kept');
  assert.equal(g.committed, null, 'no group is committed before the membership is proved');
  assert.deepEqual(first.tablePublishes, []);
  const second = await build(org, dir, spec);
  assert.equal(second.err, undefined, second.err && second.err.message);
  assert.equal(creates(second, 'savedqueries').length, 0, 'the row is not created again');
  const adds = second.writes.filter((c) => /AddSolutionComponent/.test(c.path));
  assert.equal(adds.length, 1);
  assert.equal(adds[0].body.ComponentId, id);
  g = storeOf(org, dir).readGroup('view', VIEW_KEY);
  assert.equal(g.pending, null);
  assert.equal(g.committed.root.id, id);
});

test('a receipt that cannot be written after an acknowledged create is an outcome to recover, never a refusal made before the send', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const barrier = createPublicationBarrier();
  const store = storeOf(org, dir, barrier);
  const broken = new Proxy(store, {
    get(target, key) {
      if (key === 'noteSaved') return () => { throw Object.assign(new Error('the receipt cannot be persisted'), { code: 'creation-record-unwritten' }); };
      return target[key];
    },
  });
  const r = await build(org, dir, stableSpec({ charts: [] }), { publicationBarrier: barrier, bindingGroups: { store: broken, debt: [], absent: false } });
  assert.equal(creates(r, 'savedqueries').length, 1);
  assert.equal(org.fake.rows('savedqueries').filter((x) => x.data.name === 'Declared Items').length, 1);
  assert.ok(r.err, 'the build stops');
  assert.doesNotMatch(r.err.message, /was not created|nothing was written|view-create-refused|view-write-refused/, 'an acknowledged create is not reported as refused');
  assert.ok(store.readGroup('view', VIEW_KEY).pending, 'the attempt is kept for the next run');
});

test("the build's inline --verify reads the bound rows by the same managed manifest as standalone verify", async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const seeded = await build(org, dir, stableSpec({ charts: [] }));
  assert.equal(seeded.err, undefined, seeded.err && seeded.err.message);
  const id = derived(stableSpec()).view;
  org.intercept((c) => c.method === 'GET' && c.path.startsWith(`/savedqueries(${id})`), () => ({ status: 404, headers: {}, body: { error: { code: '0x80040217', message: 'bound row no longer exists' } } }));
  const next = stableSpec({ views: [], charts: [] });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
  await sdk.initWorkspace();
  // The bound row is gone: a read by its id finds nothing, whatever else the table holds.
  const read = {
    findTable: async () => ({ logicalName: 'contoso_item' }),
    findColumns: async () => [{ logicalName: 'contoso_code' }],
    queryRecords: async () => [],
    sitemapXml: async () => '<SiteMap><Area><Group><SubArea Entity="contoso_item"/></Group></Area></SiteMap>',
  };
  let given;
  let inline;
  const out = await buildModelApp(next, { apply: true, verify: true, env: org.origin, workspaceDir: dir, appDir: dir, retryDelayMs: 0 }, {
    sdk, provisionSdk: sdk, runBuild: viewsAndCharts, warn: () => {}, log: () => {},
    verify: async (s, opts) => { given = opts; inline = await verifySpec(s, read, opts); return inline; },
  });
  assert.ok(out, 'the build returned');
  assert.ok(given && given.managedManifest, 'the inline verify is handed the managed manifest');
  const standalone = await verifySpec(next, read, { managedManifest: readManagedManifest(workspaceArgs(org, dir)) });
  assert.equal(inline.ok, false, 'a missing bound row is not a pass');
  assert.deepEqual(inline.missing, standalone.missing, 'both entries report the same missing bound row');
  assert.ok(inline.missing.some((m) => m.kind === 'managed-view'));
});

test('a removed declaration keeps its pending hold; a build recovers it by its recorded expectation, with the adoption approval, never by omission', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const declared = stableSpec({ charts: [] });
  const restore = loseNextCreateAnswer(org, 'savedqueries');
  const first = await build(org, dir, declared);
  restore();
  assert.ok(storeOf(org, dir).readGroup('view', VIEW_KEY).pending, first.err && first.err.message);
  await removeKeptDraft(first, 'view', storeOf(org, dir).readGroup('view', VIEW_KEY).pending.root.id);
  const removed = stableSpec({ views: [], charts: [] });

  // A spec without the field: nothing recovers it, and its table stays held.
  const plainBarrier = createPublicationBarrier();
  const plain = await build(org, dir, makeSpec({ views: [], charts: [] }), { publicationBarrier: plainBarrier });
  assert.deepEqual(plain.writes, []);
  assert.equal(plainBarrier.allow('contoso_item', 'omitted'), false);
  assert.equal(readManagedManifest(workspaceArgs(org, dir)).pending.length, 1);

  // Proved by its recorded expectation, but no answer acknowledged the create: it is not bound without the approval.
  const warnings = [];
  const heldBarrier = createPublicationBarrier();
  const held = await build(org, dir, removed, { publicationBarrier: heldBarrier, warn: (m) => warnings.push(String(m)) });
  assert.deepEqual(held.writes, [], 'nothing is sent for an undeclared attempt');
  assert.deepEqual(held.tablePublishes, []);
  assert.equal(heldBarrier.allow('contoso_item', 'not approved'), false, 'its table stays withheld');
  assert.ok(storeOf(org, dir).readGroup('view', VIEW_KEY).pending, 'the attempt is kept');
  assert.ok(warnings.some((w) => /managed-adoption-required/.test(w) && /no longer declared/.test(w)), warnings.join('\n'));

  // With the approval it is proved, joins the solution, is committed, and its table published once.
  const barrier = createPublicationBarrier();
  const r = await build(org, dir, removed, { publicationBarrier: barrier, authorizedAdoption: new Set([`view:${VIEW_KEY}`]) });
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.equal(creates(r, 'savedqueries').length, 0, 'never sent again');
  assert.deepEqual(r.tablePublishes, [['contoso_item']]);
  const g = storeOf(org, dir).readGroup('view', VIEW_KEY);
  assert.equal(g.pending, null);
  assert.equal(g.committed.root.id, derived(stableSpec()).view);
  assert.equal(barrier.blocks('contoso_item'), false, 'the hold ends');
});

test('a removed declaration whose row no longer holds its recorded expectation stays pending and withheld, even with the approval', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const restore = loseNextCreateAnswer(org, 'savedqueries');
  const first = await build(org, dir, stableSpec({ charts: [] }));
  restore();
  const id = storeOf(org, dir).readGroup('view', VIEW_KEY).pending.root.id;
  await removeKeptDraft(first, 'view', id);
  await org.httpClient.patch(`${org.origin}/api/data/v9.2/savedqueries(${id})`, { description: 'Changed after the interruption' });
  const warnings = [];
  const barrier = createPublicationBarrier();
  const r = await build(org, dir, stableSpec({ views: [], charts: [] }), { publicationBarrier: barrier, authorizedAdoption: new Set([`view:${VIEW_KEY}`]), warn: (m) => warnings.push(String(m)) });
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.tablePublishes, []);
  assert.ok(storeOf(org, dir).readGroup('view', VIEW_KEY).pending);
  assert.equal(barrier.allow('contoso_item', 'mismatch'), false);
  assert.ok(warnings.some((w) => /does not hold what its recorded change expected/.test(w)), warnings.join('\n'));
});

test('the documented recovery keeps the store: no advice to move, delete or reset it', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'references', 'app-spec-schema-advanced.md'), 'utf8');
  const start = doc.indexOf('## createIdentity');
  assert.ok(start >= 0);
  const next = doc.indexOf('\n## ', start + 3);
  const section = doc.slice(start, next < 0 ? undefined : next);
  assert.doesNotMatch(section, /\baside\b|delete (it|the (store|file))|reset (it|the store)|start (over|fresh)/i);
  // Restoring an older copy is not recovery: it can miss an attempt or a publish sent after it was made.
  assert.match(section, /never put back an older copy/i);
  assert.doesNotMatch(section, /put back the build's own copy/i);
  assert.match(section, /--authorize adopt:view:/);
  assert.match(section, /declaration/);
});

// --- the build's own unacknowledged local create ---------------------------------------------------------------------------------
const { readLocalCreateState } = require('../lib/creates-local.js');
const { execFileSync } = require('node:child_process');
const normalize = (g) => String(g || '').replace(/[{}]/g, '').toLowerCase();
const { withAppBuildLease } = require('../lib/app-operation-lease.js');
const { appUniqueName } = require('../lib/app-unique-name.js');

// Every file under `dir`, by relative path, to compare a workspace byte for byte.
function filesOf(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isFile()) out[name] = fs.readFileSync(file, 'base64');
  }
  return out;
}

for (const kind of ['view', 'chart']) {
  const collection = kind === 'view' ? 'savedqueries' : 'savedqueryvisualizations';
  const key = kind === 'view' ? VIEW_KEY : CHART_KEY;
  const only = () => stableSpec(kind === 'view' ? { charts: [] } : { views: [] });

  // The tradeoff of never removing a local draft: a clean lost create no longer continues by itself. Its draft is kept, the next
  // build stops on it and writes nothing, and once the maker removes the draft (the SDK's own local discard) the build after
  // proves the row from the server and binds it — never creating it again.
  test(`a ${kind} create whose answer was lost keeps its local draft; the next build stops until the maker removes it, then proves the row`, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const barrier = createPublicationBarrier();
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier) });
    await sdk.initWorkspace();
    let discards = 0;
    const discard = sdk.deleteArtifact.bind(sdk);
    sdk.deleteArtifact = async (...args) => { discards++; return discard(...args); };
    const restore = loseNextCreateAnswer(org, collection);
    const first = await build(org, dir, only(), { sdk, publicationBarrier: barrier });
    restore();
    const pending = storeOf(org, dir).readGroup(kind, key).pending;
    assert.ok(pending, first.err && first.err.message);
    assert.match(String(first.err && first.err.message), /create-local-draft-kept/);
    assert.equal(discards, 0, 'the build never removes a local draft');
    assert.equal((await readLocalCreateState(sdk, kind, pending.root.id)).state, 'pending', 'the draft is kept');
    const stopped = await build(org, dir, only(), { authorizedAdoption: new Set([`${kind}:${key}`]) });
    assert.match(String(stopped.err && stopped.err.message), /create-completion-required/);
    assert.deepEqual(stopped.writes, [], 'nothing is written while the draft is there');
    // The maker settles the draft through the SDK's public discard.
    await discard(kind, pending.root.id);
    const r = await build(org, dir, only(), { authorizedAdoption: new Set([`${kind}:${key}`]) });
    assert.equal(r.err, undefined, r.err && r.err.message);
    assert.equal(creates(r, collection).length, 0, 'bound, not created again');
    assert.equal(storeOf(org, dir).readGroup(kind, key).pending, null);
  });

  for (const field of ['name', 'description']) {
    test(`a kept ${kind} local draft of a lost create, edited in its ${field} — outside what the build reconciles — stops every rerun with the edit and the files kept`, async () => {
      const org = createFakeBuildOrg({ entities: ENTITIES });
      const dir = newDir();
      const barrier = createPublicationBarrier();
      const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier) });
      await sdk.initWorkspace();
      const restore = loseNextCreateAnswer(org, collection);
      const first = await build(org, dir, only(), { sdk, publicationBarrier: barrier });
      restore();
      const pending = storeOf(org, dir).readGroup(kind, key).pending;
      assert.ok(pending, first.err && first.err.message);
      const id = pending.root.id;
      const label = 'A maker\'s local edit the declaration does not carry';
      await sdk.updateElement(kind, id, `/${field}`, label);
      assert.equal((await readLocalCreateState(sdk, kind, id)).state, 'pending');
      const before = filesOf(dir);
      for (let i = 0; i < 2; i++) {
        const next = await build(org, dir, only(), { authorizedAdoption: new Set([`${kind}:${key}`]) });
        assert.match(String(next.err && next.err.message), /create-completion-required/, `rerun ${i + 1}`);
        assert.deepEqual(next.writes, [], `rerun ${i + 1} writes nothing`);
        assert.equal((await next.sdk.getArtifact(kind, id))[field], label, `rerun ${i + 1} keeps the edit`);
        assert.deepEqual(filesOf(dir), before, `rerun ${i + 1} keeps every file as it was`);
      }
      assert.ok(storeOf(org, dir).readGroup(kind, key).pending, 'the attempt is kept');
    });
  }

  // A maker edits the local draft (here through a second SDK over the same workspace) while the build's create request is
  // outstanding, then the answer is lost. Being the same run, and the copy being a pending create, does not make the draft the
  // build's to remove: it now holds the maker's edit, so it is kept byte for byte and the build says so.
  test(`a ${kind} draft edited while its create answer is outstanding is kept with the edit, and the build says why`, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const id = derived(stableSpec())[kind];
    const edit = 'Maker edit during the outstanding create';
    const barrier = createPublicationBarrier();
    const observer = createAttemptSendObserver();
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, observer) });
    await sdk.initWorkspace();
    const post = org.httpClient.post.bind(org.httpClient);
    let edited = false;
    let buildLeaseHeld = false;
    org.httpClient.post = async (url, ...args) => {
      const response = await post(url, ...args);
      if (!edited && new RegExp(`/${collection}(?:\\?|$)`).test(url)) {
        edited = true;
        // The edit is local authoring, not a second build: the build's lease is held throughout and refuses one.
        await assert.rejects(withAppBuildLease({ workspaceDir: dir, appUniqueName: appUniqueName(only()) }, () => assert.fail('another build must not enter')), { code: 'build-locked' });
        buildLeaseHeld = true;
        const editor = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
        await editor.initWorkspace();
        await editor.updateElement(kind, id, '/name', edit);
        const during = await readLocalCreateState(editor, kind, id);
        assert.equal(during.state, 'pending');
        assert.equal(during.draft.name, edit);
        throw Object.assign(new Error('response lost after the local edit was saved'), { code: 'ECONNRESET' });
      }
      return response;
    };
    const first = await build(org, dir, only(), { sdk, publicationBarrier: barrier, sendObserver: observer });
    org.httpClient.post = post;
    assert.equal(edited, true);
    assert.equal(buildLeaseHeld, true);
    const local = await readLocalCreateState(sdk, kind, id);
    assert.equal(local.state, 'pending', 'same-run membership does not prove the draft still holds only what the build made');
    assert.equal(local.draft.name, edit);
    assert.match(String(first.err && first.err.message), /create-local-draft-kept/);
    assert.deepEqual(first.writes.filter((c) => c.method === 'DELETE'), []);
    assert.ok(storeOf(org, dir).readGroup(kind, key).pending, 'the attempt is kept');
    const before = filesOf(dir);
    const next = await build(org, dir, only(), { authorizedAdoption: new Set([`${kind}:${key}`]) });
    assert.match(String(next.err && next.err.message), /create-completion-required/);
    assert.deepEqual(next.writes, []);
    assert.deepEqual(filesOf(dir), before, 'the next build keeps every file as it was');
  });

  // An edit that lands between the SDK writing the draft and the push: the workspace no longer holds the draft the build made, so
  // the create is not sent at all, and the draft is kept with the edit.
  test(`a ${kind} draft edited before its push is not sent and is kept with the edit`, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const id = derived(stableSpec())[kind];
    const edit = 'Maker edit before the push';
    const barrier = createPublicationBarrier();
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier) });
    await sdk.initWorkspace();
    const createArtifact = sdk.createArtifact.bind(sdk);
    sdk.createArtifact = async (...args) => {
      const art = await createArtifact(...args);
      const editor = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
      await editor.initWorkspace();
      await editor.updateElement(kind, id, '/name', edit);
      return art;
    };
    const first = await build(org, dir, only(), { sdk, publicationBarrier: barrier });
    assert.ok(first.err, 'the build stops');
    assert.equal(creates(first, collection).length, 0, 'a draft the build cannot show is its own is never sent');
    assert.match(String(first.err.message), /create-local-draft-changed[\s\S]*create-local-draft-kept/);
    const local = await readLocalCreateState(sdk, kind, id);
    assert.equal(local.state, 'pending');
    assert.equal(local.draft.name, edit);
  });

  // A second local process (another SDK on the same workspace, which the build's lease does not exclude) edits the draft at the
  // two points a check of the workspace cannot cover. Run as a real separate process, while the build holds its lease.
  const editElsewhere = async (dir, org, id, field, value) => {
    await assert.rejects(withAppBuildLease({ workspaceDir: dir, appUniqueName: appUniqueName(only()) }, () => assert.fail('another build must not enter')), { code: 'build-locked' });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const out = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'edit-local-draft.js'), dir, org.origin, kind, id, field, value], { env, encoding: 'utf8', timeout: 60000 }));
    assert.equal(out.edited, true);
    assert.notEqual(out.pid, process.pid);
  };

  // Window 1: after the create's answer was lost, when a cleanup would compare the draft and then remove it. The build removes
  // no local draft at all, so there is no comparison an edit can slip past: the edit is kept, and so is the attempt.
  test(`a ${kind} draft another process edits after its create answer was lost is never removed`, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const id = derived(stableSpec())[kind];
    const edit = 'Maker edit after the lost answer';
    const barrier = createPublicationBarrier();
    const observer = createAttemptSendObserver();
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, observer) });
    await sdk.initWorkspace();
    let discards = 0;
    sdk.deleteArtifact = async () => { discards++; throw new Error('the build must not remove a local draft'); };
    const post = org.httpClient.post.bind(org.httpClient);
    let edited = false;
    org.httpClient.post = async (url, ...args) => {
      const response = await post(url, ...args);
      if (!edited && new RegExp(`/${collection}(?:\\?|$)`).test(url)) {
        edited = true;
        await editElsewhere(dir, org, id, 'name', edit);
        throw Object.assign(new Error('response lost after the create was applied'), { code: 'ECONNRESET' });
      }
      return response;
    };
    const first = await build(org, dir, only(), { sdk, publicationBarrier: barrier, sendObserver: observer });
    org.httpClient.post = post;
    assert.equal(edited, true);
    assert.equal(discards, 0, 'no local discard is attempted');
    const local = await readLocalCreateState(sdk, kind, id);
    assert.equal(local.state, 'pending');
    assert.equal(local.draft.name, edit, 'the other process\'s edit is kept');
    assert.match(String(first.err && first.err.message), /create-local-draft-kept/);
    assert.ok(storeOf(org, dir).readGroup(kind, key).pending, 'the attempt is kept, not released');
    const next = await build(org, dir, only(), { authorizedAdoption: new Set([`${kind}:${key}`]) });
    assert.match(String(next.err && next.err.message), /create-completion-required/);
    assert.deepEqual(next.writes, [], 'nothing is sent again');
  });

  // Window 2: after the draft was made and checked, before the push reads it. The create request the push dispatches is
  // compared at the transport with the body the draft the build made serialises to, so the edited draft is refused unsent.
  for (const field of ['name', 'description']) {
    test(`a ${kind} draft another process edits in its ${field} just before the push is refused at the dispatch, unsent`, async () => {
      const org = createFakeBuildOrg({ entities: ENTITIES });
      const dir = newDir();
      const id = derived(stableSpec())[kind];
      const edit = `Maker ${field} just before the push`;
      const barrier = createPublicationBarrier();
      const observer = createAttemptSendObserver();
      const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, observer) });
      await sdk.initWorkspace();
      const push = sdk.pushArtifact.bind(sdk);
      let edited = false;
      sdk.pushArtifact = async (type, artifactId, ...args) => {
        if (type === kind && normalize(artifactId) === normalize(id) && !edited) {
          edited = true;
          await editElsewhere(dir, org, id, field, edit);
        }
        return push(type, artifactId, ...args);
      };
      const first = await build(org, dir, only(), { sdk, publicationBarrier: barrier, sendObserver: observer });
      assert.equal(edited, true);
      assert.equal(creates(first, collection).length, 0, 'the edited draft never reaches the service');
      assert.equal(first.err && first.err.code, 'create-local-draft-changed', first.err && first.err.message);
      const local = await readLocalCreateState(sdk, kind, id);
      assert.equal(local.state, 'pending');
      assert.equal(local.draft[field], edit, 'the edit is kept');
      const pending = storeOf(org, dir).readGroup(kind, key).pending;
      assert.ok(pending, 'the attempt is kept');
      assert.equal(pending.sendWindow && pending.sendWindow.possible, 0, 'the refused create is never counted as possibly dispatched');
      const next = await build(org, dir, only());
      assert.match(String(next.err && next.err.message), /create-completion-required/);
      assert.deepEqual(next.writes, [], 'nothing is sent while the draft is there');
    });
  }

  // The native SDK pushes a draft as a PATCH once it has been saved: a second SDK on the same workspace (which the build's lease
  // does not exclude) saves the draft and edits it between the build's check and its push. The pinned row's whole write boundary
  // is closed, so the PATCH is refused unsent and the create is never acknowledged as an update of the maker's edit.
  test(`a ${kind} draft another SDK saves and edits before the push is never sent as a PATCH`, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const id = derived(stableSpec())[kind];
    const barrier = createPublicationBarrier();
    const observer = createAttemptSendObserver();
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, observer) });
    await sdk.initWorkspace();
    const transmitted = [];
    const patch = org.httpClient.patch.bind(org.httpClient);
    org.httpClient.patch = async (...args) => { transmitted.push(args); return patch(...args); };
    const push = sdk.pushArtifact.bind(sdk);
    let saved = false;
    sdk.pushArtifact = async (type, artifactId, ...args) => {
      if (type === kind && normalize(artifactId) === normalize(id) && !saved) {
        await assert.rejects(withAppBuildLease({ workspaceDir: dir, appUniqueName: appUniqueName(only()) }, () => assert.fail('another build must not enter')), { code: 'build-locked' });
        const editor = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
        await editor.initWorkspace();
        assert.equal((await editor.pushArtifact(kind, id)).saved, true);
        await editor.updateElement(kind, id, '/name', 'Maker edit after an independent save');
        saved = true;
      }
      return push(type, artifactId, ...args);
    };
    const r = await build(org, dir, only(), { sdk, publicationBarrier: barrier, sendObserver: observer });
    org.httpClient.patch = patch;
    assert.equal(saved, true);
    assert.deepEqual(transmitted, [], 'the edited draft never reaches the service as an update');
    assert.match(String(r.err && r.err.message), /create-local-draft-changed/);
    const pending = storeOf(org, dir).readGroup(kind, key).pending;
    assert.ok(pending, 'the attempt is kept');
    assert.equal(pending.sendWindow && pending.sendWindow.possible, 0, 'the refused PATCH is never counted as dispatched');
  });

  // The recovery order the build gives for a kept draft. Its change is proved only against the declaration it was prepared from,
  // so the maker's change goes in AFTER the original has settled: putting it into the spec before the discard is refused (and
  // keeps the attempt); keeping the original, discarding the local copy, building, then applying the change works.
  test(`a kept ${kind} draft settles in the order the build gives: original declaration, local discard, build, then the change`, async () => {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const id = derived(stableSpec())[kind];
    const spec = only();
    const edit = 'A local description the maker wants to keep';
    const barrier = createPublicationBarrier();
    const observer = createAttemptSendObserver();
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, observer) });
    await sdk.initWorkspace();
    const push = sdk.pushArtifact.bind(sdk);
    let edited = false;
    sdk.pushArtifact = async (type, artifactId, ...args) => {
      if (type === kind && normalize(artifactId) === normalize(id) && !edited) {
        edited = true;
        const editor = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
        await editor.initWorkspace();
        await editor.updateElement(kind, id, '/description', edit);
      }
      return push(type, artifactId, ...args);
    };
    const first = await build(org, dir, spec, { sdk, publicationBarrier: barrier, sendObserver: observer });
    assert.match(String(first.err && first.err.message), /create-local-draft-changed/);
    const said = chainText(first.err);
    assert.match(said, /create-local-draft-kept/);
    assert.match(said, /1\. keep the change you want[\s\S]*2\. keep the spec's declaration[\s\S]*3\. discard only the local copy[\s\S]*deleteArtifact[\s\S]*removes nothing on the service and leaves the managed binding store as it is[\s\S]*4\. run the build again with that original declaration[\s\S]*5\. only then put your change into the spec/);
    const token = storeOf(org, dir).readGroup(kind, key).pending.token;
    const changed = structuredClone(spec);
    changed[kind === 'view' ? 'views' : 'charts'][0].description = edit;
    // While the draft is there, the stop gives the same order.
    const stopped = await build(org, dir, spec, { sendObserver: createAttemptSendObserver() });
    assert.deepEqual(stopped.writes, []);
    assert.match(chainText(stopped.err), /create-completion-required[\s\S]*1\. keep the change you want/);
    await sdk.deleteArtifact(kind, id);
    // The change put into the spec before the original settled: refused, nothing written, the same attempt kept.
    const early = await build(org, dir, changed, { sendObserver: createAttemptSendObserver() });
    assert.match(chainText(early.err), /declared differently since its change was prepared/);
    assert.deepEqual(early.writes, []);
    assert.equal(storeOf(org, dir).readGroup(kind, key).pending.token, token);
    // The order the build gives: the original declaration first, then the change.
    const original = await build(org, dir, spec, { sendObserver: createAttemptSendObserver() });
    assert.equal(original.err, undefined, original.err && chainText(original.err));
    assert.equal(storeOf(org, dir).readGroup(kind, key).pending, null);
    const then = await build(org, dir, changed, { sendObserver: createAttemptSendObserver() });
    assert.equal(then.err, undefined, then.err && chainText(then.err));
    assert.ok(then.writes.some((c) => c.method === 'PATCH' && c.path.startsWith(`/${collection}(`) && c.body && c.body.description === edit), 'the change is applied after the original settled');
    assert.equal(storeOf(org, dir).readGroup(kind, key).pending, null);
  });
}

test('a pinned create passes only the body it was pinned to; anything else that could create the row is refused unsent', async () => {
  const barrier = createPublicationBarrier();
  assert.equal(barrier.gatesTransport(), false);
  const sent = [];
  const gate = barrier.gateRequest(async (req) => { sent.push(req); return { statusCode: 204, headers: {}, body: '' }; });
  assert.equal(barrier.gatesTransport(), true);
  const id = 'a1d1e2a3-8ac8-5f10-8300-6ddd477124af';
  const url = 'https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries?$select=savedqueryid';
  const body = { name: 'Declared Items', fetchxml: '<fetch/>', savedqueryid: id };
  const send = (req) => gate({ headers: {}, ...req });
  const code = (answer) => JSON.parse(answer.body).error.code;
  const pinned = () => barrier.pinCreate({ collection: 'savedqueries', idField: 'savedqueryid', id: id.toUpperCase(), matches: (b) => JSON.stringify(b) === JSON.stringify(body) });
  // Before any pin, and after its release, every request goes as it came.
  await send({ method: 'POST', url, body: JSON.stringify({ ...body, name: 'Other' }) });
  assert.equal(sent.length, 1);
  let pin = pinned();
  await send({ method: 'POST', url, body: JSON.stringify(body) });
  assert.equal(sent.length, 2);
  assert.equal(pin.checked, true);
  await send({ method: 'POST', url, body: JSON.stringify({ name: 'Another row', savedqueryid: '{0B0B0B0B-0000-0000-0000-000000000001}' }) });
  await send({ method: 'GET', url: `https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(${id})` });
  assert.equal(sent.length, 4, 'another row\'s create and a read are not the pinned create');
  assert.equal(pin.refused, false);
  const refusals = [
    { method: 'POST', url, body: JSON.stringify({ ...body, name: 'Edited' }) },
    { method: 'POST', url: 'https://contoso.crm.dynamics.com/api/data/v9.2/savedquer%69es', body: JSON.stringify({ ...body, savedqueryid: `{${id.toUpperCase()}}`, description: 'x' }) },
    { method: 'POST', url, body: '{not json' },
    { method: 'POST', url, body: JSON.stringify({ name: 'No id' }) },
    { method: 'POST', url: 'https://contoso.crm.dynamics.com/api/data/v9.2/$batch', body: `--b\r\nPOST savedqueries HTTP/1.1\r\n\r\n{"savedqueryid":"${id}"}\r\n--b--` },
  ];
  for (const req of refusals) {
    const answer = await send(req);
    assert.equal(answer.statusCode, 409, req.body);
    assert.equal(code(answer), 'create-local-draft-changed');
  }
  assert.equal(sent.length, 4, 'nothing refused reached the transport');
  assert.equal(pin.refused, true);
  pin.release();
  await send({ method: 'POST', url, body: JSON.stringify({ ...body, name: 'Edited' }) });
  assert.equal(sent.length, 5, 'a released pin checks nothing');
  pin = pinned();
  // A batch is read part by part, the way the service reads it (its Content-Type's boundary, change sets opened).
  const batch = (parts) => ({
    method: 'POST',
    url: 'https://contoso.crm.dynamics.com/api/data/v9.2/$batch',
    headers: { 'Content-Type': 'multipart/mixed; boundary=batch_p' },
    body: ['--batch_p', 'Content-Type: multipart/mixed; boundary=changeset_p', '', ...parts.flatMap((p, i) => ['--changeset_p', 'Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${i + 1}`, '', p]), '--changeset_p--', '--batch_p--', ''].join('\r\n'),
  });
  const otherRow = '0b0b0b0b-0000-0000-0000-000000000002';
  await send(batch([`POST /api/data/v9.2/savedqueries HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"savedqueryid":"${otherRow}","name":"Other"}`, `PATCH /api/data/v9.2/savedqueries(${otherRow}) HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"name":"Other again"}`]));
  await send({ method: 'PATCH', url: `https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(${otherRow})`, body: JSON.stringify({ name: 'Another row' }) });
  await send({ method: 'POST', url: 'https://contoso.crm.dynamics.com/api/data/v9.2/PublishXml', body: JSON.stringify({ ParameterXml: '<importexportxml><entities><entity>contoso_item</entity></entities></importexportxml>' }) });
  await send({ method: 'HEAD', url: `https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(${id})` });
  assert.equal(sent.length, 9, 'a change set of another row, a write of another row, a publish and a read pass');
  assert.equal(pin.refused, false);
  const escaped = JSON.stringify({ ...body, name: 'Not declared' }).replace(id, `\\u0061${id.slice(1)}`);
  assert.equal(escaped.includes(id), false);
  const rowWrites = [
    // The native SDK's push of a draft that another process has saved: an update of the pinned row.
    { method: 'PATCH', url: `https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(${id})?$select=savedqueryid`, body: JSON.stringify({ name: 'Edited' }) },
    { method: 'PUT', url: `https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(${id.toUpperCase()})/name`, body: JSON.stringify({ value: 'Edited' }) },
    { method: 'DELETE', url: `https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries({${id}})` },
    { method: 'PATCH', url: `https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(savedqueryid=${id})`, body: JSON.stringify({ name: 'Edited' }) },
    { method: 'PATCH', url: 'https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(name=\'Declared Items\')', body: JSON.stringify({ name: 'Edited' }) },
    { method: 'PATCH', url: `https://contoso.crm.dynamics.com/api/data/v9.2/savedquer%69es(${id})`, body: JSON.stringify({ name: 'Edited' }) },
    { method: 'POST', url: 'https://contoso.crm.dynamics.com/api/data/v9.2/AddSolutionComponent', body: JSON.stringify({ ComponentId: id.replace(/-/g, '').toUpperCase() }) },
    // A change set whose create names the row only through a JSON escape, a PATCH of the row inside a change set, the exact
    // create inside a change set, and a body that cannot be read as a batch.
    batch([`POST /api/data/v9.2/savedqueries HTTP/1.1\r\nContent-Type: application/json\r\n\r\n${escaped}`]),
    batch([`PATCH savedqueries(${id}) HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"name":"Edited"}`]),
    batch([`POST savedqueries HTTP/1.1\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`]),
    { method: 'POST', url: 'https://contoso.crm.dynamics.com/api/data/v9.2/$batch', headers: { 'content-type': 'multipart/mixed; boundary=batch_p' }, body: 'not a batch' },
  ];
  for (const req of rowWrites) {
    const answer = await send(req);
    assert.equal(answer.statusCode, 409, `${req.method} ${req.url}`);
    assert.equal(code(answer), 'create-local-draft-changed');
  }
  assert.equal(sent.length, 9, 'no write of the pinned row reached the transport');
  pin.release();
  // Each pin is its own: releasing one leaves another pin of another row holding.
  const a = barrier.pinCreate({ collection: 'savedqueries', idField: 'savedqueryid', id, matches: () => false });
  const b = barrier.pinCreate({ collection: 'savedqueries', idField: 'savedqueryid', id: otherRow, matches: () => false });
  a.release();
  assert.equal((await send({ method: 'PATCH', url: `https://contoso.crm.dynamics.com/api/data/v9.2/savedqueries(${otherRow})`, body: '{}' })).statusCode, 409);
  assert.equal(b.refused, true);
  assert.equal(a.refused, false);
  b.release();
  assert.throws(() => barrier.pinCreate({ collection: 'savedqueries', idField: 'savedqueryid', id: '', matches: () => true }), TypeError);
});

// Production runs creates in parallel (the engine's concurrency; charts through mapLimit). Each create holds its own pin until
// its push ends, so one create finishing never releases another's pin while that one is still to push: a second local process
// that edits the second chart then is refused at the dispatch.
test('one parallel create finishing never releases another create\'s pin', async () => {
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const dir = newDir();
  const spec = stableSpec({ views: [] });
  spec.charts.push({ ...spec.charts[0], name: 'Other Kind' });
  const firstId = derived(stableSpec()).chart;
  const barrier = createPublicationBarrier();
  const observer = createAttemptSendObserver();
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, observer) });
  await sdk.initWorkspace();
  let ready;
  let released;
  const secondReady = new Promise((resolve) => { ready = resolve; });
  const firstReleased = new Promise((resolve) => { released = resolve; });
  const pinCreate = barrier.pinCreate.bind(barrier);
  const releases = [];
  barrier.pinCreate = (args) => {
    const pin = pinCreate(args);
    const release = pin.release;
    pin.release = () => { releases.push(pin.id); release(); if (pin.id === firstId) released(); };
    return pin;
  };
  const push = sdk.pushArtifact.bind(sdk);
  let secondId;
  let releasedEarly;
  sdk.pushArtifact = async (kind, id, ...args) => {
    if (kind === 'chart' && normalize(id) === normalize(firstId)) await secondReady;
    else if (kind === 'chart') {
      secondId = normalize(id);
      ready();
      await firstReleased;
      releasedEarly = releases.includes(secondId);
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const out = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, 'helpers', 'edit-local-draft.js'), dir, org.origin, 'chart', id, 'name', 'Concurrent maker edit'], { env, encoding: 'utf8', timeout: 60000 }));
      assert.equal(out.edited, true);
    }
    return push(kind, id, ...args);
  };
  const r = await build(org, dir, spec, { sdk, publicationBarrier: barrier, sendObserver: observer, concurrency: 2 });
  assert.ok(secondId, 'both charts were pushed');
  assert.equal(releasedEarly, false, 'the first create\'s end left the second create\'s pin in place');
  assert.deepEqual(r.writes.filter((c) => c.method === 'POST' && c.body && normalize(c.body.savedqueryvisualizationid) === secondId), [], 'the edited second chart is never sent');
  assert.match(String(r.err && r.err.message), /create-local-draft-changed/);
  assert.ok(storeOf(org, dir).readGroup('chart', 'contoso_item/Other Kind').pending, 'its attempt is kept');
  assert.deepEqual(new Set(releases), new Set([normalize(firstId), secondId]), 'each pin was released by its own create');
});

// The commit of a view's change repeats its key, which the spec controls without a length limit, so the bytes the store reserves
// for it are worked out from the key (planFor's completionBytes): a long key gets a reservation its commit fits in, and a key whose
// commit could outgrow what one change may reserve is refused before anything is prepared or sent.
test('a long view key reserves the room its commit takes; a key too long to record is refused before the send', async () => {
  for (const [label, k] of [['plain', 'k'.repeat(384 * 1024)], ['escaped', '"'.repeat(200 * 1024)]]) {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const spec = stableSpec({ charts: [] });
    spec.views[0].key = k;
    let before = null;
    const post = org.httpClient.post.bind(org.httpClient);
    org.httpClient.post = async (url, ...args) => {
      const answer = await post(url, ...args);
      if (/\/AddSolutionComponent(?:\?|$)/i.test(url)) {
        const store = storeOf(org, dir);
        const pending = store.readGroup('view', k).pending;
        if (pending) before = { size: fs.statSync(store.file).size, ...pending.completionReserve };
      }
      return answer;
    };
    const r = await build(org, dir, spec, { sendObserver: createAttemptSendObserver() });
    assert.equal(r.err, undefined, r.err && r.err.message.slice(0, 400));
    assert.ok(before, label);
    const store = storeOf(org, dir);
    assert.ok(store.readGroup('view', k).committed, label);
    const growth = fs.statSync(store.file).size - before.size;
    assert.ok(growth <= before.bytes - before.used, `${label}: the commit grew the store by ${growth}, within the ${before.bytes - before.used} its attempt held`);
  }
  // Raw, this key is half of what its escaped copies take; each of its quotes is written as two bytes in the store.
  for (const k of ['k'.repeat(1536 * 1024), '"'.repeat(768 * 1024)]) {
    const org = createFakeBuildOrg({ entities: ENTITIES });
    const dir = newDir();
    const spec = stableSpec({ charts: [] });
    spec.views[0].key = k;
    const r = await build(org, dir, spec, { sendObserver: createAttemptSendObserver() });
    assert.match(String(r.err && chainText(r.err)), /managed-binding-store-full[\s\S]*too long to record[\s\S]*nothing was sent/);
    assert.deepEqual(r.writes, [], 'nothing is sent');
    const g = storeOf(org, dir).readGroup('view', k);
    assert.equal(g.pending, null, 'no attempt is prepared');
    assert.equal(g.committed, null);
  }
});

// --- standalone discovery of a build whose spec leaves the app's unique name to be derived --------------------------------------
test('standalone discovery finds the store of a build whose spec omits app.uniqueName, by the name the build derived', async () => {
  const { openStandaloneManagedFence } = require('../lib/managed-standalone-fence.js');
  const org = createFakeBuildOrg({ entities: ENTITIES });
  const appDir = newDir();
  const workspaceDir = path.join(appDir, '.maker-workspace');
  fs.mkdirSync(workspaceDir);
  const spec = stableSpec({ charts: [] });
  delete spec.app.uniqueName;
  assert.equal(validateAppSpec(spec).ok, true);
  fs.writeFileSync(path.join(appDir, 'app-spec.json'), JSON.stringify(spec));
  const built = await build(org, workspaceDir, spec, { appDir });
  assert.equal(built.err, undefined, built.err && built.err.message);
  assert.equal(storeOf(org, workspaceDir).readGroup('view', VIEW_KEY).committed.publication.state, 'confirmed');
  for (const where of [{ appDir }, { workspaceDir, spec }]) {
    const found = openStandaloneManagedFence({ environment: org.origin, ...where });
    assert.equal(found.absent, false, JSON.stringify(Object.keys(where)));
  }
});
