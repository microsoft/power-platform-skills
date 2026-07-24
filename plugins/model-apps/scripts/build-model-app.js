#!/usr/bin/env node
// app-builder builder: turn a validated App Spec into a model-driven app via the
// headless @maker-studio/cds-maker-sdk (vendored, self-contained — see scripts/vendor/).
// Auth is the caller's: an az-token HttpClient is injected into the SDK. Idempotent — new,
// existing, and mixed environments all work. Dry-run by default; --apply writes.
//
// Usage:
//   node build-model-app.js --env <orgUrl> --spec @<app-folder>/app-spec.json [--apply]
//        [--sample-data] [--publish] [--verify] [--stage <data|ui|app|publish>]
//        [--only <phases>] [--skip <phases>] [--from <phase>] [--to <phase>]
//        [--workspace <dir>]
//   phases: solution,data-model,sample-data,web-resources,views,charts,forms,commands,dashboards,app-shell,pages,ai-features,publish
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { validateAppSpec, migrateAppSpec } = require('./lib/app-spec.js');
const { runSdkBuild, planFor, appUniqueName, compileFormIntent } = require('./lib/sdk-build.js');
const { stagePhasesOrResolve } = require('./lib/stages.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { openJournal } = require('./lib/build-journal.js');
const { classifyOps, sitemapTargets } = require('./lib/op-diff.js');
// R3 (auto-verify): after a successful --apply the build can reconcile the spec against what actually
// deployed, so a silent partial build surfaces in the same run instead of only on a separate manual
// `verify-model-app.js` pass. Reuses the read-only reconcile core + the SDK reader (DRY — same code the
// standalone verifier runs). The sibling CLI is safe to require (it has a `require.main` guard).
const { verifySpec } = require('./lib/verify-spec.js');
const { readerFor } = require('./verify-model-app.js');

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
    solutionUniqueName: spec.solution && spec.solution.uniqueName,
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

// Pre-flight collision check: does an app (by deterministic unique name) or the solution already
// exist? A match is NOT an error — the build idempotently UPDATES it — but the user should know they
// are editing an existing app, not creating a fresh one. Best-effort (reads only). `provision` is
// the header-less SDK client. Returns { appExists, solutionExists, appUnique, solutionName }.
async function checkCollisions(spec, provision) {
  const odataLit = (v) => String(v == null ? '' : v).replace(/'/g, "''");
  const solutionName = spec.solution && spec.solution.uniqueName;
  const appUnique = appUniqueName(spec);
  const [sol, app] = await Promise.all([
    solutionName
      ? provision.queryRecords('solution', { select: ['solutionid'], filter: `uniquename eq '${odataLit(solutionName)}'`, top: 1 })
      : Promise.resolve([]),
    provision.queryRecords('appmodule', { select: ['appmoduleid'], filter: `uniquename eq '${odataLit(appUnique)}'`, top: 1 }),
  ]);
  return {
    appExists: !!(app && app[0] && app[0].appmoduleid),
    solutionExists: !!(sol && sol[0] && sol[0].solutionid),
    appUnique,
    solutionName,
  };
}

// Read-only discovery for the op-diff safety gate. Gathers ONLY what classifyOps needs — the collision
// result, deployed EXPLICIT-layout forms (an auto layout never prunes, so it can't be destructive), and
// the deployed app's sitemap targets — using read-only SDK calls (queryRecords via checkCollisions, then
// findArtifact/fetchArtifact + getArtifact). No writes. `provision` is the header-less SDK client.
// Returns the `discovered` shape classifyOps consumes.
async function discoverOpDiffState(spec, provision) {
  const collision = await checkCollisions(spec, provision);
  // Explicit-layout forms only. compileFormIntent needs no notesClassId here — that id only affects the
  // non-field notes cell, never the field-logical set formRemovals compares (artifact-intent.js).
  const forms = [];
  for (const f of spec.forms || []) {
    const def = compileFormIntent(spec, f, {});
    if (!def.__explicitLayout) continue;
    const id = await provision.findArtifact('form', { name: def.name, entity: def.entityLogicalName });
    if (!id) continue; // not deployed yet → nothing to prune
    await provision.fetchArtifact('form', id); // seed the workspace copy so getArtifact can read it
    forms.push({ label: `form "${f.name || f.entity}" (${String(f.entity).toLowerCase()})`, deployedForm: provision.getArtifact('form', id) || {}, def });
  }
  // Sitemap removals only make sense when the app already exists (a fresh app has no deployed sitemap).
  let sitemap = null;
  if (spec.appShell && collision.appExists) {
    const appId = await provision.findArtifact('app', { uniqueName: collision.appUnique });
    if (appId) {
      await provision.fetchArtifact('app', appId);
      const deployed = provision.getArtifact('app', appId) || {};
      sitemap = { deployedTargets: sitemapTargets(deployed.siteMap || {}), wantTargets: sitemapTargets(spec.appShell) };
    }
  }
  return { collision, forms, sitemap };
}

async function buildModelApp(spec, opts, deps) {
  const v = validateAppSpec(spec, { profile: opts.profile || 'deploy' });
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

  // Pre-flight safety gate (apply only). Recomputed here — immediately before the write loop — so it
  // reflects live state (TOCTOU). Best-effort discovery (reads only): if there is no provision client or
  // discovery is disabled, the gate is skipped. `deps.discoverOpDiffState` is an injection seam for tests.
  // The gate lives here, in the CLI wrapper, NOT inside runSdkBuild — the pure engine is unaffected.
  // See design §11 (fail-closed destructive gate) and §14.
  if (opts.apply && (deps.discoverOpDiffState || (deps.provisionSdk && opts.checkCollisions !== false))) {
    const nonInteractive = opts.nonInteractive === true;
    const allowDestructive = opts.allowDestructive === true;
    let state;
    try {
      state = deps.discoverOpDiffState
        ? await deps.discoverOpDiffState(spec, deps.provisionSdk)
        : await discoverOpDiffState(spec, deps.provisionSdk);
    } catch { state = null; } // discovery must never crash the build; a read failure = no gate
    if (state) {
      const col = state.collision || {};
      // (1) Collision gate. Unattended, an existing app is a HARD stop unless authorized — there is no
      //     human to see a warning and Ctrl-C (design §11). Interactively we preserve today's behavior:
      //     warn + proceed to UPDATE the existing app.
      if (col.appExists || col.solutionExists) {
        const which = [col.appExists ? `app '${col.appUnique}'` : null, col.solutionExists ? `solution '${col.solutionName}'` : null].filter(Boolean).join(' and ');
        if (col.appExists && nonInteractive && !allowDestructive) {
          const msg = `${which} already exist(s) and this is a non-interactive run — refusing to overwrite an existing app. Re-run with --allow-destructive to authorize, or use a different app name.`;
          log(`\n✗ ${msg}`);
          if (journal) journal.close({ status: 'halt', phase: 'preflight', label: which, detail: 'app-collision (non-interactive)', ...counts });
          return { ok: false, errors: [msg] };
        }
        log(`\n⚠ ${which} already exist(s) — this build will UPDATE the existing app (idempotent reuse), not create a fresh one. Use a different name for a new app.`);
        if (journal) journal.record({ phase: 'preflight', status: 'collision', label: which, detail: JSON.stringify({ appExists: col.appExists, solutionExists: col.solutionExists }) });
      }
      // (2) Fail-closed destructive-op gate. ANY content removal (explicit-layout form-field prune or a
      //     dropped sitemap target) requires --allow-destructive, interactive or not — the env var /
      //     --non-interactive suppress prompts only, they never grant destructive authority. The
      //     app-collision op is handled above (interactive/non-interactive nuance), so exclude it here.
      const diff = classifyOps(spec, state, { teardown: false });
      const removals = diff.destructive.filter((o) => o.kind === 'form-field-removal' || o.kind === 'sitemap-removal');
      if (removals.length && !allowDestructive) {
        const lines = removals.map((o) => `  • ${o.label} — ${o.detail}`);
        const msg = `refusing ${removals.length} destructive operation(s) without --allow-destructive:\n${lines.join('\n')}`;
        log(`\n✗ ${msg}`);
        if (journal) journal.close({ status: 'halt', phase: 'preflight', label: 'destructive-ops', detail: removals.map((o) => o.kind).join(','), ...counts });
        return { ok: false, errors: [msg] };
      }
    }
  }
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
        env: opts.env, // for the pages phase (pac model genpage upload --environment)
        genpageCli: deps.genpageCli, // injectable seam for tests; else constructed from env
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
    // R3 — auto-verify: reconcile the spec against what actually deployed so a silent partial build
    // (an artifact created but not wired, or a phase that quietly produced nothing) surfaces now
    // instead of only when the user opens the app. Read-only; injected (deps.verify) so tests drive it.
    // A verify failure does NOT undo the build (it already ran) — it is reported and returned in
    // r.verify so the CLI can exit non-zero. Never throws out of the build: a verify that can't run is
    // a warning, not a build failure.
    if (opts.verify && deps.verify) {
      try {
        const vr = await deps.verify(spec);
        const present = vr.checks.length - vr.missing.length;
        log(`\n${vr.ok ? '✓ verify PASS' : `✗ verify FAIL — ${vr.missing.length} missing`} (${present}/${vr.checks.length} present)`);
        if (!vr.ok) for (const m of vr.missing) log(`  ✗ ${m.kind}: ${m.name}`);
        r.verify = { ok: vr.ok, present, total: vr.checks.length, missing: vr.missing.map((m) => `${m.kind}:${m.name}`) };
        if (journal) journal.record({ phase: 'verify', status: vr.ok ? 'ok' : 'error', label: `verify ${present}/${vr.checks.length} present`, ...(vr.ok ? {} : { detail: r.verify.missing.join(', ') }) });
      } catch (e) {
        log(`\n⚠ verify step could not run (build itself succeeded): ${(e && e.message) || e}`);
      }
    }
    if (journal) journal.close({ status: 'complete', ...counts, appId: r.created && r.created.app, ...(r.verify ? { verify: r.verify.ok ? 'pass' : 'fail' } : {}) });
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

// Env var truthiness for the unattended opt-in: '1' or 'true' (case-insensitive) count as set; a
// missing/other value is false. Matches the dotnet-style boolean env convention used elsewhere in this
// repo (see AGENTS.md "Shared Telemetry"). This gates PROMPT SUPPRESSION ONLY — it never grants
// destructive authority (only --allow-destructive does).
function envTruthy(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true';
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
      'Usage: node build-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--apply] [--sample-data] [--publish] [--verify] [--stage <data|ui|app|publish>] [--only|--skip <phases>] [--from|--to <phase>] [--non-interactive] [--allow-destructive] [--workspace <dir>]\n'
    );
    process.exit(1);
  }
  const specPath = path.resolve(typeof specArg === 'string' && specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  const workspaceDir = flags.workspace || path.join(path.dirname(specPath), '.maker-workspace');
  const opts = {
    apply: flags.apply === true,
    sampleData: flags['sample-data'] === true,
    publish: flags.publish === true,
    verify: flags.verify === true,
    phases: stagePhasesOrResolve({ stage: flags.stage, only: list(flags.only), skip: list(flags.skip), from: flags.from, to: flags.to }),
    profile: (flags.apply === true && flags.stage !== 'data') ? 'deploy' : 'plan',
    allowDestructive: flags['allow-destructive'] === true,
    nonInteractive: flags['non-interactive'] === true || envTruthy(process.env.POWER_PLATFORM_SKILLS_NONINTERACTIVE),
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
  let r;
  try {
    // deps.verify (R3): the real reconcile, wired to the live provision SDK. Only invoked when
    // opts.verify AND the build applied successfully. Constructed here (not in buildModelApp) so the
    // core stays free of SDK-reader wiring and fully injectable for tests.
    const deps = {
      log: (m) => process.stderr.write(m + '\n'),
      sdk, provisionSdk, journal,
      verify: (s) => verifySpec(s, readerFor(provisionSdk, appUniqueName(s))),
    };
    r = await buildModelApp(spec, opts, deps);
  } finally {
    cleanup();
  }
  // emitResult() calls process.exit(), so emit AFTER cleanup() has run. A build that applied cleanly
  // but whose auto-verify found missing artifacts exits NON-ZERO (the silent-partial signal R3 exists
  // to raise), while r still carries the full build + verify detail.
  const ok = r.ok && (!r.verify || r.verify.ok);
  emitResult(ok, r);
}

if (require.main === module) {
  main().catch((err) => emitResult(false, err));
}
module.exports = { buildModelApp, planFor, isTransientHalt, checkCollisions, discoverOpDiffState, envTruthy };
