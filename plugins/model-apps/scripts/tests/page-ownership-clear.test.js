'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ownership = require('../lib/page-ownership-records.js');
const snapshots = require('../lib/apply-snapshot-store.js');
const { loadCli } = require('./helpers/cli-harness.js');

const ENV = 'https://contoso.crm.dynamics.com';
const OTHER_ENV = 'https://fabrikam.crm.dynamics.com';
const APP = 'contoso_pages';
const ID = '11111111-1111-4111-8111-111111111111';
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contoso-receipt-clear-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.maker-workspace');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ instanceUrl: ENV, artifacts: [] }));
  return dir;
}

async function runClear(dir, { sdk, spec, realEngine = false } = {}) {
  const emissions = [];
  const cli = loadCli(path.resolve(__dirname, '..', 'teardown-model-app.js'), {
    argv: ['--env', ENV, '--spec', '@contoso-app-spec.json', '--workspace', dir, '--apply', '--allow-destructive', '--clear-workspace'],
    env: { POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
    requires: {
      ...(!realEngine ? {
        './lib/app-spec.js': { migrateAppSpec: (s) => s, validateAppSpec: () => ({ ok: true }) },
        './lib/sdk-teardown.js': { runTeardown: async () => ({ ok: true, dryRun: false, deleted: {} }) },
      } : {}),
      './lib/dataverse-auth.js': {
        ...require('../lib/dataverse-auth.js'),
        readJsonArg: () => spec || ({ app: { name: 'Contoso Pages', uniqueName: APP }, solution: { uniqueName: 'ContosoPages', publisherPrefix: 'contoso' } }),
        emitResult: (ok, result) => { emissions.push({ ok, result }); },
      },
      './lib/sdk-http-client.js': { createAzHttpClient: () => ({}) },
      './vendor/cds-maker-sdk.cjs': {
        createNodeWorkspaceStorage: () => ({}),
        createMakerSdk: () => sdk || ({ initWorkspace: async () => {} }),
      },
    },
  });
  await cli.main();
  assert.equal(emissions.length, 1);
  assert.equal(emissions[0].ok, true, `refusing cache cleanup does not rerun or fail a completed remote teardown: ${JSON.stringify(emissions[0].result)}\n${cli.stderrText()}`);
  return cli.stderrText();
}

for (const [name, app, env] of [
  ['another app', 'contoso_other', ENV],
  ['another environment', APP, OTHER_ENV],
]) {
  test(`clear-workspace keeps an unconsumed receipt for ${name}`, async (t) => {
    const dir = workspace(t);
    ownership.recordPageCreation(dir, app, 'overview', ID, 'Overview', env);
    const file = fs.readdirSync(dir).find((f) => f.startsWith('page-ownership.'));
    const bytes = fs.readFileSync(path.join(dir, file));
    const log = await runClear(dir);
    assert.ok(fs.existsSync(dir));
    assert.deepEqual(fs.readFileSync(path.join(dir, file)), bytes);
    assert.match(log, /skipped --clear-workspace/);
    assert.match(log, new RegExp(app));
    assert.match(log, new RegExp(ID));
    assert.match(log, /original.*environment|resume|reconcile/i);
    // The CLI names the record by its canonical path; a temp folder reached through an alias (macOS
    // /var -> /private/var, a Windows 8.3 name or junction) spells the same file differently.
    assert.ok(log.includes(path.join(dir, file)) || log.includes(path.join(fs.realpathSync.native(dir), file)), 'each remaining record file must be named');
    assert.match(log, /teardown consumes.*deletes.*confirms.*absence/i);
    assert.match(log, /confirmed.*gone.*deleted by hand/i);
  });
}

test('clear-workspace still clears a genuine disposable workspace without ownership records', async (t) => {
  const dir = workspace(t);
  const log = await runClear(dir);
  assert.equal(fs.existsSync(dir), false);
  assert.match(log, /cleared workspace/);
});

for (const outcome of ['deleted', 'confirmed absent']) {
  test(`build creates, teardown retires ${outcome} page records, and clear-workspace succeeds`, async (t) => {
    const dir = workspace(t);
    const appDir = path.dirname(dir);
    fs.writeFileSync(path.join(appDir, 'overview.tsx'), 'export default () => null;');
    const spec = {
      schemaVersion: 2,
      solution: { uniqueName: 'ContosoPages', publisherPrefix: 'contoso' },
      app: { name: 'Contoso Pages', uniqueName: APP },
      entities: [{ schemaName: 'contoso_item', displayName: 'Item', primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' } }],
      pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } }],
      appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ page: 'overview' }] }] }] },
    };
    const appId = '22222222-2222-4222-8222-222222222222';
    const layerId = '33333333-3333-4333-8333-333333333333';
    const sitemapId = '44444444-4444-4444-8444-444444444444';
    const state = { app: true, page: false, manifest: null, solution: true, creates: 0, deletes: 0 };
    const sdk = {
      initWorkspace: async () => {},
      queryRecords: async (entity) => {
        if (entity === 'appmodule') return state.app ? [{ appmoduleid: appId, appmoduleidunique: layerId, uniquename: APP }] : [];
        if (entity === 'appmodulecomponent') return [{ objectid: sitemapId, componenttype: 62 }];
        if (entity === 'sitemap') return state.app ? [{ sitemapxml: '<SiteMap />' }] : [];
        if (entity === 'webresource') return state.manifest ? [{ webresourceid: 'manifest-id', content: state.manifest }] : [];
        if (entity === 'uxagentproject') return state.page ? [{ uxagentprojectid: ID, name: 'Overview' }] : [];
        return [];
      },
      createWebResource: async (o) => { state.manifest = Buffer.from(o.content, 'utf8').toString('base64'); return { id: 'manifest-id' }; },
      updateWebResource: async (id, o) => { state.manifest = Buffer.from(o.content, 'utf8').toString('base64'); },
      addSolutionComponent: async () => {},
      resolveArtifact: async (kind, identity) => {
        if (kind === 'app') return state.app ? [{ id: appId, name: spec.app.name, appModuleIdUnique: layerId }] : [];
        if (kind === 'webResource') return state.manifest && identity.name === `${APP}_pagemanifest` ? [{ id: 'manifest-id', name: identity.name }] : [];
        if (kind === 'solution') return state.solution ? [{ id: 'solution-id', name: spec.solution.uniqueName }] : [];
        return [];
      },
      deleteAppCascade: async () => { state.app = false; return { success: true, deleted: [], failures: [] }; },
      deleteRecord: async (entity, id) => {
        assert.equal(entity, 'uxagentproject');
        assert.equal(id, ID);
        state.page = false;
        state.deletes++;
      },
      deleteWebResource: async () => { state.manifest = null; },
      deleteSolution: async () => { state.solution = false; },
      deleteTable: async (logical) => { assert.equal(logical, 'contoso_item'); },
    };
    await require('../lib/sdk-build.js').runSdkBuild(spec, {
      sdk, apply: true, env: ENV, appDir, workspaceDir: dir, phases: ['pages'],
      changedOnly: { resolvedAppId: appId, skipSitemapFinalize: true },
      genpageCli: {
        enumerateEnv: async () => ({ ok: true, ids: [], pages: [] }),
        upload: async (o) => {
          assert.equal(o.pageId, undefined, 'this is an acknowledged CREATE, not a reused id');
          state.page = true;
          state.creates++;
          return { pageId: ID };
        },
      },
    });
    assert.equal(state.creates, 1);
    assert.equal(ownership.readPageOwnership(dir, APP, ENV).created.length, 1);
    assert.equal(ownership.checkPageOwnershipClearable(dir).ok, false);
    if (outcome === 'confirmed absent') state.page = false;
    const log = await runClear(dir, { sdk, spec, realEngine: true });
    assert.equal(state.deletes, outcome === 'deleted' ? 1 : 0);
    assert.equal(state.page, false);
    assert.equal(state.manifest, null);
    assert.equal(state.solution, false);
    assert.equal(fs.existsSync(dir), false, 'all page records were retired before the cache was cleared');
    assert.match(log, /cleared workspace/);
    assert.doesNotMatch(log, /skipped --clear-workspace/);
  });
}

test('a receipt arriving during atomic workspace isolation is retained before recursive deletion', (t) => {
  const dir = workspace(t);
  let isolated;
  const result = snapshots.clearWorkspace(dir, {
    beforeRename: () => ownership.recordPageCreation(dir, 'contoso_other', 'overview', ID, 'Overview', ENV),
    beforeRemove: (aside) => {
      isolated = aside;
      if (fs.readdirSync(aside).some((f) => f.startsWith('page-ownership.'))) throw new Error('unconsumed ownership record arrived during clear');
    },
  });
  assert.equal(result.ok, false);
  assert.ok(isolated && fs.existsSync(isolated));
  assert.equal(ownership.readPageOwnership(isolated, 'contoso_other', ENV).created.length, 1);
  assert.match(result.reason, /kept|retained/);
  const lease = snapshots.acquireLease(isolated);
  assert.equal(lease.ok, true, 'a retained workspace must be resumable in the same process');
  snapshots.releaseLease(lease);
});
