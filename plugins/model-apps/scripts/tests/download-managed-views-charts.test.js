'use strict';
// The explicit managed download (download-model-app.js main, --include-managed --managed-manifest <store>) over the build that made
// the store: a stable view and chart (createIdentity "stable-v1") built into a fake Dataverse by the real build and the real SDK, then
// downloaded through main with only its connections replaced. runDownload answers what the plain download of this app hydrates: no
// views[] or charts[], and the view and chart in the not-round-tripped inventory, by id.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../vendor/cds-maker-sdk.cjs');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { createPublicationBarrier } = require('../lib/publication-barrier.js');
const { PREFIX } = require('../lib/managed-bindings.js');
const { main: downloadMain, notRoundTrippedSummary, notRoundTrippedWarning } = require('../download-model-app.js');
const { createFakeBuildOrg } = require('./helpers/fake-app-build-org.js');
const { gatedClient } = require('./helpers/gated-fake-client.js');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function newDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-managed-vc-'));
  dirs.push(dir);
  return dir;
}

const ENTITIES = { contoso_item: { attributes: { contoso_name: 'String', contoso_code: 'String', contoso_kind: 'Picklist' } } };
const SOLUTION = 'ContosoStable';
const APP = 'contoso_stableids';
const APP_ID = '00000000-0000-4000-8000-00000000a111';

function makeSpec(extra = {}) {
  return {
    solution: { uniqueName: SOLUTION, displayName: 'Contoso Stable', publisherPrefix: 'contoso' },
    app: { name: 'Stable Ids', uniqueName: APP },
    entities: [{
      schemaName: 'contoso_item', displayName: 'Item', existing: true, primaryAttribute: { schemaName: 'contoso_name', displayName: 'Name' },
      columns: [{ schemaName: 'contoso_code', displayName: 'Code', type: 'Text' }, { schemaName: 'contoso_kind', displayName: 'Kind', type: 'Choice', options: [{ label: 'A', value: 100000000 }, { label: 'B', value: 100000001 }] }],
    }],
    views: [{ entity: 'contoso_item', name: 'Declared Items', reconcile: 'declared', columns: ['contoso_name', 'contoso_code'] }],
    charts: [{ entity: 'contoso_item', name: 'By Kind', chartType: 'Pie', groupBy: 'contoso_kind', reconcile: 'declared' }],
    appShell: { areas: [{ label: 'Main', groups: [{ label: 'Records', subAreas: [{ entity: 'contoso_item', title: 'Items' }] }] }] },
    ...extra,
  };
}
const stableSpec = (extra) => makeSpec({ createIdentity: 'stable-v1', minimumPluginVersion: '2.21.0', ...extra });

// The build that keeps the store: views and charts only, published, as the CLI's build leaves them.
async function build(org, dir, spec) {
  const barrier = createPublicationBarrier();
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(dir), instanceUrl: org.origin, httpClient: gatedClient(org, barrier, null) });
  await sdk.initWorkspace();
  const out = await runSdkBuild(spec, { sdk, apply: true, publish: true, workspaceDir: dir, appDir: dir, env: org.origin, warn: () => {}, phases: ['views', 'charts'], publicationBarrier: barrier });
  return { out, sdk };
}
const storeFileOf = (dir) => path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith(PREFIX)));

// What a plain download of this app hydrates: the spec with no views[] or charts[] (a downloaded spec carries none), and the
// not-round-tripped inventory naming the view and chart the app holds.
function plainDownload(built) {
  const { createIdentity, minimumPluginVersion, ...spec } = makeSpec({ views: [], charts: [] });
  void createIdentity; void minimumPluginVersion;
  const inventory = {
    views: [{ id: built.view, name: 'Declared Items', entity: 'contoso_item' }],
    charts: [{ id: built.chart, name: 'By Kind', entity: 'contoso_item' }],
  };
  return { spec, inventory };
}

// download-model-app.js main with its connections replaced; runDownload keeps runDownload's contract for the report: printed by it
// unless main asks it to defer (`deferReport`), then handed back as its parts.
async function download(org, out, argv, { downloaded, ...extra } = {}) {
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(newDir()), instanceUrl: org.origin, httpClient: org.httpClient });
  await sdk.initWorkspace();
  const dl = Object.create(sdk);
  dl.queryRecords = async (table, o) => (table === 'appmodule' ? [{ uniquename: APP }] : sdk.queryRecords(table, o));
  const asked = [];
  const emitted = [];
  const said = [];
  const printed = [];
  const mark = org.calls.length;
  await downloadMain({
    argv: ['--env', org.origin, '--app', APP_ID, '--out', out, ...argv],
    stderr: { write: (text) => { said.push(String(text)); return true; } },
    exit: () => {},
    emitResult: (ok, payload) => emitted.push({ ok, payload }),
    preflightAuth: async () => ({ ok: true }),
    makeDownloadSdk: async () => ({ sdk: dl, cleanup() {} }),
    makeGenpageSdk: () => ({}),
    runDownload: async (args) => {
      asked.push(args);
      const spec = JSON.parse(JSON.stringify(downloaded.spec));
      const notRoundTripped = notRoundTrippedSummary(downloaded.inventory);
      if (!args.deferReport && notRoundTripped) printed.push(notRoundTrippedWarning(notRoundTripped));
      return {
        ok: true, spec, pages: [], entities: [], webResources: [], droppedSubareas: 0, droppedSubareaDetails: [], notRoundTripped,
        ...(args.deferReport ? { deferredReport: { inventory: downloaded.inventory, membershipNotes: [] } } : {}),
      };
    },
    ...extra,
  });
  const specFile = path.join(out, 'app-spec.json');
  const calls = org.calls.slice(mark);
  return { asked, emitted, said: said.join(''), printed: printed.join(''), calls, writes: calls.filter((c) => c.method !== 'GET'), written: fs.existsSync(specFile) ? JSON.parse(fs.readFileSync(specFile, 'utf8')) : null };
}

async function builtApp() {
  const org = createFakeBuildOrg({ entities: ENTITIES, solution: { uniqueName: SOLUTION } });
  const dir = newDir();
  const { out } = await build(org, dir, stableSpec());
  const built = { view: out.created.views['contoso_item|Declared Items'], chart: out.created.charts['contoso_item|By Kind'] };
  assert.ok(built.view && built.chart, JSON.stringify(out.created));
  return { org, dir, built, flags: ['--include-managed', '--managed-manifest', storeFileOf(dir)] };
}

// --- the report seam ---------------------------------------------------------------------------------------------------------------

test('the managed download asks runDownload to defer the not-round-tripped report and prints it once, after the restore; the plain one does not ask', async () => {
  const { org, built, flags } = await builtApp();
  const downloaded = plainDownload(built);
  const managed = await download(org, newDir(), flags, { downloaded });
  assert.equal(managed.emitted.length, 1);
  assert.equal(managed.emitted[0].ok, true, JSON.stringify(managed.emitted) + managed.said);
  assert.equal(managed.asked[0].deferReport, true);
  const warning = notRoundTrippedWarning(notRoundTrippedSummary(downloaded.inventory));
  assert.equal(managed.printed, '', 'runDownload printed nothing itself');
  assert.equal(managed.said.split(warning).length - 1, 1, `main printed the report once: ${managed.said}`);
  assert.deepEqual(managed.emitted[0].payload.notRoundTripped, notRoundTrippedSummary(downloaded.inventory));

  const plain = await download(org, newDir(), [], { downloaded });
  assert.equal(plain.emitted[0].ok, true, JSON.stringify(plain.emitted));
  assert.equal('deferReport' in plain.asked[0], false, 'the plain download asks runDownload exactly what it did');
  assert.equal(plain.printed, warning, 'runDownload printed the report, as it always did');
  assert.equal(plain.said.includes(warning), false, 'and main did not print it again');
  assert.deepEqual(plain.emitted[0].payload.notRoundTripped, managed.emitted[0].payload.notRoundTripped);
});

test('a store rewritten while the managed download reads it stops the download before anything is written', async () => {
  const { org, dir, built, flags } = await builtApp();
  const { validateAppSpec } = require('../lib/app-spec.js');
  const file = storeFileOf(dir);
  let touched = false;
  const out = newDir();
  const res = await download(org, out, flags, {
    downloaded: plainDownload(built),
    // A build rewriting the store between the restore's first read and the publication of the download (JSON-equal, other bytes).
    validateAppSpec: (s, o) => {
      if (!touched) { fs.appendFileSync(file, '\n'); touched = true; }
      return validateAppSpec(s, o);
    },
  });
  assert.ok(touched);
  assert.equal(res.emitted.length, 1);
  assert.equal(res.emitted[0].ok, false, JSON.stringify(res.emitted));
  assert.equal(res.emitted[0].payload.code, 'managed-manifest-changed');
  assert.match(res.emitted[0].payload.error, /changed while this download read it.*Nothing was written\.$/s);
  assert.deepEqual(fs.readdirSync(out), [], 'no spec, baseline or fragments file');
  assert.deepEqual(res.writes, [], 'the download writes nothing to the service');
});
