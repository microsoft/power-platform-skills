'use strict';
// Which tables the build publishes before it publishes the app, over the REAL vendored SDK and a stateful fake Dataverse that also holds
// the app, its sitemap and its components (helpers/fake-app-build-org.js), so what is asserted is what reached the wire and what the
// platform is left holding unpublished.
//
// Dataverse leaves a saved form's label changes out of the published form when a PublishXml that names only the app runs before the
// table's own publish (measured; see publishReconciledTables in sdk-build.js). The one request before the app protects the tables whose
// forms, views and charts the app holds or is about to hold, and the ones the build itself changed. A table the app does not hold is not
// published by it: a table's publish ships everything saved on that table, whoever saved it, so naming a table the app never touches
// would release a maker's unfinished work there.
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
};
const PHASES = ['views', 'charts', 'forms', 'app-shell', 'pages', 'publish'];

// Item has a view and a form and is in the navigation; Stats has a chart; Nav is only in the navigation; Lookup is only the target of a lookup
// column on Item. All four tables exist already (`existing`), as in an environment the app is built over.
function makeSpec(extra = {}) {
  const table = (schemaName, columns = []) => ({
    schemaName, displayName: schemaName, existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
    columns: columns.map((name) => ({ schemaName: name, displayName: name, ...(name === 'contoso_kind' ? { type: 'Choice', options: ['First', 'Second'] } : { type: 'Text' }) })),
  });
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

function scenario() {
  const org = createFakeBuildOrg({ entities: ENTITIES, solution: { uniqueName: 'ContosoReview' }, heldTables: { contoso_item: 0, contoso_stats: 0 } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-scope-'));
  dirs.push(dir);
  const warnings = [];
  // Each build gets a fresh SDK over the same workspace folder, as every CLI run does.
  async function build(spec, { publish = true } = {}) {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
    await sdk.initWorkspace();
    const mark = org.calls.length;
    const warned = warnings.length;
    const outcome = await runSdkBuild(spec, {
      sdk, apply: true, publish, phases: PHASES, workspaceDir: dir, appDir: dir, env: org.origin,
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
  const unfinished = () => org.fake.unpublished().map((r) => r.name);
  return { org, build, makerSavesForm, unfinished, warnings };
}

const indexOfFirst = (calls, test) => calls.findIndex(test);
const isTablePublish = (table) => (c) => c.method === 'POST' && c.path === '/PublishXml' && c.body.ParameterXml.includes(`<entity>${table}</entity>`);
const isAppPublish = (c) => c.method === 'POST' && c.path === '/PublishXml' && /<appmodule>/.test(c.body.ParameterXml);

test('the spec these cases build is valid, so none of them rests on a spec the CLI would refuse', () => {
  const validated = validateAppSpec(makeSpec());
  assert.deepStrictEqual({ ok: validated.ok, errors: validated.errors }, { ok: true, errors: [] });
});

test('a first build publishes, in one request before the app is created, the tables the app is about to hold \u2014 and not a table the spec only declares', async () => {
  const s = scenario();
  await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(), [
    'tables contoso_item, contoso_stats, contoso_nav', // Item: view and form; Stats: chart; Nav: navigation. Lookup is only a lookup column's target.
    'app', // the create's own publish
    'tables contoso_item, contoso_stats + app', // phase 8
  ]);
  const before = indexOfFirst(s.org.calls, isTablePublish('contoso_item'));
  assert.ok(before > 0 && before < indexOfFirst(s.org.calls, (c) => c.method === 'POST' && /^\/appmodules(\?|$)/.test(c.path)), 'before the app is created');
});

test('an unchanged rebuild still sends three publishes, in the same order: the tables the app holds, the app, then everything', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const { mark } = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(mark), [
    'tables contoso_item, contoso_stats, contoso_nav', // Item is reconciled and in the navigation, Nav is in the navigation, Stats is held by the app through its chart
    'app', // the sitemap finalize
    'tables contoso_item + app',
  ]);
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

test('a form saved and not published on a table the app holds only through its navigation is published before the app is', async () => {
  const s = scenario();
  await s.build(makeSpec());
  await s.makerSavesForm('contoso_nav', 'Saved form on a navigation table');
  const { mark } = await s.build(makeSpec());
  assert.deepStrictEqual(s.unfinished(), []);
  const calls = s.org.calls.slice(mark);
  const published = indexOfFirst(calls, isTablePublish('contoso_nav'));
  assert.ok(published >= 0 && published < indexOfFirst(calls, isAppPublish), 'the table is published ahead of the app\u2019s first publish');
});

test('a table the spec only declares is published once the app holds a form of it: components already on the server count', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const formid = await s.makerSavesForm('contoso_lookup', 'Form a maker added to the app');
  s.org.addToApp('systemforms', formid);
  const { mark } = await s.build(makeSpec());
  assert.deepStrictEqual(s.org.publishLog(mark)[0], 'tables contoso_item, contoso_stats, contoso_lookup, contoso_nav', 'the first publish names it, in the spec\u2019s order');
  assert.deepStrictEqual(s.unfinished(), []);
});

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

test('when the request before the app is refused the build says plainly that the protection did not apply, names the chart description it wrote, and goes on', async () => {
  const s = scenario();
  await s.build(makeSpec());
  const changed = makeSpec();
  changed.charts[0].description = 'v2';
  s.org.refuseNextTablePublish(400);
  const { outcome, mark, warnings } = await s.build(changed);
  assert.strictEqual(outcome.ok, true, 'the build goes on');
  assert.deepStrictEqual(s.org.publishLog(mark), [
    'tables contoso_item, contoso_stats, contoso_nav', // refused
    'tables contoso_item', // what the build reconciled is published through the SDK, as before
    'app',
    'tables contoso_item, contoso_stats + app',
  ]);
  const line = warnings.find((w) => /could not publish/.test(w));
  assert.ok(line, warnings.join('\n'));
  assert.match(line, /contoso_stats/);
  assert.match(line, /the description of chart Stats By Kind/, 'what this build wrote is named');
  assert.match(line, /HTTP 400/, 'with the platform\u2019s refusal');
  assert.match(line, /did not apply/, 'the protection is said to have failed');
  assert.match(line, /not been measured/, 'what the order does to a chart description is not claimed');
  assert.ok(!/someone saved on (their|its) forms/.test(line.replace(/contoso_nav[^.]*\./, '')), 'the chart table is not presented as a form someone else saved');
});

test('without --publish nothing is published ahead of the app but what the reconciles publish themselves', async () => {
  const s = scenario();
  await s.build(makeSpec(), { publish: false });
  const { mark } = await s.build(makeSpec(), { publish: false });
  assert.deepStrictEqual(s.org.publishLog(mark), ['tables contoso_item', 'tables contoso_item', 'app']);
});
