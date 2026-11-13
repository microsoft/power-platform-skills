'use strict';
// The configuration create receipt guard module (lib/configuration-create-guard.js, #807) over a REAL receipt written by
// lib/configuration-create-state.js: what it builds from an App Spec, its acknowledgment of quarantines, teardown's stricter check and
// the engine's one-attempt use of an acknowledgment. What each entry point does with it is in configuration-create-entry-guards.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { ENV } = require('./helpers/build-command-harness.js');
const { appUniqueName } = require('../lib/app-unique-name.js');
const A = require('../lib/configuration-artifacts.js');
const P = require('../lib/configuration-create-plan.js');
const S = require('../lib/configuration-create-state.js');
const G = require('../lib/configuration-create-guard.js');
const { runSdkBuild } = require('../lib/sdk-build.js');
const { runRecoveryCommand } = require('../configuration-recovery.js');
const { RETRY } = require('../lib/retry-policy.js');

const SOL = 'contoso';
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const RECEIPT_KT = P.CONFIGURATION_CREATE_RECEIPT_KIND_TABLE;
const spec = ({ references = true } = {}) => ({
  schemaVersion: 2,
  minimumPluginVersion: '2.21.0',
  solution: { uniqueName: SOL, publisherPrefix: 'contoso' },
  app: { name: 'Guard Probe' },
  entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
  connectionReferences: references ? [{ logicalName: 'contoso_c1', connectorId: SP }] : [],
});

// A receipt in `workspaceDir` with one prepared unit for the connection reference, saved for `environmentUrl`.
function writeReceipt(workspaceDir, s = spec(), { environmentUrl = ENV } = {}) {
  const c = P.compileConfigurationCreateUnit(s, { kind: 'connection-reference', key: 'contoso_c1', bindings: A.readDeploymentBindings({}, s), solution: SOL });
  assert.equal(c.ok, true, JSON.stringify(c));
  const { solution, ...unit } = c.unit;
  const context = S.createStateContext({ environmentUrl, solutionUniqueName: SOL, appUniqueName: appUniqueName(s), authoringLanguageCode: 1033 });
  S.prepareCreateUnit(workspaceDir, { kindTable: RECEIPT_KT, context, unit });
  return S.readConfigurationCreateState(workspaceDir, { kindTable: RECEIPT_KT }).units[0].unitId;
}
// A receipt made unreadable and quarantined: the workspace then holds one deferred quarantine.
function quarantine(workspaceDir) {
  writeReceipt(workspaceDir);
  fs.writeFileSync(path.join(workspaceDir, 'configuration-create-state.v1.json'), '{"not":"a receipt"}');
  return S.quarantineUnreadableReceipt(workspaceDir, { kindTable: RECEIPT_KT, acknowledgeUnknownDispatch: true }).quarantineId;
}
const halts = (code) => (e) => {
  assert.equal(e.code, code, e.message);
  assert.equal(e.retry, RETRY.NEVER);
  assert.equal(e.recoverable, false);
  return true;
};
const guard = (dir, extra = {}) => G.assertConfigurationCreatesClear(dir, { spec: spec(), env: ENV, languageCode: 1033, ...extra });

test('the guard passes a workspace with no receipt, and stops an open unit, another environment and an unreadable receipt', () => {
  const dir = makeTempDir('cfg-guard-');
  assert.equal(guard(dir).acknowledged, false);
  const unitId = writeReceipt(dir);
  assert.throws(() => guard(dir), (e) => halts('configuration-create-pending')(e) && e.unitId === unitId);
  const other = makeTempDir('cfg-guard-');
  writeReceipt(other, spec(), { environmentUrl: 'https://fabrikam.crm.dynamics.com' });
  assert.throws(() => guard(other), halts('configuration-create-context-mismatch'));
  // The language is borrowed from the receipt when the caller does not know it yet; the environment is still compared.
  assert.throws(() => guard(other, { languageCode: undefined }), halts('configuration-create-context-mismatch'));
  fs.writeFileSync(path.join(dir, 'configuration-create-state.v1.json'), 'not json');
  assert.throws(() => guard(dir), halts('configuration-create-state-invalid'));
});

test('a deferred unit stops only a build that brings its root back', async () => {
  const appDir = path.join(makeTempDir('cfg-guard-'), 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const ws = path.join(appDir, '.maker-workspace');
  const unitId = writeReceipt(ws);
  fs.writeFileSync(path.join(appDir, 'app-spec.json'), JSON.stringify(spec({ references: false })));
  const prepared = await runRecoveryCommand(['prepare', '--app-dir', appDir, '--env', ENV, '--unit', unitId, '--resolution', 'defer'], { warn: () => {} });
  const done = await runRecoveryCommand(['resolve', '--app-dir', appDir, '--env', ENV, '--unit', unitId, '--resolution', 'defer', '--approval-token', prepared.payload.approvalToken], { warn: () => {} });
  assert.equal(done.payload.code, 'configuration-create-reconciled', JSON.stringify(done.payload));
  assert.equal(G.assertConfigurationCreatesClear(ws, { spec: spec({ references: false }), env: ENV, languageCode: 1033 }).deferredUnits, 1);
  assert.throws(() => guard(ws), halts('configuration-create-pending'));
});

test('a quarantine stops configuration work until this invocation acknowledges exactly it; other work proceeds', () => {
  const dir = makeTempDir('cfg-guard-');
  const id = quarantine(dir);
  assert.throws(() => guard(dir), halts('configuration-create-quarantined'));
  assert.equal(guard(dir, { phases: ['app-shell'] }).acknowledged, false, 'a run without the data-model phase does no configuration work');
  assert.equal(G.assertConfigurationCreatesClear(dir, { spec: spec({ references: false }), env: ENV, languageCode: 1033 }).acknowledged, false);
  // Raw ids are never an acknowledgment; only the one validated at the entry point is.
  assert.throws(() => guard(dir, { quarantineAcknowledgment: { quarantineIds: [id] } }), halts('configuration-create-quarantined'));
  assert.throws(() => G.acknowledgeQuarantines(dir, '00000000-0000-4000-8000-000000000000'), halts('configuration-create-approval-stale'));
  assert.throws(() => G.acknowledgeQuarantines(dir, ''), halts('configuration-create-quarantined'));
  assert.equal(guard(dir, { quarantineAcknowledgment: G.acknowledgeQuarantines(dir, id) }).acknowledged, true);
});

test('teardown refuses every receipt but an empty valid one', () => {
  const empty = makeTempDir('cfg-guard-');
  G.assertTeardownClear(empty);
  const open = makeTempDir('cfg-guard-');
  writeReceipt(open);
  assert.throws(() => G.assertTeardownClear(open), (e) => e.retry === RETRY.NEVER && /^configuration-create-/.test(e.code));
  const quarantined = makeTempDir('cfg-guard-');
  quarantine(quarantined);
  assert.throws(() => G.assertTeardownClear(quarantined), (e) => e.retry === RETRY.NEVER && /^configuration-create-/.test(e.code));
  // What a crash can leave: an archive whose marker was never written, a marker whose archive is missing. Both are kept and refused.
  for (const drop of ['quarantine', 'unreadable']) {
    const dir = makeTempDir('cfg-guard-');
    const id = quarantine(dir);
    const ext = drop === 'quarantine' ? 'json' : 'bin';
    fs.rmSync(path.join(dir, `configuration-create-state.${drop}.${id}.${ext}`));
    const before = fs.readdirSync(dir).sort();
    assert.throws(() => G.assertTeardownClear(dir), (e) => e.retry === RETRY.NEVER && /^configuration-create-/.test(e.code), drop);
    assert.throws(() => guard(dir, { phases: ['app-shell'] }), (e) => e.retry === RETRY.NEVER && /^configuration-create-/.test(e.code), `${drop}: a build without configuration work is stopped too`);
    assert.deepEqual(fs.readdirSync(dir).sort(), before, `${drop}: nothing is removed`);
  }
});

test('the engine spends a quarantine acknowledgment on one attempt: a second run with the same one is stopped', async () => {
  const dir = makeTempDir('cfg-guard-');
  const id = quarantine(dir);
  const ack = G.acknowledgeQuarantines(dir, id);
  const sdk = { queryRecords: async () => [{ solutionid: '11111111-1111-4111-8111-111111111111' }] };
  const opts = { sdk, provisionSdk: sdk, apply: true, workspaceDir: dir, env: ENV, preResolvedLanguageCode: 1033, phases: ['solution', 'data-model'], configurationQuarantineAcknowledgment: ack };
  // The first run passes the guard (whatever the phases then answer); the second is refused at the guard.
  await runSdkBuild(spec(), opts).catch((e) => assert.notEqual(e.code, 'configuration-create-quarantined', e.message));
  await assert.rejects(runSdkBuild(spec(), opts), halts('configuration-create-quarantined'));
});
