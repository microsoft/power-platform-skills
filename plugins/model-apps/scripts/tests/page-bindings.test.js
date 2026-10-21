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
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { makeThrottleBudget } = require('../lib/throttle-budget.js');

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

test('an entry with no logicalName (a connector binding) or name (a Custom API binding) is a warning, never an error — it is written as it is; one that is not an identifier is an error, by name', () => {
  const result = validateAppSpec(specWithPages({ connectorBindings: [{ connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather' }, { dataset: '' }], actionBindings: [{ displayName: 'x' }, APPROVE] }));
  assert.ok(result.ok, JSON.stringify(result.errors));
  assert.strictEqual(result.warnings.length, 3, JSON.stringify(result.warnings));
  assert.match(result.warnings[0], /page 'weather': connectorBindings\[0\] has no logicalName/);
  assert.match(result.warnings[1], /page 'weather': connectorBindings\[1\] has no logicalName/);
  assert.match(result.warnings[2], /page 'weather': actionBindings\[0\] has no name/);
  assert.ok(result.warnings.every((w) => /finds a binding by it/.test(w)), 'the warning says why a binding needs it');
  const blank = validateAppSpec(specWithPages({ connectorBindings: [{ logicalName: '  ' }] }));
  assert.ok(blank.errors.includes("page 'weather': connectorBindings[0].logicalName must be an identifier (a letter, then letters, digits, _ . -)"), JSON.stringify(blank.errors));
});

test('what a download carries of a list always validates, and the validator refuses what the download would leave out of it — the rules they share are pageBindingsProblem and statableBindings', () => {
  const values = [[], [WEATHER], [{}], [{ anything: 1 }], [{ ...WEATHER, connectionId: 'x' }], [WEATHER, { ...SHAREPOINT, dataset: 'https://x@contoso.example' }], [{ ...APPROVE, displayName: 'https://contoso.example' }], 'x', 5, {}, [null], [WEATHER, 3], [[WEATHER]], [true]];
  for (const kind of Object.keys(PAGE_BINDINGS)) {
    const errorsOf = (list) => validateAppSpec(specWithPages({ [kind]: list })).errors.filter((e) => e.includes(kind));
    for (const value of values) {
      const container = pageBindingsProblem(kind, value);
      if (container) {
        assert.ok(errorsOf(value).length > 0, `${kind}: the validator refuses ${JSON.stringify(value)}: ${container}`);
        continue;
      }
      const { stated, problem } = statableBindings(kind, value);
      if (stated) assert.deepStrictEqual(errorsOf(stated), [], `${kind}: what a download carries of ${JSON.stringify(value)} validates`);
      assert.strictEqual(errorsOf(value).length > 0, problem !== null, `${kind}: ${JSON.stringify(value)} is refused exactly when a download would leave it out`);
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

// ── a spec states a list only whole, and only what is known to be safe ───────────────────────────────────────────────────────────
// The spec is the artifact that is committed, reviewed and shared; the page's own config.json is the environment's. A binding a page holds can carry more than the runtime reads — a connection id of the
// environment it was made in, a credential someone put in a connectors.json (as a value, a key, or inside a URL), a property a later runtime adds — and none of it is the spec's to carry. So a list is in the
// spec only when every key of every entry is a documented property and every value has a conservative shape known to be safe (lib/page-bindings.js has the threat model); otherwise the WHOLE list is left out,
// and the download says where — the page, the list, the entry's place and the vetted property — never what. A list left out is one a rebuild does not send: the page keeps it as it is.

// Synthetic values, none a real credential. Each is looked for in everything a download writes or prints.
const SECRET = {
  token: 'SYNTHETIC_TEST_ACCESS_TOKEN',
  clientSecret: 'SYNTHETIC_TEST_SECRET',
  password: 'SYNTHETIC_TEST_PASSWORD',
  signature: 'SYNTHETIC_TEST_SIGNATURE',
  connection: 'env-local-connection-placeholder',
  named: `ghp_${'R'.repeat(36)}`,
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

// What `main` writes to disk and prints for a download's result: the persistence path every sink goes through.
async function persisted(downloaded) {
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
  return { spec: fs.readFileSync(path.join(outDir, 'app-spec.json'), 'utf8'), printed: JSON.stringify(printed) };
}

test('a list that holds a credential, a connection id or a property no spec states — in any entry — is left out of the spec WHOLE, and the download says where, never what', async () => {
  const { result, stderr, outDir, weather } = await downloadPagesHolding({ connectorBindings: [WEATHER, SHAREPOINT_WITH_EXTRAS], actionBindings: [APPROVE_WITH_EXTRAS, SUMMARY] });
  assert.ok(!('connectorBindings' in weather), 'not the clean entry alone: a spec that stated part of the list would have a rebuild replace the page\'s list with that part');
  assert.ok(!('actionBindings' in weather));
  assert.ok(validateAppSpec(JSON.parse(JSON.stringify(result.spec))).ok, 'the spec validates');
  assert.deepStrictEqual(result.pageBindings.notCarried, [
    { key: 'weather', name: 'Weather', field: 'actionBindings', reason: 'actionBindings[0] holds an unrecognized property, which an App Spec does not state (a binding states only name, isFunction, boundEntityLogicalName, displayName, parameterKinds)' },
    { key: 'weather', name: 'Weather', field: 'connectorBindings', reason: 'connectorBindings[1] holds an unrecognized property, which an App Spec does not state (a binding states only logicalName, connectorId, dataset, tables, tableDisplayNames, operations)' },
  ]);
  assert.ok(!('propertiesLeftOut' in result.pageBindings), 'no property is projected out of a list, so none is listed');
  for (const word of ['apiKey', 'headers']) assert.ok(!JSON.stringify(result).includes(word) && !stderr.includes(word), `an unrecognized key is never said: ${word}`);
  assert.deepStrictEqual(leaked(JSON.stringify(result) + stderr), []);
  assert.match(stderr, /WARNING: 2 list\(s\) of connector or Custom API bindings are NOT in the spec/);
  assert.match(stderr, /still in the page folder's own config\.json \(pages\/<page id>\/config\.json\)/);
  // The page folder is the page as the environment holds it, and is not rewritten.
  const sidecar = JSON.parse(fs.readFileSync(path.join(outDir, 'pages', WEATHER_ID, 'config.json'), 'utf8'));
  assert.strictEqual(sidecar.connectorBindings[1].apiKey, SECRET.clientSecret);
  // A list whose entries are all known to be safe is stated as the page holds it, beside one that is left out.
  const mixed = await downloadPagesHolding({ connectorBindings: [WEATHER_WITH_EXTRAS], actionBindings: [APPROVE, SUMMARY] });
  assert.ok(!('connectorBindings' in mixed.weather));
  assert.deepStrictEqual(mixed.weather.actionBindings, [APPROVE, SUMMARY]);
});

// Every form a credential took in an adversarial probe of the earlier rule, through the download's projection AND `main`'s persistence: the list is left out, and the marker is in none of the spec on disk, the
// printed result or stderr; and an authored spec that states it is refused.
test('a credential hidden in a URL (user-info alone, an encoded query key, a fragment), in JSON text, in a Custom API\'s display name, as a property NAME or a parameter name, reaches no sink', async () => {
  const cases = [
    ['a token alone in the user-info', 'connectorBindings', { ...WEATHER, dataset: `https://${SECRET.token}@contoso.example/data` }],
    ['a percent-encoded query key', 'connectorBindings', { ...WEATHER, dataset: `https://contoso.example/data?api%5Fkey=${SECRET.token}` }],
    ['a fragment token', 'connectorBindings', { ...WEATHER, dataset: `https://contoso.example/data#access_token=${SECRET.token}` }],
    ['JSON text in a dataset', 'connectorBindings', { ...WEATHER, dataset: JSON.stringify({ accessToken: SECRET.token }) }],
    ['a password in the user-info', 'connectorBindings', { ...WEATHER, dataset: `https://maker:${SECRET.password}@contoso.example/data` }],
    ['a nested credential in a list', 'connectorBindings', { ...WEATHER, tables: [{ apiKey: SECRET.clientSecret }] }],
    ['a token as a property name', 'connectorBindings', { ...WEATHER, [SECRET.named]: true }],
    ['a credential-shaped identity', 'connectorBindings', { ...WEATHER, logicalName: `Bearer ${SECRET.token}` }],
    ["a Custom API's display name that is a URL", 'actionBindings', { ...APPROVE, displayName: `https://${SECRET.token}@contoso.example/api` }],
    ['a token as a parameter name', 'actionBindings', { ...APPROVE, parameterKinds: { [SECRET.named]: 'String' } }],
    ['a credential-shaped Custom API name', 'actionBindings', { ...APPROVE, name: SECRET.named }],
  ];
  for (const [what, kind, entry] of cases) {
    const { result, stderr, weather } = await downloadPagesHolding({ [kind]: [entry] });
    assert.ok(!(kind in weather), `${what}: the list is left out`);
    assert.strictEqual(result.pageBindings.notCarried.find((n) => n.field === kind).field, kind, what);
    const disk = await persisted(result);
    assert.deepStrictEqual(leaked(disk.spec), [], `${what}: app-spec.json`);
    assert.deepStrictEqual(leaked(disk.printed), [], `${what}: the printed result`);
    assert.deepStrictEqual(leaked(stderr), [], `${what}: stderr`);
    const authored = validateAppSpec(specWithPages({ [kind]: [entry] }));
    assert.strictEqual(authored.ok, false, `${what}: an authored spec that states it is refused`);
    assert.deepStrictEqual(leaked(JSON.stringify(authored)), [], `${what}: and the refusal does not quote it`);
  }
});

// A parser normalizes what it reads: a dot-segment removes the path segment before it, so a check of the parsed URL never sees that segment, while the spec would keep the text as it was. The text a download
// would persist is the text that is checked, so such a URL — in any place a binding holds a text — leaves its list out of the spec, and of every other sink.
test('a URL whose dot-segments would drop a segment — plain or percent-encoded — leaves its list out of every sink: the text checked is the text that would be persisted', async () => {
  const hidden = (dots) => `https://contoso.example/${SECRET.token}/${dots}/site`;
  const cases = [
    ['a dot-segment, as a connector dataset', 'connectorBindings', { ...WEATHER, dataset: hidden('..') }],
    ['a percent-encoded dot-segment, as a connector dataset', 'connectorBindings', { ...WEATHER, dataset: hidden('%2e%2e') }],
    ["an upper-case encoded dot-segment, as a custom connector's dataset", 'connectorBindings', { logicalName: 'contoso_widgets', connectorId: '/providers/Microsoft.PowerApps/apis/shared_contoso-5fwidgets-5f6a8c', dataset: hidden('%2E%2E'), operations: ['ListWidgets'] }],
    ['a dot-segment, as a table id', 'connectorBindings', { ...SHAREPOINT, tables: [hidden('..')] }],
    ["a dot-segment, as a Custom API's display name", 'actionBindings', { ...APPROVE, displayName: hidden('..') }],
    ['a dot-segment, as a parameter name', 'actionBindings', { ...APPROVE, parameterKinds: { [hidden('..')]: 'String' } }],
  ];
  for (const [what, kind, entry] of cases) {
    const { result, stderr, weather } = await downloadPagesHolding({ [kind]: [entry] });
    assert.ok(!(kind in weather), `${what}: the list is left out`);
    const carried = result.pageBindings.notCarried.find((n) => n.field === kind);
    assert.ok(carried && !carried.reason.includes(SECRET.token) && !carried.reason.includes('..'), `${what}: the reason says where, never what`);
    const disk = await persisted(result);
    assert.deepStrictEqual(leaked(disk.spec), [], `${what}: app-spec.json`);
    assert.deepStrictEqual(leaked(disk.printed), [], `${what}: the printed result`);
    assert.deepStrictEqual(leaked(stderr), [], `${what}: stderr`);
    const authored = validateAppSpec(specWithPages({ [kind]: [entry] }));
    assert.strictEqual(authored.ok, false, `${what}: an authored spec that states it is refused`);
    assert.deepStrictEqual(leaked(JSON.stringify(authored)), [], `${what}: and the refusal does not quote it`);
  }
});

test('validateAppSpec refuses a binding property an App Spec does not state, and a value without the shape it states — by the vetted name or as "an unrecognized property", never by value or key', () => {
  const unrecognized = (kind) => `page 'weather': ${kind}[0] holds an unrecognized property, which an App Spec does not state (a binding states only ${kind === 'connectorBindings' ? 'logicalName, connectorId, dataset, tables, tableDisplayNames, operations' : 'name, isFunction, boundEntityLogicalName, displayName, parameterKinds'})`;
  const cases = [
    [{ connectorBindings: [{ ...WEATHER, connectionId: SECRET.connection }] }, unrecognized('connectorBindings')],
    [{ connectorBindings: [{ ...WEATHER, [SECRET.named]: 1 }] }, unrecognized('connectorBindings')],
    [{ actionBindings: [{ ...APPROVE, headers: { Authorization: SECRET.token } }] }, unrecognized('actionBindings')],
    [{ connectorBindings: [{ ...WEATHER, operations: [{ credentials: SECRET.token }] }] }, "page 'weather': connectorBindings[0].operations must be a list of identifiers"],
    [{ connectorBindings: [{ ...WEATHER, dataset: `https://${SECRET.token}@contoso.example/x` }] }, "page 'weather': connectorBindings[0].dataset must be empty, a plain name, or an http(s) URL with no user-info, no query and no fragment"],
    [{ actionBindings: [{ ...APPROVE, isFunction: 'no' }] }, "page 'weather': actionBindings[0].isFunction must be true or false"],
    [{ actionBindings: [{ ...APPROVE, parameterKinds: { [SECRET.named]: 'String' } }] }, "page 'weather': actionBindings[0].parameterKinds must map parameter names to Dataverse parameter kinds"],
    [{ actionBindings: [{ ...APPROVE, displayName: `https://contoso.example/?sig=${SECRET.signature}` }] }, "page 'weather': actionBindings[0].displayName must be a plain label (letters, digits, spaces and simple punctuation; no URL)"],
  ];
  for (const [extra, expected] of cases) {
    const result = validateAppSpec(specWithPages(extra));
    assert.strictEqual(result.ok, false, JSON.stringify(extra));
    assert.ok(result.errors.includes(expected), `${expected}\n  got ${JSON.stringify(result.errors)}`);
    assert.deepStrictEqual(leaked(JSON.stringify(result)), [], 'the refusal never quotes a value or an unrecognized key');
    for (const key of ['connectionId', 'headers']) assert.ok(!JSON.stringify(result.errors).includes(key), key);
  }
  const clean = validateAppSpec(specWithPages({ connectorBindings: [WEATHER, SHAREPOINT], actionBindings: [APPROVE, SUMMARY] }));
  assert.ok(clean.ok, JSON.stringify(clean.errors));
  assert.deepStrictEqual(clean.warnings, []);
});

test('a build refuses a spec whose binding states a credential or a connection id before it does anything else, and never prints them', async () => {
  const { buildModelApp } = require('../build-model-app.js');
  const spec = specWithPages({ connectorBindings: [{ ...WEATHER, credentials: { accessToken: SECRET.token }, connectionId: SECRET.connection }] });
  const result = await buildModelApp(spec, { apply: true, appDir: tmp('page-bindings-refused-'), profile: 'deploy' }, {});
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => /^page 'weather': connectorBindings\[0\] holds an unrecognized property, which an App Spec does not state/.test(e)), JSON.stringify(result.errors));
  assert.deepStrictEqual(leaked(JSON.stringify(result)), []);
  assert.ok(!/connectionId|credentials/.test(JSON.stringify(result.errors)), 'nor the names of the keys');
});

test('pageBindingsNote says which lists are not in the spec — the page, the list, the entry\'s place and the vetted property — and where their values still are', () => {
  const pages = [{ pageId: A, key: 'weather', name: 'Weather', actionBindings: [APPROVE] }];
  const unkept = [{ pageId: A, field: 'connectorBindings', reason: 'connectorBindings[0].dataset must be empty, a plain name, or an http(s) URL with no user-info, no query and no fragment' }];
  const report = pageBindingsReport(pages, unkept);
  assert.deepStrictEqual(report.notCarried, [{ key: 'weather', name: 'Weather', field: 'connectorBindings', reason: unkept[0].reason }]);
  assert.ok(!('propertiesLeftOut' in report));
  const text = pageBindingsNote(report);
  assert.match(text, /^NOTE: 1 page\(s\) hold connector or Custom API bindings/);
  assert.match(text, /WARNING: 1 list\(s\) of connector or Custom API bindings are NOT in the spec, because the spec cannot state them as the page holds them: "Weather" \(connectorBindings\[0\]\.dataset must be empty/);
  assert.match(text, /left out whole \(the values are never printed\)/);
  assert.match(text, /still in the page folder's own config\.json \(pages\/<page id>\/config\.json\)/);
  assert.strictEqual(pageBindingsReport([{ pageId: A, key: 'plain', name: 'Plain' }], []), null);
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
// A reference's row as the Web API answers the build's read: complete — its connector, a connection, and no custom connector recorded (a connector the platform publishes).
const referenceRow = (logicalName, connector) => ({ connectionreferencelogicalname: logicalName, connectorid: connector === undefined ? undefined : apiId(connector), connectionid: `shared-${logicalName}-0001`, _customconnectorid_value: null });

// The environment a copy goes to, with the references (`connectionreference` rows) and Custom APIs (`customapi` rows) it already holds. `reads` are the reads the build made of them, `writes` every write it
// made to the SDK before it stopped.
function targetEnvironment({ references = [], apis = [], connectors = [], failReferences, failApis } = {}) {
  const sdk = freshEnvironmentSdk();
  const answer = sdk.queryRecords;
  const reads = [];
  const writes = [];
  const answers = { connectionreference: references, customapi: apis, connector: connectors };
  sdk.queryRecords = async (entity, options) => {
    if (!(entity in answers)) return answer(entity, options);
    reads.push({ entity, options });
    if (entity === 'connectionreference' && failReferences) throw new Error(failReferences);
    if (entity === 'customapi' && failApis) throw new Error(failApis);
    return answers[entity];
  };
  for (const method of ['createPublisher', 'createSolution', 'createTable', 'createColumn', 'createRelationship', 'createWebResource', 'updateWebResource', 'createArtifact', 'addElement', 'updateElement', 'removeElement', 'pushArtifact', 'publishArtifact', 'addSolutionComponent']) {
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
// The operations of Weather's binding (MSN Weather, a connector the platform publishes) are said to be not checked on every build that writes it: no row names a custom connector for its reference. Pinned once
// (`a binding whose reference names no custom connector`, below) and left out of the other tests' lists of what is said.
const OPERATIONS_NOT_CHECKED = /^the operations that connector binding "contoso_msnweather" of page "Weather" call were not checked: /;
const bindingWords = (messages) => messages.filter((m) => /connection reference|Custom API|binding/i.test(m) && !OPERATIONS_NOT_CHECKED.test(m));

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

// The halt's text opens with the page's name, and the build decides from a halt's text whether it is a transient error to run every phase again for (isTransientHalt, build-model-app.js). A page
// called "SQL Timeout 503 try again later" must not make this refusal read as one: it is raised before anything is written, and a run again reads the same reference. The words alone DO read as
// transient (the control), so it is the halt's own policy (`retry: RETRY.NEVER`) that is held here — tests/halt-retry-policy.test.js names this file for it.
test('the conflict halt of a page whose name reads as a transient error is still final — the build does not run again for it', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const { spec, outDir } = await portableCopy();
  spec.pages.find((p) => p.key === 'weather').name = 'SQL Timeout 503 try again later';
  const { sdk, writes } = targetEnvironment({ references: [referenceRow('contoso_msnweather', 'shared_office365users'), BOTH_REFERENCES[1]], apis: BOTH_APIS });
  const halt = await runSdkBuild(spec, { sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES }).then(() => null, (error) => error);
  assert.ok(halt instanceof BuildHalt, String(halt && halt.stack));
  assert.strictEqual(halt.code, 'pages-binding-reference-conflict');
  assert.match(halt.message, /page "SQL Timeout 503 try again later": connector binding "contoso_msnweather" is for connector shared_msnweather/);
  assert.deepStrictEqual(writes, []);
  assert.strictEqual(isTransientHalt(halt, { spec }), false, 'the halt reads as final');
  assert.strictEqual(halt.transient, false, 'because it says so');
  assert.strictEqual(isTransientHalt(new Error(halt.message), { spec }), true, 'its words alone would have read as a transient error');
});

test('a build with no conflict goes on: the same connector under another spelling of its id, and a Custom API of the same kind and table, are fine — and nothing is said', async () => {
  const { spec, outDir } = await portableCopy();
  const { sdk, writes } = targetEnvironment({ references: [referenceRow('CONTOSO_MsnWeather', 'SHARED_MSNWEATHER'), { connectionreferencelogicalname: 'contoso_sharepoint', connectorid: '/providers/Microsoft.PowerApps/apis/Shared_SharePointOnline', connectionid: 'shared-sharepoint-0001', _customconnectorid_value: null }], apis: BOTH_APIS });
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

// A page made with a CUSTOM connector: its binding goes through a reference whose connector's definition is a row of the environment (`connector.openapidefinition`), and the copy there can be another version.
const WIDGETS_BINDING = { logicalName: 'contoso_widgets', connectorId: '/providers/Microsoft.PowerApps/apis/shared_contoso-5fwidgets-5f6a8c', dataset: '', operations: ['ListWidgets', 'GetWidget'] };
const WIDGETS_CONNECTOR_ID = 'c0000000-0000-4000-8000-0000000000a1';
const widgetsDefinition = (operationIds) => JSON.stringify({ swagger: '2.0', info: { title: 'Widgets', version: '1.0' }, paths: Object.fromEntries(operationIds.map((id, i) => [`/widgets/${i}`, { get: { operationId: id, responses: { 200: { description: 'OK' } } } }])) });

test('a build says by name a reference that has no connection, and an operation the custom connector of a reference does not define there — and writes the pages with their bindings all the same', async () => {
  const { spec, outDir } = await portableCopy();
  const weather = spec.pages.find((p) => p.key === 'weather');
  weather.connectorBindings = [WIDGETS_BINDING, SHAREPOINT];
  const { sdk, reads } = targetEnvironment({
    references: [
      { connectionreferencelogicalname: 'contoso_widgets', connectorid: WIDGETS_BINDING.connectorId, connectionid: 'shared-contoso-5fwidgets-0001', _customconnectorid_value: WIDGETS_CONNECTOR_ID },
      { ...BOTH_REFERENCES[1], connectionid: null },
    ],
    apis: BOTH_APIS,
    connectors: [{ connectorid: WIDGETS_CONNECTOR_ID, openapidefinition: widgetsDefinition(['ListWidgets']) }],
  });
  const genpage = fakeGenpage();
  const warnings = [];
  const rebuilt = await runSdkBuild(spec, { sdk, genpage, appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.ok(rebuilt.ok);
  assert.deepStrictEqual(reads.map((r) => r.entity), ['connectionreference', 'connector', 'customapi'], 'the definition of the custom connector is read once, by id, between the two reads it already made');
  assert.deepStrictEqual(bindingWords(warnings), [
    'page "Weather": connection reference contoso_sharepoint is in this environment but has no connection, so the page\'s calls through it fail until it has one. Give it a connection (import the solution that holds it with a settings file that does: solution-settings.js, or set it in Power Apps, in the solution\'s connection references) and the page works without a rebuild',
    'page "Weather": connector binding "contoso_widgets" calls operation GetWidget, which the custom connector that connection reference is for in this environment does not define, so the page\'s call to it fails there until it does (import the solution that holds the connector as the page was made with it)',
  ]);
  const created = genpage.of('create').map((c) => c.args[0]).find((c) => c.name === 'Weather');
  assert.deepStrictEqual(created.connectorBindings, [WIDGETS_BINDING, SHAREPOINT], 'the page is written with the bindings the spec states');
});

// Successful but incomplete: the target answers the read, and its row for the custom connector's reference does not name the custom connector. The build has no definition to read, so the operation the
// binding calls is not proven to be there — and it is said, by name, as not checked: not "fine", and not a refusal either.
test('a build whose target row names no custom connector for a binding\'s reference says its operations were NOT CHECKED — it is not read as compatible, and nothing is refused', async () => {
  const { spec, outDir } = await portableCopy();
  spec.pages.find((p) => p.key === 'weather').connectorBindings = [WIDGETS_BINDING];
  for (const lookup of [undefined, null, 'not-a-guid']) {
    const row = { connectionreferencelogicalname: 'contoso_widgets', connectorid: WIDGETS_BINDING.connectorId, connectionid: 'shared-contoso-5fwidgets-0001', ...(lookup === undefined ? {} : { _customconnectorid_value: lookup }) };
    const { sdk, reads } = targetEnvironment({ references: [row], apis: BOTH_APIS, connectors: [{ connectorid: WIDGETS_CONNECTOR_ID, openapidefinition: widgetsDefinition(['ListWidgets']) }] });
    const genpage = fakeGenpage();
    const warnings = [];
    const rebuilt = await runSdkBuild(spec, { sdk, genpage, appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
    assert.ok(rebuilt.ok, String(lookup));
    assert.deepStrictEqual(reads.map((r) => r.entity), ['connectionreference', 'customapi'], 'no definition to read it by');
    assert.deepStrictEqual(warnings.filter((m) => /contoso_widgets/.test(m)), ['the operations that connector binding "contoso_widgets" of page "Weather" call were not checked: this environment does not name a custom connector for its connection reference, and only a custom connector\'s definition is read here (a connector the platform publishes defines the same operations in every environment of its cloud)'], String(lookup));
    assert.strictEqual(genpage.of('create').length, 2, 'the pages are written: missing evidence refuses nothing');
  }
  // The same build with a complete row says what the definition lacks.
  const complete = targetEnvironment({ references: [{ connectionreferencelogicalname: 'contoso_widgets', connectorid: WIDGETS_BINDING.connectorId, connectionid: 'shared-contoso-5fwidgets-0001', _customconnectorid_value: WIDGETS_CONNECTOR_ID }], apis: BOTH_APIS, connectors: [{ connectorid: WIDGETS_CONNECTOR_ID, openapidefinition: widgetsDefinition(['ListWidgets']) }] });
  const warnings = [];
  await runSdkBuild(spec, { sdk: complete.sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.ok(warnings.some((m) => /calls operation GetWidget, which the custom connector that connection reference is for in this environment does not define/.test(m)));
});

// Malformed target metadata never stops a rebuild: a `connectorid` that is not a connector's API id, and a `connectionid` that is not a text, are said as not checked. Only two VALID connector ids that differ
// are a conflict.
test('a build whose target row holds a malformed connectorid or connectionid goes on and says it was not checked — it never halts on a value it cannot read', async () => {
  const { spec, outDir } = await portableCopy();
  const malformed = [{ ...referenceRow('contoso_msnweather', 'shared_msnweather'), connectorid: '***' }, { ...BOTH_REFERENCES[1], connectionid: 42 }];
  const { sdk, writes } = targetEnvironment({ references: malformed, apis: BOTH_APIS });
  const genpage = fakeGenpage();
  const warnings = [];
  const rebuilt = await runSdkBuild(spec, { sdk, genpage, appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.ok(rebuilt.ok, 'no pages-binding-reference-conflict for a connector id it cannot read');
  assert.ok(writes.length > 0);
  assert.strictEqual(genpage.of('create').length, 2, 'the pages are written');
  assert.ok(warnings.some((m) => /connection reference contoso_msnweather did not give a connector id this build can read/.test(m)), JSON.stringify(bindingWords(warnings)));
  assert.ok(warnings.some((m) => /connection reference contoso_sharepoint did not say, in a form this build can read, whether it has a connection/.test(m)), JSON.stringify(bindingWords(warnings)));
  assert.ok(!warnings.some((m) => /has no connection/.test(m)), 'a connectionid that is not a text is not "no connection"');
});

test('a binding whose reference names no custom connector — a connector the platform publishes — has its operations said to be not checked, once per page', async () => {
  const { spec, outDir } = await portableCopy();
  const { sdk } = targetEnvironment({ references: BOTH_REFERENCES, apis: BOTH_APIS });
  const warnings = [];
  await runSdkBuild(spec, { sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.strictEqual(warnings.filter((m) => OPERATIONS_NOT_CHECKED.test(m)).length, 1);
});

test('a read of the environment that fails is said, and the build goes on as it did: the page is written, and not checked', async () => {
  const { spec, outDir } = await portableCopy();
  const { sdk } = targetEnvironment({ failReferences: 'HTTP 403', apis: BOTH_APIS });
  const warnings = [];
  const rebuilt = await runSdkBuild(spec, { sdk, genpage: fakeGenpage(), appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, warn: (m) => warnings.push(m) });
  assert.ok(rebuilt.ok);
  assert.deepStrictEqual(bindingWords(warnings), ['could not read this environment\'s connection references (HTTP 403), so the connector bindings of page "Weather" were not checked against them']);
});

// Exercise the real client's refusal bookkeeping at the SDK read boundary: a best-effort binding read catches its HTTP error, but the attempt must still stop before its first mutation.
async function failedBindingPreflight(entity, statusCode, earlierRefusal) {
  const { spec, outDir } = await portableCopy();
  const references = entity === 'connector'
    ? [{ connectionreferencelogicalname: WIDGETS_BINDING.logicalName, connectorid: WIDGETS_BINDING.connectorId, connectionid: 'shared-widgets-0001', _customconnectorid_value: WIDGETS_CONNECTOR_ID }]
    : BOTH_REFERENCES;
  if (entity === 'connector') spec.pages.find((p) => p.key === 'weather').connectorBindings = [WIDGETS_BINDING];
  const { sdk, writes } = targetEnvironment({ references, apis: BOTH_APIS });
  const throttle = makeThrottleBudget();
  if (earlierRefusal) throttle.decline({ askedMs: 600000, waitMs: 600000 });
  const requests = [];
  const http = createAzHttpClient(FABRIKAM, {
    getToken: () => 'SYNTHETIC_BINDING_PREFLIGHT_TOKEN',
    throttle,
    now: () => 0,
    random: () => 0,
    sleep: async () => { assert.fail('a refused wait or a permanent metadata failure must not sleep'); },
    request: async (request) => {
      requests.push({ method: request.method, url: request.url });
      return { statusCode, headers: statusCode === 429 ? { 'retry-after': '600' } : {}, body: JSON.stringify({ error: { message: 'Metadata unavailable' } }) };
    },
  });
  const query = sdk.queryRecords;
  sdk.queryRecords = async (logical, options) => {
    if (logical !== entity) return query(logical, options);
    const response = await http.get(`${FABRIKAM}/api/data/v9.2/${logical}`);
    throw Object.assign(new Error(`HTTP ${response.status}`), { statusCode: response.status });
  };
  const genpage = fakeGenpage();
  const warnings = [];
  const events = [];
  return {
    spec, throttle, writes, genpage, requests, warnings, events,
    opts: { sdk, genpage, appDir: outDir, env: FABRIKAM, apply: true, phases: PHASES, throttle, warn: (m) => warnings.push(m), emit: (event) => events.push(event) },
  };
}

for (const entity of ['connectionreference', 'customapi', 'connector']) {
  test(`a refused preflight wait from ${entity} halts before any SDK or page mutation`, async () => {
    for (const earlierRefusal of [false, true]) {
      const f = await failedBindingPreflight(entity, 429, earlierRefusal);
      const halt = await runSdkBuild(f.spec, f.opts).then(() => null, (error) => error);
      assert.deepStrictEqual(f.requests, [{ method: 'GET', url: `${FABRIKAM}/api/data/v9.2/${entity}` }], 'the throttled request was sent once and never resent');
      assert.deepStrictEqual(f.throttle.declined(), { count: Number(earlierRefusal) + 1, askedMs: 600000, waitMs: 600000 });
      assert.strictEqual(halt && halt.code, 'throttle-budget-exhausted', 'a refused preflight wait must stop before any mutation');
      assert.ok(halt instanceof BuildHalt);
      assert.strictEqual(halt.phase, 'preflight');
      assert.strictEqual(halt.statusCode, 429);
      assert.match(halt.message, /the service asked to wait 600 s/);
      assert.deepStrictEqual(f.writes, [], 'no SDK mutation, including solution or manifest writes');
      assert.deepStrictEqual(f.genpage.calls, [], 'no page read, create, update, placement, removal or delete');
      assert.deepStrictEqual(f.events, [], 'no mutation step started');
    }
  });

  test(`an unchecked ${entity} read still permits mutation when no new throttle wait is refused`, async () => {
    for (const earlierRefusal of [false, true]) {
      const f = await failedBindingPreflight(entity, 403, earlierRefusal);
      assert.ok((await runSdkBuild(f.spec, f.opts)).ok);
      assert.deepStrictEqual(f.requests, [{ method: 'GET', url: `${FABRIKAM}/api/data/v9.2/${entity}` }], 'a permanent metadata failure was not resent');
      assert.strictEqual(f.throttle.declined().count, Number(earlierRefusal), 'no refusal belongs to this attempt');
      assert.ok(f.warnings.some((m) => /HTTP 403/.test(m) && /not checked/.test(m)), 'unavailable metadata is still reported as unchecked');
      assert.ok(f.writes.length > 0, 'the build continues past an ordinary unchecked read');
      assert.strictEqual(f.genpage.of('create').length, 2, 'the pages are still created, even after an earlier attempt refused a wait');
    }
  });
}

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
