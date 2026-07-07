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
  const emit = deps.emit || cliEmit(log, { apply: opts.apply, counts });
  const r = await runSdkBuild(spec, {
    sdk: deps.sdk,
    provisionSdk: deps.provisionSdk,
    apply: opts.apply,
    sampleData: opts.sampleData,
    publish: opts.publish,
    phases: opts.phases,
    appDir: opts.appDir, // resolves web-resource `contentPath` relative to the app folder
    emit,
  });
  if (opts.apply && r && r.ok && !r.dryRun) {
    log(`\n✓ build complete — ${counts.ok} created, ${counts.skip} skipped, ${counts.error} failed (${counts.ok + counts.skip + counts.error} steps)`);
  }
  return r;
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
  try {
    const deps = { log: (m) => process.stderr.write(m + '\n'), sdk, provisionSdk };
    const r = await buildModelApp(spec, opts, deps);
    emitResult(r.ok, r);
  } finally {
    cleanup();
  }
}

if (require.main === module) {
  main();
}
module.exports = { buildModelApp, planFor };
