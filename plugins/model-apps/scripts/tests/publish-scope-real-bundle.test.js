'use strict';
// Which tables the build publishes before it publishes the app, over the REAL vendored SDK and a stateful fake Dataverse that also holds
// the app, its sitemap and its components (helpers/fake-app-build-org.js), so what is asserted is what reached the wire and what the
// platform is left holding unpublished.
//
// Dataverse leaves a saved form's label changes out of the published form when a PublishXml that names only the app runs before the
// table's own publish (measured; see publishReconciledTables in sdk-build.js). The one request before the app names the tables whose
// existing views and forms the build reconciled, the tables of the charts it wrote, and the tables whose forms or charts the app is PROVEN
// to hold: its component list on the server says so, whether or not the spec names the table. A table that is only a lookup column's
// target, that only a page reads, or that the app holds only as a navigation entry is not published by it: a table's publish ships
// everything saved on that table, whoever saved it, so naming one would release a maker's unfinished work there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild } = require('../lib/sdk-build.js');
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
  async function build(spec, { publish = true, phases = PHASES } = {}) {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
    await sdk.initWorkspace();
    const mark = org.calls.length;
    const warned = warnings.length;
    const outcome = await runSdkBuild(spec, {
      sdk, apply: true, publish, phases, workspaceDir: dir, appDir: dir, env: org.origin,
      genpage: { enumerateEnv: async () => ({ ok: true, pages: [], ids: [] }) },
      warn: (w) => warnings.push(String(w)),
    });
    return { outcome, mark, warnings: warnings.slice(warned) };
  }
  // A form a maker saved and never published: the platform lists it as a saved record of that table.
  async function makerSavesForm(table, name) {
    const formid = randomUUID();
    const response = await org.httpClient.post(`${org.origin}/api/data/v9.0/systemforms`, { formid, name, objecttypecode: table, type: 2, formxml: '<form><tabs/></form>' });
    assert.ok(response.status < 300, `the fake accepted the form: ${response.status}`);
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
  return { org, build, makerSavesForm, makerEditsForm, appPinsDefaultViewOf, unfinished, warnings };
}

const indexOfFirst = (calls, test) => calls.findIndex(test);
const isTablePublish = (table) => (c) => c.method === 'POST' && c.path === '/PublishXml' && c.body.ParameterXml.includes(`<entity>${table}</entity>`);
const isAppPublish = (c) => c.method === 'POST' && c.path === '/PublishXml' && /<appmodule>/.test(c.body.ParameterXml);
const isTablesPublish = (c) => c.method === 'POST' && c.path === '/PublishXml' && /<entity>/.test(c.body.ParameterXml);
const readsComponentsOfType = (type) => (c) => c.method === 'GET' && /^\/appmodulecomponents/.test(c.path) && new RegExp(`componenttype eq ${type}\\b`).test(c.path);
const refuses = (status, message) => () => ({ status, headers: {}, body: { error: { message } } });

test('the spec these cases build is valid, so none of them rests on a spec the CLI would refuse', () => {
  for (const spec of [makeSpec(), bareSpec(), pageSpec()]) {
    const validated = validateAppSpec(spec);
    assert.deepStrictEqual({ ok: validated.ok, errors: validated.errors }, { ok: true, errors: [] });
  }
});

// --- What is published, and when ---------------------------------------------------------------------------------------------

test('a first build publishes, in one request before the app is created, the tables of the charts it wrote \u2014 the app does not exist yet, so nothing on the server is proven', async () => {
  const s = scenario();
  await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(), [
    'tables contoso_stats', // the chart this build created. Item\u2019s form and view are created too, not reconciled; Nav is a navigation entry and Lookup a lookup target
    'app', // the create\u2019s own publish
    'tables contoso_item, contoso_stats + app', // phase 8
  ]);
  const before = indexOfFirst(s.org.calls, isTablePublish('contoso_stats'));
  assert.ok(before > 0 && before < indexOfFirst(s.org.calls, (c) => c.method === 'POST' && /^\/appmodules(\?|$)/.test(c.path)), 'before the app is created');
});

test('an unchanged rebuild still sends three publishes, in the same order: the tables the build changed and the app holds forms or charts of, the app, then everything', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const { mark, warnings } = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(mark), [
    'tables contoso_item, contoso_stats', // Item: reconciled, and its form is in the app. Stats: its chart is in the app. Nav and Lookup: no form or chart of theirs is
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

test('a form a maker saves on a navigation table after the app was created is pinned into the app by the next build and published before the app by the build after it: the proof is what the app held when the build read it', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const nav = s.org.fake.entityId('contoso_nav');
  const formsOfNav = () => s.org.fake.rows('systemforms').filter((r) => r.data.objecttypecode === 'contoso_nav').map((r) => r.data.formid);
  assert.ok(s.org.components.some((c) => c.componenttype === 1 && c.objectid === nav), 'the app holds the table, as a navigation entry');
  assert.deepStrictEqual(formsOfNav(), [], 'and no form of it: a table component alone proves nothing about a form');
  await s.makerEditsForm('contoso_nav', 'Saved form on a navigation table');
  const second = await s.build(makeSpec());
  assert.ok(!s.org.publishLog(second.mark)[0].includes('contoso_nav'), 'the app held no form of it when this build read what the app holds');
  assert.deepStrictEqual(s.unfinished(), ['Saved form on a navigation table']);
  // The SDK writes a navigation table\u2019s active Main forms, all its charts and public views into the app as components whenever the build writes the app.
  assert.ok(formsOfNav().every((id) => s.org.components.some((c) => c.componenttype === 60 && c.objectid === id)), 'this build pinned the form');
  const third = await s.build(makeSpec());
  assert.strictEqual(s.org.publishLog(third.mark)[0], 'tables contoso_item, contoso_nav, contoso_stats', 'so the next build can prove it, and publishes the table before the app');
  assert.deepStrictEqual(s.unfinished(), []);
  assert.strictEqual(s.org.publishLog(third.mark).length, 3, 'with the same three publishes');
});

test('a table the spec only declares is published once the app holds a form of it: components already on the server count', async () => {
  const s = scenario();
  await s.build(makeSpec());
  await s.makerEditsForm('contoso_lookup', 'Form a maker added to the app', { inApp: true });
  assert.deepStrictEqual(s.unfinished(), ['Form a maker added to the app']);
  const { mark } = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(mark)[0], 'tables contoso_item, contoso_lookup, contoso_stats', 'the first publish names it');
  assert.deepStrictEqual(s.unfinished(), []);
});

// --- The app holds a form the spec never names -------------------------------------------------------------------------------

test('a form the app holds on a table the spec does not name is published before the app: what the server says the app holds counts, whatever the spec names', async () => {
  const s = scenario();
  await s.build(makeSpec());
  await s.makerEditsForm('contoso_retained', 'Form held only on the server', { inApp: true });
  const { mark, warnings } = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_item, contoso_retained, contoso_stats', 'app', 'tables contoso_item + app']);
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

// --- A table only a page reads -----------------------------------------------------------------------------------------------

for (const pinned of [false, true]) {
  test(`a table only a page reads is not published ahead of the app, ${pinned ? 'though its default view is one of the app\u2019s components' : 'and it has no default view to pin'}`, async () => {
    const s = scenario();
    const spec = pageSpec();
    assert.strictEqual(validateAppSpec(spec).ok, true);
    const first = await s.build(spec, { phases: NO_PAGES });
    await s.makerEditsForm('contoso_page_only', 'Unrelated draft on a data-only table');
    if (pinned) s.appPinsDefaultViewOf('contoso_page_only');
    const { mark } = await s.build(spec, { phases: NO_PAGES });
    assert.deepStrictEqual(s.unfinished(), ['Unrelated draft on a data-only table'], 'what a maker left on that table is not released');
    assert.deepStrictEqual(s.org.publishLog(first.mark).filter((line) => line.includes('contoso_page_only')), [], 'no request of the first build or of the rebuild names it');
    assert.strictEqual(s.org.publishLog(mark)[0], 'tables contoso_item, contoso_stats', 'the rebuild\u2019s request is the one the same spec without the page sends');
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
    'tables contoso_item, contoso_stats', // refused
    'tables contoso_item', // what the build reconciled is published through the SDK, as before
    'app',
    'tables contoso_item, contoso_stats + app',
  ]);
  const line = warnings.find((w) => /could not publish/.test(w));
  assert.ok(line, warnings.join('\n'));
  assert.match(line, /could not publish table contoso_stats before the app/);
  assert.match(line, /the description of chart Stats By Kind/, 'what this build wrote is named');
  assert.match(line, /HTTP 400/, 'with the platform\u2019s refusal');
  assert.match(line, /did not apply/, 'the protection is said to have failed');
  assert.match(line, /not been measured/, 'what the order does to a chart description is not claimed');
  assert.ok(!/forms of contoso_stats/.test(line), 'the app holds a chart of Stats and no form: no label risk is claimed for it');
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

test('when the app\u2019s form components cannot be read the build publishes only what it changed, says which read failed, advises no publish of a table it could not prove, and covers the held form on the run that can read it', async () => {
  const s = scenario();
  await s.build(makeSpec());
  await s.makerEditsForm('contoso_retained', 'Form a maker added to the app', { inApp: true });
  await s.makerEditsForm('contoso_lookup', 'Unrelated unfinished form');
  const release = s.org.intercept(readsComponentsOfType(60), refuses(500, 'simulated read refusal'));
  const blind = await s.build(makeSpec());
  assert.strictEqual(blind.outcome.ok, true);
  assert.deepStrictEqual(s.org.publishLog(blind.mark), ['tables contoso_item', 'app', 'tables contoso_item + app'], 'exactly what it published before it read anything: the reconciled table, and nothing it cannot prove');
  assert.deepStrictEqual(s.unfinished().sort(), ['Form a maker added to the app', 'Unrelated unfinished form']);
  const said = blind.warnings.filter((w) => /could not tell which tables/.test(w));
  assert.strictEqual(said.length, 1, blind.warnings.join('\n'));
  assert.match(said[0], /could not tell which tables the forms and charts the app already holds belong to \(app component type 60 could not be read \(.*500.*\)\)/, 'which proof failed');
  assert.match(said[0], /only the tables this build changed were published before the app's own publish/);
  assert.match(said[0], /Run the build again once the cause is cleared: it then publishes the tables whose forms or charts the app holds before the app's own publish/);
  assert.ok(!/contoso_retained|contoso_lookup/.test(said[0]), 'no table it could not prove is named');
  assert.ok(!/Publish (that|those|the)[^.]*in Power Apps/i.test(said[0]), 'and none is recommended for publishing');
  release();
  const sighted = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(sighted.mark)[0], 'tables contoso_item, contoso_retained, contoso_stats', 'the run that can read what the app holds publishes the held form\u2019s table');
  assert.deepStrictEqual(s.unfinished(), ['Unrelated unfinished form'], 'and still not the one it cannot prove is the app\u2019s');
  assert.deepStrictEqual(sighted.warnings.filter((w) => /could not (publish|tell|read)/.test(w)), []);
});

test('a form component the platform answers no row for makes the read incomplete: the build does not claim a complete inventory, and publishes only what it changed', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const formid = await s.makerEditsForm('contoso_lookup', 'Unresolved app-held form', { inApp: true });
  // The component list names the form, and the lookup of its table answers 200 with no row: a stale component, a record the caller may not read, a draft only.
  s.org.intercept((c) => c.method === 'GET' && /^\/systemforms\?/.test(c.path) && c.path.includes(formid), () => ({ status: 200, headers: {}, body: { value: [] } }));
  const { mark, warnings } = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_item', 'app', 'tables contoso_item + app']);
  assert.deepStrictEqual(s.unfinished(), ['Unresolved app-held form'], 'a table that cannot be proven is left alone');
  const said = warnings.filter((w) => /could not tell which tables/.test(w));
  assert.strictEqual(said.length, 1, warnings.join('\n'));
  assert.ok(said[0].includes(formid), 'the component it could not identify is named');
  assert.ok(!/contoso_lookup/.test(said[0]));
});

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

test('a restricted app (a Main-form list and a table pinned only in app.tables) sends three publishes on a rebuild and publishes neither the pinned table nor a form the list leaves out', async () => {
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
  assert.deepStrictEqual(s.org.publishLog(first.mark), ['tables contoso_stats', 'app', 'app', 'tables contoso_item, contoso_stats + app'], 'the second app publish is the pin\u2019s');
  const rebuild = await s.build(spec);
  assert.deepStrictEqual(s.org.publishLog(rebuild.mark), ['tables contoso_item, contoso_stats', 'app', 'tables contoso_item + app']);
  assert.ok(!s.org.publishLog().some((line) => line.includes('contoso_hidden')), 'a table that is only pinned is not named by any request');
});

test('without --publish nothing is published ahead of the app but what the reconciles publish themselves', async () => {
  const s = scenario();
  await s.build(makeSpec(), { publish: false });
  const { mark } = await s.build(makeSpec(), { publish: false });
  assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_item', 'tables contoso_item', 'app']);
  assert.ok(!s.org.calls.slice(mark).some((c) => /^\/appmodulecomponents/.test(c.path) && /componenttype eq (59|60)\b/.test(c.path)), 'and the app\u2019s components are not read for it');
});
