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
const { validateAppSpec, migrateAppSpec, normalizePageSource } = require('./lib/app-spec.js');
const { runSdkBuild, planFor, appUniqueName, compileFormIntent, resolveExistingFormId } = require('./lib/sdk-build.js');
const { stagePhasesOrResolve, PHASES, STAGES } = require('./lib/stages.js');
const { createAzHttpClient } = require('./lib/sdk-http-client.js');
const { parseArgs, readJsonArg, emitResult, dataverseRequest } = require('./lib/dataverse-auth.js');
const { openJournal } = require('./lib/build-journal.js');
const { diffPhases, summarizeDiff } = require('./lib/phase-diff.js');
const { annotateContentHashes } = require('./lib/content-hash.js');
const { runChangedOnlyApply, resolveLiveIdentity } = require('./lib/changed-only-flow.js');
const applySnapshotStore = require('./lib/apply-snapshot-store.js');
const { classifyOps, sitemapTargets } = require('./lib/op-diff.js');
// R3 (auto-verify): after a successful --apply the build can reconcile the spec against what actually
// deployed, so a silent partial build surfaces in the same run instead of only on a separate manual
// `verify-model-app.js` pass. Reuses the read-only reconcile core + the SDK reader (DRY — same code the
// standalone verifier runs). The sibling CLI is safe to require (it has a `require.main` guard).
const { verifySpec } = require('./lib/verify-spec.js');
const { readerFor } = require('./verify-model-app.js');
const { makeGenpageCli } = require('./lib/genpage-cli.js');

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
    // Resolve by (entity, name, TYPE) — NOT name alone. A table routinely has same-named Main / Quick View
    // / Card forms, so a name-only lookup matched multiple rows and the SDK's AmbiguousArtifactError halted
    // this preflight (fail-closed), blocking the edit. Type-scoped resolution targets the requested form.
    const id = await resolveExistingFormId(provision, def);
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
  // Surface non-blocking validation advisories (e.g. a PRE-EXISTING duplicate page name the build does
  // not create — see validateAppSpec). These no longer HALT the build; they are narrated so the maker
  // knows about the ambiguity but an unrelated edit still applies.
  for (const w of v.warnings || []) log(`⚠ ${w}`);
  const counts = { ok: 0, skip: 0, error: 0 };
  const journal = deps.journal;
  // Tee the engine's progress events into the durable journal without touching the pure engine.
  const baseEmit = deps.emit || cliEmit(log, { apply: opts.apply, counts });
  const emit = journal ? (e) => { baseEmit(e); journal.record(e); } : baseEmit;
  const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));

  // I1: on APPLY, the ONLY safe phase selections are the FULL build or EXACTLY the `data` stage
  // (solution+data-model+sample-data). Every other partial range (--from/--to/--only/--skip, or any other
  // --stage) is dry-run-only (design §14): its range is not dependency-closed and the app id is not carried
  // across runs, so applying it would run phases against an incomplete result map. Recovery from a halt is
  // a FULL rerun (idempotent), never --from pages.
  if (opts.apply) {
    const active = opts.phases || PHASES;
    const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    // I1 exception: a `--changed-only` pages-only FAST apply is the ONE sanctioned partial range. It is
    // pre-gated by the changed-only flow (snapshot eligibility + identity match + classify proved every
    // change is a pure page-content re-upload) and self-hydrates the app id via
    // opts.changedOnly.resolvedAppId (the sdk-build seam), so it does NOT hit the cross-phase-id hazard I1
    // guards against. Any other partial range on --apply is still refused.
    const isChangedOnlyPages = !!(opts.changedOnly && opts.changedOnly.fastApply) && sameSet(active, ['pages']);
    if (!isChangedOnlyPages && !sameSet(active, PHASES) && !sameSet(active, STAGES.data)) {
      const msg = `refusing to apply a partial phase range (${active.join(',')}) — on --apply only a FULL build or exactly --stage data is allowed (design §14). The app id is not carried across runs, so recover from a halt with a FULL rerun (idempotent), not --from/--to/--only/--skip.`;
      log(`\n✗ ${msg}`);
      if (journal) journal.close({ status: 'halt', phase: 'preflight', label: 'partial-apply-range', detail: active.join(',') });
      return { ok: false, errors: [msg] };
    }
  }

  // Pre-flight safety gate (apply only). Recomputed here — immediately before the write loop — so it
  // reflects live state (TOCTOU). Best-effort discovery (reads only): if there is no provision client or
  // discovery is disabled, the gate is skipped. `deps.discoverOpDiffState` is an injection seam for tests.
  // The gate lives here, in the CLI wrapper, NOT inside runSdkBuild — the pure engine is unaffected.
  // See design §11 (fail-closed destructive gate) and §14.
  //
  // #changed-only EXEMPTION: a pages-only fast apply is pre-gated by the changed-only flow (snapshot
  // eligibility + live identity match + classify proved every change is a pure page-content re-upload) and
  // touches NO data model, so the collision/destructive preflight does not apply. Running it would (a) HARD-
  // STOP the fast path in --non-interactive because the app always exists (Opus H3), and (b) do slow full
  // form/sitemap reads for nothing. The pages phase keeps its own removal/shared/membership safety gates.
  const isFastApply = !!(opts.changedOnly && opts.changedOnly.fastApply);
  if (opts.apply && !isFastApply && (deps.discoverOpDiffState || (deps.provisionSdk && opts.checkCollisions !== false))) {
    const nonInteractive = opts.nonInteractive === true;
    const allowDestructive = opts.allowDestructive === true;
    let state;
    let discoveryError = null;
    try {
      state = deps.discoverOpDiffState
        ? await deps.discoverOpDiffState(spec, deps.provisionSdk)
        : await discoverOpDiffState(spec, deps.provisionSdk);
    } catch (err) { discoveryError = err; }
    // Fail-closed: a discovery failure means we CANNOT verify the apply is non-destructive (a transient
    // 429/timeout/auth error mid-read leaves `state` unknown). Refuse to write — UNLESS the user already
    // authorized destruction with --allow-destructive, in which case the gate below would not block
    // anything anyway. Do NOT swallow-and-proceed: that silently disables the safety gate exactly when
    // the environment is unhealthy, letting an unattended-collision overwrite or a form/sitemap removal
    // slip through (design §11 — "can't verify safety ⇒ refuse", not "⇒ proceed"). Re-running usually
    // clears a transient read failure; --allow-destructive is the explicit escape hatch.
    if (discoveryError && !allowDestructive) {
      const msg = `preflight safety check could not run (discovery failed: ${(discoveryError && discoveryError.message) || discoveryError}) — refusing to write without verifying the apply is non-destructive. Re-run to retry, or pass --allow-destructive to proceed without the check.`;
      log(`\n✗ ${msg}`);
      if (journal) journal.close({ status: 'halt', phase: 'preflight', label: 'discovery-error', detail: String((discoveryError && discoveryError.message) || discoveryError), ...counts });
      return { ok: false, errors: [msg] };
    }
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
  // Injectable apply seam: production defaults to runSdkBuild; tests inject a stub to drive verify
  // without a live SDK.
  const runBuild = deps.runBuild || runSdkBuild;
  let r;
  for (let attempt = 1; ; attempt++) {
    counts.ok = counts.skip = counts.error = 0; // summary reflects the final (successful) attempt
    try {
      r = await runBuild(spec, {
        sdk: deps.sdk,
        provisionSdk: deps.provisionSdk,
        apply: opts.apply,
        sampleData: opts.sampleData,
        publish: opts.publish,
        phases: opts.phases,
        appDir: opts.appDir, // resolves web-resource `contentPath` relative to the app folder
        env: opts.env, // for the pages phase (pac model genpage upload --environment)
        genpageCli: deps.genpageCli, // injectable seam for tests; else constructed from env
        workspaceDir: opts.workspaceDir, // lease/staging live under the real workspace dir
        allowDestructive: opts.allowDestructive, // pages phase gates destructive page removals (Imp6)
        changedOnly: opts.changedOnly, // #changed-only: pages-only fast-apply seams (resolvedAppId + skipSitemapFinalize)
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
    // r.verify so the CLI can exit non-zero.
    //
    // MANDATORY + FAIL-CLOSED for page-bearing specs (design §13.1, C6):
    //   - Page verify runs even without --verify when the spec has implemented pages AND the pages
    //     phase was applied (appliedPagesPhase). A --stage data apply (pages NOT selected) must NOT
    //     trigger mandatory verify (RECONCILIATION 2).
    //   - A verify that CANNOT run (no verifier wired, or verifySpec throws) yields
    //     r.verify={ok:false,unableToRun:true} → non-zero exit. An unverifiable page set never passes
    //     silently — distinguish reader-incapacity (unableToRun) from ordinary miss (ok:false only).
    //   - A page-LESS spec keeps the opt-in (--verify) behavior: a verify that throws is a warning.
    const hasImplementedPages = (spec.pages || []).some((p) => { const s = normalizePageSource(p); return s && s.kind === 'tsx' && s.codeFile; });
    // Mandatory trigger: pages are implemented AND the pages phase was part of this apply.
    // A --stage data apply (STAGES.data) excludes the pages phase, so it must not trigger.
    const appliedPagesPhase = opts.apply && (opts.phases || PHASES).includes('pages');
    const mustVerifyPages = hasImplementedPages && appliedPagesPhase;
    if (opts.verify || mustVerifyPages) {
      if (!deps.verify) {
        if (mustVerifyPages) {
          // Fail-closed: page verify is required but no verifier is wired. Signal unableToRun so
          // the caller and the exit-code gate (`r.verify.ok===false`) surface a non-zero exit.
          log('\n✗ page verification is required but no verifier is wired — cannot confirm the deployed pages');
          r.verify = { ok: false, present: 0, total: 0, missing: ['verify-unrunnable:no verifier'], unableToRun: true };
          if (journal) journal.record({ phase: 'verify', status: 'error', label: 'verify could not run', detail: 'no verifier wired' });
        }
        // opts.verify without mustVerifyPages and no verifier → silently skip (no pages to enforce).
      } else {
        try {
          const vr = await deps.verify(spec);
          const present = vr.checks.length - vr.missing.length;
          log(`\n${vr.ok ? '✓ verify PASS' : `✗ verify FAIL — ${vr.missing.length} missing`} (${present}/${vr.checks.length} present)`);
          if (!vr.ok) for (const m of vr.missing) log(`  ✗ ${m.kind}: ${m.name}`);
          // Propagate unableToRun from verifySpec (RECONCILIATION 1): verifySpec itself sets
          // unableToRun when the reader lacks pages/pageCode methods. Only include the property
          // when truthy so existing callers using deepStrictEqual are not affected on the normal path.
          r.verify = { ok: vr.ok, present, total: vr.checks.length, missing: vr.missing.map((m) => `${m.kind}:${m.name}`), ...(vr.unableToRun ? { unableToRun: true } : {}) };
          if (journal) journal.record({ phase: 'verify', status: vr.ok ? 'ok' : 'error', label: `verify ${present}/${vr.checks.length} present`, ...(vr.ok ? {} : { detail: r.verify.missing.join(', ') }) });
        } catch (e) {
          if (mustVerifyPages) {
            // Fail-closed: enumeration/download failure is fatal for a page-bearing applied build.
            log(`\n✗ page verification could not run (build applied, but the deployed pages are unverifiable): ${(e && e.message) || e}`);
            r.verify = { ok: false, present: 0, total: 0, missing: [`verify-unrunnable:${(e && e.message) || e}`], unableToRun: true };
            if (journal) journal.record({ phase: 'verify', status: 'error', label: 'verify could not run', detail: String((e && e.message) || e) });
          } else {
            // opts.verify (opt-in), no pages → verify that throws is a warning, not a build failure.
            log(`\n⚠ verify step could not run (build itself succeeded): ${(e && e.message) || e}`);
          }
        }
      }
    }
    if (journal) journal.close({ status: 'complete', ...counts, appId: r.created && r.created.app, ...(r.verify ? { verify: r.verify.ok ? 'pass' : 'fail' } : {}) });
  } else if (journal) {
    journal.close({ status: r && r.dryRun ? 'dry-run' : 'done', ...counts });
  }
  // Attach non-blocking validation advisories to the result JSON so programmatic callers see them too
  // (they were already narrated via `log` above). Never overrides an error result's shape.
  if (r && typeof r === 'object' && (v.warnings || []).length) r.warnings = v.warnings;
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
      'Usage: node build-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--apply] [--sample-data] [--publish] [--verify] [--changed-only] [--stage <data|ui|app|publish>] [--only|--skip <phases>] [--from|--to <phase>] [--non-interactive] [--allow-destructive] [--workspace <dir>]\n'
    );
    process.exit(1);
  }
  // #changed-only (Preview): a SAFE partial apply. Incompatible with manual phase selection — the flow
  // computes its own phases (pages-only fast path, or a full fallback), so combining it with a
  // --stage/--only/--skip/--from/--to range is ambiguous and rejected up front.
  const changedOnly = flags['changed-only'] === true;
  if (changedOnly && (flags.stage || flags.only || flags.skip || flags.from || flags.to)) {
    process.stderr.write('✗ --changed-only cannot be combined with --stage/--only/--skip/--from/--to — it selects its own phases.\n');
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
    workspaceDir,
  };
  // Construct for both dry-run and apply: proves the vendored bundle + adapter wire up
  // (offline), and apply needs it. A spec validation error short-circuits before any write.
  const { sdk, provisionSdk, cleanup } = makeSdk(env, spec, workspaceDir);
  // Durable build journal (apply runs only): a per-run record of steps + where a run halted,
  // written to <workspace>/build-log.jsonl. Resume = re-run the same command (idempotent).
  const journal = opts.apply
    ? openJournal(workspaceDir, { app: spec.app && spec.app.name, solution: spec.solution && spec.solution.uniqueName, apply: true, phases: opts.phases })
    : null;
  // Surface the live-progress files so a long build is observable even if this process's stdout is
  // buffered by the launching shell (e.g. piping through Select-Object). `build-status.json` holds the
  // current step; `build-log.jsonl` is the full trace.
  if (journal && journal.statusPath) {
    process.stderr.write(`▸ live progress: read "${journal.statusPath}" for the current step (or tail "${journal.path}").\n`);
  }
  // #3 (track the diff): on a DRY-RUN, if a prior apply left a snapshot, report which phases changed
  // since — so a small edit is visibly "only pages changed", not a re-read of the whole plan. Advisory
  // only (it does not yet gate --apply; see docs/app-builder-roadmap.md). Never fatal.
  const lastAppliedPath = path.join(workspaceDir, 'last-applied.json');
  // #2 (content-aware diff): resolve a page codeFile / web-resource contentPath the SAME way the build
  // engine does — relative to the app folder (opts.appDir) — and return its bytes, or null when it can't
  // be read. Confined to appDir: a '..'-escaping or absolute path (already rejected at spec-validation
  // time) resolves outside and returns null rather than reading an arbitrary file. A null result makes
  // annotateContentHashes emit __contentSha:null, so an unreadable/vanished source reads as CHANGED
  // (fail-closed) instead of a silent no-op. Bytes are read raw (Buffer) so the hash matches regardless
  // of encoding; the diff only cares whether the bytes changed, not how they decode.
  const appDirAbs = path.resolve(opts.appDir || '.');
  const readContent = (relPath) => {
    try {
      const abs = path.resolve(appDirAbs, relPath);
      const rel = path.relative(appDirAbs, abs);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
      return fs.readFileSync(abs);
    } catch { return null; }
  };
  if (!opts.apply) {
    try {
      if (fs.existsSync(lastAppliedPath)) {
        const prior = JSON.parse(fs.readFileSync(lastAppliedPath, 'utf8'));
        // Annotate the CURRENT spec with on-disk content hashes so a .tsx / contentPath byte edit that
        // left the spec JSON identical is still reported changed. `prior` was persisted already annotated
        // (below). NOTE: a snapshot written by a pre-#2 build has no __contentSha, so the first dry-run
        // after upgrade may over-report pages/web-resources as changed — a one-time, fail-safe direction
        // (over-report), corrected on the next apply which re-persists WITH hashes.
        process.stderr.write(`\n▸ ${summarizeDiff(diffPhases(annotateContentHashes(spec, readContent), prior))}\n`);
      }
    } catch { /* advisory only — never block a dry-run */ }
  }
  let r;
  try {
    // deps.verify (R3): the real reconcile, wired to the live provision SDK. Only invoked when
    // opts.verify AND the build applied successfully. Constructed here (not in buildModelApp) so the
    // core stays free of SDK-reader wiring and fully injectable for tests.
    const deps = {
      log: (m) => process.stderr.write(m + '\n'),
      sdk, provisionSdk, journal,
      verify: (s) => verifySpec(s, readerFor(provisionSdk, appUniqueName(s), { genpageCli: makeGenpageCli(env), workspaceDir })),
    };
    if (changedOnly && opts.apply) {
      // #changed-only: the flow decides fast (pages-only via the sdk-build seams) vs full, gated on the
      // persisted snapshot's eligibility + a live identity check (WhoAmI orgId + app discovery). It calls
      // buildModelApp itself (injected) and manages the snapshot lifecycle (invalidate-before-write +
      // re-bless-on-success). readContent + WhoAmI are injected so the flow is testable offline.
      r = await runChangedOnlyApply({
        spec, opts,
        deps: {
          ...deps,
          buildModelApp,
          buildDeps: deps,
          readContent,
          resolveLiveIdentity: () => resolveLiveIdentity({
            sdk: provisionSdk,
            envUrl: env,
            appUniqueName: appUniqueName(spec),
            whoAmI: (u) => dataverseRequest(u, 'GET', 'WhoAmI'),
          }),
        },
      });
    } else {
      // Invariant: EVERY state-changing apply must invalidate the changed-only snapshot BEFORE it writes
      // (design core invariant). A plain `--apply` (or `--stage data --apply`) mutates the app outside the
      // changed-only flow, so a stale eligible snapshot would otherwise describe pre-apply state. Best-effort
      // + fail-safe: if a snapshot exists it is marked ineligible (the next `--changed-only` re-baselines via
      // a full build); no snapshot ⇒ a harmless no-op. Never blocks the build.
      if (opts.apply) {
        try { applySnapshotStore.invalidateSnapshot(workspaceDir); } catch { /* best-effort — never block a build */ }
      }
      r = await buildModelApp(spec, opts, deps);
    }
  } finally {
    cleanup();
  }
  // #3: after a clean apply, persist the applied spec so the NEXT dry-run can diff against it and show
  // what changed. Only on a real, successful, FULL apply, OR a changed-only fast apply (whose deployed
  // state matches the spec: unchanged artifacts persist idempotently and the changed pages were just
  // re-uploaded). A partial --stage data apply is NOT the whole desired state, so it must not overwrite
  // the snapshot. Gated on EFFECTIVE success (verify passed) — a build that applied but whose auto-verify
  // found a silent partial must NOT record its spec as the deployed baseline (Sol #13). Best-effort.
  const fullPhaseApply = (opts.phases || PHASES).length === PHASES.length;
  const changedOnlyApplied = !!(r && r.changedOnly && (r.changedOnly.decision === 'fast' || r.changedOnly.decision === 'full'));
  const effectiveSuccess = r.ok && (!r.verify || r.verify.ok);
  if (effectiveSuccess && opts.apply && !r.dryRun && (fullPhaseApply || changedOnlyApplied)) {
    // Persist the applied spec ANNOTATED with on-disk content hashes (#2) so the next dry-run's diff can
    // detect a .tsx / contentPath byte edit, not just a spec-JSON change. Records the content that was
    // actually deployed by THIS apply.
    try { fs.writeFileSync(lastAppliedPath, JSON.stringify(annotateContentHashes(spec, readContent))); } catch { /* non-fatal */ }
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
