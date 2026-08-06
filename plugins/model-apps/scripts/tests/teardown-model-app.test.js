'use strict';
// Thin wiring test for teardown-model-app.js: the validation gate, dry-run purity, that apply
// threads through to the teardown engine, and the phase-grouped [n/total] log + summary. The
// engine's per-kind behavior is covered exhaustively in sdk-teardown.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { teardownModelApp, cliEmit } = require(path.join(__dirname, '..', 'teardown-model-app.js'));

const desk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'app-spec.support-desk.json'), 'utf8'));

// An SDK that reports every artifact as present (one id each) so apply performs deletes.
// Stateful for tables so the table delete flow simulates the SDK cosmetic-404 (deleteTable
// throws 404 even on success).
function presentSdk() {
  const calls = [];
  const deletedTables = new Set();
  const deletedRelationships = new Set();
  const resolveArtifact = async (kind, identity) => {
    calls.push({ method: 'resolveArtifact', kind, identity });
    if (kind === 'app') return [{ id: 'id1', name: 'App', appModuleIdUnique: 'unique-id1' }];
    if (kind === 'dashboard') return [{ id: 'id2', name: 'Dash' }];
    if (kind === 'form') return [{ id: 'id-form', name: 'Form' }];
    if (kind === 'chart') return [{ id: 'id-chart', name: 'Chart' }];
    if (kind === 'view') return [{ id: 'id-view', name: 'View' }];
    if (kind === 'command') return [{ id: identity.entity, entity: identity.entity }];
    if (kind === 'webResource') return [{ id: 'id4', name: 'wr' }];
    if (kind === 'solution') return [{ id: 'id5', name: 'Sol' }];
    return [];
  };
  const deleteAppCascade = async (appModuleId, appModuleIdUnique) => {
    calls.push({ method: 'deleteAppCascade', appModuleId, appModuleIdUnique });
  };
  const deleteRemoteArtifact = async (type, id) => {
    calls.push({ method: 'deleteRemoteArtifact', type, id });
  };
  const deleteRelationship = async (schemaName) => {
    calls.push({ method: 'deleteRelationship', schemaName });
    deletedRelationships.add(schemaName);
  };
  const deleteWebResource = async (id) => {
    calls.push({ method: 'deleteWebResource', id });
  };
  const deleteTable = async (logical) => {
    calls.push({ method: 'deleteTable', logical });
    deletedTables.add(logical);
    // SDK deleteTable throws not-found even on success
    const err = new Error('Could not find an entity with specified id');
    err.statusCode = 404;
    throw err;
  };
  const deleteSolution = async (id) => {
    calls.push({ method: 'deleteSolution', id });
  };
  // Form resolution now runs through resolveExistingFormId → queryRecords('systemform') (type-scoped),
  // replacing the old resolveArtifact('form'). Mirror the old single-form behavior: any form name/id
  // lookup resolves to 'id-form'.
  const queryRecords = async (entitySet, opts) => {
    calls.push({ method: 'queryRecords', entitySet });
    const filter = (opts && opts.filter) || '';
    if (entitySet === 'systemform') {
      if (/formid eq /.test(filter)) return [{ formid: 'id-form', objecttypecode: 'new_x', type: 2, name: 'Form' }];
      if (/name eq '/.test(filter)) return [{ formid: 'id-form' }];
    }
    return [];
  };
  return { resolveArtifact, queryRecords, deleteAppCascade, deleteRemoteArtifact, deleteRelationship, deleteWebResource, deleteTable, deleteSolution, calls };
}

const logCapture = () => { const logs = []; return { log: (m) => logs.push(m), logs }; };

test('rejects an invalid spec before any teardown', async () => {
  const sdk = presentSdk();
  const r = await teardownModelApp({ entities: [] }, { apply: true }, { sdk });
  assert.strictEqual(r.ok, false);
  assert.ok(Array.isArray(r.errors) && r.errors.length);
  assert.strictEqual(sdk.calls.length, 0, 'no SDK calls on a bad spec');
});

test('dry-run returns the plan and never touches the SDK', async () => {
  const throwing = { queryRecords: () => { throw new Error('dry-run must not call the SDK'); } };
  const r = await teardownModelApp(desk, { apply: false }, { sdk: throwing });
  assert.strictEqual(r.dryRun, true);
  assert.ok(r.plan.some((p) => /app module/.test(p)));
  assert.ok(r.plan.some((p) => /^table /.test(p)));
  assert.ok(r.plan.some((p) => /^solution /.test(p)));
});

test('apply without --allow-destructive halts before any delete (fail-closed)', async () => {
  const sdk = presentSdk();
  const cap = logCapture();
  const r = await teardownModelApp(desk, { apply: true }, { sdk, log: cap.log });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => /allow-destructive/.test(e)));
  assert.strictEqual(sdk.calls.length, 0, 'no SDK calls — halted before touching anything');
  assert.ok(cap.logs.some((l) => /refusing to delete/.test(l)), 'a clear refusal is printed');
});

test('apply --allow-destructive performs the deletes', async () => {
  const sdk = presentSdk();
  const r = await teardownModelApp(desk, { apply: true, allowDestructive: true }, { sdk });
  assert.strictEqual(r.ok, true);
  assert.ok(sdk.calls.some((c) => c.method === 'deleteAppCascade'), 'app deleted');
});

test('apply threads through to the engine (deletes issued) and returns ok', async () => {
  const sdk = presentSdk();
  const r = await teardownModelApp(desk, { apply: true, allowDestructive: true }, { sdk });
  assert.strictEqual(r.ok, true);
  assert.ok(sdk.calls.some((c) => c.method === 'deleteAppCascade'), 'app deleted via deleteAppCascade');
  assert.ok(sdk.calls.some((c) => c.method === 'deleteTable'));
  assert.ok(sdk.calls.some((c) => c.method === 'deleteSolution'));
});

test('apply emits status-marked [n/total] lines under phase headers + a summary', async () => {
  const sdk = presentSdk();
  const cap = logCapture();
  await teardownModelApp(desk, { apply: true, allowDestructive: true }, { sdk, log: cap.log });
  const lines = cap.logs.filter((l) => /\[\d+\/\d+\]/.test(l));
  assert.ok(lines.length >= 4);
  const totals = new Set(lines.map((l) => Number(l.match(/\[\d+\/(\d+)\]/)[1])));
  assert.strictEqual(totals.size, 1, 'one consistent total');
  assert.ok(cap.logs.some((l) => /▶ /.test(l)), 'phases grouped under ▶ headers');
  assert.ok(cap.logs.some((l) => /✓/.test(l)), 'deleted steps marked ✓');
  assert.ok(cap.logs.some((l) => /teardown complete — \d+ deleted/.test(l)), 'a closing summary is printed');
});

test('dry-run lists the plan with a ▢ marker and no summary', async () => {
  const throwing = { queryRecords: () => { throw new Error('no SDK'); } };
  const cap = logCapture();
  await teardownModelApp(desk, { apply: false }, { sdk: throwing, log: cap.log });
  assert.ok(cap.logs.some((l) => /\[\d+\/\d+\] ▢ /.test(l)), 'plan items use the ▢ marker');
  assert.ok(!cap.logs.some((l) => /teardown complete/.test(l)), 'no summary on a dry-run');
});

test('cliEmit: an error event with no detail has no dangling separator', () => {
  const logs = [];
  const emit = cliEmit((m) => logs.push(m), { apply: true, counts: {} });
  emit({ phase: 'p', status: 'error', label: 'thing', n: 1, total: 2 }); // no detail
  emit({ phase: 'p', status: 'error', label: 'thing2', detail: 'boom', n: 2, total: 2 });
  const noDetail = logs.find((l) => /thing(?!2)/.test(l));
  const withDetail = logs.find((l) => /thing2/.test(l));
  assert.ok(!/—\s*$/.test(noDetail) && !noDetail.includes(' — '), `no dangling separator: ${JSON.stringify(noDetail)}`);
  assert.ok(withDetail.includes(' — boom'), 'detail still rendered with separator');
});

// ---- #changed-only snapshot lifecycle: tombstone-before-delete + delete-after-clean-teardown ----------
const os = require('node:os');
const snap = require('../lib/apply-snapshot.js');
const snapStore = require('../lib/apply-snapshot-store.js');

function eligibleSnap(ws, appId) {
  const env = snap.makeEnvelope({ orgId: 'o', envUrl: 'https://e', appUniqueName: 'a', appId }, { generation: 'g' });
  snap.markEligible(env);
  snapStore.writeSnapshotAtomic(ws, env);
}

test('teardown --apply TOMBSTONES the snapshot before deleting, then DELETES it after a clean teardown', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'td-snap-'));
  try {
    eligibleSnap(ws, 'app-1');
    const sdk = presentSdk();
    const r = await teardownModelApp(desk, { apply: true, allowDestructive: true, workspaceDir: ws }, { sdk });
    assert.strictEqual(r.ok, true);
    // A clean teardown removes the envelope entirely (fresh rebuild starts a new baseline).
    assert.strictEqual(snapStore.readSnapshot(ws), null, 'the snapshot is deleted after a clean teardown');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('a teardown that finishes WITH ERRORS leaves the tombstone (snapshot not deleted, stays ineligible)', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'td-snap-'));
  try {
    eligibleSnap(ws, 'app-1');
    // An SDK whose app delete fails -> teardown r.ok=false -> the envelope must survive as a tombstone.
    const sdk = presentSdk();
    sdk.deleteAppCascade = async () => { throw new Error('app delete failed'); };
    const r = await teardownModelApp(desk, { apply: true, allowDestructive: true, workspaceDir: ws }, { sdk });
    const disk = snapStore.readSnapshot(ws);
    assert.ok(disk, 'the snapshot survives a failed teardown');
    assert.strictEqual(disk.eligible, false, 'tombstoned ineligible');
    assert.ok(snap.isTombstoned(disk), 'carries the teardown-in-progress debt');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});

test('teardown dry-run does NOT tombstone or delete the snapshot', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'td-snap-'));
  try {
    eligibleSnap(ws, 'app-1');
    await teardownModelApp(desk, { apply: false, workspaceDir: ws }, { sdk: presentSdk() });
    const disk = snapStore.readSnapshot(ws);
    assert.ok(disk && disk.eligible === true, 'a dry-run leaves the eligible snapshot untouched');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
