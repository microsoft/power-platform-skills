'use strict';
// The run a declared-dashboard test settles through: the real maker SDK bundle over a maker's SDK workspace kept between
// runs, the plugin's real HTTP client, the run's real publication barrier and the binding store, over the in-memory
// Dataverse of helpers/managed-wire.js. Shared by dashboard-settlement-real-bundle.test.js and by the second OS process of
// its crash-boundary tests (helpers/dashboard-create-crash-child.js), so both settle a dashboard exactly the same way.
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./temp-dirs.js');
const { ORIGIN, createManagedWire } = require('./managed-wire.js');
const { createAzHttpClient } = require('../../lib/sdk-http-client.js');
const { withDashboardWorkspaceScope } = require('../../lib/dashboard-recovery-workspace.js');
const { createMakerSdk, createNodeWorkspaceStorage } = require('../../vendor/cds-maker-sdk.cjs');
const { openManagedContext } = require('../../lib/managed-bindings.js');
const { createPublicationBarrier } = require('../../lib/publication-barrier.js');
const { createIntentCatalog } = require('../../lib/creates-catalog.js');
const { environmentFingerprint } = require('../../lib/page-ownership-records.js');
const { dashboardTileOpts, dashboardComponent } = require('../../lib/sdk-build.js');
const { settleDeclaredDashboard, publishDeclaredDashboard, dashboardKey } = require('../../lib/dashboard-reconcile.js');
const { createAttemptSendObserver } = require('../../lib/managed-feature-contract.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP = 'contoso_app';
const SOL = 'contoso_solution';
const FP = environmentFingerprint(ENV);
const OPEN = '66666666-0000-4000-8000-000000000001';
const ALL = '66666666-0000-4000-8000-000000000002';
const MINE = '66666666-0000-4000-8000-000000000003';
const spec = { views: [{ entity: 'incident', name: 'Open cases' }, { entity: 'incident', name: 'All cases' }, { entity: 'incident', name: 'My cases' }] };
const built = { created: { views: { 'incident|Open cases': OPEN, 'incident|All cases': ALL, 'incident|My cases': MINE }, charts: {} } };
const resolveTile = (tile) => dashboardTileOpts(spec, tile, built);

const halt = (phase, label, code, { cause } = {}) => Object.assign(new Error(`${label}: ${code}`), { phase, code, cause, retry: 'never' });
const catalogFor = (d) => createIntentCatalog([{ catalogKind: 'dashboard', key: dashboardKey(d), scope: { kind: 'solution', solution: SOL }, declaration: { scopeType: 'Standard', name: d.name } }]);
const declared = (tiles, extra = {}) => ({ name: 'Ops', reconcile: 'declared', tiles, ...extra });

// The maker's typed adoption approval of `dashboard:ops` is given unless a test passes its own `approvals`.
const ADOPT = { adopt: new Set(['dashboard:ops']) };
const settle = (w, dashboard, extra = {}) => settleDeclaredDashboard({
  dashboard, catalog: catalogFor(dashboard), sdk: w.sdk, store: w.store, barrier: w.barrier, halt, resolveTile, toComponent: dashboardComponent,
  ensureMembership: async () => undefined, ctx: { appUniqueName: APP, environmentFingerprint: FP }, approvals: ADOPT,
  provisionedLanguages: async () => w.wire.languages(),
  ...(w.observer ? { sendObserver: w.observer } : {}), ...extra,
});
// A run over the maker's SDK workspace `workspaceDir`, kept between runs as a maker's is, and the binding store in `dir`.
// `cutCreateAnswer`: the create POST reaches the service and its success passes the send observer (the receipt is
// acknowledged), then the answer is lost on its way to the SDK: the client gets a final 409, so the SDK never records the
// create and keeps its copy as an unsent draft. `deps`: the store's file seams (failNextStoreWrite).
async function makerRun({ wire = createManagedWire(), dir = makeTempDir('dash-settle-'), workspaceDir, cutCreateAnswer = false, deps } = {}) {
  const barrier = createPublicationBarrier();
  const observer = createAttemptSendObserver();
  const observed = observer.wrap(wire.request);
  const transport = cutCreateAnswer
    ? async (req) => {
      const res = await observed(req);
      if (String(req.method).toUpperCase() !== 'POST' || !/\/systemforms$/i.test(new URL(req.url).pathname)) return res;
      return { statusCode: 409, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: '0x80040216', message: 'the answer was lost' } }) };
    }
    : observed;
  const httpClient = createAzHttpClient(ORIGIN, { getToken: () => 'x'.repeat(40), request: barrier.gateRequest(transport), sleep: async () => {} });
  const sdk = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(workspaceDir), instanceUrl: ORIGIN, httpClient });
  await sdk.initWorkspace();
  const { store } = openManagedContext({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOL, barrier, ...(deps ? { deps } : {}) });
  return { wire, barrier, sdk, dir, store, observer, workspaceDir };
}

// Every file of a directory tree and its bytes: the maker's workspace copy must come out of a recovery as it went in.
function treeBytes(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(root);
  return out;
}

// The settle (and, when `publishToo`, the publish) of a run inside its dashboard workspace scope, as sdk-build.js runs them.
async function scopedSettle(w, d, extra = {}, { publishToo = false } = {}) {
  return withDashboardWorkspaceScope({ sourceSdk: w.sdk }, async (scope) => {
    const settled = await settle(w, d, { ...extra, workspaceScope: scope });
    const published = publishToo ? await publishDeclaredDashboard({ store: w.store, barrier: w.barrier, sdk: scope.currentSdk, key: 'ops', id: settled.id }) : null;
    return { settled, published, isolated: scope.isolated };
  });
}

module.exports = { ENV, APP, SOL, FP, OPEN, ALL, MINE, spec, built, resolveTile, halt, catalogFor, declared, ADOPT, settle, makerRun, treeBytes, scopedSettle };
