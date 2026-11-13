'use strict';
// The read-only recovery command (configuration-recovery.js, #807) over a real receipt and the strict fake Dataverse: inspect, prepare
// and resolve each reach the service with GETs only (the fake org records every write), a receipt of another environment is refused
// before any read, a deferral reads nothing, and a completed resolution answers configuration-create-reconciled rather than success.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');
const { createAzHttpClient } = require('../lib/sdk-http-client.js');
const { withAppBuildLease, buildLockName } = require('../lib/app-operation-lease.js');
const { ownerStamp } = require('../lib/process-owner.js');
const { deadPid } = require('./helpers/kill-target-client.js');
const { appUniqueName } = require('../lib/app-unique-name.js');
const A = require('../lib/configuration-artifacts.js');
const P = require('../lib/configuration-create-plan.js');
const S = require('../lib/configuration-create-state.js');
const G = require('../lib/configuration-create-guard.js');
const { runRecoveryCommand, currentIntentOf } = require('../configuration-recovery.js');

const SOL = 'ContosoSol';
const ENV = 'https://contoso.crm.dynamics.com';
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const RECEIPT_KT = P.CONFIGURATION_CREATE_RECEIPT_KIND_TABLE;
const spec = ({ apis = true, calcDescription } = {}) => ({
  minimumPluginVersion: '2.21.0',
  solution: { uniqueName: SOL, publisherPrefix: 'contoso' },
  app: { name: 'Recovery Test' },
  connectionReferences: [{ logicalName: 'contoso_c1', connectorId: SP }],
  customApis: apis ? [{ uniqueName: 'contoso_Calc', isFunction: true, ...(calcDescription ? { description: calcDescription } : {}), requestParameters: [{ uniqueName: 'A', type: 'integer' }], responseProperties: [{ uniqueName: 'R', type: 'string' }] }] : [],
});

function orgOf() {
  // childrenJoin: a child created with the solution header under a member root joins the solution too, as the platform does.
  return createConfigOrg({ childrenJoin: true, tables: [{ logicalName: 'contact', attributes: ['lastname'] }], solution: { uniqueName: SOL, version: '1.0.0.0', prefix: 'contoso' } });
}

// An app folder holding the spec and a receipt with one prepared (nothing sent yet) unit for `kind`/`key`.
function appWithUnit(s, kind, key, { environmentUrl = ENV } = {}) {
  const appDir = path.join(makeTempDir('cfg-recovery-cli-'), 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'app-spec.json'), JSON.stringify(s));
  const workspaceDir = path.join(appDir, '.maker-workspace');
  const c = P.compileConfigurationCreateUnit(s, { kind, key, bindings: A.readDeploymentBindings({}, s), solution: SOL });
  assert.equal(c.ok, true, JSON.stringify(c));
  const context = S.createStateContext({ environmentUrl, solutionUniqueName: SOL, appUniqueName: appUniqueName(s), authoringLanguageCode: 1033 });
  // The receipt keeps the compiled unit's public facts; the solution is the receipt context's, not the unit's.
  const { solution, ...unit } = c.unit;
  assert.equal(solution, SOL);
  S.prepareCreateUnit(workspaceDir, { kindTable: RECEIPT_KT, context, unit });
  return { appDir, workspaceDir, compiled: c, unitId: S.readConfigurationCreateState(workspaceDir, { kindTable: RECEIPT_KT }).units[0].unitId };
}

// Each create row straight to the fake org with the exact request the writer would send (as an interrupted build left it).
async function sendRows(org, c) {
  for (const r of c.unit.rows.filter((x) => x.role === 'create')) {
    const req = P.compiledRowRequest(c.handle, r.id);
    const headers = { 'content-type': 'application/json', ...(req.solutionHeader ? { 'MSCRM.SolutionUniqueName': SOL } : {}) };
    const res = await org.request({ url: `${org.origin}/api/data/v9.0${req.path}`, method: req.method, headers, body: req.body });
    assert.ok(res.statusCode < 300, `${req.path}: ${res.statusCode} ${res.body}`);
  }
}

// The raw client the command is handed, over the fake org; `made` counts how often the command asked for one.
function clientOver(org) {
  const made = { count: 0 };
  const httpClient = (origin) => {
    made.count += 1;
    return createAzHttpClient(origin, { getToken: () => 'test-token-0123456789abcdef', request: org.request, sleep: async () => {} });
  };
  return { httpClient, made };
}
const noClient = () => { throw new Error('the command asked for a service client'); };
const run = (argv, deps = {}) => runRecoveryCommand(argv, { warn: () => {}, ...deps });

test('usage errors name the problem and print the usage', async () => {
  for (const [argv, words] of [
    [[], /name one command/],
    [['inspect', '--app-dir', 'x', '--bogus'], /bogus/],
    [['prepare', '--app-dir', 'x', '--unit', 'u', '--resolution', 'defer'], /--env is required/],
    [['resolve', '--app-dir', 'x', '--resolution', 'quarantine-unreadable'], /--acknowledge-unknown-dispatch/],
    [['inspect', '--app-dir', 'x', '--unit', 'u'], /not an inspect option/],
    [['prepare', '--app-dir', 'x', '--env', ENV, '--unit', 'u', '--resolution', 'accept-current', '--approval-token', 't'], /belong to resolve/],
  ]) {
    const r = await run(argv, { httpClient: noClient });
    assert.equal(r.ok, false);
    assert.match(r.payload.error, words);
    assert.match(r.payload.error, /Usage: node scripts\/configuration-recovery\.js/);
  }
});

test('inspect of a workspace with no receipt is clear and reads nothing', async () => {
  const appDir = path.join(makeTempDir('cfg-recovery-cli-'), 'app');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'app-spec.json'), JSON.stringify(spec()));
  const r = await run(['inspect', '--app-dir', appDir, '--env', ENV], { httpClient: noClient });
  assert.equal(r.ok, true);
  assert.equal(r.payload.receipt, 'absent');
  assert.equal(r.payload.clear, true);
  assert.equal(r.payload.serviceReads, 0);
});

test('inspect without --env lists the saved unit from the workspace alone', async () => {
  const app = appWithUnit(spec(), 'connection-reference', 'contoso_c1');
  const r = await run(['inspect', '--app-dir', app.appDir], { httpClient: noClient });
  assert.equal(r.ok, true);
  assert.equal(r.payload.clear, false);
  assert.equal(r.payload.units.length, 1);
  assert.equal(r.payload.units[0].unitId, app.unitId);
  assert.equal(r.payload.units[0].state, 'open');
  assert.ok(r.payload.nextSteps.some((s) => /--env/.test(s)));
});

test('a receipt of another environment is refused before any client is made or any read is sent', async () => {
  const app = appWithUnit(spec(), 'connection-reference', 'contoso_c1', { environmentUrl: 'https://fabrikam.crm.dynamics.com' });
  for (const argv of [
    ['inspect', '--app-dir', app.appDir, '--env', ENV],
    ['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'accept-current'],
  ]) {
    const r = await run(argv, { httpClient: noClient });
    assert.equal(r.ok, false);
    assert.equal(r.payload.code, 'configuration-create-context-mismatch', JSON.stringify(r.payload));
    assert.equal(r.payload.retry, 'never');
  }
});

test('inspect of rows never sent describes each one for manual completion, with GETs only', async () => {
  const org = orgOf();
  const app = appWithUnit(spec(), 'custom-api', 'contoso_Calc');
  const { httpClient } = clientOver(org);
  const writesBefore = org.requests.length;
  const r = await run(['inspect', '--app-dir', app.appDir, '--env', ENV], { httpClient });
  assert.equal(r.ok, true, JSON.stringify(r.payload));
  const [u] = r.payload.units;
  assert.equal(u.dispatch, 'not-dispatched');
  assert.ok(r.payload.serviceReads > 0);
  assert.equal(u.manualCompletion.length, 3);
  assert.ok(u.manualCompletion.every((m) => m.method === 'POST' && typeof m.entitySet === 'string' && typeof m.idColumn === 'string'));
  assert.match(r.payload.manualCompletionNote, /Not executed/);
  assert.deepEqual(org.writes(writesBefore), []);
  assert.deepEqual(org.unexpected, []);
});

test('accept-current: a unit whose rows all landed is prepared and resolved with GETs only, and the receipt is cleared', async () => {
  const org = orgOf();
  const app = appWithUnit(spec(), 'custom-api', 'contoso_Calc');
  await sendRows(org, app.compiled);
  const { httpClient } = clientOver(org);
  const writesBefore = org.requests.length;
  const seen = await run(['inspect', '--app-dir', app.appDir, '--env', ENV], { httpClient });
  assert.equal(seen.payload.units[0].outcome, 'match', JSON.stringify(seen.payload.units[0]));
  const prepared = await run(['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'accept-current'], { httpClient });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.payload));
  assert.match(prepared.payload.approvalToken, /\./);
  const argv = ['resolve', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'accept-current', '--approval-token', prepared.payload.approvalToken];
  if (prepared.payload.privateAcknowledgmentRequired) argv.push('--accept-current-private-state');
  const done = await run(argv, { httpClient });
  assert.equal(done.ok, false, 'a resolution is never a build success');
  assert.equal(done.payload.code, 'configuration-create-reconciled', JSON.stringify(done.payload));
  assert.deepEqual(org.writes(writesBefore), [], 'recovery sent no write');
  const after = await run(['inspect', '--app-dir', app.appDir], { httpClient: noClient });
  assert.equal(after.payload.units.length, 0);
  // A used token is spent.
  const again = await run(argv, { httpClient });
  assert.equal(again.payload.code, 'configuration-create-approval-stale');
});

test('accept-current refuses when the App Spec now asks for something else (intent-changed)', async () => {
  const org = orgOf();
  const app = appWithUnit(spec(), 'custom-api', 'contoso_Calc');
  await sendRows(org, app.compiled);
  fs.writeFileSync(path.join(app.appDir, 'app-spec.json'), JSON.stringify(spec({ calcDescription: 'changed since' })));
  const r = await run(['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'accept-current'], clientOver(org));
  assert.equal(r.ok, false);
  assert.equal(r.payload.code, 'configuration-create-intent-changed', JSON.stringify(r.payload));
});

test('defer reads nothing, needs the root gone from the App Spec, and leaves the unit recorded as deferred', async () => {
  const app = appWithUnit(spec(), 'custom-api', 'contoso_Calc');
  const still = await run(['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'defer'], { httpClient: noClient });
  assert.equal(still.payload.code, 'configuration-create-pending');
  fs.writeFileSync(path.join(app.appDir, 'app-spec.json'), JSON.stringify(spec({ apis: false })));
  const prepared = await run(['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'defer'], { httpClient: noClient });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.payload));
  assert.equal(prepared.payload.serviceReads, 0);
  const done = await run(['resolve', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'defer', '--approval-token', prepared.payload.approvalToken], { httpClient: noClient });
  assert.equal(done.payload.code, 'configuration-create-reconciled', JSON.stringify(done.payload));
  const after = await run(['inspect', '--app-dir', app.appDir], { httpClient: noClient });
  assert.equal(after.payload.units[0].state, 'deferred');
  assert.equal(after.payload.clear, false);
});

test('a prepare while the app build lock is held is configuration-create-state-busy, and names the lock', async () => {
  const app = appWithUnit(spec({ apis: false }), 'connection-reference', 'contoso_c1');
  await withAppBuildLease({ workspaceDir: app.workspaceDir, appUniqueName: appUniqueName(spec()), warn: () => {} }, async () => {
    const r = await run(['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'cancel-unsent'], { httpClient: noClient });
    assert.equal(r.payload.code, 'configuration-create-state-busy', JSON.stringify(r.payload));
    assert.ok(r.payload.reason.includes(path.join(app.workspaceDir, buildLockName(appUniqueName(spec())))), r.payload.reason);
    assert.match(r.payload.nextStep, /inspect the lock named above/);
  });
});

test('a lock left by a recovery or build that is proved gone is taken over and said; one whose owner runs is never taken', async () => {
  const app = appWithUnit(spec({ apis: false }), 'connection-reference', 'contoso_c1');
  const lock = path.join(app.workspaceDir, buildLockName(appUniqueName(spec())));
  const argv = ['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'cancel-unsent'];
  // An owner that runs (this process, by a record ten minutes old) is never judged abandoned, however old.
  const running = JSON.stringify({ ...ownerStamp({ now: () => Date.now() - 10 * 60 * 1000 }), rnd: 'held' });
  fs.writeFileSync(lock, running);
  const refused = await run(argv, { httpClient: noClient });
  assert.equal(refused.payload.code, 'configuration-create-state-busy', JSON.stringify(refused.payload));
  assert.equal(fs.readFileSync(lock, 'utf8'), running, 'the lock is left as it was');
  fs.writeFileSync(lock, JSON.stringify({ ...ownerStamp({ pid: deadPid() }), rnd: 'held' }));
  const warnings = [];
  const prepared = await run(argv, { httpClient: noClient, warn: (w) => warnings.push(w) });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.payload));
  assert.ok(warnings.some((w) => /released the build lock .* is no longer running/.test(w)), warnings.join('\n'));
  assert.ok(!fs.existsSync(lock), 'the lock taken over is let go again');
});

test('an unreadable receipt is quarantined only with --acknowledge-unknown-dispatch, and inspect then names the build acknowledgment', async () => {
  const app = appWithUnit(spec(), 'connection-reference', 'contoso_c1');
  const unreadable = Buffer.from('{"not":"a receipt"}\r\n\u0000tail', 'utf8');
  fs.writeFileSync(path.join(app.workspaceDir, 'configuration-create-state.v1.json'), unreadable);
  const seen = await run(['inspect', '--app-dir', app.appDir, '--env', ENV], { httpClient: noClient });
  assert.equal(seen.payload.receipt, 'invalid');
  assert.equal(seen.payload.clear, false);
  const done = await run(['resolve', '--app-dir', app.appDir, '--resolution', 'quarantine-unreadable', '--acknowledge-unknown-dispatch'], { httpClient: noClient });
  assert.equal(done.ok, false);
  assert.equal(done.payload.code, 'configuration-create-reconciled', JSON.stringify(done.payload));
  assert.equal(done.payload.serviceReads, 0);
  assert.match(done.payload.nextStep, /--acknowledge-quarantined-configuration/);
  // The bytes are kept exactly, in the archive beside the marker.
  assert.deepEqual(fs.readFileSync(path.join(app.workspaceDir, `configuration-create-state.unreadable.${done.payload.quarantineId}.bin`)), unreadable);
  const after = await run(['inspect', '--app-dir', app.appDir], { httpClient: noClient });
  assert.equal(after.payload.quarantines.length, 1);
  assert.equal(after.payload.quarantines[0].quarantineId, done.payload.quarantineId);
  assert.ok(after.payload.nextSteps.some((s) => s.includes(`--acknowledge-quarantined-configuration ${done.payload.quarantineId}`)));
});

test('defer is refused while another declaration still depends on the deferred root', async () => {
  const both = {
    ...spec({ apis: false }),
    environmentVariables: [{ schemaName: 'contoso_V', type: 'string' }, { schemaName: 'contoso_D', type: 'dataSource', connectorId: SP, parameterKey: 'dataset', parentSchemaName: 'contoso_V' }],
  };
  const app = appWithUnit(both, 'environmentVariable', 'contoso_V');
  // The root is gone from the App Spec, but the data-source variable still names it as its parent.
  fs.writeFileSync(path.join(app.appDir, 'app-spec.json'), JSON.stringify({ ...both, environmentVariables: [both.environmentVariables[1]] }));
  const r = await run(['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'defer'], { httpClient: noClient });
  assert.equal(r.ok, false);
  assert.equal(r.payload.code, 'configuration-create-pending', JSON.stringify(r.payload));
  const after = await run(['inspect', '--app-dir', app.appDir], { httpClient: noClient });
  assert.equal(after.payload.units[0].state, 'open');
});

test('a resolution invalidates the changed-only snapshot, and a separate build then passes the receipt guard', async () => {
  const org = orgOf();
  const app = appWithUnit(spec(), 'custom-api', 'contoso_Calc');
  await sendRows(org, app.compiled);
  const { httpClient } = clientOver(org);
  const invalidated = [];
  const deps = { httpClient, invalidate: (dir) => { invalidated.push(dir); return { ok: true }; } };
  assert.throws(() => G.assertConfigurationCreatesClear(app.workspaceDir, { spec: spec(), env: ENV, languageCode: 1033 }), (e) => e.code === 'configuration-create-pending');
  const prepared = await run(['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'accept-current'], deps);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.payload));
  assert.deepEqual(invalidated, [], 'a prepare changes nothing');
  const argv = ['resolve', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'accept-current', '--approval-token', prepared.payload.approvalToken];
  if (prepared.payload.privateAcknowledgmentRequired) argv.push('--accept-current-private-state');
  const done = await run(argv, deps);
  assert.equal(done.payload.code, 'configuration-create-reconciled', JSON.stringify(done.payload));
  assert.deepEqual(invalidated.map((d) => path.resolve(d)), [path.resolve(app.workspaceDir)]);
  assert.equal(G.assertConfigurationCreatesClear(app.workspaceDir, { spec: spec(), env: ENV, languageCode: 1033 }).deferredUnits, 0);
});

test('a resolve over a workspace holding an unproven legacy configuration copy is refused before the receipt changes', async () => {
  const app = appWithUnit(spec(), 'custom-api', 'contoso_Calc');
  fs.writeFileSync(path.join(app.appDir, 'app-spec.json'), JSON.stringify(spec({ apis: false })));
  const prepared = await run(['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'defer'], { httpClient: noClient });
  assert.equal(prepared.ok, true, JSON.stringify(prepared.payload));
  // A copy an earlier plugin version wrote, with no metadata snapshot beside it: nothing proves it is what the environment held.
  const copy = path.join(app.workspaceDir, 'connection-references', 'contoso_c1.json');
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, JSON.stringify({ connectionreferencelogicalname: 'contoso_c1', connectionid: 'edited by hand' }));
  const receipt = path.join(app.workspaceDir, 'configuration-create-state.v1.json');
  const before = fs.readFileSync(receipt);
  const r = await run(['resolve', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'defer', '--approval-token', prepared.payload.approvalToken], { httpClient: noClient });
  assert.equal(r.ok, false);
  assert.equal(r.payload.code, 'WORKSPACE_LEGACY_CONFIGURATION_COPY', JSON.stringify(r.payload));
  assert.deepEqual(fs.readFileSync(receipt), before, 'the receipt is unchanged');
  assert.ok(fs.existsSync(copy), 'the copy is left as it was');
});

test('the current intent is compiled the way the build compiled the unit: over a preserved root, and under the recorded parent definition', () => {
  const s = {
    ...spec(),
    customApis: [{ uniqueName: 'contoso_Calc', isFunction: true, requestParameters: [{ uniqueName: 'A', type: 'integer' }, { uniqueName: 'B', type: 'integer' }] }],
    environmentVariables: [{ schemaName: 'contoso_V', type: 'string' }, { schemaName: 'contoso_D', type: 'dataSource', connectorId: SP, parameterKey: 'dataset', parentSchemaName: 'contoso_V' }],
  };
  const bindings = A.readDeploymentBindings({}, s);
  const receiptOf = (c) => { assert.equal(c.ok, true, JSON.stringify(c)); const { solution, ...unit } = c.unit; return unit; };
  const fresh = receiptOf(P.compileConfigurationCreateUnit(s, { kind: 'custom-api', key: 'contoso_Calc', bindings, solution: SOL }));
  const [root, kept, added] = fresh.rows;
  const baseline = { ok: true, root: { kind: 'custom-api', id: root.id, public: root.public }, children: [{ kind: kept.kind, id: kept.id, parentId: root.id, public: kept.public }] };
  const grown = receiptOf(P.compileConfigurationCreateUnit(s, { kind: 'custom-api', key: 'contoso_Calc', bindings, solution: SOL, baseline, additions: [added.key] }));
  assert.ok(grown.rows.some((r) => r.role === 'preserved'));
  assert.equal(currentIntentOf(s, grown, { bindings, solution: SOL }), grown.publicIntentSha256);
  // A data-source variable whose parent was bound to an existing definition: the intent keeps that recorded parent.
  const parentId = '11111111-2222-4333-8444-555555555555';
  const boundIdOf = (k, key) => (k === 'environmentVariable' && key === A.portKeyOf('environmentVariable', 'contoso_V') ? parentId : undefined);
  const child = receiptOf(P.compileConfigurationCreateUnit(s, { kind: 'environmentVariable', key: 'contoso_D', bindings, solution: SOL, boundIdOf }));
  assert.equal(child.rows[0].public.parentDefinitionId, parentId);
  assert.equal(currentIntentOf(s, child, { bindings, solution: SOL }), child.publicIntentSha256);
  // A declaration that is gone has no intent.
  assert.equal(currentIntentOf({ ...s, customApis: [] }, grown, { bindings, solution: SOL }), null);
});

// The SDK as a build left it in the app's durable workspace: the bundle itself, fetching the recorded root into the workspace as the
// build's overwriting read does, so the copy and its last-synced snapshot are real SDK files.
const bundle = require('../vendor/cds-maker-sdk.cjs');
async function workspaceCopy(org, workspaceDir, type, id) {
  const sdk = bundle.createMakerSdk({
    workspaceStorage: bundle.createNodeWorkspaceStorage(workspaceDir),
    instanceUrl: org.origin,
    httpClient: createAzHttpClient(org.origin, { getToken: () => 'test-token-0123456789abcdef', request: org.request, sleep: async () => {} }),
  });
  await sdk.initWorkspace();
  await sdk.fetchArtifact(type, id, { overwrite: true });
  return sdk;
}
const RULE = { key: 'check', name: 'Same surname', entity: 'contact', status: 'unpublished', conditions: [{ key: 'name', column: 'lastname', match: 'exact' }] };
const acceptArgv = (app, extra = []) => ['--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'accept-current', ...extra];

// A Custom API's or duplicate rule's copy in the workspace is the build's own artifact, and the build stops on one that holds an edit
// never sent (create-completion-required) rather than fetch over it. Recovery must not settle the unit over it either: it compares the
// copy with its snapshot (the SDK's own diff, over a storage that refuses writes and a client that refuses requests) in prepare and again
// in resolve, so a draft made after prepare is refused too. A clean copy changes nothing.
for (const [label, kind, key, type, s] of [
  ['Custom API', 'custom-api', 'contoso_Calc', 'customApi', spec()],
  ['duplicate rule', 'duplicate-rule', 'check', 'duplicateRule', { ...spec({ apis: false }), duplicateDetectionRules: [RULE] }],
]) {
  test(`accept-current refuses a unit whose ${label} copy in the workspace holds an unsent edit, in prepare and after it, and keeps the copy`, async () => {
    const org = orgOf();
    const app = appWithUnit(s, kind, key);
    await sendRows(org, app.compiled);
    const id = app.compiled.unit.root.id;
    const sdk = await workspaceCopy(org, app.workspaceDir, type, id);
    const { httpClient } = clientOver(org);
    const receipt = path.join(app.workspaceDir, 'configuration-create-state.v1.json');
    const mark = org.requests.length;
    // A clean copy: prepare goes on.
    const prepared = await run(['prepare', ...acceptArgv(app)], { httpClient });
    assert.equal(prepared.ok, true, JSON.stringify(prepared.payload));
    // A draft made after prepare: resolve is refused, the receipt and the draft are kept.
    await sdk.updateElement(type, id, '/description', 'a local draft never sent');
    assert.ok((await sdk.diffArtifact(type, id)).changes.length > 0, 'the SDK reports the draft');
    const copyFiles = () => fs.readdirSync(app.workspaceDir, { recursive: true }).filter((f) => f.endsWith(`${id}.json`) || f.endsWith(`${id}.meta.json`)).sort()
      .map((f) => [f, fs.readFileSync(path.join(app.workspaceDir, f)).toString('hex')]);
    const before = { receipt: fs.readFileSync(receipt), copy: copyFiles() };
    assert.equal(before.copy.length, 2, JSON.stringify(before.copy.map(([f]) => f)));
    const resolveArgv = ['resolve', ...acceptArgv(app, ['--approval-token', prepared.payload.approvalToken]), ...(prepared.payload.privateAcknowledgmentRequired ? ['--accept-current-private-state'] : [])];
    const done = await run(resolveArgv, { httpClient });
    assert.equal(done.ok, false);
    assert.equal(done.payload.code, 'create-completion-required', JSON.stringify(done.payload));
    assert.equal(done.payload.rootId, id);
    assert.equal(done.payload.unitId, app.unitId);
    assert.deepEqual(fs.readFileSync(receipt), before.receipt, 'the receipt is unchanged');
    assert.deepEqual(copyFiles(), before.copy, 'the copy and its snapshot are kept byte for byte');
    // A fresh prepare over the draft is refused the same way.
    const again = await run(['prepare', ...acceptArgv(app)], { httpClient });
    assert.equal(again.payload.code, 'create-completion-required', JSON.stringify(again.payload));
    assert.equal((await run(['inspect', '--app-dir', app.appDir], { httpClient: noClient })).payload.units.length, 1, 'the unit is still recorded');
    assert.deepEqual(org.writes(mark), [], 'recovery sent no write');
    assert.deepEqual(org.unexpected, []);
    // Once the maker discards the copy (nothing in it is needed), the unit is reconciled.
    for (const [f] of before.copy) fs.rmSync(path.join(app.workspaceDir, f));
    const prepared2 = await run(['prepare', ...acceptArgv(app)], { httpClient });
    assert.equal(prepared2.ok, true, JSON.stringify(prepared2.payload));
    const settled = await run(['resolve', ...acceptArgv(app, ['--approval-token', prepared2.payload.approvalToken]), ...(prepared2.payload.privateAcknowledgmentRequired ? ['--accept-current-private-state'] : [])], { httpClient });
    assert.equal(settled.payload.code, 'configuration-create-reconciled', JSON.stringify(settled.payload));
    assert.deepEqual(org.writes(mark), []);
  });
}

// A page the build writes calls what its bindings name: a Custom API through `actionBindings`, a connection reference through
// `connectorBindings`. A root a page still calls is not out of the build, so deferring it is refused while the page names it, and a
// page that names a deferred root stops every build guard. A binding to another name, and one named exactly as a built-in Dataverse
// operation (WhoAmI is no Custom API), depend on nothing.
// A spec of schema 2, where a sitemap entry names a page by its key.
const pageWith = (bindings) => ({
  schemaVersion: 2,
  pages: [{ key: 'main', name: 'Main', source: { kind: 'tsx', codeFile: 'main.tsx' }, ...bindings }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Links', subAreas: [{ page: 'main', title: 'Main' }] }] }] },
});
for (const [label, kind, key, gone, binding, other] of [
  ['an action binding', 'custom-api', 'contoso_Calc', spec({ apis: false }),
    { actionBindings: [{ name: 'contoso_Calc', isFunction: true }] }, { actionBindings: [{ name: 'contoso_Other', isFunction: true }, { name: 'WhoAmI', isFunction: true }] }],
  ['a connector binding', 'connection-reference', 'contoso_c1', { ...spec({ apis: false }), connectionReferences: [] },
    { connectorBindings: [{ logicalName: 'contoso_C1', connectorId: SP }] }, { connectorBindings: [{ logicalName: 'contoso_c2', connectorId: SP }] }],
]) {
  test(`defer is refused while a page still calls the root through ${label}, and a build guard refuses the page after deferral`, async () => {
    const app = appWithUnit(spec(), kind, key);
    const calling = { ...gone, ...pageWith(binding) };
    assert.equal(require('../lib/app-spec.js').validateAppSpec(calling).ok, true);
    fs.writeFileSync(path.join(app.appDir, 'app-spec.json'), JSON.stringify(calling));
    const prepareArgv = ['prepare', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'defer'];
    const refused = await run(prepareArgv, { httpClient: noClient });
    assert.equal(refused.ok, false);
    assert.equal(refused.payload.code, 'configuration-create-pending', JSON.stringify(refused.payload));
    assert.equal((await run(['inspect', '--app-dir', app.appDir], { httpClient: noClient })).payload.units[0].state, 'open');
    // A page that calls other names (and the built-in WhoAmI) does not hold the root: the deferral goes on.
    const unrelated = { ...gone, ...pageWith(other) };
    fs.writeFileSync(path.join(app.appDir, 'app-spec.json'), JSON.stringify(unrelated));
    const prepared = await run(prepareArgv, { httpClient: noClient });
    assert.equal(prepared.ok, true, JSON.stringify(prepared.payload));
    const done = await run(['resolve', '--app-dir', app.appDir, '--env', ENV, '--unit', app.unitId, '--resolution', 'defer', '--approval-token', prepared.payload.approvalToken], { httpClient: noClient });
    assert.equal(done.payload.code, 'configuration-create-reconciled', JSON.stringify(done.payload));
    assert.equal(G.assertConfigurationCreatesClear(app.workspaceDir, { spec: unrelated, env: ENV, languageCode: 1033 }).deferredUnits, 1);
    // After deferral, a page that calls the root again stops the build guard.
    assert.throws(() => G.assertConfigurationCreatesClear(app.workspaceDir, { spec: calling, env: ENV, languageCode: 1033 }), (e) => e.code === 'configuration-create-pending' && e.retry === 'never');
  });
}