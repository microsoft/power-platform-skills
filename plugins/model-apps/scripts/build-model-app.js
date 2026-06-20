#!/usr/bin/env node
// model-app-maker builder: turn a validated App Spec into a model-driven app via the
// headless @maker-studio/cds-maker-sdk (vendored, self-contained — see scripts/vendor/).
// Auth is the caller's: an az-token HttpClient is injected into the SDK. Dry-run by
// default; --apply writes, --sample-data / --publish opt-in.
//
// Usage:
//   node build-model-app.js --env <orgUrl> --spec @app-spec.json [--apply] [--sample-data] [--publish]
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { validateAppSpec } = require('./lib/app-spec.js');
const { runSdkBuild, planFor } = require('./lib/sdk-build.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');

// Construct the SDK against the vendored bundle + an az-token HttpClient. Construction
// is offline (installs the xmldom shim, sets up a temp fs workspace) — no token is
// fetched until the first write — so it's safe even for a dry-run.
function makeSdk(env, spec) {
  const { createMakerSdk } = require('./vendor/cds-maker-sdk.cjs');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'model-app-'));
  return createMakerSdk({
    workspacePath: ws,
    instanceUrl: env,
    httpClient: createAzHttpClient(env),
    solutionUniqueName: spec.solution.uniqueName,
  });
}

// Turn engine progress events into the live [n/total] lines the orchestrator/CLI shows.
function cliEmit(log) {
  return (e) => {
    if (e.status === 'start') log(`[${e.n}/${e.total}] ${e.label}`);
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
    apply: opts.apply,
    sampleData: opts.sampleData,
    publish: opts.publish,
    emit,
  });
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const env = flags.env;
  const specArg = flags.spec || positional[0];
  if (!env || !specArg) {
    process.stderr.write(
      'Usage: node build-model-app.js --env <url> --spec @app-spec.json [--apply] [--sample-data] [--publish]\n'
    );
    process.exit(1);
  }
  const spec = readJsonArg(typeof specArg === 'string' && specArg.startsWith('@') ? specArg : '@' + specArg);
  const opts = {
    apply: flags.apply === true,
    sampleData: flags['sample-data'] === true,
    publish: flags.publish === true,
    env,
  };
  // Construct the SDK for both dry-run and apply: it proves the vendored bundle + adapter
  // wire up (offline), and apply needs it. A spec validation error short-circuits before
  // any write inside runSdkBuild.
  const deps = { log: (m) => process.stderr.write(m + '\n'), sdk: makeSdk(env, spec) };
  const r = await buildModelApp(spec, opts, deps);
  emitResult(r.ok, r);
}

if (require.main === module) {
  main();
}
module.exports = { buildModelApp, planFor };
