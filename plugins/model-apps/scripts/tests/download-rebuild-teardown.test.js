'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDownload } = require('../download-model-app.js');
const { migrateAppSpec, validateAppSpec } = require('../lib/app-spec.js');
const { runSdkBuild, appUniqueName } = require('../lib/sdk-build.js');
const { planTeardown } = require('../lib/sdk-teardown.js');
const { teardownModelApp } = require('../teardown-model-app.js');
const snapshot = require('../lib/apply-snapshot.js');
const snapshotStore = require('../lib/apply-snapshot-store.js');
const { makeSimpleMockSdk } = require('./helpers/mock-sdk.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP_ID = '11111111-0000-4000-8000-000000000001';
const FOREIGN_APP_ID = '11111111-0000-4000-8000-000000000002';
const APP_LOOKUP = '22222222-0000-4000-8000-000000000001';
const FOREIGN_LOOKUP = '22222222-0000-4000-8000-000000000002';
const SITEMAP_ID = '33333333-0000-4000-8000-000000000001';
const FOREIGN_SITEMAP_ID = '33333333-0000-4000-8000-000000000002';
const OVERVIEW_ID = '44444444-0000-4000-8000-000000000001';
const DETAIL_ID = '44444444-0000-4000-8000-000000000002';
const FOREIGN_PAGE_ID = '44444444-0000-4000-8000-000000000003';
const SOLUTION_ID = '55555555-0000-4000-8000-000000000001';
const APP_UNIQUE = 'contoso_originalapp';
const RELATIONSHIP = 'contoso_project_task';
const MANIFEST = `${APP_UNIQUE}_pagemanifest`;
const SHARED_ICON = `${APP_UNIQUE}_icon`;
const SHARED_HTML = 'contoso_shared.html';
const OWNED_ICON = 'contoso_owned.png';
const clone = (value) => JSON.parse(JSON.stringify(value));

function recordingLifecycleSdk({ systemOnly = false } = {}) {
  const { sdk } = makeSimpleMockSdk();
  const calls = [];
  const state = {
    failure: null,
    beforeDelete: () => {},
    tables: new Set(['contoso_project', 'contoso_task']),
    pages: new Set([OVERVIEW_ID, DETAIL_ID, FOREIGN_PAGE_ID]),
    resources: new Map(),
    apps: new Map(),
    solutions: new Map([
      ['Default', { solutionid: '55555555-0000-4000-8000-000000000002', uniquename: 'Default', ismanaged: false }],
      ['Active', { solutionid: '55555555-0000-4000-8000-000000000003', uniquename: 'Active', ismanaged: false }],
      ['Basic', { solutionid: '55555555-0000-4000-8000-000000000004', uniquename: 'Basic', ismanaged: false }],
      ...(!systemOnly ? [['ContosoOwnership', { solutionid: SOLUTION_ID, uniquename: 'ContosoOwnership', ismanaged: false }]] : []),
    ]),
  };
  state.apps.set(APP_UNIQUE, {
    id: APP_ID, name: 'Renamed Customer Console', uniquename: APP_UNIQUE, lookup: APP_LOOKUP, sitemapId: SITEMAP_ID,
    siteMap: { areas: [{ title: 'Main', icon: `/WebResources/${SHARED_ICON}`, groups: [{ title: 'Work', subAreas: [
      { type: 'Entity', entity: 'contoso_project', title: 'Projects', icon: SHARED_ICON },
      { type: 'Entity', entity: 'contoso_task', title: 'Tasks', icon: OWNED_ICON },
      { type: 'GenPage', genPageId: OVERVIEW_ID, title: 'Overview navigation' },
      { type: 'GenPage', genPageId: DETAIL_ID, title: 'Detail navigation' },
      { type: 'URL', url: `$webresource:${SHARED_HTML}`, title: 'Shared content' },
    ] }] }] },
  });
  // A display-name-derived identity would hit this unrelated app after a rename.
  state.apps.set('contoso_renamedcustomerconsole', {
    id: FOREIGN_APP_ID, name: 'Renamed Customer Console', uniquename: 'contoso_renamedcustomerconsole',
    lookup: FOREIGN_LOOKUP, sitemapId: FOREIGN_SITEMAP_ID,
    siteMap: { areas: [{ title: 'Other', groups: [{ title: 'Pages', subAreas: [{ type: 'GenPage', genPageId: FOREIGN_PAGE_ID }] }] }] },
  });
  const resource = (name, type, content, n) => state.resources.set(name, {
    name, webresourceid: `66666666-0000-4000-8000-${String(n).padStart(12, '0')}`,
    webresourcetype: type, content: Buffer.from(content, 'utf8').toString('base64'), ismanaged: false,
  });
  resource(SHARED_ICON, 11, '<svg/>', 1);
  resource(SHARED_HTML, 1, '<html>Shared</html>', 2);
  resource(OWNED_ICON, 5, 'synthetic image', 3);
  resource(MANIFEST, 3, JSON.stringify({ schemaVersion: 1, pages: [
    { key: 'overview', name: 'Overview', pageId: OVERVIEW_ID },
    { key: 'detail', name: 'Detail', pageId: DETAIL_ID },
  ] }), 4);
  resource('contoso_foreign.svg', 11, '<svg/>', 5);
  const appById = (id) => [...state.apps.values()].find((a) => a.id === id);
  sdk.initWorkspace = async () => {};
  sdk.listArtifacts = async () => [...state.apps.values()].map((a) => ({ id: a.id, isDirty: false }));
  sdk.findArtifact = async (kind, identity) => kind === 'app' ? state.apps.get(identity.uniqueName)?.id || null : null;
  sdk.fetchArtifact = async (kind, id) => { assert.strictEqual(kind, 'app'); return clone(appById(id)); };
  sdk.getArtifact = async (kind, id) => { assert.strictEqual(kind, 'app'); return clone(appById(id)); };
  sdk.updateElement = async (kind, id, pointer, value) => {
    assert.strictEqual(kind, 'app');
    assert.strictEqual(pointer, '/siteMap');
    appById(id).siteMap = clone(value);
    return clone(appById(id));
  };
  sdk.findTables = async (logical) => state.tables.has(String(logical).toLowerCase())
    ? [{ logicalName: String(logical).toLowerCase(), entitySetName: `${String(logical).toLowerCase()}s`, isCustom: true }] : [];
  sdk.findColumns = async () => [{ logicalName: 'contoso_name' }, { logicalName: 'contoso_projectid' }];
  sdk.fetchEntityMetadata = async (logical) => ({
    logicalName: logical, schemaName: logical, displayName: logical, primaryNameAttribute: 'contoso_name',
    entitySetName: `${logical}s`, attributes: [], relationships: [{ schemaName: RELATIONSHIP }],
  });
  sdk.getSolution = async (uniqueName) => ({ uniqueName, publisherPrefix: 'contoso' });
  sdk.dataverse = { get: async (url) => {
    const logical = (url.match(/LogicalName='([^']+)'/) || [])[1];
    if (url.includes('/ManyToOneRelationships')) return { status: 200, body: { value: logical === 'contoso_task' ? [{
      SchemaName: RELATIONSHIP, ReferencedEntity: 'contoso_project', ReferencingEntity: 'contoso_task',
      ReferencingAttribute: 'contoso_projectid', IsCustomRelationship: true,
    }] : [] } };
    if (url.includes('/LookupAttributeMetadata')) return { status: 200, body: { value: [] } };
    if (/\/(?:Attributes|ManyToManyRelationships)/.test(url)) return { status: 200, body: { value: [] } };
    assert.ok(state.tables.has(logical), `only declared table metadata may be read: ${url}`);
    return { status: 200, body: { LogicalName: logical, EntitySetName: `${logical}s` } };
  } };
  sdk.queryRecords = async (set, opts = {}) => {
    const filter = opts.filter || '';
    if (set === 'appmodule') {
      const uniqueName = (filter.match(/uniquename eq '([^']+)'/) || [])[1];
      const id = (filter.match(/appmoduleid eq (\S+)/) || [])[1];
      return [...state.apps.values()].filter((a) => (!uniqueName || a.uniquename === uniqueName) && (!id || a.id === id))
        .map((a) => ({ appmoduleid: a.id, appmoduleidunique: a.lookup, uniquename: a.uniquename }));
    }
    if (set === 'appmodulecomponent') {
      const app = [...state.apps.values()].find((a) => filter.includes(`_appmoduleidunique_value eq ${a.lookup}`));
      return app && /componenttype eq 62/.test(filter) ? [{ objectid: app.sitemapId, componenttype: 62 }] : [];
    }
    if (set === 'sitemap') {
      const app = [...state.apps.values()].find((a) => filter === `sitemapid eq ${a.sitemapId}` || filter === `sitemapnameunique eq '${a.uniquename}'`);
      if (!app) return [];
      const entries = app.siteMap.areas.flatMap((a) => a.groups.flatMap((g) => g.subAreas || []));
      return [{ sitemapid: app.sitemapId, sitemapxml: `<SiteMap><Area><Group>${entries.map((s) =>
        s.genPageId ? `<SubArea GenPageId="${s.genPageId}"/>` : s.entity ? `<SubArea Entity="${s.entity}"/>` : '').join('')}</Group></Area></SiteMap>` }];
    }
    if (set === 'solutioncomponent') {
      if (!filter.startsWith('objectid eq ')) return [];
      assert.strictEqual(filter, `objectid eq ${APP_ID}`, 'download scopes solution membership to this app');
      assert.strictEqual(opts.paginate, true);
      return [...state.solutions.values()].map((s) => ({ _solutionid_value: s.solutionid }));
    }
    if (set === 'solution') {
      const uniqueName = (filter.match(/uniquename eq '([^']+)'/) || [])[1];
      return [...state.solutions.values()].filter((s) => !uniqueName || s.uniquename === uniqueName);
    }
    if (set === 'webresource') {
      const name = (filter.match(/name eq '([^']+)'/) || [])[1];
      return state.resources.has(name) ? [state.resources.get(name)] : [];
    }
    if (set === 'uxagentproject') return [...state.pages].filter((id) => filter.includes(`uxagentprojectid eq ${id}`)).map((uxagentprojectid) => ({ uxagentprojectid }));
    return [];
  };
  sdk.createWebResource = async (o) => {
    resource(o.name, 3, o.content || '', state.resources.size + 1);
    return { id: state.resources.get(o.name).webresourceid, name: o.name };
  };
  sdk.updateWebResource = async (id, o) => {
    const row = [...state.resources.values()].find((r) => r.webresourceid === id);
    row.content = Buffer.from(o.content, 'utf8').toString('base64');
  };
  sdk.resolveArtifact = async (kind, identity) => {
    if (kind === 'app') {
      const app = state.apps.get(identity.uniqueName);
      return app ? [{ id: app.id, name: app.name, appModuleIdUnique: app.lookup }] : [];
    }
    if (kind === 'webResource') {
      const row = state.resources.get(identity.name);
      return row ? [{ id: row.webresourceid, name: row.name }] : [];
    }
    if (kind === 'solution') {
      const row = state.solutions.get(identity.uniqueName);
      return row ? [{ id: row.solutionid, name: row.uniquename }] : [];
    }
    return [];
  };
  sdk.deleteAppCascade = async (id, uniqueValue) => {
    state.beforeDelete();
    if (state.failure === 'app') throw new Error('offline atomic app delete failed');
    const app = appById(id);
    assert.strictEqual(app.lookup, uniqueValue);
    state.apps.delete(app.uniquename);
    return { success: true, deleted: [], failures: [] };
  };
  sdk.deleteRecord = async (set, id) => {
    state.beforeDelete();
    assert.strictEqual(set, 'uxagentproject', 'project files must never be deleted separately');
    if (state.failure === 'page') throw new Error('offline page delete failed');
    if (id === DETAIL_ID) throw new Error('The component cannot be deleted because it is referenced by 1 other components.');
    state.pages.delete(id);
  };
  sdk.deleteTable = async (logical) => { state.beforeDelete(); state.tables.delete(logical); };
  sdk.deleteRelationship = async () => { state.beforeDelete(); };
  sdk.deleteWebResource = async (id) => {
    state.beforeDelete();
    for (const [name, row] of state.resources) if (row.webresourceid === id) state.resources.delete(name);
  };
  sdk.deleteSolution = async (id) => {
    state.beforeDelete();
    for (const [name, row] of state.solutions) if (row.solutionid === id) state.solutions.delete(name);
  };
  for (const method of Object.keys(sdk)) {
    if (typeof sdk[method] !== 'function') continue;
    const original = sdk[method];
    sdk[method] = (...args) => { calls.push({ method, args }); return original(...args); };
  }
  const genpageCli = {
    enumerateEnv: async () => ({ ok: true, ids: [...state.pages], pages: [
      { pageId: OVERVIEW_ID, name: 'Overview' }, { pageId: DETAIL_ID, name: 'Detail' }, { pageId: FOREIGN_PAGE_ID, name: 'Detail' },
    ] }),
    download: async ({ appId, outputDir, pageIds }) => {
      assert.strictEqual(appId, APP_ID);
      assert.deepStrictEqual(pageIds.slice().sort(), [OVERVIEW_ID, DETAIL_ID]);
      for (const id of pageIds) {
        const dir = path.join(outputDir, id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'page.tsx'), 'export default function Page(){ return null; }', 'utf8');
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dataSources: ['contoso_project'] }), 'utf8');
      }
    },
    upload: async (o) => {
      calls.push({ method: 'upload', args: [o] });
      assert.strictEqual(o.appId, APP_ID);
      assert.ok([OVERVIEW_ID, DETAIL_ID].includes(o.pageId), 'rebuild updates only downloaded page IDs');
      return { pageId: o.pageId };
    },
  };
  return { sdk, genpageCli, calls, state };
}

test('downloaded ownership survives rebuild and teardown planning', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'download-rebuild-teardown-'));
  const previousPath = process.env.PATH;
  process.env.PATH = path.dirname(process.execPath);
  const prepare = async (systemOnly = false) => {
    const outDir = fs.mkdtempSync(path.join(root, 'app-'));
    const workspaceDir = path.join(outDir, '.maker-workspace');
    const fixture = recordingLifecycleSdk({ systemOnly });
    // runDownload invokes the real hydrateSpec. Serialize and migrate that output exactly as a
    // subsequent build loads it, so ownership cannot be rescued by a separately hand-authored spec.
    const downloaded = await runDownload({ sdk: fixture.sdk, genpageCli: fixture.genpageCli, outDir, appId: APP_ID, appUnique: APP_UNIQUE });
    assert.strictEqual(downloaded.ok, true, JSON.stringify(downloaded));
    assert.deepStrictEqual(downloaded.relationshipsSkipped, []);
    const specFile = path.join(outDir, 'app-spec.json');
    fs.writeFileSync(specFile, JSON.stringify(downloaded.spec), 'utf8');
    const spec = migrateAppSpec(JSON.parse(fs.readFileSync(specFile, 'utf8')));
    assert.strictEqual(validateAppSpec(spec, { profile: 'deploy' }).ok, true);
    assert.strictEqual(spec.solution.uniqueName, systemOnly ? 'Default' : 'ContosoOwnership');
    const rebuild = await runSdkBuild(spec, {
      sdk: fixture.sdk, apply: true, env: ENV, appDir: outDir, workspaceDir,
      preResolvedLanguageCode: 1033, genpageCli: fixture.genpageCli,
    });
    assert.strictEqual(rebuild.ok, true);
    assert.strictEqual(rebuild.created.app, APP_ID, 'a display-name rename cannot redirect the rebuild');
    assert.deepStrictEqual(rebuild.created.pages, { overview: OVERVIEW_ID, detail: DETAIL_ID });
    assert.ok(!fixture.calls.some((c) => ['createTable', 'createRelationship', 'enrichDefaultViews'].includes(c.method)),
      `reused tables and relationships are not recreated or enriched: ${JSON.stringify(fixture.calls.filter((c) => ['createTable', 'createRelationship', 'enrichDefaultViews'].includes(c.method)))}`);
    assert.strictEqual(spec.entities.every((e) => e.existing === true), true);
    assert.strictEqual(spec.relationships[0].existing, true);
    assert.deepStrictEqual(spec.webResources.filter((w) => w.external).map((w) => w.name).sort(), [SHARED_HTML, SHARED_ICON].sort());
    assert.strictEqual(appUniqueName(spec), APP_UNIQUE);
    const baseline = snapshot.makeEnvelope({
      orgId: '77777777-0000-4000-8000-000000000001', envUrl: ENV, appUniqueName: APP_UNIQUE, appId: APP_ID,
    }, { generation: 'download-baseline', priorSpec: spec });
    snapshot.markEligible(baseline);
    snapshotStore.writeSnapshotAtomic(workspaceDir, baseline);
    fixture.state.beforeDelete = () => {
      const disk = snapshotStore.readSnapshot(workspaceDir);
      assert.ok(snapshot.isTombstoned(disk), 'every remote delete must follow the real tombstone write');
      assert.strictEqual(disk.eligible, false);
      assert.notStrictEqual(disk.generation, baseline.generation, 'teardown fences any pending baseline CAS');
      assert.strictEqual(snapshotStore.teardownsInFlight(disk).length, 1);
    };
    fixture.calls.length = 0;
    return { ...fixture, spec, workspaceDir };
  };
  const assertReusedRetained = ({ calls, state }) => {
    assert.ok(!calls.some((c) => ['deleteTable', 'deleteRelationship', 'enrichDefaultViews'].includes(c.method)), 'retained tables and their lookups are never touched');
    assert.deepStrictEqual([...state.tables].sort(), ['contoso_project', 'contoso_task']);
    assert.ok(state.resources.has(SHARED_ICON), 'shared icon survives, including its generated-app-icon name collision');
    assert.ok(state.resources.has(SHARED_HTML), 'shared HTML resource survives');
    assert.ok(state.resources.has('contoso_foreign.svg'), 'undeclared resource survives');
    assert.ok(state.apps.has('contoso_renamedcustomerconsole'), 'namesake foreign app survives');
    assert.ok(state.pages.has(FOREIGN_PAGE_ID), 'foreign page outside the manifest survives');
  };
  try {
    const fixture = await prepare();
    const { sdk, spec, workspaceDir, calls, state } = fixture;
    const plan = planTeardown(spec);
    assert.deepStrictEqual(plan.filter((s) => s.kind === 'table').map((s) => s.target), [
      { logical: 'contoso_task', schemaName: 'contoso_task', existing: true },
      { logical: 'contoso_project', schemaName: 'contoso_project', existing: true },
    ], 'downloaded ownership survives child-first teardown planning');
    assert.strictEqual(plan[0].target.uniqueName, APP_UNIQUE);
    assert.strictEqual(plan[1].target.manifestName, MANIFEST);
    assert.deepStrictEqual(plan.filter((s) => s.kind === 'webResource').map((s) => s.target.name), [OWNED_ICON, MANIFEST], 'only app-owned resources are planned');
    assert.strictEqual(plan[plan.length - 1].kind, 'solution');
    const before = fs.readFileSync(snapshotStore.snapshotPath(workspaceDir));
    const dry = await teardownModelApp(spec, { apply: false, workspaceDir }, { sdk });
    assert.strictEqual(dry.ok, true);
    assert.strictEqual(dry.dryRun, true);
    assert.deepStrictEqual(calls, [], 'dry-run makes no SDK calls');
    const refused = await teardownModelApp(spec, { apply: true, workspaceDir }, { sdk });
    assert.strictEqual(refused.ok, false);
    assert.match(refused.errors.join(' '), /requires --allow-destructive/);
    assert.deepStrictEqual(calls, [], 'absence of destructive approval prevents every remote call');
    assert.deepStrictEqual(fs.readFileSync(snapshotStore.snapshotPath(workspaceDir)), before, 'approval refusal leaves eligibility untouched');

    const lease = snapshotStore.acquireLease(workspaceDir);
    assert.strictEqual(lease.ok, true);
    try {
      const blocked = await teardownModelApp(spec, { apply: true, allowDestructive: true, workspaceDir }, { sdk });
      assert.strictEqual(blocked.ok, false);
      assert.match(blocked.errors.join(' '), /could not fence.*nothing was deleted/);
      assert.deepStrictEqual(calls, [], 'tombstone contention prevents every remote call');
      assert.deepStrictEqual(fs.readFileSync(snapshotStore.snapshotPath(workspaceDir)), before);
    } finally { snapshotStore.releaseLease(lease); }

    const events = [];
    const clean = await teardownModelApp(spec, { apply: true, allowDestructive: true, workspaceDir }, { sdk, emit: (e) => events.push(e) });
    assert.strictEqual(clean.ok, true, JSON.stringify(clean.errors));
    assert.deepStrictEqual(clean.deleted.app, [APP_ID]);
    assert.deepStrictEqual(clean.deleted.genpage, [OVERVIEW_ID]);
    assert.ok(clean.skipped.some((s) => /still referenced/.test(s)), 'platform-held shared page is reported as retained, not deleted');
    assert.ok(clean.skipped.some((s) => /table contoso_task.*existing: true/.test(s)));
    assert.ok(clean.skipped.some((s) => /relationship contoso_project_task.*existing: true/.test(s)));
    const deletes = calls.filter((c) => c.method.startsWith('delete'));
    assert.deepStrictEqual(deletes.map((c) => c.method), ['deleteAppCascade', 'deleteRecord', 'deleteRecord', 'deleteWebResource', 'deleteWebResource', 'deleteSolution']);
    assert.deepStrictEqual(deletes[0].args, [APP_ID, APP_LOOKUP], 'atomic delete uses the resolved app and its unique lookup');
    assert.deepStrictEqual(deletes.filter((c) => c.method === 'deleteRecord').map((c) => c.args), [['uxagentproject', OVERVIEW_ID], ['uxagentproject', DETAIL_ID]]);
    assert.deepStrictEqual(events.filter((e) => e.status === 'start').map((e) => e.label), plan.map((s) => s.label), 'execution preserves the dependency-safe plan order');
    assertReusedRetained(fixture);
    assert.strictEqual(state.resources.has(OWNED_ICON), false, 'owned-icon positive control is deleted');
    assert.strictEqual(state.solutions.has('ContosoOwnership'), false, 'real solution positive control is deleted last');
    assert.strictEqual(snapshotStore.readSnapshot(workspaceDir), null, 'clean teardown removes the baseline');
    assert.strictEqual(fs.existsSync(snapshotStore.leasePath(workspaceDir)), false);

    for (const failure of ['app', 'page']) {
      const failedFixture = await prepare();
      failedFixture.state.failure = failure;
      const failedEvents = [];
      const failed = await teardownModelApp(failedFixture.spec, { apply: true, allowDestructive: true, workspaceDir: failedFixture.workspaceDir },
        { sdk: failedFixture.sdk, emit: (e) => failedEvents.push(e) });
      assert.strictEqual(failed.ok, false);
      assert.ok(failed.errors.some((e) => e.message.includes(failure === 'app' ? 'offline atomic app delete failed' : 'offline page delete failed')), JSON.stringify(failed.errors));
      assert.ok(failedEvents.some((e) => e.status === 'error' && e.detail.includes('offline')));
      assertReusedRetained(failedFixture);
      assert.ok(failedFixture.state.solutions.has('ContosoOwnership'), 'failure preserves the solution needed for a retry');
      const disk = snapshotStore.readSnapshot(failedFixture.workspaceDir);
      assert.ok(disk, 'a failed teardown leaves the snapshot present');
      assert.strictEqual(disk.eligible, false);
      assert.ok(snapshot.isTombstoned(disk), 'partial failure must retain the tombstone');
      assert.deepStrictEqual(snapshotStore.teardownsInFlight(disk), [], 'finished failures release their in-flight registration');
      if (failure === 'app') {
        assert.deepStrictEqual(failedFixture.calls.filter((c) => c.method.startsWith('delete')).map((c) => c.method), ['deleteAppCascade'], 'live app deletion failure aborts dependent deletes');
        assert.ok(failed.skipped.some((s) => /not attempted.*app was not deleted/.test(s)));
      } else {
        assert.ok(failedFixture.calls.some((c) => c.method === 'deleteWebResource'), 'page failure still cleans later app-owned resources');
        assert.ok(failed.skipped.some((s) => /solution.*earlier step\(s\) failed/.test(s)));
        assert.ok(failedFixture.state.resources.has(MANIFEST), 'page failure keeps the manifest a retry needs to find the pages');
        assert.ok(failed.skipped.some((s) => /page manifest.*kept — the generative pages step failed/.test(s)), JSON.stringify(failed.skipped));
        assert.ok(failedFixture.state.pages.has(OVERVIEW_ID));
      }
      failedFixture.state.failure = null;
      failedFixture.state.beforeDelete = () => {
        const current = snapshotStore.readSnapshot(failedFixture.workspaceDir);
        assert.ok(snapshot.isTombstoned(current));
        assert.strictEqual(current.eligible, false);
      };
      const retry = await teardownModelApp(failedFixture.spec, { apply: true, allowDestructive: true, workspaceDir: failedFixture.workspaceDir }, { sdk: failedFixture.sdk });
      assert.strictEqual(retry.ok, true, JSON.stringify(retry.errors));
      assert.strictEqual(failedFixture.state.pages.has(OVERVIEW_ID), false, `${failure} failure: the retry deletes the authored page`);
      assert.ok(failedFixture.state.pages.has(DETAIL_ID), 'the page another app still references is left to it');
      assert.ok(failedFixture.state.pages.has(FOREIGN_PAGE_ID), 'a page outside the manifest is never touched');
      assert.strictEqual(failedFixture.state.resources.has(MANIFEST), false, 'the manifest goes once its pages are handled');
      assert.strictEqual(failedFixture.state.solutions.has('ContosoOwnership'), false, 'and the solution last');
      assert.strictEqual(snapshotStore.readSnapshot(failedFixture.workspaceDir), null, 'clean retry releases the retained tombstone');
    }

    const systemFixture = await prepare(true);
    assert.strictEqual(systemFixture.spec.solution.uniqueName, 'Default', 'download excludes every built-in solution instead of claiming ownership');
    for (const uniqueName of ['Default', 'Active', 'Basic']) {
      systemFixture.calls.length = 0;
      const systemSpec = { ...systemFixture.spec, solution: { ...systemFixture.spec.solution, uniqueName } };
      const result = await teardownModelApp(systemSpec, { apply: true, allowDestructive: true, workspaceDir: systemFixture.workspaceDir }, { sdk: systemFixture.sdk });
      assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
      assert.ok(result.skipped.includes(`solution ${uniqueName} (restricted system solution)`));
      assert.ok(!systemFixture.calls.some((c) => c.method === 'deleteSolution' || (c.method === 'resolveArtifact' && c.args[0] === 'solution')), 'system solutions are protected before discovery');
      assertReusedRetained(systemFixture);
    }
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.strictEqual(fs.existsSync(root), false, 'all downloaded specs, pages and workspaces are removed');
});
