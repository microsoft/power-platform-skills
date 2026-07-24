'use strict';
// Regression test for Critical #1: after migrateAppSpec moves the top-level `codeFile` into
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
      if (e === 'sitemap') return [{ sitemapid: 'sm-1' }];
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
    getArtifact: (t, id) => { calls.push({ name: 'getArtifact', args: [t, id] }); return store[`${t}:${id}`] || { id }; },
    addElement: (t, id, ptr, el) => { calls.push({ name: 'addElement', args: [t, id, ptr, el] }); return {}; },
    updateElement: (t, id, ptr, patch) => { calls.push({ name: 'updateElement', args: [t, id, ptr, patch] }); return {}; },
    removeElement: (t, id, ptr) => { calls.push({ name: 'removeElement', args: [t, id, ptr] }); return {}; },
    pushArtifact: async (t, id) => { calls.push({ name: 'pushArtifact', args: [t, id] }); return { type: t, id, success: true }; },
    addSolutionComponent: async (o) => { calls.push({ name: 'addSolutionComponent', args: [o] }); },
    publishArtifact: async (t, id) => { calls.push({ name: 'publishArtifact', args: [t, id] }); },
  };
  return { sdk, calls };
}

// RED before fix: `migrateAppSpec` moves `codeFile` out of p (into p.source.codeFile).
// The pages phase then reads the now-undefined `p.codeFile` → path.resolve throws → BuildHalt.
// GREEN after fix: `normalizePageSource(p)` reads from `p.source.codeFile` → resolves correctly.
test('migrated legacy spec: pages phase does NOT throw and upload receives the correct codeFile path', async () => {
  const legacy = makeSpec();
  legacy.pages = [{ name: 'Overview', codeFile: 'overview.tsx', prompt: 'show kpis' }];

  // Migrate the spec — this moves p.codeFile → p.source.codeFile and sets schemaVersion: 2.
  const migrated = migrateAppSpec(legacy);
  assert.strictEqual(migrated.pages[0].source && migrated.pages[0].source.codeFile, 'overview.tsx', 'sanity: migration placed codeFile in source');
  assert.strictEqual(migrated.pages[0].codeFile, undefined, 'sanity: top-level codeFile deleted by migration');

  const { sdk } = mockSdk();
  const uploads = [];
  const genpageCli = {
    list: async () => [],
    enumerate: async () => ({ ok: true, pages: [], empty: true }),
    upload: async (o) => { uploads.push(o); return { pageId: 'gp-1' }; },
  };

  // (a) The build must NOT throw (before the fix it throws TypeError from path.resolve(dir, undefined)).
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-pages-'));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function O(){ return null; }', 'utf8');
  try {
    await assert.doesNotReject(
      runSdkBuild(migrated, {
        sdk, apply: true, env: 'https://x.dynamics.com', appDir,
        genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'],
      }),
      'runSdkBuild should not throw after migrateAppSpec'
    );

    // (b) The mock upload must receive a codeFile path that ends in the page's .tsx filename.
    assert.strictEqual(uploads.length, 1, 'exactly one page uploaded');
    assert.ok(
      uploads[0].codeFile.endsWith('overview.tsx') || uploads[0].codeFile.endsWith(path.sep + 'overview.tsx'),
      `upload codeFile should end in 'overview.tsx', got: ${uploads[0].codeFile}`
    );
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// Native v2 spec (no legacy codeFile, source.kind = 'tsx') must also upload correctly.
test('native v2 spec (source.kind tsx): pages phase resolves codeFile from source', async () => {
  const v2 = makeSpec();
  v2.schemaVersion = 2;
  v2.pages = [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } }];

  const { sdk } = mockSdk();
  const uploads = [];
  const genpageCli = {
    list: async () => [],
    enumerate: async () => ({ ok: true, pages: [], empty: true }),
    upload: async (o) => { uploads.push(o); return { pageId: 'gp-v2' }; },
  };

  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-pages-'));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default function O(){ return null; }', 'utf8');
  try {
    await assert.doesNotReject(
      runSdkBuild(v2, {
        sdk, apply: true, env: 'https://x.dynamics.com', appDir,
        genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'],
      }),
      'runSdkBuild should not throw for a native v2 spec'
    );

    assert.strictEqual(uploads.length, 1, 'exactly one page uploaded');
    assert.ok(
      uploads[0].codeFile.endsWith('overview.tsx') || uploads[0].codeFile.endsWith(path.sep + 'overview.tsx'),
      `upload codeFile should end in 'overview.tsx', got: ${uploads[0].codeFile}`
    );
  } finally { fs.rmSync(appDir, { recursive: true, force: true }); }
});

// A page with source.kind 'intent' (not yet implemented) should be SKIPPED without throwing.
test('intent page (no codeFile) is skipped — no upload, no throw', async () => {
  const v2 = makeSpec();
  v2.schemaVersion = 2;
  v2.pages = [{ key: 'ov', name: 'Overview', source: { kind: 'intent' } }];

  const { sdk } = mockSdk();
  const uploads = [];
  const genpageCli = {
    list: async () => [],
    enumerate: async () => ({ ok: true, pages: [], empty: true }),
    upload: async (o) => { uploads.push(o); return { pageId: 'gp-skip' }; },
  };
  const events = [];

  await assert.doesNotReject(
    runSdkBuild(v2, {
      sdk, apply: true, env: 'https://x.dynamics.com', appDir: process.cwd(),
      genpageCli, phases: ['solution', 'data-model', 'app-shell', 'pages'],
      emit: (e) => events.push(e),
    }),
    'intent page should not throw'
  );

  assert.strictEqual(uploads.length, 0, 'no upload for an intent page');
  // The skip event should be emitted so the plan log reflects it.
  assert.ok(events.some((e) => e.status === 'skip' && /Overview/.test(e.label)), 'skip event emitted for the intent page');
});
