'use strict';
// The configuration create receipt stops every entry that can change an environment for an app (#807): the build engine
// (sdk-build.js runSdkBuild), the changed-only flow and the build command, each over a REAL receipt, quarantine or crash-left
// evidence written by lib/configuration-create-state.js. No shortcut gets past it: a phase-only apply, an App Spec that no longer
// declares any configuration, the protected path and a changed-only apply all stop before anything is read or sent, and nothing
// certifies the environment (no baseline, no changed-only snapshot). A workspace with no receipt is unchanged.
//
// This file loads only the receipt modules and the entry points, never the guard module itself, so each assertion here is about
// what an entry does; the guard's own unit tests are in configuration-create-guard.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { appFolder, command, settle, ENV } = require('./helpers/build-command-harness.js');
const { appUniqueName } = require('../lib/app-unique-name.js');
const A = require('../lib/configuration-artifacts.js');
const P = require('../lib/configuration-create-plan.js');
const S = require('../lib/configuration-create-state.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const flow = require('../lib/changed-only-flow.js');
const { RETRY } = require('../lib/retry-policy.js');

const SOL = 'contoso';
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const RECEIPT_KT = P.CONFIGURATION_CREATE_RECEIPT_KIND_TABLE;
const RECEIPT = 'configuration-create-state.v1.json';
const spec = ({ references = true, protectedPath = false } = {}) => ({
  schemaVersion: 2,
  minimumPluginVersion: '2.21.0',
  ...(protectedPath ? { configurationIdentity: 'stable-v1' } : {}),
  solution: { uniqueName: SOL, publisherPrefix: 'contoso' },
  app: { name: 'Guard Probe' },
  entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
  connectionReferences: references ? [{ logicalName: 'contoso_c1', connectorId: SP }] : [],
});

// A receipt in `workspaceDir` with one prepared (nothing sent yet) unit for the connection reference, saved for `environmentUrl`.
function writeReceipt(workspaceDir, { environmentUrl = ENV } = {}) {
  const s = spec();
  const c = P.compileConfigurationCreateUnit(s, { kind: 'connection-reference', key: 'contoso_c1', bindings: A.readDeploymentBindings({}, s), solution: SOL });
  assert.equal(c.ok, true, JSON.stringify(c));
  const { solution, ...unit } = c.unit;
  const context = S.createStateContext({ environmentUrl, solutionUniqueName: SOL, appUniqueName: appUniqueName(s), authoringLanguageCode: 1033 });
  S.prepareCreateUnit(workspaceDir, { kindTable: RECEIPT_KT, context, unit });
  return S.readConfigurationCreateState(workspaceDir, { kindTable: RECEIPT_KT }).units[0].unitId;
}
// A receipt made unreadable and quarantined: the workspace then holds one deferred quarantine (its marker and its archive).
function quarantine(workspaceDir) {
  writeReceipt(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, RECEIPT), '{"not":"a receipt"}');
  return S.quarantineUnreadableReceipt(workspaceDir, { kindTable: RECEIPT_KT, acknowledgeUnknownDispatch: true }).quarantineId;
}
// Evidence a crash can leave: a quarantine whose marker was never written beside its archive (an orphan archive), and one whose
// archive is missing beside its marker (an incomplete quarantine).
function crashLeft(workspaceDir, which) {
  const id = quarantine(workspaceDir);
  const name = which === 'orphan archive' ? `configuration-create-state.quarantine.${id}.json` : `configuration-create-state.unreadable.${id}.bin`;
  assert.ok(fs.existsSync(path.join(workspaceDir, name)), `${name} was written`);
  fs.rmSync(path.join(workspaceDir, name));
}
const halts = (code) => (e) => {
  assert.ok(e && typeof e === 'object', `expected the ${code} halt`);
  assert.equal(e.code, code, e.message);
  assert.equal(e.retry, RETRY.NEVER);
  assert.equal(e.recoverable, false);
  return true;
};
const blockedByEvidence = (e) => {
  assert.ok(e && typeof e.code === 'string' && e.code.startsWith('configuration-create-'), `expected a configuration create halt, got ${e && e.code}: ${e && e.message}`);
  assert.equal(e.retry, RETRY.NEVER);
  return true;
};
// What an engine run would read: the solution lookup every apply starts with, recorded.
function engineSdk() {
  const reads = [];
  const sdk = { queryRecords: async (entity) => { reads.push(entity); return [{ solutionid: '11111111-1111-4111-8111-111111111111' }]; } };
  return { sdk, reads };
}
const engineOpts = (dir, sdk, extra = {}) => ({ sdk, provisionSdk: sdk, apply: true, workspaceDir: dir, env: ENV, preResolvedLanguageCode: 1033, ...extra });
const certified = (dir) => ['last-applied.json', 'apply-snapshot.json'].filter((n) => fs.existsSync(path.join(dir, n)));

test('the build engine stops an open unit under its lease before it reads anything, whatever shortcut the run would take', async () => {
  for (const [label, s, extra] of [
    ['a full apply', spec(), {}],
    ['a phase-only apply', spec(), { phases: ['app-shell'] }],
    ['an App Spec that no longer declares the unit', spec({ references: false }), {}],
    ['an App Spec on the protected path', spec({ protectedPath: true }), {}],
  ]) {
    const dir = makeTempDir('cfg-entry-');
    const unitId = writeReceipt(dir);
    const { sdk, reads } = engineSdk();
    await assert.rejects(runSdkBuild(s, engineOpts(dir, sdk, extra)), (e) => halts('configuration-create-pending')(e) && e.unitId === unitId, label);
    assert.deepEqual(reads, [], `${label}: nothing was read`);
    assert.deepEqual(certified(dir), [], `${label}: nothing certified`);
    assert.ok(!fs.readdirSync(dir).some((n) => n.startsWith('app-build.')), `${label}: the lease was let go`);
  }
});

test('the build engine stops a receipt of another environment, an unreadable receipt and crash-left quarantine evidence', async () => {
  const other = makeTempDir('cfg-entry-');
  writeReceipt(other, { environmentUrl: 'https://fabrikam.crm.dynamics.com' });
  const unreadable = makeTempDir('cfg-entry-');
  writeReceipt(unreadable);
  fs.writeFileSync(path.join(unreadable, RECEIPT), 'not json');
  // A receipt renamed by hand is still evidence: the workspace keeps an unknown recovery file, never a clean slate.
  const renamed = makeTempDir('cfg-entry-');
  writeReceipt(renamed);
  fs.renameSync(path.join(renamed, RECEIPT), path.join(renamed, 'configuration-create-state.v1.json.bak'));
  const orphan = makeTempDir('cfg-entry-');
  crashLeft(orphan, 'orphan archive');
  const incomplete = makeTempDir('cfg-entry-');
  crashLeft(incomplete, 'marker without archive');
  for (const [label, dir, check] of [
    ['another environment', other, halts('configuration-create-context-mismatch')],
    ['an unreadable receipt', unreadable, halts('configuration-create-state-invalid')],
    ['a renamed receipt', renamed, blockedByEvidence],
    ['an orphan archive', orphan, blockedByEvidence],
    ['a marker without its archive', incomplete, blockedByEvidence],
  ]) {
    const { sdk, reads } = engineSdk();
    await assert.rejects(runSdkBuild(spec(), engineOpts(dir, sdk, { phases: ['solution'] })), check, label);
    assert.deepEqual(reads, [], `${label}: nothing was read`);
  }
});

test('the build engine stops configuration work beside a quarantine; a run without the data-model phase or without configuration passes it', async () => {
  const dir = makeTempDir('cfg-entry-');
  quarantine(dir);
  const { sdk } = engineSdk();
  await assert.rejects(runSdkBuild(spec(), engineOpts(dir, sdk)), halts('configuration-create-quarantined'));
  for (const [label, s, extra] of [['a phase-only apply', spec(), { phases: ['solution'] }], ['an App Spec without configuration', spec({ references: false }), { phases: ['solution'] }]]) {
    await runSdkBuild(s, engineOpts(dir, engineSdk().sdk, extra)).then(
      () => {},
      (e) => assert.ok(!(e && typeof e.code === 'string' && e.code.startsWith('configuration-create-')), `${label}: ${e && e.code} ${e && e.message}`),
    );
  }
});

test('the changed-only flow stops before it reads the snapshot or the live app, the protected switch included', async () => {
  for (const [label, s, prepare] of [
    ['an open unit', spec(), (dir) => writeReceipt(dir)],
    ['an open unit on the protected path', spec({ protectedPath: true }), (dir) => writeReceipt(dir)],
    ['an unacknowledged quarantine', spec(), (dir) => quarantine(dir)],
  ]) {
    const dir = makeTempDir('cfg-entry-');
    prepare(dir);
    const calls = [];
    await assert.rejects(flow.runChangedOnlyApply({ spec: s, opts: { workspaceDir: dir, apply: true, env: ENV, preResolvedLanguageCode: 1033 }, deps: {
      log: () => {},
      readContent: () => { calls.push('readContent'); return null; },
      resolveLiveIdentity: async () => { calls.push('resolveLiveIdentity'); return null; },
      buildModelApp: async () => { calls.push('buildModelApp'); return { ok: true }; },
    } }), blockedByEvidence, label);
    assert.deepEqual(calls, [], label);
    assert.deepEqual(certified(dir), [], `${label}: no snapshot or baseline`);
  }
});

test('the build command stops an apply over an open unit before the SDK, the engine or the baseline; a dry run warns and notes it', async () => {
  for (const [label, argv, s] of [
    ['a full apply', [], spec()],
    ['a phase-only apply', ['--only', 'app-shell'], spec()],
    ['a changed-only apply', ['--changed-only'], spec()],
    ['an App Spec without configuration', [], spec({ references: false })],
    ['the protected path', [], spec({ protectedPath: true })],
  ]) {
    const folder = appFolder(s);
    fs.mkdirSync(folder.workspaceDir, { recursive: true });
    const unitId = writeReceipt(folder.workspaceDir);
    const applied = command(folder, { argv });
    const outcome = await settle(applied);
    assert.ok(outcome.thrown, `${label}: ${JSON.stringify(outcome)} ${applied.calls.join(',')}`);
    halts('configuration-create-pending')(outcome.thrown);
    assert.equal(outcome.thrown.unitId, unitId);
    for (const step of ['sdk', 'engine', 'baseline', 'verify']) assert.ok(!applied.calls.includes(step), `${label}: no ${step} (${applied.calls.join(',')})`);
    assert.deepEqual(certified(folder.workspaceDir), [], `${label}: nothing certified`);
    assert.equal(outcome.heldThen, false, `${label}: the lease was let go`);
  }

  const folder = appFolder(spec());
  fs.mkdirSync(folder.workspaceDir, { recursive: true });
  const unitId = writeReceipt(folder.workspaceDir);
  const dry = command(folder, { apply: false });
  await settle(dry);
  assert.ok(dry.calls.includes('engine'), dry.calls.join(','));
  assert.equal(dry.printed.payload.configurationCreate.code, 'configuration-create-pending');
  assert.equal(dry.printed.payload.configurationCreate.unitId, unitId);
  assert.match(dry.cli.stderrText(), /An --apply of this App Spec stops here/);
  assert.equal(S.readConfigurationCreateState(folder.workspaceDir, { kindTable: RECEIPT_KT }).units[0].unitId, unitId, 'the receipt is unchanged');
});

test('the build command validates --acknowledge-quarantined-configuration and hands the validated acknowledgment to the build', async () => {
  const folder = appFolder(spec());
  fs.mkdirSync(folder.workspaceDir, { recursive: true });
  const id = quarantine(folder.workspaceDir);
  const refused = command(folder);
  const stopped = await settle(refused);
  halts('configuration-create-quarantined')(stopped.thrown);
  assert.ok(!refused.calls.includes('engine'));
  const seen = [];
  const run = command(folder, { argv: ['--acknowledge-quarantined-configuration', id], engine: (held, o) => { seen.push(o.configurationQuarantineAcknowledgment); return { ok: true, dryRun: false, created: {} }; } });
  await settle(run);
  assert.equal(seen.length, 1, run.calls.join(','));
  assert.deepEqual([...seen[0].quarantineIds], [id]);
  const stale = await settle(command(folder, { argv: ['--acknowledge-quarantined-configuration', '00000000-0000-4000-8000-000000000000'] }));
  halts('configuration-create-approval-stale')(stale.thrown);
  // The quarantine and its archive are kept, whatever was acknowledged.
  assert.ok(fs.existsSync(path.join(folder.workspaceDir, `configuration-create-state.quarantine.${id}.json`)));
  assert.ok(fs.existsSync(path.join(folder.workspaceDir, `configuration-create-state.unreadable.${id}.bin`)));
});

test('a workspace with no receipt runs the build command as before, on the protected path too', async () => {
  for (const s of [spec(), spec({ protectedPath: true })]) {
    const folder = appFolder(s);
    const run = command(folder);
    await settle(run);
    assert.ok(run.calls.includes('engine'), run.calls.join(','));
    assert.equal(run.printed.payload.configurationCreate, undefined);
    assert.ok(!fs.existsSync(folder.workspaceDir) || !fs.readdirSync(folder.workspaceDir).some((n) => n.startsWith('configuration-create-state.')), 'no receipt is written by the guard');
  }
});
