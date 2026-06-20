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
  const sdk = createMakerSdk({
    workspacePath: fs.mkdtempSync(path.join(os.tmpdir(), 'model-app-')), // unused (no workspace ops)
    instanceUrl: env,
    httpClient,
    solutionUniqueName: spec.solution.uniqueName,
  });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const provisionSdk = createMakerSdk({ workspacePath: workspaceDir, instanceUrl: env, httpClient });
  provisionSdk.initWorkspace();
  return { sdk, provisionSdk };
}

// Turn engine progress events into the live [n/total] lines the orchestrator/CLI shows.
function cliEmit(log) {
  return (e) => {
    if (e.status === 'start') log(`[${e.n}/${e.total}] ${e.label}`);
    else if (e.status === 'skip') log(`[${e.n}/${e.total}] ${e.label}`);
    else if (e.status === 'error') log(`  ✗ ${e.label}: ${e.detail || ''}`);
  };
}

async function buildModelApp(spec, opts, deps) {
  const v = validateAppSpec(spec);
  if (!v.ok) {
    return { ok: false, errors: v.errors };
  }
  const log = deps.log || (() => undefined);
  const emit = deps.emit || cliEmit(log);
  return runSdkBuild(spec, {
    sdk: deps.sdk,
    provisionSdk: deps.provisionSdk,
    apply: opts.apply,
    sampleData: opts.sampleData,
    publish: opts.publish,
    phases: opts.phases,
    emit,
  });
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
    env,
  };
  // Construct for both dry-run and apply: proves the vendored bundle + adapter wire up
  // (offline), and apply needs it. A spec validation error short-circuits before any write.
  const { sdk, provisionSdk } = makeSdk(env, spec, workspaceDir);
  const deps = { log: (m) => process.stderr.write(m + '\n'), sdk, provisionSdk };
  const r = await buildModelApp(spec, opts, deps);
  emitResult(r.ok, r);
}

if (require.main === module) {
  main();
}
module.exports = { buildModelApp, planFor };
