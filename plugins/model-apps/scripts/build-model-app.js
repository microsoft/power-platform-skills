#!/usr/bin/env node
// model-app-maker builder: turn a validated App Spec into a model-driven app via the
// headless @maker-studio/cds-maker-sdk (vendored, self-contained — see scripts/vendor/).
// Auth is the caller's: an az-token HttpClient is injected into the SDK. Idempotent — new,
// existing, and mixed environments all work. Dry-run by default; --apply writes.
//
// Usage:
//   node build-model-app.js --env <orgUrl> --spec @<app-folder>/app-spec.json [--apply]
//        [--sample-data] [--publish]
//        [--only <phases>] [--skip <phases>] [--from <phase>] [--to <phase>]
//        [--workspace <dir>]
//   phases: solution,data-model,sample-data,views,charts,forms,app-shell,publish
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { validateAppSpec } = require('./lib/app-spec.js');
const { runSdkBuild, planFor, resolvePhases } = require('./lib/sdk-build.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { openJournal } = require('./lib/build-journal.js');

// Construct the SDK against the vendored bundle + an az-token HttpClient. Two clients:
//   sdk          — carries solutionUniqueName (metadata + record writes auto-join the
//                  solution via the MSCRM.SolutionUniqueName header); does no workspace I/O.
//   provisionSdk — header-less; owns the PERSISTENT workspace. Every discovery read
//                  (findTables/findColumns/fetchEntityMetadata) and every artifact
//                  (views/charts/forms/app) lands here, so the app folder accumulates the
//                  metadata for reuse/edits. Construction is offline (no token until first call).
function makeSdk(env, spec, workspaceDir) {
  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const httpClient = createAzHttpClient(env);
  const sdkTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-app-'));
  const sdk = createMakerSdk({
    workspacePath: sdkTempDir, // unused (no workspace ops)
    instanceUrl: env,
    httpClient,
    solutionUniqueName: spec.solution.uniqueName,
  });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const provisionSdk = createMakerSdk({ workspacePath: workspaceDir, instanceUrl: env, httpClient });
  provisionSdk.initWorkspace();
  const cleanup = () => {
    fs.rmSync(sdkTempDir, { recursive: true, force: true });
  };
  return { sdk, provisionSdk, cleanup };
}

// Turn engine progress events into a phase-grouped, status-marked build log:
//   ▶ <phase>
//     [n/total] ✓ <label>        (created)
//     [n/total] ⊘ <label>        (skipped — already exists)
//     [n/total] ✗ <label> — err  (failed)
// In a dry-run (opts.apply false) the same grouping lists the plan with a ▢ marker. `opts.counts`
// (optional) accumulates ok/skip/error totals so the caller can print a closing summary.
function cliEmit(log, opts = {}) {
  const counts = opts.counts;
  let phase = null;
  return (e) => {
    if (e.phase !== phase) { phase = e.phase; log(`\n▶ ${phase}`); }
    if (e.status === 'start') return; // header only; the terminal event prints the status line
    if (!opts.apply) { log(`  [${e.n}/${e.total}] ▢ ${e.label}`); return; } // dry-run plan
    if (counts) counts[e.status] = (counts[e.status] || 0) + 1;
    const glyph = e.status === 'ok' ? '✓' : e.status === 'skip' ? '⊘' : '✗';
    const tail = e.status === 'error' ? ` — ${e.detail || ''}` : '';
    log(`  [${e.n}/${e.total}] ${glyph} ${e.label}${tail}`);
  };
}

async function buildModelApp(spec, opts, deps) {
  const v = validateAppSpec(spec);
  if (!v.ok) {
    return { ok: false, errors: v.errors };
  }
  const log = deps.log || (() => undefined);
  const counts = { ok: 0, skip: 0, error: 0 };
  const journal = deps.journal;
  // Tee the engine's progress events into the durable journal without touching the pure engine.
  const baseEmit = deps.emit || cliEmit(log, { apply: opts.apply, counts });
  const emit = journal ? (e) => { baseEmit(e); journal.record(e); } : baseEmit;
  const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  // Transient env errors (429 EntityCustomization lock, 503 SQL timeout, concurrent-op guards) are
  // retried automatically on --apply: the build is idempotent, so a retry reuses everything already
  // created. Non-transient halts (e.g. a bad spec / genuine 400) are NOT retried.
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : (opts.apply ? 3 : 0);
  let r;
  for (let attempt = 1; ; attempt++) {
    counts.ok = counts.skip = counts.error = 0; // summary reflects the final (successful) attempt
    try {
      r = await runSdkBuild(spec, {
        sdk: deps.sdk,
        provisionSdk: deps.provisionSdk,
        apply: opts.apply,
        sampleData: opts.sampleData,
        publish: opts.publish,
        phases: opts.phases,
        appDir: opts.appDir, // resolves web-resource `contentPath` relative to the app folder
        emit,
      });
      break;
    } catch (err) {
      if (attempt <= maxRetries && isTransientHalt(err)) {
        const delay = opts.retryDelayMs != null ? opts.retryDelayMs : backoffMs(attempt);
        if (journal) journal.record({ phase: err && err.phase, status: 'retry', label: `transient error (attempt ${attempt}/${maxRetries}) — retrying in ${delay}ms`, detail: String((err && err.message) || err) });
        log(`\n⟳ transient error in ${err && err.phase} — retrying (attempt ${attempt}/${maxRetries}) after ${delay}ms…`);
        await sleep(delay);
        continue;
      }
      // A non-transient (or retries-exhausted) halt — journal where/why it stopped, then propagate.
      // Resume by re-running the same command (idempotent) or with --from <phase>.
      if (journal) journal.close({ status: 'halt', phase: err && err.phase, code: err && err.code, recoverable: !!(err && err.recoverable), message: String((err && err.message) || err), ...counts });
      throw err;
    }
  }
  if (opts.apply && r && r.ok && !r.dryRun) {
    log(`\n✓ build complete — ${counts.ok} created, ${counts.skip} skipped, ${counts.error} failed (${counts.ok + counts.skip + counts.error} steps)`);
    if (journal) journal.close({ status: 'complete', ...counts, appId: r.created && r.created.app });
  } else if (journal) {
    journal.close({ status: r && r.dryRun ? 'dry-run' : 'done', ...counts });
  }
  return r;
}

// A halt is transient (safe to auto-retry, since the build is idempotent) when the underlying HTTP
// status is 429/503, or the message names a known transient server condition (customization lock,
// concurrent-op guard, SQL timeout, "try again later"). NOTE: the engine's `recoverable` flag means
// "re-runnable phase", NOT "transient error", so it is deliberately NOT used here.
function isTransientHalt(err) {
  if (!err) return false;
  const status = (err.cause && err.cause.statusCode) || err.statusCode;
  const msg = String((err.message || '') + ' ' + ((err.cause && err.cause.message) || ''));
  return (
    status === 429 ||
    status === 503 ||
    /CustomizationLockException|another solution (install|removal)|try again later|SQL timeout|concurrent [dD]elete/i.test(msg)
  );
}

// Exponential backoff with jitter: ~3s, 6s, 12s (capped at 30s).
function backoffMs(attempt) {
  return Math.min(30000, 3000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 1000);
}

function list(v) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const env = flags.env;
  const specArg = flags.spec || positional[0];
  if (!env || !specArg) {
    process.stderr.write(
      'Usage: node build-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--apply] [--sample-data] [--publish] [--only|--skip <phases>] [--from|--to <phase>] [--workspace <dir>]\n'
    );
    process.exit(1);
  }
  const specPath = path.resolve(typeof specArg === 'string' && specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = readJsonArg('@' + specPath);
  const workspaceDir = flags.workspace || path.join(path.dirname(specPath), '.maker-workspace');
  const opts = {
    apply: flags.apply === true,
    sampleData: flags['sample-data'] === true,
    publish: flags.publish === true,
    phases: resolvePhases({ only: list(flags.only), skip: list(flags.skip), from: flags.from, to: flags.to }),
    appDir: path.dirname(specPath),
    env,
  };
  // Construct for both dry-run and apply: proves the vendored bundle + adapter wire up
  // (offline), and apply needs it. A spec validation error short-circuits before any write.
  const { sdk, provisionSdk, cleanup } = makeSdk(env, spec, workspaceDir);
  // Durable build journal (apply runs only): a per-run record of steps + where a run halted,
  // written to <workspace>/build-log.jsonl. Resume = re-run the same command (idempotent).
  const journal = opts.apply
    ? openJournal(workspaceDir, { app: spec.app && spec.app.name, solution: spec.solution && spec.solution.uniqueName, apply: true, phases: opts.phases })
    : null;
  try {
    const deps = { log: (m) => process.stderr.write(m + '\n'), sdk, provisionSdk, journal };
    const r = await buildModelApp(spec, opts, deps);
    emitResult(r.ok, r);
  } finally {
    cleanup();
  }
}

if (require.main === module) {
  main();
}
module.exports = { buildModelApp, planFor, isTransientHalt };
