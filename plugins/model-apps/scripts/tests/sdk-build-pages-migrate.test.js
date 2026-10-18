'use strict';
// Regression test: after migrateAppSpec moves the top-level `codeFile` into
// `source.codeFile`, the sdk-build pages phase must read from `source` (via normalizePageSource),
// not the now-missing top-level `p.codeFile`. Without the fix, path.resolve(appDir, undefined)
// throws a TypeError and the build halts on any spec with pages[].
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { migrateAppSpec } = require('../lib/app-spec.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { fakeGenpage } = require('./helpers/fake-genpage.js');

// Real GUIDs for the three-authority sitemap mock. These migrate specs have no page subareas, so
// membership resolves to a page-less EMPTY sitemap; the pages phase reconciles by env-wide EXISTENCE.
const APP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SELF_UNIQUE_VALUE = 'c0ffee00-0000-4000-8000-00000000dddd';
const SELF_SITEMAP_ID = '5111e0f2-0000-4000-8000-0000000000aa';
const EMPTY_SITEMAP_XML = '<SiteMap><Area><Group></Group></Area></SiteMap>';

// Minimal valid spec that can run solution + data-model + app-shell + pages.
// No page subareas in the appShell (keeps the test focused: no sitemap-finalize step needed).
function makeSpec() {
  return {
    solution: { uniqueName: 'ContosoMig', displayName: 'Contoso', publisherPrefix: 'contoso' },
    app: { name: 'Migration Test' },
    entities: [
      { schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
  };
}

// Minimal mock SDK — satisfies only the methods called by solution + data-model + app-shell + pages.
// Follows the exact same pattern as mockSdk() in sdk-build.test.js.
function mockSdk() {
  const calls = [];
  let idc = 0;
  const store = {};
  const sdk = {
    queryRecords: async (e, o) => {
      calls.push({ name: 'queryRecords', args: [e, o] });
      const filter = (o && o.filter) || '';
      if (e === 'appmodule') {
        const m = filter.match(/uniquename eq '([^']+)'/);
        if (m) return [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: m[1] }];
        return [{ appmoduleid: APP_ID, appmoduleidunique: SELF_UNIQUE_VALUE, uniquename: undefined }];
      }
      if (e === 'appmodulecomponent') return [{ objectid: SELF_SITEMAP_ID, componenttype: 62 }];
      if (e === 'sitemap') {
        if (/sitemapnameunique eq/.test(filter)) return [{ sitemapid: 'sm-1' }];
        return [{ sitemapxml: EMPTY_SITEMAP_XML }];
      }
      if (e === 'solution') return [];
      if (e === 'webresource') return [];
      if (e === 'systemform') return [];
      if (e === 'savedquery') return [{ savedqueryid: 'defview-x', isdefault: true }];
      return [{ publisherid: 'pub-1' }];
    },
    findArtifact: async (kind) => { calls.push({ name: 'findArtifact', args: [kind] }); return null; },
    fetchArtifact: async (t, id) => {
      calls.push({ name: 'fetchArtifact', args: [t, id] });
      if (!store[`${t}:${id}`]) store[`${t}:${id}`] = { id, siteMap: { areas: [] } };
      return store[`${t}:${id}`];
    },
    createPublisher: async (o) => { calls.push({ name: 'createPublisher', args: [o] }); return { id: 'pub-new' }; },
    createSolution: async (o) => { calls.push({ name: 'createSolution', args: [o] }); return { id: 'sol-1' }; },
    findTables: async () => { calls.push({ name: 'findTables' }); return []; },
    findColumns: async () => { calls.push({ name: 'findColumns' }); return []; },
    fetchEntityMetadata: async (logical) => { calls.push({ name: 'fetchEntityMetadata' }); return { logicalName: logical, entitySetName: `${logical}s`, attributes: [], relationships: [] }; },
    createTable: async (o) => { calls.push({ name: 'createTable', args: [o] }); return { logicalName: o.schemaName.toLowerCase(), entitySetName: `${o.schemaName.toLowerCase()}s`, metadataId: `tbl-${o.schemaName}` }; },
    createColumn: async (e, o) => { calls.push({ name: 'createColumn', args: [e, o] }); return { logicalName: o.schemaName.toLowerCase(), metadataId: `col-${o.schemaName}` }; },
    createRelationship: async (o) => { calls.push({ name: 'createRelationship', args: [o] }); return { schemaName: o.schemaName }; },
    createWebResource: async (o) => { calls.push({ name: 'createWebResource', args: [o] }); return { id: `wr-${++idc}`, name: o.name }; },
    updateWebResource: async (id, o) => { calls.push({ name: 'updateWebResource', args: [id, o] }); return {}; },
    enrichDefaultViews: async () => { calls.push({ name: 'enrichDefaultViews' }); return { updated: [] }; },
    createArtifact: (t, def) => {
      calls.push({ name: 'createArtifact', args: [t, def] });
      const id = `${t}-${++idc}`;
      const art = Object.assign({ id }, def);
      store[`${t}:${id}`] = art;
      return JSON.parse(JSON.stringify(art));
    },
    getArtifact: async (t, id) => { await Promise.resolve(); calls.push({ name: 'getArtifact', args: [t, id] }); return store[`${t}:${id}`] || { id }; },
    addElement: async (t, id, ptr, el) => { await Promise.resolve(); calls.push({ name: 'addElement', args: [t, id, ptr, el] }); return {}; },
    updateElement: async (t, id, ptr, patch) => { await Promise.resolve(); calls.push({ name: 'updateElement', args: [t, id, ptr, patch] }); return {}; },
    removeElement: async (t, id, ptr) => { await Promise.resolve(); calls.push({ name: 'removeElement', args: [t, id, ptr] }); return {}; },
    pushArtifact: async (t, id) => { calls.push({ name: 'pushArtifact', args: [t, id] }); return { type: t, id, saved: true, shipped: false, publish: { kind: 'notRequested' } }; },
    addSolutionComponent: async (o) => { calls.push({ name: 'addSolutionComponent', args: [o] }); },
    publishArtifact: async (t, id) => { calls.push({ name: 'publishArtifact', args: [t, id] }); return { type: t, id, shipped: true, publish: { kind: 'verified' } }; },
  };
  return { sdk, calls };
}

// RED before fix: `migrateAppSpec` moves `codeFile` out of p (into p.source.codeFile).
// The pages phase then reads the now-undefined `p.codeFile` → path.resolve throws → BuildHalt.
// GREEN after fix: `normalizePageSource(p)` reads from `p.source.codeFile` → resolves correctly.
test('migrated legacy spec: pages phase does NOT throw and the backend receives the text of the page\'s file', async () => {
  const legacy = makeSpec();
  legacy.pages = [{ name: 'Overview', codeFile: 'overview.tsx', prompt: 'show kpis' }];

  // Migrate the spec — this moves p.codeFile → p.source.codeFile and sets schemaVersion: 2.
  const migrated = migrateAppSpec(legacy);
  assert.strictEqual(migrated.pages[0].source && migrated.pages[0].source.codeFile, 'overview.tsx', 'sanity: migration placed codeFile in source');
  assert.strictEqual(migrated.pages[0].codeFile, undefined, 'sanity: top-level codeFile deleted by migration');

  const { sdk } = mockSdk();
  const genpage = fakeGenpage();

  // (a) The build must NOT throw (before the fix it throws TypeError from path.resolve(dir, undefined)).
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-pages-'));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function O(){ return null; }', 'utf8');
  try {
    await assert.doesNotReject(
      runSdkBuild(migrated, {
        sdk, apply: true, env: 'https://x.dynamics.com', appDir,
        genpage, phases: ['solution', 'data-model', 'app-shell', 'pages'],
      }),
      'runSdkBuild should not throw after migrateAppSpec'
    );

    // (b) The backend must receive the text of the file source.codeFile names.
    assert.strictEqual(genpage.of('create').length, 1, 'exactly one page created');
    const [created] = genpage.of('create')[0].args;
    assert.strictEqual(created.source, 'export default function O(){ return null; }', 'the page is written from the file the migrated spec names');
    assert.deepStrictEqual([created.name, created.prompt], ['Overview', 'show kpis']);
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// Native v2 spec (no legacy codeFile, source.kind = 'tsx') must also upload correctly.
test('native v2 spec (source.kind tsx): pages phase resolves codeFile from source', async () => {
  const v2 = makeSpec();
  v2.schemaVersion = 2;
  v2.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } }];

  const { sdk } = mockSdk();
  const genpage = fakeGenpage();

  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-pages-'));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function O(){ return null; }', 'utf8');
  try {
    await assert.doesNotReject(
      runSdkBuild(v2, {
        sdk, apply: true, env: 'https://x.dynamics.com', appDir,
        genpage, phases: ['solution', 'data-model', 'app-shell', 'pages'],
      }),
      'runSdkBuild should not throw for a native v2 spec'
    );

    assert.strictEqual(genpage.of('create').length, 1, 'exactly one page created');
    assert.strictEqual(genpage.of('create')[0].args[0].source, 'export default function O(){ return null; }');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// A page with source.kind 'intent' (not yet implemented) should be SKIPPED without throwing.
test('intent page (no codeFile) is skipped — nothing written, no throw', async () => {
  const v2 = makeSpec();
  v2.schemaVersion = 2;
  v2.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];

  const { sdk } = mockSdk();
  const genpage = fakeGenpage();
  const events = [];

  // The build opens its workspace in `<appDir>/.maker-workspace` when it is given none, so the app folder is one of the test's own, removed after it — never `process.cwd()`, which is the plugin's folder.
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-pages-'));
  try {
    await assert.doesNotReject(
      runSdkBuild(v2, {
        sdk, apply: true, env: 'https://x.dynamics.com', appDir,
        genpage, phases: ['solution', 'data-model', 'app-shell', 'pages'],
        emit: (e) => events.push(e),
      }),
      'intent page should not throw'
    );

    assert.deepStrictEqual([genpage.of('create').length, genpage.of('update').length], [0, 0], 'no page written for an intent page');
    // The skip event should be emitted so the plan log reflects it.
    assert.ok(events.some((e) => e.status === 'skip' && /Overview/.test(e.label)), 'skip event emitted for the intent page');
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});
