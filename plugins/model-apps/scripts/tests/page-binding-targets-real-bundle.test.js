'use strict';
// A changed-only apply checks the bindings of the pages it writes, and of no page it leaves alone. These run it through the changed-only flow itself (lib/changed-only-flow.js → build-model-app.js →
// lib/sdk-build.js) over the REAL vendored SDK, whose reads go to a stateful fake of Dataverse (helpers/fake-app-build-org.js), and the REAL page backend over a fake of the page service
// (helpers/fake-genpage-server.js), so what is asserted is what reached the wire.
//
// The app holds three pages: Alpha; Bravo, which navigates to Charlie; and Charlie, whose connector binding goes through the connection reference `contoso_msnweather`. Since the app was built, the
// environment has come to hold a reference of that name for ANOTHER connector. A changed-only apply writes the pages it changed, and makes a navigation target only when the target is absent:
//   - an edit of Alpha writes Alpha alone. Charlie exists, so it is not made, and its binding is neither read nor judged — the run neither refuses nor says anything of it;
//   - an edit of Charlie writes Charlie, so its binding is refused, before anything is written;
//   - an edit of Alpha after Charlie was deleted in Maker makes Charlie from its spec entry, bindings and all, so it is refused too, before anything is written — though the flow's record of its last
//     apply says Charlie is there.
// The real SDK reads a table's rows in two requests — the table's entity set name, then the rows:
//   GET /EntityDefinitions(LogicalName='connectionreference')?$select=EntitySetName        ->  { "EntitySetName": "connectionreferences" }
//   GET /connectionreferences?$select=connectionreferencelogicalname,connectorid,connectionid,_customconnectorid_value&$filter=connectionreferencelogicalname eq 'contoso_msnweather'
// Neither is in the fake, so the environment's references are answered here (`references`); no request that names the table is what "not read" means.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild, appUniqueName } = require('../lib/sdk-build.js');
const { buildModelApp } = require('../build-model-app.js');
const { validateAppSpec } = require('../lib/app-spec.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { annotateContentHashes } = require('../lib/content-hash.js');
const flow = require('../lib/changed-only-flow.js');
const store = require('../lib/apply-snapshot-store.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');
const { FakeGenPageServer } = require('./helpers/fake-genpage-server.js');
const { makeTempDir } = require('./helpers/temp-dirs.js');

const ORG_ID = '0f0f0f0f-0000-4000-8000-000000000001';
const NAV = 'Xrm.Navigation.navigateTo({ pageType: "generative", pageId: "PAGEREF_charlie", data: {} });';
const SOURCES = {
  'Alpha.tsx': "import * as React from 'react';\nexport default function Alpha() { return <div>Alpha</div>; }\n",
  'Bravo.tsx': `import * as React from 'react';\nexport default function Bravo() { ${NAV} return <div>Bravo</div>; }\n`,
  'Charlie.tsx': "import * as React from 'react';\nexport default function Charlie() { return <div>Charlie</div>; }\n",
};
const WEATHER = { logicalName: 'contoso_msnweather', connectorId: '/providers/Microsoft.PowerApps/apis/shared_msnweather', dataset: '', operations: ['CurrentWeather'] };
// The reference of that name, as the environment holds it now: for another connector.
const OTHER_CONNECTOR = { connectionreferencelogicalname: 'contoso_msnweather', connectorid: '/providers/Microsoft.PowerApps/apis/shared_office365users', connectionid: 'shared-office365users-0001', _customconnectorid_value: null };

function abcSpec({ alpha = {} } = {}) {
  return {
    schemaVersion: 2,
    solution: { uniqueName: 'ContosoReview', displayName: 'Contoso Review', publisherPrefix: 'contoso' },
    app: { name: 'Binding Targets', uniqueName: 'contoso_bindingtargets' },
    entities: [{ schemaName: 'contoso_item', displayName: 'Item', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' }, columns: [] }],
    pages: [
      { key: 'alpha', name: 'Alpha', source: { kind: 'tsx', codeFile: 'Alpha.tsx' }, ...alpha },
      { key: 'bravo', name: 'Bravo', navigatesTo: [{ targetKey: 'charlie' }], source: { kind: 'tsx', codeFile: 'Bravo.tsx' } },
      { key: 'charlie', name: 'Charlie', source: { kind: 'tsx', codeFile: 'Charlie.tsx' }, connectorBindings: [WEATHER] },
    ],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Pages', subAreas: [{ entity: 'contoso_item', title: 'Items' }, { page: 'alpha' }, { page: 'bravo' }, { page: 'charlie' }] }] }] },
  };
}
// Alpha names Charlie's connection reference too, and states the connector the environment's reference is for: Alpha is fine, Charlie conflicts.
const SHARED_ALPHA = { connectorBindings: [{ ...WEATHER, connectorId: OTHER_CONNECTOR.connectorid, operations: [] }] };

// The app as a first build leaves it — its three pages created and in its navigation — with the changed-only baseline its flow records for it. `references` is what the environment answers for
// connection references from then on (none while the app was built); `answerReferences`, when set, answers each read of their rows instead (a refusal, say). `alpha`: what Alpha states besides its source.
async function builtApp(t, { alpha } = {}) {
  const org = createFakeBuildOrg({ entities: { contoso_item: { attributes: { contoso_name: 'String' } } }, solution: { uniqueName: 'ContosoReview' } });
  const server = new FakeGenPageServer();
  const dir = makeTempDir('binding-targets-');
  for (const [file, text] of Object.entries(SOURCES)) fs.writeFileSync(path.join(dir, file), text);
  const state = { references: [], answerReferences: null };
  org.intercept((c) => c.method === 'GET' && /^\/EntityDefinitions\(LogicalName='connectionreference'\)/.test(c.path), () => ({ status: 200, headers: {}, body: { EntitySetName: 'connectionreferences' } }));
  org.intercept((c) => c.method === 'GET' && /^\/connectionreferences\?/.test(c.path), () => (state.answerReferences ? state.answerReferences() : { status: 200, headers: {}, body: { value: state.references } }));
  const pages = makeGenpageSdk(org.origin, { httpClient: server.http() });
  t.after(async () => { await pages.dispose(); });
  // The page backend the build uses, the real one. A page it creates is listed by the environment's own page table too, which the build reads through the provisioning SDK.
  const backend = {
    enumerateEnv: (...args) => pages.enumerateEnv(...args),
    read: (...args) => pages.read(...args),
    fileVersions: (...args) => pages.fileVersions(...args),
    projectVersions: (...args) => pages.projectVersions(...args),
    publishedDiffers: (...args) => pages.publishedDiffers(...args),
    create: async (options) => {
      const result = await pages.create(options);
      org.pages.set(result.pageId, { uxagentprojectid: result.pageId, name: options.name, componentstate: 0 });
      return result;
    },
    update: (...args) => pages.update(...args),
  };
  // Each build gets a fresh SDK over the same workspace folder, as every CLI run does.
  const makeSdk = async () => {
    const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: org.httpClient });
    await sdk.initWorkspace();
    return sdk;
  };
  const spec = abcSpec({ alpha });
  const first = await runSdkBuild(spec, { sdk: await makeSdk(), apply: true, phases: ['app-shell', 'pages'], workspaceDir: dir, appDir: dir, env: org.origin, genpage: backend });
  assert.equal(first.ok, true);
  assert.deepEqual(Object.keys(first.created.pages).sort(), ['alpha', 'bravo', 'charlie'], 'the first build made the three pages');
  // What the flow records once a fresh full build of the app is verified: the baseline its next changed-only run starts from.
  const live = () => ({ orgId: ORG_ID, envUrl: org.origin, appUniqueName: appUniqueName(spec), appId: org.appId() || null, appIdKnown: true });
  const readContent = (relative) => fs.readFileSync(path.join(dir, relative));
  const baseline = flow.assembleBaselineSnapshot({ annotatedSpec: annotateContentHashes(spec, readContent), created: first.created, live: live(), prior: null, appPreExisted: false, sampleDataApplied: false });
  assert.equal(baseline.eligible, true);
  store.writeSnapshotAtomic(dir, baseline);

  const warnings = [];
  // The changed-only apply, as the CLI runs it on `--apply --changed-only`. Verification is not what is under test: it passes.
  const changedOnlyApply = async () => {
    const mark = { org: org.calls.length, pages: server.requests.length, warned: warnings.length };
    const outcome = await flow.runChangedOnlyApply({
      spec,
      opts: { apply: true, workspaceDir: dir, appDir: dir, env: org.origin, maxRetries: 0 },
      deps: {
        log: () => {},
        buildModelApp,
        buildDeps: {
          sdk: await makeSdk(),
          genpage: backend,
          warn: (w) => warnings.push(String(w)),
          verify: async () => ({ ok: true, checks: [{ kind: 'page', name: 'pages' }], missing: [] }),
        },
        readContent,
        resolveLiveIdentity: async () => live(),
      },
    }).then((result) => ({ result }), (error) => ({ error }));
    const orgCalls = org.calls.slice(mark.org);
    return {
      ...outcome,
      referenceReads: orgCalls.filter((c) => /connectionreference/i.test(c.path)),
      orgWrites: orgCalls.filter((c) => c.method !== 'GET'),
      pageWrites: server.requests.slice(mark.pages).filter((r) => r.method !== 'GET'),
      warnings: warnings.slice(mark.warned),
    };
  };
  const edit = (file) => fs.appendFileSync(path.join(dir, file), '// edited\n');
  return { org, server, dir, state, pages, first, edit, changedOnlyApply };
}

const conflict = (page) => (error) => error && error.code === 'pages-binding-reference-conflict' && error.phase === 'preflight' && error.recoverable === false && error.transient === false
  && error.message.includes(`page "${page}": connector binding "contoso_msnweather" is for connector shared_msnweather, but the connection reference of that name in this environment is for connector shared_office365users`)
  && error.message.includes('The build stopped before writing anything.');

test('the spec these cases build is valid, so none of them rests on a spec the CLI would refuse', () => {
  for (const spec of [abcSpec(), abcSpec({ alpha: SHARED_ALPHA })]) {
    const validated = validateAppSpec(spec, { profile: 'deploy' });
    assert.deepEqual({ ok: validated.ok, errors: validated.errors }, { ok: true, errors: [] });
  }
});

test('REAL BUNDLE: a changed-only apply of an edit to one page writes that page, and neither reads nor judges the binding of a navigation target that exists — though its reference is another connector\'s', async (t) => {
  const app = await builtApp(t);
  app.state.references = [OTHER_CONNECTOR];
  app.edit('Alpha.tsx');
  const run = await app.changedOnlyApply();
  assert.equal(run.error, undefined, run.error && run.error.stack);
  assert.equal(run.result.ok, true);
  assert.equal(run.result.changedOnly.decision, 'fast');
  assert.deepEqual(run.result.changedOnly.pageKeys, ['alpha']);
  assert.deepEqual(run.referenceReads, [], 'no request names the connection reference table: no page the run writes states a binding');
  assert.deepEqual(run.warnings.filter((w) => /contoso_msnweather|"Charlie"/.test(w)), [], 'and nothing is said of Charlie\'s binding');
  assert.equal(app.server.rowText(app.first.created.pages.alpha, 'src/pages/page.tsx'), `${SOURCES['Alpha.tsx']}// edited\n`, 'Alpha holds its edit');
  assert.equal(app.server.rowText(app.first.created.pages.charlie, 'src/pages/page.tsx'), SOURCES['Charlie.tsx'], 'Charlie is as it was');
  assert.equal(store.readSnapshot(app.dir).eligible, true, 'and the baseline is blessed again');
});

test('REAL BUNDLE: a changed-only apply of an edit to the page whose binding names that reference is refused before anything is written', async (t) => {
  const app = await builtApp(t);
  app.state.references = [OTHER_CONNECTOR];
  app.edit('Charlie.tsx');
  const run = await app.changedOnlyApply();
  assert.ok(conflict('Charlie')(run.error), String(run.error && run.error.stack));
  assert.equal(run.referenceReads.filter((c) => /^\/connectionreferences\?/.test(c.path)).length, 1, 'the references were read once');
  assert.deepEqual(run.orgWrites, [], 'nothing was written to the environment');
  assert.deepEqual(run.pageWrites, [], 'and no page');
  assert.equal(app.server.rowText(app.first.created.pages.charlie, 'src/pages/page.tsx'), SOURCES['Charlie.tsx']);
});

test('REAL BUNDLE: a changed-only apply after the navigation target was deleted in Maker makes it — so its binding is refused before anything is written, though the flow\'s record says it is there', async (t) => {
  const app = await builtApp(t);
  const charlie = app.first.created.pages.charlie;
  const removed = await app.server.http().delete(`${app.org.origin}/api/data/v9.0/uxagentprojects(${charlie})`);
  assert.ok(removed.status < 300, `the page service deleted the page: ${removed.status}`);
  app.org.pages.delete(charlie);
  app.state.references = [OTHER_CONNECTOR];
  app.edit('Alpha.tsx');
  const run = await app.changedOnlyApply();
  assert.ok(conflict('Charlie')(run.error), String(run.error && run.error.stack));
  assert.equal(run.referenceReads.filter((c) => /^\/connectionreferences\?/.test(c.path)).length, 1, 'the references were read once, when the run found it had to make the page');
  assert.deepEqual(run.orgWrites, [], 'nothing was written to the environment');
  assert.deepEqual(run.pageWrites, [], 'no page was made or written');
});

// Alpha and the deleted Charlie name the same reference. The check before writing reads it for Alpha (Alpha is fine); the pages phase, about to make Charlie, judges Charlie by that read: the
// name is read once in the attempt, so a second read — refused here — is never made, and the conflict it already proved stops the run before anything is written.
async function deletedCharlieSharingAlphasReference(t) {
  const app = await builtApp(t, { alpha: SHARED_ALPHA });
  const charlie = app.first.created.pages.charlie;
  const removed = await app.server.http().delete(`${app.org.origin}/api/data/v9.0/uxagentprojects(${charlie})`);
  assert.ok(removed.status < 300, `the page service deleted the page: ${removed.status}`);
  app.org.pages.delete(charlie);
  app.state.references = [OTHER_CONNECTOR];
  app.edit('Alpha.tsx');
  return app;
}

test('REAL BUNDLE: a deleted navigation target that names the edited page\'s reference is judged by the one read of it — a refused second read cannot let the target be made unchecked', async (t) => {
  const app = await deletedCharlieSharingAlphasReference(t);
  let rowReads = 0;
  app.state.answerReferences = () => {
    rowReads += 1;
    return rowReads === 1
      ? { status: 200, headers: {}, body: { value: app.state.references } }
      : { status: 403, headers: {}, body: { error: { code: '0x80040220', message: 'The user does not hold the privilege to read connection references.' } } };
  };
  const run = await app.changedOnlyApply();
  assert.ok(conflict('Charlie')(run.error), String(run.error && run.error.stack));
  assert.equal(rowReads, 1, 'the rows of the reference were read once in the attempt');
  assert.deepEqual(run.orgWrites, [], 'nothing was written to the environment');
  assert.deepEqual(run.pageWrites, [], 'no page was made or written');
});

test('REAL BUNDLE: a deleted navigation target that names the edited page\'s reference adds no read of it — one request for its rows in the attempt', async (t) => {
  const app = await deletedCharlieSharingAlphasReference(t);
  const run = await app.changedOnlyApply();
  assert.ok(conflict('Charlie')(run.error), String(run.error && run.error.stack));
  assert.equal(run.referenceReads.filter((c) => /^\/connectionreferences\?/.test(c.path)).length, 1);
  assert.deepEqual(run.orgWrites, []);
  assert.deepEqual(run.pageWrites, []);
});
