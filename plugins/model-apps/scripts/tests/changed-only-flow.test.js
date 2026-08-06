'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const flow = require('../lib/changed-only-flow.js');
const snap = require('../lib/apply-snapshot.js');
const store = require('../lib/apply-snapshot-store.js');
const { annotateContentHashes } = require('../lib/content-hash.js');
const { sha256 } = require('../lib/hash.js');

const LIVE = { orgId: 'org-1', envUrl: 'https://e', appUniqueName: 'new_app', appId: 'app-1' };

function ws() { return fs.mkdtempSync(path.join(os.tmpdir(), 'chg-flow-')); }
function rm(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }

// A minimal spec whose single page's bytes come from an injected content store.
function baseSpec() {
  return {
    solution: { uniqueName: 'S', publisherPrefix: 'new' },
    app: { name: 'App', icon: 'i1' },
    appShell: { areas: [{ label: 'M', groups: [{ subAreas: [{ page: 'overview' }] }] }] },
    entities: [{ schemaName: 'new_x', primaryAttribute: { schemaName: 'new_name' }, columns: [] }],
    views: [], charts: [{ entity: 'new_x', name: 'By Status', kind: 'bar' }], forms: [], commands: [], dashboards: [], webResources: [],
    pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } }],
    ai: {}, sampleData: {},
  };
}
const readFor = (content) => (rel) => (rel === 'overview.tsx' ? content : null);
const annotate = (spec, content) => annotateContentHashes(spec, readFor(content));

// Seed an ELIGIBLE snapshot whose priorSpec is `prior` (an already-annotated spec).
function seedEligible(dir, prior, gen = 'g0') {
  const env = snap.makeEnvelope(LIVE, { generation: gen });
  env.priorSpec = prior;
  env.artifacts = { pages: { overview: { pageId: 'page-1', sourceSha: prior.pages[0].__contentSha, deployedSha: prior.pages[0].__contentSha } } };
  snap.markEligible(env);
  store.writeSnapshotAtomic(dir, env);
  return env;
}

// A buildModelApp stub that records the opts it was handed and returns a successful full-ish result. Includes
// verify:{ok:true} — the real buildModelApp runs a mandatory page verify for page-bearing/pages-phase applies,
// and the flow re-blesses only when it passes.
function stubBuild(record, result) {
  return async (spec, opts) => { record.push({ phases: opts.phases, changedOnly: opts.changedOnly }); return result || { ok: true, dryRun: false, created: { app: 'app-1', pages: { overview: 'page-1' } }, verify: { ok: true } }; };
}
function baseDeps(dir, overrides = {}) {
  return {
    log: () => {},
    buildModelApp: overrides.buildModelApp || stubBuild(overrides.record || []),
    buildDeps: {},
    readContent: overrides.readContent || readFor('v2'),
    resolveLiveIdentity: overrides.resolveLiveIdentity || (async () => LIVE),
    ...overrides,
  };
}

// ---- decideChangedOnly (pure) ----

test('decide: no snapshot -> full (establish baseline)', () => {
  const d = flow.decideChangedOnly({ annotatedSpec: annotate(baseSpec(), 'v1'), snapshot: null, live: LIVE });
  assert.strictEqual(d.decision, 'full');
  assert.match(d.reason, /no snapshot/);
});

test('decide: eligible snapshot + page-content-only edit -> fast', () => {
  const prior = annotate(baseSpec(), 'v1');
  const env = seedFromPrior(prior);
  const cur = annotate(baseSpec(), 'v2');
  const d = flow.decideChangedOnly({ annotatedSpec: cur, snapshot: env, live: LIVE });
  assert.strictEqual(d.decision, 'fast');
  assert.deepStrictEqual(d.pageKeys, ['overview']);
});

test('decide: eligible snapshot + no change -> noop', () => {
  const prior = annotate(baseSpec(), 'v1');
  const env = seedFromPrior(prior);
  const d = flow.decideChangedOnly({ annotatedSpec: annotate(baseSpec(), 'v1'), snapshot: env, live: LIVE });
  assert.strictEqual(d.decision, 'noop');
});

test('decide: eligible snapshot + unsupported (chart) edit -> full', () => {
  const prior = annotate(baseSpec(), 'v1');
  const env = seedFromPrior(prior);
  const cur = annotate(baseSpec(), 'v1');
  cur.charts[0].kind = 'pie'; // additive-skipped edit
  const d = flow.decideChangedOnly({ annotatedSpec: cur, snapshot: env, live: LIVE });
  assert.strictEqual(d.decision, 'full');
});

test('decide: fast shape that is NOT page (view append) -> full (unwired in v1)', () => {
  const prior = annotate(baseSpec(), 'v1');
  prior.views = [{ entity: 'new_x', name: 'Active', columns: ['new_name'] }];
  const env = seedFromPrior(prior);
  const cur = annotate(baseSpec(), 'v1');
  cur.views = [{ entity: 'new_x', name: 'Active', columns: ['new_name', 'createdon'] }]; // pure append = fast shape
  const d = flow.decideChangedOnly({ annotatedSpec: cur, snapshot: env, live: LIVE });
  assert.strictEqual(d.decision, 'full', 'a view-append is a valid fast shape but not wired for a partial run in v1');
});

test('decide: identity mismatch -> full (gate blocks)', () => {
  const prior = annotate(baseSpec(), 'v1');
  const env = seedFromPrior(prior);
  const cur = annotate(baseSpec(), 'v2');
  const d = flow.decideChangedOnly({ annotatedSpec: cur, snapshot: env, live: { ...LIVE, orgId: 'other-org' } });
  assert.strictEqual(d.decision, 'full');
  assert.match(d.reason, /orgId/);
});

test('decide: ineligible (debt-carrying) snapshot -> full even for a page edit', () => {
  const prior = annotate(baseSpec(), 'v1');
  const env = snap.makeEnvelope(LIVE, { generation: 'g' });
  env.priorSpec = prior;
  snap.addDebt(env, { artifactType: 'chart', identity: 'new_x|By Status', reason: 'chart-edit-not-convergent' });
  snap.markEligible(env); // stays ineligible with debt
  const d = flow.decideChangedOnly({ annotatedSpec: annotate(baseSpec(), 'v2'), snapshot: env, live: LIVE });
  assert.strictEqual(d.decision, 'full');
  // A debt-carrying snapshot always has eligible:false (invariant), so the gate reports "not eligible"
  // (the direct consequence of the debt) before the debt-specific branch — either way it blocks the fast path.
  assert.match(d.reason, /not eligible|debt/);
});

test('decide: eligible snapshot but app DELETED (live appId null) -> full, not a false noop (C1)', () => {
  const prior = annotate(baseSpec(), 'v1');
  const env = seedFromPrior(prior); // records appId app-1
  // Same spec (would be noop) but the live app is gone -> identity fails -> full build, never noop.
  const d = flow.decideChangedOnly({ annotatedSpec: annotate(baseSpec(), 'v1'), snapshot: env, live: { ...LIVE, appId: null } });
  assert.strictEqual(d.decision, 'full');
  assert.match(d.reason, /app not found live/);
});

// helper: build an eligible in-memory snapshot from a prior annotated spec (no disk)
function seedFromPrior(prior) {
  const env = snap.makeEnvelope(LIVE, { generation: 'g0' });
  env.priorSpec = prior;
  env.artifacts = { pages: { overview: { pageId: 'page-1', sourceSha: prior.pages[0].__contentSha, deployedSha: prior.pages[0].__contentSha } } };
  snap.markEligible(env);
  return env;
}

// ---- resolveLiveIdentity ----

test('resolveLiveIdentity: WhoAmI orgId + app discovery', async () => {
  const id = await flow.resolveLiveIdentity({
    envUrl: 'https://e', appUniqueName: 'new_app',
    whoAmI: async () => ({ status: 200, data: { OrganizationId: 'org-9' } }),
    sdk: { queryRecords: async () => [{ appmoduleid: 'app-9' }] },
  });
  assert.deepStrictEqual(id, { orgId: 'org-9', envUrl: 'https://e', appUniqueName: 'new_app', appId: 'app-9' });
});

test('resolveLiveIdentity: WhoAmI failure -> null (degrade to full build)', async () => {
  const id = await flow.resolveLiveIdentity({ envUrl: 'https://e', appUniqueName: 'a', whoAmI: async () => { throw new Error('401'); }, sdk: {} });
  assert.strictEqual(id, null);
});

test('resolveLiveIdentity: app not found -> appId null (tolerated; fresh baseline)', async () => {
  const id = await flow.resolveLiveIdentity({
    envUrl: 'https://e', appUniqueName: 'a',
    whoAmI: async () => ({ data: { OrganizationId: 'org-9' } }),
    sdk: { queryRecords: async () => [] },
  });
  assert.strictEqual(id.appId, null);
  assert.strictEqual(id.orgId, 'org-9');
});

// ---- assembleBaselineSnapshot ----

test('baseline: fresh (no prior) -> eligible, empty debt, identity+artifacts recorded', () => {
  const env = flow.assembleBaselineSnapshot({ annotatedSpec: annotate(baseSpec(), 'v1'), created: { app: 'app-1', pages: { overview: 'page-1' } }, live: LIVE, prior: null });
  assert.strictEqual(env.eligible, true);
  assert.strictEqual(env.debt.length, 0);
  assert.strictEqual(env.appId, 'app-1');
  assert.strictEqual(env.orgId, 'org-1');
  assert.ok(env.artifacts.pages.overview);
});

test('baseline: an unsupported (chart) edit vs prior -> INELIGIBLE with sticky debt', () => {
  const prior = annotate(baseSpec(), 'v1');
  const cur = annotate(baseSpec(), 'v1');
  cur.charts[0].kind = 'pie';
  const env = flow.assembleBaselineSnapshot({ annotatedSpec: cur, created: { app: 'app-1' }, live: LIVE, prior: { priorSpec: prior, debt: [] } });
  assert.strictEqual(env.eligible, false);
  assert.ok(env.debt.some((d) => d.artifactType === 'chart'));
});

test('baseline: prior debt is STICKY across a full rebuild (never self-heals)', () => {
  const prior = annotate(baseSpec(), 'v1');
  const priorSnap = { priorSpec: prior, debt: [{ artifactType: 'chart', identity: 'new_x|By Status', reason: 'chart-edit-not-convergent' }] };
  // No new diff (same spec), but the prior debt must carry over -> ineligible.
  const env = flow.assembleBaselineSnapshot({ annotatedSpec: annotate(baseSpec(), 'v1'), created: { app: 'app-1' }, live: LIVE, prior: priorSnap });
  assert.strictEqual(env.eligible, false);
  assert.ok(env.debt.some((d) => d.reason === 'chart-edit-not-convergent'), 'a plain full rebuild must not clear the debt');
});

// ---- assembleFastSnapshot ----

test('fast snapshot: refreshes priorSpec + the changed page hash, stays eligible, bumps generation', () => {
  const prior = annotate(baseSpec(), 'v1');
  const snapshot = seedFromPrior(prior);
  const cur = annotate(baseSpec(), 'v2');
  const env = flow.assembleFastSnapshot({ snapshot, annotatedSpec: cur, created: { pages: { overview: 'page-1' }, pageDeployedShas: { overview: sha256('v2') } }, pageKeys: ['overview'], generation: 'g1' });
  assert.strictEqual(env.eligible, true);
  assert.strictEqual(env.generation, 'g1');
  assert.strictEqual(env.artifacts.pages.overview.sourceSha, sha256('v2'));
  assert.strictEqual(env.artifacts.pages.overview.deployedSha, sha256('v2'));
  assert.strictEqual(env.priorSpec.pages[0].__contentSha, sha256('v2'));
});

test('fast snapshot: a nav-resolved page records the MEASURED deployedSha (≠ source), not an assumption', () => {
  const prior = annotate(baseSpec(), 'v1');
  const snapshot = seedFromPrior(prior);
  const cur = annotate(baseSpec(), 'v2');
  // The build reports a DIFFERENT deployed hash (PAGEREF resolved to GUIDs at upload).
  const env = flow.assembleFastSnapshot({ snapshot, annotatedSpec: cur, created: { pages: { overview: 'page-1' }, pageDeployedShas: { overview: 'measured-deployed-hash' } }, pageKeys: ['overview'], generation: 'g1' });
  assert.strictEqual(env.artifacts.pages.overview.sourceSha, sha256('v2'), 'source hash from the spec');
  assert.strictEqual(env.artifacts.pages.overview.deployedSha, 'measured-deployed-hash', 'deployed hash is the measured build value');
});

// ---- runChangedOnlyApply (orchestration, real temp workspace) ----

test('run: FAST apply calls buildModelApp pages-only + re-blesses the snapshot eligible', async () => {
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { record, buildModelApp: stubBuild(record), readContent: readFor('v2') }) });
    assert.strictEqual(r.changedOnly.decision, 'fast');
    assert.deepStrictEqual(record[0].phases, ['pages'], 'buildModelApp ran pages-only');
    assert.strictEqual(record[0].changedOnly.fastApply, true);
    assert.strictEqual(record[0].changedOnly.resolvedAppId, 'app-1');
    assert.strictEqual(record[0].changedOnly.skipSitemapFinalize, true);
    assert.deepStrictEqual(record[0].changedOnly.selectedKeys, ['overview'], 'only the changed page key is uploaded (no clobber of unchanged pages)');
    const disk = store.readSnapshot(dir);
    assert.strictEqual(disk.eligible, true, 'snapshot re-blessed eligible after a verified fast apply');
    assert.strictEqual(disk.artifacts.pages.overview.sourceSha, sha256('v2'));
    assert.notStrictEqual(disk.generation, 'g0', 'generation bumped on the CAS write');
  } finally { rm(dir); }
});

test('run: a fast apply whose page VERIFY did not pass is NOT re-blessed (fail-closed)', async () => {
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    const failing = async () => ({ ok: true, dryRun: false, created: { app: 'app-1', pages: { overview: 'page-1' } }, verify: { ok: false, missing: [{ kind: 'page', name: 'Overview' }] } });
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: failing, readContent: readFor('v2') }) });
    assert.strictEqual(r.changedOnly.decision, 'fast');
    assert.strictEqual(store.readSnapshot(dir).eligible, false, 'a fast apply with a failed page verify must leave the snapshot invalidated');
  } finally { rm(dir); }
});

test('run: a FAILED fast apply leaves the snapshot INVALIDATED (not re-blessed)', async () => {
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    const record = [];
    const failing = async (s, o) => { record.push({ phases: o.phases }); return { ok: false, errors: ['boom'] }; };
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: failing, readContent: readFor('v2') }) });
    assert.strictEqual(r.ok, false);
    const disk = store.readSnapshot(dir);
    assert.strictEqual(disk.eligible, false, 'a failed fast apply must leave the snapshot invalidated (fail-safe)');
  } finally { rm(dir); }
});

test('run: NOOP does not call buildModelApp and reports up-to-date', async () => {
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), readContent: readFor('v1') }) });
    assert.strictEqual(r.noop, true);
    assert.strictEqual(record.length, 0, 'buildModelApp is not called for a noop');
  } finally { rm(dir); }
});

test('run: FULL baseline (fresh app, appId null at start) writes an ELIGIBLE snapshot', async () => {
  const dir = ws();
  try {
    const record = [];
    // A FRESH baseline: the app does NOT exist when the flow starts, so resolveLiveIdentity returns
    // appId:null; the build creates it (created.app='app-1'), and the baseline is certified eligible.
    const freshIdentity = async () => ({ orgId: 'org-1', envUrl: 'https://e', appUniqueName: 'new_app', appId: null });
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), resolveLiveIdentity: freshIdentity, readContent: readFor('v1') }) });
    assert.strictEqual(r.changedOnly.decision, 'full');
    assert.strictEqual(record[0].phases, undefined, 'a full build has no explicit phase range (=> PHASES)');
    assert.ok(!record[0].changedOnly, 'a full build carries no changedOnly seam');
    const disk = store.readSnapshot(dir);
    assert.ok(disk, 'baseline snapshot persisted');
    assert.strictEqual(disk.eligible, true, 'a fresh-create baseline is eligible');
    assert.strictEqual(disk.appId, 'app-1');
  } finally { rm(dir); }
});

test('run: FULL baseline against a PRE-EXISTING app is recorded INELIGIBLE (cannot certify convergence)', async () => {
  const dir = ws();
  try {
    const record = [];
    // The app ALREADY exists at flow start (appId non-null) -> a full build may have additive-skipped a
    // diverged artifact -> uncertified-baseline debt -> ineligible (Sol #7 / Opus H2).
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), resolveLiveIdentity: async () => LIVE, readContent: readFor('v1') }) });
    assert.strictEqual(r.changedOnly.decision, 'full');
    const disk = store.readSnapshot(dir);
    assert.strictEqual(disk.eligible, false, 'a pre-existing-app baseline cannot be certified eligible');
    assert.ok(disk.debt.some((d) => /uncertified-baseline/.test(d.reason)));
  } finally { rm(dir); }
});

test('run: no live identity -> normal full build, snapshot untouched', async () => {
  const dir = ws();
  try {
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), resolveLiveIdentity: async () => null, readContent: readFor('v1') }) });
    assert.strictEqual(r.changedOnly.reason, 'no live identity');
    assert.strictEqual(record.length, 1);
    assert.strictEqual(store.readSnapshot(dir), null, 'no snapshot written when identity is unknown');
  } finally { rm(dir); }
});

test('run: invalidate failure (lease held) ABORTS a fast apply without building', async () => {
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    // Hold the lease with THIS (live, young) pid so invalidateSnapshot cannot acquire it.
    const held = store.acquireLease(dir, { now: () => Date.now(), pid: process.pid, processAlive: () => true, staleMs: store.LEASE_STALE_MS });
    assert.ok(held.ok);
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), readContent: readFor('v2') }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(record.length, 0, 'must not build while another holds the lease');
    assert.match(r.errors[0], /invalidate/);
    store.releaseLease(held);
  } finally { rm(dir); }
});

test('run: FULL fallback for an unsupported edit records the sticky debt (ineligible baseline)', async () => {
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    const editedSpec = baseSpec();
    editedSpec.charts[0].kind = 'pie'; // additive-skipped -> classify full + debt
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: editedSpec, opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), readContent: readFor('v1') }) });
    assert.strictEqual(r.changedOnly.decision, 'full');
    const disk = store.readSnapshot(dir);
    assert.strictEqual(disk.eligible, false, 'an unsupported edit yields an ineligible baseline');
    assert.ok(disk.debt.some((d) => d.artifactType === 'chart'));
  } finally { rm(dir); }
});

test('run: --sample-data requested but baseline did not seed rows -> forced FULL, not noop (Sol #11)', async () => {
  const dir = ws();
  try {
    // Baseline recorded sampleDataApplied:false (built without --sample-data).
    const env = snap.makeEnvelope(LIVE, { generation: 'g0' });
    env.priorSpec = annotate(baseSpec(), 'v1');
    env.artifacts = { pages: { overview: { pageId: 'page-1', sourceSha: sha256('v1'), deployedSha: sha256('v1') } } };
    env.sampleDataApplied = false;
    snap.markEligible(env);
    store.writeSnapshotAtomic(dir, env);
    const record = [];
    // Same spec (would be noop) but --sample-data is now requested -> must force a full build so rows seed.
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true, sampleData: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), readContent: readFor('v1') }) });
    assert.strictEqual(r.changedOnly.decision, 'full');
    assert.match(r.changedOnly.reason, /sample-data/);
    assert.strictEqual(record.length, 1, 'a full build ran to seed the sample data');
  } finally { rm(dir); }
});
