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
const { validateFlagsFromParsed } = require('./helpers/fake-auth.js');

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

// REVERSED by #587 item 5, deliberately. This test used to assert that teardown CONTINUES after a
// failed app delete ("later steps still run after the app refusal"), on a best-effort rationale:
// one failure should not strand the rest. Deep lifecycle testing showed that is the wrong rule for
// THIS step specifically — the app module is the dependency ROOT, and tables/forms/views/charts are
// its components. Continuing strips a LIVE app of everything it renders and leaves it broken in the
// environment, which is strictly worse than stopping and leaving a consistent app to retry against.
//
// Continue-on-error still applies to every step after the root is gone, and to the case where the
// app row WAS deleted and only a cascade cleanup step failed (see the `success:false` test below,
// which still expects later steps to run).
test('deleteAppCascade rejection is reported as a failed app step and dependent teardown STOPS', async () => {
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
  assert.ok(!sdk.calls.some((c) => c.method === 'deleteSolution'),
    'the app was not deleted, so nothing that depends on it may be torn down');
  assert.ok(!sdk.calls.some((c) => /^delete/.test(c.method) && c.method !== 'deleteAppCascade'),
    'no dependent delete of any kind may run');
  assert.ok(cap.logs.some((l) => /teardown finished with errors/.test(l)), 'the summary stays visibly non-clean');
});

// After an app-delete abort the summary read "0 deleted, 8 not found, 1 failed" — eight steps never even
// QUERIED, reported as a fact about the environment. Likewise a step left in place on purpose (an
// `existing: true` table, a system table) is not "not found". Each skip is counted as what it is, and the
// counts must agree with the per-step lines the operator just read.
test('the teardown summary counts not-found, kept and not-attempted steps apart', async () => {
  const tally = (logs) => {
    const steps = logs.filter((l) => /^\s+\[\d+\/\d+\] ⊘ /.test(l));
    return {
      notFound: steps.filter((l) => /\(not found\)$/.test(l)).length,
      notAttempted: steps.filter((l) => /\(not attempted — /.test(l)).length,
      kept: steps.filter((l) => !/\(not found\)$/.test(l) && !/\(not attempted — /.test(l)).length,
    };
  };
  const summaryOf = (logs) => logs.find((l) => /teardown (complete|finished with errors) — /.test(l)) || '';

  const aborted = presentSdk();
  aborted.deleteAppCascade = async () => { throw new Error('delete not confirmed'); };
  const a = logCapture();
  await teardownModelApp(desk, { apply: true, allowDestructive: true }, { sdk: aborted, log: a.log });
  const at = tally(a.logs);
  assert.ok(at.notAttempted > 0 && at.notFound === 0, JSON.stringify(at));
  assert.match(summaryOf(a.logs), new RegExp(`0 deleted, 0 not found, 1 failed, ${at.notAttempted} not attempted \\(`), summaryOf(a.logs));

  const retained = JSON.parse(JSON.stringify(desk));
  for (const e of retained.entities) e.existing = true;
  const k = logCapture();
  await teardownModelApp(retained, { apply: true, allowDestructive: true }, { sdk: presentSdk(), log: k.log });
  const kt = tally(k.logs);
  assert.ok(kt.kept >= retained.entities.length, JSON.stringify(kt));
  assert.match(summaryOf(k.logs), new RegExp(`, ${kt.notFound} not found, 0 failed, ${kt.kept} kept \\(`), summaryOf(k.logs));
  assert.doesNotMatch(summaryOf(k.logs), /not attempted/, 'nothing was abandoned, so the clause is omitted');
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
  // #587 item 8 — lets a test drive the destructive-cleanup guard both ways. `null` means the
  // guard accepts (the ordinary case); a string is the refusal reason.
  clearRefusedBecause = null,
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
    if (id === './lib/workspace-paths.js') {
      return {
        WORKSPACE_DIR_NAME: '.maker-workspace',
        checkWorkspaceClearable: (dir) => {
          events.push({ type: 'checkWorkspaceClearable', dir });
          return clearRefusedBecause
            ? { ok: false, reason: clearRefusedBecause }
            : { ok: true, target: dir };
        },
      };
    }
    if (id === './lib/sdk-http-client.js') {
      return { createAzHttpClient: (env) => ({ env }) };
    }
    if (id === './lib/dataverse-auth.js') {
      return {
        parseArgs: () => parseResult,
        validateFlags: validateFlagsFromParsed(() => parseResult.flags),
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
          // The CLI builds its store explicitly via the /node adapter now, so the mocked bundle
          // must expose it too. The marker carries the root so the assertions below can still
          // check WHERE the throwaway workspace was placed.
          createNodeWorkspaceStorage: (root) => ({ __mockWorkspaceRoot: root }),
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

  assert.ok(harness.events.some((e) => e.type === 'createMakerSdk' && e.cfg.workspaceStorage.__mockWorkspaceRoot === harness.sdkTemp));
  assert.ok(harness.events.some((e) => e.type === 'runTeardown' && e.opts.apply === true));
  assert.ok(harness.events.some((e) => e.type === 'tombstoneSnapshot' && e.workspaceDir === workspaceDir));
  assert.ok(harness.events.some((e) => e.type === 'deleteSnapshot' && e.workspaceDir === workspaceDir));
  assert.ok(workspaceCleanupIndex > -1, '--clear-workspace removes the caller workspace only after clean apply');
  assert.ok(sdkCleanupIndex > -1 && sdkCleanupIndex < emitIndex, 'emitResult exits, so SDK cleanup must happen first');
  assert.match(harness.stderr.join(''), /cleared workspace/);
  assert.strictEqual(harness.events[emitIndex].ok, true);
});

// #587 item 8 — the destructive half of the same flag. Cleanup runs right after a SUCCESSFUL
// teardown, so an unguarded recursive delete on a caller-supplied `--workspace` destroys data at
// the moment an operator is least expecting it. When the guard refuses, NOTHING may be removed —
// and the teardown must still report success, because the teardown itself did succeed and failing
// it would push the operator to re-run a destructive command.
test('teardown CLI does not delete a workspace the safety guard refuses', async () => {
  const workspaceDir = 'D:\\Projects\\power-platform-skills-sdk\\.test-workspace\\not-a-workspace';
  const harness = loadTeardownCli({
    clearRefusedBecause: "refusing to delete 'D:\\src': only a directory named '.maker-workspace' may be cleared",
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

  assert.ok(harness.events.some((e) => e.type === 'checkWorkspaceClearable' && e.dir === workspaceDir),
    'the guard must be consulted before any delete');
  assert.ok(!harness.events.some((e) => e.type === 'rmSync' && e.dir === workspaceDir),
    'a refused workspace must NOT be removed');
  const err = harness.stderr.join('');
  assert.match(err, /skipped --clear-workspace/, 'the refusal must be reported, not silent');
  assert.doesNotMatch(err, /cleared workspace/, 'and it must not claim to have cleared anything');
  const emitted = harness.events.find((e) => e.type === 'emitResult');
  assert.strictEqual(emitted.ok, true,
    'the teardown succeeded; refusing an unsafe cleanup must not turn it into a failure');
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

// #587 item 2: the tombstone is the fence, so a teardown that cannot write it must not mutate. It used
// to warn and carry on — and if the app delete then failed after lower-level artifacts were gone, the
// old ELIGIBLE snapshot survived describing a state that no longer existed.
test('teardown --apply refuses to delete anything when the snapshot cannot be fenced', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'td-snap-'));
  try {
    eligibleSnap(ws, 'app-1');
    // Another live, young build holds the workspace lease, so the tombstone cannot be written.
    const held = snapStore.acquireLease(ws, { now: () => Date.now(), pid: process.pid, processAlive: () => true, staleMs: snapStore.LEASE_STALE_MS });
    assert.ok(held.ok);
    const sdk = presentSdk();
    const { log, logs } = logCapture();
    const r = await teardownModelApp(desk, { apply: true, allowDestructive: true, workspaceDir: ws }, { sdk, log });
    snapStore.releaseLease(held);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some((e) => /fence|tombstone/.test(e)), JSON.stringify(r.errors));
    assert.deepStrictEqual(sdk.calls.filter((c) => /^delete/.test(c.method)), [], 'no delete may run before the fence is in place');
    assert.ok(logs.some((m) => /nothing was deleted/i.test(m)), logs.join('\n'));
    const disk = snapStore.readSnapshot(ws);
    assert.ok(disk && disk.eligible === true && !snap.isTombstoned(disk), 'the untouched snapshot still describes the untouched app');
  } finally { fs.rmSync(ws, { recursive: true, force: true }); }
});
