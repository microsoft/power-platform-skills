#!/usr/bin/env node
// model-app-maker teardown: delete exactly the artifacts an App Spec declares, in
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
// Order: app -> dashboards -> commands -> web-resources -> tables (reverse-topo) -> solution.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateAppSpec } = require('./lib/app-spec.js');
const { runTeardown } = require('./lib/sdk-teardown.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');

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
    const tail = e.status === 'error' ? ` — ${e.detail || ''}` : '';
    log(`  [${e.n}/${e.total}] ${glyph} ${e.label}${tail}`);
  };
}

async function teardownModelApp(spec, opts, deps) {
  const v = validateAppSpec(spec);
  if (!v.ok) {
    return { ok: false, errors: v.errors };
  }
  const log = deps.log || (() => undefined);
  const counts = { ok: 0, skip: 0, error: 0 };
  const emit = deps.emit || cliEmit(log, { apply: opts.apply, counts });
  const r = await runTeardown(spec, { apply: opts.apply }, { sdk: deps.sdk, emit });
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
      'Usage: node teardown-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--apply] [--clear-workspace] [--workspace <dir>]\n'
    );
    process.exit(1);
  }
  const specPath = path.resolve(typeof specArg === 'string' && specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = readJsonArg('@' + specPath);
  const apply = flags.apply === true;
  const { sdk, cleanup } = makeSdk(env);
  try {
    const deps = { log: (m) => process.stderr.write(m + '\n'), sdk };
    const r = await teardownModelApp(spec, { apply }, deps);

    // Clear the local workspace only after a clean apply — stale metadata there would make a
    // subsequent rebuild skip tables that no longer exist. Filesystem-local, opt-in.
    if (apply && flags['clear-workspace'] && r && r.ok && !r.dryRun) {
      const workspaceDir = flags.workspace || path.join(path.dirname(specPath), '.maker-workspace');
      if (fs.existsSync(workspaceDir)) {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
        process.stderr.write(`\ncleared workspace ${workspaceDir}\n`);
      }
    }
    emitResult(r.ok, r);
  } finally {
    cleanup();
  }
}

if (require.main === module) {
  main();
}
module.exports = { teardownModelApp, cliEmit };
