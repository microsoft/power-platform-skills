'use strict';
// A generative page's connector and Custom API bindings, in an App Spec and through a download and a rebuild.
//
// A page holds two lists beside its data sources and its model, in its config.json: `connectorBindings` (each entry names a connection reference by its
// logical name) and `actionBindings` (each names a Custom API by its unique name). They used to be left out of a downloaded spec — the page folder kept
// them, the spec did not — so a rebuild into the environment the page came from kept them only because it sent none, and a rebuild into another
// environment deployed the page without them. The spec now states them (`pages[].connectorBindings`, `pages[].actionBindings`), a download writes what a page
// holds, a rebuild writes what a spec states, and the download says what it cannot bring to another environment.
//
// What this holds:
//   - the shape the spec accepts, and the one rule the download shares with the validator (a list of objects);
//   - what the download projects from a page's config.json, what it leaves out and says so, and that it never refuses over it;
//   - the build: a list the spec states is sent (create, navigation target, update), one it leaves out is not (the page keeps its own), `[]` clears;
//   - the round trip in the same environment, and the copy that goes to another one;
//   - what the download tells the operator, on stderr and in its JSON result.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateAppSpec, pageBindingsProblem, statedPageBindings, migrateAppSpec, PAGE_BINDINGS } = require('../lib/app-spec.js');
const { hydrateSpec } = require('../lib/hydrate-spec.js');
const { runDownload, parseDownloadedPages, pageBindingsReport, pageBindingsNote, main } = require('../download-model-app.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { classifyPages } = require('../lib/classify-changes.js');
const { buildManifest } = require('../lib/page-manifest.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');
const { currentReadSdk } = require('./helpers/app-membership-sdk.js');
const { fakeGenpage } = require('./helpers/fake-genpage.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const APP_UNIQUE = 'contoso_bindings';
const APP_UNIQUE_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const SITEMAP_ID = 'aaaaaaaa-0000-4000-8000-000000000003';
const SOLUTION_ID = 'aaaaaaaa-0000-4000-8000-000000000004';
const WEATHER_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const DETAIL_ID = 'bbbbbbbb-0000-4000-8000-000000000002';

// Bindings as /genpage writes them (references/connectors.md and references/custom-api.md). Each carries a property the plugin knows nothing about, which has to
// come back exactly: an entry is the runtime's, not the plugin's.
const WEATHER = { logicalName: 'contoso_msnweather', connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather', dataset: '', operations: ['CurrentWeather'], futureProperty: { kept: true } };
const SHAREPOINT = { logicalName: 'contoso_sharepoint', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', dataset: 'https://contoso.sharepoint.com/sites/x', tables: ['11111111-2222-3333-4444-555555555555'], tableDisplayNames: ['Pets'] };
const APPROVE = { name: 'contoso_ApproveOrder', isFunction: false, boundEntityLogicalName: 'contoso_item', displayName: 'Approve order', parameterKinds: { Comment: 'String' } };
const SUMMARY = { name: 'contoso_GetSummary', isFunction: true, displayName: 'Get summary', parameterKinds: { ItemId: 'Guid' } };
const clone = (value) => JSON.parse(JSON.stringify(value));

const tempDirs = [];
test.after(() => { for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true }); });
function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// What a download runs while it writes to stderr, kept: runDownload prints its notes as it goes.
async function withStderr(fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    return { value: await fn(), stderr: lines.join('') };
  } finally {
    process.stderr.write = write;
  }
}

// ── the spec states them ────────────────────────────────────────────────────────────────────────────────────────────────────────

// A valid two-page spec; `extra` is added to the first page.
function specWithPages(extra = {}) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoBindings', publisherPrefix: 'contoso' },
    app: { name: 'Bindings App' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [
      { key: 'weather', name: 'Weather', source: { kind: 'tsx', codeFile: 'weather.tsx' }, ...extra },
      { key: 'detail', name: 'Detail', source: { kind: 'tsx', codeFile: 'detail.tsx' } },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'weather', title: 'Weather' }, { page: 'detail', title: 'Detail' }, { entity: 'contoso_item', title: 'Items' }] }] }] },
  };
}

test('a spec page may state connectorBindings and actionBindings, every entry exactly as the page holds it — extra properties included', () => {
  const result = validateAppSpec(specWithPages({ connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE, SUMMARY] }));
  assert.ok(result.ok, JSON.stringify(result.errors));
  assert.deepStrictEqual(result.warnings, []);
  // An empty list is a statement too (a rebuild clears the page's list with it), so it is valid.
  assert.ok(validateAppSpec(specWithPages({ connectorBindings: [], actionBindings: [] })).ok);
  // And a page that states none is what every spec was: valid, and nothing to say.
  const plain = validateAppSpec(specWithPages());
  assert.ok(plain.ok, JSON.stringify(plain.errors));
  assert.deepStrictEqual(plain.warnings, []);
});

test('a list that is not a list, or an entry that is not an object, is an error naming the page and the place', () => {
  for (const [kind, value, expected] of [
    ['connectorBindings', 'contoso_msnweather', /pages\[0\]\.connectorBindings must be an array/],
    ['connectorBindings', { logicalName: 'contoso_msnweather' }, /pages\[0\]\.connectorBindings must be an array/],
    ['actionBindings', 'contoso_ApproveOrder', /pages\[0\]\.actionBindings must be an array/],
    ['connectorBindings', [WEATHER, null], /pages\[0\]\.connectorBindings\[1\] must be an object/],
    ['actionBindings', [APPROVE, undefined], /pages\[0\]\.actionBindings\[1\] must be an object/],
  ]) {
    const result = validateAppSpec(specWithPages({ [kind]: value }));
    assert.strictEqual(result.ok, false, `${kind}: ${JSON.stringify(value)}`);
    assert.ok(result.errors.some((e) => expected.test(e)), `${kind}: ${JSON.stringify(result.errors)}`);
  }
  // A string, a number, a list inside the list: none is an object either, and the validator says so as the download does.
  for (const entry of ['contoso_msnweather', 7, ['contoso_msnweather']]) {
    assert.strictEqual(pageBindingsProblem('connectorBindings', [entry]), 'connectorBindings[0] is not an object', JSON.stringify(entry));
    const result = validateAppSpec(specWithPages({ connectorBindings: [entry] }));
    assert.strictEqual(result.ok, false, JSON.stringify(entry));
    assert.ok(result.errors.includes("page 'weather': connectorBindings[0] is not an object"), JSON.stringify(result.errors));
  }
  // A hole is reported once, by the shape check that repairs it, and not again as an entry that is no object.
  const hole = validateAppSpec(specWithPages({ actionBindings: [APPROVE, null] }));
  assert.deepStrictEqual(hole.errors.filter((e) => /actionBindings/.test(e)), ['pages[0].actionBindings[1] must be an object']);
});

test('an entry with no logicalName (a connector binding) or name (a Custom API binding) is a warning, never an error — it is written as it is', () => {
  const result = validateAppSpec(specWithPages({ connectorBindings: [{ connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather' }, { logicalName: '  ' }], actionBindings: [{ displayName: 'x' }, APPROVE] }));
  assert.ok(result.ok, JSON.stringify(result.errors));
  assert.strictEqual(result.warnings.length, 3, JSON.stringify(result.warnings));
  assert.match(result.warnings[0], /page 'weather': connectorBindings\[0\] has no logicalName/);
  assert.match(result.warnings[1], /page 'weather': connectorBindings\[1\] has no logicalName/);
  assert.match(result.warnings[2], /page 'weather': actionBindings\[0\] has no name/);
  assert.ok(result.warnings.every((w) => /finds a binding by it/.test(w)), 'the warning says why a binding needs it');
});

test('the download and the validator agree on what a list of bindings can be: pageBindingsProblem is null exactly when validateAppSpec reports no error for it', () => {
  const values = [[], [WEATHER], [{}], [{ anything: 1 }], 'x', 5, {}, [null], [WEATHER, 3], [[WEATHER]], [true]];
  for (const kind of Object.keys(PAGE_BINDINGS)) {
    for (const value of values) {
      const accepted = validateAppSpec(specWithPages({ [kind]: value })).errors.filter((e) => e.includes(kind)).length === 0;
      assert.strictEqual(pageBindingsProblem(kind, value) === null, accepted, `${kind}: ${JSON.stringify(value)}`);
    }
  }
});

test('statedPageBindings answers the lists a page states — `[]` too — and nothing for a list it leaves out', () => {
  assert.deepStrictEqual(statedPageBindings({ key: 'a' }), {});
  assert.deepStrictEqual(statedPageBindings({ connectorBindings: [WEATHER] }), { connectorBindings: [WEATHER] });
  assert.deepStrictEqual(statedPageBindings({ connectorBindings: [], actionBindings: [APPROVE] }), { connectorBindings: [], actionBindings: [APPROVE] });
  assert.deepStrictEqual(statedPageBindings({ connectorBindings: 'x', actionBindings: null }), {}, 'what is no list is not stated');
  assert.deepStrictEqual(statedPageBindings(undefined), {});
});

test('a spec from before schemaVersion 2 keeps the lists its pages state when it is migrated', () => {
  const migrated = migrateAppSpec({
    solution: { uniqueName: 'ContosoBindings', publisherPrefix: 'contoso' },
    app: { name: 'Bindings App' },
    pages: [{ name: 'Weather', codeFile: 'weather.tsx', connectorBindings: [WEATHER], actionBindings: [] }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'Weather', title: 'Weather' }] }] }] },
  });
  assert.strictEqual(migrated.schemaVersion, 2);
  assert.deepStrictEqual(statedPageBindings(migrated.pages[0]), { connectorBindings: [WEATHER], actionBindings: [] });
});

// ── what a download projects from a page's config.json ────────────────────────────────────────────────────────────────────────

// A page tree as a download writes it: <root>/<pageId>/{page.tsx, config.json}.
function pageTree(configs) {
  const root = tmp('page-bindings-tree-');
  for (const [id, config] of Object.entries(configs)) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'page.tsx'), 'export default () => null;', 'utf8');
    if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.json'), typeof config === 'string' || Buffer.isBuffer(config) ? config : JSON.stringify(config));
  }
  return root;
}
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';

test('parseDownloadedPages carries a page\'s binding lists as its config.json holds them — entries, their order and their unknown properties unchanged', () => {
  const root = pageTree({
    [A]: { dataSources: ['contoso_item'], model: 'gpt-4.1', connectorBindings: [SHAREPOINT, WEATHER], actionBindings: [SUMMARY, APPROVE] },
    [B]: { dataSources: ['contoso_item'] },
  });
  const unkept = [];
  const pages = parseDownloadedPages(root, root, null, [], [], unkept);
  const byId = new Map(pages.map((p) => [p.pageId, p]));
  assert.deepStrictEqual(byId.get(A).connectorBindings, [SHAREPOINT, WEATHER], 'order and every property kept');
  assert.deepStrictEqual(byId.get(A).actionBindings, [SUMMARY, APPROVE]);
  assert.deepStrictEqual(byId.get(A).dataSources, ['contoso_item'], 'what a page already carried is carried as before');
  assert.strictEqual(byId.get(A).model, 'gpt-4.1');
  assert.ok(!('connectorBindings' in byId.get(B)) && !('actionBindings' in byId.get(B)), 'a page with none states none');
  assert.deepStrictEqual(unkept, []);
});

test('an empty list, null, or no key at all puts nothing in the page — a spec never states [] for a page that holds none, because a rebuild would read it as "clear them"', () => {
  const root = pageTree({
    [A]: { connectorBindings: [], actionBindings: [] },
    [B]: { connectorBindings: null, actionBindings: null },
    [C]: { dataSources: [] },
    [D]: undefined,
  });
  const unkept = [];
  const pages = parseDownloadedPages(root, root, null, [], [], unkept);
  assert.strictEqual(pages.length, 4);
  for (const page of pages) assert.ok(!('connectorBindings' in page) && !('actionBindings' in page), page.pageId);
  assert.deepStrictEqual(unkept, [], 'nothing is reported for any of these: a page holds no bindings in each of them');
});

test('a list the spec cannot state is left out WHOLE and recorded — the page\'s other list is still carried, and the download does not refuse', () => {
  const root = pageTree({
    [A]: { connectorBindings: 'contoso_msnweather', actionBindings: [APPROVE] },
    [B]: { connectorBindings: [WEATHER, 'oops'], actionBindings: { name: 'contoso_ApproveOrder' } },
    [C]: { connectorBindings: [WEATHER, [SHAREPOINT]] },
  });
  const unkept = [];
  const unreadable = [];
  const pages = parseDownloadedPages(root, root, null, unreadable, [], unkept);
  const byId = new Map(pages.map((p) => [p.pageId, p]));
  assert.deepStrictEqual(byId.get(A).actionBindings, [APPROVE], 'the page\'s good list is carried');
  assert.ok(!('connectorBindings' in byId.get(A)));
  // Whole: a spec that stated part of a list would have a rebuild REPLACE the page's list with that part.
  assert.ok(!('connectorBindings' in byId.get(B)) && !('actionBindings' in byId.get(B)));
  assert.ok(!('connectorBindings' in byId.get(C)));
  assert.deepStrictEqual(unkept.map((u) => [u.pageId, u.field, u.reason]), [
    [A, 'connectorBindings', 'connectorBindings is present but is not an array'],
    [B, 'connectorBindings', 'connectorBindings[1] is not an object'],
    [B, 'actionBindings', 'actionBindings is present but is not an array'],
    [C, 'connectorBindings', 'connectorBindings[1] is not an object'],
  ]);
  assert.deepStrictEqual(unreadable, [], 'a list that cannot be stated is not an unreadable config: the page\'s data sources are known');
});

test('a BOM-prefixed config.json keeps its binding lists, as it keeps its data sources', () => {
  const root = pageTree({ [A]: Buffer.from(`\uFEFF${JSON.stringify({ dataSources: ['contoso_item'], connectorBindings: [WEATHER] })}`, 'utf8') });
  const [page] = parseDownloadedPages(root, root, null, [], [], []);
  assert.deepStrictEqual(page.connectorBindings, [WEATHER]);
});

test('a download without the collector of unstated lists still projects (the argument is optional, as the other two are)', () => {
  const root = pageTree({ [A]: { connectorBindings: 'x', actionBindings: [APPROVE] } });
  const [page] = parseDownloadedPages(root, root, null);
  assert.deepStrictEqual(page.actionBindings, [APPROVE]);
});

// ── what the spec says of a page it was downloaded from ───────────────────────────────────────────────────────────────────────

// hydrateSpec with the least it needs: one entity, an app that navigates to the pages.
async function hydrated(pages) {
  return hydrateSpec({
    app: async () => ({ name: 'Bindings App', uniquename: APP_UNIQUE, description: '', siteMap: { areas: [{ title: 'Main', groups: [{ title: 'Pages', subAreas: pages.map((p) => ({ type: 'GenPage', genPageId: p.pageId, title: p.name })) }] }] } }),
    pages: async () => pages,
    entities: async () => [],
    webResources: async () => [],
    solution: async () => ({ uniqueName: 'ContosoBindings', publisherPrefix: 'contoso' }),
    dashboards: async () => [],
  });
}

test('hydrateSpec writes the binding lists a page holds, in the keyed and the legacy page shape, and leaves out an empty one', async () => {
  const base = { codeFile: 'pages/p/page.tsx', prompt: undefined };
  const keyed = await hydrated([
    { ...base, pageId: A, key: 'weather', name: 'Weather', dataSources: [], connectorBindings: [WEATHER], actionBindings: [APPROVE] },
    { ...base, pageId: B, key: 'detail', name: 'Detail', dataSources: [], connectorBindings: [], actionBindings: [] },
  ]);
  const [weather, detail] = keyed.pages;
  assert.deepStrictEqual([weather.connectorBindings, weather.actionBindings], [[WEATHER], [APPROVE]]);
  assert.ok(!('connectorBindings' in detail) && !('actionBindings' in detail));
  // The order a spec lists a page's fields in is fixed, so two downloads of one app match byte for byte.
  assert.deepStrictEqual(Object.keys(weather), ['key', 'name', 'pageId', 'connectorBindings', 'actionBindings', 'source']);

  const legacy = await hydrated([{ ...base, pageId: A, name: 'Weather', dataSources: [], connectorBindings: [WEATHER] }]);
  assert.strictEqual(legacy.schemaVersion, undefined, 'a page with no key makes the legacy shape');
  assert.deepStrictEqual(legacy.pages[0].connectorBindings, [WEATHER]);
});

// ── what the download tells the operator ──────────────────────────────────────────────────────────────────────────────────────

test('pageBindingsReport names, once and in order, what the target environment must have, and is null for pages that hold nothing', () => {
  const pages = [
    { pageId: A, key: 'weather', name: 'Weather', connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE, SUMMARY, APPROVE] },
    { pageId: B, key: 'detail', name: 'Detail', connectorBindings: [{ ...WEATHER }] },
    { pageId: C, key: 'plain', name: 'Plain' },
  ];
  const report = pageBindingsReport(pages, []);
  assert.deepStrictEqual(report.pages, [
    { key: 'weather', name: 'Weather', connectorBindings: ['contoso_msnweather', 'contoso_sharepoint'], actionBindings: ['contoso_ApproveOrder', 'contoso_GetSummary'] },
    { key: 'detail', name: 'Detail', connectorBindings: ['contoso_msnweather'] },
  ]);
  assert.deepStrictEqual(report.neededInTarget, {
    connectionReferences: ['contoso_msnweather', 'contoso_sharepoint'],
    customApis: ['contoso_ApproveOrder', 'contoso_GetSummary'],
    // Only the binding that points at a dataset or tables of the service: a weather call names no resource of its own.
    serviceResources: ['contoso_sharepoint'],
  });
  assert.ok(!('notCarried' in report));
  assert.match(report.note, /cannot create what they name/);
  assert.strictEqual(pageBindingsReport([{ pageId: C, key: 'plain', name: 'Plain' }], []), null);
  assert.strictEqual(pageBindingsReport([], []), null);
  assert.strictEqual(pageBindingsReport(undefined, undefined), null);
});

test('pageBindingsReport lists an entry that has no name as such — a page that holds a binding never reads as one that holds none', () => {
  const report = pageBindingsReport([{ pageId: A, key: 'a', name: 'A', connectorBindings: [{ connectorId: 'x' }], actionBindings: [{ displayName: 'y' }, APPROVE] }], []);
  assert.deepStrictEqual(report.pages[0].connectorBindings, ['(no logicalName)']);
  assert.deepStrictEqual(report.pages[0].actionBindings, ['(no name)', 'contoso_ApproveOrder']);
  assert.deepStrictEqual(report.neededInTarget, { customApis: ['contoso_ApproveOrder'] }, 'an entry with no name names nothing the target could be missing');
});

test('pageBindingsReport reports a list the spec could not state, by the page\'s name and key', () => {
  const pages = [{ pageId: A, key: 'weather', name: 'Weather' }, { pageId: B, key: 'detail', name: 'Detail', actionBindings: [APPROVE] }];
  const report = pageBindingsReport(pages, [{ pageId: A.toUpperCase(), field: 'connectorBindings', reason: 'connectorBindings is present but is not an array' }]);
  assert.deepStrictEqual(report.notCarried, [{ key: 'weather', name: 'Weather', field: 'connectorBindings', reason: 'connectorBindings is present but is not an array' }]);
  assert.deepStrictEqual(report.pages.map((p) => p.key), ['detail']);
  // Only a list left out, and no page that holds one: there is still something to say.
  const onlyLost = pageBindingsReport([{ pageId: A, key: 'weather', name: 'Weather' }], [{ pageId: A, field: 'actionBindings', reason: 'actionBindings[0] is not an object' }]);
  assert.deepStrictEqual(onlyLost.pages, []);
  assert.deepStrictEqual(onlyLost.neededInTarget, {});
});

test('pageBindingsNote says what a rebuild into another environment cannot bring, names the scripts that make each piece, and is silent when there is nothing to say', () => {
  const report = pageBindingsReport([{ pageId: A, key: 'weather', name: 'Weather', connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE] }], []);
  const text = pageBindingsNote(report);
  assert.match(text, /^NOTE: 1 page\(s\) hold connector or Custom API bindings, and the spec states them \(pages\[\]\.connectorBindings, pages\[\]\.actionBindings\)/);
  assert.match(text, /Rebuilding into THIS environment keeps them working\. Rebuilding into a DIFFERENT environment writes them, but cannot bring what they name/);
  assert.match(text, /connection reference\(s\) contoso_msnweather, contoso_sharepoint, and the connection each one goes through/);
  assert.match(text, /create-connection-reference\.js/);
  assert.match(text, /add-page-to-solution\.js --connection-refs, then solution-settings\.js/);
  assert.match(text, /Custom API\(s\) contoso_ApproveOrder: a Custom API is a solution component, not an App Spec item/);
  assert.match(text, /list-custom-apis\.js/);
  assert.match(text, /what the connector bindings of contoso_sharepoint point at inside the service/);
  assert.match(text, /Weather \[weather\] — connectorBindings: contoso_msnweather, contoso_sharepoint; actionBindings: contoso_ApproveOrder/);
  assert.ok(!/WARNING/.test(text), 'nothing was left out');
  assert.strictEqual(pageBindingsNote(null), '');

  // A page with a connector binding and no Custom API says nothing of Custom APIs, and the other way round.
  const connectorOnly = pageBindingsNote(pageBindingsReport([{ pageId: A, key: 'w', name: 'W', connectorBindings: [WEATHER] }], []));
  assert.ok(/connection reference\(s\)/.test(connectorOnly) && !/Custom API\(s\)/.test(connectorOnly) && !/inside the service/.test(connectorOnly), connectorOnly);
  const apiOnly = pageBindingsNote(pageBindingsReport([{ pageId: A, key: 'w', name: 'W', actionBindings: [APPROVE] }], []));
  assert.ok(/Custom API\(s\)/.test(apiOnly) && !/connection reference\(s\)/.test(apiOnly), apiOnly);

  const lost = pageBindingsNote(pageBindingsReport([{ pageId: A, key: 'weather', name: 'Weather' }], [{ pageId: A, field: 'connectorBindings', reason: 'connectorBindings is present but is not an array' }]));
  assert.match(lost, /^WARNING: 1 list\(s\) of connector or Custom API bindings are NOT in the spec/);
  assert.match(lost, /"Weather" \(connectorBindings is present but is not an array\)/);
  assert.match(lost, /Rebuilding into THIS environment leaves such a page's bindings as they are\. Rebuilding into a DIFFERENT environment will not carry them — bind them there with \/genpage/);
  assert.ok(!/^NOTE/.test(lost), 'no page holds a binding the spec states, so there is no note about them');
});

// ── a download, end to end over the stand-in SDK ──────────────────────────────────────────────────────────────────────────────

// What one app of two pages looks like to a download: the navigation names both, and the stand-in SDK answers the reads runDownload makes.
function downloadFixture(pages) {
  const sitemapXml = `<SiteMap><Area><Group>${pages.map((p) => `<SubArea GenPageId="${p.pageId}" Title="${p.title}"/>`).join('')}<SubArea Entity="contoso_item"/></Group></Area></SiteMap>`;
  const app = {
    name: 'Bindings App', uniquename: APP_UNIQUE, description: '',
    siteMap: { areas: [{ title: 'Main', groups: [{ title: 'Pages', subAreas: [
      ...pages.map((p) => ({ type: 'GenPage', genPageId: p.pageId, title: p.title })),
      { type: 'Entity', entity: 'contoso_item' },
    ] }] }] },
  };
  const { sdk } = makeSimpleMockSdk();
  const fetchArtifact = sdk.fetchArtifact;
  sdk.fetchArtifact = async (kind, id) => {
    const artifact = await fetchArtifact(kind, id);
    return kind === 'app' ? Object.assign(artifact, clone(app)) : artifact;
  };
  sdk.findArtifact = async (kind) => (kind === 'app' ? APP_ID : null);
  sdk.listArtifacts = async (kind) => (kind === 'app' ? [{ id: APP_ID, isDirty: false }] : []);
  sdk.findTables = async () => [{ logicalName: 'contoso_item', entitySetName: 'contoso_items' }];
  sdk.fetchEntityMetadata = async (logical) => ({ logicalName: logical, schemaName: logical, displayName: 'Item', primaryNameAttribute: 'contoso_name', entitySetName: 'contoso_items', attributes: [], relationships: [] });
  sdk.dataverse = { get: async () => ({ status: 200, body: { value: [] } }) };
  const manifest = buildManifest({ pages: pages.map((p) => ({ key: p.key, name: p.name })) }, new Map(pages.map((p) => [p.key, p.pageId])));
  let manifestContent = Buffer.from(JSON.stringify(manifest), 'utf8').toString('base64');
  sdk.queryRecords = async (logical, opts = {}) => {
    if (logical === 'appmodule') return [{ appmoduleid: APP_ID, appmoduleidunique: APP_UNIQUE_ID, uniquename: APP_UNIQUE }];
    if (logical === 'appmodulecomponent') return /componenttype eq 62/.test(opts.filter || '') ? [{ objectid: SITEMAP_ID, componenttype: 62 }] : [];
    if (logical === 'sitemap') return [{ sitemapid: SITEMAP_ID, sitemapxml: sitemapXml }];
    if (logical === 'webresource') return /_pagemanifest'/.test(opts.filter || '') ? [{ webresourceid: 'manifest', content: manifestContent }] : [];
    if (logical === 'solutioncomponent') return [{ _solutionid_value: SOLUTION_ID }];
    if (logical === 'solution') return [{ solutionid: SOLUTION_ID, uniquename: 'ContosoBindings', ismanaged: false }];
    return [];
  };
  sdk.updateWebResource = async (id, value) => { manifestContent = Buffer.from(value.content, 'utf8').toString('base64'); };
  return { sdk, readSdk: () => currentReadSdk(sdk, { appId: APP_ID, layerId: APP_UNIQUE_ID, sitemapXml }) };
}

const WEATHER_SOURCE = 'export default function Weather() { return null; }\r\n';
const DETAIL_SOURCE = 'export default function Detail() { return null; }\r\n';
const environmentPages = () => [
  { pageId: WEATHER_ID, key: 'weather', title: 'Weather navigation', name: 'Weather', source: WEATHER_SOURCE, dataSources: ['contoso_item'], model: 'gpt-4.1', connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE, SUMMARY] },
  { pageId: DETAIL_ID, key: 'detail', title: 'Detail navigation', name: 'Item Detail', source: DETAIL_SOURCE, dataSources: ['contoso_item'] },
];
const livePages = (pages) => pages.map(({ pageId, name, source, dataSources, model, connectorBindings, actionBindings }) => ({ pageId, name, source, dataSources, model, connectorBindings, actionBindings }));

test('a download states the bindings a page holds in the spec, the spec validates, and the page folder and the spec say the same', async () => {
  const outDir = tmp('page-bindings-download-');
  const pages = environmentPages();
  const { readSdk } = downloadFixture(pages);
  const genpage = fakeGenpage({ pages: livePages(pages) });
  const { value: result, stderr } = await withStderr(() => runDownload({ sdk: readSdk(), genpage, outDir, appId: APP_ID, appUnique: APP_UNIQUE }));
  assert.ok(result.ok, JSON.stringify(result));
  const spec = JSON.parse(JSON.stringify(result.spec));
  const validation = validateAppSpec(spec);
  assert.ok(validation.ok, validation.errors.join('; '));
  const weather = spec.pages.find((p) => p.key === 'weather');
  const detail = spec.pages.find((p) => p.key === 'detail');
  assert.deepStrictEqual(weather.connectorBindings, [WEATHER, SHAREPOINT]);
  assert.deepStrictEqual(weather.actionBindings, [APPROVE, SUMMARY]);
  assert.ok(!('connectorBindings' in detail) && !('actionBindings' in detail), 'a page with none states none');
  // The page folder still holds the raw config, which is what the spec projects.
  const config = JSON.parse(fs.readFileSync(path.join(outDir, 'pages', WEATHER_ID, 'config.json'), 'utf8'));
  assert.deepStrictEqual([config.connectorBindings, config.actionBindings], [weather.connectorBindings, weather.actionBindings]);

  // What it says: in the result, and on stderr.
  assert.deepStrictEqual(result.pageBindings.pages, [{ key: 'weather', name: 'Weather', connectorBindings: ['contoso_msnweather', 'contoso_sharepoint'], actionBindings: ['contoso_ApproveOrder', 'contoso_GetSummary'] }]);
  assert.deepStrictEqual(result.pageBindings.neededInTarget, { connectionReferences: ['contoso_msnweather', 'contoso_sharepoint'], customApis: ['contoso_ApproveOrder', 'contoso_GetSummary'], serviceResources: ['contoso_sharepoint'] });
  assert.match(stderr, /NOTE: 1 page\(s\) hold connector or Custom API bindings, and the spec states them/);
  assert.match(stderr, /Rebuilding into a DIFFERENT environment writes them, but cannot bring what they name/);
  assert.ok(!/WARNING: \d+ list\(s\) of connector/.test(stderr), 'nothing was left out');
});

test('an app whose pages hold no bindings downloads exactly as it did: no field in the spec, no note, nothing in the result', async () => {
  const outDir = tmp('page-bindings-none-');
  const pages = environmentPages().map(({ connectorBindings, actionBindings, ...rest }) => rest);
  const { readSdk } = downloadFixture(pages);
  const { value: result, stderr } = await withStderr(() => runDownload({ sdk: readSdk(), genpage: fakeGenpage({ pages: livePages(pages) }), outDir, appId: APP_ID, appUnique: APP_UNIQUE }));
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(result.spec.pages.every((p) => !('connectorBindings' in p) && !('actionBindings' in p)));
  assert.strictEqual('pageBindings' in result, false);
  assert.ok(!/bindings/i.test(stderr), `no word about bindings: ${stderr}`);
});

test('a page whose list the spec cannot state is downloaded without it, and the download says so — it is a note, not a refusal, with or without --allow-lossy-download', async () => {
  for (const allowLossy of [false, true]) {
    const pages = environmentPages();
    pages[0].connectorBindings = { logicalName: 'contoso_msnweather' };
    const outDir = tmp('page-bindings-lost-');
    const { readSdk } = downloadFixture(pages);
    const { value: result, stderr } = await withStderr(() => runDownload({ sdk: readSdk(), genpage: fakeGenpage({ pages: livePages(pages) }), outDir, appId: APP_ID, appUnique: APP_UNIQUE, allowLossy }));
    assert.ok(result.ok, `allowLossy ${allowLossy}: ${JSON.stringify(result)}`);
    const weather = result.spec.pages.find((p) => p.key === 'weather');
    assert.ok(!('connectorBindings' in weather), 'the list the spec cannot state is left out');
    assert.deepStrictEqual(weather.actionBindings, [APPROVE, SUMMARY], 'and the other list is still stated');
    assert.deepStrictEqual(result.pageBindings.notCarried, [{ key: 'weather', name: 'Weather', field: 'connectorBindings', reason: 'connectorBindings is present but is not an array' }]);
    assert.match(stderr, /WARNING: 1 list\(s\) of connector or Custom API bindings are NOT in the spec/);
    assert.match(stderr, /Rebuilding into THIS environment leaves such a page's bindings as they are/);
  }
});

test('main puts pageBindings in the JSON result, and leaves it out when there is none', async () => {
  const run = async (result) => {
    const outDir = tmp('page-bindings-main-');
    const results = [];
    await main({
      argv: ['--env', ENV, '--app', APP_UNIQUE, '--out', outDir],
      stderr: { write: () => {} },
      emitResult: (ok, payload) => results.push({ ok, payload }),
      preflightAuth: async () => ({ ok: true }),
      makeGenpageSdk: () => ({}),
      makeDownloadSdk: async () => ({ sdk: { queryRecords: async (_set, opts = {}) => (/uniquename eq/.test(opts.filter || '') ? [{ appmoduleid: APP_ID }] : [{ uniquename: APP_UNIQUE }]) }, cleanup() {} }),
      runDownload: async () => ({ ok: true, spec: { schemaVersion: 2, solution: { uniqueName: 'ContosoBindings', publisherPrefix: 'contoso' }, app: { name: 'Bindings App', uniqueName: APP_UNIQUE }, entities: [], pages: [], appShell: { areas: [] } }, pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [], dashboardWarnings: [], ...result }),
      validateAppSpec: () => ({ ok: true, warnings: [] }),
    });
    assert.strictEqual(results.length, 1);
    return results[0];
  };
  const report = pageBindingsReport([{ pageId: A, key: 'weather', name: 'Weather', connectorBindings: [WEATHER] }], []);
  const withReport = await run({ pageBindings: report });
  assert.strictEqual(withReport.ok, true);
  assert.deepStrictEqual(withReport.payload.pageBindings, report);
  const without = await run({});
  assert.strictEqual('pageBindings' in without.payload, false);
});

// ── the build ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PHASES = ['solution', 'data-model', 'app-shell', 'pages'];

// What a download wrote, rebuilt into the environment it came from: the page the SDK already holds is updated, never created.
async function downloadThenRebuild({ edit } = {}) {
  const appDir = tmp('page-bindings-roundtrip-');
  const pages = environmentPages();
  const { sdk, readSdk } = downloadFixture(pages);
  const genpage = fakeGenpage({ pages: livePages(pages) });
  const downloaded = await withStderr(() => runDownload({ sdk: readSdk(), genpage, outDir: appDir, appId: APP_ID, appUnique: APP_UNIQUE }));
  assert.ok(downloaded.value.ok, JSON.stringify(downloaded.value));
  const spec = JSON.parse(JSON.stringify(downloaded.value.spec));
  if (edit) edit(spec);
  assert.ok(validateAppSpec(spec).ok, validateAppSpec(spec).errors.join('; '));
  const before = genpage.of('update').length;
  const rebuilt = await runSdkBuild(spec, { sdk, genpage, appDir, env: ENV, apply: true, phases: PHASES });
  assert.ok(rebuilt.ok);
  assert.deepStrictEqual(rebuilt.created.pages, { weather: WEATHER_ID, detail: DETAIL_ID });
  const updates = genpage.of('update').slice(before);
  assert.strictEqual(updates.length, 2, 'one update per page');
  assert.strictEqual(genpage.of('create').length, 0, 'a downloaded page is updated, never created');
  const sentTo = (id) => updates.find((u) => u.args[0] === id).args[1];
  return { genpage, spec, sentTo, appDir };
}

test('a rebuild into the environment a spec was downloaded from sends the bindings the spec states — and none for a page that states none, which keeps its own', async () => {
  const { genpage, sentTo } = await downloadThenRebuild();
  const weather = sentTo(WEATHER_ID);
  assert.deepStrictEqual(weather.connectorBindings, [WEATHER, SHAREPOINT]);
  assert.deepStrictEqual(weather.actionBindings, [APPROVE, SUMMARY]);
  const detail = sentTo(DETAIL_ID);
  for (const key of ['connectorBindings', 'actionBindings']) assert.ok(!(key in detail), `${key} is not sent for a page that states none: it keeps its own`);
  // What the environment holds after the rebuild is what it held before.
  assert.deepStrictEqual(genpage.pages.get(WEATHER_ID).connectorBindings, [WEATHER, SHAREPOINT]);
  assert.deepStrictEqual(genpage.pages.get(WEATHER_ID).actionBindings, [APPROVE, SUMMARY]);
});

test('a spec edit to a page\'s binding lists is what the page holds after the rebuild: a changed list replaces, `[]` clears, and a list the spec no longer states is left as it is', async () => {
  const { genpage, spec, sentTo } = await downloadThenRebuild({
    edit: (spec) => {
      const weather = spec.pages.find((p) => p.key === 'weather');
      weather.connectorBindings = [WEATHER];
      weather.actionBindings = [];
      const detail = spec.pages.find((p) => p.key === 'detail');
      detail.actionBindings = [SUMMARY];
    },
  });
  assert.deepStrictEqual(sentTo(WEATHER_ID).connectorBindings, [WEATHER]);
  assert.deepStrictEqual(sentTo(WEATHER_ID).actionBindings, [], 'a stated empty list is sent: it clears the page\'s');
  assert.deepStrictEqual(genpage.pages.get(WEATHER_ID).connectorBindings, [WEATHER]);
  assert.deepStrictEqual(genpage.pages.get(WEATHER_ID).actionBindings, []);
  assert.deepStrictEqual(genpage.pages.get(DETAIL_ID).actionBindings, [SUMMARY], 'a page that held none now holds what the spec states');
  assert.ok(!('connectorBindings' in sentTo(DETAIL_ID)));
  assert.ok(spec.pages.length === 2);

  // A list the spec leaves out is not sent, so the page keeps what it holds.
  const kept = await downloadThenRebuild({ edit: (s) => { delete s.pages.find((p) => p.key === 'weather').connectorBindings; } });
  assert.ok(!('connectorBindings' in kept.sentTo(WEATHER_ID)));
  assert.deepStrictEqual(kept.genpage.pages.get(WEATHER_ID).connectorBindings, [WEATHER, SHAREPOINT]);
  assert.deepStrictEqual(kept.sentTo(WEATHER_ID).actionBindings, [APPROVE, SUMMARY], 'the other list is still sent');
});

// `--changed-only` applies a change fast only when it is provably one of its shapes; a page whose only change is its source is the one such shape. A change to a binding list is another thing, so the
// build takes the full way, which sends the lists as the spec states them.
test('--changed-only reads a change to a page\'s binding list as a structural change, so it takes a full build — a change to the source alone still goes the fast way', () => {
  const page = (extra = {}) => ({ key: 'weather', name: 'Weather', source: { kind: 'tsx', codeFile: 'weather.tsx' }, __contentSha: 'sha-1', ...extra });
  const prior = { pages: [page({ connectorBindings: [WEATHER] })] };
  const edited = classifyPages({ pages: [page({ connectorBindings: [WEATHER, SHAREPOINT] })] }, prior);
  assert.deepStrictEqual(edited.fast, []);
  assert.strictEqual(edited.full.length, 1);
  assert.match(edited.full[0], /pages: page 'weather' changed structurally/);
  const stated = classifyPages({ pages: [page({ connectorBindings: [WEATHER] })] }, { pages: [page()] });
  assert.strictEqual(stated.full.length, 1, 'a list the spec states for the first time is a change too');
  const sourceOnly = classifyPages({ pages: [page({ connectorBindings: [WEATHER], __contentSha: 'sha-2' })] }, prior);
  assert.deepStrictEqual(sourceOnly.full, []);
  assert.deepStrictEqual(sourceOnly.fast.map((f) => f.identity), ['weather']);
});

// A fresh environment: nothing but the app the build makes. The stand-in answers what the solution, data-model, app-shell and pages phases read and write for a spec whose
// navigation holds its pages and one table (a new app is created with its navigation minus the pages, and Dataverse refuses a navigation with nothing left).
function freshEnvironmentSdk() {
  let idc = 0;
  const store = {};
  const empty = '<SiteMap><Area><Group></Group></Area></SiteMap>';
  return {
    queryRecords: async (e, o) => {
      const filter = (o && o.filter) || '';
      if (e === 'appmodule') {
        const m = filter.match(/uniquename eq '([^']+)'/);
        return [{ appmoduleid: APP_ID, appmoduleidunique: APP_UNIQUE_ID, uniquename: m ? m[1] : undefined }];
      }
      if (e === 'appmodulecomponent') return [{ objectid: SITEMAP_ID, componenttype: 62 }];
      if (e === 'sitemap') return /sitemapnameunique eq/.test(filter) ? [{ sitemapid: 'sm-1' }] : [{ sitemapxml: empty }];
      if (e === 'solution' || e === 'webresource' || e === 'systemform') return [];
      if (e === 'savedquery') return [{ savedqueryid: 'defview-x', isdefault: true }];
      return [{ publisherid: 'pub-1' }];
    },
    findArtifact: async () => null,
    fetchArtifact: async (t, id) => { if (!store[`${t}:${id}`]) store[`${t}:${id}`] = { id, siteMap: { areas: [] } }; return store[`${t}:${id}`]; },
    createPublisher: async () => ({ id: 'pub-new' }),
    createSolution: async () => ({ id: 'sol-1' }),
    findTables: async () => [],
    findColumns: async () => [],
    fetchEntityMetadata: async (logical) => ({ logicalName: logical, entitySetName: `${logical}s`, attributes: [], relationships: [] }),
    createTable: async (o) => ({ logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }),
    createColumn: async (e, o) => ({ logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }),
    createRelationship: async (o) => ({ schemaName: o.schemaName }),
    createWebResource: async (o) => ({ id: `wr-${++idc}`, name: o.name }),
    updateWebResource: async () => ({}),
    enrichDefaultViews: async () => ({ updated: [] }),
    createArtifact: (t, def) => { const id = `${t}-${++idc}`; store[`${t}:${id}`] = Object.assign({ id }, def); return JSON.parse(JSON.stringify(store[`${t}:${id}`])); },
    getArtifact: async (t, id) => { await Promise.resolve(); return store[`${t}:${id}`] || { id }; },
    addElement: async () => { await Promise.resolve(); return {}; },
    updateElement: async () => { await Promise.resolve(); return {}; },
    removeElement: async () => { await Promise.resolve(); return {}; },
    pushArtifact: async (t, id) => ({ type: t, id, saved: true, shipped: false, publish: { kind: 'notRequested' } }),
    addSolutionComponent: async () => {},
    publishArtifact: async (type, id) => ({ type, id, shipped: true, publish: { kind: 'verified' } }),
    dataverse: { get: async () => ({ status: 404, body: null }) },
  };
}

// The spec of a copy that goes to another environment: what a download wrote, without the ids of the pages of the environment it came from (they belong to it).
async function portableCopy() {
  const outDir = tmp('page-bindings-portable-');
  const pages = environmentPages();
  const { readSdk } = downloadFixture(pages);
  const downloaded = await withStderr(() => runDownload({ sdk: readSdk(), genpage: fakeGenpage({ pages: livePages(pages) }), outDir, appId: APP_ID, appUnique: APP_UNIQUE }));
  assert.ok(downloaded.value.ok, JSON.stringify(downloaded.value));
  const spec = JSON.parse(JSON.stringify(downloaded.value.spec));
  for (const page of spec.pages) delete page.pageId;
  // Weather navigates to Detail, so the build makes Detail first — as a target, in one write — and Weather after it.
  const weather = spec.pages.find((p) => p.key === 'weather');
  weather.navigatesTo = [{ targetKey: 'detail' }];
  fs.writeFileSync(path.join(outDir, weather.source.codeFile), 'export default function Weather() { Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_detail", data: {} }); return null; }\r\n');
  return { spec, outDir };
}

test('a copy of a downloaded spec built into ANOTHER environment writes the bindings onto the pages it creates', async () => {
  const { spec, outDir } = await portableCopy();
  const genpage = fakeGenpage();
  const rebuilt = await runSdkBuild(spec, { sdk: freshEnvironmentSdk(), genpage, appDir: outDir, env: 'https://fabrikam.crm.dynamics.com', apply: true, phases: PHASES });
  assert.ok(rebuilt.ok);
  assert.strictEqual(genpage.of('update').length, 0, 'nothing existed there: every page is created');
  const byName = new Map(genpage.of('create').map((c) => [c.args[0].name, c.args[0]]));
  assert.deepStrictEqual([...byName.keys()].sort(), ['Item Detail', 'Weather']);
  assert.deepStrictEqual(byName.get('Weather').connectorBindings, [WEATHER, SHAREPOINT]);
  assert.deepStrictEqual(byName.get('Weather').actionBindings, [APPROVE, SUMMARY]);
  for (const key of ['connectorBindings', 'actionBindings']) assert.ok(!(key in byName.get('Item Detail')), `${key} is not sent for the page that states none`);
  const held = [...genpage.pages.values()].find((page) => page.name === 'Weather');
  assert.deepStrictEqual([held.connectorBindings, held.actionBindings], [[WEATHER, SHAREPOINT], [APPROVE, SUMMARY]], 'the environment holds what the spec states');
});

test('a navigation target that states bindings is created with them — the create that makes it is its only write, so it has to carry them', async () => {
  const { spec, outDir } = await portableCopy();
  // The other way round: Detail, the target, states the bindings, and Weather states none.
  const detail = spec.pages.find((p) => p.key === 'detail');
  const weather = spec.pages.find((p) => p.key === 'weather');
  detail.connectorBindings = weather.connectorBindings;
  detail.actionBindings = weather.actionBindings;
  delete weather.connectorBindings;
  delete weather.actionBindings;
  const genpage = fakeGenpage();
  const rebuilt = await runSdkBuild(spec, { sdk: freshEnvironmentSdk(), genpage, appDir: outDir, env: 'https://fabrikam.crm.dynamics.com', apply: true, phases: PHASES });
  assert.ok(rebuilt.ok);
  assert.strictEqual(genpage.of('update').length, 0, 'the target is not written again: its create held everything');
  const byName = new Map(genpage.of('create').map((c) => [c.args[0].name, c.args[0]]));
  assert.deepStrictEqual(byName.get('Item Detail').connectorBindings, [WEATHER, SHAREPOINT]);
  assert.deepStrictEqual(byName.get('Item Detail').actionBindings, [APPROVE, SUMMARY]);
  for (const key of ['connectorBindings', 'actionBindings']) assert.ok(!(key in byName.get('Weather')), `${key} is not sent for the page that states none`);
});
