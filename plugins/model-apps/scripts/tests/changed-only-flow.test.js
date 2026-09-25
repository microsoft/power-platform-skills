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
  assert.deepStrictEqual(id, { orgId: 'org-9', envUrl: 'https://e', appUniqueName: 'new_app', appId: 'app-9', appIdKnown: true });
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
  assert.strictEqual(id.appIdKnown, true, 'an empty result is a PROVEN absence, not an unreadable one');
});

// #587.4 — a FAILED app query used to collapse to the same `appId: null` as a proven absence, and
// that null is the single fact certifying a fresh (ELIGIBLE) changed-only baseline. So one transient
// error against a PRE-EXISTING app minted an eligible baseline for an additive build that may not
// have converged, and a later page edit rode the fast path on it.
test('resolveLiveIdentity: a FAILED app query is distinguishable from a proven absence', async () => {
  const id = await flow.resolveLiveIdentity({
    envUrl: 'https://e', appUniqueName: 'a',
    whoAmI: async () => ({ data: { OrganizationId: 'org-9' } }),
    sdk: { queryRecords: async () => { throw new Error('transient 503'); } },
  });
  assert.strictEqual(id.appId, null, 'no id was read');
  assert.strictEqual(id.appIdKnown, false, 'and the caller must be able to tell it was UNREADABLE');
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

// #587 item 1: a teardown that tombstones the snapshot while a changed-only run is between its read and
// its first write must fence that run. Measured before the fix: the run resumed with decision FAST,
// invalidated the tombstoned copy, and its re-bless CAS still matched — leaving the snapshot eligible with
// no debt, i.e. the tombstone erased. The identity lookup is the slow network step where that lands.
for (const [path_, spec, content] of [
  ['FAST', baseSpec, 'v2'],
  ['FULL', () => { const s = baseSpec(); s.charts[0].kind = 'pie'; return s; }, 'v1'],
]) {
  test(`run: a teardown tombstone landing during identity discovery fences a ${path_} apply (#587 item 1)`, async () => {
    const dir = ws();
    try {
      seedEligible(dir, annotate(baseSpec(), 'v1'));
      const record = [];
      const r = await flow.runChangedOnlyApply({ spec: spec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, {
        buildModelApp: stubBuild(record), readContent: readFor(content),
        resolveLiveIdentity: async () => { assert.ok(store.tombstoneSnapshot(dir).ok); return LIVE; },
      }) });
      assert.strictEqual(r.changedOnly.decision, path_.toLowerCase(), 'precondition: the stale read still decides this path');
      assert.strictEqual(r.ok, false, 'the run must fail closed');
      assert.strictEqual(record.length, 0, 'nothing may be applied on a snapshot a teardown has fenced');
      assert.match(r.errors[0], /changed since/);
      const disk = store.readSnapshot(dir);
      assert.ok(snap.isTombstoned(disk) && disk.eligible === false, 'the tombstone survives');
    } finally { rm(dir); }
  });

  // The other window: the tombstone lands AFTER this run's invalidate, while its build is running. The
  // run's re-bless must then lose its CAS rather than write its pre-teardown view over the tombstone.
  test(`run: a teardown tombstone landing during a ${path_} build is not re-blessed away (#587 item 1)`, async () => {
    const dir = ws();
    try {
      seedEligible(dir, annotate(baseSpec(), 'v1'));
      const build = async () => {
        assert.ok(store.tombstoneSnapshot(dir).ok);
        return { ok: true, dryRun: false, created: { app: 'app-1', pages: { overview: 'page-1' } }, verify: { ok: true } };
      };
      const r = await flow.runChangedOnlyApply({ spec: spec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: build, readContent: readFor(content) }) });
      assert.strictEqual(r.changedOnly.decision, path_.toLowerCase());
      const disk = store.readSnapshot(dir);
      assert.ok(snap.isTombstoned(disk) && disk.eligible === false, `the tombstone must survive the re-bless; got ${JSON.stringify({ eligible: disk && disk.eligible, debt: disk && disk.debt })}`);
    } finally { rm(dir); }
  });
}

// The same fence for a FIRST build, which has no snapshot to be fenced by. Its baseline write expected
// "no snapshot", and a teardown that found none either wrote nothing, so the build blessed an app the
// teardown had just deleted — the fence above only covered a workspace that already had a snapshot. The
// build now claims a placeholder before it builds, and a teardown tombstones even an empty workspace.
const FRESH = { orgId: 'org-1', envUrl: 'https://e', appUniqueName: 'new_app', appId: null };
test('run: a teardown landing during identity discovery stops a FIRST build before it builds anything', async () => {
  const dir = ws();
  try {
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, {
      buildModelApp: stubBuild(record), readContent: readFor('v1'),
      resolveLiveIdentity: async () => { assert.ok(store.tombstoneSnapshot(dir).ok); return FRESH; },
    }) });
    assert.match(r.changedOnly.reason, /no snapshot/, 'precondition: the run read no snapshot');
    assert.strictEqual(r.ok, false, 'the run must fail closed');
    assert.strictEqual(record.length, 0, 'nothing may be built while a teardown holds the workspace');
    assert.match(r.errors[0], /could not claim the workspace for the first baseline \(a snapshot appeared since/);
    const disk = store.readSnapshot(dir);
    assert.ok(snap.isTombstoned(disk) && disk.eligible === false, 'the tombstone survives');
  } finally { rm(dir); }
});

for (const [when, teardown] of [
  ['finishes with errors', (dir) => assert.ok(store.tombstoneSnapshot(dir).ok)],
  ['finishes cleanly', (dir) => { assert.ok(store.tombstoneSnapshot(dir).ok); assert.ok(store.deleteSnapshot(dir).ok); }],
]) {
  test(`run: a teardown that ${when} during a FIRST build leaves no eligible baseline behind`, async () => {
    const dir = ws();
    try {
      const build = async () => {
        teardown(dir);
        return { ok: true, dryRun: false, created: { app: 'app-1', pages: { overview: 'page-1' } }, verify: { ok: true } };
      };
      const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: build, resolveLiveIdentity: async () => FRESH, readContent: readFor('v1') }) });
      assert.match(r.changedOnly.reason, /no snapshot/);
      const disk = store.readSnapshot(dir);
      assert.ok(!disk || (disk.eligible === false && snap.isTombstoned(disk)), `no eligible baseline may be written over a teardown; got ${JSON.stringify(disk && { eligible: disk.eligible, debt: disk.debt })}`);
    } finally { rm(dir); }
  });
}

// The placeholder a crashed first build leaves must not poison the next one: no debt (a baseline inherits
// its prior's), and no identity mismatch in the reason a reader sees.
test('run: a FIRST build that fails leaves a debt-free placeholder, and the next run still certifies a fresh baseline', async () => {
  const dir = ws();
  try {
    const failed = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: async () => ({ ok: false, errors: ['boom'] }), resolveLiveIdentity: async () => FRESH, readContent: readFor('v1') }) });
    assert.strictEqual(failed.ok, false);
    const placeholder = store.readSnapshot(dir);
    assert.ok(placeholder && placeholder.eligible === false && placeholder.debt.length === 0 && placeholder.priorSpec === null, JSON.stringify(placeholder));
    const d = flow.decideChangedOnly({ annotatedSpec: annotate(baseSpec(), 'v1'), snapshot: placeholder, live: FRESH });
    assert.strictEqual(d.decision, 'full');
    assert.match(d.reason, /not eligible/, `reported as not eligible, not as an identity mismatch: ${d.reason}`);
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), resolveLiveIdentity: async () => FRESH, readContent: readFor('v1') }) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(record.length, 1);
    const disk = store.readSnapshot(dir);
    assert.strictEqual(disk.eligible, true, `the retry certifies its fresh baseline; debt ${JSON.stringify(disk.debt)}`);
    assert.strictEqual(disk.appId, 'app-1');
  } finally { rm(dir); }
});

// A tombstone that lists a teardown still running means that teardown is deleting the app right now: a
// build would recreate what it deletes, and its fenced invalidate would pass — the generation it compares
// is the tombstone's own. So a changed-only run refuses and builds nothing until the teardown finishes.
test('run: a changed-only build refuses while a teardown of the workspace is still running', async () => {
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    const t = store.tombstoneSnapshot(dir);
    const before = store.readSnapshot(dir);
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), readContent: readFor('v1') }) });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0], /^changed-only: 1 teardown\(s\) of this workspace are still running \(pid \d+, last seen \d+s ago\) — re-run the build once they have finished\. A teardown that died stops counting 5 minutes after it was last seen\.$/);
    assert.strictEqual(record.length, 0, 'nothing is built while the teardown deletes');
    assert.deepStrictEqual(store.readSnapshot(dir), before, 'and the tombstone is untouched');
    assert.deepStrictEqual(store.releaseTombstone(dir, t.teardownId), { ok: true, deleted: true }, 'the teardown then finishes as usual');
  } finally { rm(dir); }
});

// …whichever build it would have run: a run that cannot resolve its live identity falls back to a plain
// full build, and that one waits for the teardown too — before it even asks for the identity.
test('run: the no-identity fallback also waits for a teardown still running', async () => {
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    store.tombstoneSnapshot(dir);
    const record = [];
    let asked = 0;
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), readContent: readFor('v1'), resolveLiveIdentity: async () => { asked += 1; return null; } }) });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0], /teardown\(s\) of this workspace are still running/);
    assert.deepStrictEqual([record.length, asked], [0, 0], 'nothing built, and the identity never asked for');
  } finally { rm(dir); }
});

// …and a teardown that BEGINS while the identity is being resolved is not in the first read. The fenced
// branches catch it through their invalidate; the no-identity one writes no snapshot, so it reads the
// workspace again and refuses when it moved — a teardown's tombstone, or another build's invalidate.
test('run: the no-identity fallback refuses when the workspace changed during identity discovery', async () => {
  for (const [what, seed, during] of [
    ['a teardown began', (dir) => seedEligible(dir, annotate(baseSpec(), 'v1')), (dir) => store.tombstoneSnapshot(dir)],
    ['a teardown began on a workspace with no snapshot', () => {}, (dir) => store.tombstoneSnapshot(dir)],
    ['another build invalidated it', (dir) => seedEligible(dir, annotate(baseSpec(), 'v1')), (dir) => store.invalidateSnapshot(dir, { expectedGeneration: store.readSnapshot(dir).generation })],
  ]) {
    const dir = ws();
    try {
      seed(dir);
      const record = [];
      const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), readContent: readFor('v1'), resolveLiveIdentity: async () => { during(dir); return null; } }) });
      assert.strictEqual(r.ok, false, what);
      assert.match(r.errors[0], /the workspace changed while the live identity was being resolved/, what);
      assert.strictEqual(record.length, 0, `${what}: nothing is built`);
    } finally { rm(dir); }
  }
});

// A teardown that begins after that re-read, while the build runs, is not fenced by it, and this path writes no
// baseline whose CAS could be refused. The workspace is read again when the build returns, and a moved generation
// fails the run: what the build made may already be partly deleted.
test('run: the no-identity fallback fails when the workspace changed while the build ran', async () => {
  for (const [what, seed, during] of [
    ['a teardown began', (dir) => seedEligible(dir, annotate(baseSpec(), 'v1')), (dir) => store.tombstoneSnapshot(dir)],
    ['a teardown began on a workspace with no snapshot', () => {}, (dir) => store.tombstoneSnapshot(dir)],
    ['another build invalidated it', (dir) => seedEligible(dir, annotate(baseSpec(), 'v1')), (dir) => store.invalidateSnapshot(dir, { expectedGeneration: store.readSnapshot(dir).generation })],
  ]) {
    const dir = ws();
    try {
      seed(dir);
      const record = [];
      const build = async (spec, opts) => { record.push(opts.phases); during(dir); return { ok: true, dryRun: false, created: { app: 'app-1' }, verify: { ok: true } }; };
      const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: build, readContent: readFor('v1'), resolveLiveIdentity: async () => null }) });
      assert.strictEqual(record.length, 1, `${what}: the build ran`);
      assert.strictEqual(r.ok, false, what);
      assert.match(r.errors[r.errors.length - 1], /the workspace changed while this build ran/, what);
      assert.strictEqual(r.changedOnly.reason, 'the workspace changed during the build', what);
    } finally { rm(dir); }
  }
  // CONTROL: nothing changes the workspace during the build — the full build's result stands.
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), readContent: readFor('v1'), resolveLiveIdentity: async () => null }) });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.changedOnly, { decision: 'full', reason: 'no live identity' });
  } finally { rm(dir); }
});

// With no snapshot there was no generation to compare: a teardown that began AND finished during the build wrote its
// tombstone and deleted it on release, and "none" before and after hid it. The run claims a placeholder first, and
// drops it afterwards when nothing raced, so this path still leaves no snapshot behind.
test('run: the no-identity fallback on a workspace with no snapshot sees a teardown that came and went during the build', async () => {
  const dir = ws();
  try {
    const record = [];
    const build = async (spec, opts) => {
      record.push(opts.phases);
      assert.ok(store.readSnapshot(dir), 'the build runs under the placeholder the run claimed');
      const t = store.tombstoneSnapshot(dir);
      assert.deepStrictEqual(store.releaseTombstone(dir, t.teardownId), { ok: true, deleted: true }, 'precondition: the teardown finished and deleted its tombstone');
      return { ok: true, dryRun: false, created: { app: 'app-1' }, verify: { ok: true } };
    };
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: build, readContent: readFor('v1'), resolveLiveIdentity: async () => null }) });
    assert.strictEqual(record.length, 1);
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[r.errors.length - 1], /the workspace changed while this build ran/);
  } finally { rm(dir); }
  // CONTROL: nothing raced — the build's result stands, and the placeholder is gone again.
  const quiet = ws();
  try {
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: quiet, apply: true }, deps: baseDeps(quiet, { buildModelApp: stubBuild([]), readContent: readFor('v1'), resolveLiveIdentity: async () => null }) });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    assert.strictEqual(store.readSnapshot(quiet), null, 'no snapshot is left behind');
  } finally { rm(quiet); }
  // A claim that cannot be made (another writer holds the lease) stops the run before it builds anything.
  const busy = ws();
  try {
    fs.writeFileSync(store.leasePath(busy), JSON.stringify({ pid: process.pid, at: Date.now(), rnd: 'held' }));
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: busy, apply: true }, deps: baseDeps(busy, { buildModelApp: stubBuild(record), readContent: readFor('v1'), resolveLiveIdentity: async () => null }) });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0], /could not claim the workspace before the build/);
    assert.strictEqual(record.length, 0, 'nothing is built');
  } finally { rm(busy); }
});

// Two no-identity builds that read the same generation, one inside the other, each saw it unchanged at the end and
// both reported success. Each now takes a generation of its own before it builds, so the first sees the second's.
test('run: overlapping no-identity builds do not both pass', async () => {
  for (const [what, seed] of [
    ['on a workspace with no snapshot', () => {}],
    ['on a workspace with an eligible snapshot', (dir) => seedEligible(dir, annotate(baseSpec(), 'v1'))],
  ]) {
    const dir = ws();
    try {
      seed(dir);
      let inner = null;
      const innerDeps = baseDeps(dir, { buildModelApp: stubBuild([]), readContent: readFor('v1'), resolveLiveIdentity: async () => null });
      const build = async () => {
        inner = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: innerDeps });
        return { ok: true, dryRun: false, created: { app: 'app-1' }, verify: { ok: true } };
      };
      const outer = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: build, readContent: readFor('v1'), resolveLiveIdentity: async () => null }) });
      assert.ok(inner, `${what}: the second build ran inside the first`);
      assert.strictEqual(outer.ok, false, `${what}: the first build saw the second`);
      assert.match(outer.errors[outer.errors.length - 1], /the workspace changed while this build ran/, what);
    } finally { rm(dir); }
  }
});

// A no-identity build outdates the baseline it read, as any full build does, so the baseline is invalidated first —
// fenced to the generation read — and never left eligible behind the build.
test('run: the no-identity fallback invalidates an existing baseline before it builds', async () => {
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    const seen = store.readSnapshot(dir).generation;
    let during = null;
    const build = async () => { during = store.readSnapshot(dir); return { ok: true, dryRun: false, created: { app: 'app-1' }, verify: { ok: true } }; };
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: build, readContent: readFor('v1'), resolveLiveIdentity: async () => null }) });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    assert.ok(during && during.eligible === false && during.generation !== seen, 'invalidated, with a rotated generation, before the build ran');
    assert.strictEqual(store.readSnapshot(dir).eligible, false, 'and still ineligible afterwards');
  } finally { rm(dir); }
  // An invalidate that cannot be made (the lease is held) stops the run before it builds anything.
  const busy = ws();
  try {
    seedEligible(busy, annotate(baseSpec(), 'v1'));
    fs.writeFileSync(store.leasePath(busy), JSON.stringify({ pid: process.pid, at: Date.now(), rnd: 'held' }));
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: busy, apply: true }, deps: baseDeps(busy, { buildModelApp: stubBuild(record), readContent: readFor('v1'), resolveLiveIdentity: async () => null }) });
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0], /could not invalidate the snapshot before the build/);
    assert.strictEqual(record.length, 0);
  } finally { rm(busy); }
});

test('dropBaselineClaim removes only the placeholder it was given', () => {
  const dir = ws();
  try {
    const claim = store.claimBaselineSnapshot(dir, {});
    assert.strictEqual(claim.ok, true);
    assert.strictEqual(store.dropBaselineClaim(dir, 'another-generation').ok, false, 'not a placeholder this run claimed');
    assert.ok(store.readSnapshot(dir), 'so it stays');
    assert.deepStrictEqual(store.dropBaselineClaim(dir, claim.generation), { ok: true });
    assert.strictEqual(store.readSnapshot(dir), null);
    assert.strictEqual(store.dropBaselineClaim(dir, claim.generation).ok, false, 'nothing left to drop');
  } finally { rm(dir); }
});

// A tombstone no teardown still holds — one that failed, or a day old — does not block: the build runs, and
// the tombstone's debt keeps its baseline ineligible, as it always did.
test('run: a tombstone no teardown still holds only makes the baseline ineligible', async () => {
  const dir = ws();
  try {
    seedEligible(dir, annotate(baseSpec(), 'v1'));
    store.tombstoneSnapshot(dir, { now: () => Date.now() - store.TEARDOWN_STALE_MS - 1000 });
    assert.deepStrictEqual(store.teardownsInFlight(store.readSnapshot(dir)), [], 'precondition: no teardown is still running');
    const record = [];
    const r = await flow.runChangedOnlyApply({ spec: baseSpec(), opts: { workspaceDir: dir, apply: true }, deps: baseDeps(dir, { buildModelApp: stubBuild(record), readContent: readFor('v1') }) });
    assert.strictEqual(r.changedOnly.decision, 'full');
    assert.strictEqual(record.length, 1);
    const disk = store.readSnapshot(dir);
    assert.ok(disk && disk.eligible === false && snap.isTombstoned(disk), 'the teardown debt keeps the baseline ineligible');
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

// #587.4, end to end: the consequence of the identity distinction, not just the field.
// An unreadable app id must produce an INELIGIBLE baseline carrying `uncertified-baseline` debt,
// exactly as a known-pre-existing app does — otherwise a later page edit takes the fast path on a
// baseline that was never proven to be a fresh create.
test('run: an unreadable app id must not certify an eligible fresh baseline', async () => {
  const dir = ws();
  try {
    const unreadable = async () => ({ ...LIVE, appId: null, appIdKnown: false });
    await flow.runChangedOnlyApply({
      spec: baseSpec(),
      opts: { workspaceDir: dir, apply: true },
      deps: baseDeps(dir, { resolveLiveIdentity: unreadable }),
    });
    const snap = store.readSnapshot(dir);
    assert.ok(snap, `a snapshot must still be written; got ${JSON.stringify(snap)}`);
    assert.strictEqual(snap.eligible, false,
      'an identity we could not read cannot certify a fresh create');
    assert.ok(JSON.stringify(snap.debt || []).includes('uncertified-baseline'),
      `the reason must be recorded as debt; got ${JSON.stringify(snap.debt)}`);
  } finally { rm(dir); }
});

// The control: a PROVEN absence still certifies a fresh baseline, so the fix cannot be satisfied by
// making every baseline ineligible.
test('run: a PROVEN absent app still certifies an eligible fresh baseline', async () => {
  const dir = ws();
  try {
    const absent = async () => ({ ...LIVE, appId: null, appIdKnown: true });
    await flow.runChangedOnlyApply({
      spec: baseSpec(),
      opts: { workspaceDir: dir, apply: true },
      deps: baseDeps(dir, { resolveLiveIdentity: absent }),
    });
    const snap = store.readSnapshot(dir);
    assert.strictEqual(snap.eligible, true,
      `a fresh create must still yield an eligible baseline; debt=${JSON.stringify(snap.debt)}`);
  } finally { rm(dir); }
});
