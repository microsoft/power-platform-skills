'use strict';
// Declared dashboards (dashboards[].reconcile: "declared") wired into the build: the spec gate, the dashboards phase's dispatch to
// the managed dashboard helper (lib/dashboard-reconcile.js settleDeclaredDashboard and publishDeclaredDashboard), the halt it is
// given, the publish by the dashboard's own id, and the typed approvals the halts name. Everything runs through the real engine
// (lib/sdk-build.js runSdkBuild) and the real vendored SDK over a fake Dataverse wire that models a dashboard's saved and published
// layers (helpers/managed-wire.js), with the CLI's transport shape: the publication barrier with the send observer inside it.
// The build path is behind lib/declared-features.js; each test that needs it switches it on and back.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { openManagedBindings } = require('../lib/managed-bindings.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { createAttemptSendObserver } = require('../lib/managed-feature-contract.js');
const { DECLARED_FEATURES } = require('../lib/declared-features.js');
const { ORIGIN, createManagedWire, sdkOver } = require('./helpers/managed-wire.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const SOLUTION = 'ContosoDash';
const APP = 'contoso_dash';
const KEY = 'ops';

function makeSpec({ declared = true, dashboard = {} } = {}) {
  return {
    solution: { uniqueName: SOLUTION, displayName: 'Contoso Dash', publisherPrefix: 'contoso' },
    app: { name: 'Dash', uniqueName: APP },
    dashboards: [{
      name: 'Ops', ...(declared ? { key: KEY, reconcile: 'declared' } : {}), description: 'Daily',
      tiles: [{ ...(declared ? { key: 'map' } : {}), type: 'iframe', url: 'https://contoso.example/map', name: 'Map' }],
      ...dashboard,
    }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Board', subAreas: [{ dashboard: 'Ops', title: 'Ops' }] }] }] },
  };
}

async function withDashboards(on, fn) {
  const was = DECLARED_FEATURES.dashboards;
  DECLARED_FEATURES.dashboards = on;
  try { return await fn(); } finally { DECLARED_FEATURES.dashboards = was; }
}

const storeOf = (dir) => openManagedBindings({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOLUTION });

// One invocation: a fresh barrier, observer and SDK (a stopped invocation's SDK and observer are retired), over the same wire and
// the same build workspace `dir`, which holds the binding store.
async function build(wire, dir, spec, opts = {}) {
  const barrier = createPublicationBarrier();
  const sendObserver = createAttemptSendObserver();
  const { sdk } = await sdkOver(wire, { barrier, observer: sendObserver });
  const mark = wire.log.length;
  const warnings = [];
  let out;
  let err;
  try {
    out = await runSdkBuild(spec, { sdk, apply: true, publish: false, workspaceDir: dir, appDir: dir, env: ORIGIN, warn: (w) => warnings.push(String(w)), phases: ['dashboards'], publicationBarrier: barrier, sendObserver, ...opts });
  } catch (e) {
    err = e;
  }
  const calls = wire.log.slice(mark);
  const publishes = calls.filter((c) => c.method === 'POST' && /^PublishXml$/i.test(c.path));
  return { out, err, calls, barrier, warnings, writes: calls.filter((c) => c.method !== 'GET'), formWrites: calls.filter((c) => c.method !== 'GET' && /^systemforms/i.test(c.path)), publishes };
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const shape = (calls) => calls.map((c) => `${c.method} ${c.path.replace(GUID, '<id>')}`);

// Every word a stop says: its message, its causes and the findings it carries.
function chainText(err) {
  const out = [];
  for (let e = err, n = 0; e && n < 10; e = e.cause, n += 1) {
    out.push(String(e.message || ''));
    for (const f of Array.isArray(e.findings) ? e.findings : []) out.push(`${f.code}: ${f.message}`);
  }
  return out.join('\n');
}
const ownHalt = (err) => { for (let e = err; e; e = e.cause) if (Array.isArray(e.findings)) return e; return null; };

// A dashboard the maker made in the environment: one iframe tile, published.
async function makerDashboard(wire, { name = 'Ops', description = 'Daily', formid } = {}) {
  const seed = createManagedWire();
  const dir = makeTempDir('declared-dash-');
  const tiles = [{ key: 'legacy', type: 'iframe', url: 'https://contoso.example/legacy', name: 'Legacy' }];
  const made = await withDashboards(true, () => build(seed, dir, makeSpec({ dashboard: { name, description, tiles } })));
  assert.equal(made.err, undefined, chainText(made.err));
  const row = [...seed.saved.values()][0];
  return wire.putForm({ ...row, ...(formid ? { formid } : {}) }, { publishedToo: true });
}

// --- the spec gate -----------------------------------------------------------------------------------------------------------

test('with the build path off, a declared dashboard is refused with the words it always had', async () => {
  await withDashboards(false, () => {
    const v = validateAppSpec(makeSpec(), { profile: 'deploy' });
    assert.equal(v.ok, false);
    assert.ok(v.errors.includes("dashboards: 'Ops' — reconcile is supported only on views, charts, forms and web resources; leave it out (this artifact keeps the existing build behaviour)"), JSON.stringify(v.errors));
  });
});

test('with the build path on, a declared dashboard validates and refuses what the declared build cannot keep proved', async () => {
  await withDashboards(true, () => {
    assert.deepEqual(validateAppSpec(makeSpec(), { profile: 'deploy' }).errors, []);
    const refused = (dashboard) => {
      const v = validateAppSpec(makeSpec({ dashboard }), { profile: 'deploy' });
      assert.equal(v.ok, false, JSON.stringify(dashboard));
      return v.errors.join('\n');
    };
    assert.match(refused({ reconcile: 'additive' }), /dashboards\[0\] 'Ops': reconcile must be "declared"/);
    assert.match(refused({ key: 'two words' }), /key must be letters, digits/);
    assert.match(refused({ key: undefined, name: 'Ops/Daily' }), /whose name holds '\/' needs a key/);
    assert.match(refused({ tiles: [{ type: 'iframe', url: 'https://contoso.example/map', name: 'Map' }] }), /dashboards\[0\] 'Ops': /);
    const twice = makeSpec();
    twice.dashboards.push({ ...twice.dashboards[0], name: 'Ops 2', key: 'OPS' });
    assert.match(validateAppSpec(twice, { profile: 'deploy' }).errors.join('\n'), /same key \(dashboard:OPS\)/);
    // An explicit empty description is the declared clear; an undeclared dashboard still refuses it.
    assert.deepEqual(validateAppSpec(makeSpec({ dashboard: { description: '' } }), { profile: 'deploy' }).errors, []);
    assert.equal(validateAppSpec(makeSpec({ declared: false, dashboard: { description: '' } }), { profile: 'deploy' }).ok, false);
  });
});

// --- the dashboards phase ----------------------------------------------------------------------------------------------------

test('with the build path off, an undeclared dashboard sends exactly the requests it sent with the path on', async () => {
  const run = (on) => withDashboards(on, async () => {
    const r = await build(createManagedWire(), makeTempDir('declared-dash-'), makeSpec({ declared: false }));
    return { err: r.err && r.err.message, calls: shape(r.calls) };
  });
  const off = await run(false);
  assert.ok(off.calls.some((c) => c.startsWith('POST systemforms')), JSON.stringify(off));
  assert.deepEqual(await run(true), off);
});

test('a declared dashboard is created once, published once by its own id, and a rebuild sends no dashboard write and no publish', async () => {
  await withDashboards(true, async () => {
    const wire = createManagedWire();
    const dir = makeTempDir('declared-dash-');
    const first = await build(wire, dir, makeSpec());
    assert.equal(first.err, undefined, chainText(first.err));
    assert.equal(first.formWrites.filter((c) => c.method === 'POST').length, 1);
    const g = storeOf(dir).readGroup('dashboard', KEY).committed;
    const id = g.root.id;
    assert.equal(g.records.find((r) => r.kind === 'dashboard').origin, 'created');
    assert.equal(g.publication.state, 'confirmed');
    assert.equal(first.publishes.length, 1);
    assert.match(first.publishes[0].body.ParameterXml, new RegExp(`<dashboards><dashboard>${id}</dashboard></dashboards>`, 'i'));
    assert.equal(first.out.created.dashboards.Ops, id);
    const again = await build(wire, dir, makeSpec());
    assert.equal(again.err, undefined, chainText(again.err));
    assert.deepEqual(again.formWrites, []);
    assert.deepEqual(again.publishes, []);
    assert.equal(again.out.created.dashboards.Ops, id);
    // A changed declaration is one keyed write and one publish of the same dashboard.
    const changed = await build(wire, dir, makeSpec({ dashboard: { description: 'Weekly' } }));
    assert.equal(changed.err, undefined, chainText(changed.err));
    assert.ok(changed.formWrites.length > 0 && changed.formWrites.every((c) => c.path.toLowerCase().includes(id)), shape(changed.formWrites).join('\n'));
    assert.equal(changed.publishes.length, 1);
    assert.equal(wire.published.get(id).description, 'Weekly');
  });
});

test('a declared dashboard found by name halts naming the typed adoption approval, writes nothing, and binds with it', async () => {
  await withDashboards(true, async () => {
    const wire = createManagedWire();
    const row = await makerDashboard(wire, { description: 'From the maker' });
    const dir = makeTempDir('declared-dash-');
    const halted = await build(wire, dir, makeSpec());
    assert.ok(halted.err, 'the unbound dashboard is not taken over');
    const text = chainText(halted.err);
    assert.match(text, new RegExp(`\\(approve with --authorize "?adopt:dashboard:${KEY}"?\\)`), text);
    const own = ownHalt(halted.err);
    assert.ok(own, text);
    assert.equal(own.name, 'BuildHalt');
    assert.deepEqual(own.findings.map((f) => f.code), ['dashboard-adoption-not-authorized']);
    assert.deepEqual(halted.formWrites, [], 'nothing is written over the unbound dashboard');
    assert.deepEqual(halted.publishes, []);
    assert.equal(storeOf(dir).readGroup('dashboard', KEY).committed, null);
    // An approval of another family or key does not approve it.
    assert.ok((await build(wire, dir, makeSpec(), { authorizedAdoption: new Set([`form:${KEY}`, 'dashboard:other']) })).err);
    const bound = await build(wire, dir, makeSpec(), { authorizedAdoption: new Set([`dashboard:${KEY}`]) });
    assert.equal(bound.err, undefined, chainText(bound.err));
    assert.equal(bound.formWrites.filter((c) => c.method === 'POST').length, 0, 'no second dashboard');
    const g = storeOf(dir).readGroup('dashboard', KEY).committed;
    assert.equal(g.root.id, row.formid);
    assert.equal(g.records.find((r) => r.kind === 'dashboard').origin, 'adopted');
    assert.equal(wire.published.get(row.formid).description, 'Daily');
    const xml = String(wire.published.get(row.formid).formxml);
    assert.ok(xml.includes('contoso.example/map') && xml.includes('contoso.example/legacy'), 'the declared tile is added and the maker\'s tile is kept');
    assert.equal(bound.publishes.length, 1);
    // Later runs need no new grant.
    const later = await build(wire, dir, makeSpec({ dashboard: { description: 'Weekly' } }));
    assert.equal(later.err, undefined, chainText(later.err));
    assert.equal(later.publishes.length, 1);
  });
});

test('a declared dashboard whose name matches several dashboards, none in the solution, stops before any write and withholds every match', async () => {
  await withDashboards(true, async () => {
    const wire = createManagedWire();
    const a = await makerDashboard(wire);
    const b = await makerDashboard(wire, { name: 'OPS ', formid: '22222222-2222-4222-8222-222222222222' });
    assert.notEqual(a.formid, b.formid);
    const r = await build(wire, makeTempDir('declared-dash-'), makeSpec());
    assert.ok(r.err);
    assert.match(chainText(r.err), /2 dashboards in this environment match the name 'Ops'/);
    assert.deepEqual(r.writes.filter((c) => !/^AddSolutionComponent$/i.test(c.path)), []);
    for (const id of [a.formid, b.formid]) {
      assert.equal(r.barrier.checkAppWrite({ addedDashboards: [id] }).ok, false, `${id} is withheld from the app write`);
    }
  });
});

test('a tile changed outside the spec halts naming the typed overwrite of that one tile, and the approval writes it', async () => {
  await withDashboards(true, async () => {
    const wire = createManagedWire();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    for (const layer of [wire.saved, wire.published]) for (const r of layer.values()) r.formxml = r.formxml.replace(/contoso\.example\/map/g, 'contoso.example/maker');
    const moved = makeSpec({ dashboard: { tiles: [{ key: 'map', type: 'iframe', url: 'https://contoso.example/map2', name: 'Map' }] } });
    const halted = await build(wire, dir, moved);
    assert.ok(halted.err);
    const text = chainText(halted.err);
    assert.ok(text.includes('(approve with --authorize overwrite:dashboard:ops/map)'), text);
    assert.deepEqual(ownHalt(halted.err).findings.map((f) => `${f.code} ${f.label}`), ['dashboard-tile-drift declared dashboard "ops/map"']);
    assert.deepEqual(halted.formWrites, []);
    assert.deepEqual(halted.publishes, []);
    // The dashboard's own approval is not the tile's.
    assert.ok((await build(wire, dir, moved, { authorizedOverwrite: new Set(['dashboard:ops']) })).err);
    const written = await build(wire, dir, moved, { authorizedOverwrite: new Set(['dashboard:ops/map']) });
    assert.equal(written.err, undefined, chainText(written.err));
    assert.equal(written.publishes.length, 1);
    assert.ok(String([...wire.published.values()][0].formxml).includes('contoso.example/map2'));
  });
});

test('a lost dashboard publish the org never applied blocks the dashboard in later builds, with its typed approval as data', async () => {
  await withDashboards(true, async () => {
    const wire = createManagedWire();
    const dir = makeTempDir('declared-dash-');
    wire.script((e) => e.method === 'POST' && /^PublishXml$/i.test(e.path), { error: new Error('socket hang up'), unapplied: true });
    assert.ok((await build(wire, dir, makeSpec())).err);
    const id = storeOf(dir).readGroup('dashboard', KEY).committed.root.id;
    for (const n of [2, 3]) {
      const r = await build(wire, dir, makeSpec());
      assert.ok(r.err, `run ${n} stops`);
      const blocked = (() => { for (let e = r.err; e; e = e.cause) if (e.approval) return e; return null; })();
      assert.ok(blocked, `run ${n}: the refusal carries its data\n${chainText(r.err)}`);
      assert.equal(blocked.approval, `publication-risk:dashboard:${id}`);
      assert.match(blocked.dispatchToken, /\S/);
      assert.match(blocked.remedy, /\S/);
      assert.deepEqual(r.publishes, [], `run ${n} sends no publish`);
    }
  });
});
