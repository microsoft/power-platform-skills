'use strict';
// Thin wiring test for teardown-model-app.js: the validation gate, dry-run purity, that apply
// threads through to the teardown engine, and the phase-grouped [n/total] log + summary. The
// engine's per-kind behavior is covered exhaustively in sdk-teardown.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
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

test('deleteAppCascade rejection is reported as a failed app step and teardown continues', async () => {
  const sdk = presentSdk();
  sdk.deleteAppCascade = async (appModuleId, appModuleIdUnique) => {
    sdk.calls.push({ method: 'deleteAppCascade', appModuleId, appModuleIdUnique });
    throw new Error('delete not confirmed: generative page is shared by another app');
  };
  const cap = logCapture();

  const r = await teardownModelApp(desk, { apply: true, allowDestructive: true }, { sdk, log: cap.log });

  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.step === 'app module "Support Desk"' && /delete not confirmed/.test(e.message)));
  assert.ok(cap.logs.some((l) => /✗ app module "Support Desk" — delete not confirmed/.test(l)));
  assert.ok(sdk.calls.some((c) => c.method === 'deleteSolution'), 'later steps still run after the app refusal');
  assert.ok(cap.logs.some((l) => /teardown finished with errors/.test(l)), 'the summary stays visibly non-clean');
});

test('deleteAppCascade resolved success:false reports orphaned generative-page children', async () => {
  const sdk = presentSdk();
  sdk.deleteAppCascade = async (appModuleId, appModuleIdUnique) => {
    sdk.calls.push({ method: 'deleteAppCascade', appModuleId, appModuleIdUnique });
    return {
      success: false,
      deleted: [{ type: 'app', id: appModuleId }],
      failures: [
        { operation: 'delete', type: 'genPageFile', id: 'file-1', error: new Error('file remained') },
        { operation: 'delete', type: 'genPage', id: 'page-1', error: new Error('page remained') },
      ],
    };
  };
  const cap = logCapture();

  const r = await teardownModelApp(desk, { apply: true, allowDestructive: true }, { sdk, log: cap.log });
  const message = r.errors.map((e) => e.message).join('\n');

  assert.strictEqual(r.ok, false);
  assert.match(message, /app "App" deleted, but 2 cascade cleanup step\(s\) failed \(orphaned rows remain\)/);
  assert.match(message, /delete genPageFile file-1: file remained/);
  assert.match(message, /delete genPage page-1: page remained/);
  assert.doesNotMatch(message, /sitemap/i, 'the app sitemap is no longer reported as a separate cascade target');
  assert.ok(cap.logs.some((l) => /✗ app module "Support Desk"/.test(l) && /orphaned rows remain/.test(l)));
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

function loadTeardownCli({
  parseResult,
  validation = { ok: true },
  runResult = { ok: true, dryRun: false },
  runThrows = null,
  sdkThrows = null,
  workspaceExists = true,
  invokeAsMain = false,
  emitThrows = false,
}) {
  const scriptPath = path.join(__dirname, '..', 'teardown-model-app.js');
  const source = `${fs.readFileSync(scriptPath, 'utf8')}\nmodule.exports.__mainForTest = main;\n`;
  const events = [];
  const stderr = [];
  const mod = { exports: {} };
  const sdkTemp = 'D:\\Projects\\power-platform-skills-sdk\\.test-workspace\\teardown-sdk';
  const fakeFs = {
    mkdtempSync: (prefix) => {
      events.push({ type: 'mkdtempSync', prefix });
      return sdkTemp;
    },
    rmSync: (dir, opts) => events.push({ type: 'rmSync', dir, opts }),
    existsSync: (dir) => {
      events.push({ type: 'existsSync', dir });
      return workspaceExists;
    },
  };
  const customRequire = (id) => {
    if (id === 'node:fs') return fakeFs;
    if (id === 'node:path') return path;
    if (id === 'node:os') return { tmpdir: () => 'D:\\Projects\\power-platform-skills-sdk\\.test-workspace' };
    if (id === './lib/app-spec.js') {
      return {
        validateAppSpec: () => validation,
        migrateAppSpec: (spec) => {
          events.push({ type: 'migrateAppSpec', spec });
          return { ...spec, migrated: true };
        },
      };
    }
    if (id === './lib/sdk-teardown.js') {
      return {
        runTeardown: async (spec, opts, deps) => {
          events.push({ type: 'runTeardown', spec, opts });
          if (runThrows) throw runThrows;
          deps.emit({ phase: 'app', status: runResult.ok ? 'ok' : 'error', label: 'app module "Support Desk"', n: 1, total: 1, detail: runResult.ok ? '' : 'refused' });
          return runResult;
        },
      };
    }
    if (id === './lib/op-diff.js') {
      return { classifyOps: () => ({ hasDestructive: false, destructive: [] }) };
    }
    if (id === './lib/sdk-http-client.js') {
      return { createAzHttpClient: (env) => ({ env }) };
    }
    if (id === './lib/dataverse-auth.js') {
      return {
        parseArgs: () => parseResult,
        readJsonArg: (arg) => {
          events.push({ type: 'readJsonArg', arg });
          return { app: { name: 'Support Desk' }, solution: { publisherPrefix: 'new' } };
        },
        emitResult: (ok, payload) => {
          events.push({ type: 'emitResult', ok, payload });
          if (emitThrows) {
            const err = new Error(`emitResult(${ok})`);
            err.exitCode = ok ? 0 : 1;
            throw err;
          }
        },
      };
    }
    if (id === './lib/apply-snapshot-store.js') {
      return {
        tombstoneSnapshot: (workspaceDir) => { events.push({ type: 'tombstoneSnapshot', workspaceDir }); return { ok: true }; },
        deleteSnapshot: (workspaceDir) => events.push({ type: 'deleteSnapshot', workspaceDir }),
      };
    }
    if (id === './vendor/cds-maker-sdk.cjs') {
      return {
        createMakerSdk: (cfg) => {
          events.push({ type: 'createMakerSdk', cfg });
          if (sdkThrows) throw sdkThrows;
          return {
            initWorkspace: () => events.push({ type: 'initWorkspace' }),
            resolveArtifact: async () => [],
          };
        },
      };
    }
    return require(id);
  };
  customRequire.main = invokeAsMain ? mod : {};
  const sandboxProcess = {
    argv: ['node', scriptPath],
    stderr: { write: (message) => stderr.push(message) },
    exit: (code) => {
      const err = new Error(`process.exit(${code})`);
      err.exitCode = code;
      throw err;
    },
  };
  vm.runInNewContext(source, {
    require: customRequire,
    module: mod,
    exports: mod.exports,
    process: sandboxProcess,
    Buffer,
    setImmediate,
  }, { filename: scriptPath });
  return { main: mod.exports.__mainForTest, events, stderr, sdkTemp, settle: () => new Promise((resolve) => setImmediate(resolve)) };
}

test('teardown CLI rejects usage errors before creating the destructive SDK client', async () => {
  const harness = loadTeardownCli({
    parseResult: { positional: [], flags: { env: 'https://org.example', spec: '@app-spec.json', workspace: true } },
  });

  await assert.rejects(harness.main(), (err) => err.exitCode === 1);
  assert.match(harness.stderr.join(''), /Usage: node scripts\/teardown-model-app\.js/);
  assert.ok(!harness.events.some((e) => e.type === 'createMakerSdk'), 'usage failures do not initialize the SDK');
});

test('teardown CLI applies, clears the local workspace only after a clean run, and cleans the SDK temp dir before emit', async () => {
  const workspaceDir = 'D:\\Projects\\power-platform-skills-sdk\\.test-workspace\\teardown-local';
  const harness = loadTeardownCli({
    parseResult: {
      positional: [],
      flags: {
        env: 'https://org.example',
        spec: '@D:\\Projects\\power-platform-skills-sdk\\plugins\\model-apps\\samples\\app-spec.support-desk.json',
        apply: true,
        'allow-destructive': true,
        'clear-workspace': true,
        workspace: workspaceDir,
      },
    },
  });

  await harness.main();
  const emitIndex = harness.events.findIndex((e) => e.type === 'emitResult');
  const sdkCleanupIndex = harness.events.findIndex((e) => e.type === 'rmSync' && e.dir === harness.sdkTemp);
  const workspaceCleanupIndex = harness.events.findIndex((e) => e.type === 'rmSync' && e.dir === workspaceDir);

  assert.ok(harness.events.some((e) => e.type === 'createMakerSdk' && e.cfg.workspacePath === harness.sdkTemp));
  assert.ok(harness.events.some((e) => e.type === 'runTeardown' && e.opts.apply === true));
  assert.ok(harness.events.some((e) => e.type === 'tombstoneSnapshot' && e.workspaceDir === workspaceDir));
  assert.ok(harness.events.some((e) => e.type === 'deleteSnapshot' && e.workspaceDir === workspaceDir));
  assert.ok(workspaceCleanupIndex > -1, '--clear-workspace removes the caller workspace only after clean apply');
  assert.ok(sdkCleanupIndex > -1 && sdkCleanupIndex < emitIndex, 'emitResult exits, so SDK cleanup must happen first');
  assert.match(harness.stderr.join(''), /cleared workspace/);
  assert.strictEqual(harness.events[emitIndex].ok, true);
});

test('teardown CLI dry-runs a positional spec with the default workspace and no destructive cleanup', async () => {
  const specPath = 'D:\\Projects\\power-platform-skills-sdk\\plugins\\model-apps\\samples\\app-spec.support-desk.json';
  const harness = loadTeardownCli({
    parseResult: { positional: [specPath], flags: { env: 'https://org.example' } },
    runResult: { ok: true, dryRun: true, plan: ['app module "Support Desk"'] },
  });

  await harness.main();
  const emitted = harness.events.find((e) => e.type === 'emitResult');

  assert.ok(harness.events.some((e) => e.type === 'runTeardown' && e.opts.apply === false));
  assert.ok(!harness.events.some((e) => e.type === 'tombstoneSnapshot'), 'dry-runs do not touch changed-only snapshots');
  assert.ok(!harness.events.some((e) => e.type === 'existsSync'), 'dry-runs never clear the caller workspace');
  assert.strictEqual(emitted.ok, true);
  assert.strictEqual(emitted.payload.dryRun, true);
});

test('teardown CLI emits an engine failure only after cleaning the SDK temp workspace', async () => {
  const harness = loadTeardownCli({
    parseResult: {
      positional: [],
      flags: {
        env: 'https://org.example',
        spec: '@D:\\Projects\\power-platform-skills-sdk\\plugins\\model-apps\\samples\\app-spec.support-desk.json',
        apply: true,
        'allow-destructive': true,
      },
    },
    runThrows: new Error('engine failed'),
    emitThrows: true,
  });

  await assert.rejects(harness.main(), (err) => err.exitCode === 1);
  const emitIndex = harness.events.findIndex((e) => e.type === 'emitResult');
  const sdkCleanupIndex = harness.events.findIndex((e) => e.type === 'rmSync' && e.dir === harness.sdkTemp);

  assert.ok(sdkCleanupIndex > -1 && sdkCleanupIndex < emitIndex);
  assert.strictEqual(harness.events[emitIndex].ok, false);
  assert.match(harness.events[emitIndex].payload.message, /engine failed/);
});

test('teardown CLI entrypoint reports SDK startup failures after removing the throwaway workspace', async () => {
  const harness = loadTeardownCli({
    parseResult: {
      positional: [],
      flags: {
        env: 'https://org.example',
        spec: '@D:\\Projects\\power-platform-skills-sdk\\plugins\\model-apps\\samples\\app-spec.support-desk.json',
      },
    },
    sdkThrows: new Error('SDK init failed'),
    invokeAsMain: true,
  });

  await harness.settle();
  const emitted = harness.events.find((e) => e.type === 'emitResult');

  assert.ok(harness.events.some((e) => e.type === 'rmSync' && e.dir === harness.sdkTemp));
  assert.strictEqual(emitted.ok, false);
  assert.match(emitted.payload.message, /SDK init failed/);
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
