#!/usr/bin/env node
// app-builder teardown: delete exactly the artifacts an App Spec declares, in
// dependency-safe order, via the SDK's delete methods — the first-class, classifier-safe
// counterpart to `build-model-app.js`. Auth is the caller's az token (same as the rest of
// the plugin). DRY-RUN BY DEFAULT — it lists what would be deleted and touches nothing; only
// `--apply` performs deletes. It removes ONLY artifacts whose identity is resolved from a
// name/logical/uniquename the given spec declares, so it can never wildcard-scan an org.
//
// Usage:
//   node teardown-model-app.js --env <orgUrl> --spec @<app-folder>/app-spec.json [--apply]
//        [--clear-workspace] [--workspace <dir>]
//
// Order: app -> dashboards -> commands -> forms -> charts -> views -> relationships ->
//   web-resources -> ai-summaries -> tables (reverse-topo) -> global-choices -> solution.
//   Forms/charts/views/relationships are deleted explicitly BEFORE tables (a table delete does
//   not reliably cascade cross-references). Command teardown removes the whole command bar for an
//   entity the spec authored commands on (the SDK models a command bar per entity, not per button).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateAppSpec, migrateAppSpec } = require('./lib/app-spec.js');
const { runTeardown } = require('./lib/sdk-teardown.js');
const { classifyOps } = require('./lib/op-diff.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const snapStore = require('./lib/apply-snapshot-store.js');

// Build an SDK client for teardown. Uses the same az-token HttpClient as build-model-app.js.
function makeSdk(env) {
  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  // Teardown uses a minimal SDK client (no workspace, no solution header) — just queryRecords
  // and delete methods. Use a throw-away temp dir since initWorkspace is mandatory.
  const sdkTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-'));
  const sdk = createMakerSdk({
    workspacePath: sdkTempDir,
    instanceUrl: env,
    httpClient,
  });
  sdk.initWorkspace();
  const cleanup = () => {
    fs.rmSync(sdkTempDir, { recursive: true, force: true });
  };
  return { sdk, cleanup };
}

// Turn engine progress events into a phase-grouped, status-marked teardown log — the same shape
// build-model-app.js uses: ▶ <phase>, then per step [n/total] with ✓ (deleted) / ⊘ (not found) /
// ✗ (failed). A dry-run lists the same plan with a ▢ marker. `opts.counts` accumulates totals.
function cliEmit(log, opts = {}) {
  const counts = opts.counts;
  let phase = null;
  return (e) => {
    if (e.phase !== phase) { phase = e.phase; log(`\n▶ ${phase}`); }
    if (e.status === 'start') return;
    if (!opts.apply) { log(`  [${e.n}/${e.total}] ▢ ${e.label}`); return; }
    if (counts) counts[e.status] = (counts[e.status] || 0) + 1;
    const glyph = e.status === 'ok' ? '✓' : e.status === 'skip' ? '⊘' : '✗';
    const tail = e.status === 'error' && e.detail ? ` — ${e.detail}` : '';
    log(`  [${e.n}/${e.total}] ${glyph} ${e.label}${tail}`);
  };
}

async function teardownModelApp(spec, opts, deps) {
  const v = validateAppSpec(spec, { profile: 'structural' });
  if (!v.ok) {
    return { ok: false, errors: v.errors };
  }
  const log = deps.log || (() => undefined);
  const counts = { ok: 0, skip: 0, error: 0 };
  const emit = deps.emit || cliEmit(log, { apply: opts.apply, counts });
  // Fail-closed: a teardown --apply DELETES real artifacts (app, tables, solution), so it now requires
  // explicit --allow-destructive — the same authorization the builder's destructive gate uses (design
  // §11). Dry-run is unaffected (it only prints the plan). The op set is the pure planTeardown, reused
  // via op-diff so the gate and the engine can never disagree about what will be deleted.
  if (opts.apply && opts.allowDestructive !== true) {
    const diff = classifyOps(spec, {}, { teardown: true });
    if (diff.hasDestructive) {
      const preview = diff.destructive.slice(0, 8).map((o) => `  • ${o.label}`);
      const more = diff.destructive.length > preview.length ? `\n  … and ${diff.destructive.length - preview.length} more` : '';
      log(`\n✗ refusing to delete ${diff.destructive.length} artifact(s) without --allow-destructive:\n${preview.join('\n')}${more}\nRe-run with --allow-destructive to authorize teardown.`);
      return { ok: false, errors: [`teardown of ${diff.destructive.length} artifact(s) requires --allow-destructive`, ...diff.destructive.slice(0, 8).map((o) => o.label)] };
    }
  }
  // TOMBSTONE the changed-only snapshot BEFORE any delete (design core invariant): eligible:false +
  // teardown-in-progress debt, so a partial/crashed teardown leaves the tombstone and a surviving artifact
  // can never be rebaselined as an eligible fast-path source. Best-effort — a lease contention is logged,
  // not fatal (once the app is deleted, the fast-path identity check also blocks any stale snapshot).
  if (opts.apply && opts.workspaceDir) {
    const tomb = snapStore.tombstoneSnapshot(opts.workspaceDir);
    if (!tomb.ok) log(`⚠ could not tombstone the changed-only snapshot before teardown (${tomb.reason}) — proceeding; the app-deletion identity check still blocks a stale snapshot`);
  }
  const r = await runTeardown(spec, { apply: opts.apply }, { sdk: deps.sdk, emit });
  // After a CLEAN teardown, DELETE the snapshot envelope — the app is gone, so a fresh rebuild must start a
  // new baseline. A teardown that finished WITH ERRORS leaves the tombstone in place (a surviving artifact
  // must not be rebaselined). Best-effort.
  if (opts.apply && opts.workspaceDir && r && r.ok && !r.dryRun) {
    snapStore.deleteSnapshot(opts.workspaceDir);
  }
  if (opts.apply && r && !r.dryRun) {
    log(`\n${r.ok ? '✓' : '✗'} teardown ${r.ok ? 'complete' : 'finished with errors'} — ${counts.ok} deleted, ${counts.skip} not found, ${counts.error} failed (${counts.ok + counts.skip + counts.error} steps)`);
  }
  return r;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const env = flags.env;
  const specArg = flags.spec || positional[0];
  if (!env || !specArg) {
    process.stderr.write(
      'Usage: node teardown-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--apply] [--allow-destructive] [--clear-workspace] [--workspace <dir>]\n'
    );
    process.exit(1);
  }
  const specPath = path.resolve(typeof specArg === 'string' && specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  const apply = flags.apply === true;
  const allowDestructive = flags['allow-destructive'] === true;
  const workspaceDir = flags.workspace || path.join(path.dirname(specPath), '.maker-workspace');
  const { sdk, cleanup } = makeSdk(env);
  let r;
  try {
    const deps = { log: (m) => process.stderr.write(m + '\n'), sdk };
    r = await teardownModelApp(spec, { apply, allowDestructive, workspaceDir }, deps);

    // Clear the local workspace only after a clean apply — stale metadata there would make a
    // subsequent rebuild skip tables that no longer exist. Filesystem-local, opt-in.
    if (apply && flags['clear-workspace'] && r && r.ok && !r.dryRun) {
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        process.stderr.write(`\ncleared workspace ${workspaceDir}\n`);
      }
    }
  } finally {
    cleanup();
  }
  // emitResult() calls process.exit(), so emit AFTER cleanup() has run.
  emitResult(r.ok, r);
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}
module.exports = { teardownModelApp, cliEmit };
