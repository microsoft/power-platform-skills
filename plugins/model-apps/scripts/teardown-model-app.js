#!/usr/bin/env node
// app-builder teardown: delete exactly the artifacts an App Spec declares, in
// dependency-safe order, via the SDK's delete methods — the first-class, classifier-safe
// counterpart to `build-model-app.js`. Auth is the caller's az token (same as the rest of
// the plugin). DRY-RUN BY DEFAULT — it lists what would be deleted and touches nothing; only
// `--apply` performs deletes. It removes ONLY artifacts whose identity is resolved from a
// name/logical/uniquename the given spec declares, so it can never wildcard-scan an org.
//
// Usage:
//   node scripts/teardown-model-app.js --env <orgUrl> --spec @<app-folder>/app-spec.json [--apply]
//        [--clear-workspace] [--workspace <dir>]  (--workspace names the build's workspace: teardown
//        fences its --changed-only snapshot there, and --clear-workspace removes it after a clean run)
//
// Order: app -> security roles -> dashboards -> command bars -> forms -> charts -> views
//   (then reset enriched default views) -> relationships -> AI row summaries -> tables
//   (reverse-topo) -> web resources (generated icon + page manifest + declared) ->
//   global choices -> solution. Forms/charts/views/relationships are deleted explicitly BEFORE
//   tables (a table delete does not reliably cascade cross-references). Command teardown removes
//   the whole command bar for an entity the spec authored commands on (the SDK models a command bar
//   per entity, not per button).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateAppSpec, migrateAppSpec } = require('./lib/app-spec.js');
const { runTeardown } = require('./lib/sdk-teardown.js');
const { classifyOps } = require('./lib/op-diff.js');
const { checkWorkspaceClearable } = require('./lib/workspace-paths.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { parseArgs, validateFlags, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const snapStore = require('./lib/apply-snapshot-store.js');

// Build an SDK client for teardown. Uses the same az-token HttpClient as build-model-app.js.
async function makeSdk(env) {
  const { createMakerSdk, createNodeWorkspaceStorage } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  // Teardown uses a minimal SDK client (no workspace, no solution header) — just queryRecords
  // and delete methods. Use a throw-away temp dir since initWorkspace is mandatory.
  const sdkTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teardown-'));
  try {
    const sdk = createMakerSdk({
      workspaceStorage: createNodeWorkspaceStorage(sdkTempDir),
      instanceUrl: env,
      httpClient,
    });
    await sdk.initWorkspace();
    const cleanup = () => {
      fs.rmSync(sdkTempDir, { recursive: true, force: true });
    };
    return { sdk, cleanup };
  } catch (err) {
    // If SDK initialization fails, no caller-owned cleanup function exists yet; remove the
    // throwaway workspace here so an auth/SDK startup error does not leak temp directories.
    try {
      fs.rmSync(sdkTempDir, { recursive: true, force: true });
    } catch {
      // Preserve the SDK/auth startup error as the actionable failure; a best-effort temp cleanup
      // problem would otherwise mask the reason teardown could not even initialize.
    }
    throw err;
  }
}

// Turn engine progress events into a phase-grouped, status-marked teardown log — the same shape
// build-model-app.js uses: ▶ <phase>, then per step [n/total] with ✓ (deleted) / ⊘ (not found, kept on
// purpose, or not attempted — the label says which) / ✗ (failed). A dry-run lists the same plan with a ▢
// marker. `opts.counts` accumulates totals, with skips also tallied by kind for the summary.
function cliEmit(log, opts = {}) {
  const counts = opts.counts;
  let phase = null;
  return (e) => {
    if (e.phase !== phase) { phase = e.phase; log(`\n▶ ${phase}`); }
    if (e.status === 'start') return;
    if (!opts.apply) { log(`  [${e.n}/${e.total}] ▢ ${e.label}`); return; }
    if (counts) {
      counts[e.status] = (counts[e.status] || 0) + 1;
      if (e.status === 'skip') counts[e.skip || 'not-found'] = (counts[e.skip || 'not-found'] || 0) + 1;
    }
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
  // teardown-in-progress debt + a rotated generation, so a partial/crashed teardown leaves the tombstone,
  // a surviving artifact can never be rebaselined as an eligible fast-path source, and a changed-only run
  // already in flight is fenced off (#587 item 1).
  //
  // The tombstone IS the fence, so failing to write it stops the teardown before it mutates (#587 item 2).
  // It used to warn and proceed — and if the app delete then failed after lower-level artifacts were
  // gone, the old ELIGIBLE snapshot survived describing a state that no longer existed. The usual cause
  // is a build holding the workspace lease right now; a stale lease is reclaimed automatically, so a
  // persistent failure means real contention or an unwritable workspace, and waiting is the fix.
  //
  // A workspace with NO snapshot gets a fresh tombstone too (a first changed-only build has none until it
  // finishes — see tombstoneSnapshot), creating the folder if it has to; `createdDir` is what to remove
  // again once the teardown is clean, so a folder that never had a workspace is left without one.
  let createdWorkspaceDir = null;
  let teardownId = null;
  let heartbeat = null;
  if (opts.apply && opts.workspaceDir) {
    const tomb = snapStore.tombstoneSnapshot(opts.workspaceDir);
    if (!tomb.ok) {
      const msg = `could not fence the changed-only snapshot before teardown (${tomb.reason}) — nothing was deleted. Let any running build of this app finish, then re-run the teardown.`;
      log(`\n✗ ${msg}`);
      return { ok: false, errors: [msg] };
    }
    createdWorkspaceDir = tomb.createdDir || null;
    teardownId = tomb.teardownId || null;
    // While it runs, the teardown keeps its entry fresh (apply-snapshot-store.js liveTeardowns): an entry
    // counts as running only while it keeps being seen, so one a killed teardown left behind stops counting
    // within minutes. unref'd, so it never keeps the process alive; cleared the moment the teardown ends.
    if (teardownId) {
      heartbeat = setInterval(() => snapStore.beatTeardown(opts.workspaceDir, teardownId), snapStore.TEARDOWN_BEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
    }
  }
  let r;
  try {
    r = await runTeardown(spec, { apply: opts.apply }, { sdk: deps.sdk, emit });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // Every teardown that FINISHES drops its entry from the tombstone's list of teardowns in flight — a
    // clean one, one that finished with errors, and one that threw. An entry left behind read as a
    // teardown still running whenever its pid was alive (reused, slow to exit, or this very process), and
    // a later clean teardown then kept the fence for up to a day.
    //
    // Only a CLEAN teardown may also delete the snapshot — the app is gone, so a fresh rebuild must start a
    // new baseline — and then only as the last one to finish: an overlapping teardown still deleting keeps
    // its fence (releaseTombstone). One that failed or threw keeps the tombstone (`keep`: a surviving
    // artifact must not be rebaselined), in a folder it created too, since that tombstone is what keeps it.
    if (teardownId) {
      const clean = !!(r && r.ok && !r.dryRun);
      const rel = snapStore.releaseTombstone(opts.workspaceDir, teardownId, clean ? {} : { keep: true });
      if (clean && rel.ok && !rel.left) {
        if (createdWorkspaceDir) snapStore.removeCreatedDir(opts.workspaceDir, createdWorkspaceDir);
      } else if (clean) {
        // On the result, so main() leaves the workspace alone: --clear-workspace would delete the fence.
        r.snapshotKept = rel.reason;
        log(`\n▸ the changed-only snapshot stays tombstoned: ${rel.reason}.${rel.left ? ' The last of them to finish removes it.' : ' A --changed-only build full-builds until a clean teardown removes it.'}`);
      } else if (!rel.ok) {
        log(`\n▸ could not drop this teardown from the changed-only fence (${rel.reason}); the snapshot stays tombstoned, and a later teardown may keep it until this process has exited.`);
      }
    }
  }
  if (opts.apply && r && !r.dryRun) {
    // A skip is one of three different facts, and the summary used to call all of them "not found" —
    // after an app-delete abort that read "0 deleted, 8 not found, 1 failed" for eight steps nobody
    // queried. `kept` (left in place on purpose: existing:true, system tables, …) and `not attempted`
    // are shown only when non-zero, so an ordinary run reads exactly as it always did.
    const notFound = counts['not-found'] || 0;
    const kept = counts.kept || 0;
    const notAttempted = counts['not-attempted'] || 0;
    const extra = `${kept ? `, ${kept} kept` : ''}${notAttempted ? `, ${notAttempted} not attempted` : ''}`;
    log(`\n${r.ok ? '✓' : '✗'} teardown ${r.ok ? 'complete' : 'finished with errors'} — ${counts.ok} deleted, ${notFound} not found, ${counts.error} failed${extra} (${counts.ok + counts.skip + counts.error} steps)`);
  }
  return r;
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const USAGE =
    'Usage: node scripts/teardown-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--apply] [--allow-destructive] [--clear-workspace] [--workspace <dir>]\n' +
    '  Note: --workspace names the build\'s workspace (default: .maker-workspace next to the spec). Teardown fences its --changed-only snapshot there before deleting anything, and --clear-workspace removes it after a clean run; the SDK itself uses a throwaway workspace.';
  // Strictness matters more here than anywhere else: this tool deletes. A mistyped
  // `--allow-destructiv` was previously dropped in silence, and the safety flag the operator
  // believed they had passed simply did not exist.
  const flagError = validateFlags(argv, {
    known: ['env', 'spec', 'apply', 'allow-destructive', 'clear-workspace', 'workspace'],
    needValue: ['env', 'spec', 'workspace'],
  });
  if (flagError) {
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  const env = flags.env;
  const specArg = flags.spec || positional[0];
  const workspaceArg = flags.workspace;
  if (!env || !specArg) {
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }
  const specPath = path.resolve(typeof specArg === 'string' && specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  const apply = flags.apply === true;
  const allowDestructive = flags['allow-destructive'] === true;
  const workspaceDir = workspaceArg || path.join(path.dirname(specPath), '.maker-workspace');
  const { sdk, cleanup } = await makeSdk(env);
  let r;
  let thrown = null;
  try {
    const deps = { log: (m) => process.stderr.write(m + '\n'), sdk };
    r = await teardownModelApp(spec, { apply, allowDestructive, workspaceDir }, deps);

    // Clear the local workspace only after a clean apply — stale metadata there would make a
    // subsequent rebuild skip tables that no longer exist. Filesystem-local, opt-in.
    if (apply && flags['clear-workspace'] && r && r.ok && !r.dryRun) {
      // VALIDATE BEFORE DELETING. `--workspace` is caller-supplied and this runs immediately
      // after a SUCCESSFUL teardown — the moment an operator is least expecting data loss — so an
      // unguarded `rmSync(dir, { recursive: true, force: true })` on a mistyped path, or on a
      // shell variable that expanded to a repo root, destroyed real work. Refusal is a WARNING,
      // not a failure: the teardown itself already succeeded, and the cost of refusing is only a
      // stale cache directory the operator can remove by hand.
      //
      // A workspace whose changed-only snapshot is still tombstoned — another teardown of it is running,
      // or the release failed — is left whole: deleting it deletes the fence that teardown depends on.
      const clearable = r.snapshotKept
        ? { ok: false, reason: `the workspace still holds the changed-only fence (${r.snapshotKept}); clear it once that is done` }
        : checkWorkspaceClearable(workspaceDir);
      //
      // The clear itself runs under the workspace's lease, and only while no snapshot has appeared since this
      // teardown's release — another teardown's tombstone, say, which removing the folder in place after the
      // release deleted (apply-snapshot-store.js clearWorkspace).
      const cleared = clearable.ok ? snapStore.clearWorkspace(clearable.target) : clearable;
      if (cleared.ok) {
        process.stderr.write(`\ncleared workspace ${clearable.target}${cleared.leftover ? ` (${cleared.reason})` : ''}\n`);
      } else {
        process.stderr.write(`\nskipped --clear-workspace: ${cleared.reason}\n`);
      }
    }
  } catch (err) {
    thrown = err;
  } finally {
    cleanup();
  }
  // emitResult() calls process.exit(), so emit AFTER cleanup() has run.
  if (thrown) {
    emitResult(false, thrown);
  }
  emitResult(r.ok, r);
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}
module.exports = { teardownModelApp, cliEmit };
