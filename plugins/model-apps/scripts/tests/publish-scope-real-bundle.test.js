'use strict';
// Which tables the build publishes before it publishes the app, over the REAL vendored SDK and a stateful fake Dataverse that also holds
// the app, its sitemap and its components (helpers/fake-app-build-org.js), so what is asserted is what reached the wire and what the
// platform is left holding unpublished.
//
// Dataverse leaves a saved form's label changes out of the published form when a PublishXml that names only the app runs before the
// table's own publish (measured; see publishReconciledTables in sdk-build.js). The one request before the app names the tables whose
// existing views and forms the build reconciled, the tables of the charts it wrote, the tables whose Main forms the build's own write of
// the app adds (the SDK adds the active Main forms of the navigation's tables), and the tables whose forms or charts the app is PROVEN to
// hold: its saved component list says so, whether or not the spec names the table. A table that is only a lookup column's target, that
// only a page reads, or that only `app.tables` pins is not published by it: a table's publish ships everything saved on that table, whoever
// saved it, so naming one would release a maker's unfinished work there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { buildModelApp } = require('../build-model-app.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const ENTITIES = {
  contoso_item: { attributes: { contoso_name: 'String', contoso_code: 'String', contoso_lookupid: 'Lookup' } },
  contoso_stats: { attributes: { contoso_name: 'String', contoso_kind: 'Picklist' } },
  contoso_lookup: { attributes: { contoso_name: 'String' } },
  contoso_nav: { attributes: { contoso_name: 'String' } },
  contoso_retained: { attributes: { contoso_name: 'String' } },
  contoso_page_only: { attributes: { contoso_name: 'String' } },
  contoso_hidden: { attributes: { contoso_name: 'String' } },
};
const PHASES = ['views', 'charts', 'forms', 'app-shell', 'pages', 'publish'];
const NO_PAGES = PHASES.filter((phase) => phase !== 'pages');

const table = (schemaName, columns = []) => ({
  schemaName, displayName: schemaName, existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
  columns: columns.map((name) => ({ schemaName: name, displayName: name, ...(name === 'contoso_kind' ? { type: 'Choice', options: ['First', 'Second'] } : { type: 'Text' }) })),
});

// Item has a view and a form and is in the navigation; Stats has a chart; Nav is only in the navigation; Lookup is only the target of a lookup
// column on Item. All four tables exist already (`existing`), as in an environment the app is built over.
function makeSpec(extra = {}) {
  return {
    solution: { uniqueName: 'ContosoReview', displayName: 'Contoso Review', publisherPrefix: 'contoso' },
    app: { name: 'Publish Review', uniqueName: 'contoso_publishreview' },
    entities: [table('contoso_item', ['contoso_code']), table('contoso_stats', ['contoso_kind']), table('contoso_lookup'), table('contoso_nav')],
    relationships: [{ type: 'OneToMany', referenced: 'contoso_lookup', referencing: 'contoso_item', lookup: { schemaName: 'contoso_LookupId', displayName: 'Reference' } }],
    views: [{ entity: 'contoso_item', name: 'Items', columns: ['contoso_name', 'contoso_code'] }],
    charts: [{ entity: 'contoso_stats', name: 'Stats By Kind', chartType: 'Pie', groupBy: 'contoso_kind', measure: 'count', description: 'v1' }],
    forms: [{ entity: 'contoso_item', name: 'Item', layout: 'auto' }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }, { entity: 'contoso_nav', title: 'Navigation only' }] }] }] },
    ...extra,
  };
}

// An app whose only content is the navigation to one table: nothing authored (no view, form, chart or lookup), so nothing else the build does publishes a
// table before the app, and the one request is all that stands between a saved edit on that table and the app's publish.
function navOnlySpec() {
  const spec = makeSpec();
  spec.entities = [table('contoso_nav')];
  spec.relationships = [];
  spec.views = [];
  spec.forms = [];
  spec.charts = [];
  spec.appShell = { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_nav', title: 'Navigation' }] }] }] };
  return spec;
}

// An app that authors no view, form or chart of its own: its navigation is a link, and the one table the spec names is a reference table.
// What such an app holds on the server is whatever a maker added to it.
function bareSpec() {
  const spec = makeSpec();
  spec.entities = [table('contoso_lookup')];
  spec.relationships = [];
  spec.views = [];
  spec.forms = [];
  spec.charts = [];
  spec.appShell = { areas: [{ label: 'Main', groups: [{ label: 'Links', subAreas: [{ url: 'https://contoso.example/', title: 'Documentation' }] }] }] };
  return spec;
}

// A page reads a table the spec names nowhere else: validation only lints a data source that `entities` does not declare.
function pageSpec() {
  const spec = makeSpec();
  spec.schemaVersion = 2;
  spec.pages = [{ key: 'overview', name: 'Overview', dataSources: ['contoso_page_only'], source: { kind: 'tsx', codeFile: 'Overview.tsx' } }];
  spec.appShell.areas[0].groups[0].subAreas.push({ page: 'overview', title: 'Overview' });
  return spec;
}

function scenario() {
  const org = createFakeBuildOrg({ entities: ENTITIES, solution: { uniqueName: 'ContosoReview' }, heldTables: { contoso_item: 0, contoso_stats: 0 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-scope-'));
  dirs.push(dir);
  const warnings = [];
  // Each build gets a fresh SDK over the same workspace folder, as every CLI run does.
  const makeSdk = async () => {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
    await sdk.initWorkspace();
    return sdk;
  };
  const noPageBackend = { enumerateEnv: async () => ({ ok: true, pages: [], ids: [] }) };
  async function build(spec, { publish = true, phases = PHASES } = {}) {
    const sdk = await makeSdk();
    const mark = org.calls.length;
    const warned = warnings.length;
    const outcome = await runSdkBuild(spec, {
      sdk, apply: true, publish, phases, workspaceDir: dir, appDir: dir, env: org.origin,
      genpage: noPageBackend,
      warn: (w) => warnings.push(String(w)),
    });
    return { outcome, mark, warnings: warnings.slice(warned) };
  }
  // A form a maker saved and never published: the platform lists it as a saved record of that table, in the saved layer only. `inApp`: the maker also
  // added it to the app in the designer, so the app's saved component list names a form that no published read finds.
  async function makerSavesForm(table, name, { inApp = false } = {}) {
    const formid = randomUUID();
    const response = await org.httpClient.post(`${org.origin}/api/data/v9.0/systemforms`, { formid, name, objecttypecode: table, type: 2, formxml: '<form><tabs/></form>' });
    assert.ok(response.status < 300, `the fake accepted the form: ${response.status}`);
    if (inApp) org.addToApp('systemforms', formid);
    return formid;
  }
  // A maker edits a form that is live and saves the edit without publishing it: the platform holds the old form and the saved one. It goes through
  // the fake directly, so none of it is among the requests the build is asserted to send.
  async function makerEditsForm(table, name, { inApp = false } = {}) {
    const formid = randomUUID();
    const base = `${org.origin}/api/data/v9.0`;
    const created = await org.fake.httpClient.post(`${base}/systemforms`, { formid, name: `Original ${name}`, objecttypecode: table, type: 2, formxml: '<form><tabs/></form>' });
    assert.ok(created.status < 300, `the fake accepted the form: ${created.status}`);
    const published = await org.fake.httpClient.post(`${base}/PublishXml`, { ParameterXml: `<importexportxml><entities><entity>${table}</entity></entities></importexportxml>` });
    assert.ok(published.status < 300, `the fake published it: ${published.status}`);
    const edited = await org.fake.httpClient.patch(`${base}/systemforms(${formid})`, { name });
    assert.ok(edited.status < 300, `the fake accepted the edit: ${edited.status}`);
    if (inApp) org.addToApp('systemforms', formid);
    return formid;
  }
  // What the pages phase does for a table a page reads: it pins that table's default public view into the app, and nothing else of the table.
  function appPinsDefaultViewOf(logical) {
    org.fake.seedDefaultViews(logical, 'Page Data');
    const view = org.fake.rows('savedqueries').find((row) => row.data.returnedtypecode === logical && row.data.isdefault);
    org.addToApp('savedqueries', view.data.savedqueryid);
  }
  const unfinished = () => org.fake.unpublished().map((r) => r.name);
  return { org, dir, makeSdk, noPageBackend, build, makerSavesForm, makerEditsForm, appPinsDefaultViewOf, unfinished, warnings };
}

const indexOfFirst = (calls, test) => calls.findIndex(test);
const isTablePublish = (table) => (c) => c.method === 'POST' && c.path === '/PublishXml' && c.body.ParameterXml.includes(`<entity>${table}</entity>`);
const isAppPublish = (c) => c.method === 'POST' && c.path === '/PublishXml' && /<appmodule>/.test(c.body.ParameterXml);
const isTablesPublish = (c) => c.method === 'POST' && c.path === '/PublishXml' && /<entity>/.test(c.body.ParameterXml);
const isAppCreate = (c) => c.method === 'POST' && /^\/appmodules(\?|$)/.test(c.path);
const pinsForm = (formid) => (c) => c.method === 'POST' && c.path === '/AddAppComponents' && JSON.stringify(c.body).includes(formid);
const readsComponentsOfType = (type) => (c) => c.method === 'GET' && /^\/appmodulecomponents/.test(c.path) && new RegExp(`componenttype eq ${type}\\b`).test(c.path);
// The lookup of the tables of the forms the app holds, in the SAVED layer, by id:
//   GET /systemforms/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()?$select=formid,objecttypecode&$filter=formid eq <id> or formid eq <id>
const isFormTableLookup = (c) => c.method === 'GET' && /^\/systemforms\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?\$select=formid,objecttypecode&\$filter=formid eq /.test(c.path);
const refuses = (status, message) => () => ({ status, headers: {}, body: { error: { message } } });
const rowsOf = (value, extra = {}) => ({ status: 200, headers: {}, body: { value, ...extra } });
// Matches the first request `match` accepts and no later one, so a read the build makes again afterwards (the SDK fetches the app too) is left alone.
const onlyFirst = (match) => { let used = false; return (c) => !used && match(c) && (used = true); };

test('the spec these cases build is valid, so none of them rests on a spec the CLI would refuse', () => {
  for (const spec of [makeSpec(), bareSpec(), pageSpec(), navOnlySpec()]) {
    const validated = validateAppSpec(spec);
    assert.deepStrictEqual({ ok: validated.ok, errors: validated.errors }, { ok: true, errors: [] });
  }
});

// --- What is published, and when ---------------------------------------------------------------------------------------------

test('a first build publishes, in one request before the app is created, the tables of the charts it wrote and the navigation\u2019s tables, whose Main forms the creation adds', async () => {
  const s = scenario();
  await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(), [
    'tables contoso_item, contoso_nav, contoso_stats', // Stats: the chart this build created. Item and Nav: the navigation\u2019s tables, whose active Main forms the SDK adds when it creates the app. Lookup is a lookup target
    'app', // the create\u2019s own publish
    'tables contoso_item, contoso_stats + app', // phase 8
  ]);
  const before = indexOfFirst(s.org.calls, isTablePublish('contoso_stats'));
  assert.ok(before > 0 && before < indexOfFirst(s.org.calls, isAppCreate), 'before the app is created');
});

test('an unchanged rebuild still sends three publishes, in the same order: the tables the build changed and the app holds or is about to hold forms or charts of, the app, then everything', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const { mark, warnings } = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(mark), [
    'tables contoso_item, contoso_nav, contoso_stats', // Item: reconciled. Stats: its chart is in the app. Nav: the navigation\u2019s, whose Main forms the write adds. Lookup: no form or chart of it is in the app
    'app', // the sitemap finalize
    'tables contoso_item + app',
  ]);
  assert.deepStrictEqual(warnings.filter((w) => /could not (publish|tell|read)/.test(w)), [], 'the app\u2019s components were read, so there is nothing to say');
});

test('a form a maker saved and never published on a table the app does not hold is still unpublished after the build', async () => {
  const s = scenario();
  await s.build(makeSpec());
  await s.makerSavesForm('contoso_lookup', 'Unrelated unfinished form');
  assert.deepStrictEqual(s.unfinished(), ['Unrelated unfinished form']);
  await s.build(makeSpec());
  assert.deepStrictEqual(s.unfinished(), ['Unrelated unfinished form'], 'the lookup target is not the app\u2019s: the build does not release what a maker left there');
  assert.ok(!s.org.calls.some(isTablePublish('contoso_lookup')), 'no request names it');
});

// --- A form the build\u2019s own write adds to the app ---------------------------------------------------------------------------------
//
// The SDK writes a navigation table\u2019s active Main forms into the app as components whenever it writes the app, immediately before it publishes it. A
// form that is live with a label saved and not published, and that this very write pins, would be published with the app before its table was: the
// strand the order of the publishes causes. The app\u2019s saved component list cannot name it before the write, so the navigation names the table.

test('a form already live with a saved, unpublished edit on a navigation table, that this very build pins into the app, is published before the app is written', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const nav = s.org.fake.entityId('contoso_nav');
  const formsOfNav = () => s.org.fake.rows('systemforms').filter((r) => r.data.objecttypecode === 'contoso_nav').map((r) => r.data.formid);
  assert.ok(s.org.components.some((c) => c.componenttype === 1 && c.objectid === nav), 'the app holds the table, as a navigation entry');
  assert.deepStrictEqual(formsOfNav(), [], 'and no form of it: a table component alone proves nothing about a form');
  const formid = await s.makerEditsForm('contoso_nav', 'Saved form on a navigation table');
  assert.ok(!s.org.components.some((c) => c.objectid === formid), 'the app does not hold it yet, so its component list cannot prove it');
  assert.deepStrictEqual(s.unfinished(), ['Saved form on a navigation table']);
  const second = await s.build(makeSpec());
  assert.ok(s.org.components.some((c) => c.componenttype === 60 && c.objectid === formid), 'this build pinned it: the SDK adds the active Main forms of a navigation table');
  assert.deepStrictEqual(s.org.publishLog(second.mark), ['tables contoso_item, contoso_nav, contoso_stats', 'app', 'tables contoso_item + app'], 'the same three publishes, the first naming the table');
  const calls = s.org.calls.slice(second.mark);
  const published = indexOfFirst(calls, isTablePublish('contoso_nav'));
  assert.ok(published >= 0 && published < indexOfFirst(calls, pinsForm(formid)), 'its table was published before the form was written into the app');
  assert.ok(published < indexOfFirst(calls, isAppPublish), 'and before the app\u2019s publish');
  assert.deepStrictEqual(s.unfinished(), [], 'so the edit is live after this build, not after the next one');
});

test('a form already live with a saved, unpublished edit on a navigation table the app is created with is published before the app is created: the first build protects it too', async () => {
  const s = scenario();
  const formid = await s.makerEditsForm('contoso_nav', 'Edited before the app existed');
  assert.deepStrictEqual(s.unfinished(), ['Edited before the app existed']);
  const first = await s.build(makeSpec());
  const calls = s.org.calls.slice(first.mark);
  const published = indexOfFirst(calls, isTablePublish('contoso_nav'));
  assert.ok(published >= 0 && published < indexOfFirst(calls, isAppCreate), 'before the app is created');
  assert.ok(published < indexOfFirst(calls, isAppPublish), 'and before any publish of the app');
  assert.ok(s.org.components.some((c) => c.componenttype === 60 && c.objectid === formid), 'the app holds the form the creation added');
  assert.deepStrictEqual(s.unfinished(), []);
});

for (const afterCreate of [false, true]) {
  test(`with nothing else for the build to publish, ${afterCreate ? 'the build that pins a new form into an existing app' : 'the first build'} publishes the navigation table first: tables, app, app`, async () => {
    const s = scenario();
    const spec = navOnlySpec();
    if (afterCreate) await s.build(spec);
    const formid = await s.makerEditsForm('contoso_nav', 'Label saved on the only table');
    assert.ok(!s.org.components.some((c) => c.objectid === formid), 'the app does not hold it before this build');
    const { mark } = await s.build(spec);
    assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_nav', 'app', 'app'], 'the table is published before the app, with nothing else to publish it');
    assert.ok(s.org.components.some((c) => c.componenttype === 60 && c.objectid === formid), 'the app holds the form after this build');
    assert.deepStrictEqual(s.unfinished(), [], 'and the edit is live: not after the next build');
    const next = await s.build(spec);
    assert.deepStrictEqual(s.org.publishLog(next.mark), ['tables contoso_nav', 'app', 'app'], 'an unchanged build after it sends the same');
  });
}

test('a table pinned only in app.tables gets no form from the SDK, so it is not named: its saved edit stays unpublished', async () => {
  const s = scenario();
  const spec = makeSpec();
  spec.minimumPluginVersion = '2.13.0';
  spec.app.tables = ['contoso_hidden'];
  assert.strictEqual(validateAppSpec(spec).ok, true);
  const formid = await s.makerEditsForm('contoso_hidden', 'Saved form on a pinned-only table');
  for (let run = 0; run < 2; run += 1) await s.build(spec);
  assert.ok(s.org.components.some((c) => c.componenttype === 1 && c.objectid === s.org.fake.entityId('contoso_hidden')), 'the table is pinned, as a table component');
  assert.ok(!s.org.components.some((c) => c.objectid === formid), 'and the SDK added none of its forms: it expands the tables of the navigation\u2019s entity entries, and only those');
  assert.ok(!s.org.publishLog().some((line) => line.includes('contoso_hidden')), 'so no request names it');
  assert.deepStrictEqual(s.unfinished(), ['Saved form on a pinned-only table']);
});

test('a table pinned only in app.tables and also in the navigation is the navigation\u2019s: its forms are added and its table is named', async () => {
  const s = scenario();
  const spec = makeSpec();
  spec.minimumPluginVersion = '2.13.0';
  spec.app.tables = ['contoso_nav'];
  const formid = await s.makerEditsForm('contoso_nav', 'Saved form on a table that is both');
  const { mark } = await s.build(spec);
  assert.ok(s.org.components.some((c) => c.componenttype === 60 && c.objectid === formid));
  assert.strictEqual(s.org.publishLog(mark)[0], 'tables contoso_item, contoso_nav, contoso_stats');
  assert.deepStrictEqual(s.unfinished(), []);
});

test('a table the spec only declares is published once the app holds a form of it: components already on the server count', async () => {
  const s = scenario();
  await s.build(makeSpec());
  await s.makerEditsForm('contoso_lookup', 'Form a maker added to the app', { inApp: true });
  assert.deepStrictEqual(s.unfinished(), ['Form a maker added to the app']);
  const { mark } = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(mark)[0], 'tables contoso_item, contoso_lookup, contoso_nav, contoso_stats', 'the first publish names it');
  assert.deepStrictEqual(s.unfinished(), []);
});

// --- The app holds a form the spec never names -------------------------------------------------------------------------------

test('a form the app holds on a table the spec does not name is published before the app: what the server says the app holds counts, whatever the spec names', async () => {
  const s = scenario();
  await s.build(makeSpec());
  await s.makerEditsForm('contoso_retained', 'Form held only on the server', { inApp: true });
  const { mark, warnings } = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_item, contoso_nav, contoso_retained, contoso_stats', 'app', 'tables contoso_item + app']);
  assert.deepStrictEqual(s.unfinished(), [], 'the label the maker saved is live');
  assert.deepStrictEqual(warnings.filter((w) => /could not (publish|tell|read)/.test(w)), []);
});

test('the same with nothing else for the build to publish: the held form\u2019s table is the only one in the request, and a spec with nothing held adds no request at all', async () => {
  const s = scenario();
  const spec = bareSpec();
  const first = await s.build(spec);
  assert.deepStrictEqual(s.org.publishLog(first.mark), ['app', 'app'], 'a first build that changes no table has nothing to name: the request is not sent empty');
  const idle = await s.build(spec);
  assert.deepStrictEqual(s.org.publishLog(idle.mark), ['app', 'app'], 'nothing to protect: the same two publishes as before');
  await s.makerEditsForm('contoso_retained', 'Form held only on the server', { inApp: true });
  assert.deepStrictEqual(s.unfinished(), ['Form held only on the server']);
  const { mark } = await s.build(spec);
  assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_retained', 'app', 'app'], 'a table that no part of the spec names, held through one form');
  assert.deepStrictEqual(s.unfinished(), []);
});

// --- A form the app holds that was never published ---------------------------------------------------------------------------
//
// The component list is the SAVED layer\u2019s, and so is the lookup of each component\u2019s table. A plain read answers the published layer only and would not
// find a form a maker added to the app in the designer and never published; the saved layer does.

test('a form the app holds that was never published is identified in the saved layer, so the forms the app holds elsewhere are protected in the same build', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const live = await s.makerEditsForm('contoso_retained', 'Held form with a saved label', { inApp: true });
  const draft = await s.makerSavesForm('contoso_lookup', 'Held form never published', { inApp: true });
  assert.deepStrictEqual(s.unfinished().sort(), ['Held form never published', 'Held form with a saved label']);
  const { mark, warnings } = await s.build(makeSpec());
  const calls = s.org.calls.slice(mark);
  const lookups = calls.filter(isFormTableLookup);
  assert.ok(lookups.some((c) => c.path.includes(draft)) && lookups.some((c) => c.path.includes(live)), 'both components are looked up in the saved layer');
  assert.ok(!calls.some((c) => c.method === 'GET' && /^\/systemforms\?/.test(c.path) && /\$filter=formid eq /.test(c.path)), 'and never with a plain read, which answers the published layer only');
  assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_item, contoso_lookup, contoso_nav, contoso_retained, contoso_stats', 'app', 'tables contoso_item + app'], 'the table of the form never published is named: the app holds a form of it');
  assert.deepStrictEqual(s.unfinished(), [], 'the held form with a saved label is live before the app is published');
  assert.deepStrictEqual(warnings.filter((w) => /could not (publish|tell|read)/.test(w)), [], 'nothing was left unproven, so nothing is said');
  const second = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(second.mark).length, 3, 'and a build after it sends the same three publishes');
});

// --- A table only a page reads -----------------------------------------------------------------------------------------------

for (const pinned of [false, true]) {
  test(`a table only a page reads is not published ahead of the app, ${pinned ? 'though its default view is one of the app\u2019s components' : 'and it has no default view to pin'}`, async () => {
    const s = scenario();
    const spec = pageSpec();
    assert.strictEqual(validateAppSpec(spec).ok, true);
    const first = await s.build(spec, { phases: NO_PAGES });
    assert.strictEqual(s.org.publishLog(first.mark)[0], 'tables contoso_item, contoso_nav, contoso_stats', 'the first build creates the app: the navigation\u2019s tables, and the chart\u2019s');
    await s.makerEditsForm('contoso_page_only', 'Unrelated draft on a data-only table');
    if (pinned) s.appPinsDefaultViewOf('contoso_page_only');
    const { mark } = await s.build(spec, { phases: NO_PAGES });
    assert.deepStrictEqual(s.unfinished(), ['Unrelated draft on a data-only table'], 'what a maker left on that table is not released');
    assert.deepStrictEqual(s.org.publishLog(first.mark).filter((line) => line.includes('contoso_page_only')), [], 'no request of the first build or of the rebuild names it');
    assert.strictEqual(s.org.publishLog(mark)[0], 'tables contoso_item, contoso_stats', 'the rebuild writes no sitemap (the page entry waits for the pages phase), so the SDK adds no form: what the build changed and what the app holds, and not the navigation\u2019s Nav');
  });
}

// --- Charts ------------------------------------------------------------------------------------------------------------------

test('a chart the build creates on a table the app does not hold is published with that table before the app', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const grown = makeSpec();
  grown.charts.push({ entity: 'contoso_lookup', name: 'Lookup By Name', chartType: 'Pie', groupBy: 'contoso_name', measure: 'count' });
  const { mark } = await s.build(grown);
  const calls = s.org.calls.slice(mark);
  const created = indexOfFirst(calls, (c) => c.method === 'POST' && c.path.startsWith('/savedqueryvisualizations'));
  const published = indexOfFirst(calls, isTablePublish('contoso_lookup'));
  assert.ok(created >= 0 && published > created && published < indexOfFirst(calls, isAppPublish), 'created, then published, before the app');
  assert.deepStrictEqual(s.unfinished(), []);
});

test('a changed chart description is published with its table before the app\u2019s first publish, not after it', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const changed = makeSpec();
  changed.charts[0].description = 'v2';
  const { mark } = await s.build(changed);
  const calls = s.org.calls.slice(mark);
  const saved = indexOfFirst(calls, (c) => c.method === 'PATCH' && c.path.startsWith('/savedqueryvisualizations('));
  const published = indexOfFirst(calls, isTablePublish('contoso_stats'));
  assert.ok(saved >= 0, 'the description is written');
  assert.ok(published > saved && published < indexOfFirst(calls, isAppPublish), 'published after it is written and before the app');
  assert.deepStrictEqual(s.unfinished(), []);
  assert.strictEqual(s.org.publishLog(mark).length, 3, 'still three publishes');
});

// --- A request that is refused ------------------------------------------------------------------------------------------------

test('when the request before the app is refused the build says plainly that the protection did not apply, names the chart description it wrote, and goes on', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const changed = makeSpec();
  changed.charts[0].description = 'v2';
  s.org.refuseNextTablePublish(400);
  const { outcome, mark, warnings } = await s.build(changed);
  assert.strictEqual(outcome.ok, true, 'the build goes on');
  assert.deepStrictEqual(s.org.publishLog(mark), [
    'tables contoso_item, contoso_nav, contoso_stats', // refused
    'tables contoso_item', // what the build reconciled is published through the SDK, as before
    'app',
    'tables contoso_item, contoso_stats + app',
  ]);
  const line = warnings.find((w) => /could not publish/.test(w));
  assert.ok(line, warnings.join('\n'));
  assert.match(line, /could not publish tables contoso_nav, contoso_stats before the app/);
  assert.match(line, /the description of chart Stats By Kind/, 'what this build wrote is named');
  assert.match(line, /HTTP 400/, 'with the platform\u2019s refusal');
  assert.match(line, /did not apply/, 'the protection is said to have failed');
  assert.match(line, /not been measured/, 'what the order does to a chart description is not claimed');
  assert.match(line, /The app holds, or this build's write of it adds, forms of contoso_nav: a label someone saved/, 'the navigation\u2019s table is one whose forms the write adds');
  assert.ok(!/forms of [^:]*contoso_stats/.test(line), 'the app holds a chart of Stats and no form: no label risk is claimed for it');
});

test('a table that carries this build\u2019s chart description AND a form a maker saved gets both warnings when the request before the app is refused', async () => {
  const s = scenario();
  const spec = makeSpec();
  spec.views = [];
  spec.forms = [];
  spec.appShell.areas[0].groups[0].subAreas = [{ entity: 'contoso_stats', title: 'Stats' }];
  await s.build(spec);
  await s.makerEditsForm('contoso_stats', 'Maker label on the chart table', { inApp: true });
  spec.charts[0].description = 'v2';
  s.org.refuseNextTablePublish(400);
  const { outcome, mark, warnings } = await s.build(spec);
  assert.strictEqual(outcome.ok, true, 'the build goes on');
  assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_stats', 'app', 'tables contoso_stats + app'], 'nothing else is published before the app: no fallback hides the risk');
  const line = warnings.find((w) => /could not publish/.test(w));
  assert.ok(line, warnings.join('\n'));
  assert.match(line, /This build saved the description of chart Stats By Kind on contoso_stats/);
  assert.match(line, /Whether the app's publish holds back a chart's description saved before it has not been measured/);
  assert.match(line, /The app holds forms of contoso_stats: a label someone saved on a form there and did not publish may stay unpublished once the app is published/, 'the form risk is not dropped because the table also carries a chart');
  assert.match(line, /may have to be saved again and then published with its table before the app\./);
});

// --- What the app holds cannot be proven ---------------------------------------------------------------------------------------
//
// The request then names what the build changed and what its own write of the app adds (which needs no read), and the build says which proof failed.

test('when the app\u2019s form components cannot be read the build publishes only what it changed and what its write adds, says which read failed, advises no publish of a table it could not prove, and covers the held form on the run that can read it', async () => {
  const s = scenario();
  await s.build(makeSpec());
  await s.makerEditsForm('contoso_retained', 'Form a maker added to the app', { inApp: true });
  await s.makerEditsForm('contoso_lookup', 'Unrelated unfinished form');
  const release = s.org.intercept(readsComponentsOfType(60), refuses(500, 'simulated read refusal'));
  const blind = await s.build(makeSpec());
  assert.strictEqual(blind.outcome.ok, true);
  assert.deepStrictEqual(s.org.publishLog(blind.mark), ['tables contoso_item, contoso_nav', 'app', 'tables contoso_item + app'], 'exactly what it published before it read anything: the reconciled table and the navigation\u2019s, and nothing it cannot prove');
  assert.deepStrictEqual(s.unfinished().sort(), ['Form a maker added to the app', 'Unrelated unfinished form']);
  const said = blind.warnings.filter((w) => /could not tell which tables/.test(w));
  assert.strictEqual(said.length, 1, blind.warnings.join('\n'));
  assert.match(said[0], /could not tell which tables the forms and charts the app already holds belong to \(app component type 60 could not be read \(.*500.*\)\)/, 'which proof failed');
  assert.match(said[0], /so before the app's own publish it published only the tables this build changed and the navigation's tables, whose Main forms its own write of the app adds/);
  assert.match(said[0], /Run the build again once the cause is cleared: it then publishes the tables whose forms or charts the app holds before the app's own publish/);
  assert.ok(!/contoso_retained|contoso_lookup/.test(said[0]), 'no table it could not prove is named');
  assert.ok(!/Publish (that|those|the)[^.]*in Power Apps/i.test(said[0]), 'and none is recommended for publishing');
  release();
  const sighted = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(sighted.mark)[0], 'tables contoso_item, contoso_nav, contoso_retained, contoso_stats', 'the run that can read what the app holds publishes the held form\u2019s table');
  assert.deepStrictEqual(s.unfinished(), ['Unrelated unfinished form'], 'and still not the one it cannot prove is the app\u2019s');
  assert.deepStrictEqual(sighted.warnings.filter((w) => /could not (publish|tell|read)/.test(w)), []);
});

test('a form component no layer answers a row for makes the read incomplete: the build does not claim a complete inventory, and publishes only what it changed and what its write adds', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const formid = await s.makerEditsForm('contoso_lookup', 'Unresolved app-held form', { inApp: true });
  // The component list names the form, and the lookup of its table, in the saved layer, answers 200 with no row: a stale component, a record the caller may not read.
  s.org.intercept((c) => isFormTableLookup(c) && c.path.includes(formid), () => rowsOf([]));
  const { mark, warnings } = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_item, contoso_nav', 'app', 'tables contoso_item + app']);
  assert.deepStrictEqual(s.unfinished(), ['Unresolved app-held form'], 'a table that cannot be proven is left alone');
  const said = warnings.filter((w) => /could not tell which tables/.test(w));
  assert.strictEqual(said.length, 1, warnings.join('\n'));
  assert.ok(said[0].includes(formid), 'the component it could not identify is named');
  assert.ok(!/contoso_lookup/.test(said[0]));
});

// The answer to the lookup of the forms\u2019 tables is read strictly: a row counts for a form the app holds, and for no other, and what it says of the table has
// to be a table. The rows below are answered for the two forms the app holds that the build can name, Item\u2019s (created by the build) and the held form\u2019s.
const heldFormScenario = async () => {
  const s = scenario();
  await s.build(makeSpec());
  const held = await s.makerEditsForm('contoso_retained', 'Held form', { inApp: true });
  const unrelated = await s.makerSavesForm('contoso_lookup', 'Unrelated lookup draft');
  const item = s.org.fake.rows('systemforms').find((r) => r.data.objecttypecode === 'contoso_item').data.formid;
  return { s, held, unrelated, item };
};
const COMPLETE = 'tables contoso_item, contoso_nav, contoso_retained, contoso_stats';
const WHAT_THE_BUILD_CHANGED = 'tables contoso_item, contoso_nav';

for (const [name, answer, complete] of [
  ['a row for a form the app does not hold, and a row that names no form at all, both on the lookup table', ({ item, held, unrelated }) => [{ formid: item, objecttypecode: 'contoso_item' }, { formid: held, objecttypecode: 'contoso_retained' }, { formid: unrelated, objecttypecode: 'contoso_lookup' }, { objecttypecode: 'contoso_lookup' }], true],
  ['the same form answered in both layers', ({ item, held }) => [{ formid: item, objecttypecode: 'contoso_item' }, { formid: held, objecttypecode: 'contoso_retained' }, { formid: held.toUpperCase(), objecttypecode: 'contoso_retained' }], true],
  ['one form answered with two different tables', ({ item, held }) => [{ formid: item, objecttypecode: 'contoso_item' }, { formid: held, objecttypecode: 'contoso_retained' }, { formid: held, objecttypecode: 'contoso_lookup' }], false],
  ['a table that is only whitespace', ({ item, held }) => [{ formid: item, objecttypecode: 'contoso_item' }, { formid: held, objecttypecode: '   ' }], false],
  ['a table that is a number', ({ item, held }) => [{ formid: item, objecttypecode: 'contoso_item' }, { formid: held, objecttypecode: 12345 }], false],
]) {
  test(`strict resolution: ${name} ${complete ? 'adds no table, and the read stays complete' : 'keeps the read from being complete, so only what the build changed and its write adds is published'}`, async () => {
    const { s, held, unrelated, item } = await heldFormScenario();
    s.org.intercept(isFormTableLookup, () => rowsOf(answer({ item, held, unrelated })));
    const { mark, warnings } = await s.build(makeSpec());
    const said = warnings.filter((w) => /could not tell which tables/.test(w));
    if (complete) {
      assert.deepStrictEqual(s.org.publishLog(mark)[0], COMPLETE, 'the tables the app proves it holds forms and charts of, and never the lookup table');
      assert.deepStrictEqual(said, [], 'the answer proves every component: nothing is left unproven');
      assert.deepStrictEqual(s.unfinished(), ['Unrelated lookup draft'], 'what a maker left on a table the app does not hold is not released');
    } else {
      assert.deepStrictEqual(s.org.publishLog(mark)[0], WHAT_THE_BUILD_CHANGED, 'no table the answer names is taken for one the app holds');
      assert.strictEqual(said.length, 1, warnings.join('\n'));
      assert.match(said[0], /could not be fully identified/);
      assert.deepStrictEqual(s.unfinished().sort(), ['Held form', 'Unrelated lookup draft'], 'and neither draft is released');
    }
    assert.strictEqual(s.org.publishLog(mark).length, 3, 'the same three publishes');
  });
}

// Each read the proof rests on, refused, malformed or lost, ends in the same fallback and the same one warning: the build goes on, publishes what it changed
// and what its write adds, and names no table it could not prove. The denial is of the new read alone: the SDK reads the app again later in the build.
// (Every read in every one of those ways is pinned in table-publish.test.js; these run the real SDK through one way of each, and a description the build wrote.)
const isLayerRead = (c) => c.method === 'GET' && /^\/appmodules\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple/.test(c.path);
for (const [what, how, match, answer, withChartWrite] of [
  ['the app\u2019s layer', 'refused', isLayerRead, refuses(403, 'injected denial'), false],
  ['the chart components', 'malformed', readsComponentsOfType(59), () => rowsOf({}), false],
  ['the form components', 'lost to the network', readsComponentsOfType(60), () => { throw new Error('injected transport loss'); }, false],
  ['the lookup of the forms\u2019 tables', 'refused', isFormTableLookup, refuses(500, 'injected refusal'), false],
  ['the lookup of the forms\u2019 tables', 'malformed', isFormTableLookup, () => rowsOf({}), true],
]) {
  test(`${what} ${how}${withChartWrite ? ', with a chart description written in the same build' : ''}: the build goes on and publishes what it changed and what its write adds, with one warning`, async () => {
    const s = scenario();
    const spec = makeSpec();
    await s.build(spec);
    await s.makerEditsForm('contoso_retained', 'Held form outside the spec', { inApp: true });
    await s.makerEditsForm('contoso_lookup', 'Unrelated lookup draft');
    if (withChartWrite) spec.charts[0].description = 'v2 during an unreadable inventory';
    s.org.intercept(onlyFirst(match), answer);
    const { outcome, mark, warnings } = await s.build(spec);
    assert.strictEqual(outcome.ok, true);
    assert.deepStrictEqual(s.org.publishLog(mark), withChartWrite
      ? ['tables contoso_item, contoso_nav, contoso_stats', 'app', 'tables contoso_item, contoso_stats + app']
      : [WHAT_THE_BUILD_CHANGED, 'app', 'tables contoso_item + app']);
    assert.strictEqual(warnings.filter((w) => /could not tell which tables/.test(w)).length, 1, warnings.join('\n'));
    assert.ok(!warnings.some((w) => /contoso_lookup|contoso_retained|Publish (that|those|these) tables? in Power Apps/.test(w)), 'no table it could not prove is named or recommended');
    assert.deepStrictEqual(s.unfinished().sort(), ['Held form outside the spec', 'Unrelated lookup draft']);
  });
}

test('a large membership is looked up twenty forms to a request, with every answer counted and no table metadata read', async () => {
  const s = scenario();
  await s.build(makeSpec());
  for (let i = 0; i < 45; i += 1) await s.makerEditsForm('contoso_retained', `Held form ${i}`, { inApp: true });
  const { mark } = await s.build(makeSpec());
  const calls = s.org.calls.slice(mark);
  const before = calls.slice(0, indexOfFirst(calls, isTablesPublish));
  assert.deepStrictEqual(before.filter(isFormTableLookup).map((c) => (c.path.match(/formid eq /g) || []).length), [20, 20, 6], 'the 45 held forms and Item\u2019s own');
  assert.deepStrictEqual(before.filter((c) => /^\/EntityDefinitions\([0-9a-f-]{36}\)/i.test(c.path)), []);
  assert.deepStrictEqual(s.org.publishLog(mark), [COMPLETE, 'app', 'tables contoso_item + app']);
});

// The component list is read page by page: a continuation the platform sends is an absolute link, and a page that fails is a list that cannot be trusted to be
// whole. (A malformed page, a repeated link and one that is no link are pinned in app-components.test.js, where the pages are read.)
for (const kind of ['good', 'refused']) {
  test(`a component list that continues on a second page: ${kind === 'good' ? 'the second page\u2019s form counts' : 'a refused continuation keeps the read from being complete'}`, async () => {
    const s = scenario();
    await s.build(makeSpec());
    await s.makerEditsForm('contoso_retained', 'First-page held form', { inApp: true });
    const second = await s.makerEditsForm('contoso_lookup', 'Second-page held form', { inApp: true });
    const forms = s.org.components.filter((c) => c.componenttype === 60);
    const next = `${s.org.origin}/api/data/v9.0/appmodulecomponents?$skiptoken=next-page`;
    let followed = 0;
    s.org.intercept(onlyFirst(readsComponentsOfType(60)), () => rowsOf(forms.filter((c) => c.objectid !== second), { '@odata.nextLink': next }));
    s.org.intercept((c) => c.method === 'GET' && c.path.includes('$skiptoken=next-page'), () => {
      followed += 1;
      return kind === 'refused' ? refuses(500, 'injected continuation refusal')() : rowsOf(forms.filter((c) => c.objectid === second));
    });
    const { outcome, mark, warnings } = await s.build(makeSpec());
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(followed, 1, 'the link is followed once');
    if (kind === 'good') {
      assert.strictEqual(s.org.publishLog(mark)[0], 'tables contoso_item, contoso_lookup, contoso_nav, contoso_retained, contoso_stats');
      assert.deepStrictEqual(warnings.filter((w) => /could not tell which tables/.test(w)), []);
    } else {
      assert.strictEqual(s.org.publishLog(mark)[0], WHAT_THE_BUILD_CHANGED);
      assert.strictEqual(warnings.filter((w) => /could not tell which tables/.test(w)).length, 1, warnings.join('\n'));
    }
  });
}

// --- Cost, and the restricted app --------------------------------------------------------------------------------------------

test('the read of what the app holds is only its form and chart components: no table metadata and no view is read before the tables are published', async () => {
  const s = scenario();
  await s.build(makeSpec());
  for (let i = 0; i < 50; i += 1) s.org.components.push({ componenttype: 1, objectid: s.org.fake.entityId(`contoso_large${i}`) });
  const { mark } = await s.build(makeSpec());
  const calls = s.org.calls.slice(mark);
  const before = calls.slice(0, indexOfFirst(calls, isTablesPublish));
  assert.deepStrictEqual(before.filter((c) => /^\/EntityDefinitions\([0-9a-f-]{36}\)/i.test(c.path)), [], 'a table component\u2019s metadata is never read: fifty of them cost nothing');
  assert.deepStrictEqual(before.filter((c) => /^\/appmodulecomponents/.test(c.path)).map((c) => Number((/componenttype eq (\d+)/.exec(c.path) || [])[1])), [59, 60], 'one read per kind of component that counts');
  assert.deepStrictEqual(before.filter((c) => /^\/savedqueries\?/.test(c.path) && /savedqueryid eq/.test(c.path)), [], 'and the views are not looked up');
  assert.strictEqual(s.org.publishLog(mark).length, 3);
});

test('a restricted app (a Main-form list and a table pinned only in app.tables) sends three publishes on a rebuild: a listed table counts for the forms the list keeps, and the pinned table is not named', async () => {
  const s = scenario();
  const spec = makeSpec();
  spec.minimumPluginVersion = '2.13.0';
  spec.app.tables = ['contoso_hidden'];
  spec.app.mainForms = { contoso_item: ['Item'] };
  spec.forms.push({ entity: 'contoso_item', name: 'Excluded Item', layout: 'auto' });
  assert.strictEqual(validateAppSpec(spec).ok, true);
  const first = await s.build(spec);
  const heldForms = new Set(s.org.components.filter((c) => c.componenttype === 60).map((c) => c.objectid));
  const heldNames = s.org.fake.rows('systemforms').filter((r) => heldForms.has(r.data.formid)).map((r) => r.data.name);
  assert.deepStrictEqual(heldNames, ['Item'], 'the list keeps the second Main form out of the app');
  assert.ok(s.org.components.some((c) => c.componenttype === 1 && c.objectid === s.org.fake.entityId('contoso_hidden')), 'the table is pinned');
  assert.deepStrictEqual(s.org.publishLog(first.mark), ['tables contoso_item, contoso_nav, contoso_stats', 'app', 'app', 'tables contoso_item, contoso_stats + app'], 'Item is listed with a form the app will hold; the second app publish is the pin\u2019s');
  const rebuild = await s.build(spec);
  assert.deepStrictEqual(s.org.publishLog(rebuild.mark), ['tables contoso_item, contoso_nav, contoso_stats', 'app', 'tables contoso_item + app']);
  assert.ok(!s.org.publishLog().some((line) => line.includes('contoso_hidden')), 'a table that is only pinned is not named by any request');
});

test('a Main-form list is honoured: the form it leaves out is not one the build\u2019s write adds, and the table is named because the forms it keeps are', async () => {
  const s = scenario();
  const spec = makeSpec();
  spec.minimumPluginVersion = '2.13.0';
  spec.app.mainForms = { contoso_item: ['Item'] };
  spec.forms.push({ entity: 'contoso_item', name: 'Excluded Item', layout: 'auto' });
  await s.build(spec);
  // A later edit of the form the list leaves out, and of a form a maker adds to Nav, which the list does not mention.
  const excluded = s.org.fake.rows('systemforms').find((r) => r.data.name === 'Excluded Item').data.formid;
  const navForm = await s.makerEditsForm('contoso_nav', 'Nav form edited after the app was created');
  const { mark } = await s.build(spec);
  assert.ok(!s.org.components.some((c) => c.objectid === excluded), 'the app never holds the form the list leaves out');
  assert.ok(s.org.components.some((c) => c.componenttype === 60 && c.objectid === navForm), 'while the table the list does not mention gets all its active Main forms');
  assert.strictEqual(s.org.publishLog(mark)[0], 'tables contoso_item, contoso_nav, contoso_stats');
  assert.deepStrictEqual(s.unfinished(), []);
});

test('without --publish nothing is published ahead of the app but what the reconciles publish themselves', async () => {
  const s = scenario();
  await s.build(makeSpec(), { publish: false });
  const { mark } = await s.build(makeSpec(), { publish: false });
  assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_item', 'tables contoso_item', 'app']);
  assert.ok(!s.org.calls.slice(mark).some((c) => /^\/appmodulecomponents/.test(c.path) && /componenttype eq (59|60)\b/.test(c.path)), 'and the app\u2019s components are not read for it');
});

// --- A build that stops before its publish phase -----------------------------------------------------------------------------
//
// With every publish of tables refused, the build stops before the app is written (the request before the app, and then the SDK\u2019s publish of what it
// reconciled, are refused). The CLI settles what the build owed and then says what the spec\u2019s tables still hold saved and not published: a read of every
// table the spec names, the navigation\u2019s, the lookup\u2019s and a page\u2019s included, which publishes none of the ones the app does not hold.
for (const settleSucceeds of [true, false]) {
  test(`a build stopped by a refused table publish, ${settleSucceeds ? 'with the settle allowed' : 'with the settle refused too'}: the app is not published, and the diagnostic reads every table the spec names`, async () => {
    const s = scenario();
    const spec = pageSpec();
    await s.build(spec, { phases: NO_PAGES });
    await s.makerSavesForm('contoso_nav', 'Draft on nav-only table');
    await s.makerSavesForm('contoso_lookup', 'Draft on lookup-only table');
    await s.makerSavesForm('contoso_page_only', 'Draft on page-only table');
    fs.writeFileSync(path.join(s.dir, 'Overview.tsx'), 'export default function Overview() { return null; }\n');
    spec.charts[0].description = 'v2';
    spec.views[0].columns = ['contoso_name', 'contoso_code', 'contoso_lookupid'];
    spec.views[0].description = 'View edit saved before the halted publish';
    const sdk = await s.makeSdk();
    const mark = s.org.calls.length;
    const warnings = [];
    let halted;
    let stage = 'build';
    s.org.intercept((c) => isTablesPublish(c) && (stage === 'build' || !settleSucceeds), refuses(400, 'injected refusal until the engine halts'));
    await assert.rejects(buildModelApp(spec, { apply: true, publish: true, maxRetries: 0, appDir: s.dir, workspaceDir: s.dir }, {
      sdk,
      warn: (w) => warnings.push(String(w)),
      runBuild: async (runSpec, options) => {
        try {
          return await runSdkBuild(runSpec, { ...options, phases: PHASES, env: s.org.origin, genpage: s.noPageBackend });
        } catch (e) {
          halted = e;
          stage = 'settle';
          throw e;
        }
      },
    }), (e) => e === halted && e.code === 'reconciled-publish-failed');
    const requests = s.org.calls.slice(mark);
    assert.ok(!requests.some(isAppPublish), 'the refusal stops the app from being published');
    assert.ok(!requests.some(isAppCreate) && !requests.some((c) => c.method === 'POST' && c.path === '/AddAppComponents'), 'and from being written');
    const diagnostic = requests.filter((c) => /^\/(savedqueries|systemforms|savedqueryvisualizations)\/Microsoft\.Dynamics\.CRM\.RetrieveUnpublishedMultiple\(\)\?.*\$filter=[a-z]+ eq '/.test(c.path));
    assert.strictEqual(diagnostic.length, 3, 'one read of the saved layer per collection');
    for (const read of diagnostic) {
      for (const name of ['contoso_nav', 'contoso_lookup', 'contoso_page_only']) assert.ok(read.path.includes(`'${name}'`), `${name} is read: the diagnostic is as wide as the spec`);
    }
    assert.match(warnings.at(-1), /Draft on page-only table/, 'what a maker left on a table only a page reads is said, not published');
    const drafts = s.unfinished().filter((name) => /^Draft on /.test(name)).sort();
    assert.deepStrictEqual(drafts, ['Draft on lookup-only table', 'Draft on nav-only table', 'Draft on page-only table'], 'and none of the drafts was released by the settle');
    assert.strictEqual(s.unfinished().includes('Items'), !settleSucceeds, 'the view the build saved is live when the settle was allowed, and not when it was refused');
  });
}
