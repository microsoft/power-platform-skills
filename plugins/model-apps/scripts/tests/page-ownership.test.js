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
const { fakeGenpage } = require('./helpers/fake-genpage.js');
const { withPageType } = require('./helpers/page-component-type.js');
const { recordPageCreation, readPageOwnership, recordPagePending, readPendingCreations, checkPageOwnershipClearable, recordPageTeardown } = require('../lib/page-ownership-records.js');
const { sha256 } = require('../lib/hash.js');

// What the page backend was asked to write: a build that must not touch a page leaves this empty.
const writes = (genpage) => genpage.calls.filter((c) => c.method === 'create' || c.method === 'update');

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
// A sitemap whose navigation holds these pages. The entries sit where the platform keeps them, under SiteMap/Area/Group, which is where the teardown reads a navigation from.
const navigationXml = (ids) => `<SiteMap><Area><Group>${ids.map((id) => `<SubArea GenPageId="${id}" />`).join('')}</Group></Area></SiteMap>`;

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
  // The page table as the SAVED layer holds it (the layer teardown reads): a row is { uxagentprojectid, name }, plus
  //   draftOnly: true      the page was never published, so only the saved layer has a row for it (componentstate 1)
  //   publishedName        the page has a pending edit: the published layer still answers this name, the saved one `name`
  const rows = opts.rows || [
    { uxagentprojectid: OWN, name: 'Overview' },
    { uxagentprojectid: OTHER, name: 'Contoso Draft' },
  ];
  const savedRows = (asked) => rows.filter((r) => asked.includes(r.uxagentprojectid.toLowerCase())).flatMap((r) => {
    const { draftOnly, publishedName, ...row } = r;
    if (draftOnly) return [{ ...row, componentstate: 1 }];
    if (publishedName !== undefined) return [{ ...row, name: publishedName, componentstate: 0 }, { ...row, componentstate: 1 }];
    return [{ ...row, componentstate: 0 }];
  });
  // `appResolves` and `appLayerReads` count the lookups of the app in its saved layer (the SDK's app resolver, and the read of the app's current layer), `sitemapListReads` the read of every saved sitemap.
  const state = { app: opts.appPresent !== false, deletes: [], reads: [], resources: [], draftReads: 0, pageReads: [], appResolves: 0, appLayerReads: 0, sitemapListReads: 0 };
  const membership = opts.membership || [OWN];
  const sdk = {
    // The app as the SDK's resolver finds it: through the SAVED layer, so an app that was never published (`opts.neverPublished`) is found, though the published read below does not return it.
    resolveArtifact: async (kind, identity) => {
      if (kind === 'app') {
        state.appResolves += 1;
        if (opts.resolveError) throw new Error('Contoso app lookup unavailable');
        return state.app ? [{ id: APP, name: 'Contoso Pages', appModuleIdUnique: opts.neverPublished ? DRAFT_LAYER : LAYER }] : [];
      }
      if (kind === 'solution') return [{ id: 'solution-id', name: 'ContosoPages' }];
      if (kind === 'webResource') return [{ id: identity.name, name: identity.name }];
      return [];
    },
    queryRecords: async (entity, options) => {
      state.reads.push({ entity, options, appPresent: state.app });
      if (entity === 'webresource') return [{ webresourceid: 'manifest-id', content: Buffer.from(opts.corruptManifest ? '{' : JSON.stringify({ schemaVersion: 1, pages: candidates })).toString('base64') }];
      if (entity === 'appmodule') {
        if (opts.sitemapError) throw new Error('Contoso sitemap read unavailable');
        // A plain read answers the PUBLISHED layer, and an app that was never published has no row in it: it answers as it does for an app that does not exist.
        return state.app && !opts.neverPublished ? [{ appmoduleid: APP, appmoduleidunique: LAYER, uniquename: 'contoso_pages' }] : [];
      }
      if (entity === 'appmodulecomponent') {
        if (opts.componentError) throw new Error('Contoso sitemap component read unavailable');
        if (opts.componentRows !== undefined) return opts.componentRows;
        return opts.noSitemapComponent ? [] : [{ objectid: SITEMAP, componenttype: 62 }];
      }
      if (entity === 'sitemap') return state.app ? [{ sitemapxml: navigationXml(membership) }] : [];
      if (entity === 'uxagentproject') {
        // A plain read of the page table answers the PUBLISHED layer only: a page that was never published is not in it. Teardown must not decide what exists by this.
        return rows.filter((r) => !r.draftOnly && options.filter.includes(r.uxagentprojectid.toLowerCase()))
          .map((r) => ({ uxagentprojectid: r.uxagentprojectid, name: r.publishedName !== undefined ? r.publishedName : r.name }));
      }
      return [];
    },
    deleteAppCascade: async () => { state.app = false; return { success: true, deleted: [], failures: [] }; },
    // A page is deleted through the SDK's own delete (the project row, then the conversation history that points at it): the row is what `entity` names.
    //   deleteAnswers404: true    the DELETE answers "not found" and the page stays — what a by-id request that cannot see a draft-only row would do
    //   deleteAnswers404: 'gone'  the DELETE answers "not found" because the page IS gone (a cascade race, a maker who deleted it meanwhile)
    //   referenced: [id, …]       the pages another component still references: the platform refuses their DELETE and they stay
    deleteRemoteArtifact: async (kind, id) => {
      assert.equal(kind, 'genPage');
      state.deletes.push({ entity: 'uxagentproject', id });
      if ((opts.referenced || []).includes(id)) throw new Error(`The uxagentproject(${id}) component cannot be deleted because it is referenced by 1 other components.`);
      if (!opts.deleteAnswers404) return;
      if (opts.deleteAnswers404 === 'gone') rows.splice(rows.findIndex((r) => r.uxagentprojectid === id), 1);
      throw Object.assign(new Error(`HTTP 404 from DELETE /uxagentprojects(${id}): Does Not Exist`), { code: 'CONNECTION_ERROR', statusCode: 404 });
    },
    deleteWebResource: async (id) => { state.resources.push(id); },
    deleteSolution: async () => {},
    createWebResource: async () => ({ id: 'manifest-id' }),
    updateWebResource: async () => {},
    addSolutionComponent: async () => {},
  };
  // The app's CURRENT (saved, unpublished) layer, read through the Dataverse client as download reads it:
  // appmodules and sitemaps by RetrieveUnpublishedMultiple, e.g. { value: [{ appmoduleidunique, componentstate: 1 }] }.
  // By default it equals the published navigation (nothing pending), as on an environment with no unpublished edit.
  // The page table's component type is answered in front of it, uncounted: the build's pages join the spec's solution (lib/page-solution.js).
  if (!opts.noDataverse) {
    sdk.dataverse = {
      get: withPageType(async (url) => {
        // The pages in their saved layer, whichever of the rows the platform answers (see `rows` above). Not a read of the navigation, so it is not counted in `draftReads`.
        if (url.startsWith('/uxagentprojects/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()')) {
          state.pageReads.push(url);
          if (opts.nameError) throw new Error('Contoso page row read unavailable');
          // The read that follows a delete (`state.deletes` is not empty yet): the one that says whether a page is gone.
          if (opts.readBackError && state.deletes.length) throw new Error('Contoso page row read-back unavailable');
          if (Object.prototype.hasOwnProperty.call(opts, 'pageResponse')) return { status: 200, body: { value: opts.pageResponse } };
          return { status: 200, body: { value: savedRows(url.match(/uxagentprojectid eq [0-9a-f-]{36}/gi).map((clause) => clause.slice('uxagentprojectid eq '.length).toLowerCase())) } };
        }
        state.draftReads += 1;
        if (opts.draftError) return { status: 503, body: null };
        if (url.startsWith('/appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')) {
          state.appLayerReads += 1;
          // `layerRows` are the rows of the app's layers verbatim (to say two current layers, say). The app is not in either layer once it is deleted.
          if (opts.layerRows !== undefined) return { status: 200, body: { value: opts.layerRows } };
          return { status: 200, body: { value: state.app ? [{ appmoduleid: APP, appmoduleidunique: DRAFT_LAYER, componentstate: 1 }] : [] } };
        }
        if (url.startsWith('/sitemaps/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple')) {
          const ids = opts.draftMembership !== undefined ? opts.draftMembership : membership;
          const xml = navigationXml(ids);
          // The read of EVERY saved sitemap, which finds the one an app's name links to when no component does:
          //   { "value": [ { "sitemapid": "…", "sitemapnameunique": "contoso_pages", "componentstate": 1, "sitemapxml": "<SiteMap>…" } ] }
          if (url.includes('sitemapnameunique')) {
            state.sitemapListReads += 1;
            return { status: 200, body: { value: opts.savedSitemaps !== undefined ? opts.savedSitemaps(xml) : [{ sitemapid: SITEMAP, sitemapnameunique: 'contoso_pages', sitemapxml: xml, componentstate: 1 }] } };
          }
          return { status: 200, body: { value: [{ sitemapxml: xml, componentstate: 1 }] } };
        }
        throw new Error(`unexpected test read: ${url}`);
      }),
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
    const { sdk } = sdkForPages({
      candidates: manifest(OWN).pages, membership: [],
      ...(draft === 'saved' ? { draftMembership: [OWN] } : { draftError: true }),
    });
    const genpage = fakeGenpage({ pages: [{ pageId: OWN, name: 'Overview' }] });
    const s = spec();
    s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
    // The build binds by the published navigation or a receipt only: the shared-page scan reads other
    // apps' published navigation, so a page bound through the saved layer could be another app's too.
    await assert.rejects(runSdkBuild(s, {
      sdk, apply: true, appDir, workspaceDir: path.join(appDir, '.maker-workspace'), env: ENV, phases: ['pages'],
      changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
      genpage,
    }), (e) => {
      assert.equal(e.code, 'pages-identity-conflict');
      if (draft === 'saved') {
        // The page is in the saved navigation already, so what is left is publishing the app — which the verb that places a page does for a placement saved and never published.
        assert.match(e.message, new RegExp(`only in this app's saved but unpublished navigation: publish the app — node scripts/genpage\\.js add-to-app --env ${ENV} --app-id ${APP} --page-id ${OWN} publishes it, since the page is already in its saved navigation — then re-run\\.`));
        assert.doesNotMatch(e.message, /in the maker/, 'the maker is not sent to Maker for what the verb does');
        assert.doesNotMatch(e.message, /add it to the app's navigation/, 'it is already there');
      } else {
        assert.match(e.message, /saved but unpublished navigation could not be read/);
      }
      return true;
    });
    assert.deepEqual(writes(genpage), []);
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

// A create this app started and never acknowledged leaves a "pending" record under the id it used. The page it was sending can appear later than any build looked — the request lands after the build gave
// up on it, and by then the spec key may be bound to another page — and nothing else names it: no manifest entry, no receipt. Teardown finds it by the record, and deletes it as it deletes any page it can
// prove is this app's: the stored name is one the create sent. A page named otherwise is kept, and an id with no page keeps its record — the request may still land.
test('teardown finds and deletes a page that appeared under a retained pending id — named as the create sent it — and consumes that record; a page named otherwise is kept, and an id with no page keeps its record', async () => {
  const workspaceDir = workspace();
  const GONE = '77777777-7777-4777-8777-777777777777';
  const SENT = sha256('export default () => null;');
  recordPagePending(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV, SENT);
  recordPagePending(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview, renamed', ENV, SENT);
  recordPagePending(workspaceDir, 'contoso_pages', 'detail', OTHER, 'Detail', ENV, SENT);
  recordPagePending(workspaceDir, 'contoso_pages', 'gone', GONE, 'Gone', ENV, SENT);
  const { sdk, state } = sdkForPages({
    candidates: [], membership: [],
    rows: [{ uxagentprojectid: OWN, name: 'Overview, renamed' }, { uxagentprojectid: OTHER, name: 'Somebody else\'s page' }],
  });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }], 'the page named as one of the creates under its id sent it is deleted, and only that one');
  assert.deepEqual(r.deleted.genpage, [OWN]);
  const kept = r.skipped.join('\n');
  assert.match(kept, new RegExp(`${OTHER}[^\\n]*a create this app started under this id was never acknowledged, but the page is named "Somebody else's page", not what that create sent \\("Detail"\\)`));
  assert.match(kept, /inspect this id and remove it manually only if it is yours/);
  assert.deepEqual([...readPendingCreations(workspaceDir, 'contoso_pages', ENV).keys()].sort(), ['detail', 'gone'], 'the deleted page\'s records are consumed; the page that is not the one that was sent, and the id with no page, keep theirs');
  assert.deepEqual(readPageOwnership(workspaceDir, 'contoso_pages', ENV), { created: [], teardown: [] }, 'and the pre-delete proof that carried the page through a retry is gone with it');
  const clear = checkPageOwnershipClearable(workspaceDir);
  assert.equal(clear.ok, false, '--clear-workspace stays blocked by what is left');
  assert.match(clear.reason, new RegExp(`page ${OTHER}`));
  assert.match(clear.reason, new RegExp(`page ${GONE}`));
  assert.doesNotMatch(clear.reason, new RegExp(`page ${OWN}`));
  assert.match(clear.reason, /delete the record by hand once you have confirmed that no such page exists/);
});

test('teardown does not consume a pending record because its page is not there — a request that is still in flight can create it later', async () => {
  const workspaceDir = workspace();
  const GONE = '77777777-7777-4777-8777-777777777777';
  recordPagePending(workspaceDir, 'contoso_pages', 'overview', GONE, 'Overview', ENV, sha256('x'));
  // The manifest names the same id, so it is a candidate both ways and is "not found" by the ordinary rule — which consumes receipts and teardown records, not this.
  const { sdk, state } = sdkForPages({ candidates: [{ key: 'overview', name: 'Overview', pageId: GONE }], membership: [], rows: [] });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, []);
  assert.deepEqual([...readPendingCreations(workspaceDir, 'contoso_pages', ENV).keys()], ['overview'], 'the record is kept');
});

test('dry-run lists a page found under a pending id as one it would delete — and an id with no page is not listed as "not found": a pending record is not a manifest name', async () => {
  const workspaceDir = workspace();
  const GONE = '77777777-7777-4777-8777-777777777777';
  recordPagePending(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV, sha256('x'));
  recordPagePending(workspaceDir, 'contoso_pages', 'gone', GONE, 'Gone', ENV, sha256('x'));
  const { sdk, state } = sdkForPages({ candidates: [], membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  const r = await runTeardown(spec(), { apply: false, workspaceDir }, { sdk });
  const plan = r.plan.join('\n');
  assert.match(plan, new RegExp(`${OWN}[^\\n]*would delete`));
  assert.doesNotMatch(plan, new RegExp(GONE), 'an id no page answers to is not a candidate that was "not found"');
  assert.deepEqual(state.deletes, [], 'and a dry run deletes nothing');
});

test('a pending record alone authorizes no deletion: with the record, the page named as it was sent is deleted only through teardown\'s own proof — another environment\'s record and another app\'s grant nothing', async () => {
  const workspaceDir = workspace();
  recordPagePending(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', OTHER_ENV, sha256('x'));
  recordPagePending(workspaceDir, 'contoso_other', 'overview', OWN, 'Overview', ENV, sha256('x'));
  const { sdk, state } = sdkForPages({ candidates: [], membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [], 'a record for another environment, or for another app, proves nothing here');
});

// ── A page that was created and never published exists only in the SAVED layer ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A build killed after the create change set, a publish that was refused and never finished, a standalone create nobody published: each leaves a page with a row in the saved layer and none in the published one,
// and a plain read of the page table — which answers the published layer only — says "not found". Teardown decided what to delete by that read, so it kept the page and its conversation messages although a
// pending record or a receipt of this workspace named it, and it consumed the receipt as if the page were gone. The pages are read in the saved layer now (`rows[].draftOnly` is a page with no published row).
test('teardown finds and deletes a page that was created and never published, under a retained pending id — and consumes the record', async () => {
  const workspaceDir = workspace();
  recordPagePending(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV, sha256('x'));
  const { sdk, state } = sdkForPages({ candidates: [], membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview', draftOnly: true }] });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }], 'the page the create left is found by its record and deleted');
  assert.deepEqual(r.deleted.genpage, [OWN]);
  assert.strictEqual(readPendingCreations(workspaceDir, 'contoso_pages', ENV).size, 0, 'and the record is consumed: the page was found and deleted');
});

test('teardown deletes a receipted page that was never published, and keeps no receipt for a page it did not delete', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview', draftOnly: true }] });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }], 'a draft-only page is a page: the receipt corroborates it by its name');
  assert.deepEqual(readPageOwnership(workspaceDir, 'contoso_pages', ENV), { created: [], teardown: [] }, 'the receipt is consumed because the page was deleted, not because it was "not found"');
});

test('a page that was never published and that nothing proves is KEPT and named — not reported as "not found", and its receipt is not consumed', async () => {
  const workspaceDir = workspace();
  // A receipt for another key: it corroborates nothing for this page, which the manifest names under "overview".
  recordPageCreation(workspaceDir, 'contoso_pages', 'detail', OWN, 'Overview', ENV);
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview', draftOnly: true }] });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.deepEqual(state.deletes, [], 'nothing proves it is this app\'s');
  assert.match(r.skipped.join('\n'), new RegExp(`${OWN}[^\\n]*not proven to belong to this app`), 'it is found, and kept for the reason a published page would be');
  assert.doesNotMatch(r.skipped.join('\n'), /not found/);
  assert.equal(readPageOwnership(workspaceDir, 'contoso_pages', ENV).created.length, 1, 'the receipt stays: the page it names exists');
});

test('a page that was never published is proven by the saved navigation like any other, and a dry run lists it as one it would delete', async () => {
  const rows = [{ uxagentprojectid: OWN, name: 'Overview', draftOnly: true }];
  const dry = sdkForPages({ candidates: manifest(OWN).pages, membership: [], draftMembership: [OWN], rows });
  const plan = (await runTeardown(spec(), { apply: false }, { sdk: dry.sdk })).plan.join('\n');
  assert.match(plan, new RegExp(`${OWN}[^\\n]*would delete`));
  assert.doesNotMatch(plan, /not found/, 'a page that exists only as a draft is not "not found — manifest name only"');
  assert.deepEqual(dry.state.deletes, []);
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], draftMembership: [OWN], rows });
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }]);
});

test('teardown asks for the pages in their saved layer, in chunks — never the published-only collection', async () => {
  const workspaceDir = workspace();
  const ids = Array.from({ length: 120 }, (_, n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`);
  ids.forEach((id, n) => recordPagePending(workspaceDir, 'contoso_pages', `page${n}`, id, `Page ${n}`, ENV, sha256('x')));
  const { sdk, state } = sdkForPages({ candidates: [], membership: [], rows: ids.map((id, n) => ({ uxagentprojectid: id, name: `Page ${n}`, draftOnly: n % 2 === 0 })) });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(state.deletes.length, 120, 'every page is found, published or not');
  assert.equal(state.reads.filter((read) => read.entity === 'uxagentproject').length, 0, 'the published-only collection is not asked');
  assert.deepEqual(state.pageReads.map((url) => url.match(/uxagentprojectid eq/g).length), [50, 50, 20]);
  assert.ok(state.pageReads.every((url) => url.includes('$select=uxagentprojectid,name,componentstate')));
});

test('a page with a pending edit is judged by its current row — the authored one — not by the published row beside it', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  // The published row still holds "Overview"; the authored (saved) row holds what a maker renamed it to. The page is not named as this build named it any more.
  const renamed = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Renamed in the maker', publishedName: 'Overview' }] });
  const kept = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk: renamed.sdk });
  assert.deepEqual(renamed.state.deletes, []);
  assert.match(kept.skipped.join('\n'), /Renamed in the maker[^\n]*not proven/);
  // The authored row carries the name the spec asks for (an update whose publish failed): that is the page this build wrote.
  const written = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview', publishedName: 'Older name' }] });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk: written.sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(written.state.deletes, [{ entity: 'uxagentproject', id: OWN }]);
});

// ── An app that was never published has only its SAVED navigation ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The twin of the page section above, one level up. A plain read answers the PUBLISHED layer, and an app that was created and never published — a build killed before its publish, an app saved in the maker and left —
// has no row in it: the read of its sitemap answers "app not found", exactly as it does for an app that was deleted. Its navigation exists only in the saved layer, and a page stays a dependency of that navigation until
// the app and its sitemap are deleted. Teardown proved the pages of such an app by this workspace's records alone, so a page its navigation held, and no receipt or pending record named, was kept. The saved layer
// is read now, as that of a published app is when its published layer leaves a page unproven. `neverPublished: true` is an app with no published row; `draftMembership` is the navigation it saved.
const neverPublishedOpts = (extra = {}) => ({
  neverPublished: true,
  membership: [],
  draftMembership: [OWN, OTHER],
  // One page that is published, one that is a draft too: the app's own layer does not depend on the layer of its pages.
  rows: [{ uxagentprojectid: OWN, name: 'Overview' }, { uxagentprojectid: OTHER, name: 'Contoso Draft', draftOnly: true }],
  ...extra,
});

test("teardown deletes the pages a never-published app's saved navigation holds — the app has no published navigation to prove them by", async () => {
  const { sdk, state } = sdkForPages(neverPublishedOpts());
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.deepEqual(state.deletes.map((d) => d.id).sort(), [OWN, OTHER].sort(), 'both pages are in the app\'s navigation, and no record of this workspace is needed to say so');
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual([...r.deleted.genpage].sort(), [OWN, OTHER].sort());
  assert.equal(state.app, false, 'and then the app, whose sitemap held them');
  assert.ok(state.resources.some((id) => id.endsWith('_pagemanifest')), 'a clean pages step lets the manifest go');
  assert.equal(state.reads.filter((read) => read.entity === 'sitemap').length, 0, 'there is no published sitemap to read');
  assert.ok(state.draftReads > 0, 'the saved layer is what was read');
});

test("a page in a never-published app's navigation that another app still references is kept: the platform refuses its delete, and teardown does not force it", async () => {
  const { sdk, state } = sdkForPages(neverPublishedOpts({ referenced: [OTHER] }));
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.deepEqual(r.deleted.genpage, [OWN], 'only the page nothing else references is deleted');
  assert.deepEqual(state.deletes.map((d) => d.id).sort(), [OWN, OTHER].sort(), 'the other was put to the platform, which is the authority on what references it, and refused');
  assert.equal(r.ok, false, 'a proven page that is still there is not a clean teardown, as for a published app');
  assert.match(JSON.stringify(r.errors), new RegExp(`proven pages remain undeleted: ${OTHER}`));
  assert.ok(state.resources.every((id) => !id.endsWith('_pagemanifest')), 'and its manifest stays for a re-run');
});

test("a never-published app whose saved navigation holds none of the pages leaves the decision to this workspace's records, as before: a receipted page is deleted, the others are kept and named", async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'draft', OTHER, 'Contoso Draft', ENV);
  const { sdk, state } = sdkForPages(neverPublishedOpts({ draftMembership: [] }));
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OTHER }], 'the page the receipt and its stored name corroborate');
  assert.match(r.skipped.join('\n'), new RegExp(`${OWN}[^\\n]*not proven to belong to this app`), 'the page nothing proves is named, and left');
  assert.deepEqual(readPageOwnership(workspaceDir, 'contoso_pages', ENV), { created: [], teardown: [] }, 'the receipt of the deleted page is consumed');
});

test('a page that is in neither the saved navigation of a never-published app nor this workspace\'s records is kept, and a navigation that does not name it is not an error', async () => {
  const { sdk, state } = sdkForPages(neverPublishedOpts({ draftMembership: [OWN] }));
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }]);
  assert.match(r.skipped.join('\n'), new RegExp(`${OTHER}[^\\n]*not proven to belong to this app`));
});

test('a never-published app whose saved navigation cannot be read is an error that keeps every page — one this workspace holds a receipt for too — and the app stays for a re-run', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  const opts = neverPublishedOpts({ draftError: true });
  const { sdk, state } = sdkForPages(opts);
  const first = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.deepEqual(state.deletes, [], 'nothing is deleted while the navigation that would rule a page in or out cannot be read');
  assert.equal(first.ok, false);
  assert.equal(state.app, true, 'the app, and the sitemap that proves its pages, stay');
  assert.ok(state.resources.every((id) => !id.endsWith('_pagemanifest')));
  const said = first.errors.map((e) => e.message).join('\n');
  assert.match(said, /app sitemap unreadable \(the app was never published, so its navigation is the one it saved, and that could not be read: appmodule-query-failed: /);
  assert.match(said, new RegExp(`${OWN} "Overview" \\(kept\\)`), 'the pages are named, and kept');
  // Once it reads, the re-run finishes the cleanup, and the receipt goes with the page it named.
  opts.draftError = false;
  const second = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(second.ok, true, JSON.stringify(second.errors));
  assert.deepEqual(state.deletes.map((d) => d.id).sort(), [OWN, OTHER].sort());
  assert.deepEqual(readPageOwnership(workspaceDir, 'contoso_pages', ENV), { created: [], teardown: [] });
});

for (const [what, extra, reason] of [
  ['its sitemap component cannot be read', { componentError: true }, /sitemap-component-query-failed: Contoso sitemap component read unavailable/],
  ['its sitemap component is there and names no sitemap', { componentRows: [{ componenttype: 62 }] }, /sitemap-component-not-found: its sitemap component names no sitemap/],
  ['its saved layer is two current rows', { layerRows: [
    { appmoduleid: APP, appmoduleidunique: DRAFT_LAYER, componentstate: 1 },
    { appmoduleid: APP, appmoduleidunique: '77777777-7777-4777-8777-777777777777', componentstate: 1 },
  ] }, /appmodule-query-failed: no single current layer among 2 app row\(s\)/],
  ['the SDK cannot look it up in its saved layer', { resolveError: true }, /app sitemap unreadable \(appmodule-query-failed: Contoso app lookup unavailable\)/],
]) {
  test(`a never-published app whose navigation cannot be read because ${what} keeps every page, receipted or not, and the app`, async () => {
    const workspaceDir = workspace();
    recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
    const { sdk, state } = sdkForPages(neverPublishedOpts(extra));
    const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
    assert.deepEqual(state.deletes, []);
    assert.equal(r.ok, false);
    assert.equal(state.app, true);
    assert.match(r.errors.map((e) => e.message).join('\n'), reason);
    assert.equal(readPageOwnership(workspaceDir, 'contoso_pages', ENV).created.length, 1, 'the receipt stays: its page was not deleted');
  });
}

test('a never-published app with no sitemap component in its layer is read through the sitemap that carries its name — the link the SDK itself follows', async () => {
  const { sdk, state } = sdkForPages(neverPublishedOpts({ noSitemapComponent: true }));
  const r = await runTeardown(spec(), { apply: true }, { sdk });
  assert.deepEqual(state.deletes.map((d) => d.id).sort(), [OWN, OTHER].sort());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(state.sitemapListReads, 1, 'the one read of the saved sitemaps, which is how the name finds it');
});

test('a never-published app with no sitemap component and no sitemap of its name has no navigation: its pages are the records\' to decide, and nothing is an error', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'draft', OTHER, 'Contoso Draft', ENV);
  // A sitemap that another app's name carries is that app's, whatever it holds.
  const { sdk, state } = sdkForPages(neverPublishedOpts({
    noSitemapComponent: true,
    savedSitemaps: (xml) => [{ sitemapid: SITEMAP, sitemapnameunique: 'contoso_someone_else', sitemapxml: xml, componentstate: 1 }],
  }));
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OTHER }]);
  assert.match(r.skipped.join('\n'), new RegExp(`${OWN}[^\\n]*not proven to belong to this app`));
});

for (const [what, savedSitemaps] of [
  ['two sitemaps carry its name', (xml) => [
    { sitemapid: SITEMAP, sitemapnameunique: 'contoso_pages', sitemapxml: xml, componentstate: 1 },
    { sitemapid: '77777777-7777-4777-8777-777777777777', sitemapnameunique: 'CONTOSO_PAGES', sitemapxml: xml, componentstate: 1 },
  ]],
  ['the sitemap that carries its name has no XML', () => [{ sitemapid: SITEMAP, sitemapnameunique: 'contoso_pages', sitemapxml: '', componentstate: 1 }]],
  ['the sitemap that carries its name is cut short', () => [{ sitemapid: SITEMAP, sitemapnameunique: 'contoso_pages', sitemapxml: '<SiteMap><Area><Group><SubArea GenPageId="1111', componentstate: 1 }]],
  ['the saved sitemaps cannot be read', () => { throw new Error('Contoso saved sitemaps unavailable'); }],
]) {
  test(`a never-published app with no sitemap component, when ${what}, keeps every page and the app`, async () => {
    const workspaceDir = workspace();
    recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
    const { sdk, state } = sdkForPages(neverPublishedOpts({ noSitemapComponent: true, savedSitemaps }));
    const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
    assert.deepEqual(state.deletes, []);
    assert.equal(r.ok, false);
    assert.equal(state.app, true);
    assert.match(r.errors.map((e) => e.message).join('\n'), /app sitemap unreadable \(the app was never published, so its navigation is the one it saved, and that could not be read: /);
  });
}

test("a dry run lists the pages a never-published app's saved navigation holds as ones it would delete, and deletes nothing", async () => {
  const { sdk, state } = sdkForPages(neverPublishedOpts());
  const r = await runTeardown(spec(), { apply: false }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const plan = r.plan.join('\n');
  assert.match(plan, new RegExp(`${OWN}[^\\n]*would delete`));
  assert.match(plan, new RegExp(`${OTHER}[^\\n]*would delete`));
  assert.doesNotMatch(plan, /not proven|kept/);
  assert.deepEqual(state.deletes, []);
  assert.equal(state.app, true);
  assert.equal(state.appResolves, 1, 'one look for the app in its saved layer');
});

test('a dry run says that the saved navigation of a never-published app could not be read, lists every page as kept for that reason, and fails', async () => {
  const { sdk, state } = sdkForPages(neverPublishedOpts({ draftError: true }));
  const r = await runTeardown(spec(), { apply: false }, { sdk });
  assert.equal(r.ok, false);
  const plan = r.plan.join('\n');
  for (const id of [OWN, OTHER]) assert.match(plan, new RegExp(`${id}[^\\n]*kept — page proof unreadable: app sitemap unreadable \\(the app was never published, so its navigation is the one it saved, and that could not be read: appmodule-query-failed`));
  assert.doesNotMatch(plan, /would delete/);
  assert.deepEqual(state.deletes, []);
});

// Where the published layer answers, nothing changes — and an app that is in neither layer is still the records' to decide.
test('an app that is in neither layer — the re-run of a teardown that deleted it — is left to the records of this workspace, as before', async () => {
  const workspaceDir = workspace();
  recordPageTeardown(workspaceDir, 'contoso_pages', [{ id: OWN, key: 'overview', name: 'Overview' }], ENV);
  const { sdk, state } = sdkForPages({ appPresent: false, rows: [{ uxagentprojectid: OWN, name: 'Overview' }, { uxagentprojectid: OTHER, name: 'Contoso Draft' }] });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }], 'the page this workspace proved before the app went');
  assert.match(r.skipped.join('\n'), new RegExp(`${OTHER}[^\\n]*not proven to belong to this app`));
  assert.deepEqual(readPageOwnership(workspaceDir, 'contoso_pages', ENV), { created: [], teardown: [] });
});

test('an app that is in neither layer costs one look for it in the saved layer and no read of any navigation', async () => {
  const workspaceDir = workspace();
  recordPageTeardown(workspaceDir, 'contoso_pages', [{ id: OWN, key: 'overview', name: 'Overview' }], ENV);
  const { sdk, state } = sdkForPages({ appPresent: false, rows: [{ uxagentprojectid: OWN, name: 'Overview' }, { uxagentprojectid: OTHER, name: 'Contoso Draft' }] });
  await runTeardown(spec(), { apply: false, workspaceDir }, { sdk });
  assert.equal(state.appResolves, 1);
  assert.equal(state.appLayerReads, 0);
  assert.equal(state.draftReads, 0);
});

test('a published app is not looked for in its saved layer by the proof: its published navigation names every page, or the one read of its saved navigation follows', async () => {
  // Every page proven by the published navigation: no read of the saved layer at all.
  const proven = sdkForPages({ candidates: manifest(OWN).pages, draftMembership: [OWN], rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  await runTeardown(spec(), { apply: false }, { sdk: proven.sdk });
  assert.equal(proven.state.appResolves, 0);
  assert.equal(proven.state.draftReads, 0);
  // A page the published navigation does not name: the saved layer of the app that IS published is read, through the app's own id.
  const unproven = sdkForPages({ draftMembership: [OWN, OTHER] });
  const r = await runTeardown(spec(), { apply: false }, { sdk: unproven.sdk });
  assert.equal(unproven.state.appResolves, 0, 'it is a published app: the published read found it, and nothing asks whether it was ever published');
  assert.equal(unproven.state.appLayerReads, 1);
  assert.match(r.plan.join('\n'), new RegExp(`${OTHER}[^\\n]*would delete`));
});

test('pages that are not in the environment cost no read of the app at all', async () => {
  const { sdk, state } = sdkForPages(neverPublishedOpts({ rows: [] }));
  const r = await runTeardown(spec(), { apply: false }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(state.appResolves, 0);
  assert.equal(state.draftReads, 0);
  assert.equal(state.reads.filter((read) => read.entity === 'appmodule' || read.entity === 'sitemap').length, 0);
});

// What is NOT an app with no published layer stays what it was: every other answer of the published read keeps every page and the app, in the words it always used, and is never looked up in the saved layer.
for (const [what, extra, said] of [
  ['its published sitemap read fails', { sitemapError: true }, 'app sitemap unreadable (appmodule-query-failed: Contoso sitemap read unavailable)'],
  ['it has a published layer but no published sitemap component', { noSitemapComponent: true }, 'app sitemap unreadable (sitemap-component-not-found)'],
]) {
  test(`a published app whose navigation cannot be read because ${what} is kept whole, in the words it always was — it is not taken for an app that was never published`, async () => {
    const workspaceDir = workspace();
    recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
    const { sdk, state } = sdkForPages({ ...extra });
    const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
    assert.equal(r.ok, false);
    assert.deepEqual(state.deletes, []);
    assert.equal(state.app, true);
    assert.ok(r.errors.map((e) => e.message).join('\n').includes(said), `the message is ${said}`);
    assert.doesNotMatch(JSON.stringify(r), /never published/);
    assert.equal(state.appResolves, 0, 'the saved layer is not asked whether it was published: the published layer found it');
  });
}

// ── A "not found" from the DELETE of a page is not proof that the page is gone ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The SDK's delete sends DELETE /uxagentprojects(<id>) with no MSCRM.IncludeUnpublished header, and its own notes say a by-id request on a page that was never published answers 404 without it. Measured live,
// the platform DELETED such a row (afterwards the saved layer no longer held it and its messages were gone), so a "not found" for a draft-only page is insurance and not a known path. deleteStep reads a not-found
// answer as "already gone" for any handler that cannot check; for a page that consumed the receipt and the pending record and reported the page deleted while it stayed, with its conversation messages.
test('a "not found" from the DELETE of a page the saved layer still holds is not a delete — the step fails, and the receipt and the pending record stay', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  recordPagePending(workspaceDir, 'contoso_pages', 'later', OTHER, 'Later', ENV, sha256('x'));
  const { sdk, state } = sdkForPages({
    candidates: manifest(OWN).pages,
    membership: [],
    rows: [{ uxagentprojectid: OWN, name: 'Overview', draftOnly: true }, { uxagentprojectid: OTHER, name: 'Later', draftOnly: true }],
    deleteAnswers404: true,
  });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, false, 'a page that is still there is not a clean teardown');
  assert.deepEqual(r.deleted.genpage || [], [], 'and it is not reported deleted');
  assert.match(r.errors.map((e) => e.message).join('\n'), /404/, 'the platform\'s own answer is what the failure says');
  assert.deepEqual(readPageOwnership(workspaceDir, 'contoso_pages', ENV).created.map((x) => x.pageId), [OWN], 'its receipt is kept');
  assert.equal(readPendingCreations(workspaceDir, 'contoso_pages', ENV).size, 1, 'and so is the pending record of the other');
  assert.ok(state.pageReads.length >= 2, 'the saved layer was read again after the delete');
  assert.equal(state.reads.filter((read) => read.entity === 'uxagentproject').length, 0, 'and never through the published-only collection');
});

test('a "not found" from the DELETE of a page that IS gone — the saved layer no longer holds it — is a delete, and the receipt is consumed', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview', draftOnly: true }], deleteAnswers404: 'gone' });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.deleted.genpage, [OWN]);
  assert.deepEqual(readPageOwnership(workspaceDir, 'contoso_pages', ENV), { created: [], teardown: [] });
  assert.equal(state.deletes.length, 1);
});

test('a "not found" from the DELETE of a page whose read-back FAILS is not counted as deleted either — it cannot be proven gone', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  const { sdk } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview', draftOnly: true }], deleteAnswers404: 'gone', readBackError: true });
  const r = await runTeardown(spec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, false, 'a page that cannot be proven gone fails the step: "cannot prove it is gone" must not license consuming its receipt');
  assert.deepEqual(r.deleted.genpage || [], []);
  assert.equal(readPageOwnership(workspaceDir, 'contoso_pages', ENV).created.length, 1, 'the receipt stays');
});

// ── A receipt corroborates a page by the name the build proved, not only by the spec's current name ──────────────────────────────────────────────────────────────────────────────────────────
// A page the build adopted but did not use (its key is bound to another page) keeps the name the earlier create sent. When the spec renamed the entry since, the page still holds the receipt's name and
// not the spec's — and the build had told the user that teardown deletes it.
test('a receipt corroborates a page by the name it recorded when the spec has renamed the page since, and by no other name', async () => {
  const workspaceDir = workspace();
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  const renamedSpec = () => ({ ...spec(), pages: [{ key: 'overview', name: 'Summary' }] });
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Overview' }] });
  const r = await runTeardown(renamedSpec(), { apply: true, workspaceDir }, { sdk });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(state.deletes, [{ entity: 'uxagentproject', id: OWN }], 'named as the receipt recorded it');
  const other = workspace();
  recordPageCreation(other, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  const foreign = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Somebody else\'s page' }] });
  await runTeardown(renamedSpec(), { apply: true, workspaceDir: other }, { sdk: foreign.sdk });
  assert.deepEqual(foreign.state.deletes, [], 'a name that is neither the spec\'s nor the receipt\'s proves nothing');
  const current = sdkForPages({ candidates: manifest(OWN).pages, membership: [], rows: [{ uxagentprojectid: OWN, name: 'Summary' }] });
  const third = workspace();
  recordPageCreation(third, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  await runTeardown(renamedSpec(), { apply: true, workspaceDir: third }, { sdk: current.sdk });
  assert.deepEqual(current.state.deletes, [{ entity: 'uxagentproject', id: OWN }], 'and the spec\'s current name still does, as before');
});

test('an environment A creation receipt cannot authorize an off-sitemap build update in B', async (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-foreign-environment-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  const workspaceDir = path.join(appDir, '.maker-workspace');
  recordPageCreation(workspaceDir, 'contoso_pages', 'overview', OWN, 'Overview', ENV);
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
  const { sdk } = sdkForPages({ candidates: manifest(OWN).pages, membership: [] });
  const genpage = fakeGenpage({ pages: [{ pageId: OWN, name: 'Overview' }] });
  const s = spec();
  s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
  await assert.rejects(runSdkBuild(s, {
    sdk, apply: true, appDir, workspaceDir, env: OTHER_ENV, phases: ['pages'],
    changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
    genpage,
  }), (e) => {
    assert.equal(e.code, 'pages-identity-conflict');
    assert.ok(e.message.includes(OWN));
    assert.match(e.message, /this workspace holds no record that this app created it/);
    // The two ways on, each as a command: place the page (which publishes the app and proves the page in what runs), or delete it — after asking, and with the confirmation the script requires.
    assert.ok(e.message.includes(`if it is this app's page, add it to the app's navigation with node scripts/genpage.js add-to-app --env ${OTHER_ENV} --app-id ${APP} --page-id ${OWN} (it publishes the app and proves the page in what runs) and re-run`), e.message);
    assert.ok(e.message.includes(`if not, remove the stale id from the manifest/spec (or delete the page, after asking the user — it is permanent: node scripts/genpage.js delete --env ${OTHER_ENV} --page-id ${OWN} --allow-destructive) and re-run`), e.message);
    assert.doesNotMatch(e.message, /in the maker/, 'the maker is not sent to Maker for what a verb does');
    return true;
  });
  assert.deepEqual(writes(genpage), []);
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
    const { sdk } = sdkForPages({ candidates: [], membership: [] });
    const genpage = fakeGenpage();
    const s = spec();
    s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
    await assert.rejects(runSdkBuild(s, {
      sdk, apply: true, appDir, workspaceDir, env: ENV, phases: ['pages'],
      changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
      genpage,
    }), (e) => {
      assert.equal(e.code, 'pages-identity-conflict');
      assert.ok(e.message.includes(file));
      assert.match(e.message, /is not a readable page-ownership record.*inspect it/);
      return true;
    });
    assert.deepEqual(writes(genpage), []);
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
  const { sdk } = sdkForPages({ candidates: [], membership: [] });
  // The page this run creates joins the environment the backend lists, as a real create does.
  const genpage = fakeGenpage({ newId: () => OWN });
  const s = spec();
  s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
  sdk.updateWebResource = async () => {
    assert.equal(readPageOwnership(workspaceDir, 'contoso_pages', ENV).created[0]?.pageId, OWN);
    throw new Error('stop after creation receipt');
  };
  const options = {
    sdk, apply: true, appDir, workspaceDir, env: ENV, phases: ['pages'],
    changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
    genpage,
  };
  await assert.rejects(runSdkBuild(s, options), /stop after creation receipt/);
  assert.deepEqual(writes(genpage).map((c) => c.method), ['create']);
  sdk.updateWebResource = async () => {};
  await runSdkBuild(s, options);
  assert.deepEqual(writes(genpage).map((c) => c.method), ['create', 'update']);
  assert.equal(genpage.of('update')[0].args[0], OWN, 'the second run updates the page the receipt names');
  assert.equal(readPageOwnership(workspaceDir, 'contoso_pages', ENV).created.length, 1, 'an update must not manufacture another creation receipt');
});

test('build halts on a same-name off-sitemap manifest candidate without local creation proof', async (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-no-receipt-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
  const { sdk } = sdkForPages({ candidates: manifest(OWN).pages, membership: [] });
  const genpage = fakeGenpage({ pages: [{ pageId: OWN, name: 'Overview' }] });
  const s = spec();
  s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
  await assert.rejects(runSdkBuild(s, {
    sdk, apply: true, appDir, env: ENV, workspaceDir: path.join(appDir, '.maker-workspace'), phases: ['pages'],
    changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
    genpage,
  }), (e) => e.code === 'pages-identity-conflict' && e.message.includes(OWN));
  assert.deepEqual(writes(genpage), []);
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
      './lib/maker-sdk.js': {
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

// A page the app's sitemap does not prove is bound only by a creation receipt and its stored name, and the stored name is read from the environment's page list: each
// page's name exactly as its own row has it. A name the list does not carry is unreadable proof, said so in the halt — and neither way is a page the build adopts or recreates.
for (const [what, listed, says] of [
  ['the list carries its name', { pageId: OTHER, name: 'Overview' }, null],
  ['the list carries no name for it', { pageId: OTHER, name: '' }, /stored-name reads failed: .*stored page name is unreadable/],
]) {
  test(`build halts rather than recreating an unproven manifest id (${what})`, async (t) => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-page-proof-'));
    t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
    const { sdk } = sdkForPages({ candidates: manifest().pages, membership: [] });
    const genpage = fakeGenpage({ pages: [listed] });
    const s = spec();
    s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
    await assert.rejects(runSdkBuild(s, {
      sdk, apply: true, env: ENV, appDir, phases: ['pages'],
      changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
      genpage,
    }), (e) => e.code === 'pages-identity-conflict' && /unproven-manifest-id/.test(e.message) && (!says || says.test(e.message)));
    assert.deepEqual(writes(genpage), []);
  });
}

test('build never reads a page row one at a time: a page this app\'s sitemap proves needs no stored name, and the names that are needed come from the one page list', async (t) => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-page-names-'));
  t.after(() => fs.rmSync(appDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
  const { sdk, state } = sdkForPages({ candidates: manifest(OWN).pages });
  const genpage = fakeGenpage({ pages: [{ pageId: OWN, name: 'Overview' }] });
  const s = spec();
  s.pages[0].source = { kind: 'tsx', codeFile: 'overview.tsx' };
  await runSdkBuild(s, {
    sdk, apply: true, env: ENV, appDir, phases: ['pages'],
    changedOnly: { resolvedAppId: APP, skipSitemapFinalize: true },
    genpage,
  });
  assert.equal(state.reads.filter((r) => r.entity === 'uxagentproject').length, 0);
  assert.equal(genpage.of('enumerateEnv').length, 1, 'one listing');
  assert.equal(genpage.of('update')[0].args[0], OWN);
});
