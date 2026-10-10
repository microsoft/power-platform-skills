'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { stageFacts, makeAllPresentReader } = require('../lib/facts.js');
const { ASSERTIONS } = require('../lib/assertions.js');
const { loadFixtures } = require('../lib/fixture-loader.js');
const evalsManifest = require('../evals.json');

function fixtureFor(id) {
  const fixture = loadFixtures(path.join(__dirname, '..', 'fixtures')).find((f) => f.id === id);
  assert.ok(fixture, `fixture ${id} exists`);
  return fixture;
}

function score(text, facts, fixture) {
  const check = ASSERTIONS.get(text);
  assert.strictEqual(typeof check, 'function', `registered assertion: ${text}`);
  return check({ facts, spec: fixture.spec, eval: evalsManifest.evals.find((e) => e.id === fixture.id) });
}

// A minimal but valid schemaVersion:2 spec covering all stage primitives: one entity with a
// Choice column, a view, a chart, a form, an intent page (no .tsx), and a sitemap subarea for each.
// The page key and display name intentionally differ: v2 sitemap references use the stable key.
const spec = {
  schemaVersion: 2,
  solution: { uniqueName: 'S', publisherPrefix: 'new' },
  app: { name: 'T', description: '' },
  entities: [{
    schemaName: 'new_order', displayName: 'Order',
    primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [{ schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['New', 'Done'] }],
  }],
  views: [{ entity: 'new_order', name: 'Active Orders', columns: ['new_name', 'new_status'], activeOnly: true }],
  charts: [{ entity: 'new_order', name: 'Orders by Status', groupBy: 'new_status', measure: 'count', chartType: 'Pie' }],
  forms: [{ entity: 'new_order', type: 'main', name: 'Order', layout: 'auto' }],
  pages: [{ key: 'overview', name: 'Overview', source: { kind: 'intent' }, navigatesTo: [{ targetKey: 'overview' }] }],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [
    { entity: 'new_order', title: 'Orders' },
    { page: 'overview', title: 'Overview' },
  ] }] }] },
};

test('stageFacts.author validates under the plan profile and lints clean', async () => {
  const f = await stageFacts(spec);
  assert.strictEqual(f.author.validate.ok, true, JSON.stringify(f.author.validate.errors));
  assert.strictEqual(f.author.lint.errors.length, 0, JSON.stringify(f.author.lint.errors));
});

test('stageFacts.data/ui expose normalized structural facts', async () => {
  const f = await stageFacts(spec);
  assert.deepStrictEqual(f.data.tables.map((t) => t.logicalName), ['new_order']);
  assert.deepStrictEqual(f.ui.views.map((v) => v.name), ['Active Orders']);
  assert.deepStrictEqual(f.ui.charts.map((c) => c.name), ['Orders by Status']);
  assert.ok(f.ui.forms[0].fields.includes('new_name'), 'primary field placed in form');
});

test('stageFacts.app resolves every sitemap subarea and reports no dangling nav', async () => {
  const f = await stageFacts(spec);
  const refs = f.app.areas.flatMap((a) => a.groups.flatMap((g) => g.subAreas.map((s) => s.ref)));
  assert.ok(refs.every((r) => r), `all subareas should have a resolved ref; got ${JSON.stringify(refs)}`);
  // overview→overview: targetKey "overview" matches p.key "overview" → not dangling.
  assert.deepStrictEqual(f.app.danglingNav, []);
});

test('stageFacts.plan groups items by known engine phase; verify runs offline', async () => {
  const f = await stageFacts(spec);
  assert.ok(f.plan.phases.every((p) => f.PHASES.includes(p)), `unknown phase in plan: ${f.plan.phases.filter((p) => !f.PHASES.includes(p))}`);
  assert.strictEqual(f.verify.ok, true, `unexpected verify result: ${JSON.stringify(f.verify)}`);
  assert.deepStrictEqual(f.verify.missing, []);
});

test('verification exceptions fail the eval rather than skip', async () => {
  const layoutSpec = require('../fixtures/6-form-layout/app-spec.json');
  const check = ASSERTIONS.get('verify: reconcile against an all-present reader returns ok with no missing');
  const positive = await stageFacts(layoutSpec);
  assert.strictEqual(check({ facts: positive }).status, 'pass');

  const throwingVerifier = await stageFacts(layoutSpec, {
    verifier: async () => { throw new Error('verifier regression'); },
  });
  assert.strictEqual(throwingVerifier.verify.ok, false);
  assert.strictEqual(throwingVerifier.verify.skipped, undefined);
  const failure = check({ facts: throwingVerifier });
  assert.strictEqual(failure.status, 'fail');
  assert.match(failure.reason, /verifier regression/);

  const reader = makeAllPresentReader(layoutSpec);
  reader.formTopology = async () => { throw new Error('topology read regression'); };
  const throwingReader = await stageFacts(layoutSpec, { verifyReader: reader });
  assert.strictEqual(throwingReader.verify.ok, false);
  assert.strictEqual(check({ facts: throwingReader }).status, 'fail');
  assert.ok(throwingReader.verify.missing.some((m) => /topology read regression/.test(m.detail)));

  // Isolate the injected plugin export in a child process: a scorer failure must also reach the
  // runner's exit code, without altering the production module or another test's require cache.
  const runner = path.join(__dirname, '..', 'run-app-builder.js');
  const verifierPath = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'scripts', 'lib', 'verify-spec.js');
  const child = spawnSync(process.execPath, ['-e', `
    require(${JSON.stringify(verifierPath)}).verifySpec = async () => { throw new Error('verifier regression'); };
    process.argv = [process.execPath, ${JSON.stringify(runner)}, '--eval', '6'];
    require(${JSON.stringify(runner)}).main();
  `], { encoding: 'utf8' });
  assert.strictEqual(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stdout, /not ok \d+ - verify: reconcile against an all-present reader/);
  assert.match(child.stdout, /verifier regression/);

  const malformed = await stageFacts(layoutSpec, { verifier: async () => ({ skipped: 'unspecified optional extension' }) });
  assert.strictEqual(check({ facts: malformed }).status, 'fail', 'a skip-shaped result is not required verification');
  const noTopology = makeAllPresentReader(layoutSpec);
  delete noTopology.formTopology;
  const absentReader = await stageFacts(layoutSpec, { verifyReader: noTopology });
  assert.strictEqual(check({ facts: absentReader }).status, 'fail', 'topology is required, unlike the served-order capability');
  assert.match(check({ facts: absentReader }).reason, /UNVERIFIED/);
});

test('verification requires each applicable check kind, not just an ok flag', async () => {
  const f = await stageFacts(require('../fixtures/6-form-layout/app-spec.json'));
  const check = ASSERTIONS.get('verify: every required check kind actually ran');
  assert.strictEqual(typeof check, 'function', 'the required-check assertion is registered');
  assert.strictEqual(check({ facts: f }).status, 'pass');
  for (const kind of ['entity', 'column', 'view', 'chart', 'form', 'form-order', 'form-topology', 'form-order-served']) {
    assert.ok(f.verify.requiredChecks[kind] > 0, `${kind} is required by fixture 6`);
    const drifted = structuredClone(f);
    drifted.verify.checks = drifted.verify.checks.filter((c) => c.kind !== kind);
    const result = check({ facts: drifted });
    assert.strictEqual(result.status, 'fail', `${kind} cannot silently stop running`);
    assert.ok(result.reason.includes(kind), result.reason);
  }
  const empty = structuredClone(f);
  empty.verify.checks = [];
  assert.strictEqual(check({ facts: empty }).status, 'fail', 'ok:true with no checks is not verification');
});

test('an unavailable optional served-form reader is a named skip, never a verifier-error skip', async () => {
  const layoutSpec = require('../fixtures/6-form-layout/app-spec.json');
  const check = ASSERTIONS.get('verify: served Main form order is checked or explicitly unavailable');
  assert.strictEqual(typeof check, 'function', 'the optional capability assertion is registered');
  const positive = await stageFacts(layoutSpec);
  assert.strictEqual(check({ facts: positive }).status, 'pass');

  const reader = makeAllPresentReader(layoutSpec);
  delete reader.servedMainForms;
  const unavailable = await stageFacts(layoutSpec, { verifyReader: reader });
  assert.strictEqual(unavailable.verify.ok, true);
  const result = check({ facts: unavailable });
  assert.strictEqual(result.status, 'skip');
  assert.match(result.reason, /servedMainForms.*optional/i);

  reader.servedMainForms = async () => { throw new Error('served order regression'); };
  const broken = await stageFacts(layoutSpec, { verifyReader: reader });
  assert.strictEqual(check({ facts: broken }).status, 'fail');
});

test('stageFacts.teardown plans a reverse-of-build delete ending at the solution, web resources after tables', async () => {
  const f = await stageFacts(spec);
  const kinds = f.teardown.kinds;
  assert.strictEqual(kinds[kinds.length - 1], 'solution', 'the solution container is deleted last');
  assert.ok(kinds.includes('table'), 'a table delete step is planned');
  // Web resources (incl. the build's generated icon + the page manifest) are torn down AFTER tables —
  // a table's icon web resource is referenced by the table, so it cannot be removed until the table is.
  const lastTable = kinds.lastIndexOf('table');
  const firstWr = kinds.indexOf('webResource');
  assert.ok(firstWr > lastTable, `web-resource step (${firstWr}) must follow the last table (${lastTable})`);
});

test('stageFacts.roundTrip preserves the compared synthetic metadata (solution, tables, pages, sitemap)', async () => {
  const f = await stageFacts(spec);
  assert.strictEqual(f.roundTrip.error, undefined, f.roundTrip.error);
  assert.strictEqual(f.roundTrip.solution, 'S', 'the solution round-trips');
  assert.deepStrictEqual(f.roundTrip.tables, ['new_order'], 'tables round-trip');
  assert.deepStrictEqual(f.roundTrip.pageKeys, ['overview'], 'page keys round-trip');
  assert.deepStrictEqual(f.roundTrip.origSubareaTargets, f.roundTrip.hydratedSubareaTargets, 'the sitemap subareas round-trip unchanged');
  assert.deepStrictEqual(f.roundTrip.hydratedSubareaTargets, ['entity:new_order', 'page:overview']);
});

// A spec with a classic dashboard pinned to the nav — exercises the download→rebuild dashboard
// reconstruction (readDashboards + DashBoard-subarea hydrate) and the teardown dashboard step.
const dashSpec = {
  schemaVersion: 2,
  solution: { uniqueName: 'D', publisherPrefix: 'new' },
  app: { name: 'A', description: '' },
  entities: [{ schemaName: 'new_asset', displayName: 'Asset', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' },
    columns: [{ schemaName: 'new_status', displayName: 'Status', type: 'Choice', options: ['A', 'B'] }] }],
  views: [{ entity: 'new_asset', name: 'Active Assets', columns: ['new_name', 'new_status'], activeOnly: true }],
  charts: [{ entity: 'new_asset', name: 'Assets by Status', groupBy: 'new_status', measure: 'count', chartType: 'Column' }],
  dashboards: [{ name: 'Ops', tiles: [{ type: 'chart', chart: 'Assets by Status', view: 'Active Assets' }, { type: 'list', view: 'Active Assets', name: 'Recent' }] }],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_asset', title: 'Assets' }, { dashboard: 'Ops', title: 'Dash' }] }] }] },
};

test('stageFacts round-trips a classic DashBoard subarea and plans its teardown', async () => {
  const f = await stageFacts(dashSpec);
  assert.strictEqual(f.author.validate.ok, true, JSON.stringify(f.author.validate.errors));
  assert.ok(f.teardown.kinds.includes('dashboard'), 'a dashboard delete step is planned');
  assert.strictEqual(f.roundTrip.error, undefined, f.roundTrip.error);
  // The DashBoard subarea is reconstructed by name (readDashboards id-passthrough) and survives the round-trip.
  assert.deepStrictEqual(f.roundTrip.hydratedSubareaTargets, ['entity:new_asset', 'dashboard:Ops']);
});

// A lookup-heavy child (8 scalars + a 1:N parent lookup) with a no-label sub-grid — exercises the
// 2026-07-15 fixes at the fact level: #2 (default view keeps the lookup), #7 (no createdon), #5
// (sub-grid own 1-column section titled by the child pluralName).
const hardeningSpec = {
  schemaVersion: 2,
  solution: { uniqueName: 'H', publisherPrefix: 'new' },
  app: { name: 'H', description: '' },
  entities: [
    { schemaName: 'new_customer', displayName: 'Customer', pluralName: 'Customers', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    { schemaName: 'new_ticket', displayName: 'Ticket', pluralName: 'Tickets', primaryAttribute: { schemaName: 'new_subject', displayName: 'Subject' },
      columns: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => ({ schemaName: `new_${s}`, displayName: s.toUpperCase(), type: 'Text' })) },
  ],
  relationships: [{ type: 'OneToMany', referenced: 'new_customer', referencing: 'new_ticket', lookup: { schemaName: 'new_CustomerId', displayName: 'Customer' } }],
  forms: [{ entity: 'new_customer', type: 'main', name: 'Customer', layout: 'auto', subgrids: [{ childEntity: 'new_ticket', view: 'Open Tickets' }] }],
  views: [{ entity: 'new_ticket', name: 'Open Tickets', columns: ['new_subject'], activeOnly: true }],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [{ entity: 'new_customer', title: 'Customers' }] }] }] },
  sampleData: { new_customer: [{ new_name: 'Acme' }], new_ticket: [{ new_subject: 'Down', new_a: 'x', $parent: { entity: 'new_customer', match: { new_name: 'Acme' } } }] },
};

test('stageFacts.ui.defaultViews keep the parent lookup despite 8 scalars (#2) and drop createdon (#7)', async () => {
  const f = await stageFacts(hardeningSpec);
  assert.strictEqual(f.author.validate.ok, true, JSON.stringify(f.author.validate.errors));
  const tk = f.ui.defaultViews['new_ticket'];
  assert.ok(tk, 'new_ticket is enrichable');
  assert.ok(tk.columns.includes('new_customerid'), `#2: parent lookup kept; got [${tk.columns}]`);
  assert.strictEqual(tk.lookupsPresent, true, '#2: every parent lookup present');
  assert.strictEqual(tk.hasCreatedon, false, '#7: no createdon in the enriched default view');
});

test('stageFacts.ui.subgrids give each sub-grid a 1-column section titled by the child pluralName (#5)', async () => {
  const f = await stageFacts(hardeningSpec);
  const sg = f.ui.subgrids.find((s) => s.childEntity === 'new_ticket');
  assert.ok(sg, 'sub-grid fact present');
  assert.strictEqual(sg.sectionColumns, 1, '#5: full-width 1-column section');
  assert.strictEqual(sg.label, 'Tickets', '#5: title from child pluralName, not the logical name');
});

// Two personas exercising the security facts: an app-access "Agent" (jobs touch two authored tables +
// one external table) and an opted-out "Analyst" (appAccess:false). Proves securityFacts computes the
// declared/granted unions, the appmodule injection, and clean app-table resolution (#1 + #2 evals).
const personaSpec = {
  schemaVersion: 2,
  solution: { uniqueName: 'P', publisherPrefix: 'new' },
  app: { name: 'P', description: '' },
  entities: [
    { schemaName: 'new_order', displayName: 'Order', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
    { schemaName: 'new_customer', displayName: 'Customer', primaryAttribute: { schemaName: 'new_name', displayName: 'Name' }, columns: [] },
  ],
  appShell: { areas: [{ label: 'M', groups: [{ label: 'G', subAreas: [
    { entity: 'new_order', title: 'Orders' }, { entity: 'new_customer', title: 'Customers' },
  ] }] }] },
  personas: [
    { persona: 'Agent', jobs: [{ name: 'Handle orders', privileges: [
      { entity: 'new_order', access: ['read', 'write', 'create'], scope: 'businessUnit' },
      { entity: 'new_customer', access: ['read'], scope: 'organization' },
      { entity: 'account', access: ['read'], scope: 'organization' },
    ] }] },
    { persona: 'Analyst', appAccess: false, jobs: [{ name: 'Report', privileges: [
      { entity: 'new_order', access: ['read'], scope: 'organization' },
    ] }] },
  ],
};

test('stageFacts.security computes declared/granted unions, appmodule injection, and clean table resolution', async () => {
  const f = await stageFacts(personaSpec);
  assert.strictEqual(f.author.validate.ok, true, JSON.stringify(f.author.validate.errors));
  const agent = f.security.find((r) => r.persona === 'Agent');
  const analyst = f.security.find((r) => r.persona === 'Analyst');
  // Agent has app access -> appmodule read injected into GRANTED but never into DECLARED.
  assert.strictEqual(agent.appAccess, true);
  assert.strictEqual(agent.appModuleRead, true);
  assert.deepStrictEqual(agent.granted.appmodule, { read: 'organization' }, 'granted carries the injected appmodule read');
  assert.strictEqual(agent.declared.appmodule, undefined, 'declared never carries the injection');
  // Declared union preserves per-(entity, access) scope (businessUnit lower-cased).
  assert.deepStrictEqual(agent.declared.new_order, { create: 'businessunit', read: 'businessunit', write: 'businessunit' });
  assert.deepStrictEqual(agent.declared.new_customer, { read: 'organization' });
  // No app-prefixed table is unprovisioned; the external `account` is exempt (not `new`-prefixed).
  assert.deepStrictEqual(agent.unresolvedAppTables, []);
  // Analyst opted out of app access -> no appmodule injection anywhere.
  assert.strictEqual(analyst.appAccess, false);
  assert.strictEqual(analyst.appModuleRead, false);
  assert.strictEqual(analyst.granted.appmodule, undefined);
});

test('stageFacts.security flags a persona privilege on an app-prefixed table the app never provisions (#1)', async () => {
  const bogus = JSON.parse(JSON.stringify(personaSpec));
  // `new_bogus` carries the app's own `new` prefix but is not in entities[] -> unresolved.
  bogus.personas[0].jobs[0].privileges.push({ entity: 'new_bogus', access: ['read'], scope: 'user' });
  const f = await stageFacts(bogus);
  const agent = f.security.find((r) => r.persona === 'Agent');
  assert.deepStrictEqual(agent.unresolvedAppTables, ['new_bogus']);
});

// Drive the #1/#2 assertions directly with synthetic facts so the FAIL paths are proven (fixtures only
// exercise the PASS/SKIP paths). Mirrors how the runner invokes a check: `check({ facts, spec, eval })`.
const coverageCheck = ASSERTIONS.get('security: every persona privilege on an app-owned table resolves to a provisioned entity');
const overGrantCheck = ASSERTIONS.get('security: each persona role grants exactly its declared job privileges (no over-grant)');

test('security #1 coverage assertion: skips with no personas, fails on an unresolved app table', () => {
  assert.strictEqual(coverageCheck({ facts: { security: [] } }).status, 'skip');
  const r = coverageCheck({ facts: { security: [{ persona: 'X', unresolvedAppTables: ['new_bogus'] }] } });
  assert.strictEqual(r.status, 'fail');
  assert.match(r.reason, /new_bogus/);
});

test('security #2 least-privilege assertion: passes faithful mapping, catches over-grant / scope inflation / under-grant / leak', () => {
  const wrap = (rec) => ({ facts: { security: [rec] } });
  // Faithful mapping (declared == granted, plus the allowed appmodule injection) passes.
  assert.strictEqual(overGrantCheck(wrap({ persona: 'A', appAccess: true,
    declared: { new_order: { read: 'user' } },
    granted: { new_order: { read: 'user' }, appmodule: { read: 'organization' } },
  })).status, 'pass');
  // Extra entity the author never declared.
  assert.match(overGrantCheck(wrap({ persona: 'A', appAccess: true,
    declared: { new_order: { read: 'user' } },
    granted: { new_order: { read: 'user' }, new_secret: { read: 'user' } },
  })).reason, /new_secret/);
  // Extra access token beyond declared.
  assert.match(overGrantCheck(wrap({ persona: 'A', appAccess: true,
    declared: { new_order: { read: 'user' } },
    granted: { new_order: { read: 'user', delete: 'user' } },
  })).reason, /delete/);
  // PER-ACCESS scope inflation: the entity's max declared scope is organization (read), but write is
  // only declared @user — granting write@organization must still fail even though read@org is declared.
  assert.match(overGrantCheck(wrap({ persona: 'A', appAccess: true,
    declared: { new_order: { read: 'organization', write: 'user' } },
    granted: { new_order: { read: 'organization', write: 'organization' } },
  })).reason, /write.*scope|scope/);
  // UNDER-grant: a declared privilege the role does not carry (mapper dropped it).
  assert.match(overGrantCheck(wrap({ persona: 'A', appAccess: true,
    declared: { new_order: { read: 'user', write: 'user' } },
    granted: { new_order: { read: 'user' } },
  })).reason, /under-grant/);
  // appmodule granted while the persona opted out of app access (and never declared it) = leak.
  assert.match(overGrantCheck(wrap({ persona: 'A', appAccess: false,
    declared: { new_order: { read: 'user' } },
    granted: { new_order: { read: 'user' }, appmodule: { read: 'organization' } },
  })).reason, /leak/);
});

// The form-shape oracle used to FLATTEN sections across form-columns on both sides, so a section
// that moved from column 0 to column 1 — keeping its order and fields — produced identical flat
// lists and passed. That is precisely the topology this assertion exists to prove, so the oracle was
// blind to the defect class it was written for. Both projections now group by form-column.
test('the form-topology assertion sees a section moved between form-columns', () => {
  const check = ASSERTIONS.get('ui: an explicit layout compiles to the authored tab, form-column and section topology (it is not flattened)');
  const sec = (label, fields) => ({ label, columns: 1, fields });
  const tab = (byColumn) => ({
    label: 'General', expanded: true, columnCount: byColumn.length,
    declaredWidths: byColumn.map(() => null), sectionsByColumn: byColumn,
  });
  const authored = [tab([[sec('L', ['a'])], [sec('R', ['b'])]])];
  const run = (compiled) => check({ facts: { ui: { forms: [{ name: 'F', authoredShape: authored, compiledShape: compiled, placements: [] }] } } });

  assert.strictEqual(run([tab([[sec('L', ['a'])], [sec('R', ['b'])]])]).status, 'pass',
    'the authored topology compiled faithfully must still pass');

  // Both sections collapsed into column 0. Flattened, this is still [L, R] — indistinguishable from
  // the correct shape, which is exactly how it used to slip through.
  const collapsed = run([tab([[sec('L', ['a']), sec('R', ['b'])], []])]);
  assert.strictEqual(collapsed.status, 'fail', 'a section moved out of its form-column must fail');
  assert.match(collapsed.reason, /form-column 0/, `the failure must name the form-column: ${collapsed.reason}`);

  // Same section count per column, but swapped between them — the subtlest version, where every
  // per-column count matches and only the contents moved.
  const swapped = run([tab([[sec('R', ['b'])], [sec('L', ['a'])]])]);
  assert.strictEqual(swapped.status, 'fail', 'sections swapped between form-columns must fail');
});

test('form facts detect state order width and quick-view drift', async () => {
  const fixture = fixtureFor(7);
  const facts = await stageFacts(fixture.spec, { fixture });
  assert.ok(facts.formReconcile, 'independent deployed form evidence is scored');
  const topology = 'ui: an explicit layout compiles to the authored tab, form-column and section topology (it is not flattened)';
  const state = 'ui: explicit container names display flags and field state match authored intent';
  const baseline = 'verify: form reconciliation exercises an inserted tab and reordered existing containers';
  const quickViews = 'verify: Quick View bindings survive form reconciliation';
  const verify = 'verify: reconcile against an all-present reader returns ok with no missing';
  for (const text of [topology, state, baseline, quickViews, verify]) {
    assert.strictEqual(score(text, facts, fixture).status, 'pass', text);
  }
  const badBaseline = structuredClone(facts);
  badBaseline.formReconcile.edits.find((e) => e.name === 'Work Item').before = [];
  const baselineFailure = score(baseline, badBaseline, fixture);
  assert.strictEqual(baselineFailure.status, 'fail', 'a fresh-only fixture cannot masquerade as an edit baseline');
  assert.match(baselineFailure.reason, /baseline tab order/);
  const main = facts.ui.forms.find((f) => f.name === 'Work Item');
  assert.deepStrictEqual(main.authoredShape[1].expectedWidths, ['50%', '50%']);
  assert.strictEqual(main.authoredShape[2].name, 'tab_admin');
  assert.strictEqual(main.authoredShape[2].visible, false);
  assert.strictEqual(main.authoredShape[1].sectionsByColumn[0][0].visible, false);
  assert.strictEqual(main.authoredShape[1].sectionsByColumn[0][1].showLabel, false);
  assert.ok(main.authoredPlacements.some((p) => p.field === 'cnt_projectid' && p.hidden && p.readOnly));
  assert.ok(facts.verify.checks.some((c) => c.kind === 'form-order-served' && c.present));

  const xml = fixture.evidence.formReconcile.forms[0].xml;
  const swap = (source, tag, first, second) => {
    const block = (name) => new RegExp(`<${tag} name="${name}"[\\s\\S]*?<\\/${tag}>`).exec(source)[0];
    const a = block(first), b = block(second);
    return source.replace(a, '__FIRST_CONTAINER__').replace(b, a).replace('__FIRST_CONTAINER__', b);
  };
  const changes = [
    ['hidden tab', (s) => s.replace('name="tab_admin" visible="false"', 'name="tab_admin" visible="true"'), /tab_admin.*visible/],
    ['collapsed tab', (s) => s.replace('name="tab_admin" visible="false" expanded="false"', 'name="tab_admin" visible="false" expanded="true"'), /tab_admin.*expanded/],
    ['hidden section', (s) => s.replace('name="section_notes" columns="1" visible="false"', 'name="section_notes" columns="1" visible="true"'), /section_notes.*visible/],
    ['section label display', (s) => s.replace('name="section_execution" columns="11" visible="true" showlabel="false"', 'name="section_execution" columns="11" visible="true" showlabel="true"'), /section_execution.*showlabel/],
    ['hidden field', (s) => s.replace('id="lookup_cell" visible="false"', 'id="lookup_cell" visible="true"'), /cnt_projectid.*visible/],
    ['read-only field', (s) => s.replace('id="project_lookup" datafieldname="cnt_projectid" disabled="true"', 'id="project_lookup" datafieldname="cnt_projectid" disabled="false"'), /cnt_projectid.*disabled/],
    ['equal-split width', (s) => s.replace('width="50%"', 'width="100%"'), /form-column 1.*100%.*50%/],
    ['grid width', (s) => s.replace('name="section_execution" columns="11"', 'name="section_execution" columns="1"'), /section_execution.*column/],
    ['tab order', (s) => swap(s, 'tab', 'tab_intake', 'tab_admin'), /tabs.*order/],
    ['section order', (s) => swap(s, 'section', 'section_notes', 'section_execution'), /sections.*order/],
    ['inserted tab missing', (s) => s.replace(/<tab name="tab_intake"[\s\S]*?<\/tab>/, ''), /tab_intake.*absent/],
    ['field span', (s) => s.replace('colspan="2"', 'colspan="1"'), /cnt_title.*colspan/],
    ['field rowspan', (s) => s.replace('rowspan="2"', 'rowspan="1"'), /cnt_notes.*rowspan/],
    ['stored form order', (s) => s.replace('Order="0"', 'Order="2"'), /form-order.*not after/],
  ];
  for (const [name, change, reason] of changes) {
    const changed = structuredClone(fixture);
    const deployed = change(xml);
    assert.notStrictEqual(deployed, xml, `${name} changes one deployed fact`);
    changed.evidence.formReconcile.forms[0].xml = deployed;
    const drift = await stageFacts(changed.spec, { fixture: changed });
    const result = score(verify, drift, changed);
    assert.strictEqual(result.status, 'fail', name);
    assert.match(result.reason, reason, `${name}: ${result.reason}`);
  }

  const served = structuredClone(fixture);
  served.evidence.formReconcile.servedMainForms.cnt_workitem.reverse();
  const wrongOrder = await stageFacts(served.spec, { fixture: served });
  assert.strictEqual(score(verify, wrongOrder, served).status, 'fail');
  assert.match(score(verify, wrongOrder, served).reason, /form-order-served.*Work Item Review/);

  for (const [name, change, reason] of [
    ['missing Quick View', (s) => s.replace(/<cell id="quickview_cell"[\s\S]*?<\/cell>/, ''), /Quick View.*missing/],
    ['wrong Quick View form', (s) => s.replace('00000000-0000-0000-0000-000000000703</QuickFormId>', '00000000-0000-0000-0000-000000000704</QuickFormId>'), /Quick View.*form/],
    ['wrong Quick View lookup', (s) => s.replace('id="project_quickview" classid="{5C5600E0-1D6E-4205-A272-BE80DA87FD42}" datafieldname="cnt_projectid"', 'id="project_quickview" classid="{5C5600E0-1D6E-4205-A272-BE80DA87FD42}" datafieldname="cnt_wrongid"'), /Quick View.*lookup/],
    ['wrong Quick View target table', (s) => s.replace('QuickFormId entityname="cnt_project"', 'QuickFormId entityname="cnt_workitem"'), /Quick View.*form/],
    ['wrong Quick View class', (s) => s.replace('classid="{5C5600E0-1D6E-4205-A272-BE80DA87FD42}"', 'classid="{4273EDBD-AC1D-40D3-9FB2-095C621B552D}"'), /Quick View.*control class/],
  ]) {
    const changed = structuredClone(fixture);
    changed.evidence.formReconcile.forms[0].xml = change(xml);
    assert.notStrictEqual(changed.evidence.formReconcile.forms[0].xml, xml, name);
    const result = score(quickViews, await stageFacts(changed.spec, { fixture: changed }), changed);
    assert.strictEqual(result.status, 'fail', name);
    assert.match(result.reason, reason);
  }

  // The Quick View is encountered before the ordinary lookup and has the same binding. Its display
  // state must neither mask a wrong lookup state nor make a correct lookup fail.
  const independentCard = structuredClone(fixture);
  independentCard.evidence.formReconcile.forms[0].xml = xml
    .replace('id="quickview_cell" visible="false"', 'id="quickview_cell" visible="true"')
    .replace('datafieldname="cnt_projectid" disabled="true">\n', 'datafieldname="cnt_projectid" disabled="false">\n');
  const unchangedLookup = await stageFacts(independentCard.spec, { fixture: independentCard });
  assert.strictEqual(score(verify, unchangedLookup, independentCard).status, 'pass');

  for (const [name, mutate] of [
    ['tab name', (f) => { f.compiledShape[2].name = 'tab_wrong'; }],
    ['section name', (f) => { f.compiledShape[1].sectionsByColumn[0][0].name = 'section_wrong'; }],
    ['tab visibility', (f) => { f.compiledShape[2].visible = true; }],
    ['section visibility', (f) => { f.compiledShape[1].sectionsByColumn[0][0].visible = true; }],
    ['section showLabel', (f) => { f.compiledShape[1].sectionsByColumn[0][1].showLabel = true; }],
    ['compiled field state', (f) => { f.placements.find((p) => p.field === 'cnt_reviewer').readOnly = false; }],
    ['compiled hidden field', (f) => { f.placements.find((p) => p.field === 'cnt_notes').hidden = false; }],
  ]) {
    const drift = structuredClone(facts);
    mutate(drift.ui.forms.find((f) => f.name === 'Work Item'));
    const result = score(state, drift, fixture);
    assert.strictEqual(result.status, 'fail', name);
    assert.match(result.reason, /Work Item/);
  }
  const wrongWidth = structuredClone(facts);
  wrongWidth.ui.forms.find((f) => f.name === 'Work Item').compiledShape[1].declaredWidths[0] = '100%';
  assert.strictEqual(score(topology, wrongWidth, fixture).status, 'fail', 'omitted authored widths still require the independent equal split');
});

test('page round-trip facts preserve own names and models through the real download helpers and hydrator', async () => {
  const fixture = fixtureFor(8);
  const facts = await stageFacts(fixture.spec, { fixture });
  assert.strictEqual(facts.roundTrip.source, 'pac-download-fixture', 'read committed PAC files, not a compiler-generated page');
  const text = 'round-trip: generative pages preserve their names and models';
  assert.strictEqual(score(text, facts, fixture).status, 'pass');
  const page = (f, key) => f.roundTrip.pageMetadata.find((p) => p.key === key);
  assert.strictEqual(page(facts, 'revenue').name, 'Revenue "FY"');
  assert.strictEqual(page(facts, 'revenue').model, 'gpt-4.1');
  assert.deepStrictEqual(page(facts, 'revenue').dataSources, ['cnt_order']);
  assert.strictEqual(page(facts, 'help').model, null);
  assert.strictEqual(page(facts, 'archive').model, null);
  assert.deepStrictEqual(facts.roundTrip.origSubareaTargets, facts.roundTrip.hydratedSubareaTargets);

  for (const [name, key, field, value] of [
    ['lost name', 'revenue', 'name', undefined],
    ['navigation title used as name', 'revenue', 'name', 'Revenue Navigation'],
    ['escaping accumulates', 'revenue', 'name', 'Revenue \\"FY\\"'],
    ['model emptied', 'revenue', 'model', ''],
    ['model dropped', 'revenue', 'model', null],
    ['absent model invented', 'help', 'model', 'gpt-4.1'],
    ['invalid model retained', 'archive', 'model', 'model with spaces'],
  ]) {
    const changed = structuredClone(facts);
    page(changed, key)[field] = value;
    const result = score(text, changed, fixture);
    assert.strictEqual(result.status, 'fail', name);
    assert.match(result.reason, new RegExp(`${key}.*${field}`));
  }

  const { hydrateSpec } = require('../../../../plugins/model-apps/scripts/lib/hydrate-spec.js');
  for (const field of ['name', 'model']) {
    const changed = await stageFacts(fixture.spec, { fixture, hydrator: async (reader) => {
      const hydrated = await hydrateSpec(reader);
      delete hydrated.pages.find((p) => p.key === 'revenue')[field];
      return hydrated;
    } });
    assert.strictEqual(score(text, changed, fixture).status, 'fail', `a broken hydrate dropping ${field} cannot score green`);
  }
});

test('invalid downloaded page models are dropped with discriminating loss diagnostics', async () => {
  const fixture = fixtureFor(8);
  const facts = await stageFacts(fixture.spec, { fixture });
  const text = 'round-trip: invalid downloaded models are omitted with explicit diagnostics';
  assert.strictEqual(score(text, facts, fixture).status, 'pass');
  assert.deepStrictEqual(facts.roundTrip.unkeptModels, [
    { pageId: '00000000-0000-0000-0000-000000000803', model: 'model with spaces' },
  ]);
  const missingWarning = structuredClone(facts);
  missingWarning.roundTrip.unkeptModels = [];
  assert.strictEqual(score(text, missingWarning, fixture).status, 'fail', 'silent model loss is not a successful round trip');
  const retained = structuredClone(facts);
  retained.roundTrip.pageMetadata.find((p) => p.key === 'archive').model = 'model with spaces';
  assert.strictEqual(score(text, retained, fixture).status, 'fail', 'a diagnostic does not excuse retaining invalid metadata');
  const unreadable = structuredClone(facts);
  unreadable.roundTrip.unreadableConfigs = [{ pageId: '00000000-0000-0000-0000-000000000801', reason: 'invalid JSON' }];
  assert.strictEqual(score(text, unreadable, fixture).status, 'fail', 'unknown bindings must not look like an absent model');
});

test('changed-only facts use real hashes snapshots and classifications and reject wrong verdicts', async () => {
  const fixture = fixtureFor(9);
  const facts = await stageFacts(fixture.spec, { fixture });
  assert.ok(facts.changedOnly, 'the real changed-only decision core is exercised');
  const text = 'changed-only: page bytes use a page-only fast path data-model edits use full and identical inputs are noop';
  assert.strictEqual(score(text, facts, fixture).status, 'pass');
  assert.strictEqual(facts.changedOnly.snapshot.eligible, true);
  assert.strictEqual(facts.changedOnly.baselineVerified, true);
  assert.ok(facts.verify.checks.some((c) => c.kind === 'page' && c.present), 'implemented pages must also be verified');
  assert.ok(facts.verify.requiredChecks.page > 0);
  const cases = facts.changedOnly.cases;
  assert.deepStrictEqual(cases.map((c) => [c.name, c.verdict]), [
    ['page-only', 'fast'], ['column-edit', 'full'], ['identical', 'noop'],
  ]);
  const hashes = facts.changedOnly.contentHashes;
  for (const row of hashes) {
    assert.match(row.before, /^[0-9a-f]{64}$/);
    assert.match(row.after, /^[0-9a-f]{64}$/);
    assert.strictEqual(row.before !== row.after, row.key === 'overview', 'only overview bytes differ');
  }
  assert.deepStrictEqual(cases[0].fastChanges.map((c) => [c.shape, c.phase, c.identity]), [['page', 'pages', 'overview']]);
  assert.match(cases[1].fullReasons[0], /data-model: changed/);

  for (const [index, wrong] of [[0, 'noop'], [0, 'full'], [1, 'fast'], [1, 'noop'], [2, 'fast'], [2, 'full']]) {
    const changed = structuredClone(facts);
    changed.changedOnly.cases[index].verdict = wrong;
    const result = score(text, changed, fixture);
    assert.strictEqual(result.status, 'fail', `${cases[index].name} cannot report ${wrong}`);
    assert.match(result.reason, /verdict/);
  }
  for (const [name, mutate, reason] of [
    ['wrong page identity', (c) => { c.cases[0].fastChanges[0].identity = 'detail'; }, /page-only.*fast changes/],
    ['extra page upload', (c) => { c.cases[0].fastChanges.push({ shape: 'page', phase: 'pages', identity: 'detail' }); }, /page-only.*fast changes/],
    ['wrong phase', (c) => { c.cases[0].changedPhases = ['forms']; }, /page-only.*phases/],
    ['wrong full reason', (c) => { c.cases[1].fullReasons = ['pages changed']; }, /column-edit.*reason/],
    ['missing case', (c) => { c.cases.pop(); }, /case/],
    ['ineligible snapshot', (c) => { c.snapshot.eligible = false; }, /snapshot/],
    ['unverified baseline', (c) => { c.baselineVerified = false; }, /baseline/],
    ['unexpected debt', (c) => { c.cases[1].debt = [{ artifactType: 'entity', identity: 'cnt_order', reason: 'unexpected debt' }]; }, /debt/],
  ]) {
    const changed = structuredClone(facts);
    mutate(changed.changedOnly);
    const result = score(text, changed, fixture);
    assert.strictEqual(result.status, 'fail', name);
    assert.match(result.reason, reason);
  }
});

test('artifact names are per-table and page quote warnings remain visible', async () => {
  const fixture = fixtureFor(10);
  const facts = await stageFacts(fixture.spec, { fixture });
  const names = 'author: artifact-name warnings use per-table and form-type scope';
  const quotes = 'author: page quote warnings remain visible without rewriting approved names';
  assert.strictEqual(facts.author.validate.ok, true, JSON.stringify(facts.author.validate.errors));
  assert.deepStrictEqual(facts.author.lint.errors, []);
  assert.strictEqual(score(names, facts, fixture).status, 'pass');
  assert.strictEqual(score(quotes, facts, fixture).status, 'pass');
  assert.deepStrictEqual(facts.author.artifactNameCollisions, [], 'shared names on different tables are not collisions');
  assert.deepStrictEqual(facts.author.pageNames.map((p) => p.name), fixture.spec.pages.map((p) => p.name));
  const quoteWarnings = facts.author.lint.warnings.filter((w) => w.includes('ASCII double quote'));
  assert.strictEqual(quoteWarnings.length, 1);
  assert.match(quoteWarnings[0], /Revenue "FY"/);
  assert.ok(!quoteWarnings.some((w) => w.includes("Clerk's Queue") || w.includes('Revenue \u201cFY\u201d')));
  assert.ok(facts.author.lint.warnings.some((w) => !w.includes('ASCII double quote')), 'other legitimate warnings remain non-fatal');

  for (const [collection, kind] of [['forms', 'form'], ['views', 'view'], ['charts', 'chart']]) {
    const changed = structuredClone(fixture);
    changed.spec[collection].push(structuredClone(changed.spec[collection][0]));
    const duplicate = await stageFacts(changed.spec, { fixture: changed });
    assert.ok(duplicate.author.lint.warnings.some((w) => w.startsWith(`Duplicate ${kind} name on cnt_order:`)), `${kind}: same-table duplicate is flagged by the real linter`);
    const result = score(names, duplicate, changed);
    assert.strictEqual(result.status, 'fail', `${kind}: a same-table duplicate cannot pass the fixture contract`);
    assert.match(result.reason, /same-table duplicate.*cnt_order/);
  }

  const otherType = structuredClone(fixture);
  otherType.spec.forms.push({ ...otherType.spec.forms[0], formType: 'QuickView' });
  const typeScoped = await stageFacts(otherType.spec, { fixture: otherType });
  assert.strictEqual(score(names, typeScoped, otherType).status, 'pass', 'Main and QuickView names have separate identities');
  assert.ok(typeScoped.author.lint.warnings.some((w) => /QuickView.*isn't placed/.test(w)), 'an unrelated advisory does not become a blanket failure');

  const globalCollision = structuredClone(facts);
  globalCollision.author.lint.warnings.push('Duplicate form name on cnt_ticket: Information');
  assert.strictEqual(score(names, globalCollision, fixture).status, 'fail', 'a globally scoped duplicate warning is a false positive');
  const missingQuote = structuredClone(facts);
  missingQuote.author.lint.warnings = missingQuote.author.lint.warnings.filter((w) => !w.includes('ASCII double quote'));
  assert.strictEqual(score(quotes, missingQuote, fixture).status, 'fail', 'quote warnings must not silently disappear');
  for (const key of ['apostrophe', 'typographic']) {
    const changed = structuredClone(facts);
    const name = fixture.spec.pages.find((p) => p.key === key).name;
    changed.author.lint.warnings.push(`Page '${name}': pac stores each ASCII double quote`);
    assert.strictEqual(score(quotes, changed, fixture).status, 'fail', `${key} is not an ASCII-quote warning`);
  }
  const rewritten = structuredClone(facts);
  rewritten.author.pageNames.find((p) => p.key === 'straight-quote').name = 'Revenue FY';
  assert.strictEqual(score(quotes, rewritten, fixture).status, 'fail', 'the approved name must not be silently sanitized');

  const runner = path.join(__dirname, '..', 'run-app-builder.js');
  const shown = spawnSync(process.execPath, [runner, '--eval', '10'], { encoding: 'utf8' });
  assert.strictEqual(shown.status, 0, shown.stdout + shown.stderr);
  assert.match(shown.stdout, /# lint warning:.*ASCII double quote/, 'the warning is visible in green TAP output');
  const lintPath = path.join(__dirname, '..', '..', '..', '..', 'plugins', 'model-apps', 'scripts', 'lib', 'spec-lint.js');
  const lost = spawnSync(process.execPath, ['-e', `
    const lint = require(${JSON.stringify(lintPath)});
    const realLint = lint.lintAppSpec;
    lint.lintAppSpec = (spec) => {
      const result = realLint(spec);
      return { ...result, warnings: result.warnings.filter((w) => !w.includes('ASCII double quote')) };
    };
    process.argv = [process.execPath, ${JSON.stringify(runner)}, '--eval', '10'];
    require(${JSON.stringify(runner)}).main();
  `], { encoding: 'utf8' });
  assert.strictEqual(lost.status, 1, lost.stdout + lost.stderr);
  assert.match(lost.stdout, /not ok \d+ - author: page quote warnings/);

  const sanitized = spawnSync(process.execPath, ['-e', `
    const lint = require(${JSON.stringify(lintPath)});
    const realLint = lint.lintAppSpec;
    lint.lintAppSpec = (spec) => {
      for (const page of spec.pages || []) page.name = page.name.replace(/"/g, '');
      return realLint(spec);
    };
    process.argv = [process.execPath, ${JSON.stringify(runner)}, '--eval', '10'];
    require(${JSON.stringify(runner)}).main();
  `], { encoding: 'utf8' });
  assert.strictEqual(sanitized.status, 1, 'an input-mutating linter cannot rewrite its own approved-name expectation:\n' + sanitized.stdout + sanitized.stderr);
  assert.match(sanitized.stdout, /approved page names were rewritten/);
});

test('evidence loading rejects malformed form records and out-of-fixture XML paths by fixture name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-evidence-'));
  const dir = path.join(root, '6-form-evidence');
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify(require('../fixtures/6-form-layout/app-spec.json')));
    fs.writeFileSync(path.join(dir, 'inside.xml'), '<form/>');
    fs.writeFileSync(path.join(root, 'outside.xml'), '<form/>');
    const form = { id: '00000000-0000-0000-0000-000000000601', entity: 'new_workitem', name: 'Work Item', xmlFile: 'inside.xml' };
    const write = (body) => fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify(body));
    write({ formReconcile: { forms: [form] } });
    assert.strictEqual(loadFixtures(root)[0].evidence.formReconcile.forms[0].xml, '<form/>');
    for (const body of [
      { formReconcile: 'not an object' },
      { formReconcile: { forms: 'not an array' } },
      { formReconcile: { forms: [null] } },
    ]) {
      write(body);
      assert.throws(() => loadFixtures(root), /Fixture 6-form-evidence:.*formReconcile/);
    }
    write({ formReconcile: { forms: [{ ...form, xmlFile: path.join('..', 'outside.xml') }] } });
    assert.throws(() => loadFixtures(root), /Fixture 6-form-evidence:.*outside the fixture/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evidence XML remains confined when the fixtures root is accessed through a junction or symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-evidence-link-'));
  const corpus = path.join(root, 'corpus');
  const dir = path.join(corpus, '6-linked-evidence');
  const alias = path.join(root, 'alias');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify(require('../fixtures/6-form-layout/app-spec.json')));
    fs.writeFileSync(path.join(dir, 'inside.xml'), '<form/>');
    const form = { id: '00000000-0000-0000-0000-000000000601', entity: 'new_workitem', name: 'Work Item', xmlFile: 'inside.xml' };
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify({ formReconcile: { forms: [form] } }));
    fs.symlinkSync(corpus, alias, 'junction');
    assert.strictEqual(loadFixtures(alias)[0].evidence.formReconcile.forms[0].xml, '<form/>');
    fs.writeFileSync(path.join(corpus, 'outside.xml'), '<form/>');
    fs.writeFileSync(path.join(dir, 'evidence.json'), JSON.stringify({ formReconcile: { forms: [{ ...form, xmlFile: path.join('..', 'outside.xml') }] } }));
    assert.throws(() => loadFixtures(alias), /Fixture 6-linked-evidence:.*outside the fixture/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the app-builder fixture roster and required assertion texts match the registry', () => {
  const fixtures = loadFixtures(path.join(__dirname, '..', 'fixtures'));
  const check = (inputs, manifest) => {
    assert.deepStrictEqual(inputs.map((f) => f.id).sort((a, b) => a - b), manifest.evals.map((e) => e.id).sort((a, b) => a - b), 'fixture ids match the manifest');
    for (const ev of manifest.evals) for (const text of [...manifest.common_stage_assertions, ...(ev.expectations || [])]) {
      assert.ok(ASSERTIONS.has(text), `unregistered assertion for eval ${ev.id}: ${text}`);
    }
  };
  check(fixtures, evalsManifest);
  assert.throws(() => check(fixtures.slice(1), evalsManifest), /fixture ids/);
  const typo = structuredClone(evalsManifest);
  typo.evals.find((e) => e.id === 7).expectations.push('verify: an unregistered required assertion');
  assert.throws(() => check(fixtures, typo), /unregistered assertion/);
});