'use strict';
// Declared dashboards (dashboards[].reconcile: "declared") wired into the build: the spec gate, the dashboards phase's dispatch to
// the managed dashboard helper (lib/dashboard-reconcile.js settleDeclaredDashboard and publishDeclaredDashboard), the halt it is
// given, the publish by the dashboard's own id, and the typed approvals the halts name. Everything runs through the real engine
// (lib/sdk-build.js runSdkBuild) and the real vendored SDK over a fake Dataverse wire that models a dashboard's saved and published
// layers (helpers/managed-wire.js), with the CLI's transport shape: the publication barrier with the send observer inside it.
// The round trip is covered too: the CLI's approval parsing (authorizationKeys), verify's managed-dashboard check through
// lib/declared-dashboard-io.js, and the managed download that restores a certified dashboard's original declaration.
// The build path is behind lib/declared-features.js (on in this release); each test sets it explicitly and restores it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { openManagedBindings } = require('../lib/managed-bindings.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { createAttemptSendObserver } = require('../lib/managed-feature-contract.js');
const { DECLARED_FEATURES } = require('../lib/declared-features.js');
const fs = require('node:fs');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { buildModelApp, authorizationKeys } = require('../build-model-app.js');
const { readerFor, isolatedReaderFor } = require('../verify-model-app.js');
const { main: downloadMain } = require('../download-model-app.js');
const { verifySpec } = require('../lib/verify-spec.js');
const { readSystemFormRootPresence } = require('../lib/systemform-published.js');
const { readVerifyManifest } = require('../lib/declared-form-io.js');
const { storeFileName } = require('../lib/managed-bindings.js');
const { environmentFingerprint } = require('../lib/page-ownership-records.js');
const { ORIGIN, createManagedWire, clientOver, sdkOver } = require('./helpers/managed-wire.js');
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
// the same build workspace `dir`, which holds the binding store. The SDK's workspace is a new one each time unless `sdkDir`
// names it (sdkOver `workspaceDir`); it is the test's, never passed to the build.
async function build(wire, dir, spec, { sdkDir, ...opts } = {}) {
  const barrier = createPublicationBarrier();
  const sendObserver = createAttemptSendObserver();
  const { sdk } = await sdkOver(wire, { barrier, observer: sendObserver, ...(sdkDir ? { workspaceDir: sdkDir } : {}) });
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
    assert.ok(v.errors.includes("dashboards: 'Ops' — reconcile is supported only on views, charts, forms, business rules, business process flows and web resources; leave it out (this artifact keeps the existing build behaviour)"), JSON.stringify(v.errors));
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

// --- the round trip: the typed dashboard approvals, verify and the explicit managed download ----------------------------------

test('--authorize adopt|overwrite:dashboard:<key> and a tile\'s overwrite are read in any case, typed or not; an adopt of a tile, an undeclared key or an ambiguous one is refused', async () => {
  await withDashboards(true, () => {
    const spec = makeSpec();
    const keys = (...list) => authorizationKeys(list.flatMap((k) => ['--authorize', k]), spec);
    const typed = keys('adopt:dashboard:OPS', 'overwrite:dashboard:Ops/MAP');
    assert.equal(typed.error, null);
    assert.deepEqual([...typed.adopt], [`dashboard:${KEY}`]);
    assert.deepEqual([...typed.overwrite], [`dashboard:${KEY}/map`]);
    const untyped = keys('adopt:Ops', 'overwrite:ops/Map', 'overwrite:ops');
    assert.equal(untyped.error, null);
    assert.deepEqual([...untyped.adopt], [`dashboard:${KEY}`]);
    assert.deepEqual([...untyped.overwrite].sort(), [`dashboard:${KEY}`, `dashboard:${KEY}/map`]);
    for (const [key, words] of [
      ['adopt:dashboard:ops/map', /is not an approval a dashboard tile takes/],
      ['adopt:ops/map', /names the tile ops\/map of a declared dashboard, which takes only overwrite:dashboard:ops\/map/],
      ['adopt:dashboard:other', /approves an artifact the spec does not declare \(it would need a dashboard with reconcile: "declared" keyed other/],
      ['overwrite:dashboard:ops/other', /approves an artifact the spec does not declare/],
      ['overwrite:ops/other', /or a dashboard tile, with reconcile: "declared" keyed ops\/other/],
    ]) {
      const r = keys(key);
      assert.match(String(r.error), words, key);
      assert.equal(r.adopt.size + r.overwrite.size, 0, key);
    }
    // A declared web resource of the same name: the untyped key could mean either.
    const both = makeSpec();
    both.webResources = [{ name: 'ops', type: 'js', content: 'x', reconcile: 'declared' }];
    const ambiguous = authorizationKeys(['--authorize', 'adopt:ops'], both);
    assert.match(String(ambiguous.error), /could approve more than one declared artifact; name the one you mean with its typed key: adopt:dashboard:ops or adopt:webresource:ops/);
    assert.equal(ambiguous.adopt.size, 0);
    // An undeclared dashboard of the same name takes no approval.
    assert.match(String(authorizationKeys(['--authorize', 'adopt:dashboard:ops'], makeSpec({ declared: false })).error), /does not declare/);
  });
  await withDashboards(false, () => {
    const off = authorizationKeys(['--authorize', `adopt:dashboard:${KEY}`], makeSpec());
    assert.match(String(off.error), /approves an artifact the spec does not declare/);
    assert.equal(off.adopt.size, 0);
  });
});

// verify's reader as the CLI builds it (verify-model-app.js readerFor): a declared dashboard is read by its bound id on a throwaway
// SDK (isolatedReaderFor) over the same wire, never the build's.
async function verifyReader(wire) {
  const { sdk } = await sdkOver(wire);
  const cli = readerFor(sdk, APP, { isolatedReader: isolatedReaderFor(ORIGIN, { httpClient: clientOver(wire) }) });
  const dashboardReads = [];
  return {
    dashboardReads,
    read: {
      findTable: async () => null,
      findColumns: async () => [],
      // The bound-id read verify makes of a group it does not hold as declared: systemform by formid, answered from the wire.
      queryRecords: async (table, o) => {
        const id = (/formid eq (\S+)/.exec((o && o.filter) || '') || [])[1];
        return table === 'systemform' && id && wire.saved.has(id.toLowerCase()) ? [{ formid: id }] : [];
      },
      sitemapXml: async () => '',
      declaredDashboard: async (id) => { dashboardReads.push(id); return cli.declaredDashboard(id); },
    },
  };
}
const managedChecks = (r) => r.checks.filter((c) => c.kind === 'managed-dashboard');
const manifestOf = (dir) => readVerifyManifest({ workspaceDir: dir, environment: ORIGIN, appUniqueName: APP, solutionUniqueName: SOLUTION });
const retile = (wire, from, to) => { for (const layer of [wire.saved, wire.published]) for (const r of layer.values()) r.formxml = r.formxml.split(from).join(to); };

test('verify holds a bound declared dashboard to its declaration and last proof by a fresh read of its id', async () => {
  await withDashboards(true, async () => {
    const wire = createManagedWire();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const id = storeOf(dir).readGroup('dashboard', KEY).committed.root.id;
    const { read, dashboardReads } = await verifyReader(wire);
    const pass = await verifySpec(makeSpec(), read, { managedManifest: manifestOf(dir) });
    assert.deepEqual(managedChecks(pass).map((c) => [c.name, c.present, c.detail]), [[`${KEY} (${id})`, true, '']]);
    assert.deepEqual(dashboardReads, [id], 'read by the bound id');
    assert.deepEqual((pass.unverified || []).filter((u) => u.startsWith('managed:')), []);
    // A declaration the dashboard does not hold yet fails it, and says to build again.
    const changed = await verifySpec(makeSpec({ dashboard: { description: 'Weekly' } }), read, { managedManifest: manifestOf(dir) });
    assert.equal(managedChecks(changed)[0].present, false);
    assert.match(managedChecks(changed)[0].detail, /^dashboard-declaration-changed: .*build again/);
    assert.ok(changed.missing.some((m) => m.kind === 'managed-dashboard'), 'a failing bound dashboard fails verify');
    // A managed tile changed outside the spec fails it under the unchanged declaration.
    retile(wire, 'contoso.example/map', 'contoso.example/maker');
    const drifted = await verifySpec(makeSpec(), read, { managedManifest: manifestOf(dir) });
    assert.equal(managedChecks(drifted)[0].present, false);
    assert.match(managedChecks(drifted)[0].detail, /^dashboard-changed: /);
    // And a dashboard no read can find is reported failed, never passed.
    retile(wire, 'contoso.example/maker', 'contoso.example/map');
    wire.saved.delete(id);
    wire.published.delete(id);
    const gone = await verifySpec(makeSpec(), read, { managedManifest: manifestOf(dir) });
    assert.equal(managedChecks(gone)[0].present, false);
  });
});

test('verify lists a bound dashboard whose publication is not confirmed as unverified, and a reader that cannot read by id never passes it', async () => {
  await withDashboards(true, async () => {
    const wire = createManagedWire();
    const dir = makeTempDir('declared-dash-');
    wire.script((e) => e.method === 'POST' && /^PublishXml$/i.test(e.path), { error: new Error('socket hang up'), unapplied: true });
    assert.ok((await build(wire, dir, makeSpec())).err);
    const { read, dashboardReads } = await verifyReader(wire);
    const r = await verifySpec(makeSpec(), read, { managedManifest: manifestOf(dir) });
    assert.ok(r.unverified.some((u) => u.startsWith(`managed:dashboard ${KEY} (its publication is not confirmed`)), JSON.stringify(r.unverified));
    assert.equal(managedChecks(r)[0].present, true, 'the saved dashboard is still checked');
    const { declaredDashboard, ...plain } = read;
    void declaredDashboard;
    const blind = await verifySpec(makeSpec(), plain, { managedManifest: manifestOf(dir) });
    assert.deepEqual(managedChecks(blind), []);
    assert.ok(blind.unverified.includes(`managed:dashboard ${KEY} (this reader cannot read a dashboard by id)`), JSON.stringify(blind.unverified));
    // With the build path off, the group is held only to its bound id, as an undeclared one.
    await withDashboards(false, async () => {
      const before = dashboardReads.length;
      const off = await verifySpec(makeSpec(), read, { managedManifest: manifestOf(dir) });
      assert.deepEqual(managedChecks(off).map((c) => [c.present, c.detail]), [[true, '']]);
      assert.equal(dashboardReads.length, before, 'not read as a declared dashboard');
    });
  });
});

// download-model-app.js main with its side effects replaced: the download's SDK is a real one over the wire (it answers the app's
// unique name itself), and runDownload answers the spec a download of this app hydrates: the site map's dashboard as a plain entry
// pinned by its id.
async function download(wire, out, argv, { plainId, ...extra } = {}) {
  const { sdk } = await sdkOver(wire);
  const dl = Object.create(sdk);
  dl.queryRecords = async (table, o) => (table === 'appmodule' ? [{ uniquename: APP }] : sdk.queryRecords(table, o));
  const downloaded = makeSpec({ declared: false });
  downloaded.dashboards = plainId ? [{ name: 'Ops', dashboardId: plainId, description: 'Daily', tiles: [{ type: 'iframe', url: 'https://contoso.example/map', name: 'Map' }] }] : [];
  // With no plain entry, the site map has no dashboard either (the download reconstructs the dashboards its site map names).
  if (!plainId) downloaded.appShell.areas[0].groups[0].subAreas = [{ url: 'https://contoso.example/home', title: 'Home' }];
  const emitted = [];
  const said = [];
  let exited = null;
  const mark = wire.log.length;
  await downloadMain({
    argv: ['--env', ORIGIN, '--app', '00000000-0000-0000-0000-00000000a222', '--out', out, ...argv],
    stderr: { write: (text) => { said.push(String(text)); return true; } },
    exit: (code) => { exited = code; },
    emitResult: (ok, payload) => emitted.push({ ok, payload }),
    preflightAuth: async () => ({ ok: true }),
    makeDownloadSdk: async () => ({ sdk: dl, cleanup() {} }),
    makeGenpageSdk: () => ({}),
    runDownload: async () => ({ ok: true, spec: downloaded, pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [] }),
    ...extra,
  });
  const specFile = path.join(out, 'app-spec.json');
  return { emitted, said: said.join(''), exited, calls: wire.log.slice(mark), written: fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, 'utf8')) : null };
}
const storeFileOf = (dir) => path.join(dir, storeFileName(environmentFingerprint(ORIGIN), APP, SOLUTION));
// What the managed download restores for makeSpec()'s dashboard bound by `group`: the declaration as authored, plus the root and tile ids
// its last proof certified.
const restoredOf = (group) => makeSpec({ dashboard: { dashboardId: group.root.id, tiles: makeSpec().dashboards[0].tiles.map((t) => ({ ...t, componentId: group.consumerState.tiles[`${KEY}/${t.key}`].id })) } }).dashboards;

test('the explicit managed download restores a proved declared dashboard in place of its plain entry, and names any it cannot restore', async () => {
  await withDashboards(true, async () => {
    const wire = createManagedWire();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const bound = storeOf(dir).readGroup('dashboard', KEY).committed;
    const id = bound.root.id;
    const flags = ['--include-managed', '--managed-manifest', storeFileOf(dir)];
    const restored = await download(wire, makeTempDir('declared-dash-'), flags, { plainId: id });
    assert.equal(restored.emitted.length, 1);
    assert.equal(restored.emitted[0].ok, true, JSON.stringify(restored.emitted));
    assert.deepEqual(restored.emitted[0].payload.managedDashboards, { restored: [KEY], stale: [] });
    assert.deepEqual(restored.written.dashboards, restoredOf(bound), 'the declaration it was built from, with its certified ids, once, where the plain entry was');
    // With no plain entry for it, the declaration is appended.
    assert.deepEqual((await download(wire, makeTempDir('declared-dash-'), flags)).written.dashboards, restoredOf(bound));
    // A dashboard changed since its last proof is named and kept as the plain entry; the rest of the download is written.
    retile(wire, 'contoso.example/map', 'contoso.example/maker');
    const changed = await download(wire, makeTempDir('declared-dash-'), flags, { plainId: id });
    assert.equal(changed.emitted[0].ok, true);
    assert.deepEqual(changed.emitted[0].payload.managedDashboards.restored, []);
    assert.match(changed.emitted[0].payload.managedDashboards.stale[0].reason, new RegExp(`dashboard ${id} is not what its last build proved \\(dashboard-changed\\)`));
    assert.match(changed.said, new RegExp(`WARNING: managed dashboard ${KEY} was not restored: `));
    assert.deepEqual(changed.written.dashboards.map((d) => d.dashboardId), [id]);
    assert.equal('reconcile' in changed.written.dashboards[0], false);
  });
});

test('the explicit managed download refuses a store file that is not this app\'s; without the flags it reads no dashboard by id', async () => {
  await withDashboards(true, async () => {
    const wire = createManagedWire();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const copy = path.join(makeTempDir('declared-dash-'), 'managed-manifest.json');
    fs.copyFileSync(storeFileOf(dir), copy);
    const wrong = await download(wire, makeTempDir('declared-dash-'), ['--include-managed', '--managed-manifest', copy]);
    assert.equal(wrong.emitted[0].ok, false);
    assert.equal(wrong.emitted[0].payload.code, 'managed-manifest-unusable');
    assert.match(wrong.emitted[0].payload.error, /Nothing was written/);
    assert.equal(wrong.written, null, 'nothing is written');
    const plain = await download(wire, makeTempDir('declared-dash-'), []);
    assert.equal(plain.emitted[0].ok, true, JSON.stringify(plain.emitted) + plain.said);
    assert.equal('managedDashboards' in plain.emitted[0].payload, false);
    assert.deepEqual(plain.calls.filter((c) => /^systemforms\(/i.test(c.path)), [], 'no dashboard is read');
  });
});

test('the enabled feature through the CLI: the printed typed approval binds the dashboard, verify passes then fails a changed declaration, and the managed download restores it', async () => {
  await withDashboards(true, async () => {
    const wire = createManagedWire();
    await makerDashboard(wire, { description: 'From the maker' });
    const appDir = makeTempDir('declared-dash-');
    const dir = path.join(appDir, '.maker-workspace');
    fs.mkdirSync(dir);
    const { read } = await verifyReader(wire);
    const cli = async (spec, extra = {}) => {
      const barrier = createPublicationBarrier();
      const sendObserver = createAttemptSendObserver();
      const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient: clientOver(wire, { barrier, observer: sendObserver }) });
      await sdk.initWorkspace();
      let verified = null;
      let err;
      try {
        await buildModelApp(spec, { apply: true, env: ORIGIN, workspaceDir: dir, appDir, retryDelayMs: 0, ...extra }, {
          sdk, provisionSdk: sdk, runBuild: (s, o) => runSdkBuild(s, { ...o, phases: ['dashboards'] }), publicationBarrier: barrier, sendObserver, warn: () => {}, log: () => {},
          verify: async (s, o) => { verified = await verifySpec(s, read, o); return verified; },
        });
      } catch (e) { err = e; }
      return { err, verified };
    };
    const halted = await cli(makeSpec());
    assert.ok(halted.err, 'the unbound dashboard is not taken over');
    const printed = /--authorize "?(adopt:dashboard:[^"\s)]+)/.exec(chainText(halted.err));
    assert.ok(printed, chainText(halted.err));
    assert.equal(printed[1], `adopt:dashboard:${KEY}`);
    const keys = authorizationKeys(['--authorize', printed[1]], makeSpec());
    assert.equal(keys.error, null);
    const bound = await cli(makeSpec(), { authorizedAdoption: keys.adopt, verify: true });
    assert.equal(bound.err, undefined, chainText(bound.err));
    const g = storeOf(dir).readGroup('dashboard', KEY).committed;
    assert.equal(g.records.find((r) => r.kind === 'dashboard').origin, 'adopted');
    assert.deepEqual(managedChecks(bound.verified).map((c) => c.present), [true], 'the inline verify reads the bound dashboard');
    const standalone = await verifySpec(makeSpec({ dashboard: { description: 'Weekly' } }), read, { managedManifest: manifestOf(dir) });
    assert.equal(managedChecks(standalone)[0].present, false, 'the dashboard does not hold a declaration it was never built from');
    const downloaded = await download(wire, makeTempDir('declared-dash-'), ['--include-managed', '--managed-manifest', storeFileOf(dir)], { plainId: g.root.id });
    assert.deepEqual(downloaded.emitted[0].payload.managedDashboards, { restored: [KEY], stale: [] });
    assert.deepEqual(downloaded.written.dashboards, restoredOf(g));
  });
});

// ---- Identity, removed declarations, verify identity and the managed download's pins ----

// The wire, with the plain collection read verify and the legacy pinned lookup make of a dashboard by its id
// (sdk-build.js findPinnedDashboard):
//   GET systemforms?$select=formid,name,type&$filter=formid eq <id>&$top=1
// answered from the PUBLISHED layer, as the service answers a plain read.
function wireWithIdReads() {
  const wire = createManagedWire();
  const request = wire.request.bind(wire);
  wire.request = async (req) => {
    const url = new URL(req.url);
    const id = ((/\bformid eq ([0-9a-f-]{36})/i.exec(url.searchParams.get('$filter') || '') || [])[1] || '').toLowerCase();
    if (req.method === 'GET' && /\/systemforms$/.test(url.pathname) && id) {
      await request(req); // logged, as every read is
      return { statusCode: 200, headers: {}, body: JSON.stringify({ value: wire.published.has(id) ? [wire.published.get(id)] : [] }) };
    }
    return request(req);
  };
  return wire;
}
const committedGroup = (dir, key = KEY) => storeOf(dir).readGroup('dashboard', key).committed;
const clone = (x) => JSON.parse(JSON.stringify(x));
const NAMESAKE = '22222222-2222-4222-8222-222222222222';
// The spec with its declared dashboard taken out, and the site map no longer naming it.
const dropDashboard = (spec) => ({ ...spec, dashboards: [], appShell: { areas: [{ label: 'Main', groups: [{ label: 'Home', subAreas: [{ url: 'https://contoso.example/home', title: 'Home' }] }] }] } });
const rename = (wire, id, name) => { for (const layer of [wire.saved, wire.published]) layer.get(id).name = name; };

// The CLI front door (build-model-app.js buildModelApp) over the wire, with the build workspace in `appDir`/.maker-workspace.
async function cliBuild(wire, appDir, spec, extra = {}) {
  const dir = path.join(appDir, '.maker-workspace');
  fs.mkdirSync(dir, { recursive: true });
  const barrier = createPublicationBarrier();
  const sendObserver = createAttemptSendObserver();
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: ORIGIN, httpClient: clientOver(wire, { barrier, observer: sendObserver }) });
  await sdk.initWorkspace();
  const messages = [];
  const mark = wire.log.length;
  let error;
  try {
    await buildModelApp(spec, { apply: true, env: ORIGIN, workspaceDir: dir, appDir, retryDelayMs: 0, ...extra }, {
      sdk, provisionSdk: sdk, runBuild: (s, o) => runSdkBuild(s, { ...o, phases: ['dashboards'] }), publicationBarrier: barrier, sendObserver,
      warn: (m) => messages.push(String(m)), log: (m) => messages.push(String(m)),
    });
  } catch (e) { error = e; }
  return { error, barrier, messages, calls: wire.log.slice(mark), dir };
}
const serviceWrites = (calls) => calls.filter((c) => c.method !== 'GET' && /^(systemforms|appmodules|sitemaps|PublishXml)/i.test(c.path));

for (const ambiguous of [false, true]) {
  test(`identity: an explicit dashboardId is used before any name lookup (${ambiguous ? 'several namesakes' : 'a renamed dashboard and a namesake'})`, async () => {
    await withDashboards(true, async () => {
      const wire = wireWithIdReads();
      const own = await makerDashboard(wire, { name: ambiguous ? 'Ops' : 'Maker renamed' });
      await makerDashboard(wire, { name: 'Ops', formid: NAMESAKE });
      const dir = makeTempDir('declared-dash-');
      const r = await build(wire, dir, makeSpec({ dashboard: { dashboardId: own.formid } }), { authorizedAdoption: new Set([`dashboard:${KEY}`]) });
      assert.equal(r.err, undefined, chainText(r.err));
      assert.equal(committedGroup(dir).root.id, own.formid);
      assert.equal(wire.saved.get(own.formid).name, own.name, 'the live name is kept');
      assert.equal(r.formWrites.filter((c) => c.path.includes(NAMESAKE)).length, 0);
    });
  });
}

test('identity: a recorded binding that differs from an authored dashboardId is still refused before any write', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const other = await makerDashboard(wire, { name: 'Other', formid: NAMESAKE });
    const r = await build(wire, dir, makeSpec({ dashboard: { dashboardId: other.formid } }));
    assert.match(chainText(r.err), /dashboard-binding-mismatch/);
    assert.equal(r.formWrites.length + r.publishes.length, 0);
  });
});

test('pending identity: a retained create resumes by the id it recorded, despite a new namesake', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    wire.script((e) => e.method === 'POST' && e.path === 'systemforms', { statusCode: 400, body: { error: { code: '0x80040216', message: 'create rejected after dispatch' } }, unapplied: true });
    assert.ok((await build(wire, dir, makeSpec())).err);
    const pending = storeOf(dir).readGroup('dashboard', KEY).pending;
    assert.ok(pending);
    await makerDashboard(wire, { name: 'Ops', formid: NAMESAKE });
    const second = await build(wire, dir, makeSpec(), { authorizedAdoption: new Set([`dashboard:${KEY}`]) });
    assert.equal(second.err, undefined, chainText(second.err));
    assert.equal(committedGroup(dir).root.id, (pending.root && pending.root.id) || pending.expected.rootId);
    assert.equal(second.formWrites.filter((c) => c.path.includes(NAMESAKE)).length, 0);
  });
});

for (const keepOther of [false, true]) {
  test(`removed declaration: a stored uncertain dashboard publish the org applied is confirmed read-only (${keepOther ? 'another dashboard declared' : 'no dashboard declared'})`, async () => {
    await withDashboards(true, async () => {
      const wire = wireWithIdReads();
      const dir = makeTempDir('declared-dash-');
      wire.script((e) => e.method === 'POST' && e.path === 'PublishXml', { error: new Error('lost answer after apply') });
      assert.ok((await build(wire, dir, makeSpec())).err);
      const old = clone(committedGroup(dir));
      assert.equal(old.publication.state, 'unconfirmed');
      const spec = dropDashboard(makeSpec());
      if (keepOther) spec.dashboards = [{ ...makeSpec().dashboards[0], name: 'Other', key: 'other' }];
      const before = wire.publishes(old.root.id).length;
      const out = await build(wire, dir, spec);
      assert.equal(committedGroup(dir).publication.state, 'confirmed');
      assert.equal(wire.publishes(old.root.id).length, before, 'never replayed');
      assert.equal(out.formWrites.filter((c) => c.path.includes(old.root.id)).length, 0);
      assert.equal(out.barrier.checkAppWrite({ addedDashboards: [old.root.id] }).ok, false, 'the read does not clear this run\'s quarantine');
      assert.deepEqual(committedGroup(dir).originalDeclaration, old.originalDeclaration, 'no new content authority');
      // The quarantine this run opened with stays, so the next run is the clean one.
      const next = await build(wire, dir, spec);
      assert.equal(next.err, undefined, chainText(next.err));
      assert.equal(wire.publishes(old.root.id).length, before);
      assert.equal(next.barrier.checkAppWrite({ addedDashboards: [old.root.id] }).ok, true);
    });
  });
}

test('removed declaration: an unapplied stored publish halts with its structured approval, and the exact CLI approval records it', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const appDir = makeTempDir('declared-dash-');
    const spec = makeSpec();
    wire.script((e) => e.method === 'POST' && e.path === 'PublishXml', { error: new Error('lost unapplied answer'), unapplied: true });
    const first = await cliBuild(wire, appDir, spec);
    assert.ok(first.error);
    const g = committedGroup(first.dir);
    const token = g.publication.dispatchToken;
    const removed = dropDashboard(spec);
    // The engine's halt carries the decision as data, not only as prose.
    const halt = await build(wire, first.dir, removed);
    let cause = null;
    for (let e = halt.err; e; e = e.cause) if (e.dispatchToken) { cause = e; break; }
    assert.ok(cause, chainText(halt.err));
    assert.equal(cause.dispatchToken, token);
    assert.equal(cause.approval, `publication-risk:dashboard:${g.root.id}`);
    assert.equal(typeof cause.remedy, 'string');
    assert.equal(serviceWrites(halt.calls).length, 0);
    const parsed = authorizationKeys(['--authorize', `publication-risk:dashboard:${g.root.id}`], removed);
    assert.equal(parsed.error, null);
    const decision = await cliBuild(wire, appDir, removed, { publicationRisk: parsed.publicationRisk });
    assert.ok(decision.error, 'the deciding invocation still stops');
    assert.equal(committedGroup(first.dir).publication.state, 'owed');
    assert.equal(serviceWrites(decision.calls).length, 0);
  });
});

test('verify: after a maker rename the build rebinds, every dashboard identity check follows the bound dashboard', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const id = committedGroup(dir).root.id;
    rename(wire, id, 'Maker renamed');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const { sdk } = await sdkOver(wire);
    const read = readerFor(sdk, APP, { isolatedReader: isolatedReaderFor(ORIGIN, { httpClient: clientOver(wire) }) });
    const r = await verifySpec(makeSpec(), read, { managedManifest: manifestOf(dir) });
    const checks = r.checks.filter((c) => c.kind === 'dashboard' || c.kind === 'managed-dashboard');
    assert.ok(checks.some((c) => c.kind === 'managed-dashboard' && c.present), JSON.stringify(checks));
    assert.ok(checks.some((c) => c.kind === 'dashboard'), JSON.stringify(checks));
    assert.ok(checks.every((c) => c.present), JSON.stringify(checks));
    // A namesake made later does not redirect the identity checks.
    await makerDashboard(wire, { name: 'Ops', formid: NAMESAKE });
    const again = await verifySpec(makeSpec(), read, { managedManifest: manifestOf(dir) });
    assert.ok(again.checks.filter((c) => c.kind === 'dashboard' || c.kind === 'managed-dashboard').every((c) => c.present));
  });
});

test('verify: a declared dashboard whose binding differs from its authored dashboardId fails, and a pending one is never found by name', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const other = await makerDashboard(wire, { name: 'Ops', formid: NAMESAKE });
    const { sdk } = await sdkOver(wire);
    const read = readerFor(sdk, APP, { isolatedReader: isolatedReaderFor(ORIGIN, { httpClient: clientOver(wire) }) });
    const conflict = await verifySpec(makeSpec({ dashboard: { dashboardId: other.formid } }), read, { managedManifest: manifestOf(dir) });
    const dash = conflict.checks.filter((c) => c.kind === 'dashboard');
    assert.ok(dash.length && dash.every((c) => !c.present), JSON.stringify(dash));
    assert.match(dash[0].detail || '', /bound/);
    // A group whose create is not settled has no identity to verify by: unverified, not the namesake.
    const pendingWire = wireWithIdReads();
    const pendingDir = makeTempDir('declared-dash-');
    pendingWire.script((e) => e.method === 'POST' && e.path === 'systemforms', { statusCode: 400, body: { error: { code: '0x80040216', message: 'create rejected after dispatch' } }, unapplied: true });
    assert.ok((await build(pendingWire, pendingDir, makeSpec())).err);
    await makerDashboard(pendingWire, { name: 'Ops', formid: NAMESAKE });
    const { sdk: pendingSdk } = await sdkOver(pendingWire);
    const pendingRead = readerFor(pendingSdk, APP, { isolatedReader: isolatedReaderFor(ORIGIN, { httpClient: clientOver(pendingWire) }) });
    const pending = await verifySpec(makeSpec(), pendingRead, { managedManifest: manifestOf(pendingDir) });
    assert.equal(pending.checks.filter((c) => c.kind === 'dashboard' && c.present).length, 0, JSON.stringify(pending.checks));
    assert.ok(pending.unverified.some((u) => u.startsWith(`managed:dashboard ${KEY}`)), JSON.stringify(pending.unverified));
  });
});

test('download: a certified declaration keeps every authored value and adds the certified root and tile ids', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    const spec = makeSpec({ dashboard: { key: 'OPS.Key', description: 'Authored text', tiles: [{ key: 'Map.Key', type: 'iframe', url: 'https://contoso.example/map?a=1&b=2', name: 'Named', colspan: 2, rowspan: 16 }] } });
    assert.equal((await build(wire, dir, spec)).err, undefined);
    const g = committedGroup(dir, 'OPS.Key');
    const dl = await download(wire, makeTempDir('declared-dash-'), ['--include-managed', '--managed-manifest', storeFileOf(dir)], { plainId: g.root.id });
    assert.equal(dl.emitted[0].ok, true, JSON.stringify(dl.emitted));
    const [written] = dl.written.dashboards;
    assert.equal(written.dashboardId, g.root.id);
    assert.equal(written.tiles[0].componentId, g.consumerState.tiles['OPS.Key/Map.Key'].id);
    const authored = clone(written);
    delete authored.dashboardId;
    delete authored.tiles[0].componentId;
    assert.deepEqual(authored, spec.dashboards[0], 'no authored value is dropped or rewritten');
    assert.deepEqual(committedGroup(dir, 'OPS.Key').originalDeclaration, spec.dashboards[0], 'the store is not changed');
  });
});

test('download: the restored declaration needs the adoption approval for its first binding in a fresh workspace, and writes nothing', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const g = committedGroup(dir);
    const out = makeTempDir('declared-dash-');
    const dl = await download(wire, out, ['--include-managed', '--managed-manifest', storeFileOf(dir)], { plainId: g.root.id });
    const fresh = path.join(out, '.maker-workspace');
    // Without the approval the build inspects, writes nothing and records no binding: the download transfers none.
    const unbound = await build(wire, fresh, dl.written, { appDir: out });
    assert.equal(unbound.err, undefined, chainText(unbound.err));
    assert.equal(committedGroup(fresh), null);
    assert.equal(unbound.formWrites.length + unbound.publishes.length, 0);
    const bound = await build(wire, fresh, dl.written, { appDir: out, authorizedAdoption: new Set([`dashboard:${KEY}`]) });
    assert.equal(bound.err, undefined, chainText(bound.err));
    assert.equal(committedGroup(fresh).root.id, g.root.id);
    assert.equal(bound.formWrites.length + bound.publishes.length, 0);
  });
});

test('download: after a maker rename and a later namesake, the downloaded declaration still binds the dashboard it was proved on', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const id = committedGroup(dir).root.id;
    const out = makeTempDir('declared-dash-');
    const dl = await download(wire, out, ['--include-managed', '--managed-manifest', storeFileOf(dir)], { plainId: id });
    assert.equal(dl.emitted[0].ok, true);
    rename(wire, id, 'Maker renamed');
    const foreign = await makerDashboard(wire, { name: 'Ops', description: 'Unrelated maker description', formid: NAMESAKE });
    const before = clone(wire.saved.get(foreign.formid));
    const grant = authorizationKeys(['--authorize', `adopt:dashboard:${KEY}`], dl.written);
    assert.equal(grant.error, null);
    const rebuilt = await cliBuild(wire, out, dl.written, { authorizedAdoption: grant.adopt });
    assert.equal(rebuilt.error, undefined, chainText(rebuilt.error));
    assert.deepEqual(wire.saved.get(foreign.formid), before, 'the namesake is not touched');
    assert.equal(wire.publishes(foreign.formid).length, 0);
    assert.equal(committedGroup(rebuilt.dir).root.id, id);
    assert.equal(wire.saved.get(id).name, 'Maker renamed', 'the live name is kept');
  });
});

test('download control: explicit certified root and tile ids inspect without a binding, and bind with the approval without a write', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const g = committedGroup(dir);
    const spec = makeSpec({ dashboard: { dashboardId: g.root.id, tiles: [{ ...makeSpec().dashboards[0].tiles[0], componentId: g.consumerState.tiles[`${KEY}/map`].id }] } });
    const fresh = makeTempDir('declared-dash-');
    const unbound = await build(wire, fresh, spec);
    assert.equal(unbound.err, undefined, chainText(unbound.err));
    assert.equal(committedGroup(fresh), null);
    const bound = await build(wire, fresh, spec, { authorizedAdoption: new Set([`dashboard:${KEY}`]) });
    assert.equal(bound.err, undefined, chainText(bound.err));
    assert.ok(committedGroup(fresh));
    assert.equal(bound.formWrites.length + bound.publishes.length, 0);
  });
});

test('app gate: a withheld dashboard reaches the app writer\'s pre-write check as an added dashboard, and no app write is sent', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    const spec = makeSpec();
    spec.app.icon = 'existing-icon';
    assert.equal((await build(wire, dir, spec)).err, undefined);
    const id = committedGroup(dir).root.id;
    wire.script((e) => e.method === 'GET' && /^webresources(?:et)?$/i.test(e.path) && e.url.includes('existing-icon'), {
      statusCode: 200, body: { value: [{ webresourceid: '66666666-6666-4666-8666-666666666666', name: 'existing-icon', webresourcetype: 11 }] },
    });
    const barrier = createPublicationBarrier();
    barrier.quarantine({ type: 'dashboard', id }, 'withheld dashboard');
    const observer = createAttemptSendObserver();
    const { sdk } = await sdkOver(wire, { barrier, observer });
    const check = barrier.checkAppWrite;
    const checks = [];
    barrier.checkAppWrite = function (args) { checks.push(clone(args)); return check.call(this, args); };
    const mark = wire.log.length;
    let error;
    try {
      await runSdkBuild(spec, { sdk, apply: true, publish: false, workspaceDir: dir, appDir: dir, env: ORIGIN, phases: ['dashboards', 'app-shell'], publicationBarrier: barrier, sendObserver: observer });
    } catch (e) { error = e; }
    assert.ok(checks.some((c) => c.addedDashboards && c.addedDashboards.includes(id) && !c.existingApp), JSON.stringify(checks));
    assert.match(chainText(error), /publication|withheld/i);
    assert.equal(wire.log.slice(mark).filter((c) => c.method !== 'GET' && /^(appmodules|sitemaps)/i.test(c.path)).length, 0);
  });
});

test('publication risk through the CLI: --approve all does not accept it; the exact typed approval records the dispatch, stops, and a fresh run settles', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const appDir = makeTempDir('declared-dash-');
    const spec = makeSpec();
    wire.script((e) => e.method === 'POST' && e.path === 'PublishXml', { error: new Error('lost answer'), unapplied: true });
    const first = await cliBuild(wire, appDir, spec);
    assert.ok(first.error);
    const g = committedGroup(first.dir);
    const token = g.publication.dispatchToken;
    const denied = await cliBuild(wire, appDir, spec, { approve: 'all', allowDestructive: true });
    assert.ok(denied.error);
    assert.equal(committedGroup(first.dir).publication.dispatchToken, token);
    assert.ok(denied.messages.some((m) => m.includes(`publication-risk:dashboard:${g.root.id}`)), denied.messages.join('\n'));
    const parsed = authorizationKeys(['--authorize', `publication-risk:dashboard:${g.root.id}`], spec);
    assert.equal(parsed.error, null);
    const granted = await cliBuild(wire, appDir, spec, { publicationRisk: parsed.publicationRisk });
    assert.ok(granted.error, 'the accepting invocation still stops');
    assert.equal(serviceWrites(granted.calls).length, 0);
    assert.equal(granted.barrier.checkAppWrite({ addedDashboards: [g.root.id] }).ok, false);
    const accepted = JSON.parse(fs.readFileSync(storeFileOf(first.dir), 'utf8')).publicationRiskAcceptances;
    assert.equal(accepted[accepted.length - 1].dispatchToken, token);
    const next = await cliBuild(wire, appDir, spec);
    assert.equal(next.error, undefined, chainText(next.error));
    assert.equal(committedGroup(first.dir).publication.state, 'confirmed');
  });
});

test('publication risk through the CLI: an unchanged all-carried dashboard stays blocked until the exact approval, then a fresh run publishes nothing', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const appDir = makeTempDir('declared-dash-');
    const spec = makeSpec();
    const first = await cliBuild(wire, appDir, spec);
    assert.equal(first.error, undefined, chainText(first.error));
    const g = committedGroup(first.dir);
    const barrier = createPublicationBarrier();
    const { sdk } = await sdkOver(wire, { barrier });
    const { publishManagedScope } = require('../lib/managed-feature-contract.js');
    wire.script((e) => e.method === 'POST' && e.path === 'PublishXml', { error: new Error('lost carried reply') });
    let lost;
    try {
      await publishManagedScope({ store: storeOf(first.dir), barrier, client: sdk.dataverse, scope: g.publication.scope, groups: [], carry: true, publish: async () => {
        await sdk.fetchArtifact('dashboard', g.root.id);
        const answer = await sdk.publishArtifact('dashboard', g.root.id);
        if (answer.publish && answer.publish.kind === 'failed') throw answer.publish.error;
        return answer;
      } });
    } catch (e) { lost = e; }
    assert.equal(lost && lost.code, 'managed-publication-unconfirmed');
    const denied = await cliBuild(wire, appDir, spec);
    assert.ok(denied.error);
    assert.equal(committedGroup(first.dir).publication.state, 'unconfirmed');
    const parsed = authorizationKeys(['--authorize', `publication-risk:dashboard:${g.root.id}`], spec);
    const accepted = await cliBuild(wire, appDir, spec, { publicationRisk: parsed.publicationRisk });
    assert.ok(accepted.error);
    assert.equal(committedGroup(first.dir).publication.state, 'confirmed');
    assert.equal(accepted.barrier.checkAppWrite({ addedDashboards: [g.root.id] }).ok, false);
    const next = await cliBuild(wire, appDir, spec);
    assert.equal(next.error, undefined, chainText(next.error));
    assert.equal(next.calls.filter((c) => c.path === 'PublishXml').length, 0);
  });
});
// One invocation with the caller's barrier (shared by the SDK's send boundary and the build), as build() makes its own.
async function buildWith(wire, dir, spec, { barrier = createPublicationBarrier(), ...opts } = {}) {
  const sendObserver = createAttemptSendObserver();
  const { sdk } = await sdkOver(wire, { barrier, observer: sendObserver });
  const mark = wire.log.length;
  let err;
  try {
    await runSdkBuild(spec, { sdk, apply: true, publish: false, workspaceDir: dir, appDir: dir, env: ORIGIN, phases: ['dashboards'], publicationBarrier: barrier, sendObserver, ...opts });
  } catch (e) { err = e; }
  return { err, barrier, calls: wire.log.slice(mark) };
}
const appWrites = (calls) => calls.filter((c) => c.method !== 'GET' && /^(appmodules|sitemaps|PublishXml)/i.test(c.path));
const scriptIcon = (wire) => wire.script((e) => e.method === 'GET' && /^webresources(?:et)?$/i.test(e.path) && e.url.includes('existing-icon'), {
  statusCode: 200, body: { value: [{ webresourceid: '66666666-6666-4666-8666-666666666666', name: 'existing-icon', webresourcetype: 11 }] },
});
// A bound dashboard whose last change is saved and whose publish is owed: the send boundary held its scope, so it was definitely not sent.
async function owedDashboard() {
  const wire = wireWithIdReads();
  const dir = makeTempDir('declared-dash-');
  assert.equal((await build(wire, dir, makeSpec())).err, undefined);
  const id = committedGroup(dir).root.id;
  const barrier = createPublicationBarrier();
  barrier.blockScope({ type: 'dashboard', id }, 'held before dispatch');
  const changed = makeSpec({ dashboard: { description: 'Saved but not published' } });
  assert.ok((await buildWith(wire, dir, changed, { barrier })).err);
  const group = committedGroup(dir);
  assert.equal(group.publication.state, 'owed');
  assert.equal(group.publication.dispatchToken, null);
  assert.equal(wire.saved.get(id).description, 'Saved but not published');
  assert.equal(wire.published.get(id).description, 'Daily');
  return { wire, dir, id, changed, group };
}

test('removed owed: a removed declaration\'s owed publish is neither paid nor discarded, its scope is fenced for the run, and declaring it again pays it through its proof', async () => {
  await withDashboards(true, async () => {
    const w = await owedDashboard();
    const before = clone(w.group);
    const removed = await buildWith(w.wire, w.dir, dropDashboard(w.changed));
    assert.equal(serviceWrites(removed.calls).length, 0);
    assert.deepEqual(committedGroup(w.dir), before, 'the debt is kept exactly as it was');
    assert.equal(removed.barrier.checkAppWrite({ addedDashboards: [w.id] }).ok, false);
    assert.equal(removed.barrier.checkAppWrite({ existingApp: true, heldDashboards: [w.id] }).ok, false);
    const declared = await buildWith(w.wire, w.dir, w.changed);
    assert.equal(declared.err, undefined, chainText(declared.err));
    assert.equal(committedGroup(w.dir).publication.state, 'confirmed');
    assert.equal(w.wire.published.get(w.id).description, 'Saved but not published');
  });
});

for (const path_ of ['app', 'final publish']) {
  test(`removed owed: a plain entry pinned to its dashboard, with a later maker draft, sends no ${path_} request and is refused before the plain path`, async () => {
    await withDashboards(true, async () => {
      const w = await owedDashboard();
      const spec = makeSpec({ declared: false, dashboard: { dashboardId: w.id } });
      if (path_ === 'app') { spec.app.icon = 'existing-icon'; scriptIcon(w.wire); }
      w.wire.saved.get(w.id).description = 'Later maker draft';
      const r = await buildWith(w.wire, w.dir, spec, path_ === 'app' ? { phases: ['dashboards', 'app-shell'] } : { phases: ['dashboards', 'publish'], publish: true });
      assert.match(chainText(r.err), /managed-dashboard-unsettled/);
      assert.equal(appWrites(r.calls).length, 0, JSON.stringify(appWrites(r.calls).map((c) => c.path)));
      assert.equal(r.calls.filter((c) => c.method !== 'GET' && /^systemforms/i.test(c.path)).length, 0);
      assert.equal(committedGroup(w.dir).publication.state, 'owed');
      assert.equal(w.wire.published.get(w.id).description, 'Daily', 'the maker draft is not published');
    });
  });
}

test('removed owed: a run without the dashboards phase fences the owed dashboard from the app writer too', async () => {
  await withDashboards(true, async () => {
    const w = await owedDashboard();
    const spec = clone(w.changed);
    spec.app.icon = 'existing-icon';
    scriptIcon(w.wire);
    w.wire.saved.get(w.id).description = 'Later maker draft';
    const r = await buildWith(w.wire, w.dir, spec, { phases: ['app-shell'] });
    assert.equal(r.barrier.checkAppWrite({ addedDashboards: [w.id] }).ok, false);
    assert.equal(appWrites(r.calls).filter((c) => /^PublishXml/i.test(c.path) || JSON.stringify(c.body || '').includes(w.id)).length, 0, JSON.stringify(appWrites(r.calls).map((c) => c.path)));
    assert.equal(committedGroup(w.dir).publication.state, 'owed');
    assert.equal(w.wire.published.get(w.id).description, 'Daily');
  });
});

// A never-published root an earlier run left unsettled: its publish lost and not applied (uncertain), held at the send boundary
// (owed), or its create retained as a pending attempt. A plain entry that names it, by its id or by its declared name, must not
// make a second dashboard in its place.
async function retainedRoot(kind) {
  const wire = wireWithIdReads();
  const dir = makeTempDir('declared-dash-');
  let opts = {};
  if (kind === 'uncertain') wire.script((e) => e.method === 'POST' && e.path === 'PublishXml', { error: new Error('lost unapplied publication'), unapplied: true });
  if (kind === 'pending') wire.script((e) => e.method === 'POST' && e.path === 'systemforms', { statusCode: 400, body: { error: { code: '0x80040216', message: 'create rejected after dispatch' } }, unapplied: true });
  if (kind === 'owed') {
    // Hold the new root's scope the moment it is created, so its first publish is definitely not sent.
    const barrier = createPublicationBarrier();
    const request = wire.request.bind(wire);
    wire.request = async (req) => {
      const known = new Set(wire.saved.keys());
      const res = await request(req);
      for (const id of wire.saved.keys()) if (!known.has(id)) barrier.blockScope({ type: 'dashboard', id }, 'held before its first publish');
      return res;
    };
    opts = { barrier };
  }
  assert.ok((await buildWith(wire, dir, makeSpec(), opts)).err);
  const { committed, pending } = storeOf(dir).readGroup('dashboard', KEY);
  const id = committed ? committed.root.id : (pending.root && pending.root.id) || pending.expected.rootId;
  if (kind === 'uncertain') assert.equal(committed.publication.state, 'unconfirmed');
  if (kind === 'owed') assert.equal(committed.publication.state, 'owed');
  if (kind === 'pending') assert.equal(committed, null);
  assert.equal(wire.published.has(id), false);
  return { wire, dir, id, saved: [...wire.saved.keys()] };
}
for (const kind of ['uncertain', 'owed', 'pending']) {
  for (const by of ['id', 'name']) {
    test(`retained identity: a plain entry naming an unsettled ${kind} dashboard by its ${by} creates no second dashboard`, async () => {
      await withDashboards(true, async () => {
        const w = await retainedRoot(kind);
        const legacy = makeSpec({ declared: false, dashboard: by === 'id' ? { dashboardId: w.id } : {} });
        const r = await buildWith(w.wire, w.dir, legacy);
        assert.ok(r.err);
        assert.equal(r.calls.filter((c) => c.method === 'POST' && c.path === 'systemforms').length, 0, chainText(r.err));
        assert.deepEqual([...w.wire.saved.keys()], w.saved);
        assert.equal(r.calls.filter((c) => c.method === 'POST' && c.path === 'PublishXml').length, 0);
        if (kind === 'uncertain') {
          let cause = null;
          for (let e = r.err; e; e = e.cause) if (e.dispatchToken) { cause = e; break; }
          assert.ok(cause, chainText(r.err));
          assert.equal(cause.approval, `publication-risk:dashboard:${w.id}`);
        } else {
          assert.match(chainText(r.err), /managed-dashboard-unsettled/);
        }
      });
    });
  }
}

test('verify: a declared dashboard held to a deleted dashboardId fails, and a namesake is never taken in its place', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const id = committedGroup(dir).root.id;
    const out = makeTempDir('declared-dash-');
    const dl = await download(wire, out, ['--include-managed', '--managed-manifest', storeFileOf(dir)], { plainId: id });
    assert.equal(dl.emitted[0].ok, true);
    wire.saved.delete(id);
    wire.published.delete(id);
    await makerDashboard(wire, { name: 'Ops', formid: NAMESAKE });
    const { sdk } = await sdkOver(wire);
    const read = readerFor(sdk, APP, { isolatedReader: isolatedReaderFor(ORIGIN, { httpClient: clientOver(wire) }) });
    const r = await verifySpec(dl.written, read, { managedManifest: manifestOf(path.join(out, '.maker-workspace')) });
    const checks = r.checks.filter((c) => c.kind === 'dashboard');
    assert.ok(checks.length > 0, JSON.stringify(r.checks));
    assert.ok(checks.every((c) => !c.present), JSON.stringify(checks));
    // A plain (undeclared) entry keeps its name fallback.
    const plain = await verifySpec(makeSpec({ declared: false, dashboard: { dashboardId: id } }), read, {});
    assert.ok(plain.checks.filter((c) => c.kind === 'dashboard').some((c) => c.present), JSON.stringify(plain.checks));
  });
});
// A removed declaration whose dashboard the maker deleted: an owed publish (or none) is retired once both layers read as gone.
const savedReadOf = (id) => (e) => e.method === 'GET' && e.url.includes(id) && /RetrieveUnpublished/.test(e.url);
const publishedReadOf = (id) => (e) => e.method === 'GET' && e.url.includes(id) && !/RetrieveUnpublished/.test(e.url) && /^systemforms\(/i.test(e.path);
const retiredOf = (dir) => JSON.parse(fs.readFileSync(storeFileOf(dir), 'utf8')).retiredGroups || [];

test('removed owed: a deleted dashboard proved gone from both layers is retired with a coded notice; the run and the next are clean, and nothing is sent', async () => {
  await withDashboards(true, async () => {
    const w = await owedDashboard();
    w.wire.saved.delete(w.id);
    w.wire.published.delete(w.id);
    const removed = dropDashboard(w.changed);
    const warnings = [];
    const first = await buildWith(w.wire, w.dir, removed, { warn: (m) => warnings.push(String(m)) });
    assert.equal(first.err, undefined, chainText(first.err));
    assert.equal(serviceWrites(first.calls).length, 0);
    assert.equal(first.calls.filter(savedReadOf(w.id)).length, 1, 'the saved layer is read by its id');
    assert.equal(first.calls.filter(publishedReadOf(w.id)).length, 1, 'the published layer is read by its id');
    assert.ok(warnings.some((m) => m.includes(`declared dashboard "${KEY}": managed-dashboard-retired`) && m.includes(w.id)), warnings.join('\n'));
    assert.equal(committedGroup(w.dir), null);
    const [entry] = retiredOf(w.dir);
    assert.deepEqual({ family: entry.family, key: entry.key, generation: entry.generation, rootId: entry.rootId, reason: entry.reason, publication: entry.publication }, { family: 'dashboard', key: KEY, generation: w.group.generation, rootId: w.id, reason: 'root-absent', publication: 'owed' });
    assert.equal(first.barrier.checkAppWrite({ addedDashboards: [w.id] }).ok, true, 'a retired group installs no fence');
    const second = await buildWith(w.wire, w.dir, removed);
    assert.equal(second.err, undefined, chainText(second.err));
    assert.equal(second.calls.length, 0, 'the next run has nothing to read or send for it');
    assert.equal(retiredOf(w.dir).length, 1);
  });
});

test('removed owed: when this invocation already blocks the scope, the group is retired but that invocation stays stopped; a fresh one is clean', async () => {
  await withDashboards(true, async () => {
    const w = await owedDashboard();
    w.wire.saved.delete(w.id);
    w.wire.published.delete(w.id);
    const removed = dropDashboard(w.changed);
    const barrier = createPublicationBarrier();
    barrier.quarantine({ type: 'dashboard', id: w.id }, [w.id], 'already quarantined in this invocation');
    const held = await buildWith(w.wire, w.dir, removed, { barrier });
    assert.match(chainText(held.err), /already quarantined in this invocation/);
    assert.equal(serviceWrites(held.calls).length, 0);
    assert.equal(committedGroup(w.dir), null, 'the durable result is the retirement');
    assert.equal(held.barrier.checkAppWrite({ addedDashboards: [w.id] }).ok, false, 'its quarantine is never cleared');
    const fresh = await buildWith(w.wire, w.dir, removed);
    assert.equal(fresh.err, undefined, chainText(fresh.err));
  });
});

for (const control of ['saved layer still there', 'published layer still there', 'a 403 read', 'a read that times out']) {
  test(`removed owed control: ${control} keeps the fence and the store unchanged`, async () => {
    await withDashboards(true, async () => {
      const w = await owedDashboard();
      const spec = dropDashboard(w.changed);
      if (control !== 'saved layer still there') w.wire.saved.delete(w.id);
      if (control !== 'published layer still there') w.wire.published.delete(w.id);
      if (control === 'a 403 read') w.wire.script(savedReadOf(w.id), { statusCode: 403, body: { error: { code: '0x80040220', message: 'no read privilege' } } });
      if (control === 'a read that times out') for (let i = 0; i < 8; i += 1) w.wire.script(savedReadOf(w.id), { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), code: 'ETIMEDOUT' });
      const before = fs.readFileSync(storeFileOf(w.dir));
      const r = await buildWith(w.wire, w.dir, spec);
      assert.match(chainText(r.err), /its publish is owed/);
      assert.equal(serviceWrites(r.calls).length, 0);
      assert.equal(r.barrier.checkAppWrite({ addedDashboards: [w.id] }).ok, false);
      assert.ok(fs.readFileSync(storeFileOf(w.dir)).equals(before), 'nothing is retired on unproved absence');
    });
  });
}

test('removed owed control: a deleted dashboard that is still declared, in a run without the dashboards phase, is not retired and stays fenced', async () => {
  await withDashboards(true, async () => {
    const w = await owedDashboard();
    w.wire.saved.delete(w.id);
    w.wire.published.delete(w.id);
    const spec = clone(w.changed);
    spec.app.icon = 'existing-icon';
    scriptIcon(w.wire);
    const before = fs.readFileSync(storeFileOf(w.dir));
    const r = await buildWith(w.wire, w.dir, spec, { phases: ['app-shell'] });
    assert.equal(r.barrier.checkAppWrite({ addedDashboards: [w.id] }).ok, false);
    assert.equal(r.calls.filter((c) => c.url.includes(w.id)).length, 0, 'a declared dashboard is not probed for retirement');
    assert.equal(appWrites(r.calls).filter((c) => /^PublishXml/i.test(c.path)).length, 0);
    assert.ok(fs.readFileSync(storeFileOf(w.dir)).equals(before));
  });
});
test('removed owed control: a never-published root that is still saved keeps its fence', async () => {
  await withDashboards(true, async () => {
    const w = await retainedRoot('owed');
    const before = fs.readFileSync(storeFileOf(w.dir));
    const r = await buildWith(w.wire, w.dir, dropDashboard(makeSpec()));
    assert.match(chainText(r.err), /its publish is owed/);
    assert.equal(r.barrier.checkAppWrite({ addedDashboards: [w.id] }).ok, false);
    assert.equal(serviceWrites(r.calls).length, 0);
    assert.ok(fs.readFileSync(storeFileOf(w.dir)).equals(before));
  });
});

test('removed owed: an existing app is refused before any site map or app write in a run without the dashboards phase', async () => {
  await withDashboards(true, async () => {
    const w = await owedDashboard();
    const spec = dropDashboard(w.changed);
    spec.app.icon = 'existing-icon';
    scriptIcon(w.wire);
    w.wire.script((e) => e.method === 'GET' && e.path === 'appmodules', { statusCode: 200, body: { value: [{ appmoduleid: '77777777-7777-4777-8777-777777777777', name: 'Dash', uniquename: APP }] } });
    const r = await buildWith(w.wire, w.dir, spec, { phases: ['app-shell'] });
    assert.match(chainText(r.err), /app was not written or published/);
    assert.equal(appWrites(r.calls).length, 0);
    assert.equal(committedGroup(w.dir).publication.state, 'owed');
  });
});
test('removed settled: a deleted dashboard with no debt is retired once both layers read as gone; one that still exists keeps its record and no fence', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const group = committedGroup(dir);
    const id = group.root.id;
    const removed = dropDashboard(makeSpec());
    const before = fs.readFileSync(storeFileOf(dir));
    const kept = await buildWith(wire, dir, removed);
    assert.equal(kept.err, undefined, chainText(kept.err));
    assert.equal(serviceWrites(kept.calls).length, 0);
    assert.ok(fs.readFileSync(storeFileOf(dir)).equals(before), 'a dashboard that still exists keeps its record');
    wire.saved.delete(id);
    wire.published.delete(id);
    const warnings = [];
    const gone = await buildWith(wire, dir, removed, { warn: (m) => warnings.push(String(m)) });
    assert.equal(gone.err, undefined, chainText(gone.err));
    assert.equal(serviceWrites(gone.calls).length, 0);
    assert.ok(warnings.some((m) => m.includes('managed-dashboard-retired') && !m.includes('unpublished change')), warnings.join('\n'));
    assert.equal(committedGroup(dir), null);
    assert.equal(retiredOf(dir)[0].rootId, id);
    assert.notEqual(retiredOf(dir)[0].publication, 'owed');
  });
});

// The removed-declaration dead end as first reported: the owed dashboard is deleted from both layers (the presence read
// proves it), its declaration is removed and the build runs twice. Before the retirement both runs ended on the same
// re-declaration instruction with zero requests, and re-declaring stopped on dashboard-bound-row-missing.
test('removed owed liveness: two runs after the deletion finish, and declaring the key again afterwards is not stopped on the deleted row', async () => {
  await withDashboards(true, async () => {
    const w = await owedDashboard();
    w.wire.saved.delete(w.id);
    w.wire.published.delete(w.id);
    const { sdk } = await sdkOver(w.wire);
    assert.equal(await readSystemFormRootPresence(sdk.dataverse, w.id), 'absent');
    const removed = dropDashboard(w.changed);
    const first = await buildWith(w.wire, w.dir, removed);
    const second = await buildWith(w.wire, w.dir, removed);
    assert.equal(first.err, undefined, chainText(first.err));
    assert.equal(second.err, undefined, chainText(second.err));
    assert.equal(serviceWrites([...first.calls, ...second.calls]).length, 0);
    assert.equal(committedGroup(w.dir), null);
    assert.equal(retiredOf(w.dir).length, 1);
    const redeclared = await buildWith(w.wire, w.dir, w.changed);
    assert.doesNotMatch(chainText(redeclared.err), /dashboard-bound-row-missing/);
  });
});

// The retirement is bound to the store as observed BEFORE the two layer reads. Here another invocation settles the owed
// publish against a live published layer (confirmPublished, no dispatch: owed becomes not-needed) while this build is
// reading the saved layer: same generation, same root, a state that is itself retirable. Only the observation tells the
// store that the group moved after the proof's read, so the retirement must be refused and nothing written for it.
test('removed owed: a store change between the observation and the retirement refuses the retirement; the next build observes and reads again', async () => {
  await withDashboards(true, async () => {
    const w = await owedDashboard();
    w.wire.saved.delete(w.id);
    w.wire.published.delete(w.id);
    const removed = dropDashboard(w.changed);
    const request = w.wire.request;
    let raced = 0;
    w.wire.request = async (req) => {
      if (!raced && String(req.method).toUpperCase() === 'GET' && req.url.includes(w.id) && /RetrieveUnpublished/.test(req.url)) {
        raced += 1;
        storeOf(w.dir).confirmPublished({ groups: [{ family: 'dashboard', key: KEY, generation: w.group.generation }], token: null, proof: { publishedSha256: w.group.publication.desiredSha256 || 'a'.repeat(64) } });
      }
      return request(req);
    };
    const warnings = [];
    const r = await buildWith(w.wire, w.dir, removed, { warn: (m) => warnings.push(String(m)) });
    w.wire.request = request;
    assert.equal(raced, 1, 'the concurrent change landed between the observation and the retirement');
    assert.equal(serviceWrites(r.calls).length, 0);
    assert.deepEqual(retiredOf(w.dir), [], 'nothing is retired on a proof about an older state');
    const kept = committedGroup(w.dir);
    assert.equal(kept.generation, w.group.generation);
    assert.equal(kept.publication.state, 'not-needed', 'the concurrent change is kept');
    assert.ok(warnings.some((m) => m.includes(`declared dashboard "${KEY}"`) && m.includes('managed-binding-generation-conflict') && m.includes('its retirement could not be confirmed')), warnings.join('\n'));
    assert.ok(!warnings.some((m) => m.includes('managed-dashboard-retired')), warnings.join('\n'));
    assert.match(chainText(r.err), new RegExp(`managed dashboard "${KEY}" \\(its retirement could not be confirmed`), 'the unconfirmed retirement ends this invocation incomplete');
    assert.equal(r.barrier.checkAppWrite({ addedDashboards: [w.id] }).ok, false, 'and keeps the dashboard fenced in it');
    const next = await buildWith(w.wire, w.dir, removed);
    assert.equal(next.err, undefined, chainText(next.err));
    assert.equal(next.calls.filter(savedReadOf(w.id)).length, 1, 'the next build reads the root again');
    assert.equal(committedGroup(w.dir), null);
    assert.equal(retiredOf(w.dir)[0].publication, 'not-needed');
  });
});

// A refused retirement leaves this invocation's cached store from before the race. Another invocation that, while this one
// reads the published layer, commits a new owed generation, prepares an attempt, or marks a carried publish dispatching, and
// a saved row that is there again: this invocation stops before any write, incomplete and naming the dashboard, and keeps it
// fenced (no app write admits it, a scoped publish naming it is not sent).
for (const state of ['owed', 'pending', 'dispatching']) {
  test(`removed settled: a retirement refused because another invocation left the dashboard ${state} fences it for the rest of this invocation`, async () => {
    await withDashboards(true, async () => {
      const wire = wireWithIdReads();
      const dir = makeTempDir('declared-dash-');
      assert.equal((await build(wire, dir, makeSpec())).err, undefined);
      const g = committedGroup(dir);
      const id = g.root.id;
      const row = { ...wire.saved.get(id), description: 'Concurrent later draft' };
      wire.saved.delete(id);
      wire.published.delete(id);
      const request = wire.request;
      let raced = 0;
      wire.request = async (req) => {
        const answer = await request(req);
        if (!raced && String(req.method).toUpperCase() === 'GET' && req.url.includes(id) && !/RetrieveUnpublished/.test(req.url)) {
          raced += 1;
          const other = storeOf(dir);
          if (state === 'dispatching') {
            other.markPublishDispatch({ groups: [], carried: [{ family: 'dashboard', key: KEY, generation: g.generation, savedSha256: g.publication.desiredSha256, publishedSha256: g.publication.desiredSha256 }], scope: g.publication.scope, token: 'concurrent-publish' });
          } else {
            const token = other.prepareAttempt({ family: 'dashboard', key: KEY, baseGeneration: g.generation, root: g.root, knownScopes: [g.publication.scope], declarationSha256: 'a'.repeat(64), declaration: g.originalDeclaration });
            if (state === 'owed') {
              other.markSending(token, { proofVersion: 1, proofSchema: 'dashboard-v1', rootId: id, baseProofSha256: null, sentProjectionSha256: 'b'.repeat(64), preservationSha256: 'c'.repeat(64), baseObservation: null, children: [] });
              other.noteSaved(token, { proof: g.proof, acknowledgedRoot: false });
              other.commitGroup({ token, baseGeneration: g.generation, records: g.records, proof: g.proof, consumerState: g.consumerState, publication: { scope: g.publication.scope, state: 'owed', desiredSha256: g.publication.desiredSha256, dispatchToken: null } });
            }
          }
          wire.putForm(row);
        }
        return answer;
      };
      const warnings = [];
      const r = await buildWith(wire, dir, dropDashboard(makeSpec()), { warn: (m) => warnings.push(String(m)) });
      wire.request = request;
      assert.equal(raced, 1, 'the concurrent change landed during the published read');
      assert.deepEqual(retiredOf(dir), []);
      assert.ok(warnings.some((m) => m.includes(`declared dashboard "${KEY}"`) && m.includes('managed-binding-generation-conflict') && m.includes('its retirement could not be confirmed') && m.includes('the next build reads it again')), warnings.join('\n'));
      assert.match(chainText(r.err), new RegExp(`managed dashboard "${KEY}" \\(its retirement could not be confirmed`));
      assert.equal(serviceWrites(r.calls).length, 0);
      assert.equal(r.barrier.checkAppWrite({ addedDashboards: [id] }).ok, false, 'no app write admits it');
      const mark = wire.log.length;
      const client = clientOver(wire, { barrier: r.barrier, observer: createAttemptSendObserver() });
      await client.post(`${ORIGIN}/api/data/v9.0/PublishXml`, { ParameterXml: `<importexportxml><dashboards><dashboard>${id}</dashboard></dashboards></importexportxml>` });
      assert.deepEqual(wire.log.slice(mark), [], 'a scoped publish naming it is not sent');
      assert.equal(wire.published.get(id), undefined, 'the concurrent saved row is not put live');
    });
  });
}

// The same race, with the spec now holding a plain dashboard of the removed one's name. The plain path looks a dashboard up by
// name in the PUBLISHED layer only, so a saved-only row is found by nothing there; reading this invocation's cached store from
// before the race, it would see no unsettled group and create a second dashboard, then write and publish the app. In the
// fourth case the other invocation retires the group and starts a fresh create of the same key under another root, which is
// visible in the service: that replacement must not be reused or admitted either. The unconfirmed retirement ends the
// invocation before the plain path or the app shell runs, so nothing but reads is sent.
for (const state of ['owed', 'pending', 'dispatching', 'replacement']) {
  test(`removed settled: after a retirement refused because another invocation left the dashboard ${state}, a plain dashboard of its name creates, reuses and publishes nothing`, async () => {
    await withDashboards(true, async () => {
      const wire = wireWithIdReads();
      const dir = makeTempDir('declared-dash-');
      assert.equal((await build(wire, dir, makeSpec())).err, undefined);
      const g = committedGroup(dir);
      const id = g.root.id;
      const newId = '99999999-9999-4999-8999-999999999999';
      const row = { ...wire.saved.get(id), description: 'Concurrent later draft' };
      wire.saved.delete(id);
      wire.published.delete(id);
      const request = wire.request;
      let raced = 0;
      wire.request = async (req) => {
        const answer = await request(req);
        if (!raced && String(req.method).toUpperCase() === 'GET' && req.url.includes(id) && !/RetrieveUnpublished/.test(req.url)) {
          raced += 1;
          const other = storeOf(dir);
          if (state === 'dispatching') {
            other.markPublishDispatch({ groups: [], carried: [{ family: 'dashboard', key: KEY, generation: g.generation, savedSha256: g.publication.desiredSha256, publishedSha256: g.publication.desiredSha256 }], scope: g.publication.scope, token: 'concurrent-publish' });
          } else {
            if (state === 'replacement') {
              const { observation } = other.observeRetirement({ family: 'dashboard', key: KEY });
              other.retireAbsentGroup({ family: 'dashboard', key: KEY, generation: g.generation, rootId: id, observation, evidence: { kind: 'root-absent', rootId: id, saved: 'not-found', published: 'not-found' } });
            }
            const root = state === 'replacement' ? { ...g.root, id: newId } : g.root;
            const token = other.prepareAttempt({ family: 'dashboard', key: KEY, baseGeneration: state === 'replacement' ? null : g.generation, root, knownScopes: [{ type: 'dashboard', id: root.id }], declarationSha256: 'a'.repeat(64), declaration: g.originalDeclaration });
            if (state === 'owed') {
              other.markSending(token, { proofVersion: 1, proofSchema: 'dashboard-v1', rootId: id, baseProofSha256: null, sentProjectionSha256: 'b'.repeat(64), preservationSha256: 'c'.repeat(64), baseObservation: null, children: [] });
              other.noteSaved(token, { proof: g.proof, acknowledgedRoot: false });
              other.commitGroup({ token, baseGeneration: g.generation, records: g.records, proof: g.proof, consumerState: g.consumerState, publication: { scope: g.publication.scope, state: 'owed', desiredSha256: g.publication.desiredSha256, dispatchToken: null } });
            }
          }
          wire.putForm({ ...row, ...(state === 'replacement' ? { formid: newId } : {}) }, { publishedToo: state === 'replacement' });
        }
        return answer;
      };
      const spec = makeSpec({ declared: false });
      spec.app.icon = 'existing-icon';
      scriptIcon(wire);
      const warnings = [];
      const r = await buildWith(wire, dir, spec, { phases: ['dashboards', 'app-shell', 'publish'], publish: true, warn: (m) => warnings.push(String(m)) });
      wire.request = request;
      assert.equal(raced, 1, 'the concurrent change landed during the published read');
      assert.ok(warnings.some((m) => m.includes(`declared dashboard "${KEY}"`) && m.includes('its retirement could not be confirmed')), warnings.join('\n'));
      assert.equal(r.calls.filter((c) => c.method === 'POST' && c.path === 'systemforms').length, 0, 'no second plain dashboard is created');
      assert.deepEqual(appWrites(r.calls).map((c) => `${c.method} ${c.path}`), [], 'no app write or publish goes ahead');
      assert.equal(r.err && r.err.code, 'managed-not-settled', chainText(r.err));
      assert.deepEqual(r.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), [], 'nothing but reads is sent');
      assert.equal(r.barrier.checkAppWrite({ addedDashboards: [id] }).ok, false);
      const now = storeOf(dir).readGroup('dashboard', KEY);
      if (state === 'owed') assert.equal(now.committed.publication.state, 'owed', 'the concurrent debt is kept, not paid');
      if (state === 'dispatching') assert.equal(now.committed.publication.state, 'dispatching', 'the concurrent dispatch is kept');
      if (state === 'pending' || state === 'replacement') assert.notEqual(now.pending, null, 'the concurrent attempt is kept');
    });
  });
}

// The race lands inside the observation itself: another invocation retires the group and starts a fresh create of the same key
// under another root, named anew. This invocation's one observation already sees the replacement, so its retirement is not
// confirmed, and it does not read the store again: it stops there, before the plain dashboard (by the replacement's name, or
// pinned to the replacement's id), the app shell or a publish runs. A reread that would fail changes nothing, as none is made.
const REPLACEMENT = '99999999-9999-4999-8999-999999999999';
async function raceAtObservation() {
  const wire = wireWithIdReads();
  const dir = makeTempDir('declared-dash-');
  assert.equal((await build(wire, dir, makeSpec())).err, undefined);
  const g = committedGroup(dir);
  const id = g.root.id;
  const row = { ...wire.saved.get(id) };
  wire.saved.delete(id);
  wire.published.delete(id);
  const store = storeOf(dir);
  const counts = { observations: 0, retirements: 0, refreshes: 0 };
  const observe = store.observeRetirement;
  const retire = store.retireAbsentGroup;
  const refresh = store.refresh;
  store.observeRetirement = (arg) => {
    counts.observations += 1;
    const other = storeOf(dir);
    const { observation } = other.observeRetirement({ family: 'dashboard', key: KEY });
    other.retireAbsentGroup({ family: 'dashboard', key: KEY, generation: g.generation, rootId: id, observation, evidence: { kind: 'root-absent', rootId: id, saved: 'not-found', published: 'not-found' } });
    const declaration = { ...g.originalDeclaration, name: 'New Name' };
    other.prepareAttempt({ family: 'dashboard', key: KEY, baseGeneration: null, root: { ...g.root, id: REPLACEMENT }, knownScopes: [{ type: 'dashboard', id: REPLACEMENT }], declarationSha256: 'a'.repeat(64), declaration });
    wire.putForm({ ...row, formid: REPLACEMENT, name: 'New Name' }, { publishedToo: true });
    return observe(arg);
  };
  store.retireAbsentGroup = (arg) => { counts.retirements += 1; return retire(arg); };
  store.refresh = (...args) => {
    counts.refreshes += 1;
    if (counts.refreshes > 1) throw new Error('the store file cannot be reread');
    return refresh(...args);
  };
  return { wire, dir, id, store, counts };
}
for (const by of ['name', 'id']) {
  test(`removed settled: a replacement learned by the observation (by its ${by}) stops the invocation before any write; a reread is never needed`, async () => {
    await withDashboards(true, async () => {
      const w = await raceAtObservation();
      const spec = makeSpec({ declared: false, dashboard: by === 'name' ? { name: 'New Name' } : { name: 'Unrelated', dashboardId: REPLACEMENT } });
      spec.appShell.areas[0].groups[0].subAreas[0].dashboard = spec.dashboards[0].name;
      spec.app.icon = 'existing-icon';
      scriptIcon(w.wire);
      const warnings = [];
      const r = await buildWith(w.wire, w.dir, spec, { bindingGroups: { store: w.store }, phases: ['dashboards', 'app-shell', 'publish'], publish: true, warn: (m) => warnings.push(String(m)) });
      assert.deepEqual([w.counts.observations, w.counts.retirements, w.counts.refreshes], [1, 0, 1], 'one observation, no retirement, nothing reread after it');
      assert.equal(r.err && r.err.code, 'managed-not-settled', chainText(r.err));
      assert.match(chainText(r.err), new RegExp(`managed dashboard "${KEY}" \\(its retirement could not be confirmed: the binding store changed before its dashboard was read\\); the build stopped before writing anything, and the next build reads it again`));
      assert.ok(warnings.some((m) => m.includes(`declared dashboard "${KEY}"`) && m.includes('this build stops before writing anything')), warnings.join('\n'));
      assert.deepEqual(r.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), [], 'nothing but reads is sent');
      assert.deepEqual(r.calls.filter((c) => /^(appmodules|sitemaps|webresources)/i.test(c.path) || decodeURIComponent(c.url).includes('New Name') || c.url.includes(REPLACEMENT)).map((c) => c.url), [], 'neither the plain dashboard path nor the app shell ran');
      assert.equal(r.barrier.checkAppWrite({ addedDashboards: [w.id] }).ok, false, 'the old quarantine is kept');
      const now = storeOf(w.dir).readGroup('dashboard', KEY);
      assert.equal(now.pending && now.pending.root.id, REPLACEMENT, 'the other invocation\'s attempt is kept as it was');
    });
  });
}

// Liveness: a store that cannot be observed once stops that invocation before anything is written; the next invocation reads
// the store afresh, retires the deleted dashboard, and writes and publishes the app as it always did.
test('removed settled liveness: an observation that fails stops the invocation before any write; the next one retires and builds the app', async () => {
  await withDashboards(true, async () => {
    const wire = wireWithIdReads();
    const dir = makeTempDir('declared-dash-');
    assert.equal((await build(wire, dir, makeSpec())).err, undefined);
    const id = committedGroup(dir).root.id;
    wire.saved.delete(id);
    wire.published.delete(id);
    const spec = dropDashboard(makeSpec({ declared: false }));
    spec.app.icon = 'existing-icon';
    scriptIcon(wire);
    const store = storeOf(dir);
    store.observeRetirement = () => { throw Object.assign(new Error('the store file is locked'), { code: 'managed-binding-store-busy' }); };
    const opts = { phases: ['dashboards', 'app-shell', 'publish'], publish: true };
    const first = await buildWith(wire, dir, spec, { ...opts, bindingGroups: { store } });
    assert.equal(first.err && first.err.code, 'managed-not-settled', chainText(first.err));
    assert.match(chainText(first.err), /the binding store could not be observed \(managed-binding-store-busy: the store file is locked\)/);
    assert.deepEqual(first.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), []);
    assert.notEqual(committedGroup(dir), null, 'nothing is retired');
    const warnings = [];
    const next = await buildWith(wire, dir, spec, { ...opts, warn: (m) => warnings.push(String(m)) });
    assert.equal(next.err, undefined, chainText(next.err));
    assert.ok(warnings.some((m) => m.includes('managed-dashboard-retired')), warnings.join('\n'));
    assert.equal(committedGroup(dir), null);
    assert.ok(appWrites(next.calls).length > 0, 'the app is written and published');
  });

});
// --- a key declared again after its root was retired -------------------------------------------------------------------------

// A dashboard made by a build, then deleted from both layers and retired by a build without its declaration, so the store's
// key has a new incarnation and the old id is the retired one. `retainSdk`: every build keeps the SDK's workspace in `dir`
// (answered as `sdk`, the options that keep it for later builds), so it still holds its synced copy of the retired row.
async function retiredDashboard({ retainSdk = false } = {}) {
  const wire = wireWithIdReads();
  const dir = makeTempDir('declared-dash-');
  const sdk = retainSdk ? { sdkDir: dir } : {};
  assert.equal((await build(wire, dir, makeSpec(), sdk)).err, undefined);
  const old = clone(committedGroup(dir));
  wire.saved.delete(old.root.id);
  wire.published.delete(old.root.id);
  const retired = await build(wire, dir, dropDashboard(makeSpec()), sdk);
  assert.equal(retired.err, undefined, chainText(retired.err));
  assert.equal(retiredOf(dir)[0].rootId, old.root.id);
  // Read from the envelope, not incarnations(), so a build without incarnations fails on what it sends, not on an accessor.
  const reborn = (storeOf(dir).snapshot().envelope.incarnations || []).find((x) => x.family === 'dashboard' && x.key === KEY) || {};
  return { wire, dir, old, reborn: reborn.rootId, sdk };
}
// Whether the SDK workspace kept in `dir` (sdkOver `workspaceDir`) still lists the artifact `id` in its manifest.
const sdkHolds = (dir, id) => fs.existsSync(path.join(dir, 'manifest.json')) && fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').toLowerCase().includes(id);
const dashboardPosts = (r) => r.formWrites.filter((c) => c.method === 'POST').map((c) => String(c.body.formid).toLowerCase());

for (const fresh of [false, true]) {
  test(`a declared dashboard declared again after its root was retired is created and published under a fresh id, its tiles under it, and the next build is write-free (${fresh ? 'a fresh' : 'the same'} workspace)`, async () => {
    await withDashboards(true, async () => {
      // The SDK's workspace is the build workspace throughout: the same one keeps it (and its synced copy of the retired
      // row) through the create, the retirement and the new declaration; a fresh one is a new directory with only the store.
      const { wire, dir, old, reborn } = await retiredDashboard({ retainSdk: true });
      const ws = fresh ? makeTempDir('declared-dash-') : dir;
      if (fresh) fs.copyFileSync(storeFileOf(dir), storeFileOf(ws));
      assert.equal(sdkHolds(ws, old.root.id), !fresh, 'the same workspace still holds the SDK\'s copy of the retired row; a fresh one holds none');
      const first = await build(wire, ws, makeSpec(), { sdkDir: ws });
      assert.equal(first.err, undefined, chainText(first.err));
      assert.ok(!dashboardPosts(first).includes(old.root.id), 'the retired id is never created again');
      assert.deepEqual(dashboardPosts(first), [reborn], 'one create, under the incarnation');
      assert.ok(!JSON.stringify(first.writes).toLowerCase().includes(old.root.id), 'no write names the retired id');
      assert.equal(first.publishes.length, 1);
      assert.match(first.publishes[0].body.ParameterXml, new RegExp(`<dashboard>${reborn}</dashboard>`, 'i'));
      const bound = committedGroup(ws);
      assert.equal(bound.root.id, reborn);
      const oldIds = new Set(old.records.map((r) => String(r.id).toLowerCase()));
      assert.deepEqual(bound.records.map((r) => String(r.id).toLowerCase()).filter((id) => oldIds.has(id)), [], 'every tile is derived under the new root');
      const second = await build(wire, ws, makeSpec(), { sdkDir: ws });
      assert.equal(second.err, undefined, chainText(second.err));
      assert.deepEqual([second.formWrites, second.publishes], [[], []]);
    });
  });
}

test('a declared dashboard declared again after retirement keeps its incarnation through a create the org never applied, and is never sent under the retired id', async () => {
  await withDashboards(true, async () => {
    const { wire, dir, old, reborn } = await retiredDashboard();
    wire.script((e) => e.method === 'POST' && e.path === 'systemforms', { statusCode: 400, body: { error: { code: '0x80040216', message: 'create rejected after dispatch' } }, unapplied: true });
    const lost = await build(wire, dir, makeSpec());
    assert.ok(lost.err);
    assert.ok(!dashboardPosts(lost).includes(old.root.id), 'the retired id is never created again');
    assert.deepEqual(dashboardPosts(lost), [reborn]);
    const next = await build(wire, dir, makeSpec());
    assert.equal(next.err, undefined, chainText(next.err));
    assert.ok(!dashboardPosts(next).includes(old.root.id), 'the retired id is never created again');
    assert.deepEqual(dashboardPosts(next), [reborn], 'sent again under the same id');
    assert.equal(committedGroup(dir).root.id, reborn);
    assert.ok(!JSON.stringify([lost.writes, next.writes]).toLowerCase().includes(old.root.id));
  });
});
// A retained SDK workspace (the maker's own, kept between builds): a re-declared dashboard whose create answer keeps being
// lost leaves the SDK's local copy of the new row unsynced, and the documented dirty-copy fence holds it. Every retry stops
// with create-completion-required, sends nothing and keeps the attempt on the incarnation. Discarding only the owned local
// copy (no service request) is the documented recovery: the next build completes under the same id, with the adoption
// approval when the create landed, and nothing is ever sent under the retired id.
for (const applied of [false, true]) {
  test(`a re-declared dashboard in a retained SDK workspace whose create answer was lost stays behind the dirty-copy fence under its incarnation until only its own local copy is discarded (${applied ? 'the create landed' : 'it did not land'})`, async () => {
    await withDashboards(true, async () => {
      const { wire, dir, old, reborn, sdk: kept } = await retiredDashboard({ retainSdk: true });
      assert.ok(sdkHolds(dir, old.root.id), 'the SDK workspace is the retained one');
      let fault = true;
      for (let n = 0; n < 12; n += 1) {
        wire.script((e) => fault && e.method === 'POST' && e.path === 'systemforms', { error: 'socket hang up', code: 'ECONNRESET', ...(applied && n === 0 ? {} : { unapplied: true }) });
      }
      const lost = await build(wire, dir, makeSpec(), kept);
      fault = false;
      assert.ok(lost.err, 'the lost answer stops the build');
      assert.deepEqual([...new Set(dashboardPosts(lost))], [reborn]);
      assert.equal(storeOf(dir).readGroup('dashboard', KEY).pending.root.id, reborn);
      const approval = applied ? { authorizedAdoption: new Set([`dashboard:${KEY}`]) } : {};
      for (let n = 0; n < 2; n += 1) {
        const blocked = await build(wire, dir, makeSpec(), { ...kept, ...approval });
        assert.equal(blocked.err && blocked.err.code, 'create-completion-required', chainText(blocked.err));
        assert.deepEqual(blocked.writes, [], 'the fence sends nothing');
        assert.equal(storeOf(dir).readGroup('dashboard', KEY).pending.root.id, reborn, 'the attempt keeps the incarnation');
      }
      const { sdk } = await sdkOver(wire, { workspaceDir: dir });
      const mark = wire.log.length;
      await sdk.deleteArtifact('dashboard', reborn);
      assert.equal(wire.log.length, mark, 'discarding the owned local copy makes no service request');
      const next = await build(wire, dir, makeSpec(), { ...kept, ...approval });
      assert.equal(next.err, undefined, chainText(next.err));
      assert.deepEqual(dashboardPosts(next), applied ? [] : [reborn], 'completed under the same id');
      assert.equal(committedGroup(dir).root.id, reborn);
      assert.ok(!JSON.stringify([lost.writes, next.writes]).toLowerCase().includes(old.root.id), 'nothing is sent under the retired id');
    });
  });
}