'use strict';
// Generative pages on forms (forms[].genPages, pages[].placement 'form') through the build and the gates in front of it:
//   - the spec gates accept a form-only page that a form embeds, keep an embed's `inputData` object as it was written, and still refuse a
//     form-only page no form embeds (warnings only under the shape-only `structural` profile);
//   - the build's pages phase embeds the page once it exists: the add runs through the create port, which allocates its ids and sends the form
//     push from inside its one execute; the cell names the page's id, and the form's publish is owed to the run's publication;
//   - a requested embed the build cannot apply (no create port; the forms phase not in the run; the pages phase not in the run) halts it as
//     `form-page-embeds-incomplete` — never a success with a warning — and a spec with no embed needs no port and plans no step;
//   - the verifier finds a form-placed page through the form that embeds it, not the sitemap, and holds every other page to the sitemap as before;
//   - the caller's TypeScript provider reaches the page backend the build makes, and the page gates' parsers, in the shapes each reads.
require('./helpers/own-temp-folder.js');
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSdkBuild, planFor } = require('../lib/sdk-build.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { normalizeSpecShape } = require('../lib/spec-shape.js');
const { loadVendoredTypeScript } = require('../lib/typescript-compiler.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');
const { withPageType } = require('./helpers/page-component-type.js');
const { createCreatesPortDouble } = require('./helpers/creates-port-double.js');

const PANEL_ID = '33333333-0000-4000-8000-000000000003';
const OVERVIEW_ID = '11111111-0000-4000-8000-000000000001';
const ALL_PHASES = ['solution', 'data-model', 'forms', 'app-shell', 'pages'];

const folders = [];
test.after(() => { for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true }); });
const tmp = () => { const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'form-embeds-')); folders.push(folder); return folder; };

function specWith({ embeds = true, inputData } = {}) {
  const form = { entity: 'contoso_item', name: 'Item', tabs: [{ name: 'tab_general', sections: [{ name: 'section_general', fields: ['contoso_name'] }] }] };
  if (embeds) form.genPages = [{ key: 'panel', page: 'panel', tab: 'tab_general', section: 'section_general', ...(inputData ? { inputData } : {}) }];
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'Embeds', displayName: 'Embeds', publisherPrefix: 'contoso' },
    app: { name: 'Embed App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    forms: [form],
    pages: [
      { key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } },
      ...(embeds ? [{ key: 'panel', name: 'Panel', placement: 'form', source: { kind: 'tsx', codeFile: 'panel.tsx' } }] : []),
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview', title: 'Overview' }, { entity: 'contoso_item', title: 'Items' }] }] }] },
  };
}

// The simple mock SDK, answering the reads a forms + app + pages build makes. `log` is shared with the create port's events, so the order of an
// add's execute and a form push can be read off one list.
function world(log) {
  const { sdk, calls } = makeSimpleMockSdk();
  const query = sdk.queryRecords;
  const createArtifact = sdk.createArtifact;
  let app = null;
  sdk.createArtifact = (type, def) => { const made = createArtifact(type, def); if (type === 'app') app = made.id; return made; };
  sdk.queryRecords = async (entity, o) => {
    const filter = (o && o.filter) || '';
    if (entity === 'appmodule') { const m = filter.match(/uniquename eq '([^']+)'/); return [{ appmoduleid: app, appmoduleidunique: 'c0ffee00-0000-4000-8000-00000000dddd', uniquename: m ? m[1] : 'x' }]; }
    if (entity === 'appmodulecomponent') return [{ objectid: '5111e0f2-0000-4000-8000-0000000000aa', componenttype: 62 }];
    if (entity === 'sitemap') return /sitemapnameunique eq/.test(filter) ? [{ sitemapid: 'sm-1' }] : [{ sitemapxml: '<SiteMap><Area><Group></Group></Area></SiteMap>' }];
    if (entity === 'webresource' || entity === 'uxagentproject' || entity === 'systemform') return [];
    if (entity === 'savedquery') return [{ savedqueryid: 'defview-x', isdefault: true }];
    return query(entity, o);
  };
  const push = sdk.pushArtifact;
  sdk.pushArtifact = async (type, id) => {
    if (type === 'form') log.push(['push', id, JSON.stringify(await sdk.getArtifact('form', id)).includes(PANEL_ID)]);
    return push(type, id);
  };
  sdk.updateWebResource = async () => ({});
  sdk.dataverse = { get: withPageType(async (url) => (url.startsWith('/appmodules/') || url.startsWith('/sitemaps/') ? { status: 200, body: { value: [] } } : { status: 404, body: null })) };
  const genpage = {
    enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
    create: async (o) => ({ pageId: o.name === 'Panel' ? PANEL_ID : OVERVIEW_ID, name: o.name, publish: { kind: 'verified', detail: '' }, warnings: [] }),
    update: async (id, o) => ({ pageId: id, name: o.name, publish: { kind: 'verified', detail: '' }, warnings: [] }),
    placeInApp: async () => ({ added: [], alreadyPlaced: [], pinnedViews: [], warnings: [], appEdited: false }),
  };
  return { sdk, calls, genpage };
}

function appDirFor(spec) {
  const dir = tmp();
  for (const p of spec.pages) fs.writeFileSync(path.join(dir, p.source.codeFile), `export default function ${p.name}() { return null; }\n`);
  return dir;
}

test('spec gates: a form-only page a form embeds is valid, its inputData object survives normalization, and an orphan form-only page is still refused', () => {
  const inputData = { mode: 'compact', limit: 5 };
  const { spec: shaped, errors: shapeErrors } = normalizeSpecShape(specWith({ inputData }));
  assert.deepStrictEqual(shapeErrors, []);
  assert.deepStrictEqual(shaped.forms[0].genPages[0].inputData, inputData, 'an embed\'s inputData object is kept as written, not replaced by []');
  const valid = validateAppSpec(shaped);
  assert.deepStrictEqual(valid.errors, [], 'the form-only page is placed by the form that embeds it, not the sitemap');

  const orphan = specWith();
  delete orphan.forms[0].genPages;
  const refused = validateAppSpec(orphan);
  assert.strictEqual(refused.ok, false, 'a form-only page that no form embeds is refused');
  assert.ok(refused.errors.some((e) => /panel/.test(e)), JSON.stringify(refused.errors));
  const structural = validateAppSpec(orphan, { profile: 'structural' });
  assert.deepStrictEqual(structural.errors, [], 'the shape-only profile reports it as a warning');
  assert.ok(structural.warnings.some((w) => /panel/.test(w)), JSON.stringify(structural.warnings));

  // A spec without embeds is judged as before: a page outside the sitemap is still an error.
  const legacy = specWith({ embeds: false });
  assert.deepStrictEqual(validateAppSpec(legacy).errors, []);
  legacy.appShell.areas[0].groups[0].subAreas.shift();
  assert.ok(validateAppSpec(legacy).errors.some((e) => /'overview' is not placed in the sitemap/.test(e)));
});

test('plan: the pages phase lists the embed step only for a spec that embeds a page', () => {
  const labels = (spec) => planFor(spec, { phases: ALL_PHASES }).map((i) => i.label || i);
  assert.ok(JSON.stringify(labels(specWith())).includes('embed generative pages on forms'));
  assert.ok(!JSON.stringify(labels(specWith({ embeds: false }))).includes('embed generative pages on forms'));
});

// The build's managed-artifacts store (opts.managedArtifacts), holding no binding yet; `recorded` is what the build records with it.
function emptyStore(recorded = []) {
  return { lookup: async () => null, recordApplied: (b) => { recorded.push(b); } };
}

test('build: the embed is sent through the create port — its ids allocated, then the form pushed from inside the one execute — the cell names the page, and the form is owed a publish', async () => {
  const creates = createCreatesPortDouble();
  const { sdk, genpage } = world(creates.events);
  const spec = specWith();
  const recorded = [];
  const result = await runSdkBuild(spec, { sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir: appDirFor(spec), genpage, creates, managedArtifacts: emptyStore(recorded), phases: ALL_PHASES, warn: () => {} });
  const saved = result.formPageEmbeds && result.formPageEmbeds.saved;
  assert.ok(Array.isArray(saved) && saved.length === 1, JSON.stringify(result.formPageEmbeds));
  assert.strictEqual(saved[0].key, 'contoso_item|Main|Item#panel');
  assert.strictEqual(saved[0].action, 'add');
  assert.ok(result.formPageEmbeds.pendingPublish.some((p) => p.kind === 'form'), JSON.stringify(result.formPageEmbeds));
  const steps = creates.events.map((e) => (e[0] === 'push' ? `push:${e[2]}` : `${e[0]}:${e[1]}`));
  assert.deepStrictEqual(steps.filter((s) => s !== 'push:false'), ['allocate:contoso_item|Main|Item#panel', 'execute:contoso_item|Main|Item#panel', 'push:true'], 'one allocate, one execute, and the push that carries the page inside it');
  // The binding the next build finds the embed by is recorded with the build's store, under the ids the port allocated.
  assert.deepStrictEqual(recorded.map((b) => [b.key, b.origin, b.id]), result.formPageEmbeds.managedBindings.map((b) => [b.key, 'created', b.id]));
  assert.strictEqual(recorded.length, 1);
});

test('build: with no managed-artifacts store (the CLI build has none) a requested embed is unknown, the form is not read for it, and the phase halts', async () => {
  const creates = createCreatesPortDouble();
  const { sdk, genpage } = world(creates.events);
  const spec = specWith();
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir: appDirFor(spec), genpage, creates, phases: ALL_PHASES, warn: () => {} }),
    (e) => e.code === 'form-page-embeds-incomplete' && JSON.stringify(e).concat(String(e.message), JSON.stringify(e.cause || {})).includes('managed-bindings-unavailable'),
  );
  assert.ok(!creates.events.some((e) => e[0] === 'execute'), 'nothing was sent through the port');
});

test('build: a requested embed with no create port halts the pages phase as form-page-embeds-incomplete and writes no embed', async () => {
  const log = [];
  const { sdk, genpage } = world(log);
  const spec = specWith();
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir: appDirFor(spec), genpage, managedArtifacts: emptyStore(), phases: ALL_PHASES, warn: () => {} }),
    (e) => e.code === 'form-page-embeds-incomplete' && JSON.stringify(e).concat(String(e.message), JSON.stringify(e.cause || {})).includes('create-port-unavailable'),
  );
  assert.ok(!log.some((e) => e[0] === 'push' && e[2] === true), 'no form carrying the page was pushed');
});

test('build: a requested embed whose forms phase is not in the run is not reported as done — the phase halts', async () => {
  const creates = createCreatesPortDouble();
  const { sdk, genpage } = world(creates.events);
  const spec = specWith();
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir: appDirFor(spec), genpage, creates, managedArtifacts: emptyStore(), phases: ['solution', 'data-model', 'app-shell', 'pages'], warn: () => {} }),
    (e) => e.code === 'form-page-embeds-incomplete',
  );
  assert.ok(!creates.events.some((e) => e[0] === 'execute'), 'nothing was sent');
});

test('build: a spec without embeds needs no create port and reports no embed', async () => {
  const { sdk, genpage } = world([]);
  const spec = specWith({ embeds: false });
  const result = await runSdkBuild(spec, { sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir: appDirFor(spec), genpage, phases: ALL_PHASES, warn: () => {} });
  assert.strictEqual(result.formPageEmbeds, undefined);
});

test('build: a run with the forms phase but not the pages phase refuses a spec with form embeds before anything is written; the same run of a spec without embeds builds as before', async () => {
  const FORMS_NOT_PAGES = ['solution', 'data-model', 'forms', 'app-shell'];
  const creates = createCreatesPortDouble();
  const { sdk, calls, genpage } = world(creates.events);
  const spec = specWith();
  await assert.rejects(
    runSdkBuild(spec, { sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir: appDirFor(spec), genpage, creates, managedArtifacts: emptyStore(), phases: FORMS_NOT_PAGES, warn: () => {} }),
    (e) => e.code === 'form-page-embeds-incomplete' && e.phase === 'preflight' && /before writing anything/.test(e.message)
      && JSON.stringify(e.notApplied) === JSON.stringify([{ key: 'contoso_item|Main|Item#panel', kind: 'formPageEmbed', reason: 'pages-phase-not-selected', outcome: 'unknown' }]),
  );
  assert.deepStrictEqual([calls.map((c) => c[0]), creates.events], [[], []], 'nothing was written and the port was not called');

  const plain = world([]);
  const legacy = specWith({ embeds: false });
  const result = await runSdkBuild(legacy, { sdk: plain.sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir: appDirFor(legacy), genpage: plain.genpage, phases: FORMS_NOT_PAGES, warn: () => {} });
  assert.strictEqual(result.formPageEmbeds, undefined);
  assert.ok(plain.calls.some((c) => c[0] === 'createSolution'), 'a spec without embeds is built by the same run');
});

test('dry run: a spec with form embeds, run with the forms phase but not the pages phase, marks the halt an apply would meet; every other plan is as it was', async () => {
  const FORMS_NOT_PAGES = ['solution', 'data-model', 'forms', 'app-shell'];
  const dryRun = async (spec, phases, livePlan) => {
    const w = world([]);
    const result = await runSdkBuild(spec, { sdk: w.sdk, genpage: w.genpage, apply: false, livePlan, phases, warn: () => {} });
    assert.deepStrictEqual(w.calls.map((c) => c[0]).filter((n) => !/^(query|get|find|fetch)/i.test(n)), [], 'a dry run writes nothing');
    assert.strictEqual(result.ok, true);
    return result;
  };
  const item = (phase, label, state) => ({ phase, label, ...(state ? { state } : {}) });
  const head = (live) => [item('solution', 'solution Embeds (publisher contoso)'), item('data-model', 'table contoso_item ("Item")', live && 'create'),
    item('forms', 'form for contoso_item', live && 'create'), item('forms', 'form order for contoso_item')];
  const shell = (live) => [item('app-shell', 'app module "Embed App" + sitemap', live && 'reuse'), item('app-shell', 'app icon (generated) contoso_embedapp_icon')];
  const pages = (embeds) => [item('pages', 'page "Overview"'), ...(embeds ? [item('pages', 'page "Panel"')] : []), item('pages', 'page manifest contoso_embedapp_pagemanifest'),
    item('pages', 'finalize sitemap (genpage subareas)'), ...(embeds ? [item('pages', 'embed generative pages on forms')] : [])];
  const halt = { phase: 'forms', label: 'embed generative pages on forms', state: 'unknown', wouldHalt: true,
    stateWhy: 'the build would stop before writing anything: the generative pages requested on forms are embedded by the pages phase, which this run does not include: contoso_item|Main|Item#panel; run it with the pages phase (a full build)' };
  for (const live of [false, true]) {
    const refused = await dryRun(specWith(), FORMS_NOT_PAGES, live);
    assert.deepStrictEqual(refused.planItems, [...head(live), halt, ...shell(live)], `live plan ${live}: the halt on a line of its own, after the forms`);
    assert.ok(refused.plan.includes('embed generative pages on forms [unknown]'));
    // As before: a spec without embeds, in either phase set; a spec with embeds and the pages phase.
    assert.deepStrictEqual((await dryRun(specWith({ embeds: false }), FORMS_NOT_PAGES, live)).planItems, [...head(live), ...shell(live)]);
    assert.deepStrictEqual((await dryRun(specWith({ embeds: false }), ALL_PHASES, live)).planItems, [...head(live), ...shell(live), ...pages(false)]);
    assert.deepStrictEqual((await dryRun(specWith(), ALL_PHASES, live)).planItems, [...head(live), ...shell(live), ...pages(true)]);
  }
});
// What a deployed app holds for specWith(): the overview page in the sitemap, the panel page only on the form. `panel` is the form body row
// that holds the page's control; `description` the UxAgentControl description that binds it.
const FORM_ID = '22222222-0000-4000-8000-000000000002';
const CONTROL_UID = '44444444-0000-4000-8000-000000000004';
function deployedReader({ panel = `<row><cell rowspan="6"><control id="panel" uniqueid="{${CONTROL_UID}}" classid="{F9A8A302-114E-466A-B582-6771B2AE0D92}"/></cell></row>`, ref = PANEL_ID, sitemapIds = [OVERVIEW_ID] } = {}) {
  const description = `<controlDescription forControl="{${CONTROL_UID}}"><customControl name="MscrmControls.UxAgentControl" formFactor="2"><parameters><RefId static="true" type="SingleLine.Text">${ref}</RefId></parameters></customControl></controlDescription>`;
  const xml = '<form><DisplayConditions Order="0"/><tabs><tab name="tab_general"><columns><column width="100%"><sections><section name="section_general"><rows>'
    + `<row><cell><control id="contoso_name" datafieldname="contoso_name"/></cell></row>${panel}</rows></section></sections></column></columns></tab></tabs><controlDescriptions>${description}</controlDescriptions></form>`;
  return {
    findTable: async () => ({ logicalName: 'contoso_item' }),
    findColumns: async () => [{ logicalName: 'contoso_name' }],
    queryRecords: async () => [{ formid: FORM_ID }],
    formTopology: async () => xml,
    sitemapXml: async () => `<SiteMap><Area><Group>${sitemapIds.map((id) => `<SubArea GenPageId="${id}"/>`).join('')}<SubArea Entity="contoso_item"/></Group></Area></SiteMap>`,
    sitemapPageIds: async () => sitemapIds,
    existenceIds: async () => [OVERVIEW_ID, PANEL_ID],
    manifest: async () => ({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: OVERVIEW_ID }, { key: 'panel', name: 'Panel', pageId: PANEL_ID }] }),
  };
}

test('verify: a form-placed page is present through the form that embeds it, with no sitemap entry; a missing control or another page is a miss, and every other page still needs the sitemap', async () => {
  const { verifySpec } = require('../lib/verify-spec.js');
  const spec = specWith();
  assert.deepStrictEqual(validateAppSpec(spec).errors, []);
  const pages = (result) => result.checks.filter((c) => c.kind === 'page').map((c) => [c.name, c.present, c.detail]);

  const deployed = await verifySpec(spec, deployedReader());
  assert.deepStrictEqual(deployed.missing, [], JSON.stringify(deployed.missing));
  assert.deepStrictEqual(pages(deployed), [['Overview', true, ''], ['Panel', true, '']]);

  const noControl = await verifySpec(spec, deployedReader({ panel: '' }));
  assert.deepStrictEqual(pages(noControl), [['Overview', true, ''], ['Panel', false, "form 'Item' does not show it as declared (not-embedded)"]], 'a description with no control on the form shows nothing');
  const otherPage = await verifySpec(spec, deployedReader({ ref: OVERVIEW_ID }));
  assert.deepStrictEqual(pages(otherPage)[1], ['Panel', false, "form 'Item' does not show it as declared (not-embedded)"]);
  const noForm = specWith();
  delete noForm.forms[0].genPages;
  assert.deepStrictEqual(pages(await verifySpec(noForm, deployedReader()))[1], ['Panel', false, 'no form embeds it'], 'an orphan form-only page is a miss');

  // A page in the sitemap is judged as before: present only with its sitemap entry, whatever a form shows.
  assert.deepStrictEqual(pages(await verifySpec(spec, deployedReader({ sitemapIds: [] })))[0], ['Overview', false, '']);
  const legacy = specWith({ embeds: false });
  assert.deepStrictEqual(pages(await verifySpec(legacy, deployedReader())), [['Overview', true, '']]);
  assert.deepStrictEqual(pages(await verifySpec(legacy, deployedReader({ sitemapIds: [] }))), [['Overview', false, '']]);
});

test('verify: a form-placed page that is also in the app\'s navigation is a miss naming the placement; a page placed in the sitemap is judged as before', async () => {
  const { verifySpec } = require('../lib/verify-spec.js');
  const spec = specWith();
  const pages = (result) => result.checks.filter((c) => c.kind === 'page' || c.kind === 'page-extra').map((c) => [c.kind, c.name, c.present, c.detail]);
  const leaked = await verifySpec(spec, deployedReader({ sitemapIds: [OVERVIEW_ID, PANEL_ID] }));
  assert.deepStrictEqual(pages(leaked), [['page', 'Overview', true, ''], ['page', 'Panel', false, 'it is in the app\'s navigation, but the spec places it on a form only']]);
  assert.deepStrictEqual(leaked.missing.map((c) => [c.kind, c.name]), [['page', 'Panel']]);
  // Placed as declared: the form shows it and the navigation does not.
  assert.deepStrictEqual(pages(await verifySpec(spec, deployedReader())), [['page', 'Overview', true, ''], ['page', 'Panel', true, '']]);
  // A sitemap page the spec does not declare is still an extra; one it places in the sitemap is still present with its entry, and a miss without it.
  const EXTRA = '55555555-0000-4000-8000-000000000005';
  assert.deepStrictEqual(pages(await verifySpec(spec, deployedReader({ sitemapIds: [OVERVIEW_ID, EXTRA] }))).slice(2), [['page-extra', EXTRA, false, 'a sitemap page not declared in the spec']]);
  const legacy = specWith({ embeds: false });
  assert.deepStrictEqual(pages(await verifySpec(legacy, deployedReader({ sitemapIds: [OVERVIEW_ID, PANEL_ID] }))), [['page', 'Overview', true, ''], ['page-extra', PANEL_ID, false, 'a sitemap page not declared in the spec']]);
  assert.deepStrictEqual(pages(await verifySpec(legacy, deployedReader({ sitemapIds: [] }))), [['page', 'Overview', false, '']]);
});
// A page may be both in the navigation and on a form (placement 'sitemap' with a forms[].genPages entry naming it): each declared embed is held to the form whatever the
// page's placement, and the navigation entry is still required. A spec that declares no embed reads no form for its pages.
test('verify: a sitemap page a form also embeds needs both its navigation entry and the form\'s control; a spec with no embed reads no form for it', async () => {
  const { verifySpec } = require('../lib/verify-spec.js');
  const dual = specWith();
  dual.pages[1].placement = 'sitemap';
  dual.appShell.areas[0].groups[0].subAreas.push({ page: 'panel', title: 'Panel' });
  assert.deepStrictEqual(validateAppSpec(dual).errors, []);
  const both = [OVERVIEW_ID, PANEL_ID];
  const pages = (result) => result.checks.filter((c) => c.kind === 'page').map((c) => [c.name, c.present, c.detail]);
  const counted = (options) => { const reader = deployedReader(options); const topology = reader.formTopology; reader.reads = 0; reader.formTopology = async (...a) => { reader.reads += 1; return topology(...a); }; return reader; };

  const noControl = await verifySpec(dual, deployedReader({ panel: '', sitemapIds: both }));
  assert.deepStrictEqual(pages(noControl), [['Overview', true, ''], ['Panel', false, "form 'Item' does not show it as declared (not-embedded)"]], 'a declared Main-form embed that is absent must be reported missing');
  assert.strictEqual(noControl.ok, false);
  assert.deepStrictEqual(noControl.missing.filter((c) => c.kind === 'page').map((c) => c.name), ['Panel']);

  const placed = await verifySpec(dual, deployedReader({ sitemapIds: both }));
  assert.deepStrictEqual(placed.missing, [], JSON.stringify(placed.missing));
  assert.deepStrictEqual(pages(placed), [['Overview', true, ''], ['Panel', true, '']]);
  assert.ok(placed.checks.some((c) => c.kind === 'page-subarea' && c.name === 'Panel' && c.present), 'its navigation entry is still checked');
  // Out of the navigation it is a miss as any sitemap page is, whatever the form shows.
  assert.deepStrictEqual(pages(await verifySpec(dual, deployedReader({ sitemapIds: [OVERVIEW_ID] })))[1], ['Panel', false, '']);

  // The same sitemap page with no embed declared, and a spec with no form page at all, make the same form reads; the declared embed adds exactly one.
  const plain = JSON.parse(JSON.stringify(dual));
  delete plain.forms[0].genPages;
  const legacy = specWith({ embeds: false });
  const readsOf = async (spec, options) => { const reader = counted(options); await verifySpec(spec, reader); return reader.reads; };
  const legacyReads = await readsOf(legacy, {});
  assert.strictEqual(await readsOf(plain, { sitemapIds: both }), legacyReads, 'a spec with no embed reads no form for its pages');
  assert.strictEqual(await readsOf(dual, { sitemapIds: both }), legacyReads + 1, 'the declared embed is read once');
});
// The build makes its own page backend when none is handed to it: the caller's provider reaches it as `typescript`, in the form given.
test('build: the caller\'s TypeScript provider reaches the page backend the build makes, as `typescript`', async () => {
  const sdkBuildPath = require.resolve('../lib/sdk-build.js');
  const backendPath = require.resolve('../lib/genpage-sdk.js');
  const realExports = require.cache[backendPath].exports;
  const seen = [];
  const stop = Object.assign(new Error('stop after the backend is made'), { code: 'test-stop' });
  try {
    require.cache[backendPath].exports = { ...realExports, makeGenpageSdk: (env, options) => { seen.push(options); throw stop; } };
    delete require.cache[sdkBuildPath];
    const fresh = require('../lib/sdk-build.js');
    const ts = loadVendoredTypeScript();
    for (const typescript of [ts, () => ts, undefined]) {
      const { sdk } = world([]);
      const spec = specWith({ embeds: false });
      await assert.rejects(fresh.runSdkBuild(spec, { sdk, apply: true, env: 'https://contoso.crm.dynamics.com', appDir: appDirFor(spec), typescript, phases: ['pages'], warn: () => {} }), (e) => e === stop || (e && e.cause === stop));
    }
  } finally {
    require.cache[backendPath].exports = realExports;
    delete require.cache[sdkBuildPath];
  }
  assert.strictEqual(seen.length, 3);
  assert.strictEqual(typeof seen[0].typescript, 'object', 'the namespace, as given');
  assert.strictEqual(typeof seen[1].typescript, 'function', 'the SDK\'s function shape, as given');
  assert.ok(!('typescript' in seen[2]), 'no provider: the backend loads the vendored compiler itself');
  for (const options of seen) assert.ok(!('ts' in options), 'never the parser\'s key');
});

// A page the lexer can only guess at (a generic call signature in an interface) is settled by a parser — the caller's, in both provider forms.
const GUESSED = "import * as React from 'react';\ninterface Api { <U>(x: U): U; }\nexport default function Page() { return <div>Hi</div>; }\n";
function spyCompiler() {
  const ts = loadVendoredTypeScript();
  const calls = { createSourceFile: 0 };
  const spy = Object.create(ts);
  Object.defineProperty(spy, 'createSourceFile', { value: (...args) => { calls.createSourceFile += 1; return ts.createSourceFile(...args); }, enumerable: true });
  return { spy, calls };
}

for (const [label, shape] of [['the namespace', (spy) => spy], ['the SDK\'s function shape', (spy) => () => spy]]) {
  test(`page gates (${label}): the worker-output and promote gates parse with the caller's compiler`, () => {
    const { validatePageOutput } = require('../genpage-worker-output.js');
    const { validatePage } = require('../promote-intent-pages.js');
    const dir = tmp();
    const file = path.join(dir, 'page.tsx');
    fs.writeFileSync(file, GUESSED);
    const worker = spyCompiler();
    const checked = validatePageOutput({ filePath: file, typescript: shape(worker.spy) });
    assert.strictEqual(checked.ok, true, JSON.stringify(checked));
    assert.ok(worker.calls.createSourceFile >= 1, 'the worker-output gate parsed with the caller\'s compiler');
    const promote = spyCompiler();
    const page = { key: 'page', name: 'Page', source: { kind: 'tsx', codeFile: 'page.tsx' } };
    const promoted = validatePage(page, dir, { typescript: shape(promote.spy) });
    assert.deepStrictEqual(promoted.problems, [], JSON.stringify(promoted));
    assert.ok(promote.calls.createSourceFile >= 1, 'the promote gate parsed with the caller\'s compiler');
  });
}

// A page on a DECLARED form (forms[].reconcile "declared") is held to the form its managed binding names, as the form itself is. Validation and
// the build refuse such a spec today, so verifySpec is called directly: a hand-made spec or a later release must not pass a namesake's embed.
const BOUND_FORM = '66666666-0000-4000-8000-000000000006';
const OTHER_FORM = '77777777-0000-4000-8000-000000000007';
const HOST_KEY = 'contoso_item/main/item';
const declaredHost = (spec, form = {}) => { Object.assign(spec.forms[0], { reconcile: 'declared' }, form); return spec; };
const hostManifest = (rest = {}) => ({ groups: [{ family: 'form', key: HOST_KEY, root: { id: BOUND_FORM } }], pending: [], invalid: [], ...rest });
// deployedReader's app, where only the bound row shows the page: a row of the form's name (FORM_ID, what a name read finds) and any other
// row show the form without it. `reads` records the systemform filters and `layouts` the rows whose layout was read.
function boundReader(options = {}) {
  const reader = deployedReader(options);
  const shown = deployedReader(options).formTopology;
  const bare = deployedReader({ ...options, panel: '' }).formTopology;
  reader.reads = [];
  reader.layouts = [];
  reader.queryRecords = async (table, o) => {
    const filter = (o && o.filter) || '';
    if (table === 'systemform') reader.reads.push(filter);
    const byId = filter.match(/formid eq ([0-9a-f-]{36})/i);
    if (byId) return [BOUND_FORM, OTHER_FORM, FORM_ID].includes(byId[1].toLowerCase()) ? [{ formid: byId[1], objecttypecode: 'contoso_item', type: 2 }] : [];
    return [{ formid: /name eq 'Other'/.test(filter) ? OTHER_FORM : FORM_ID }];
  };
  reader.formTopology = async (entity, id) => { reader.layouts.push(String(id).toLowerCase()); return String(id).toLowerCase() === BOUND_FORM ? shown() : bare(); };
  return reader;
}
const pageChecks = (r, kind = 'page') => r.checks.filter((c) => c.kind === kind).map((c) => [c.kind, c.name, c.present, c.detail]);
const pageLines = (r) => (r.unverified || []).filter((u) => u.startsWith('page:'));

test('verify: a page on a declared form is held to the form its binding names — a renamed bound form shows it, a namesake is never read in its place', async () => {
  const { verifySpec } = require('../lib/verify-spec.js');
  const spec = declaredHost(specWith());
  assert.ok(validateAppSpec(spec).errors.length > 0, 'validation still refuses a page on a declared form');
  const reader = boundReader();
  const r = await verifySpec(spec, reader, { managedManifest: hostManifest() });
  assert.deepStrictEqual(pageChecks(r), [['page', 'Overview', true, ''], ['page', 'Panel', true, '']], JSON.stringify(r.missing));
  assert.deepStrictEqual(pageLines(r), []);
  assert.ok(!reader.reads.some((f) => /name eq/.test(f)), `no form is read by name: ${JSON.stringify(reader.reads)}`);
  assert.ok(reader.layouts.length > 0 && reader.layouts.every((id) => id === BOUND_FORM), `only the bound row's layout is read: ${JSON.stringify(reader.layouts)}`);
  // The same spec, not declared, is judged as before: its form is found by name, and the row of that name does not show the page.
  const plain = specWith();
  assert.deepStrictEqual(pageChecks(await verifySpec(plain, boundReader()))[1], ['page', 'Panel', false, "form 'Item' does not show it as declared (not-embedded)"]);
  // A bound row that is gone is a miss that says a namesake is not taken in its place.
  const gone = await verifySpec(spec, boundReader(), { managedManifest: { ...hostManifest(), groups: [{ family: 'form', key: HOST_KEY, root: { id: '88888888-0000-4000-8000-000000000008' } }] } });
  assert.deepStrictEqual(pageChecks(gone)[1], ['page', 'Panel', false, `form 'Item': the form its managed binding (${HOST_KEY}) is bound to (88888888-0000-4000-8000-000000000008) was not found on its table; a form of the same name is not taken in its place`]);
});

test('verify: a page on a declared form whose binding is not settled is unverified, not passed or failed — its navigation entry is still checked, and a bad embed on another form still fails it', async () => {
  const { verifySpec } = require('../lib/verify-spec.js');
  const open = `form 'Item': its managed binding (${HOST_KEY}) is not settled (managed-attempt-pending) — unverified, not proven correct; the declared embed was not compared`;
  const pending = hostManifest({ groups: [], pending: [{ family: 'form', key: HOST_KEY, code: 'managed-attempt-pending', root: { id: BOUND_FORM } }] });

  const onForm = boundReader();
  const r = await verifySpec(declaredHost(specWith()), onForm, { managedManifest: pending });
  assert.deepStrictEqual(pageChecks(r), [['page', 'Overview', true, '']], 'no page check for the page whose form is not known');
  assert.deepStrictEqual(pageLines(r), [`page:Panel (${open})`]);
  assert.ok(!r.missing.some((c) => c.kind === 'page'), JSON.stringify(r.missing));
  assert.deepStrictEqual(onForm.layouts, [], 'no form layout is read for it');
  assert.deepStrictEqual(onForm.reads, [], 'no form is read by id or by name for it');

  // The page is also in the navigation: its entry is still checked, as it does not depend on the form.
  const dual = declaredHost(specWith());
  dual.pages[1].placement = 'sitemap';
  dual.appShell.areas[0].groups[0].subAreas.push({ page: 'panel', title: 'Panel' });
  const both = await verifySpec(dual, boundReader({ sitemapIds: [OVERVIEW_ID, PANEL_ID] }), { managedManifest: pending });
  assert.deepStrictEqual(pageChecks(both, 'page-subarea').filter(([, name]) => name === 'Panel'), [['page-subarea', 'Panel', true, '']]);
  assert.deepStrictEqual(pageChecks(both), [['page', 'Overview', true, '']]);
  assert.deepStrictEqual(pageLines(both), [`page:Panel (${open})`]);

  // A second form, not declared, that does not show the page: the page fails on it, and the unknown first form is still listed.
  const two = declaredHost(specWith());
  two.forms.push({ entity: 'contoso_item', name: 'Other', tabs: [{ name: 'tab_general', sections: [{ name: 'section_general', fields: ['contoso_name'] }] }], genPages: [{ key: 'panel', page: 'panel', tab: 'tab_general', section: 'section_general' }] });
  const bad = await verifySpec(two, boundReader(), { managedManifest: pending });
  assert.deepStrictEqual(pageChecks(bad)[1], ['page', 'Panel', false, "form 'Other' does not show it as declared (not-embedded)"]);
  assert.deepStrictEqual(pageLines(bad), [`page:Panel (${open})`]);
  assert.strictEqual(bad.ok, false);
});

test('verify: a page on a declared form whose formId pins another row than its binding fails, and neither row is read for it', async () => {
  const { verifySpec } = require('../lib/verify-spec.js');
  const reader = boundReader();
  const r = await verifySpec(declaredHost(specWith(), { formId: FORM_ID }), reader, { managedManifest: hostManifest() });
  assert.deepStrictEqual(pageChecks(r)[1], ['page', 'Panel', false, `form 'Item': its formId ${FORM_ID} is not the form its managed binding (${HOST_KEY}) is bound to (${BOUND_FORM}); correct or remove the formId`]);
  assert.deepStrictEqual(reader.layouts, []);
  assert.deepStrictEqual(reader.reads, []);
});
