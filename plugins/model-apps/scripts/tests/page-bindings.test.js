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
const { statableBindings } = require('../lib/page-bindings.js');
const { hydrateSpec } = require('../lib/hydrate-spec.js');
const { runDownload, parseDownloadedPages, pageBindingsReport, pageBindingsNote, main } = require('../download-model-app.js');
const { runSdkBuild, BuildHalt } = require('../lib/sdk-build.js');
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

// Bindings as /genpage writes them (references/connectors.md and references/custom-api.md): only the properties an App Spec states. What a page may hold beyond them (a connection id,
// a credential, a property the plugin does not know) never reaches a spec, and the tests of that put it on the page side of a fixture (`WEATHER_WITH_EXTRAS`).
const WEATHER = { logicalName: 'contoso_msnweather', connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather', dataset: '', operations: ['CurrentWeather'] };
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

test('a spec page may state connectorBindings and actionBindings: each entry by the properties an App Spec states', () => {
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

test('what a download carries of a list always validates, and the validator refuses what the download would leave out of it — the rules they share are pageBindingsProblem and statableBindings', () => {
  const values = [[], [WEATHER], [{}], [{ anything: 1 }], [{ ...WEATHER, connectionId: 'x' }], 'x', 5, {}, [null], [WEATHER, 3], [[WEATHER]], [true]];
  for (const kind of Object.keys(PAGE_BINDINGS)) {
    const errorsOf = (list) => validateAppSpec(specWithPages({ [kind]: list })).errors.filter((e) => e.includes(kind));
    for (const value of values) {
      const container = pageBindingsProblem(kind, value);
      if (container) {
        assert.ok(errorsOf(value).length > 0, `${kind}: the validator refuses ${JSON.stringify(value)}: ${container}`);
        continue;
      }
      const { stated, leftOut } = statableBindings(kind, value);
      assert.deepStrictEqual(errorsOf(stated), [], `${kind}: what a download carries of ${JSON.stringify(value)} validates`);
      assert.strictEqual(errorsOf(value).length > 0, leftOut.length > 0, `${kind}: ${JSON.stringify(value)} is refused exactly when something of it would be left out`);
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

test('parseDownloadedPages carries a page\'s binding lists as its config.json holds them — entries, their order and every property a spec states unchanged', () => {
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

// ── a spec states a binding's identity and shape, never a credential ─────────────────────────────────────────────────────────
// The spec is the artifact that is committed, reviewed and shared; the page's own config.json is the environment's. A binding a page holds can carry more than the runtime reads — a connection id of the
// environment it was made in, a credential someone put in a connectors.json, a property a later runtime adds — and none of it is the spec's to carry. So the spec states a binding by an ALLOWLIST of
// properties, the ones references/connectors.md and references/custom-api.md document, each with the kind of value it holds; anything else is left out and the download says which, by name.

// Synthetic values, none a real credential. Each is looked for in everything a download writes or prints.
const SECRET = {
  token: 'SYNTHETIC_TEST_ACCESS_TOKEN',
  clientSecret: 'SYNTHETIC_TEST_SECRET',
  password: 'SYNTHETIC_TEST_PASSWORD',
  signature: 'SYNTHETIC_TEST_SIGNATURE',
  connection: 'env-local-connection-placeholder',
};
const leaked = (text) => Object.values(SECRET).filter((value) => String(text).includes(value));

// The page's side of a binding: what it may hold beyond what a spec states.
const WEATHER_WITH_EXTRAS = { ...WEATHER, connectionId: SECRET.connection, credentials: { accessToken: SECRET.token, clientSecret: SECRET.clientSecret }, futureProperty: { kept: true } };
const SHAREPOINT_WITH_EXTRAS = { ...SHAREPOINT, apiKey: SECRET.clientSecret };
const APPROVE_WITH_EXTRAS = { ...APPROVE, headers: { Authorization: `Bearer ${SECRET.token}` } };

// A download of the app whose first page holds the given lists.
async function downloadPagesHolding({ connectorBindings, actionBindings, allowLossy } = {}) {
  const pages = environmentPages();
  if (connectorBindings !== undefined) pages[0].connectorBindings = connectorBindings;
  if (actionBindings !== undefined) pages[0].actionBindings = actionBindings;
  const outDir = tmp('page-bindings-secret-');
  const { readSdk } = downloadFixture(pages);
  const { value: result, stderr } = await withStderr(() => runDownload({ sdk: readSdk(), genpage: fakeGenpage({ pages: livePages(pages) }), outDir, appId: APP_ID, appUnique: APP_UNIQUE, allowLossy }));
  assert.ok(result.ok, JSON.stringify(result));
  return { result, stderr, outDir, weather: result.spec.pages.find((p) => p.key === 'weather') };
}

test('a download states a binding by its identity and shape only: a credential, a connection id and a property no spec states stay out of the spec, the result and stderr — and the download names them', async () => {
  const { result, stderr, outDir, weather } = await downloadPagesHolding({ connectorBindings: [WEATHER_WITH_EXTRAS, SHAREPOINT_WITH_EXTRAS], actionBindings: [APPROVE_WITH_EXTRAS, SUMMARY] });
  assert.deepStrictEqual(weather.connectorBindings, [WEATHER, SHAREPOINT], 'exactly the properties a spec states, in the page\'s order');
  assert.deepStrictEqual(weather.actionBindings, [APPROVE, SUMMARY]);
  assert.ok(validateAppSpec(JSON.parse(JSON.stringify(result.spec))).ok, 'and the spec validates');
  assert.deepStrictEqual(leaked(JSON.stringify(result)), [], 'no value of a left-out property is in the spec, the pages or the report');
  assert.deepStrictEqual(leaked(stderr), [], 'nor on stderr');

  // What it left out is said by the property's NAME: the page, the list, the entry, the entry's own name, and why.
  assert.deepStrictEqual(result.pageBindings.propertiesLeftOut, [
    { key: 'weather', name: 'Weather', field: 'actionBindings', entry: 0, binding: 'contoso_ApproveOrder', properties: [{ property: 'headers', why: 'not-stated' }] },
    { key: 'weather', name: 'Weather', field: 'connectorBindings', entry: 0, binding: 'contoso_msnweather', properties: [{ property: 'connectionId', why: 'not-stated' }, { property: 'credentials', why: 'not-stated' }, { property: 'futureProperty', why: 'not-stated' }] },
    { key: 'weather', name: 'Weather', field: 'connectorBindings', entry: 1, binding: 'contoso_sharepoint', properties: [{ property: 'apiKey', why: 'not-stated' }] },
  ]);
  assert.match(stderr, /WARNING: 3 binding\(s\) hold properties that are NOT in the spec/);
  assert.match(stderr, /a spec states only what identifies a binding and shapes its calls \(connectorBindings: logicalName, connectorId, dataset, tables, tableDisplayNames, operations; actionBindings: name, isFunction, boundEntityLogicalName, displayName, parameterKinds\)/);
  assert.match(stderr, /Weather connectorBindings\[0\] \(contoso_msnweather\): connectionId, credentials, futureProperty/);
  assert.match(stderr, /the values are never printed/);
  // A page whose bindings are all stated is still a page that holds bindings: the note about the target environment is there as before.
  assert.match(stderr, /NOTE: 1 page\(s\) hold connector or Custom API bindings/);

  // The page folder is the page as the environment holds it. It is not rewritten, so it still holds what the spec does not — and the download says that too.
  const sidecar = JSON.parse(fs.readFileSync(path.join(outDir, 'pages', WEATHER_ID, 'config.json'), 'utf8'));
  assert.strictEqual(sidecar.connectorBindings[0].connectionId, SECRET.connection);
  assert.match(stderr, /still in the page folder's own config\.json \(pages\/<page id>\/config\.json\)/);
});

test('a property a spec does state is left out too when its value is not what the property holds — a credential cannot ride in a list, a map or a flag', async () => {
  const { result, stderr, weather } = await downloadPagesHolding({
    connectorBindings: [{
      ...WEATHER,
      operations: [{ name: 'CurrentWeather', credentials: { accessToken: SECRET.token } }],
      tables: ['11111111-2222-3333-4444-555555555555', { id: 'x', clientSecret: SECRET.clientSecret }],
      tableDisplayNames: 'Pets',
    }],
    actionBindings: [{
      ...APPROVE,
      isFunction: 'false',
      displayName: { en: SECRET.password },
      parameterKinds: { Comment: 'String', Authorization: { scheme: 'Bearer', value: SECRET.token }, Note: `Bearer ${SECRET.token}` },
    }],
  });
  assert.deepStrictEqual(weather.connectorBindings, [{ logicalName: WEATHER.logicalName, connectorId: WEATHER.connectorId, dataset: '' }]);
  assert.deepStrictEqual(weather.actionBindings, [{ name: APPROVE.name, boundEntityLogicalName: APPROVE.boundEntityLogicalName }]);
  assert.deepStrictEqual(result.pageBindings.propertiesLeftOut.map((l) => [l.field, l.entry, l.properties]), [
    ['actionBindings', 0, [{ property: 'displayName', why: 'not-text' }, { property: 'isFunction', why: 'not-boolean' }, { property: 'parameterKinds', why: 'not-parameter-kinds' }]],
    ['connectorBindings', 0, [{ property: 'operations', why: 'not-text-list' }, { property: 'tableDisplayNames', why: 'not-text-list' }, { property: 'tables', why: 'not-text-list' }]],
  ]);
  assert.deepStrictEqual(leaked(JSON.stringify(result) + stderr), []);
  assert.match(stderr, /operations \(must be a list of texts\)/);
  assert.match(stderr, /isFunction \(must be true or false\)/);
});

test('a text that holds a credential is left out whatever its property: a password in a URL, a signature in a query, a connection string, a bearer token', async () => {
  const { result, stderr, weather } = await downloadPagesHolding({
    connectorBindings: [{
      ...SHAREPOINT,
      dataset: `https://admin:${SECRET.password}@contoso.sharepoint.com/sites/x`,
      tableDisplayNames: [`Pets; Password=${SECRET.password}`, 'Owners'],
      operations: [`GetItems?sig=${SECRET.signature}`],
    }],
    actionBindings: [{ ...APPROVE, displayName: `Bearer ${SECRET.token}ABCDEFGH` }],
  });
  assert.deepStrictEqual(weather.connectorBindings, [{ logicalName: SHAREPOINT.logicalName, connectorId: SHAREPOINT.connectorId, tables: SHAREPOINT.tables }]);
  assert.ok(!('displayName' in weather.actionBindings[0]));
  assert.deepStrictEqual(result.pageBindings.propertiesLeftOut.flatMap((l) => l.properties), [
    { property: 'displayName', why: 'credential-shaped' },
    { property: 'dataset', why: 'credential-shaped' },
    { property: 'operations', why: 'credential-shaped' },
    { property: 'tableDisplayNames', why: 'credential-shaped' },
  ]);
  assert.deepStrictEqual(leaked(JSON.stringify(result) + stderr), []);
});

test('a property whose NAME is not a plain identifier is reported without its name — a name can carry a value too', async () => {
  const odd = `Authorization: Bearer ${SECRET.token}`;
  const { result, stderr } = await downloadPagesHolding({ connectorBindings: [{ ...WEATHER, [odd]: true, [`sk-live-${SECRET.clientSecret}`]: 1 }] });
  assert.deepStrictEqual(result.pageBindings.propertiesLeftOut[0].properties, [
    { property: '(a property with an unusual name)', why: 'not-stated' },
    { property: '(a property with an unusual name)', why: 'not-stated' },
  ]);
  assert.deepStrictEqual(leaked(JSON.stringify(result) + stderr), []);
});

test('an entry in which a spec can state nothing leaves its whole list out — a spec that stated the others would have a rebuild drop that entry from the page', async () => {
  const { result, weather } = await downloadPagesHolding({ connectorBindings: [WEATHER, { credentials: { accessToken: SECRET.token } }] });
  assert.ok(!('connectorBindings' in weather));
  assert.deepStrictEqual(weather.actionBindings, [APPROVE, SUMMARY], 'the other list is still stated');
  assert.deepStrictEqual(result.pageBindings.notCarried, [{ key: 'weather', name: 'Weather', field: 'connectorBindings', reason: 'connectorBindings[1] holds nothing an App Spec states' }]);
  assert.deepStrictEqual(leaked(JSON.stringify(result)), []);
});

test('main writes an app-spec.json that holds none of it, and prints by name what it left out', async () => {
  const { result: downloaded } = await downloadPagesHolding({ connectorBindings: [WEATHER_WITH_EXTRAS], actionBindings: [APPROVE_WITH_EXTRAS] });
  const outDir = tmp('page-bindings-main-out-');
  const printed = [];
  await main({
    argv: ['--env', ENV, '--app', APP_UNIQUE, '--out', outDir],
    stderr: { write: () => {} },
    emitResult: (ok, payload) => printed.push({ ok, payload }),
    preflightAuth: async () => ({ ok: true }),
    makeGenpageSdk: () => ({}),
    makeDownloadSdk: async () => ({ sdk: { queryRecords: async (_set, opts = {}) => (/uniquename eq/.test(opts.filter || '') ? [{ appmoduleid: APP_ID }] : [{ uniquename: APP_UNIQUE }]) }, cleanup() {} }),
    runDownload: async () => downloaded,
  });
  assert.strictEqual(printed.length, 1);
  assert.strictEqual(printed[0].ok, true, JSON.stringify(printed[0].payload));
  const persisted = fs.readFileSync(path.join(outDir, 'app-spec.json'), 'utf8');
  assert.deepStrictEqual(leaked(persisted), [], 'the spec on disk');
  assert.deepStrictEqual(leaked(JSON.stringify(printed)), [], 'and what main printed');
  assert.deepStrictEqual(JSON.parse(persisted).pages.find((p) => p.key === 'weather').connectorBindings, [WEATHER]);
  assert.deepStrictEqual(printed[0].payload.pageBindings.propertiesLeftOut.map((l) => [l.field, l.entry, l.properties.map((p) => p.property)]), [
    ['actionBindings', 0, ['headers']],
    ['connectorBindings', 0, ['connectionId', 'credentials', 'futureProperty']],
  ]);
});

test('validateAppSpec refuses a binding property an App Spec does not state — by name, never by value — and a value a property cannot hold', () => {
  const cases = [
    [{ connectorBindings: [{ ...WEATHER, connectionId: SECRET.connection }] }, "page 'weather': connectorBindings[0].connectionId is not a property an App Spec states (a binding states only logicalName, connectorId, dataset, tables, tableDisplayNames, operations) — remove it"],
    [{ connectorBindings: [{ ...WEATHER, credentials: { accessToken: SECRET.token } }] }, "page 'weather': connectorBindings[0].credentials is not a property an App Spec states (a binding states only logicalName, connectorId, dataset, tables, tableDisplayNames, operations) — remove it"],
    [{ actionBindings: [{ ...APPROVE, headers: { Authorization: SECRET.token } }] }, "page 'weather': actionBindings[0].headers is not a property an App Spec states (a binding states only name, isFunction, boundEntityLogicalName, displayName, parameterKinds) — remove it"],
    [{ connectorBindings: [{ ...WEATHER, futureProperty: true }] }, "page 'weather': connectorBindings[0].futureProperty is not a property an App Spec states (a binding states only logicalName, connectorId, dataset, tables, tableDisplayNames, operations) — remove it"],
    [{ connectorBindings: [{ ...WEATHER, operations: [{ credentials: SECRET.token }] }] }, "page 'weather': connectorBindings[0].operations must be a list of texts"],
    [{ connectorBindings: [{ ...WEATHER, dataset: `https://admin:${SECRET.password}@contoso.sharepoint.com/sites/x` }] }, "page 'weather': connectorBindings[0].dataset looks like it holds a credential, which an App Spec never states"],
    [{ actionBindings: [{ ...APPROVE, isFunction: 'no' }] }, "page 'weather': actionBindings[0].isFunction must be true or false"],
    [{ actionBindings: [{ ...APPROVE, parameterKinds: { Comment: SECRET.token } }] }, "page 'weather': actionBindings[0].parameterKinds must map parameter names to Dataverse parameter kinds"],
    [{ connectorBindings: [{ ...WEATHER, [`sk-live-${SECRET.clientSecret}`]: 1 }] }, "page 'weather': connectorBindings[0] has a property with an unusual name, which an App Spec does not state — remove it"],
  ];
  for (const [extra, expected] of cases) {
    const result = validateAppSpec(specWithPages(extra));
    assert.strictEqual(result.ok, false, JSON.stringify(extra));
    assert.ok(result.errors.includes(expected), `${expected}\n  got ${JSON.stringify(result.errors)}`);
    assert.deepStrictEqual(leaked(JSON.stringify(result)), [], 'the refusal quotes the name of a property, never its value');
  }
  // The same entries without the extra property are valid, and so are the documented values of every property.
  const clean = validateAppSpec(specWithPages({ connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE, SUMMARY] }));
  assert.ok(clean.ok, JSON.stringify(clean.errors));
  assert.deepStrictEqual(clean.warnings, []);
});

test('a build refuses a spec whose binding states a credential or a connection id, by the property\'s name, before it does anything else', async () => {
  const { buildModelApp } = require('../build-model-app.js');
  const spec = specWithPages({ connectorBindings: [{ ...WEATHER, credentials: { accessToken: SECRET.token }, connectionId: SECRET.connection }] });
  const result = await buildModelApp(spec, { apply: true, appDir: tmp('page-bindings-refused-'), profile: 'deploy' }, {});
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => /^page 'weather': connectorBindings\[0\]\.credentials is not a property an App Spec states/.test(e)), JSON.stringify(result.errors));
  assert.ok(result.errors.some((e) => /^page 'weather': connectorBindings\[0\]\.connectionId is not a property an App Spec states/.test(e)), JSON.stringify(result.errors));
  assert.deepStrictEqual(leaked(JSON.stringify(result)), [], 'and the refusal does not print their values');
});

test('pageBindingsNote names what a download left out of a binding, and where the values still are', () => {
  const pages = [{ pageId: A, key: 'weather', name: 'Weather', connectorBindings: [WEATHER] }];
  const leftOut = [{ pageId: A, field: 'connectorBindings', entry: 0, binding: 'contoso_msnweather', properties: [{ property: 'connectionId', why: 'not-stated' }, { property: 'operations', why: 'not-text-list' }] }];
  const report = pageBindingsReport(pages, [], leftOut);
  assert.deepStrictEqual(report.propertiesLeftOut, [{ key: 'weather', name: 'Weather', field: 'connectorBindings', entry: 0, binding: 'contoso_msnweather', properties: leftOut[0].properties }]);
  const text = pageBindingsNote(report);
  assert.match(text, /^NOTE: 1 page\(s\) hold connector or Custom API bindings/);
  assert.match(text, /WARNING: 1 binding\(s\) hold properties that are NOT in the spec/);
  assert.match(text, /Weather connectorBindings\[0\] \(contoso_msnweather\): connectionId, operations \(must be a list of texts\)/);
  assert.match(text, /Rebuilding into THIS environment leaves them on the page/);
  assert.match(text, /still in the page folder's own config\.json \(pages\/<page id>\/config\.json\)/);
  // Only a binding left something out, and no page states one: there is still something to say. And nothing left out says nothing.
  const only = pageBindingsReport([{ pageId: A, key: 'plain', name: 'Plain' }], [], [{ pageId: A, field: 'actionBindings', entry: 2, properties: [{ property: 'headers', why: 'not-stated' }] }]);
  assert.deepStrictEqual(only.pages, []);
  assert.match(pageBindingsNote(only), /^WARNING: 1 binding\(s\) hold properties that are NOT in the spec/);
  assert.strictEqual(pageBindingsReport([{ pageId: A, key: 'plain', name: 'Plain' }], [], []), null);
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

// ── a rebuild checks the environment's references before it writes a binding ──────────────────────────────────────────────────
// A binding is called through the logical name of a connection reference, and the spec cannot make the reference. A rebuild into another environment reads what that environment has for the names the
// spec states — before it writes anything — and: refuses a reference that is there for ANOTHER connector (the page would call that connector under this name), says by name what is not there, and says by name
// a Custom API that is the other kind or bound to another table. It never makes one: a connection holds a user's sign-in.
const FABRIKAM = 'https://fabrikam.crm.dynamics.com';
const apiId = (name) => `/providers/Microsoft.PowerApps/apis/${name}`;
const referenceRow = (logicalName, connector) => ({ connectionreferencelogicalname: logicalName, connectorid: connector === undefined ? undefined : apiId(connector) });

// The environment a copy goes to, with the references (`connectionreference` rows) and Custom APIs (`customapi` rows) it already holds. `reads` are the reads the build made of them, `writes` every write it
// made to the SDK before it stopped.
function targetEnvironment({ references = [], apis = [], failReferences, failApis } = {}) {
  const sdk = freshEnvironmentSdk();
  const answer = sdk.queryRecords;
  const reads = [];
  const writes = [];
  sdk.queryRecords = async (entity, options) => {
    if (entity !== 'connectionreference' && entity !== 'customapi') return answer(entity, options);
    reads.push({ entity, options });
    if (entity === 'connectionreference' && failReferences) throw new Error(failReferences);
    if (entity === 'customapi' && failApis) throw new Error(failApis);
    return entity === 'connectionreference' ? references : apis;
  };
  for (const method of ['createPublisher', 'createSolution', 'createTable', 'createColumn', 'createRelationship', 'createWebResource', 'createArtifact', 'addElement', 'updateElement', 'pushArtifact', 'publishArtifact', 'addSolutionComponent']) {
    const original = sdk[method];
    sdk[method] = (...args) => { writes.push(method); return original(...args); };
  }
  return { sdk, reads, writes };
}
const BOTH_REFERENCES = [referenceRow('contoso_msnweather', 'shared_msnweather'), referenceRow('contoso_sharepoint', 'shared_sharepointonline')];
const BOTH_APIS = [
  { uniquename: 'contoso_ApproveOrder', isfunction: false, bindingtype: 1, boundentitylogicalname: 'contoso_item' },
  { uniquename: 'contoso_GetSummary', isfunction: true, bindingtype: 0 },
];
const bindingWords = (messages) => messages.filter((m) => /connection reference|Custom API|binding/i.test(m));

test('a build into another environment refuses a binding whose connection reference is there for ANOTHER connector — before it writes anything', async () => {
  const { spec, outDir } = await portableCopy();
  const { sdk, reads, writes } = targetEnvironment({ references: [referenceRow('contoso_msnweather', 'shared_office365users'), BOTH_REFERENCES[1]], apis: BOTH_APIS });
  const genpage = fakeGenpage();
  await assert.rejects(runSdkBuild(spec, { sdk, genpage, appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES }), (error) => {
    assert.ok(error instanceof BuildHalt, String(error && error.stack));
    assert.deepStrictEqual([error.phase, error.code, error.recoverable, error.transient], ['preflight', 'pages-binding-reference-conflict', false, false], 'a run again reads the same references: it is not retried');
    assert.match(error.message, /1 connector binding\(s\) name a connection reference this environment already has for ANOTHER connector: page "Weather": connector binding "contoso_msnweather" is for connector shared_msnweather, but the connection reference of that name in this environment is for connector shared_office365users\./);
    assert.match(error.message, /The build stopped before writing anything\./);
    assert.match(error.message, /give the binding the logical name of a reference that is for the right connector \(create-connection-reference\.js makes one\)/);
    assert.match(error.message, /set the binding's connectorId in the spec to the connector this environment has/);
    assert.ok(!/contoso_sharepoint/.test(error.message), 'only the binding that conflicts is named');
    return true;
  });
  assert.deepStrictEqual(writes, [], 'nothing was written: no solution, no table, no app');
  assert.deepStrictEqual(genpage.calls.filter((c) => c.method === 'create' || c.method === 'update'), [], 'and no page');
  assert.deepStrictEqual(reads.map((r) => r.entity), ['connectionreference', 'customapi'], 'what it read: the references and the Custom APIs the pages state, once');
});

test('a build with no conflict goes on: the same connector under another spelling of its id, and a Custom API of the same kind and table, are fine — and nothing is said', async () => {
  const { spec, outDir } = await portableCopy();
  const { sdk, writes } = targetEnvironment({ references: [referenceRow('CONTOSO_MsnWeather', 'SHARED_MSNWEATHER'), { connectionreferencelogicalname: 'contoso_sharepoint', connectorid: 'shared_sharepointonline' }], apis: BOTH_APIS });
  const genpage = fakeGenpage();
  const warnings = [];
  const rebuilt = await runSdkBuild(spec, { sdk, genpage, appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.ok(rebuilt.ok);
  assert.ok(writes.length > 0);
  assert.strictEqual(genpage.of('create').length, 2);
  assert.deepStrictEqual(bindingWords(warnings), []);
});

test('a build says by name what the environment does not have — and writes the pages with their bindings all the same: a reference made later makes the page work without a rebuild', async () => {
  const { spec, outDir } = await portableCopy();
  const { sdk } = targetEnvironment({ references: [BOTH_REFERENCES[1]], apis: [BOTH_APIS[1]] });
  const genpage = fakeGenpage();
  const warnings = [];
  const rebuilt = await runSdkBuild(spec, { sdk, genpage, appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.ok(rebuilt.ok);
  const bound = bindingWords(warnings);
  assert.strictEqual(bound.length, 2, JSON.stringify(bound));
  assert.match(bound[0], /^page "Weather": connection reference contoso_msnweather is not in this environment, so the page is written with a binding it cannot resolve yet\. A page finds its connector by the reference's logical name: create the reference here \(create-connection-reference\.js, or import the solution that holds it\) and the page works without a rebuild$/);
  assert.match(bound[1], /^page "Weather": Custom API contoso_ApproveOrder is not in this environment \(list-custom-apis\.js lists what it has\), so a call through the binding is refused until it is deployed here$/);
  const weather = genpage.of('create').map((c) => c.args[0]).find((c) => c.name === 'Weather');
  assert.deepStrictEqual([weather.connectorBindings, weather.actionBindings], [[WEATHER, SHAREPOINT], [APPROVE, SUMMARY]], 'the bindings are written: the spec states them');
});

test('a Custom API of the other kind, or bound to another table, is a warning by name, never a refusal', async () => {
  const { spec, outDir } = await portableCopy();
  const { sdk } = targetEnvironment({ references: BOTH_REFERENCES, apis: [{ ...BOTH_APIS[0], isfunction: true }, { ...BOTH_APIS[1], bindingtype: 1, boundentitylogicalname: 'contoso_other' }] });
  const warnings = [];
  const rebuilt = await runSdkBuild(spec, { sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.ok(rebuilt.ok);
  assert.deepStrictEqual(bindingWords(warnings), [
    'page "Weather": Custom API binding "contoso_ApproveOrder" says it is an Action, but the Custom API of that name in this environment is a Function — the runtime refuses the call (wrong_operation_kind)',
    'page "Weather": Custom API binding "contoso_GetSummary" is for a Global operation, but the Custom API of that name in this environment is bound to table contoso_other — the runtime refuses the call (invalid_bound_to)',
  ]);
});

test('a read of the environment that fails is said, and the build goes on as it did: the page is written, and not checked', async () => {
  const { spec, outDir } = await portableCopy();
  const { sdk } = targetEnvironment({ failReferences: 'HTTP 403', apis: BOTH_APIS });
  const warnings = [];
  const rebuilt = await runSdkBuild(spec, { sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.ok(rebuilt.ok);
  assert.deepStrictEqual(bindingWords(warnings), ['could not read this environment\'s connection references (HTTP 403), so the connector bindings of page "Weather" were not checked against them']);
});

test('a spec that states no binding makes no read of references or Custom APIs, and a rebuild of it is as it was', async () => {
  const { spec, outDir } = await portableCopy();
  for (const page of spec.pages) { delete page.connectorBindings; delete page.actionBindings; }
  const { sdk, reads } = targetEnvironment({ references: [referenceRow('contoso_msnweather', 'shared_office365users')] });
  const warnings = [];
  const rebuilt = await runSdkBuild(spec, { sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.ok(rebuilt.ok);
  assert.deepStrictEqual(reads, []);
  assert.deepStrictEqual(bindingWords(warnings), []);
});

test('a run without the pages phase does not read them either: the bindings are not written, so there is nothing to check', async () => {
  const { spec, outDir } = await portableCopy();
  const { sdk, reads } = targetEnvironment({ references: [referenceRow('contoso_msnweather', 'shared_office365users')] });
  const rebuilt = await runSdkBuild(spec, { sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: true, phases: ['solution', 'data-model', 'app-shell'] });
  assert.ok(rebuilt.ok);
  assert.deepStrictEqual(reads, []);
});

test('a dry run says what an apply would stop at — on the page\'s own line — and reads nothing when it is asked not to read the environment', async () => {
  const { spec, outDir } = await portableCopy();
  const conflicting = [referenceRow('contoso_msnweather', 'shared_office365users'), BOTH_REFERENCES[1]];
  const warnings = [];
  const { sdk, reads, writes } = targetEnvironment({ references: conflicting, apis: BOTH_APIS });
  const planned = await runSdkBuild(spec, { sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: false, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.strictEqual(planned.dryRun, true);
  assert.deepStrictEqual(writes, [], 'a dry run writes nothing');
  assert.ok(reads.length > 0, 'it read the environment for the names the pages state');
  const weather = planned.planItems.find((item) => item.label === 'page "Weather"');
  assert.deepStrictEqual([weather.state, weather.wouldHalt], ['unknown', true]);
  assert.strictEqual(weather.stateWhy, 'the build would stop before writing anything: page "Weather": connector binding "contoso_msnweather" is for connector shared_msnweather, but the connection reference of that name in this environment is for connector shared_office365users');
  assert.deepStrictEqual(planned.planItems.filter((item) => item.wouldHalt).map((item) => item.label), ['page "Weather"'], 'no other line is marked');

  // A reference that is not there is a warning in the plan, as it is in the build, and halts nothing.
  const missing = targetEnvironment({ references: [BOTH_REFERENCES[1]], apis: BOTH_APIS });
  const missingWarnings = [];
  const missingPlan = await runSdkBuild(spec, { sdk: missing.sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: false, phases: PHASES, warn: (m) => missingWarnings.push(m) });
  assert.deepStrictEqual(missingPlan.planItems.filter((item) => item.wouldHalt), []);
  assert.match(bindingWords(missingWarnings)[0], /^page "Weather": connection reference contoso_msnweather is not in this environment/);

  // `livePlan: false` is a plan that does not read the environment: it reads no reference either.
  const offline = targetEnvironment({ references: conflicting });
  const offlinePlan = await runSdkBuild(spec, { sdk: offline.sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: false, livePlan: false, phases: PHASES });
  assert.deepStrictEqual(offline.reads, []);
  assert.deepStrictEqual(offlinePlan.planItems.filter((item) => item.wouldHalt), []);
});

test('a dry run whose read of the references fails says so, and halts nothing', async () => {
  const { spec, outDir } = await portableCopy();
  const { sdk } = targetEnvironment({ failReferences: 'HTTP 403', apis: BOTH_APIS });
  const warnings = [];
  const planned = await runSdkBuild(spec, { sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: false, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.deepStrictEqual(planned.planItems.filter((item) => item.wouldHalt), []);
  assert.strictEqual(bindingWords(warnings).length, 1);
  assert.match(bindingWords(warnings)[0], /^could not read this environment's connection references \(HTTP 403\)/);
});
