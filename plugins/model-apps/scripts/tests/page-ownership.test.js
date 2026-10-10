'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reconcilePageIds } = require('../lib/page-manifest.js');
const { runTeardown: realRunTeardown } = require('../lib/sdk-teardown.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { loadCli } = require('./helpers/cli-harness.js');
const { recordPageCreation, readPageOwnership } = require('../lib/page-ownership-records.js');

const workspaces = [];
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-page-ownership-'));
  workspaces.push(dir);
  return dir;
}
test.after(() => { for (const dir of workspaces) fs.rmSync(dir, { recursive: true, force: true }); });
const runTeardown = (s, opts, deps) => realRunTeardown(s, {
  env: ENV, ...opts, workspaceDir: Object.prototype.hasOwnProperty.call(opts, 'workspaceDir') ? opts.workspaceDir : workspace(),
}, deps);

const OWN = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const APP = '33333333-3333-4333-8333-333333333333';
const LAYER = '44444444-4444-4444-8444-444444444444';
const SITEMAP = '55555555-5555-4555-8555-555555555555';
const DRAFT_LAYER = '66666666-6666-4666-8666-666666666666';
const ENV = 'https://contoso.crm.dynamics.com';
const OTHER_ENV = 'https://fabrikam.crm.dynamics.com';

const spec = () => ({
  solution: { uniqueName: 'ContosoPages', publisherPrefix: 'contoso' },
  app: { name: 'Contoso Pages', uniqueName: 'contoso_pages' },
  pages: [{ key: 'overview', name: 'Overview' }],
});
const manifest = (id = OTHER) => ({ schemaVersion: 1, pages: [{ key: 'overview', name: 'Overview', pageId: id }] });

for (const pinned of [false, true]) {
  test(`manifest adoption refuses an unplaced id with another stored name (spec pin: ${pinned})`, () => {
    const page = { key: 'overview', name: 'Overview', ...(pinned ? { pageId: OTHER } : {}) };
    const r = reconcilePageIds([page], manifest(), [OTHER], [], new Map([[OTHER, 'Contoso Draft']]));
    assert.equal(r.keyToId.size, 0);
    assert.deepEqual(r.absentKeys, [], 'an unproven live id is a conflict, never a new-page request');
    assert.equal(r.conflicts[0]?.reason, 'unproven-manifest-id');
  });

  test(`manifest adoption refuses missing stored-name proof (spec pin: ${pinned})`, () => {
    const page = { key: 'overview', name: 'Overview', ...(pinned ? { pageId: OTHER } : {}) };
    const r = reconcilePageIds([page], manifest(), [OTHER], []);
    assert.equal(r.keyToId.size, 0);
    assert.equal(r.conflicts[0]?.reason, 'unproven-manifest-id');
    assert.deepEqual(r.absentKeys, []);
  });

  test(`manifest adoption refuses a matching name without a local creation receipt (spec pin: ${pinned})`, () => {
    const page = { key: 'overview', name: 'Overview', ...(pinned ? { pageId: OTHER } : {}) };
    const r = reconcilePageIds([page], manifest(), [OTHER.toUpperCase()], [], new Map([[OTHER.toUpperCase(), 'Overview']]));
    assert.equal(r.keyToId.size, 0);
    assert.deepEqual(r.absentKeys, []);
    assert.equal(r.conflicts[0]?.reason, 'unproven-manifest-id');
  });

  test(`manifest adoption accepts a local creation receipt with a corroborating name (spec pin: ${pinned})`, () => {
    const page = { key: 'overview', name: 'Overview', ...(pinned ? { pageId: OTHER } : {}) };
    const r = reconcilePageIds([page], manifest(), [OTHER], [], new Map([[OTHER, 'Overview']]), new Map([['overview', new Set([OTHER])]]));
    assert.equal(r.keyToId.get('overview'), OTHER);
    assert.deepEqual(r.conflicts, []);
  });

  test(`a local creation receipt cannot authorize another page key (spec pin: ${pinned})`, () => {
    const page = { key: 'overview', name: 'Overview', ...(pinned ? { pageId: OTHER } : {}) };
    const r = reconcilePageIds([page], manifest(), [OTHER], [], new Map([[OTHER, 'Overview']]), new Map([['detail', new Set([OTHER])]]));
    assert.equal(r.keyToId.size, 0);
    assert.equal(r.conflicts[0]?.reason, 'unproven-manifest-id');
  });
}

test('manifest adoption does not fold stored-name casing or use the manifest name as proof', () => {
  const r = reconcilePageIds(spec().pages, manifest(), [OTHER], [], new Map([[OTHER, 'overview']]));
  assert.equal(r.conflicts[0]?.reason, 'unproven-manifest-id');
  assert.equal(r.keyToId.size, 0);
});

test('this app sitemap proves a manifest page even when it has been renamed', () => {
  const r = reconcilePageIds(spec().pages, manifest(), [OTHER], [OTHER]);
  assert.equal(r.keyToId.get('overview'), OTHER);
  assert.deepEqual(r.conflicts, []);
});

function sdkForPages(opts = {}) {
  const candidates = opts.candidates || [
    { key: 'overview', name: 'Overview', pageId: OWN },
    { key: 'draft', name: 'Overview', pageId: OTHER },
  ];
  const rows = opts.rows || [
    { uxagentprojectid: OWN, name: 'Overview' },
    { uxagentprojectid: OTHER, name: 'Contoso Draft' },
  ];
  const state = { app: opts.appPresent !== false, deletes: [], reads: [], resources: [], uploads: [], draftReads: 0 };
  const membership = opts.membership || [OWN];
  const sdk = {
    resolveArtifact: async (kind, identity) => {
      if (kind === 'app') return state.app ? [{ id: APP, name: 'Contoso Pages', appModuleIdUnique: LAYER }] : [];
      if (kind === 'solution') return [{ id: 'solution-id', name: 'ContosoPages' }];
      if (kind === 'webResource') return [{ id: identity.name, name: identity.name }];
      return [];
    },
    queryRecords: async (entity, options) => {
      state.reads.push({ entity, options, appPresent: state.app });
      if (entity === 'webresource') return [{ webresourceid: 'manifest-id', content: Buffer.from(opts.corruptManifest ? '{' : JSON.stringify({ schemaVersion: 1, pages: candidates })).toString('base64') }];
      if (entity === 'appmodule') {
        if (opts.sitemapError) throw new Error('Contoso sitemap read unavailable');
        return state.app ? [{ appmoduleid: APP, appmoduleidunique: LAYER, uniquename: 'contoso_pages' }] : [];
      }
      if (entity === 'appmodulecomponent') return [{ objectid: SITEMAP, componenttype: 62 }];
      if (entity === 'sitemap') return state.app ? [{ sitemapxml: `<SiteMap>${membership.map((id) => `<SubArea GenPageId="${id}" />`).join('')}</SiteMap>` }] : [];
      if (entity === 'uxagentproject') {
        if (opts.nameError) throw new Error('Contoso page row read unavailable');
        if (Object.prototype.hasOwnProperty.call(opts, 'pageResponse')) return opts.pageResponse;
        return rows.filter((r) => options.filter.includes(r.uxagentprojectid.toLowerCase()));
      }
      return [];
    },
    deleteAppCascade: async () => { state.app = false; return { success: true, deleted: [], failures: [] }; },
    deleteRecord: async (entity, id) => { state.deletes.push({ entity, id }); },
    deleteWebResource: async (id) => { state.resources.push(id); },
    deleteSolution: async () => {},
    createWebResource: async () => ({ id: 'manifest-id' }),
    updateWebResource: async () => {},
    addSolutionComponent: async () => {},
  };
  // The app's CURRENT (saved, unpublished) layer, read through the Dataverse client as download reads it:
  // appmodules and sitemaps by RetrieveUnpublishedMultiple, e.g. { value: [{ appmoduleidunique, componentstate: 1 }] }.
  // By default it equals the published navigation (nothing pending), as on an environment with no unpublished edit.
  if (!opts.noDataverse) {
    sdk.dataverse = {
      get: async (url) => {
        state.draftReads += 1;
        if (opts.draftError) return { status: 503, body: null };
        if (url.startsWith('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')) {
          return { status: 200, body: { value: [{ appmoduleid: APP, appmoduleidunique: DRAFT_LAYER, componentstate: 1 }] } };
        }
        if (url.startsWith('/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')) {
          const ids = opts.draftMembership !== undefined ? opts.draftMembership : membership;
          const xml = `<SiteMap>${ids.map((id) => `<SubArea GenPageId="${id}" />`).join('')}</SiteMap>`;
          return { status: 200, body: { value: [{ sitemapxml: xml, componentstate: 1 }] } };
        }
        throw new Error(`unexpected test read: ${url}`);
      },
    };
  }
  return { sdk, state };
}

test('teardown keeps and reports a manifest-listed page without app membership or exact spec name', async () => {
  const { sdk, state } = sdkForPages();
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }]);
  const kept = r.skipped.join('\n');
  assert.match(kept, new RegExp(OTHER));
  assert.match(kept, /Contoso Draft/);
  assert.match(kept, /not proven.*local creation receipt/);
});

test('teardown captures this app sitemap before deleting the app', async () => {
  const { sdk, state } = sdkForPages({ rows: [{ uxagentprojectid: OWN, name: 'Renamed Overview' }] });
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.deepEqual(r.deleted.genpage, [OWN]);
  assert.ok(state.reads.some((r) => r.entity === 'sitemap' && r.appPresent));
});

test('teardown can remove a navigation member when the spec no longer lists pages', async () => {
  const { sdk, state } = sdkForPages();
  const s = spec();
  delete s.pages;
  await runTeardown(s, { apply: true }, { sdk });
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }]);
});

test('teardown keeps a same-name unplaced page nominated only by a remote manifest', async () => {
  const { sdk, state } = sdkForPages({ membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview \\"Home\\"' }] });
  const s = spec();
  s.pages[0].name = 'Overview "Home"';
  const r = await runTeardown(s, { apply: true }, { sdk });
  assert.deepEqual(state.deletes, []);
  assert.match(r.skipped.join('\n'), /not proven|no local.*receipt/i);
  assert.match(r.skipped.join('\n'), /manual|remove.*yourself/i);
});

// A page a maker saved into the app's navigation, but has not published, is this app's page: a download
// reads that layer and writes it, so the rebuild and the teardown must accept the same proof.
test("teardown deletes a page proven only by the app's saved but unpublished navigation", async () => {
  const { sdk, state } = sdkForPages({ membership: [OWN], draftMembership: [OWN, OTHER] });
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes.map((d) => d.id).sort(), [OWN, OTHER].sort());
  assert.ok(state.draftReads > 0);
});

test('an unreadable unpublished navigation keeps the app intact, and a re-run once it reads completes the cleanup', async () => {
  const opts = { draftError: true };
  const { sdk, state } = sdkForPages(opts);
  const workspaceDir = workspace();
  const first = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(first.ok, false);
  assert.deepEqual(state.deletes, [], 'nothing is deleted while a candidate can be neither proven nor ruled out');
  assert.equal(state.app, true, 'the app, its navigation and the manifest stay for the re-run');
  assert.match(first.errors.map((e) => e.message).join('\n'), new RegExp(`${OTHER}: cannot be proven or ruled out while the app's saved but unpublished navigation is unreadable`));
  opts.draftError = false;
  opts.draftMembership = [OWN, OTHER];
  const second = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.deepEqual(state.deletes.map((d) => d.id).sort(), [OWN, OTHER].sort());
});

test('a page in neither navigation layer is kept without stopping the teardown when both layers read', async () => {
  const { sdk, state } = sdkForPages({ draftMembership: [OWN] });
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }]);
  assert.match(r.skipped.join('\n'), new RegExp(`${OTHER}[^\\n]*not proven`));
});

test('teardown reads no unpublished navigation when the published one proves every page', async () => {
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, draftMembership: [OWN], rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  await runTeardown(spec(), { apply: true }, { sdk });
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }]);
  assert.equal(state.draftReads, 0);
});

for (const draft of ['saved', 'unreadable']) {
  test(`a manifest page only in the saved but unpublished navigation: build halts ${draft === 'saved' ? 'and says to publish the app first' : 'and says the layer was unreadable'}`, async (t) => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-draft-navigation-'));
    t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
    const { sdk, state } = sdkForPages({
      candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview' }],
      ...(draft === 'saved' ? { draftMembership: [OWN] } : { draftError: true }),
    });
    const s = spec();
    s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
    // The build binds by the published navigation or a receipt only: the shared-page scan reads other
    // apps' published navigation, so a page bound through the saved layer could be another app's too.
    await assert.rejects(runSdkBuild(s, {
      sdk, apply: true, appDir, workspaceDir: path.join(appDir, '.maker-workspace'), env: ENV, phases: ['pages'],
      changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
      genpageCli: {
        enumerateEnv: async () => ({ ok: true, ids: [OWN], pages: [] }),
        upload: async (o) => { state.uploads.push(o); return { pageId: OWN }; },
      },
    }), (e) => {
      assert.equal(e.code, 'pages-identity-conflict');
      if (draft === 'saved') {
        assert.match(e.message, /only in this app's saved but unpublished navigation: publish the app in the maker, then re-run/);
        assert.doesNotMatch(e.message, /add it to the app's navigation/, 'it is already there');
      } else {
        assert.match(e.message, /saved but unpublished navigation could not be read/);
      }
      return true;
    });
    assert.deepEqual(state.uploads, []);
  });
}

test('a corroborated local creation receipt permits off-sitemap deletion', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true);
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }]);
  assert.deepEqual(readPageOwnership(workspaceDir, 'contoso_pages', ENV), { created: [], teardown: [] });
});

test('no workspace cannot authorize a same-name off-sitemap candidate', async () => {
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  const r = await runTeardown(spec(), { apply: true, workspaceDir: null }, { sdk });
  assert.deepEqual(state.deletes, []);
  assert.match(r.skipped.join('\n'), /manually.*yours/i);
});

test('an environment A receipt cannot authorize or be consumed by teardown in B', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  const before = new Map(fs.readdirSync(workspaceDir).map((f) => [f, fs.readFileSync(path.join(workspaceDir, f), 'utf8')]));
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  const r = await runTeardown(spec(), { apply: true, workspaceDir, env: OTHER_ENV }, { sdk });
  assert.deepEqual(state.deletes, []);
  assert.match(r.skipped.join('\n'), /not proven/);
  assert.deepEqual(new Map(fs.readdirSync(workspaceDir).map((f) => [f, fs.readFileSync(path.join(workspaceDir, f), 'utf8')])), before);
});

test('confirmed absence in B leaves A creation and pending teardown records intact', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  require('../lib/page-ownership-records.js').recordPageTeardown(workspaceDir, 'contoso_pages', [{ id: OWN, key: 'overview', name: 'Overview' }], ENV);
  const before = new Map(fs.readdirSync(workspaceDir).map((f) => [f, fs.readFileSync(path.join(workspaceDir, f), 'utf8')]));
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [] });
  await runTeardown(spec(), { apply: true, workspaceDir, env: OTHER_ENV }, { sdk });
  assert.deepEqual(state.deletes, []);
  assert.deepEqual(new Map(fs.readdirSync(workspaceDir).map((f) => [f, fs.readFileSync(path.join(workspaceDir, f), 'utf8')])), before);
});

test('an environment A creation receipt cannot authorize an off-sitemap build update in B', async (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-foreign-environment-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  const workspaceDir = path.join(appDir, '.maker-workspace');
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  const s = spec();
  s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
  await assert.rejects(runSdkBuild(s, {
    sdk, apply: true, appDir, workspaceDir, env: OTHER_ENV, phases: ['pages'],
    changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
    genpageCli: {
      enumerateEnv: async () => ({ ok: true, ids: [OWN], pages: [] }),
      upload: async (o) => { state.uploads.push(o); return { pageId: OWN }; },
    },
  }), (e) => {
    assert.equal(e.code, 'pages-identity-conflict');
    assert.ok(e.message.includes(OWN));
    assert.match(e.message, /this workspace holds no record that this app created it/);
    assert.match(e.message, /add it to the app's navigation in the maker, publish the app and re-run/);
    assert.match(e.message, /remove the stale id from the manifest\/spec/);
    return true;
  });
  assert.deepEqual(state.uploads, []);
});

for (const schemaVersion of [1, 99, null]) {
  test(`an uninterpretable ownership record halts build before any create (${schemaVersion === null ? 'corrupt JSON' : `version ${schemaVersion}`})`, async (t) => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-unreadable-ownership-'));
    t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
    const workspaceDir = path.join(appDir, '.maker-workspace');
    fs.mkdirSync(workspaceDir);
    const record = { schemaVersion, kind: 'created', appUniqueName: 'contoso_pages', key: 'overview', pageId: OWN, name: 'Overview' };
    const identity = schemaVersion === 1 ? ['contoso_pages', 'overview', OWN] : ['unknown', 'contoso_pages', 'overview', OWN];
    const file = path.join(workspaceDir, `page-ownership.created.${require('../lib/hash.js').sha256(JSON.stringify(identity))}.json`);
    const contents = schemaVersion === null ? '{' : JSON.stringify(record);
    fs.writeFileSync(file, contents);
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
    const { sdk, state } = sdkForPages({ candidates: [], membership: [] });
    const s = spec();
    s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
    await assert.rejects(runSdkBuild(s, {
      sdk, apply: true, appDir, workspaceDir, env: ENV, phases: ['pages'],
      changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
      genpageCli: {
        enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
        upload: async (o) => { state.uploads.push(o); return { pageId: OWN }; },
      },
    }), (e) => {
      assert.equal(e.code, 'pages-identity-conflict');
      assert.ok(e.message.includes(file));
      assert.match(e.message, /is not a readable page-ownership record.*inspect it/);
      return true;
    });
    assert.deepEqual(state.uploads, []);
    assert.equal(fs.readFileSync(file, 'utf8'), contents, 'an unrecognized record is never consumed or replaced');
  });
}

test('no workspace refuses app deletion when navigation proof cannot be preserved', async () => {
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages });
  const r = await runTeardown(spec(), { apply: true, workspaceDir: null }, { sdk });
  assert.equal(r.ok, false);
  assert.equal(state.app, true);
  assert.deepEqual(state.deletes, []);
  assert.deepEqual(state.resources, []);
  assert.match(JSON.stringify(r), /workspace/);
});

test('a failed ownership-record write leaves the app and its pages intact', async (t) => {
  const workspaceDir = workspace();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).includes('page-ownership.teardown.')) throw Object.assign(new Error('local proof write refused'), { code: 'EACCES' });
    return rename(from, to);
  });
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, false);
  assert.equal(state.app, true);
  assert.deepEqual(state.deletes, []);
  assert.deepEqual(state.resources, []);
  assert.match(JSON.stringify(r), /proof write refused/);
});

test('a successful create is receipted before remote persistence and recovered even without a manifest entry', async (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-receipted-create-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  const workspaceDir = path.join(appDir, '.maker-workspace');
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
  const { sdk, state } = sdkForPages({ candidates: [], membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  const s = spec();
  s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
  sdk.updateWebResource = async () => {
    assert.equal(readPageOwnership(workspaceDir, 'contoso_pages', ENV).created[0]?.pageId, OWN);
    throw new Error('stop after creation receipt');
  };
  const options = {
    sdk, apply: true, appDir, workspaceDir, env: ENV, phases: ['pages'],
    changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
    genpageCli: {
      enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
      upload: async (o) => { state.uploads.push(o); return { pageId: OWN }; },
    },
  };
  await assert.rejects(runSdkBuild(s, options), /stop after creation receipt/);
  assert.equal(state.uploads.length, 1);
  assert.equal(state.uploads[0].pageId, undefined);
  sdk.updateWebResource = async () => {};
  options.genpageCli.enumerateEnv = async () => ({ ok: true, ids: [OWN], pages: [] });
  await runSdkBuild(s, options);
  assert.equal(state.uploads.length, 2);
  assert.equal(state.uploads[1].pageId, OWN);
  assert.equal(readPageOwnership(workspaceDir, 'contoso_pages', ENV).created.length, 1, 'an update must not manufacture another creation receipt');
});

test('build halts on a same-name off-sitemap manifest candidate without local creation proof', async (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-no-receipt-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
  const { sdk, state } = sdkForPages({
    candidates: manifest(OWN).pages, membership: [],
    rows: [{ uxagentprojectid: OWN, name: 'Overview' }],
  });
  const s = spec();
  s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
  await assert.rejects(runSdkBuild(s, {
    sdk, apply: true, appDir, env: ENV, workspaceDir: path.join(appDir, '.maker-workspace'), phases: ['pages'],
    changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
    genpageCli: {
      enumerateEnv: async () => ({ ok: true, ids: [OWN], pages: [] }),
      upload: async (o) => { state.uploads.push(o); return { pageId: OWN }; },
    },
  }), (e) => e.code === 'pages-identity-conflict' && e.message.includes(OWN));
  assert.deepEqual(state.uploads, []);
});

test('teardown keeps all candidates when the sitemap cannot be read', async () => {
  const { sdk, state } = sdkForPages({ sitemapError: true });
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.deepEqual(state.deletes, []);
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /sitemap.*unavailable|sitemap.*unreadable/);
  assert.match(JSON.stringify(r), new RegExp(OWN));
  assert.ok(state.resources.every((id) => !id.endsWith('_pagemanifest')));
});

test('teardown keeps a navigation member whose stored name is unreadable', async () => {
  const { sdk, state } = sdkForPages({ rows: [{ uxagentprojectid: OWN }] });
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.deepEqual(state.deletes, []);
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /name.*unreadable/);
});

test('teardown reports a failed page-row read without deleting candidates', async () => {
  const { sdk, state } = sdkForPages({ nameError: true });
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.deepEqual(state.deletes, []);
  assert.equal(r.ok, false);
  assert.match(JSON.stringify(r), /page row read unavailable/);
});

for (const pageResponse of [null, {}, [{ name: 'Overview' }]]) {
  test(`teardown refuses unreadable page-id results: ${JSON.stringify(pageResponse)}`, async () => {
    const { sdk, state } = sdkForPages({ pageResponse });
    const r = await runTeardown(spec(), { apply: true }, { sdk });
    assert.equal(r.ok, false);
    assert.deepEqual(state.deletes, []);
    assert.ok(state.resources.every((id) => !id.endsWith('_pagemanifest')));
    const dry = await runTeardown(spec(), { apply: false }, { sdk });
    assert.equal(dry.ok, false);
    assert.match(dry.plan.join('\n'), new RegExp(OWN));
    assert.match(dry.plan.join('\n'), new RegExp(OTHER));
    assert.match(dry.plan.join('\n'), /unreadable|could not check/);
  });
}

test('dry-run names every live manifest candidate by id and stored name and makes no writes', async () => {
  const { sdk, state } = sdkForPages();
  const r = await runTeardown(spec(), { apply: false }, { sdk });
  assert.match(r.plan.join('\n'), new RegExp(OWN));
  assert.match(r.plan.join('\n'), new RegExp(OTHER));
  assert.match(r.plan.join('\n'), /Overview/);
  assert.match(r.plan.join('\n'), /Contoso Draft/);
  assert.deepEqual(state.deletes, []);
  assert.deepEqual(state.resources, []);
  assert.equal(state.app, true);
});

test('dry-run also lists absent manifest candidates without claiming their stored names were read', async () => {
  const { sdk, state } = sdkForPages({ rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  const r = await runTeardown(spec(), { apply: false }, { sdk });
  const absent = r.plan.find((line) => line.includes(OTHER));
  assert.ok(absent, 'every manifest candidate must appear in the dry-run');
  assert.match(absent, /Overview/);
  assert.match(absent, /absent|not found/i);
  assert.match(absent, /manifest/i);
  assert.doesNotMatch(absent, /would delete/i);
  assert.deepEqual(state.deletes, []);
});

test('teardown CLI dry-run lists live and absent page candidates without changing the app', async () => {
  const { sdk, state } = sdkForPages({ rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  sdk.initWorkspace = async () => {};
  const s = {
    ...spec(),
    entities: [{
      schemaName: 'contoso_ticket', displayName: 'Ticket',
      primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
    }],
    pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview' }] }] }] },
  };
  const emissions = [];
  const cli = loadCli(path.resolve(__dirname, '..', 'teardown-model-app.js'), {
    argv: ['--env', ENV, '--spec', '@contoso-app-spec.json'],
    env: { POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    requires: {
      './lib/dataverse-auth.js': {
        ...require('../lib/dataverse-auth.js'),
        readJsonArg: () => s,
        emitResult: (ok, result) => { emissions.push({ ok, result }); },
      },
      './lib/sdk-http-client.js': { createAzHttpClient: () => ({}) },
      './vendor/cds-maker-sdk.cjs': {
        createMakerSdk: () => sdk,
        createNodeWorkspaceStorage: () => ({}),
      },
    },
  });
  await cli.main();
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].ok, true);
  assert.match(cli.stderrText(), new RegExp(OWN));
  assert.match(cli.stderrText(), new RegExp(OTHER));
  assert.match(cli.stderrText(), /Overview/);
  assert.deepEqual(state.deletes, []);
  assert.deepEqual(state.resources, []);
  assert.equal(state.app, true);
});

test('a present but unreadable manifest is preserved for a later teardown', async () => {
  const { sdk, state } = sdkForPages({ corruptManifest: true });
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.equal(r.ok, false);
  assert.deepEqual(state.deletes, []);
  assert.ok(state.resources.every((id) => !id.endsWith('_pagemanifest')));
});

for (const nameError of [false, true]) {
  test(`build halts rather than recreating an unproven manifest id (row read fails: ${nameError})`, async (t) => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-page-proof-'));
    t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
    const { sdk, state } = sdkForPages({ candidates: manifest().pages, membership: [], nameError });
    const s = spec();
    s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
    await assert.rejects(runSdkBuild(s, {
      sdk, apply: true, env: ENV, appDir, phases: ['pages'],
      changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
      genpageCli: {
        enumerateEnv: async () => ({ ok: true, ids: [OTHER], pages: [{ pageId: OTHER, name: 'Overview' }] }),
        upload: async (o) => { state.uploads.push(o); return { pageId: OTHER }; },
      },
    }), (e) => e.code === 'pages-identity-conflict' && /unproven-manifest-id/.test(e.message));
    assert.deepEqual(state.uploads, []);
  });
}

test('build reads stored names only for live manifest pages outside this app sitemap', async (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-page-names-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages });
  const s = spec();
  s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
  await runSdkBuild(s, {
    sdk, apply: true, env: ENV, appDir, phases: ['pages'],
    changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
    genpageCli: {
      enumerateEnv: async () => ({ ok: true, ids: [OWN], pages: [] }),
      upload: async (o) => { state.uploads.push(o); return { pageId: OWN }; },
    },
  });
  assert.equal(state.reads.filter((r) => r.entity === 'uxagentproject').length, 0);
  assert.equal(state.uploads[0].pageId, OWN);
});
