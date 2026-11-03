#!/usr/bin/env node
// app-builder builder: turn a validated App Spec into a model-driven app via the
// headless @maker-studio/cds-maker-sdk (vendored, self-contained — see scripts/vendor/).
// Auth is the caller's: an az-token HttpClient is injected into the SDK. Idempotent — new,
// existing, and mixed environments all work. Dry-run by default; --apply writes.
//
// Usage:
//   node build-model-app.js --env <orgUrl> --spec @<app-folder>/app-spec.json [--apply]
//        [--sample-data] [--publish] [--verify] [--no-live-plan] [--stage <data|ui|app|publish>]
//        [--only <phases>] [--skip <phases>] [--from <phase>] [--to <phase>]
//        [--workspace <dir>]
//   phases: solution,data-model,sample-data,web-resources,views,charts,forms,commands,dashboards,app-shell,pages,ai-features,security,publish
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sha256 } = require('./lib/hash.js');
const { validateAppSpec, migrateAppSpec, normalizePageSource, normalizeLanguageCode, specDeclaresAttribute } = require('./lib/app-spec.js');
const { runSdkBuild, openBuildBindingGroups, planFor, appUniqueName, compileFormIntent, resolveExistingFormId, normalizeFormId, settleOwedPublishes, collectOwedPublishes, settleOwedLengths } = require('./lib/sdk-build.js');
const { authorizeFlag } = require('./lib/cli-failure.js');
const { specTables } = require('./lib/table-publish.js');
const { stagePhasesOrResolve, PHASES, STAGES } = require('./lib/stages.js');
// #455: resolves the authoring LCID over the transport hatch, BEFORE constructing the SDK that
// bakes it into the App/Form/Dashboard adapters.
const { resolveAuthoringLanguage, BuildHalt } = require('./lib/entity-provision.js');
const { createAzHttpClient, SQL_DEADLOCK_VICTIM } = require('./lib/sdk-http-client.js');
const { createPublicationBarrier, describeWithheld } = require('./lib/publication-barrier.js');
const { RETRY, judgeFailure, retryPolicyFor, throttleAskOf } = require('./lib/retry-policy.js');
const { makeThrottleBudget, waitDoesNotFit } = require('./lib/throttle-budget.js');
const { workspaceBindingError, workspaceBindingNote } = require('./lib/workspace-binding.js');
const { parseArgs, validateFlags, readAliasedFlag, readJsonArg, emitResult, dataverseRequest, readProvisionedLanguages, preflightAuth, dataverseOrigin } = require('./lib/dataverse-auth.js');
const { openJournal } = require('./lib/build-journal.js');
const { assertSafeOutputDir, assertPlainFileTarget, writeFileSafe } = require('./lib/safe-fs.js');
const { diffPhases, summarizeDiff } = require('./lib/phase-diff.js');
const { annotateContentHashes, appSourceFileErrors } = require('./lib/content-hash.js');
const { baselinePath, confinedReader, writeBaseline, readBaseline } = require('./lib/deployed-baseline.js');
const { runChangedOnlyApply, resolveLiveIdentity } = require('./lib/changed-only-flow.js');
const applySnapshotStore = require('./lib/apply-snapshot-store.js');
const { classifyOps, sitemapTargets } = require('./lib/op-diff.js');
const { navigationHolds } = require('./lib/app-navigation.js');
// Unattended-mode detection lives in one module so /app-builder and /genpage cannot drift apart
// on what "unattended" means. Re-exported from here because callers and tests already import it
// from this file.
const { envTruthy } = require('./lib/interaction-mode.js');
// Auto-verify: after a successful --apply the build can reconcile the spec against what actually
// deployed, so a silent partial build surfaces in the same run instead of only on a separate manual
// `verify-model-app.js` pass. Reuses the read-only reconcile core + the SDK reader (DRY — same code the
// standalone verifier runs). The sibling CLI is safe to require (it has a `require.main` guard).
const { verifySpec } = require('./lib/verify-spec.js');
const { isTranslationExport } = require('./lib/translation-labels.js');
const { readerFor, isolatedReaderFor } = require('./verify-model-app.js');
const { makeGenpageSdk } = require('./lib/genpage-sdk.js');
const { leftOnDiskWarning } = require('./lib/left-on-disk.js');
const { makeTempWorkspace } = require('./lib/temp-workspace.js');
const { createPassthroughCreates } = require('./lib/creates-passthrough.js');
// The configuration kinds (lib/configuration-artifacts.js): the --authorize tokens they claim, the --deployment-settings bindings, the
// send-once scope of their writes (lib/configuration-transport.js), and the connection inventory a reference's binding is proven
// against, read as list-connections.js reads it (the SDK first, pac when the SDK's route is refused).
const { configurationAuthorizationKeys, readDeploymentBindings, usesConfiguration } = require('./lib/configuration-artifacts.js');
const { configurationSendOnce } = require('./lib/configuration-transport.js');
const { sdkFirst, connectivity } = require('./lib/sdk-first.js');
const { connectionRowFromSdk, listConnectionsWithPac } = require('./list-connections.js');
const { isDeclaredView, compileViewIntent } = require('./lib/view-reconcile.js');
const { approvalKey } = require('./lib/reconcile-common.js');
const { isDeclaredChart, compileChartIntent } = require('./lib/chart-reconcile.js');
const { isDeclaredForm, formLayoutKey } = require('./lib/form-layout-reconcile.js');
const { isDeclaredDashboard, dashboardKey } = require('./lib/dashboard-reconcile.js');
const { declaredFeatureOn } = require('./lib/declared-features.js');
const { isDeclaredWebResource } = require('./lib/web-resource-reconcile.js');
const { makeWritesBlocking } = require('./lib/output-redaction.js');
// The lease one apply of an app holds for the whole of its work in the workspace (lib/app-operation-lease.js).
const { withAppBuildLease, applyWorkspaceOf } = require('./lib/app-operation-lease.js');
const { publicationRiskApproval } = require('./lib/managed-bindings.js');
const { readVerifyManifest } = require('./lib/declared-form-io.js');
const { createAttemptSendObserver } = require('./lib/managed-feature-contract.js');
const { emitSkillCompleted, createStepTally } = require('./lib/telemetry/skill-completed.js');

// The folder an app's workspace lives in, checked before anything is built on it. An APPLY makes the folder if it is
// missing and re-checks it (mkdir on an existing junction succeeds, so the re-check is what refuses one). A DRY RUN
// only ever reads from it, so a folder that is not there — or cannot be inspected — is just one with no workspace; a
// link or a file in its place is refused either way, as everywhere the plugin takes a workspace.
function assertWorkspaceDir(workspaceDir, { create }) {
  try {
    assertSafeOutputDir(workspaceDir, { create });
  } catch (err) {
    if (create || !(err && err.reason === 'uninspectable')) throw err;
  }
}

// Construct the SDK against the vendored bundle + an az-token HttpClient. Two clients:
//   sdk          — carries solutionUniqueName (metadata + record writes auto-join the
//                  solution via the MSCRM.SolutionUniqueName header). Its workspace is a throwaway, prepared
//                  only for a spec with configuration items: they are the one thing written through it as
//                  an artifact (see below); for every other spec it does no workspace I/O.
//   provisionSdk — header-less; owns a workspace. In an APPLY (`persistent`) that is the app
//                  folder's PERSISTENT one: every discovery read (findTables/findColumns/
//                  fetchEntityMetadata) and every artifact (views/charts/forms/app) lands there, so
//                  the app folder accumulates the metadata for reuse/edits — and opening it binds it
//                  to the environment of this run (lib/workspace-binding.js). In a DRY RUN it is a
//                  throwaway inside the SDK's own temp dir: a preview builds nothing, so it must not
//                  bind a folder to an environment it only previewed (the next --apply, against the
//                  environment the operator meant, would be refused), and every read its live plan
//                  makes goes to the server anyway. The persistent folder is only ASKED, read-only,
//                  which environment it belongs to, and the answer comes back as `folderNote` so the
//                  preview can warn that an --apply would stop. Construction is offline (no token
//                  until first call).
async function makeSdk(env, spec, workspaceDir, languageCode, { persistent = true, throttle, previewPush = false, publicationBarrier, sendObserver, workflowEffectGate } = {}) {
  // A link at the workspace root would make the provision SDK's storage follow it. Refuse
  // before either constructor: the first SDK does not use this directory, but once the
  // directory has been refused the factory must not run at all.
  assertWorkspaceDir(workspaceDir, { create: persistent });
  const { createMakerSdk, createNodeWorkspaceStorage } = require('./lib/maker-sdk.js');
  // The one client of both SDK instances and of verify's isolated reader draws its waits for a throttled answer from the run's budget (`throttle`, made by main()).
  // The build's own `--verify` reads a form's captions in a language the form read does not carry from a translation export (verify-model-app.js readerFor), through this client:
  // that request is sent once whatever answers it (isTranslationExport), as in the standalone verify — a long action, which a re-send would run a second time.
  // The publication barrier checks every publish request when it is dispatched (publicationBarrier.gateRequest). The send observer of managed
  // attempts (managed-feature-contract.js createAttemptSendObserver) sits INSIDE the gate, so a request the barrier answers itself is never counted
  // as sent; with no attempt's window open it passes every request untouched.
  // A configuration write (lib/configuration-transport.js) is sent once too: a re-sent create can make a second row, and a re-sent PATCH or
  // DELETE can hide that the first send's outcome was never seen. Outside that scope the predicate answers false, so nothing else changes.
  // A declared business rule's or process flow's workflow write is screened by the gate of the store that holds its effect
  // (lib/deferred-workflow-gate.js): main() makes the gate only when one of those features is on, and the build binds it to its
  // store; with no gate the client is made exactly as before.
  const httpClient = createAzHttpClient(env, { throttle, sendOnce: (method, url) => isTranslationExport(method, url) || configurationSendOnce(method, url), ...(publicationBarrier ? { request: publicationBarrier.gateRequest(sendObserver ? sendObserver.wrap() : undefined) } : {}), ...(workflowEffectGate ? { workflowEffectGate } : {}) });
  const sdkTempDir = makeTempWorkspace('model-app-');
  const cleanup = () => {
    fs.rmSync(sdkTempDir, { recursive: true, force: true });
  };
  // Inside the temp dir that `cleanup` removes, so a preview has nothing more to strand.
  const provisionDir = persistent ? workspaceDir : path.join(sdkTempDir, 'preview-workspace');
  // Everything fallible after the directory exists runs INSIDE this guard, because the caller's
  // `finally { cleanup() }` only becomes reachable once this function RETURNS — so anything that
  // throws before the return strands the throwaway workspace for the life of the machine.
  //
  // That deliberately includes the `createMakerSdk` CONSTRUCTORS, not just `initWorkspace`: the
  // constructor now builds the injected-storage adapter (`createNodeWorkspaceStorage`), so it
  // touches the filesystem and can fail on its own. Guarding only the init left both constructions
  // outside the net. Matches provision-solution.js and ai-preflight.js, which already keep
  // construction inside their protected region for this exact reason.
  //
  // `workspaceDir` is deliberately NOT removed — it is the caller's durable workspace, not a
  // throwaway, so a failed run must leave it exactly as it found it.
  let sdk;
  let provisionSdk;
  let folderNote = null;
  try {
    sdk = createMakerSdk({
      // A throwaway workspace: only the configuration items work in it (prepared below), and each of them re-reads the server's copy.
      workspaceStorage: createNodeWorkspaceStorage(sdkTempDir),
      instanceUrl: env,
      httpClient,
      solutionUniqueName: spec.solution && spec.solution.uniqueName,
      // #455: the App, Form and Dashboard adapters bake this in at construction, so it is the ONLY
      // way to stop sitemap titles and FormXML labels being written at a hardcoded 1033. Omitted
      // (undefined) means the SDK's own DEFAULT_LCID, which preserves the previous behaviour exactly.
      ...(languageCode ? { languageCode } : {}),
    });
    provisionSdk = createMakerSdk({
      workspaceStorage: createNodeWorkspaceStorage(provisionDir),
      instanceUrl: env,
      httpClient,
      // Must match the `sdk` instance above: `pushArtifact` refuses a push whose stored artifact
      // language disagrees with the SDK performing it (for language-sensitive registrations), so two
      // instances at different LCIDs would make every push of a fetched artifact fail.
      ...(languageCode ? { languageCode } : {}),
      // A form create whose answer was lost converges instead of halting. The HTTP client re-sends a POST that
      // got no answer; when the first attempt had committed, the SDK sees the re-send's 412 for the id it minted
      // and, without this, reports ARTIFACT_ALREADY_EXISTS — a halt a re-run repeats until the workspace is
      // reset by hand (requireSuccessfulPush). With it the SDK reads that row and adopts it ONLY when it is
      // exactly what was sent, writing nothing (a Main form only; anything else is refused with the reason,
      // and the halt is as before). It is on THIS instance because it pushes every form. This instance is
      // header-less, so no solution membership is demanded of the row — a form joins its solution after its
      // push. An adoption reports `saved: false`; pushFailed knows that is not a failure.
      createRecovery: 'adoptExact',
      // app.theme (Preview) runs on THIS instance (lib/sdk-build.js ensureThemeApplied): its reads go through the strict
      // theme read policy only when the spec declares a theme, so a spec without one makes exactly the requests it made before.
      ...(spec.app && spec.app.theme !== undefined ? { themeReads: true } : {}),
    });
    if (!persistent) fs.mkdirSync(provisionDir);
    try {
      await provisionSdk.initWorkspace();
    } catch (err) {
      // `initWorkspace` is where the SDK refuses a workspace that belongs to another environment, before it
      // reads or writes anything, and where it reads a manifest the JSON parser may reject. That is an
      // operator's problem to solve, not a crash: say which environments are involved and what the safe ways
      // forward are (lib/workspace-binding.js). Only an apply can meet it: a preview's workspace is brand new.
      throw workspaceBindingError(err, { env, workspaceDir }) || err;
    }
    // The configuration items (environment variables, connection references, Custom APIs, duplicate-detection rules) are written through
    // `sdk`, because their creates must join the solution, and the SDK writes each one as an artifact: it creates it in the workspace, pushes
    // it, and reads the server's copy back with `fetchArtifact(…, { overwrite: true })`. Every one of those refuses a workspace that was never
    // prepared (WORKSPACE_NOT_INITIALIZED), so without this a spec that declared one halted at the data model, every time.
    // Prepared only for a spec that uses them (lib/configuration-artifacts.js usesConfiguration, the test the engine makes before building
    // their runtime), so every other spec keeps the client it had. Preparing sends no request: it reads and writes this throwaway folder only
    // (manifest.json and the kind folders), which is removed with the rest of the run's temporary files.
    if (usesConfiguration(spec)) await sdk.initWorkspace();
    if (!persistent) {
      // The preview did not open the app folder's workspace, so it cannot be refused by it — but an --apply
      // would be, and the operator is better told now than after the plan has been read and approved.
      try {
        const probe = createMakerSdk({ workspaceStorage: createNodeWorkspaceStorage(workspaceDir), instanceUrl: env, httpClient });
        folderNote = await workspaceBindingNote(probe, { env, workspaceDir });
      } catch { /* advisory only: nothing here may stop a preview */ }
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  // Only the two SDK instances, the cleanup and verify's isolated dashboard reader are returned (and, for a
  // preview, the note it owes about the app folder). The raw `httpClient` used to come back with them so the
  // caller could wire verify's role-privilege reader — that read had no SDK surface and had to compose an
  // absolute `EntityDefinitions(...)?$select=Privileges` request itself. The vendored bundle now exposes
  // `getEntityPrivileges`, so the reader takes the SDK and the raw client has no caller. Returning it anyway
  // would advertise a bypass this file no longer takes.
  //
  // The isolated reader is built HERE so it shares this client, and with it the Azure CLI token: made by the
  // caller, it created a client of its own, and a second `az account get-access-token`, for every build's
  // dashboard verify. Each read still gets its own throwaway workspace and SDK (verify-model-app.js).
  const isolatedReader = isolatedReaderFor(env, { httpClient });
  // `--preview-push` hands the SDK's push preview a client to read with (lib/push-preview.js), and only then. It
  // is the same client wrapped read-only, so it can be given out without the bypass above: a write through it is
  // refused before it is sent. Undefined otherwise, so a run without the flag gets nothing it did not get before.
  const previewHttpClient = previewPush ? require('./lib/readonly-operations.js').readOnlyHttpClient(httpClient).client : undefined;
  return { sdk, provisionSdk, cleanup, isolatedReader, folderNote, previewHttpClient };
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
    if (!opts.apply) {
      // #559: the dry run now resolves each item against the live environment, so say which way it
      // will go. A glyph alone cannot carry three states, and an unresolved one must not look like
      // either decision — so name it.
      if (e.status === 'warn') { log(`  ⚠ ${e.label}`); return; }
      const mark = e.state === 'create' ? '+ create' : e.state === 'reuse' ? '= reuse ' : e.state === 'unknown' ? '? unknown' : '▢';
      const why = e.state === 'unknown' && e.stateWhy ? ` — ${e.stateWhy}` : '';
      log(`  [${e.n}/${e.total}] ${mark} ${e.label}${why}`);
      return;
    }
    if (counts) {
      // A step taken up again later in its phase keeps its number and names the outcome it replaces (`replaces`: a status reason its table's
      // lag deferred, then retried — makeRunner, entity-provision.js), so the summary counts each step once, by the outcome it ended with.
      if (e.replaces && counts[e.replaces] > 0) counts[e.replaces] -= 1;
      counts[e.status] = (counts[e.status] || 0) + 1;
    }
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
    // A declared form never reaches this gate: its build keeps a control it does not declare and never deletes one
    // (lib/form-layout-reconcile.js), and validation refuses `prune` on it, so a field found only on the deployed
    // form is not a removal and must not be refused as one.
    if (declaredFeatureOn('forms') && isDeclaredForm(f)) continue;
    const def = compileFormIntent(spec, f, {});
    if (!def.__explicitLayout || def.__prune === false) continue;
    // Resolve by (entity, name, TYPE) — NOT name alone. A table routinely has same-named Main / Quick View
    // / Card forms, so a name-only lookup matched multiple rows and the SDK's AmbiguousArtifactError halted
    // this preflight (fail-closed), blocking the edit. Type-scoped resolution targets the requested form.
    const id = await resolveExistingFormId(provision, def);
    if (!id) continue; // not deployed yet → nothing to prune
    await provision.fetchArtifact('form', id); // seed the workspace copy so getArtifact can read it
    forms.push({ formId: id, label: `form "${f.name || f.entity}" (${String(f.entity).toLowerCase()})`, deployedForm: await provision.getArtifact('form', id) || {}, def });
  }
  // Sitemap removals only make sense when the app already exists (a fresh app has no deployed sitemap) and the build will write a navigation. A spec
  // whose appShell has no `areas` array is refused by the navigation check before anything is written (lib/app-navigation.js: `appDef` has nothing to
  // build a sitemap from), so listing every live entry as dropped would ask the maker to authorize a removal the build is then going to refuse.
  let sitemap = null;
  if (navigationHolds(spec).declared && collision.appExists) {
    const appId = await provision.findArtifact('app', { uniqueName: collision.appUnique });
    if (appId) {
      await provision.fetchArtifact('app', appId);
      const deployed = await provision.getArtifact('app', appId) || {};
      sitemap = { deployedTargets: sitemapTargets(deployed.siteMap || {}), wantTargets: sitemapTargets(spec.appShell) };
    }
  }
  return { collision, forms, sitemap };
}

const DESTRUCTIVE_APPROVAL_FILE = 'destructive-approval.json';

function destructiveApprovalPath(workspaceDir) {
  return workspaceDir ? path.join(workspaceDir, DESTRUCTIVE_APPROVAL_FILE) : null;
}

// Approval records are deliberately tiny and human-readable because they bind a later
// `--allow-destructive` run to the exact refusal list a maker reviewed:
//   {
//     "schemaVersion": 1,
//     "generatedAt": "2026-01-01T00:00:00.000Z",
//     "formRemovals": { "<form-id>": { "label": "form \"Main\" (new_table)", "fields": ["new_field"] } },
//     "sitemapRemovals": ["entity:new_table", "url:https://contoso.crm.dynamics.com/help"],
//     "runId": "<the build that wrote it>"
//   }
// `runId` makes every record's bytes unique, so a record's content fingerprint says which build wrote
// it (see approvalFingerprint). Reading ignores it.
// Treat every malformed shape as unreadable: guessing at a damaged approval would widen destructive
// authority, which is exactly what this file is meant to prevent.
function normalizeApprovalRecord(value) {
  if (!value || value.schemaVersion !== 1 || !value.formRemovals || Array.isArray(value.formRemovals) || typeof value.formRemovals !== 'object' || !Array.isArray(value.sitemapRemovals)) return null;
  const formRemovals = {};
  for (const [formId, entry] of Object.entries(value.formRemovals)) {
    if (!entry || !Array.isArray(entry.fields)) return null;
    const normalizedFormId = normalizeFormId(formId);
    if (!normalizedFormId) return null;
    formRemovals[normalizedFormId] = {
      label: typeof entry.label === 'string' ? entry.label : normalizedFormId,
      fields: entry.fields.map((f) => String(f).toLowerCase()),
    };
  }
  return {
    schemaVersion: 1,
    generatedAt: typeof value.generatedAt === 'string' ? value.generatedAt : '',
    formRemovals,
    sitemapRemovals: value.sitemapRemovals.map((target) => String(target)),
  };
}

// One read yields both the record and the fingerprint of the bytes it was parsed from, so the record a
// build compares with and the one it later claims as "the record I saw" cannot differ.
function readApprovalRecord(workspaceDir) {
  const file = destructiveApprovalPath(workspaceDir);
  if (!file) return { exists: false, file, record: null, fingerprint: null };
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, file, record: null, fingerprint: null };
    return { exists: true, file, error: err, fingerprint: `unreadable:${(err && err.code) || 'error'}` };
  }
  const fingerprint = sha256(raw);
  try {
    const record = normalizeApprovalRecord(JSON.parse(raw.toString('utf8')));
    if (!record) throw new Error('record has an unsupported shape');
    return { exists: true, file, record, fingerprint };
  } catch (err) {
    return { exists: true, file, error: err, fingerprint };
  }
}

// The content fingerprint of the record on disk, or null when there is none. A file that cannot be
// read gets a fingerprint no build ever wrote, so an owner check never consumes or replaces it.
function approvalFingerprint(workspaceDir) {
  return readApprovalRecord(workspaceDir).fingerprint;
}

// Writes atomically and returns the fingerprint of what it wrote.
function writeApprovalRecord(workspaceDir, removals, runId) {
  const file = destructiveApprovalPath(workspaceDir);
  if (!file) return null;
  // Same rule as the workspace check above: a link at the workspace, or at the approval
  // file name, must not be followed. writeFileSafe replaces a plain file and refuses a link.
  assertSafeOutputDir(workspaceDir, { create: true });
  const text = JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), ...removals, runId }, null, 2) + '\n';
  writeFileSafe(file, text);
  return sha256(text);
}

function deleteApprovalRecord(workspaceDir) {
  const file = destructiveApprovalPath(workspaceDir);
  if (!file) return;
  try { fs.unlinkSync(file); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
}

function removalRecordFromOps(removals) {
  const byForm = new Map();
  const sitemap = [];
  for (const op of removals || []) {
    if (op.kind === 'form-field-removal') {
      const formId = normalizeFormId(op.formId);
      if (!formId) continue;
      if (!byForm.has(formId)) byForm.set(formId, { formId, label: op.label, fields: [] });
      byForm.get(formId).fields.push(...(op.fields || []));
    } else if (op.kind === 'sitemap-removal') {
      sitemap.push(...(op.targets || []));
    }
  }
  const formRemovals = {};
  for (const entry of byForm.values()) {
    formRemovals[entry.formId] = { label: entry.label, fields: [...new Set(entry.fields.map((f) => String(f).toLowerCase()))] };
  }
  return {
    formRemovals,
    sitemapRemovals: [...new Set(sitemap.map((target) => String(target)))],
  };
}

function authorizedFormRemovalMap(state, removals) {
  const map = new Map();
  for (const f of (state && state.forms) || []) {
    if (f && f.formId && f.def && f.def.__explicitLayout && f.def.__prune !== false) map.set(normalizeFormId(f.formId), new Set());
  }
  for (const [formId, entry] of Object.entries(removalRecordFromOps(removals).formRemovals)) {
    const normalizedFormId = normalizeFormId(formId);
    if (!normalizedFormId) continue;
    if (!map.has(normalizedFormId)) map.set(normalizedFormId, new Set());
    for (const field of entry.fields || []) map.get(normalizedFormId).add(field);
  }
  return map;
}

function findNewlyUnapprovedRemovals(current, approved) {
  const approvedSitemap = new Set(approved.sitemapRemovals || []);
  const newOps = [];
  for (const [formId, entry] of Object.entries(current.formRemovals || {})) {
    const normalizedFormId = normalizeFormId(formId);
    const approvedEntry = (approved.formRemovals || {})[normalizedFormId];
    const ok = new Set((approvedEntry && approvedEntry.fields) || []);
    const fields = (entry.fields || []).filter((field) => !ok.has(field));
    if (fields.length) newOps.push({ kind: 'form-field-removal', label: entry.label, fields });
  }
  const sitemap = (current.sitemapRemovals || []).filter((target) => !approvedSitemap.has(target));
  if (sitemap.length) newOps.push({ kind: 'sitemap-removal', label: 'app sitemap', targets: sitemap });
  return newOps;
}

function formatNewRemovalDetail(op) {
  if (op.kind === 'form-field-removal') return `removes field(s): ${op.fields.join(', ')} — not on the list the maker approved (another maker may have added them, or the spec changed since)`;
  return `drops navigation target(s): ${op.targets.join(', ')} — not on the list the maker approved (another maker may have added them, or the spec changed since)`;
}

// A managed publish whose answer was lost, and that no fresh read can settle (it carried only layers that were already live),
// blocks its scope across runs until the maker accepts the risk (managed-bindings.js acceptUncertainPublication). Every refusal
// over it carries the blocked dispatch as DATA (managed-bindings.js blockedPublication): { dispatchToken, approval:
// 'publication-risk:<scopeKey>/<dispatchToken>', remedy } — on the error itself when the publish protocol or the store threw it,
// on a cause when a feature's or the table publisher's halt wraps it (err.cause, err.cause.cause, …). So the dispatch is read
// from those properties and never parsed out of a message. Answers { scope, dispatchToken, approval, remedy } or null.
function blockedPublicationOf(err) {
  const seen = new Set();
  for (let e = err, depth = 0; e && typeof e === 'object' && depth < 8 && !seen.has(e); e = e.cause, depth += 1) {
    seen.add(e);
    if (typeof e.dispatchToken !== 'string' || !e.dispatchToken || typeof e.remedy !== 'string' || typeof e.approval !== 'string') continue;
    // publication-risk:table:new_ticket/<dispatch> | publication-risk:dashboard:00000000-0000-0000-0000-000000000000/<dispatch>
    const m = /^publication-risk:(table|dashboard):([^/]+)\//.exec(e.approval);
    if (!m) continue;
    const scope = m[1] === 'table' ? { type: 'table', table: m[2] } : { type: 'dashboard', id: m[2] };
    // Only an approval that spells exactly this scope AND the dispatch the refusal carries: the round trip is the store's
    // spelling, so a refusal can never offer one dispatch's decision for another.
    if (publicationRiskApproval(scope, e.dispatchToken) !== e.approval) continue;
    return { scope, dispatchToken: e.dispatchToken, approval: e.approval, remedy: e.remedy };
  }
  return null;
}

const scopeLabel = (scope) => (scope.type === 'table' ? `table ${scope.table}` : `dashboard ${scope.id}`);

// What a halt over such a publish offers the maker: the remedy and the typed approval the refusal names, exactly as the
// refusal carries them, for the NEXT run. It records nothing. The approval names the dispatch it is printed for, and a run
// accepts it only as it starts, against the publishes its store holds unconfirmed then (acceptPublicationRiskAtStart). A key
// this run was given that matched none of those grants nothing later in the run: a dispatch made during the run has a token
// no earlier stop printed, so recording it here could only act on a decision the maker never saw. Never throws: the halt is
// what this run reports.
function offerPublicationRisk(err, { say } = {}) {
  const blocked = blockedPublicationOf(err);
  if (!blocked || typeof say !== 'function') return null;
  say(`a managed publish of ${scopeLabel(blocked.scope)} was sent and could not be confirmed (dispatch ${blocked.dispatchToken}): ${blocked.remedy}. Check what is live there; to accept that this lost publish may still complete, run the build again with ${authorizeFlag(blocked.approval)}`);
  return blocked;
}

// Record the maker's typed acceptance of one blocked dispatch ({ scope, dispatchToken, approval }) and say what it did.
// Answers what the store answered ({ released }), or null when the store refused it before writing anything (the
// dispatch settled or changed under the lease, the store busy or full), so nothing was recorded and the scope stays
// blocked. Any other failure (the replacement was attempted and its answer or read-back failed: refusedBeforeWrite is
// not true) leaves the acceptance perhaps durable and perhaps not; the run must not go on as if nothing were recorded,
// nor say the scope stayed blocked, so it ends the invocation with a halt that sends nothing more and is never retried.
// The next build reads the store afresh and finds the dispatch either accepted or still blocked.
function recordPublicationRisk(store, blocked, say) {
  const detail = (e) => String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 300);
  try {
    const out = store.acceptUncertainPublication({ scope: blocked.scope, dispatchToken: blocked.dispatchToken, approval: blocked.approval });
    say(`accepted the risk of dispatch ${blocked.dispatchToken} (${blocked.approval}); ${(out && out.released ? out.released.length : 0)} managed group(s) owe their publish again. This run stays stopped: run the build again to publish it after the usual checks`);
    return out;
  } catch (e) {
    if (e && e.refusedBeforeWrite === true) {
      say(`--authorize ${blocked.approval} was not recorded: the store refused it before writing anything (${detail(e)}); dispatch ${blocked.dispatchToken} stays blocked`);
      return null;
    }
    const halt = new BuildHalt(`the build could not confirm whether it recorded the accepted risk of dispatch ${blocked.dispatchToken} (${blocked.approval}): the store's replacement was attempted and its answer was lost (${detail(e)}), so the acceptance may or may not be recorded. The build stopped before writing anything to the environment and sends nothing more in this run. Run the build again: it reads the store afresh and finds that publish either accepted (owed again, and published after the usual checks) or still unconfirmed, with the same approval to give.`, {
      phase: 'preflight', code: 'publication-risk-record-unconfirmed', recoverable: true, retry: RETRY.NEVER, cause: e,
    });
    // Nothing of this invocation may be sent after it (this is the first attempt, before any phase), so the final cleanup sends nothing.
    Object.defineProperty(halt, 'stopsServiceWrites', { value: true, enumerable: false, configurable: true });
    throw halt;
  }
}

// The maker's decision, taken as the run starts and only then: every publish the store holds as sent and unconfirmed
// ('dispatching' or 'unconfirmed') whose exact typed approval (its scope AND its dispatch token) this run was given is
// accepted right after the store opens, before any phase and any service write. Waiting for a phase to stop on it is not
// enough: the stop does not always carry the dispatch as data. With --publish a declared form's table is confirmed only in
// the publish phase, so the app write, which the store's quarantine withholds, stops the build first; a removed
// declaration, or a run without the phase that would confirm it, stops the same way. The scope, dispatch token and approval
// are the store's own data (the same the printed remedy was made from), never parsed out of an earlier run's text. Only a
// key the CLI parsed into `publicationRisk` (authorizationKeys) counts: --allow-destructive, --approve all and every other key
// never do. A key for an earlier dispatch of the same scope, one already settled, or one for a dispatch that does not
// exist matches nothing here and grants nothing for the rest of the run (offerPublicationRisk only prints); it is reported
// as unused. A store that refuses before writing is said, and the run goes on as it would have; one whose write cannot be
// confirmed halts (recordPublicationRisk). Answers the dispatches it recorded.
function acceptPublicationRiskAtStart(store, accepted, say) {
  if (!(accepted instanceof Set) || !accepted.size) return [];
  const due = new Map();
  const readable = store && typeof store.snapshot === 'function' && typeof store.acceptUncertainPublication === 'function';
  if (readable) {
    for (const unit of store.snapshot().units()) {
      const pub = !unit.invalid && unit.group && unit.group.publication;
      if (!pub || (pub.state !== 'dispatching' && pub.state !== 'unconfirmed') || !pub.scope || typeof pub.dispatchToken !== 'string' || !pub.dispatchToken) continue;
      const approval = publicationRiskApproval(pub.scope, pub.dispatchToken);
      if (!accepted.has(approval)) continue;
      due.set(approval, { scope: { ...pub.scope }, dispatchToken: pub.dispatchToken, approval });
    }
  }
  for (const key of accepted) {
    if (due.has(key)) continue;
    say(`--authorize ${key} was not used: ${readable ? 'no publish this run\'s managed binding store holds unconfirmed is that dispatch (it may have settled, or the key was printed for another one)' : 'this run has no managed binding store to accept it in'}; it grants nothing in this run`);
  }
  const recorded = [];
  for (const blocked of due.values()) if (recordPublicationRisk(store, blocked, say)) recorded.push(blocked);
  return recorded;
}

// What a run says when a halt that ends the invocation before any service write (`stopsServiceWrites`, sdk-build.js
// haltOnUnconfirmedRetirements) stops it. The final cleanup sends nothing after such a halt (buildModelApp), so what an
// EARLIER attempt of this run left unsettled is warned about instead, with what recovers it:
//  - a table publish it deferred (`owedPublishes`, `[type, id, names?]` targets): the change is saved and not live, and the
//    next build publishes it (it reconciles the same views and forms and publishes their tables, unchanged ones too);
//  - a name column length it owed for a table it created (`owedLengths`, `{ table, column, asked, tried }`; one marked
//    `tried` already had its own warning): a later build leaves the column of a table it finds as it is, so the maker sets it.
// The halt's own words ("the build stopped before writing anything") are true of the attempt that raised it. A run past its
// first attempt had an earlier one end on a transient failure, and what that attempt sent stays sent, so from the second
// attempt on the halt is said again with that told apart. Its code, phase, findings and signal are the halt's own, so nothing
// that reads them changes, and it is never retried, like the halt it says again (only the retirement halt,
// managed-not-settled, and the start-of-run publication-risk-accepted and publication-risk-record-unconfirmed halts, all
// RETRY.NEVER, carry the signal); on the first attempt the halt is returned as it is.
function stoppedAfterEarlierAttempts(err, attempt, owedPublishes, owedLengths, warn) {
  const say = (message) => { if (typeof warn === 'function') warn(message); };
  const nameOf = (t) => (Array.isArray(t[2]) && t[2].length ? t[2].join(', ') : `${t[0]} ${t[1]}`);
  const publishes = (Array.isArray(owedPublishes) ? owedPublishes : []).filter((t) => Array.isArray(t) && t[0] && t[1]);
  if (publishes.length) {
    say(`the build stopped before its publish phase and sends nothing more in this run; an earlier attempt of this run saved and did not publish ${publishes.map(nameOf).join('; ')} — the change is SAVED but the runtime still serves the previously published copy until the next build publishes it`);
  }
  for (const d of (Array.isArray(owedLengths) ? owedLengths : []).filter((x) => x && typeof x.table === 'string' && x.tried !== true)) {
    say(`table ${d.table}, which an earlier attempt of this run created, may not have its name column ${d.column} at ${d.asked} characters: the environment may have given it another length, and this run did not check (it sends nothing more); a later build leaves the column of a table it finds as it is, so check ${d.column} in Maker and set it to ${d.asked} characters if it differs`);
  }
  if (!(attempt > 1)) return err;
  const halt = new BuildHalt(`${err.message} That is attempt ${attempt} of this run: an earlier attempt ended on a transient failure and was retried, and what it had already sent stays as it is; nothing more is sent in this run.`, {
    phase: err.phase, code: err.code, recoverable: !!err.recoverable, retry: RETRY.NEVER, cause: err,
  });
  Object.defineProperty(halt, 'findings', { value: err.findings, enumerable: false, configurable: true });
  Object.defineProperty(halt, 'stopsServiceWrites', { value: true, enumerable: false, configurable: true });
  return halt;
}

async function buildModelApp(spec, opts, deps) {
  const v = validateAppSpec(spec, { profile: opts.profile || 'deploy' });
  if (!v.ok) {
    return { ok: false, errors: v.errors };
  }
  const fileErrors = appSourceFileErrors(spec, opts.appDir);
  if (fileErrors.length) return { ok: false, errors: fileErrors };
  if (!opts.apply) return buildModelAppHeld(spec, opts, deps, v, undefined);
  // An APPLY runs under the app's build lease (lib/app-operation-lease.js), from the approval record it reads at its start, through every attempt
  // of the retry loop below and its waits, the settlement of what a halted run owes, the inline verify and the journal's close: a second apply of
  // the same app in the same workspace is refused before any of that. The CLI hands its own lease in (`opts.buildLease`), and it is borrowed; a
  // caller that holds none gets one taken here, and let go when this returns or throws.
  return withAppBuildLease({ workspaceDir: applyWorkspaceOf(opts), appUniqueName: appUniqueName(spec), buildLease: opts.buildLease, warn: deps.warn },
    (buildLease) => buildModelAppHeld(spec, opts, deps, v, buildLease));
}

// The body of buildModelApp, run once the spec has been validated — under the build lease `buildLease` for an apply, which every attempt below borrows.
async function buildModelAppHeld(spec, opts, deps, v, buildLease) {
  const log = deps.log || (() => undefined);
  // Surface non-blocking validation advisories (e.g. a PRE-EXISTING duplicate page name the build does
  // not create — see validateAppSpec). These no longer HALT the build; they are narrated so the maker
  // knows about the ambiguity but an unrelated edit still applies.
  for (const w of v.warnings || []) log(`⚠ ${w}`);
  const counts = { ok: 0, skip: 0, error: 0 };
  const journal = deps.journal;
  // Tee the engine's progress events into the durable journal without touching the pure engine.
  const baseEmit = deps.emit || cliEmit(log, { apply: opts.apply, counts });
  // skill_completed telemetry counts an apply's steps per phase from the same events (lib/telemetry/skill-completed.js).
  const stepTally = opts.apply ? deps.stepTally : null;
  const emit = journal || stepTally
    ? (e) => { baseEmit(e); if (journal) journal.record(e); if (stepTally) stepTally.record(e); }
    : baseEmit;
  const sleep = deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms)));
  // One budget for all the waiting a run does when a service throttles — the HTTP client's waits before it sends a throttled read, publish, delete or column create again, the page backend's waits between the sends of a page write (a `$batch` the
  // client never re-sends) and this loop's own waits before it runs a phase again — so the run can neither wait twenty silent minutes for one page nor forget, where one layer hands over to the other, what the service asked (lib/throttle-budget.js).
  // main() makes it before the SDK and hands it to the client the SDK is made over, to the page backend (through the engine's `throttle`) and here (`deps.throttle`); a caller that gives none gets one of its own, which only the layers it is handed to
  // draw from. The waits that are not for a throttle — a 5xx, a reset connection, a deadlock victim — keep the clients' own schedules and are not drawn. `now` is the clock the page backend stamps the moment before which nothing may be sent on
  // (`retryNotBefore`): a test seam, with `sleep`.
  const throttle = deps.throttle || makeThrottleBudget({ warn: deps.warn });
  const now = deps.now || Date.now;
  let authorizedFormRemovals;
  let authorizedSitemapRemovals;
  let currentDestructiveApproval;
  // The approval record binds the run that SHOWED a list. Two builds can share a workspace, so this run
  // consumes or replaces only a record it found at its start (`seen`) or wrote itself (`owned`), by
  // content fingerprint, and does the check and the change under the workspace lease the apply snapshot
  // uses (lib/apply-snapshot-store.js). Without that, a build that finished with nothing kept deleted
  // the record another build had just written for its refusal, and that build's approved re-run was
  // bound to nothing. Captured before any discovery, from the same read the gate compares with.
  const approvalAtStart = opts.apply && opts.workspaceDir ? readApprovalRecord(opts.workspaceDir) : { exists: false, fingerprint: null };
  const approvalRun = { id: randomUUID(), seen: approvalAtStart.fingerprint, owned: new Set() };
  // What a record on disk is to this run: 'none'; 'ours' (the one it started with, or one it wrote);
  // 'unreadable', whose content is unknown, so it never proves ownership (two unreadable reads say
  // nothing about whether it is the same file); or 'foreign', another build's.
  const approvalOwnership = (fingerprint) => {
    if (fingerprint === null) return 'none';
    if (typeof fingerprint === 'string' && fingerprint.startsWith('unreadable:')) return 'unreadable';
    return fingerprint === approvalRun.seen || approvalRun.owned.has(fingerprint) ? 'ours' : 'foreign';
  };
  // Every writer holds the lease for milliseconds, so a few short waits ride out a collision. A lease
  // that stays held is reported, and each caller decides what is safe without it.
  const withApprovalLease = async (fn) => {
    const attempts = deps.approvalLeaseAttempts || 10;
    let reason = 'held';
    for (let i = 0; i < attempts; i += 1) {
      const lease = applySnapshotStore.acquireLease(opts.workspaceDir);
      if (lease.ok) {
        try { return { locked: true, value: fn() }; } finally { applySnapshotStore.releaseLease(lease); }
      }
      reason = lease.reason || reason;
      if (i < attempts - 1) await sleep(200);
    }
    return { locked: false, reason };
  };
  // Write this run's record under the lease. `ifOurs` refuses to replace another build's record, or one
  // it cannot read.
  const recordApproval = (record, { ifOurs = false } = {}) => withApprovalLease(() => {
    const owner = ifOurs ? approvalOwnership(approvalFingerprint(opts.workspaceDir)) : 'none';
    if (owner === 'unreadable' || owner === 'foreign') return owner;
    approvalRun.owned.add(writeApprovalRecord(opts.workspaceDir, record, approvalRun.id));
    return 'written';
  });
  // Only the forms and app-shell phases remove anything, and a changed-only fast apply runs neither.
  const runsRemovalPhases = (opts.phases || PHASES).includes('forms') && (opts.phases || PHASES).includes('app-shell')
    && !(opts.changedOnly && opts.changedOnly.fastApply);

  // Partial-apply guard: on APPLY, the ONLY safe phase selections are the FULL build or EXACTLY the `data` stage
  // (solution+data-model+sample-data). Every other partial range (--from/--to/--only/--skip, or any other
  // --stage) is dry-run-only (design §14): its range is not dependency-closed and the app id is not carried
  // across runs, so applying it would run phases against an incomplete result map. Recovery from a halt is
  // a FULL rerun (idempotent), never --from pages.
  if (opts.apply) {
    const active = opts.phases || PHASES;
    const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    // Exception: a `--changed-only` pages-only FAST apply is the ONE sanctioned partial range. It is
    // pre-gated by the changed-only flow (snapshot eligibility + identity match + classify proved every
    // change is a pure page-content re-upload) and self-hydrates the app id via
    // opts.changedOnly.resolvedAppId (the sdk-build seam), so it does NOT hit the cross-phase-id hazard this guard
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
  // STOP the fast path in --non-interactive because the app always exists, and (b) do slow full
  // form/sitemap reads for nothing. The pages phase keeps its own removal/shared/membership safety gates.
  const isFastApply = !!(opts.changedOnly && opts.changedOnly.fastApply);
  if (opts.apply && !isFastApply && (deps.discoverOpDiffState || (deps.provisionSdk && opts.checkCollisions !== false))) {
    const nonInteractive = opts.nonInteractive === true;
    const allowDestructive = opts.allowDestructive === true;
    let state;
    let discoveryError = null;
    const priorApproval = allowDestructive && opts.workspaceDir ? approvalAtStart : { exists: false };
    if (priorApproval.error) {
      const msg = `${priorApproval.file} could not be read as a destructive approval record — delete it or re-run without --allow-destructive to see the list again.`;
      log(`\n✗ ${msg}`);
      if (journal) journal.close({ status: 'halt', phase: 'preflight', label: 'destructive-approval-unreadable', detail: priorApproval.file, ...counts });
      return { ok: false, errors: [msg] };
    }
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
    if (discoveryError && priorApproval.exists) {
      const msg = `preflight safety check could not run (discovery failed: ${(discoveryError && discoveryError.message) || discoveryError}) — live removals cannot be compared with the approved list in ${DESTRUCTIVE_APPROVAL_FILE}. Re-run to retry before writing.`;
      log(`\n✗ ${msg}`);
      if (journal) journal.close({ status: 'halt', phase: 'preflight', label: 'destructive-approval-compare-failed', detail: String((discoveryError && discoveryError.message) || discoveryError), ...counts });
      return { ok: false, errors: [msg] };
    }
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
      //     An 'app-main-forms-removal' (app.mainFormsOnUpdate "exact" on an existing app) is authorized by the
      //     flag for this run: the approval record holds form fields and sitemap targets only, so it neither
      //     records nor compares it (the engine refuses it too without the flag).
      const diff = classifyOps(spec, state, { teardown: false });
      const removals = diff.destructive.filter((o) => o.kind === 'form-field-removal' || o.kind === 'sitemap-removal' || o.kind === 'app-main-forms-removal');
      authorizedFormRemovals = authorizedFormRemovalMap(state, removals);
      const currentApproval = removalRecordFromOps(removals);
      currentDestructiveApproval = currentApproval;
      if (state.sitemap) authorizedSitemapRemovals = new Set(currentApproval.sitemapRemovals);
      if (removals.length && !allowDestructive) {
        const lines = removals.map((o) => `  • ${o.label} — ${o.detail}`);
        // --authorize names one change it consents to and never approves a removal on this list, so a run that was given one is
        // told so: otherwise "without --allow-destructive" reads as if the key it was given had been ignored.
        const authorizeGiven = [opts.authorizedDestructive, opts.authorizedAdoption, opts.authorizedOverwrite, opts.authorizedWebResourceAdoption, opts.authorizedWebResourceOverwrite, opts.publicationRisk]
          .some((s) => s && s.size > 0);
        const msg = `refusing ${removals.length} destructive operation(s) without --allow-destructive${authorizeGiven ? ' (the --authorize keys given approve none of them)' : ''}:\n${lines.join('\n')}`;
        if (opts.workspaceDir) {
          try {
            // The newest refusal is the list the maker is looking at, so it replaces any older record.
            const lock = await recordApproval(currentApproval);
            if (!lock.locked) log(`\n⚠ could not lock the workspace to write ${DESTRUCTIVE_APPROVAL_FILE} (${lock.reason}) — re-run this refusal before approving it with --allow-destructive.`);
          } catch (err) {
            // Approval records are a safety aid for the NEXT invocation. The refusal itself is the
            // primary guard, so a disk failure must not replace the exact destructive-op list the maker
            // needs to review now.
            log(`\n⚠ could not write ${DESTRUCTIVE_APPROVAL_FILE}: ${(err && err.message) || err}`);
          }
        }
        log(`\n✗ ${msg}`);
        if (journal) journal.close({ status: 'halt', phase: 'preflight', label: 'destructive-ops', detail: removals.map((o) => o.kind).join(','), ...counts });
        return { ok: false, errors: [msg] };
      }
      if (allowDestructive && opts.workspaceDir) {
        if (priorApproval.exists) {
          const newlyUnapproved = findNewlyUnapprovedRemovals(currentApproval, priorApproval.record);
          if (newlyUnapproved.length) {
            try {
              const lock = await recordApproval(currentApproval);
              if (!lock.locked) log(`\n⚠ could not lock the workspace to refresh ${DESTRUCTIVE_APPROVAL_FILE} (${lock.reason})`);
            } catch (err) { log(`\n⚠ could not refresh ${DESTRUCTIVE_APPROVAL_FILE}: ${(err && err.message) || err}`); }
            const lines = newlyUnapproved.map((o) => `  • ${o.label} — ${formatNewRemovalDetail(o)}`);
            const msg = `refusing ${newlyUnapproved.length} destructive operation(s) that were not on the list the maker approved:\n${lines.join('\n')}`;
            log(`\n✗ ${msg}`);
            if (journal) journal.close({ status: 'halt', phase: 'preflight', label: 'destructive-ops-new', detail: newlyUnapproved.map((o) => o.kind).join(','), ...counts });
            return { ok: false, errors: [msg] };
          }
        }
        // Persist the gate-time list BEFORE the first mutation. If the engine later keeps a new field
        // and then fails, the next approved run must still be bound to what this run saw. That holds
        // for an EMPTY list too: with nothing recorded, a retry after a failure that kept a field
        // another maker added would have removed it without showing it. A run without the removal
        // phases can keep nothing, so it records only a list it actually has.
        if (removals.length || runsRemovalPhases) {
          let lock = null;
          let writeError = null;
          try { lock = await recordApproval(currentApproval, { ifOurs: true }); } catch (err) { writeError = err; }
          // Fail closed: only a list that is verifiably on disk binds a retry. The comparison above was
          // with the record this run read; a record some other build wrote since then (or one that can
          // no longer be read) means that comparison no longer describes what is on disk. Either way,
          // stop before any write rather than run unbound.
          const halt = writeError
            ? `could not record what this run may remove in ${DESTRUCTIVE_APPROVAL_FILE} (${(writeError && writeError.message) || writeError}) — nothing was changed; fix the workspace folder and re-run.`
            : !lock.locked
              ? `could not lock the workspace to record what this run may remove (${lock.reason}) — re-run once no other build or teardown of this workspace is running.`
              : lock.value === 'unreadable'
                ? `${DESTRUCTIVE_APPROVAL_FILE} could not be read while this build was starting — nothing was changed; check the workspace folder and re-run.`
                : lock.value !== 'written'
                  ? `${DESTRUCTIVE_APPROVAL_FILE} changed while this build was starting — another build may be using this workspace. Re-run once it has finished.`
                  : null;
          if (halt) {
            log(`\n✗ ${halt}`);
            if (journal) journal.close({ status: 'halt', phase: 'preflight', label: 'destructive-approval-changed', detail: halt, ...counts });
            return { ok: false, errors: [halt] };
          }
        }
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
  // The create port feature creates go through (a field security profile today). A plain pass-through: it gives no fence, so a
  // whole-build retry after a lost answer to a create can create a second row of the same name, as for every other create.
  const creates = deps.creates || createPassthroughCreates();
  // The connections a declared connection reference may be bound to, read as list-connections.js reads them. A function, called by the
  // configuration step only when a binding or a page's readiness needs proof (once per pass), so a spec without references never reads them.
  // Without an environment (a test double) there is no reader, and a bound reference stays unproven rather than assumed bound.
  const connections = deps.connections || (opts.env
    ? async () => (await sdkFirst(opts.env, {
      ...connectivity,
      fromSdk: async (sdk) => (await sdk.listConnections()).map(connectionRowFromSdk),
      fromPac: async (refusal) => listConnectionsWithPac(opts.env, refusal),
    })).value
    : undefined);
  // What failed attempts still owe for the views and forms they saved and deferred (sdk-build.js: the default-view
  // enrichment 4b, the reconcile of existing views and forms), by target. Every attempt re-runs every phase, but a
  // later one can halt before the step an earlier one owed from, so each debt is kept until a publish phase pays it
  // (`owedPaid`), and the final halt settles the rest.
  const owedAcrossAttempts = new Map();
  const publicationBarrier = deps.publicationBarrier || createPublicationBarrier();
  // What failed attempts still owe for the primary name column of a table they created and did not finish setting the length of
  // (sdk-build.js: `owedLengths` on the halt, the records the data-model phase keeps). Handed to every attempt, which pays what it can
  // at the end of its own data-model phase; what a halt carries replaces it, being everything that is still owed. A halt that carries
  // no list (one thrown before the engine, or by a stand-in for it) leaves it as it was.
  let owedLengths = [];
  // The tables an attempt of THIS invocation created, by the acknowledged answer of the create (entity-provision.js, provisionDataModelSteps). The set itself is handed to every attempt and lives as long as
  // the invocation, because the retry runs the whole build again: the next attempt finds the table and reuses it, and only this set remembers that this build made it. It decides whether the platform's
  // metadata-cache lag on a table's default views is the lag of a table just created (retry-policy.js, markFreshTable). The retry loop below bounds the invocation, so the set adds no retries of its own.
  const createdTables = new Set();
  // The managed binding store (sdk-build.js openBuildBindingGroups: the one opener, read-only discovery), opened once for the whole
  // invocation on its first attempt and handed to every attempt as `bindingGroups`, so no attempt opens a second writer. Its debt is
  // installed on the barrier every attempt shares. Opened inside the attempt so that a store the build cannot trust halts like any
  // other halt (managed-binding-store-unreadable, never retried).
  let bindingGroups = deps.bindingGroups || null;
  let riskCheckedAtStart = false;
  let r;
  // How many waits the HTTP client has been refused by the budget (lib/throttle-budget.js, `declined`): the count at the start of a run of the phases says whether one happened in it.
  const declinedCount = () => (typeof throttle.declined === 'function' ? throttle.declined().count : 0);
  for (let attempt = 1; ; attempt++) {
    counts.ok = counts.skip = counts.error = 0; // summary reflects the final (successful) attempt
    if (stepTally) stepTally.reset();
    const declinedBefore = declinedCount();
    try {
      if (!bindingGroups) bindingGroups = openBuildBindingGroups(spec, { apply: opts.apply, env: opts.env, workspaceDir: opts.workspaceDir, appDir: opts.appDir, barrier: publicationBarrier });
      // A typed publication-risk approval is taken once, as the store opens and before the first phase, and never later in
      // the run (acceptPublicationRiskAtStart). A run that records one stops here: the store's quarantine of that scope was
      // installed when it opened, so this run could only be withheld by it. One whose recording cannot be confirmed halts
      // inside it, before any phase, and sends nothing.
      if (!riskCheckedAtStart) {
        riskCheckedAtStart = true;
        const accepted = acceptPublicationRiskAtStart(bindingGroups && bindingGroups.store, opts.publicationRisk, deps.warn || log);
        if (accepted.length) {
          const halt = new BuildHalt(`the build recorded the accepted risk of ${accepted.length} unconfirmed managed publish(es) (${accepted.map((a) => a.approval).join(', ')}) and stopped before writing anything. Their publish is owed again: run the build again, without the approval, to publish them after the usual checks (a dashboard whose declaration the spec no longer holds stays owed, and its stop says so, until the declaration is restored).`, {
            phase: 'preflight', code: 'publication-risk-accepted', recoverable: true, retry: RETRY.NEVER,
          });
          // Nothing of this invocation may be sent after it, the settlement of an earlier attempt included (there is none:
          // this is the first attempt), so the final cleanup below sends nothing.
          Object.defineProperty(halt, 'stopsServiceWrites', { value: true, enumerable: false, configurable: true });
          throw halt;
        }
      }
      r = await runBuild(spec, {
        publicationBarrier,
        ...(bindingGroups ? { bindingGroups } : {}),
        ...(deps.sendObserver ? { sendObserver: deps.sendObserver } : {}),
        // The client's workflow effect gate (lib/deferred-workflow-gate.js), which the engine binds to this store.
        ...(deps.workflowEffectGate ? { workflowEffectGate: deps.workflowEffectGate } : {}),
        sdk: deps.sdk,
        provisionSdk: deps.provisionSdk,
        owedLengths,
        createdTables,
        apply: opts.apply,
        sampleData: opts.sampleData,
        publish: opts.publish,
        livePlan: opts.livePlan,
        phases: opts.phases,
        appDir: opts.appDir, // resolves web-resource `contentPath` relative to the app folder
        env: opts.env, // for the pages phase (its page backend is made for this environment)
        languageCode: opts.languageCode,
        // Forwarded explicitly because this is a fresh literal, not a spread of `opts`: without it
        // the data-model phase re-resolves, and on a transient org-read failure that fallback lands
        // on 1033 while the SDK is already baked at the resolved LCID — the exact split-language
        // build (translated FormXML, English columns) this threading exists to prevent.
        preResolvedLanguageCode: opts.preResolvedLanguageCode,
        // Injected so the pure lib stays free of transport. Consulted for an EXPLICIT language override, and by a declared
        // dashboard write that creates a tile (each new tile is sent with its caption in every one of these languages).
        provisionedLanguages: deps.provisionedLanguages,
        warn: deps.warn,
        genpage: deps.genpage, // injectable seam for tests (lib/genpage-sdk.js's shape); else made from env
        typescript: deps.typescript, // the caller's TypeScript provider (lib/typescript-provider.js); absent → the vendored compiler, loaded lazily
        workspaceDir: opts.workspaceDir, // lease/staging live under the real workspace dir
        // The build lease this apply holds (or borrowed from its caller): every attempt borrows it, so none of them takes a second one.
        buildLease,
        authorizedFormRemovals,
        authorizedSitemapRemovals,
        allowDestructive: opts.allowDestructive, // pages phase gates destructive page removals
        // The `--authorize` keys: consent to exactly the destructive schema changes they name, and to nothing else (authorizationKeys).
        authorizedDestructive: opts.authorizedDestructive,
        // The adopt:/overwrite: keys: approvals for exactly the declared views, charts and Quick Find views they name, stored under
        // their family-typed keys (authorizationKeys).
        ...(opts.authorizedAdoption ? { authorizedAdoption: opts.authorizedAdoption } : {}),
        ...(opts.authorizedOverwrite ? { authorizedOverwrite: opts.authorizedOverwrite } : {}),
        // The adopt:webresource:/overwrite:webresource: keys: approvals for exactly the declared web resources they name, kept apart from
        // the view and chart approvals above (authorizationKeys).
        ...(opts.authorizedWebResourceAdoption ? { authorizedWebResourceAdoption: opts.authorizedWebResourceAdoption } : {}),
        ...(opts.authorizedWebResourceOverwrite ? { authorizedWebResourceOverwrite: opts.authorizedWebResourceOverwrite } : {}),
        creates,
        changedOnly: opts.changedOnly, // #changed-only: pages-only fast-apply seams (resolvedAppId + skipSitemapFinalize)
        // The configuration kinds: the --deployment-settings bindings, the managed-artifact recorder a caller may supply (none at this base, so
        // no management record is written), and the connection inventory (B5).
        configurationBindings: opts.configurationBindings,
        managed: deps.managed,
        connections,
        // AB#6726727: the spec last applied to, or downloaded from, this environment — lets the sitemap
        // rewrite keep a nav change made in the designer since then instead of reverting it.
        baselineSpec: opts.baselineSpec,
        // The budget of waiting the page backend spends from, one for every attempt of this run.
        throttle,
        emit,
        // --preview-push (a dry run with the live plan only): the read-only client the preview reads through. Spread
        // in only when asked, so a run without the flag hands the engine exactly the options it did before.
        ...(opts.previewPush === true && !opts.apply ? { previewPush: true, httpClient: deps.previewHttpClient } : {}),
      });
      break;
    } catch (err) {
      if (err && err.owedPaid) owedAcrossAttempts.clear();
      collectOwedPublishes(owedAcrossAttempts, err && err.owedPublishes);
      if (err && Array.isArray(err.owedLengths)) owedLengths = err.owedLengths;
      let halted = err;
      const transient = isTransientHalt(err, { spec });
      const ask = transient ? throttleAskOf(err) : null;
      // The words of the halt for a wait that does not fit: stop, and say what the service asked. The build is idempotent, so a later run goes on from here.
      const budgetHalt = (askedMs, waitMs) => new BuildHalt(`${err && err.phase ? `${err.phase} stopped` : 'the build stopped'}: ${waitDoesNotFit(throttle, { askedMs, waitMs })}`, {
        phase: err && err.phase, code: 'throttle-budget-exhausted', recoverable: true, cause: err, retry: retryPolicyFor(err), statusCode: 429,
      });
      // A throttle that stopped a request in THIS run of the phases: the HTTP client draws its waits from the budget too, and a wait that does not fit is not taken — the answer comes back as the 429 it is, which carries nothing of what the service
      // asked (the SDK's error holds no headers), and the client tells the budget instead (`declined`, lib/throttle-budget.js). The service said it was not ready for longer than the run may wait, so running the phases again would meet the
      // same answer: stop here, as for a wait of the build's own that does not fit — and so on the last run as on the first.
      const refused = transient && ask.throttled && declinedCount() > declinedBefore ? throttle.declined() : null;
      if (refused) {
        halted = budgetHalt(Math.max(ask.askedMs, refused.askedMs), refused.waitMs);
      } else if (attempt <= maxRetries && transient) {
        const backoff = opts.retryDelayMs != null ? opts.retryDelayMs : backoffMs(attempt);
        // What the service asked of the next send, carried across the layers (retry-policy.js, throttleAskOf): when the page backend's sends ran out it handed over the moment before which nothing may be
        // sent. The wait is what is LEFT of it — the layers between did work — in whole seconds, the unit `Retry-After` counts in, and never less than the build's own backoff.
        const asked = ask.notBefore > 0 ? Math.ceil(Math.min(ask.askedMs || Infinity, Math.max(0, ask.notBefore - now())) / 1000) * 1000 : 0;
        const delay = Math.max(backoff, asked);
        if (ask.throttled && !throttle.fits(delay)) {
          // The wait does not fit what is left of the run's budget.
          halted = budgetHalt(ask.askedMs || asked, delay);
        } else {
          if (ask.throttled) throttle.spend(delay);
          if (journal) journal.record({ phase: err && err.phase, status: 'retry', label: `transient error (attempt ${attempt}/${maxRetries}) — retrying in ${delay}ms`, detail: String((err && err.message) || err) });
          const askNote = asked > 0 ? ` (the service asked to wait ${Math.ceil((ask.askedMs || asked) / 1000)} s)` : '';
          log(`\n⟳ transient error in ${err && err.phase} — retrying (attempt ${attempt}/${maxRetries}) after ${delay}ms${askNote}…`);
          await sleep(delay);
          continue;
        }
      }
      // A non-transient (or retries-exhausted, or out-of-budget) halt — journal where/why it stopped, then propagate.
      // Resume by re-running the same command (idempotent): a partial range (--from and the like) is
      // refused on --apply.
      //
      // First publish the views and forms this build's attempts had saved and no publish phase paid: no
      // retry follows now (see settleOwedPublishes, sdk-build.js). Best-effort, so the halt below is still
      // what this run reports. The spec's tables ride along so the settle can say what they still hold saved and
      // not published — but only for a build that stopped BEFORE a publish phase it has: an apply with --publish
      // and the phase in its range, not a halt before anything was written, and not one after the phase completed
      // (`owedPaid`: the halt of a step that runs after it, the AI features' re-confirmation, say). What the phase
      // published is live, and a line that says the build stopped before it would be false.
      const hadPublishPhase = opts.apply && opts.publish && (opts.phases || PHASES).includes('publish') && !(err && err.phase === 'preflight') && !(err && err.owedPaid);
      // A halt that ends the invocation before any service write (`stopsServiceWrites`: a dashboard or form retirement
      // the build could not confirm, sdk-build.js haltOnUnconfirmedRetirements, or a publication risk accepted as the run
      // started, or whose recording could not be confirmed, acceptPublicationRiskAtStart) sends nothing here either: neither the
      // publish an EARLIER attempt of this run deferred, nor the name column length it owed. The store that attempt and
      // this one read can no longer be trusted, so this run stops sending. What is left is said instead, and stays
      // recoverable: the next build reconciles the same views and forms and publishes their tables again (publishReconciled,
      // which publishes a form or view it finds unchanged too); a name column length it cannot set, because a build never
      // rewrites the column of a table it finds (provisionDataModel), so the warning says the length to set. Every other
      // halt settles as before.
      const writesStopped = !!(err && err.stopsServiceWrites === true);
      if (writesStopped) {
        halted = stoppedAfterEarlierAttempts(err, attempt, [...owedAcrossAttempts.values()], owedLengths, deps.warn);
      } else {
        await settleOwedPublishes(deps.provisionSdk || deps.sdk, [...owedAcrossAttempts.values()].filter((t) => publicationBarrier.allowTarget(t, 'settle after a halt')), deps.warn, hadPublishPhase ? { tables: specTables(spec) } : undefined);
      }
      if (typeof deps.warn === 'function') for (const w of publicationBarrier.withheld()) deps.warn(describeWithheld(w));
      // And set the name column length of a table whose debt no attempt got as far as paying (the last one halted before its data-model phase).
      if (!writesStopped) await settleOwedLengths({ sdk: deps.sdk, provision: deps.provisionSdk || deps.sdk, spec, owed: owedLengths, warn: deps.warn, sleep });
      // A managed publish no fresh read can settle: say what the maker may decide, for the next run (offerPublicationRisk). Nothing
      // is recorded here: an approval is accepted only as a run starts (acceptPublicationRiskAtStart). The halt stands.
      offerPublicationRisk(halted, { say: deps.warn || log });
      if (journal) journal.close({ status: 'halt', phase: halted && halted.phase, code: halted && halted.code, recoverable: !!(halted && halted.recoverable), message: String((halted && halted.message) || halted), ...counts });
      throw halted;
    }
  }
  // #559: a dry run's whole purpose is to say what an apply would DO, so summarise the decision
  // rather than only listing the spec back. `unknown` is counted separately and never folded into
  // either real decision — an unresolved probe is missing information, not a verdict. Within it, an item
  // the environment ANSWERED and the answer is "this would stop the build" (`wouldHalt`: a view filter
  // label that names no option) is a verdict too, so it is not counted as unreadable.
  if (r && r.dryRun && Array.isArray(r.planItems)) {
    const n = (s) => r.planItems.filter((p) => p.state === s).length;
    const unprobed = r.planItems.filter((p) => !p.state && !p.op).length;
    const wouldHalt = r.planItems.filter((p) => p.state === 'unknown' && p.wouldHalt).length;
    // An exact Main-form list's removal (`op`, sdk-build.js) is not an artifact the live plan probes: it is counted on its own, never as "not probed".
    const removals = r.planItems.filter((p) => p.op && p.destructive).length;
    const removing = removals ? `${removals} would take Main forms out of the app (--allow-destructive)` : '';
    const unreadable = n('unknown') - wouldHalt;
    const parts = [`${n('create')} to create`, `${n('reuse')} already present`];
    if (unreadable) parts.push(`${unreadable} could not be read`);
    if (wouldHalt) parts.push(`${wouldHalt} would stop the build`);
    if (unprobed) parts.push(`${unprobed} not probed`);
    if (removing) parts.push(removing);
    // A dry run that says a step would stop the build must not then tell the maker to run it. The spec-only summary counts those steps too: with no live
    // probe the navigation check can still refuse a spec on its own, and it marks the app step the same way.
    const closing = wouldHalt ? 'Fix the steps marked ? above, then re-run with --apply to execute.' : 'Re-run with --apply to execute.';
    log(r.livePlan
      ? `\n▢ dry run — ${parts.join(', ')} (${r.planItems.length} steps). ${closing}`
      : `\n▢ dry run — ${r.planItems.length} steps, spec-only (no live probe; --no-live-plan)${wouldHalt ? `, ${wouldHalt} would stop the build` : ''}${removing ? `, ${removing}` : ''}. ${closing}`);
    if (r.pushPreview) printPushPreview(r.pushPreview, log);
  }
  if (opts.apply && r && r.ok && !r.dryRun) {
    log(`\n✓ build complete — ${counts.ok} created, ${counts.skip} skipped, ${counts.error} failed (${counts.ok + counts.skip + counts.error} steps)`);
    // Auto-verify: reconcile the spec against what actually deployed so a silent partial build
    // (an artifact created but not wired, or a phase that quietly produced nothing) surfaces now
    // instead of only when the user opens the app. Read-only; injected (deps.verify) so tests drive it.
    // A verify failure does NOT undo the build (it already ran) — it is reported and returned in
    // r.verify so the CLI can exit non-zero.
    //
    // MANDATORY + FAIL-CLOSED for page-bearing specs (design §13.1):
    //   - Page verify runs even without --verify when the spec has implemented pages AND the pages
    //     phase was applied (appliedPagesPhase). A --stage data apply (pages NOT selected) must NOT
    //     trigger mandatory verify.
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
          // Hand verify what the BUILD could not do on this environment, and which phases actually
          // ran. Without the first, an environment-gated business-rule skip reports `not deployed`
          // and drives `verify.ok` false forever — and that value gates the exit code,
          // `.last-applied.json` AND the `--changed-only` snapshot, so the baseline would never be
          // written and every later run would fall back to a full build. Without the second, the
          // `--changed-only` FAST path (which runs `phases: ['pages']`, so it produces no skip list
          // at all) fails the same way on every run after the first.
          // The language the build wrote its labels in goes too: the flag it was given and what its SDK was made for. A build run with
          // `--language-code` in an organization whose base language is another one publishes its captions in the flag's language, and a
          // verify that does not know it holds them to the organization's and reports the captions it was just given as missing. And the app
          // folder, from which a web resource's `contentPath` is read to compare its deployed content (verify-spec.js, the web-resource check).
          // And the managed bindings the same workspace holds, read afresh after the build, exactly as the standalone verify reads them
          // (verify-model-app.js): a bound view or chart is held to its bound id, a bound declared form, dashboard, business rule or
          // business process flow to its declaration and last proof, and a pending or unusable group is listed as unverified.
          const managedManifest = spec.solution && spec.solution.uniqueName
            ? readVerifyManifest({ workspaceDir: applyWorkspaceOf(opts), environment: opts.env, appUniqueName: appUniqueName(spec), solutionUniqueName: spec.solution.uniqueName })
            : undefined;
          const vr = await deps.verify(spec, { environmentSkipped: r.skipped, phases: opts.phases, baselineSpec: opts.baselineSpec, languageCode: opts.languageCode, preResolvedLanguageCode: opts.preResolvedLanguageCode, appDir: opts.appDir, configurationBindings: opts.configurationBindings, managedManifest });
          const present = vr.checks.length - vr.missing.length;
          log(`\n${vr.ok ? '✓ verify PASS' : `✗ verify FAIL — ${vr.missing.length} missing`} (${present}/${vr.checks.length} present)`);
          // Named explicitly rather than folded into the pass, so a green verify never reads as
          // "everything the spec asked for is deployed" when part of it could not be. Two distinct
          // causes get two distinct messages: telling an operator on a HEALTHY environment that it
          // cannot host business rules — which is what a single shared message did on every
          // `--changed-only` fast apply — is worse than saying nothing.
          if (vr.environmentSkipped && vr.environmentSkipped.length) {
            log(`  ⊘ ${vr.environmentSkipped.length} check(s) not applicable on this environment: ${vr.environmentSkipped.join(', ')}`);
          }
          if (vr.phaseSkipped && vr.phaseSkipped.length) {
            log(`  ⊘ ${vr.phaseSkipped.length} check(s) not verified because their phase did not run in this build: ${vr.phaseSkipped.join(', ')}`);
          }
          // A check verify could not DECIDE is neither of those and neither a pass nor a failure: named beside the PASS, with its reason, so a
          // green verify never reads as "everything the spec declares is deployed" while a label was not compared.
          if (vr.unverified && vr.unverified.length) {
            log(`  ⊘ ${vr.unverified.length} check${vr.unverified.length === 1 ? '' : 's'} could not be verified — ${vr.unverified.length === 1 ? 'it is' : 'they are'} neither passed nor failed:`);
            for (const u of vr.unverified) log(`      ⊘ ${u}`);
          }
          // Include `detail` on a failure so a READ that failed (throttling, auth expiry, a 5xx) is
          // not reported identically to an artifact that is genuinely absent.
          if (!vr.ok) for (const m of vr.missing) log(`  ✗ ${m.kind}: ${m.name}${m.detail ? ` — ${m.detail}` : ''}`);
          // Propagate unableToRun from verifySpec: verifySpec itself sets
          // unableToRun when the reader lacks pages/pageCode methods. Only include the property
          // when truthy so existing callers using deepStrictEqual are not affected on the normal path.
          r.verify = { ok: vr.ok, present, total: vr.checks.length, missing: vr.missing.map((m) => `${m.kind}:${m.name}${m.detail ? ` (${m.detail})` : ''}`), ...(vr.unableToRun ? { unableToRun: true } : {}), ...(vr.environmentSkipped && vr.environmentSkipped.length ? { environmentSkipped: vr.environmentSkipped } : {}), ...(vr.phaseSkipped && vr.phaseSkipped.length ? { phaseSkipped: vr.phaseSkipped } : {}), ...(vr.unverified && vr.unverified.length ? { unverified: vr.unverified } : {}) };
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
  if (opts.apply && r && r.ok && !r.dryRun && (!r.verify || r.verify.ok) && opts.workspaceDir) {
    const kept = (((r.skipped || {}).unauthorizedRemovals) || []);
    if (kept.length) {
      const record = currentDestructiveApproval || { formRemovals: {}, sitemapRemovals: [] };
      const names = kept.map((x) => `${x.form || x.formId || 'form'}:${x.field}`).join(', ');
      try {
        const lock = await recordApproval(record, { ifOurs: true });
        if (!lock.locked) {
          log(`\n⚠ kept unauthorized form removal(s) (${names}), but could not lock the workspace to record them (${lock.reason}).`);
        } else if (lock.value === 'unreadable') {
          log(`\n⚠ kept unauthorized form removal(s) (${names}), but ${DESTRUCTIVE_APPROVAL_FILE} could not be read, so it was left as it is.`);
        } else if (lock.value === 'foreign') {
          // That build's list binds its own approval; any kept field it does not name is still new to it.
          log(`\n⚠ kept unauthorized form removal(s) (${names}); ${DESTRUCTIVE_APPROVAL_FILE} was written by another build since this one started, so it was left as it is.`);
        } else {
          log(`\n⚠ kept unauthorized form removal(s) (${names}); ${DESTRUCTIVE_APPROVAL_FILE} was left for review, so the next run will ask about them before removing anything.`);
        }
      } catch (err) {
        log(`\n⚠ kept unauthorized form removal(s), but could not write ${DESTRUCTIVE_APPROVAL_FILE}: ${(err && err.message) || err}`);
      }
    } else if (runsRemovalPhases) {
      try {
        const lock = await withApprovalLease(() => {
          const owner = approvalOwnership(approvalFingerprint(opts.workspaceDir));
          if (owner !== 'ours') return owner;
          deleteApprovalRecord(opts.workspaceDir);
          return 'deleted';
        });
        if (!lock.locked) log(`\n⚠ could not lock the workspace to consume ${DESTRUCTIVE_APPROVAL_FILE} (${lock.reason}); it was left, so the next run may ask about its removals again.`);
        else if (lock.value === 'unreadable') log(`\n⚠ left ${DESTRUCTIVE_APPROVAL_FILE}: it could not be read, so this build cannot tell whose it is.`);
        else if (lock.value === 'foreign') log(`\n⚠ left ${DESTRUCTIVE_APPROVAL_FILE}: another build wrote it after this one started.`);
      } catch (err) { log(`\n⚠ could not delete ${DESTRUCTIVE_APPROVAL_FILE}: ${(err && err.message) || err}`); }
    }
  }
  // Attach non-blocking validation advisories to the result JSON so programmatic callers see them too
  // (they were already narrated via `log` above). Never overrides an error result's shape.
  if (r && typeof r === 'object' && (v.warnings || []).length) r.warnings = v.warnings;
  return r;
}

// What `--preview-push` found (lib/push-preview.js runPushPreview's result), printed under the dry-run summary.
// Codes, keys, counts and the helper's own fixed words only: a refusal or a warning carries no SDK message in the
// result (it can quote a record value), and a failure's `error` is already reduced to its code, HTTP status and
// fixed words (readonly-operations.js findingOf). Every item the preview did not answer is printed, by its reason,
// and a preview that did not answer them all says so — it must never read as covering the plan when it does not.
const PREVIEW_REASON_WORDS = Object.freeze({
  noTypedTarget: 'the build has no typed change for it to preview',
  livePlanUnknown: 'its live state could not be read',
  notInBatch: 'the batch preview did not answer it (no local edit), so it was not previewed',
});
function printPushPreview(p, log) {
  const codes = (list) => (list || []).map((f) => (f && f.code) || '?').join(', ');
  const s = p.summary;
  log(s
    ? `\n▢ push preview — ${s.ready || 0} ready, ${s.refused || 0} refused, ${s.unknown || 0} unknown, ${s.requiresSchema || 0} schema step(s), ${s.notPrepared || 0} not prepared, ${s.notEvaluated || 0} not evaluated`
    : '\n▢ push preview');
  for (const pv of p.previews || []) {
    if (pv.outcome === 'ready') continue;
    const found = [codes(pv.refusals) && `refused: ${codes(pv.refusals)}`, codes(pv.warnings) && `warnings: ${codes(pv.warnings)}`].filter(Boolean).join('; ');
    log(`  ? ${pv.key} — ${pv.outcome}${found ? ` (${found})` : ''}`);
  }
  for (const np of p.notPrepared || []) {
    log(`  ? ${np.key} — not prepared: ${np.code || 'PREVIEW_FAILED'}${np.statusCode ? ` (HTTP ${np.statusCode})` : ''}${np.message ? ` — ${np.message}` : ''}`);
  }
  for (const ne of p.notEvaluated || []) {
    log(`  ? ${ne.key} — not evaluated: ${ne.reason}${PREVIEW_REASON_WORDS[ne.reason] ? ` (${PREVIEW_REASON_WORDS[ne.reason]})` : ''}`);
  }
  if (p.error) log(`  ✗ push preview failed: ${p.error.code || 'PREVIEW_FAILED'}${p.error.statusCode ? ` (HTTP ${p.error.statusCode})` : ''}${p.error.message ? ` — ${p.error.message}` : ''}`);
  if (p.writeAttempts > 0) log(`  ✗ ${p.writeAttempts} write request(s) were attempted and refused before sending: this preview is not trustworthy`);
  if (p.allEvaluated !== true) log('  the preview did not evaluate every planned change; see the items above');
  if (p.disclaimer) log(`  ${p.disclaimer}`);
}

// A failure is transient (safe to auto-retry, since the build is idempotent) when the SERVICE said so, by the
// structure of its answer: the HTTP status it answered (429, 502, 503, 504), a timeout or a reset of the
// transport, or a condition it names by the `error.code` of its answer (a customization or solution lock, SQL
// giving up waiting, a concurrent request on the same record, a SQL deadlock victim — the generic SQL error code
// with the platform's deadlock signature in the service's own answer — the lag of a column the spec creates). A
// status that is not one of those — a 403, a 404, a 400, a 500 — is final, whatever the answer says: an answer
// echoes what the maker named, and "SQL Timeout Reader" is a legal name for a view, a role, a persona, a flow,
// a page, and — `contoso_customizationlockexception` — a table. Only a failure that carries no HTTP status at
// all (a plain error, the words a helper reported by value) is read by the service's own words as a fallback:
// customization lock, concurrent-op guard, SQL timeout, "try again later". What the build or the maker named
// is never read: a halt's message quotes views, roles, personas, flows, pages, paths and the workspace's
// folder. So the decision is made from the STRUCTURE of the failure first, and the plugin's own text is out of
// it — lib/retry-policy.js holds the rule (`judgeFailure`), and tests/halt-retry-policy.test.js holds every
// halt the build raises to a policy of its own. A failure that says it must not be retried (`transient: false`
// anywhere along its causes) or that the SDK or the plugin types as a refusal (VALIDATION_ERROR,
// VERSION_CONFLICT, a file system error) is never retried, whatever it quotes.
// NOTE: the engine's `recoverable` flag means "re-runnable phase", NOT "transient error", so it is
// deliberately NOT used here.
//
// `spec` (optional) enables the one condition that depends on what the build itself creates — the lag of a
// column the spec declares (see MISSING_ATTRIBUTE_CODES in lib/retry-policy.js). Without it that condition never
// fires, so a caller that passes no spec gets exactly the classification it always had.
function isTransientHalt(err, { spec } = {}) {
  if (!err) return false;
  // A dashboard the build could neither add to its solution nor remove again says `transient: false`
  // (sdk-build.js): its message quotes the causes verbatim — a customization lock, "try again later" —
  // but the add and its undo were both refused just now, which is a person's to look at, and a dashboard
  // the build could not record (lib/dashboard-creation-records.js) would be found by a retry as a lone name
  // match and reused outside the solution, the state the undo exists to prevent. One it recorded is added by
  // the maker's next run. `never` is that, and the typed refusals, and a status that says no.
  const judgement = judgeFailure(err, spec ? { declares: (table, column) => specDeclaresAttribute(spec, table, column) } : {});
  if (judgement.never) return false;
  if (judgement.transient) return true;
  // Here the failure carries no HTTP status at all. `text` is only what the service said — a halt's own
  // message, and what an error says of its url, are not in it — unless an error declares its own words
  // (`retryText`), and then those alone are.
  const msg = judgement.text;
  return (
    /CustomizationLockException|another solution (install|removal)|try again later|SQL timeout|concurrent [dD]elete/i.test(msg) ||
    // A SQL deadlock victim was rolled back, so the idempotent build can simply run again — the same
    // footing as the "SQL timeout" above, with a less ambiguous outcome (see SQL_DEADLOCK_VICTIM).
    SQL_DEADLOCK_VICTIM.test(msg)
  );
}

// Exponential backoff with jitter: ~3s, 6s, 12s (capped at 30s).
function backoffMs(attempt) {
  return Math.min(30000, 3000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 1000);
}

function list(v) {
  return typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
}

// Read the language flag from either spelling, rejecting a conflicting pair rather than silently
// preferring one.
const readLanguageFlag = (flags) => readAliasedFlag(flags, 'language-code', 'languageCode');

// `--authorize <key>`, repeatable, consents to ONE destructive schema change the spec declares, and to nothing else:
//   dateTimeBehavior:<table>.<column>   a one-way Date and Time behaviour change of a column the table already has
//   isSecured:<table>.<column>          unsecuring a secured column, which deletes every permission any profile holds on it
//   tableFlags:<table>                  turning duplicate detection off, which unpublishes the table's duplicate rules
// and to ONE approval a declared view, chart or Quick Find view asks for, named by the artifact's family and id:
//   adopt:view:<table>/<name>           taking over an existing view of that name the spec (reconcile: "declared") has not managed
//   adopt:chart:<table>/<name>          the same for a declared chart (lib/view-reconcile.js, lib/chart-reconcile.js)
//   overwrite:view:<table>/<name>       replacing the changes made on the server since the build last wrote it, or a local copy
//   overwrite:chart:<table>/<name>      that differs from the server's (sdk-build.js, refuseUnsentCopy)
//   overwrite:quickfind:<table>         replacing a local copy of a table's Quick Find view (entities[].quickFind) that differs
//                                       from the server's; a Quick Find view is never adopted and has no server drift
// The family is part of the key because ids collide across families: a view and a chart may share <table>/<name>, and a view
// may be named "quickFind". Each approval is stored under its family-typed id (reconcile-common.js approvalKey, the flag minus
// its verb) and each guard asks only for its own family, so consent to one artifact never reaches another. The untyped form
// adopt:<table>/<name> / overwrite:<table>/<name> is still read when it names exactly one declared artifact — a view, a chart, or
// (overwrite:<table>/quickFind) a table's Quick Find view; one that could mean several, such as a view and a chart of one name or a
// view named "quickFind" on a table that declares quickFind, is refused, before any write, with the typed keys it could mean. Every refusal prints its artifact's typed key.
// The two approvals are separate Sets (opts.authorizedAdoption, opts.authorizedOverwrite), so consent to one is never consent to the
// other or to a destructive schema change.
// A declared business rule (businessRules[].reconcile "declared", lib/rule-settlement.js) takes adopt only, by its table and name:
//   adopt:rule:<table>/<name>           binding an existing rule of that name whole, or re-adopting one changed outside the spec
// (the untyped adopt:<table>/<name> reads it too when it names nothing else). A rule is never overwritten by an approval.
// A declared business process flow (businessProcessFlows[].reconcile "declared", lib/bpf-settlement.js) likewise, adopt only:
//   adopt:bpf:<table>/<name>            binding an existing flow of that name whole, or re-adopting one changed outside the spec
// and to ONE approval a declared web resource (reconcile: "declared", lib/web-resource-reconcile.js) asks for, by its whole name:
//   adopt:webresource:<name>            writing the spec's content to an existing web resource the spec has not managed before
//   overwrite:webresource:<name>        replacing content changed on the server since the build last wrote it
// A web resource's approvals are typed too and kept in Sets of their own (opts.authorizedWebResourceAdoption,
// opts.authorizedWebResourceOverwrite): its name may hold '/', so `contoso_case/script` can be both a view's id and a web resource's
// name, and no view, chart or untyped key ever approves a web resource.
// and to the maker's acceptance of ONE managed publish whose answer was lost and that no fresh read can settle:
//   publication-risk:table:<table>/<dispatch>    accepting that the lost publish <dispatch> of the table may still complete
//   publication-risk:dashboard:<id>/<dispatch>  (managed-bindings.js acceptUncertainPublication); the same for a dashboard
// The dispatch is part of the key, exactly as the stop printed it, so a key printed for one lost publish never accepts a later
// one of the same scope. It is recorded only as the run's store opens, before any write, for the unconfirmed publication the
// store then holds under exactly that scope and dispatch (acceptPublicationRiskAtStart); that run still stops, and the next run
// publishes after the usual checks. A key that matches none is reported unused and grants nothing later in the run (a stop of
// the same run only prints the key for the next one, offerPublicationRisk). No other key implies it.
// It is deliberately not implied by --allow-destructive: that flag approves the form and sitemap removals the build lists, and a
// consent to delete security or to convert stored dates must name the column it is for. The build's refusal of such a change names
// the exact key, so the maker reads what will happen, then runs the build again with it. A key is refused unless the spec declares
// the change it consents to, so a stale or mistyped key cannot authorize something else later. Table and column names are matched
// case-insensitively, as the build matches them; a view or chart name is matched exactly, as the reconcile keys it.
// parseArgs keeps only the last value of a repeated flag, so the keys are read from argv.
function authorizationKeys(argv, spec) {
  const raw = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--authorize') { raw.push(argv[i + 1]); i += 1; } else if (typeof a === 'string' && a.startsWith('--authorize=')) raw.push(a.slice('--authorize='.length));
  }
  const lower = (s) => String(s || '').toLowerCase();
  // The configuration kinds' tokens, <kind>:<declared key>:<field> (e.g. connectionReference:contoso_sp:connectionId, environmentVariableValue:contoso_ApiKey:value),
  // are claimed first and checked against the spec by their own grammar (lib/configuration-artifacts.js); every other token is read below exactly as before.
  // No operating system can pass NUL in a process argument (Node's spawnSync throws ERR_INVALID_ARG_VALUE), so a key holding one can never be pasted
  // back as the one argument a hint asks for; it is refused by name here rather than read as a view or chart name by the patterns below.
  const hasNul = (k) => typeof k === 'string' && k.includes('\u0000');
  const nulKeys = raw.filter(hasNul);
  const configuration = configurationAuthorizationKeys(raw.filter((k) => !hasNul(k)), spec);
  const keys = new Set(configuration.keys);
  const adopt = new Set();
  const overwrite = new Set();
  const problems = nulKeys.map((key) => `'${key.replace(/\u0000/g, '\\u0000')}' holds a NUL character (U+0000), which a command-line argument cannot carry; give the item a name without it`).concat(configuration.problems.map(({ token, code }) => (code === 'CONFIGURATION_AUTHORIZATION_UNKNOWN_ITEM'
    ? `'${token}' names a configuration item the spec does not declare`
    : `'${token}' is not <kind>:<declared key>:<field> for a field a configuration change can consent to`)));
  // The ids each approval family's artifacts carry in this spec. A view's or chart's is the reconcile's intent key, `<table>/<name>`
  // with the table in lower case (a spec whose declared artifact does not compile fails validation before any key is used); a Quick
  // Find view's (entities[].quickFind, lib/quick-find.js) is its table, in lower case.
  // A declared form's (forms[].reconcile "declared", lib/form-layout-reconcile.js) is its layout key, `<table>/<form type>/<name>`,
  // all in lower case (formLayoutKey); only while the declared form build is on (lib/declared-features.js), as validation allows it.
  const declared = { view: new Set(), chart: new Set(), quickfind: new Set(), form: new Set() };
  if (declaredFeatureOn('forms')) {
    for (const f of (spec && Array.isArray(spec.forms) ? spec.forms : [])) if (isDeclaredForm(f)) declared.form.add(formLayoutKey(f));
  }
  // A declared dashboard's (dashboards[].reconcile "declared", lib/dashboard-reconcile.js) is its key as the helper spells it
  // (dashboardKey: its `key`, or its name in lower case), and each of its tiles' is `<key>/<tile key>`; only while the declared
  // dashboard build is on. The helper matches approvals exactly, so a key typed in any case is mapped back to that spelling here
  // (validation refuses two declared dashboards whose keys differ only in case, and two tiles of one dashboard alike).
  //   dashboards: Map(lower key -> { key, tiles: Map(lower tile key -> '<key>/<tile key>') })
  const dashboards = new Map();
  if (declaredFeatureOn('dashboards')) {
    for (const d of (spec && Array.isArray(spec.dashboards) ? spec.dashboards : [])) {
      if (!isDeclaredDashboard(d)) continue;
      const key = dashboardKey(d);
      const tiles = new Map();
      for (const t of (Array.isArray(d.tiles) ? d.tiles : [])) if (t && typeof t.key === 'string' && t.key) tiles.set(lower(t.key), `${key}/${t.key}`);
      if (key) dashboards.set(lower(key), { key, tiles });
    }
  }
  // The declared dashboard or tile `text` names: { root: true, id } for a dashboard, { root: false, id } for one tile, or null.
  // A dashboard key never holds '/' (validation), so only the last '/' can split a tile key off; both readings are still tried,
  // and a text that could be either is refused by the caller as ambiguous.
  const dashboardTargets = (text) => {
    const out = [];
    const root = dashboards.get(lower(text));
    if (root) out.push({ root: true, id: root.key });
    const cut = String(text).lastIndexOf('/');
    if (cut > 0) {
      const owner = dashboards.get(lower(String(text).slice(0, cut)));
      const tile = owner && owner.tiles.get(lower(String(text).slice(cut + 1)));
      if (tile) out.push({ root: false, id: tile });
    }
    return out;
  };
  // A declared business rule's (businessRules[].reconcile "declared", lib/rule-settlement.js) and a declared business process flow's
  // (businessProcessFlows[].reconcile "declared", lib/bpf-settlement.js bpfKey) approval id is `<table>/<name>`, the
  // table in lower case and the name as written: the helper's approval id, whatever `key` the rule or flow has. Only while that
  // feature's declared build is on. The helpers match approvals exactly, so a key typed in any case is mapped back to that spelling here
  // (validation refuses two declared rules, or two flows, on one table whose names differ only in case). A rule or flow is adopted whole
  // and never overwritten by an approval, so it takes adopt only. `reconcile === 'declared'` is isDeclaredRule / isDeclaredBpf, inlined:
  // those helpers load the creates catalog, which a default build must not reach (tests/creates-port.test.js).
  //   workflows.rule, workflows.bpf: Map(lower id -> id)
  const workflows = { rule: new Map(), bpf: new Map() };
  const workflowNoun = { rule: 'business rule', bpf: 'business process flow' };
  if (declaredFeatureOn('rules')) {
    for (const r of (spec && Array.isArray(spec.businessRules) ? spec.businessRules : [])) {
      if (r && r.reconcile === 'declared' && typeof r.entity === 'string' && typeof r.name === 'string') workflows.rule.set(lower(`${r.entity}/${r.name}`), `${lower(r.entity)}/${r.name}`);
    }
  }
  if (declaredFeatureOn('bpf')) {
    for (const f of (spec && Array.isArray(spec.businessProcessFlows) ? spec.businessProcessFlows : [])) {
      if (f && f.reconcile === 'declared' && typeof f.entity === 'string' && typeof f.name === 'string') workflows.bpf.set(lower(`${f.entity}/${f.name}`), `${lower(f.entity)}/${f.name}`);
    }
  }
  // Why `verb` cannot approve the declared workflow `id` of `family`, or null when it can: only adopt binds one.
  const workflowVerbProblem = (key, verb, family, id) => (verb === 'adopt' ? null
    : `'${key}' is not an approval a declared ${workflowNoun[family]} takes: it is adopted whole, never overwritten by an approval (use adopt:${approvalKey(family, id)} with a declaration that names its whole current body)`);
  for (const v of (spec && Array.isArray(spec.views) ? spec.views : [])) {
    if (isDeclaredView(v)) { const { intent } = compileViewIntent(v); if (intent) declared.view.add(intent.key); }
  }
  for (const ch of (spec && Array.isArray(spec.charts) ? spec.charts : [])) {
    if (isDeclaredChart(ch)) { const { intent } = compileChartIntent(ch); if (intent) declared.chart.add(intent.key); }
  }
  for (const e of (spec && Array.isArray(spec.entities) ? spec.entities : [])) {
    if (e && e.quickFind && typeof e.schemaName === 'string') declared.quickfind.add(lower(e.schemaName));
  }
  // A declared web resource's key is its name, lower-cased, as lib/web-resource-reconcile.js keys it. Validation refuses a declared
  // web resource whose name another entry shares, letter case aside (app-spec.js); each key still counts the declared resources it
  // would name, so this parser is safe on its own.
  const webResourceAdopt = new Set();
  const webResourceOverwrite = new Set();
  const declaredWebResources = new Map();
  for (const wr of (spec && Array.isArray(spec.webResources) ? spec.webResources : [])) {
    if (isDeclaredWebResource(wr) && typeof wr.name === 'string') declaredWebResources.set(lower(wr.name), (declaredWebResources.get(lower(wr.name)) || 0) + 1);
  }
  // An untyped key that spells a declared web resource's name is not that resource's approval. Its own branch below refuses it or
  // keeps it for the view or chart it names; when it is refused, the refusal also says which typed key the maker meant.
  const webResourceHints = [];
  // One entry per approval family: the verbs it takes, how its id is read from the key (null: not an id of this family), and what
  // the spec must declare for the key to approve anything. A new family is one more entry (a web resource's approvals are read in the
  // loop first, into Sets of their own).
  // <table>/<name>: the name may hold spaces, ':' and '/', so only the first '/' splits.
  const tableAndName = (text) => { const m = /^([A-Za-z0-9_]+)\/(.+)$/.exec(text); return m ? `${lower(m[1])}/${m[2]}` : null; };
  const families = {
    view: { verbs: ['adopt', 'overwrite'], id: tableAndName, needs: 'a view with reconcile: "declared"' },
    chart: { verbs: ['adopt', 'overwrite'], id: tableAndName, needs: 'a chart with reconcile: "declared"' },
    quickfind: { verbs: ['overwrite'], id: (text) => (/^[A-Za-z0-9_]+$/.test(text) ? lower(text) : null), needs: 'a table that declares quickFind' },
    // <table>/<form type>/<name>, matched in any case: the form's key is lower case throughout (formLayoutKey), as the build matches forms.
    form: { verbs: ['adopt', 'overwrite'], id: (text) => (/^[A-Za-z0-9_]+\/[A-Za-z]+\/.+$/.test(text) ? lower(text) : null), needs: 'a form with reconcile: "declared"' },
  };
  const approve = (verb, family, id) => (verb === 'adopt' ? adopt : overwrite).add(approvalKey(family, id));
  // publication-risk:table:<table>/<dispatch> | publication-risk:dashboard:<id>/<dispatch> — the maker accepts the risk of the managed publish whose
  // answer was lost and that no fresh read can settle (managed-bindings.js acceptUncertainPublication). Kept in a Set of its
  // own, in the store's spelling (publicationRiskApproval), and never implied by any other key: the build accepts only the
  // approval an unconfirmed publication the store holds as the run starts carries, with its own scope and dispatch token
  // (acceptPublicationRiskAtStart). The scope is matched in any case, as the build names tables and dashboards; the dispatch
  // token is taken exactly as the stop printed it (a UUID; no white space, no '/'). A key with no dispatch is refused: a
  // decision about a scope alone could reach a publish of it the maker never saw.
  const publicationRisk = new Set();
  for (const key of configuration.unclaimed) {
    const risk = /^publication-risk:(table|dashboard):(.+)$/.exec(String(key));
    if (risk) {
      const parts = /^([^/]+)\/([^\s/]{1,128})$/.exec(risk[2]);
      const scope = !parts ? null : risk[1] === 'table' ? { type: 'table', table: lower(parts[1]) } : { type: 'dashboard', id: lower(parts[1]).replace(/^\{|\}$/g, '') };
      const ok = !!scope && (scope.type === 'table' ? /^[a-z0-9_]+$/.test(scope.table) : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope.id));
      if (ok) publicationRisk.add(publicationRiskApproval(scope, parts[2]));
      else problems.push(`'${key}' is not publication-risk:table:<table>/<dispatch> or publication-risk:dashboard:<dashboard id>/<dispatch> (give the whole approval the stop printed: it names the lost publish it accepts)`);
      continue;
    }
    // adopt:webresource:new_/scripts/case.js | overwrite:webresource:new_casebanner — a declared web resource, by its whole name (any case).
    const resource = /^(adopt|overwrite):webresource:(.+)$/.exec(String(key));
    if (resource) {
      const named = declaredWebResources.get(lower(resource[2])) || 0;
      if (named === 1) (resource[1] === 'adopt' ? webResourceAdopt : webResourceOverwrite).add(lower(resource[2]));
      else if (named > 1) problems.push(`'${key}' names ${named} declared web resources that differ only in case, so it cannot say which one it approves (rename one of them)`);
      else problems.push(`'${key}' approves a web resource the spec does not declare with reconcile: "declared" (${lower(resource[2])})`);
      continue;
    }
    const spelled = /^(adopt|overwrite):(.+)$/.exec(String(key));
    if (spelled && declaredWebResources.has(lower(spelled[2]))) webResourceHints.push({ key: String(key), hint: `use ${spelled[1]}:webresource:${spelled[2]} for the declared web resource of that name` });
    const text = String(key);
    // adopt:dashboard:operations | overwrite:dashboard:operations | overwrite:dashboard:operations/open-orders — a declared
    // dashboard by its key, or one of its tiles by `<key>/<tile key>`, in any case. Only the dashboard takes adopt: the
    // dashboard is bound whole, so a tile has nothing to adopt on its own.
    const typedDashboard = /^(adopt|overwrite):dashboard:(.+)$/.exec(text);
    if (typedDashboard) {
      const [, verb, idText] = typedDashboard;
      const targets = dashboardTargets(idText);
      if (targets.length > 1) problems.push(`'${key}' could name the declared dashboard ${targets[0].id} or the tile ${targets[1].id}; give that dashboard a key without '/'`);
      else if (!targets.length) problems.push(`'${key}' approves an artifact the spec does not declare (it would need a dashboard with reconcile: "declared" keyed ${idText}, or a tile <key>/<tile key> of one)`);
      else if (verb === 'adopt' && !targets[0].root) problems.push(`'${key}' is not an approval a dashboard tile takes (a tile takes only overwrite:dashboard:<key>/<tile key>; adopt:dashboard:<key> binds the whole dashboard)`);
      else approve(verb, 'dashboard', targets[0].id);
      continue;
    }
    // adopt:rule:account/Require Email | adopt:bpf:account/Onboarding — a declared business rule or process flow by its table and
    // name, in any case.
    const typedWorkflow = /^(adopt|overwrite):(rule|bpf):(.+)$/.exec(text);
    if (typedWorkflow) {
      const [, verb, family, idText] = typedWorkflow;
      const id = workflows[family].get(lower(idText));
      if (!id) problems.push(`'${key}' approves an artifact the spec does not declare (it would need a ${workflowNoun[family]} with reconcile: "declared" named ${idText}, as <table>/<name>)`);
      else if (workflowVerbProblem(key, verb, family, id)) problems.push(workflowVerbProblem(key, verb, family, id));
      else approve(verb, family, id);
      continue;
    }
    // overwrite:quickfind:contoso_item | adopt:view:account/My Accounts | overwrite:chart:new_ticket/By Status
    const typed = /^(adopt|overwrite):([a-z]+):(.*)$/.exec(text);
    if (typed && Object.prototype.hasOwnProperty.call(families, typed[2])) {
      const [, verb, family, idText] = typed;
      const fam = families[family];
      const id = fam.id(idText);
      if (!fam.verbs.includes(verb)) problems.push(`'${key}' is not an approval a ${family} takes (it takes only ${fam.verbs.map((v) => `${v}:${family}:<id>`).join(' or ')})`);
      else if (id === null || !declared[family].has(id)) problems.push(`'${key}' approves an artifact the spec does not declare (it would need ${fam.needs}${id === null ? '' : ` with the id ${id}`})`);
      else approve(verb, family, id);
      continue;
    }
    // The untyped form, adopt:account/My Accounts | overwrite:new_ticket/Open Tickets: whichever single declared view, chart or form it
    // names. Candidates are found case-folded on both table and name, so two artifacts whose names differ only in case are both
    // candidates and the key is refused as ambiguous; a single view or chart candidate is still approved only on an exact name match,
    // as before (a form's key is lower case throughout, so it has no other spelling to match exactly).
    const untyped = /^(adopt|overwrite):([A-Za-z0-9_]+)\/(.+)$/.exec(text);
    if (untyped) {
      const verb = untyped[1];
      const wanted = `${lower(untyped[2])}/${untyped[3]}`;
      const candidates = [];
      for (const family of ['view', 'chart']) {
        for (const id of declared[family]) if (lower(id) === lower(wanted)) candidates.push({ family, id });
      }
      // A declared form's key has the same <table>/... shape (`<table>/<form type>/<name>`), so an untyped key may name one; its
      // key is lower case, so it matches in any case. It is one more candidate: a key that could also be a view or chart is refused.
      for (const id of declared.form) if (id === lower(wanted)) candidates.push({ family: 'form', id });
      // A declared dashboard's tile key, `<key>/<tile key>`, has the same shape too (a dashboard key may be a bare word): one more
      // candidate, matched in any case and approved in the helper's own spelling.
      for (const t of dashboardTargets(`${untyped[2]}/${untyped[3]}`)) candidates.push({ family: 'dashboard', id: t.id, root: t.root });
      // A declared business rule's or process flow's id is `<table>/<name>` too: one more candidate each, matched in any case and approved
    // in the helper's spelling.
      for (const family of Object.keys(workflows)) {
        const id = workflows[family].get(lower(`${untyped[2]}/${untyped[3]}`));
        if (id) candidates.push({ family, id });
      }
      // A table's Quick Find view is a view too, and takes an overwrite: an overwrite whose name is "quickFind" on a table that
      // declares quickFind might mean it. It is one more candidate: alone, overwrite:<table>/quickFind (that exact name) means it.
      const table = lower(untyped[2]);
      const quickFindToo = verb === 'overwrite' && lower(untyped[3]) === 'quickfind' && declared.quickfind.has(table);
      if (candidates.length + (quickFindToo ? 1 : 0) > 1) {
        const typedKeys = candidates.map((c) => `${verb}:${approvalKey(c.family, c.id)}`);
        if (quickFindToo) typedKeys.push(`overwrite:${approvalKey('quickfind', table)}`);
        problems.push(`'${key}' could approve more than one declared artifact; name the one you mean with its typed key: ${typedKeys.join(' or ')}`);
      } else if (candidates.length === 1 && candidates[0].family === 'dashboard' && !candidates[0].root && verb === 'adopt') {
        problems.push(`'${key}' names the tile ${candidates[0].id} of a declared dashboard, which takes only overwrite:dashboard:${candidates[0].id} (adopt:dashboard:<key> binds the whole dashboard)`);
      } else if (candidates.length === 1 && workflows[candidates[0].family] && workflowVerbProblem(key, verb, candidates[0].family, candidates[0].id)) {
        problems.push(workflowVerbProblem(key, verb, candidates[0].family, candidates[0].id));
      } else if (candidates.length === 1 && (candidates[0].family === 'form' || candidates[0].family === 'dashboard' || workflows[candidates[0].family] || candidates[0].id === wanted)) {
        approve(verb, candidates[0].family, candidates[0].id);
      } else if (quickFindToo && candidates.length === 0 && untyped[3] === 'quickFind') {
        approve(verb, 'quickfind', table);
      } else if (quickFindToo) {
        problems.push(`'${key}' does not name a declared view or chart; to replace the local copy of ${table}'s Quick Find view use overwrite:${approvalKey('quickfind', table)}`);
      } else {
        const others = [declared.form.size ? 'a form' : '', dashboards.size ? 'a dashboard tile' : '', ...Object.keys(workflows).map((f) => (workflows[f].size ? `a ${workflowNoun[f]}` : ''))].filter(Boolean);
        problems.push(`'${key}' approves an artifact the spec does not declare (it would need a view or chart${others.length ? `, or ${others.join(' or ')},` : ''} with reconcile: "declared" keyed ${wanted})`);
      }
      continue;
    }
    // The untyped dashboard, adopt:operations | overwrite:operations | overwrite:ops-board/map: a declared dashboard's key alone, or
    // a tile key the branch above could not read (a dashboard key may hold '.' or '-'), in any case. A declared web resource of the
    // same name makes it ambiguous.
    const bareDashboard = /^(adopt|overwrite):(.+)$/.exec(text);
    const bareTargets = bareDashboard ? dashboardTargets(bareDashboard[2]) : [];
    if (bareTargets.length) {
      const [, verb, idText] = bareDashboard;
      if (bareTargets.length > 1) problems.push(`'${key}' could name the declared dashboard ${bareTargets[0].id} or the tile ${bareTargets[1].id}; give that dashboard a key without '/'`);
      else if (declaredWebResources.has(lower(idText))) problems.push(`'${key}' could approve more than one declared artifact; name the one you mean with its typed key: ${verb}:dashboard:${bareTargets[0].id} or ${verb}:webresource:${idText}`);
      else if (verb === 'adopt' && !bareTargets[0].root) problems.push(`'${key}' names the tile ${bareTargets[0].id} of a declared dashboard, which takes only overwrite:dashboard:${bareTargets[0].id} (adopt:dashboard:<key> binds the whole dashboard)`);
      else approve(verb, 'dashboard', bareTargets[0].id);
      continue;
    }
    // dateTimeBehavior:new_ticket.new_due | isSecured:new_ticket.new_salary | tableFlags:new_ticket
    const m = /^(dateTimeBehavior|isSecured):([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$|^(tableFlags):([A-Za-z0-9_]+)$/.exec(String(key));
    if (!m) { problems.push(`'${key}' is not dateTimeBehavior:<table>.<column>, isSecured:<table>.<column> or tableFlags:<table> (nor adopt:view:<table>/<name>, overwrite:view:<table>/<name>, the same for chart:, adopt:form:<table>/<form type>/<name>, overwrite:form:<table>/<form type>/<name>, adopt:dashboard:<key>, overwrite:dashboard:<key>, overwrite:dashboard:<key>/<tile>, adopt:rule:<table>/<name>, adopt:bpf:<table>/<name>, overwrite:quickfind:<table>, adopt:webresource:<name>, overwrite:webresource:<name>, publication-risk:table:<table>/<dispatch> or publication-risk:dashboard:<dashboard id>/<dispatch>)`); continue; }
    const kind = m[1] || m[4];
    const table = lower(m[2] || m[5]);
    const entity = ((spec && spec.entities) || []).find((e) => lower(e && e.schemaName) === table);
    const column = m[3] ? (((entity && entity.columns) || []).find((c) => lower(c && c.schemaName) === lower(m[3]))) : null;
    const declares = kind === 'tableFlags' ? !!entity && entity.duplicateDetectionEnabled === false
      : kind === 'isSecured' ? !!column && column.isSecured === false
        : !!column && column.type === 'DateTime' && column.dateTimeBehavior !== undefined;
    if (!declares) {
      const what = kind === 'tableFlags' ? `duplicateDetectionEnabled: false on table ${table}` : kind === 'isSecured' ? `isSecured: false on column ${table}.${lower(m[3])}` : `a dateTimeBehavior on the DateTime column ${table}.${lower(m[3])}`;
      problems.push(`'${key}' consents to a change the spec does not declare (it would need ${what})`);
      continue;
    }
    keys.add(kind === 'tableFlags' ? `tableFlags:${table}` : `${kind}:${table}.${lower(m[3])}`);
  }
  for (const { key, hint } of webResourceHints) {
    const i = problems.findIndex((p) => p.startsWith(`'${key}' `));
    if (i >= 0) problems[i] += ` — ${hint}`;
  }
  return { keys, adopt, overwrite, webResourceAdopt, webResourceOverwrite, publicationRisk, error: problems.length ? `--authorize: ${problems.join('; ')}` : null };
}

function parseLanguageCode(value) {
  if (value === undefined) return undefined;
  // Shares app-spec's normalizer so the CLI flag, the App Spec field and the resolver can never
  // disagree about which LCIDs are valid.
  const lc = normalizeLanguageCode(value);
  if (lc === null) {
    throw new Error(`--language-code / --languageCode must be digits only, a positive integer LCID up to 65535 (got '${value}')`);
  }
  return lc;
}

// Refuse to mutate unless the changed-only snapshot was demonstrably invalidated (#587 item 3).
//
// Extracted from main() so it can be tested by BEHAVIOUR. The first version of this guard was
// covered only by a source-level test, which proved worthless: both
// `if (false && …)` and a catch that manufactures `{ ok: true }` passed the whole file. A guard
// whose test survives its own removal is not a guard.
//
// Throws on anything that is not a definite success — `{ ok: false }`, a thrown error, and a
// missing/malformed return alike. A MISSING snapshot is not one of those: invalidateSnapshot
// reports `{ ok: true, reason: 'no snapshot to invalidate' }`, so an ordinary first build is
// unaffected. Halting costs a retry; continuing costs a silently incomplete deployment.
function assertSnapshotInvalidated(store, workspaceDir) {
  let inv;
  try {
    inv = store.invalidateSnapshot(workspaceDir);
  } catch (e) {
    inv = { ok: false, reason: e && e.message ? e.message : String(e) };
  }
  if (!inv || inv.ok !== true) {
    throw new Error(
      `refusing to apply: the changed-only snapshot in ${workspaceDir} could not be invalidated `
      + `(${(inv && inv.reason) || 'unknown reason'}). A later --changed-only run would trust it and `
      + 'skip work this apply is about to make necessary. Retry once any concurrent run has finished, '
      + 'or delete the snapshot to re-baseline.'
    );
  }
  return inv;
}

// #3: after a clean apply, persist the applied spec so the NEXT dry-run can diff against it and show
// what changed. Only on a real, successful, FULL apply, OR a changed-only fast apply (whose deployed
// state matches the spec: unchanged artifacts persist idempotently and the changed pages were just
// re-uploaded). A partial --stage data apply is NOT the whole desired state, so it must not overwrite
// the snapshot. Gated on EFFECTIVE success (verify passed) — a build that applied but whose auto-verify
// found a silent partial must NOT record its spec as the deployed baseline. Best-effort:
// returns whether the baseline was written, and never throws.
//
// The spec is persisted ANNOTATED with on-disk content hashes (#2) so the next dry-run's diff can
// detect a .tsx / contentPath byte edit, not just a spec-JSON change. It records the content that was
// actually deployed by THIS apply, stamped with the environment and app it was deployed to, and the
// dashboard/page ids this apply resolved there (AB#6726727: the sitemap baseline lines entries up by
// them, and a spec downloaded elsewhere carries another environment's). A page's hash is the one of the
// source the pages phase read and sent (`created.pageSourceShas`), not of the file as it is when the build
// ends: a page saved while the build ran must read as changed next time, and the build's Griffel check
// judges a page against this record (deployed-baseline.js annotateForBaseline). `write` is a test seam.
function persistAppliedBaseline(r, { spec, opts, workspaceDir, appDirAbs, baselineIdentity }, write = writeBaseline) {
  const fullPhaseApply = (opts.phases || PHASES).length === PHASES.length;
  const changedOnlyApplied = !!(r && r.changedOnly && (r.changedOnly.decision === 'fast' || r.changedOnly.decision === 'full'));
  const effectiveSuccess = !!(r && r.ok && (!r.verify || r.verify.ok));
  if (!(effectiveSuccess && opts.apply && !r.dryRun && (fullPhaseApply || changedOnlyApplied))) return false;
  try {
    // A changed-only run that found nothing to apply (`noop`, with no `created`) sent nothing, so it has no source to record: every page keeps the record it had.
    const created = r.created || (r.noop === true ? { pageSourceShas: {} } : r.created);
    write(workspaceDir, spec, { appDir: appDirAbs, ...baselineIdentity, created, previous: opts.baselineSpec });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const USAGE =
    'Usage: node scripts/build-model-app.js --env <url> --spec @<app-folder>/app-spec.json [--apply] [--sample-data] [--publish] [--verify] [--changed-only] [--no-live-plan] [--preview-push] [--stage <data|ui|app|publish>] [--only|--skip <phases>] [--from|--to <phase>] [--language-code|--languageCode <lcid>] [--non-interactive] [--allow-destructive] [--authorize <key>]... [--deployment-settings <file>] [--workspace <dir>]';
  // The declared flag contract, enforced before anything else runs.
  //
  // `needValue` lists every flag whose MISSING value would be read as a default rather than an
  // error — critically the phase selectors, where a bare `--only` is dropped by
  // list()/stagePhasesOrResolve and silently resolves to the full phase set. `--apply --only` must
  // not become a full apply on this destructive tool.
  //
  // validateFlags additionally rejects an unrecognised flag, which parseArgs would otherwise drop
  // while swallowing the token after it. Measured before this guard: `--stage ui` planned 3 steps
  // but the one-letter typo `--stagee ui` planned all 9 and still exited 0 — a caller who believed
  // they had scoped an apply to the UI phases got a full data-model apply with no diagnostic.
  const flagError = validateFlags(argv, {
    known: ['env', 'spec', 'apply', 'sample-data', 'publish', 'verify', 'changed-only', 'no-live-plan', 'preview-push',
      'stage', 'only', 'skip', 'from', 'to', 'language-code', 'languageCode', 'non-interactive',
      'allow-destructive', 'authorize', 'deployment-settings', 'workspace'],
    needValue: ['env', 'spec', 'stage', 'only', 'skip', 'from', 'to', 'language-code', 'languageCode', 'authorize', 'deployment-settings', 'workspace'],
  });
  if (flagError) {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  // validateFlags has already rejected a bare or empty --env/--spec, so each is now either absent
  // or a non-empty string; the typeof dance these lines used to carry is subsumed by it.
  const env = flags.env;
  const specArg = flags.spec || positional[0];
  if (!env || !specArg) {
    process.stderr.write(USAGE + '\n');
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
  // --preview-push previews against the live environment, so it needs the live plan it builds on (a dry run
  // with the live plan only), and an apply has nothing to preview. Refused like every other flag conflict here.
  if (flags['preview-push'] === true && (flags.apply === true || flags['no-live-plan'] === true)) {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`✗ --preview-push runs on a dry run with the live plan; drop --apply / --no-live-plan\n${USAGE}\n`);
    process.exit(1);
  }
  const specPath = path.resolve(specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  const workspaceDir = flags.workspace || path.join(path.dirname(specPath), '.maker-workspace');
  const authorization = authorizationKeys(argv, spec);
  if (authorization.error) {
    makeWritesBlocking(process.stdout, process.stderr);
    process.stderr.write(`✗ ${authorization.error}\n${USAGE}\n`);
    process.exit(1);
  }
  // --deployment-settings <file>: per-environment environment variable values and connection reference connections, in the shape
  // `pac solution create-settings` writes: { "EnvironmentVariables": [{ "SchemaName", "Value" }], "ConnectionReferences": [{ "LogicalName", "ConnectionId", "ConnectorId" }] }.
  // The file can hold secrets, so nothing printed quotes its content: a JSON error names the file only (V8's message quotes the text near the
  // error), and readDeploymentBindings' errors name entries, never values. A UTF-8 BOM (Windows editors write one) is dropped before parsing.
  let configurationBindings;
  if (typeof flags['deployment-settings'] === 'string') {
    const settingsPath = path.resolve(flags['deployment-settings']);
    let settingsText;
    try {
      settingsText = fs.readFileSync(settingsPath, 'utf8');
    } catch (err) {
      makeWritesBlocking(process.stdout, process.stderr);
      process.stderr.write(`✗ --deployment-settings: cannot read ${settingsPath} (${(err && err.code) || 'error'})\n`);
      process.exit(1);
    }
    let settings;
    try {
      settings = JSON.parse(settingsText.replace(/^\uFEFF/, ''));
    } catch {
      makeWritesBlocking(process.stdout, process.stderr);
      process.stderr.write(`✗ --deployment-settings: ${settingsPath} is not valid JSON\n`);
      process.exit(1);
    }
    const bindings = readDeploymentBindings(settings, spec);
    if (bindings.errors.length) {
      makeWritesBlocking(process.stdout, process.stderr);
      process.stderr.write(`✗ --deployment-settings: ${bindings.errors.join('; ')}\n`);
      process.exit(1);
    }
    configurationBindings = bindings;
  }
  // Before auth, language resolution, and SDK construction. A link planted as the workspace
  // root is refused here so the factory below is never called; a real directory is allowed.
  // Only an --apply creates it: a dry run never opens this workspace (see makeSdk).
  try {
    assertWorkspaceDir(workspaceDir, { create: flags.apply === true });
  } catch (err) {
    emitResult(false, err instanceof Error ? err : new Error(String(err)));
    return;
  }
  // The journal is apply-only and best-effort. A LINK at its log name must still be refused
  // before auth and before the SDK factory, or the throwaway SDK directory is created and then
  // stranded when the journal later refuses the write. Any other reason the log cannot be used —
  // a folder at that name, an unreadable entry — is the journal's ordinary best-effort case:
  // openJournal disables journaling with a warning, and the build goes on.
  if (flags.apply === true) {
    try {
      assertPlainFileTarget(path.join(workspaceDir, 'build-log.jsonl'));
    } catch (err) {
      if (err && (err.reason === 'link' || err.reason === 'hard-link')) {
        emitResult(false, err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
  }
  const languageCode = parseLanguageCode(readLanguageFlag(flags));
  const phases = stagePhasesOrResolve({ stage: flags.stage, only: list(flags.only), skip: list(flags.skip), from: flags.from, to: flags.to });
  // Phases that stamp an authoring language onto something. `data-model` writes Dataverse label
  // objects; `forms`, `dashboards` and `app-shell` write FormXML `<labels>` and sitemap
  // `<Titles><Title LCID=…>` through the SDK, which since #455 takes the LCID as a construction
  // option. Anything else (views, pages, web-resources, publish, sample-data) creates no labels.
  //
  // This list must stay in step with what actually consumes the language. When it drifted before,
  // the warning told users the flag was ignored on `--stage ui` at the same time as the build was
  // faithfully applying it — worse than no warning, because it stops them investigating.
  const LANGUAGE_CONSUMING_PHASES = ['data-model', 'forms', 'dashboards', 'app-shell'];
  // A selector that excludes ALL of them makes the flag a genuine no-op. Say so rather than accept
  // it silently: a user who passed --language-code believes their labels are being pinned, and
  // finding out otherwise means re-running the whole build.
  if (languageCode !== undefined && Array.isArray(phases) && phases.length
      && !phases.some((p) => LANGUAGE_CONSUMING_PHASES.includes(p))) {
    process.stderr.write(`⚠ --language-code ${languageCode} has no effect for the selected phases (${phases.join('·')}) — none of them create labels (${LANGUAGE_CONSUMING_PHASES.join(', ')} do).\n`);
  }
  const opts = {
    apply: flags.apply === true,
    sampleData: flags['sample-data'] === true,
    publish: flags.publish === true,
    // #559: a dry run resolves create-vs-reuse against the live environment by default, because a
    // plan that cannot tell them apart is not a plan. `--no-live-plan` restores the offline,
    // spec-only listing for a caller with no environment access.
    livePlan: flags['no-live-plan'] !== true,
    verify: flags.verify === true,
    phases,
    profile: (flags.apply === true && flags.stage !== 'data') ? 'deploy' : 'plan',
    allowDestructive: flags['allow-destructive'] === true,
    authorizedDestructive: authorization.keys,
    configurationBindings,
    // Spread in only when given, so a run without them hands the engine exactly the options it did before.
    ...(authorization.adopt.size ? { authorizedAdoption: authorization.adopt } : {}),
    ...(authorization.overwrite.size ? { authorizedOverwrite: authorization.overwrite } : {}),
    ...(authorization.webResourceAdopt.size ? { authorizedWebResourceAdoption: authorization.webResourceAdopt } : {}),
    ...(authorization.webResourceOverwrite.size ? { authorizedWebResourceOverwrite: authorization.webResourceOverwrite } : {}),
    ...(authorization.publicationRisk.size ? { publicationRisk: authorization.publicationRisk } : {}),
    nonInteractive: flags['non-interactive'] === true || envTruthy(process.env.POWER_PLATFORM_SKILLS_NONINTERACTIVE),
    languageCode,
    appDir: path.dirname(specPath),
    env,
    workspaceDir,
    // --preview-push: only when given, so the options of a run without it are what they were.
    ...(flags['preview-push'] === true ? { previewPush: true } : {}),
  };
  // An APPLY runs under the app's build lease from here to its result (lib/app-operation-lease.js): taken after the arguments, the spec and the
  // paths have been checked, and BEFORE the auth check, the language read, the SDK's workspace, the journal, the baseline and the snapshot — so a
  // second apply of the same app in this workspace is refused (`build-locked`: on stderr, exit 1, no stdout JSON) before it sends a request or
  // touches a file another build is using. The lease covers the build's automatic re-runs and their waits, the settlement of a halt, the inline
  // verify, the SDK's cleanup and the baseline written last, and it is let go — in the `finally` of withAppBuildLease — before the result is
  // printed: emitResult ends the process, and a `finally` around it would never run. So the command's body ANSWERS its result, and it is printed
  // here, after the release; an error it throws goes on to main().catch the same way. A dry run reads only, and takes no lease.
  const command = { env, spec, languageCode, changedOnly, workspaceDir };
  // skill_completed telemetry, for an APPLY only: a dry run changes nothing in the environment. Set before the run so a halt thrown out of
  // it (main().catch) is reported too; reportCompletion awaits at most a short WhoAmI and never throws.
  if (opts.apply) {
    completionRun = {
      startedAt, env, changedOnly, opts,
      staged: !!(flags.stage || flags.only || flags.skip || flags.from || flags.to),
      tally: createStepTally(),
    };
  }
  const outcome = opts.apply
    ? await withAppBuildLease({ workspaceDir, appUniqueName: appUniqueName(spec), warn: (m) => process.stderr.write(`⚠ ${m}\n`) },
      (buildLease) => runBuildCommand({ ...command, opts: { ...opts, buildLease }, stepTally: completionRun.tally }))
    : await runBuildCommand({ ...command, opts });
  await reportCompletion(completionRun, { ok: outcome.ok, payload: outcome.payload });
  emitResult(outcome.ok, outcome.payload);
}

// The apply this process is running, for skill_completed telemetry; null for a dry run or before an apply starts.
let completionRun = null;

// What an apply's result says, in the closed vocabulary of lib/telemetry/skill-completed.js — never its messages.
//   ok                                   → success
//   thrown build-locked/pages-locked     → locked          (another build holds the app; nothing was sent)
//   thrown BuildHalt with a phase        → halted, haltPhase
//   { ok: false, error }                 → auth            (the identity preflight refused; runBuildCommand)
//   { ok: true, verify.ok: false }       → verify-failed   (applied, but the auto-verify found it incomplete)
//   { ok: false, errors } after a step failed → deploy-failed; before any step → halted at preflight (spec checks, approvals)
function completionFor(run, { ok, payload, error }) {
  const steps = run.tally.snapshot();
  const stepErrors = Object.values(steps).some((row) => row.error > 0);
  const eventInfo = {
    operation: 'app-build',
    scope: run.changedOnly ? 'changed-only' : run.staged ? 'staged' : 'full',
    publish: !!run.opts.publish,
    steps,
  };
  const verify = payload && payload.verify;
  if (verify) eventInfo.verify = verify.ok ? 'passed' : 'failed';
  else if (payload && !error) eventInfo.verify = 'not-run';
  if (ok) return { outcome: 'success', eventInfo };
  if (error) {
    const code = error && error.code;
    if (code === 'build-locked' || code === 'pages-locked' || code === 'build-lease-invalid') return { outcome: 'failure', errorClass: 'locked', eventInfo };
    const phase = error && typeof error.phase === 'string' ? error.phase : undefined;
    return phase
      ? { outcome: 'failure', errorClass: 'halted', eventInfo: { ...eventInfo, haltPhase: phase } }
      : { outcome: 'failure', errorClass: 'unexpected', eventInfo };
  }
  if (payload && payload.ok && verify && !verify.ok) return { outcome: 'failure', errorClass: 'verify-failed', eventInfo };
  if (payload && typeof payload.error === 'string' && !Array.isArray(payload.errors)) return { outcome: 'failure', errorClass: 'auth', eventInfo: { ...eventInfo, haltPhase: 'preflight' } };
  if (stepErrors) return { outcome: 'failure', errorClass: 'deploy-failed', eventInfo };
  return { outcome: 'failure', errorClass: 'halted', eventInfo: { ...eventInfo, haltPhase: 'preflight' } };
}

async function reportCompletion(run, result, emit = emitSkillCompleted) {
  if (!run) return;
  try {
    const { outcome, errorClass, eventInfo } = completionFor(run, result);
    await emit({ skillName: 'app-builder', outcome, errorClass, eventInfo, envUrl: run.env, durationMs: Date.now() - run.startedAt });
  } catch { /* telemetry never changes the build's result */ }
}

// Everything main() does once the command line has been checked: auth, the authoring language, the SDK, the journal, the build and the baseline.
// Answers { ok, payload } for main() to print: a refusal of the identity as the `{ ok: false, error }` it has always printed, and otherwise the
// build's result, `ok` only when the build and its verify succeeded.
async function runBuildCommand({ env, spec, languageCode, changedOnly, workspaceDir, opts, stepTally }) {
  // #455: the App, Form and Dashboard adapters bake the authoring LCID in at CONSTRUCTION, so it
  // has to be resolved before the SDK exists — which is why this reads over the transport hatch
  // rather than through `provision.queryRecords`. Resolving here also means the provisioned-language
  // halt fires once, before anything is constructed or written. Dry runs skip it: they perform no
  // writes, and a language read is a round trip a plan does not need.
  //
  // Resolution is best-effort in its *fallback* direction: an unreadable organization language, a
  // failed probe, or a missing value all degrade to the 1033 default with a warning rather than
  // failing the build. It is deliberately NOT best-effort in one direction — an EXPLICIT
  // `--language-code` / spec `languageCode` that the organization has not provisioned halts here
  // (#456), before the SDK is constructed and before any label is written. That halt is the point:
  // Dataverse would otherwise accept some labels under the wrong language and reject others
  // mid-build, phases away from the flag that caused it.
  // AB#6686427 — prove the ambient Azure CLI identity can reach this org BEFORE anything else on an
  // apply. Everything below (the language read, the destructive-apply safety probe, every phase)
  // authenticates through that identity, and when it is wrong they each fail in their own vocabulary
  // — "could not determine the organization's base language", "preflight safety check could not run"
  // — none of which names the actual cause. Dry runs skip it: they perform no writes and need no
  // identity. An INCONCLUSIVE verdict never blocks; see preflightAuth.
  if (opts.apply) {
    const auth = await preflightAuth(env, { identityOnSuccess: false });
    // A single, already-explained failure uses `error`, not `errors: [...]`. `emitResult` reserves
    // the array for a genuine PARTIAL failure and summarises it as a COUNT ("completed with 1
    // error(s); see stdout JSON") — which would replace a message written specifically to tell the
    // operator which identity to sign in as. `download-model-app.js` uses `error` for the identical
    // failure, so the array here also made two sibling CLIs report the same problem differently.
    if (!auth.ok && !auth.inconclusive) return { ok: false, payload: { ok: false, error: auth.error } };
    if (auth.inconclusive) process.stderr.write(`⚠ ${auth.error}\n`);
  }
  const authoringLanguageCode = opts.apply
    ? await resolveAuthoringLanguage({ envUrl: env, languageCode, spec, warn: (m) => process.stderr.write(`⚠ ${m}\n`) })
    : undefined;
  // Reuse the SAME resolved value for the data-model phase instead of repeating the org read and the
  // provisioned-languages probe. A disagreement between the two would label columns in one language
  // and FormXML/sitemap titles in another — assigned after resolution because `opts` is built above.
  opts.preResolvedLanguageCode = authoringLanguageCode;
  // Construct for both dry-run and apply: proves the vendored bundle + adapter wire up
  // (offline), and apply needs it. A spec validation error short-circuits before any write.
  // Only an apply opens (and so binds) the app folder's workspace; a dry run works in a throwaway one and
  // hands back a note when the folder would stop an --apply.
  // The run's budget for waiting out a throttled service (lib/throttle-budget.js), made before anything that sends so that every layer draws from the one: the HTTP client the SDK is made over, the page backend (through the engine's
  // `throttle`) and the build's own retry loop (`deps.throttle`). A wait of more than a few seconds is announced on stderr — stdout carries the JSON result.
  const throttle = makeThrottleBudget({ warn: (m) => process.stderr.write(`⚠ ${m}\n`) });
  const publicationBarrier = createPublicationBarrier();
  const sendObserver = createAttemptSendObserver();
  // The workflow effect gate of declared business rules and process flows, bound to the managed binding store once the build opens
  // it (lib/deferred-workflow-gate.js). Made only while one of those features is on, so with both off the client is unchanged.
  const workflowEffectGate = declaredFeatureOn('rules') || declaredFeatureOn('bpf') ? require('./lib/deferred-workflow-gate.js').createDeferredWorkflowGate() : null;
  const { sdk, provisionSdk, cleanup, isolatedReader, folderNote, previewHttpClient } = await makeSdk(env, spec, workspaceDir, authoringLanguageCode, { persistent: opts.apply, throttle, previewPush: opts.previewPush === true && !opts.apply, publicationBarrier, sendObserver, ...(workflowEffectGate ? { workflowEffectGate } : {}) });
  if (folderNote) process.stderr.write(`⚠ ${folderNote}\n`);
  // Durable build journal (apply runs only): a per-run record of steps + where a run halted,
  // written to <workspace>/build-log.jsonl. Resume = re-run the same command (idempotent).
  // Opened here, after the SDK exists, so a refusal still runs cleanup. The preflight above
  // is what keeps a link present at the start from constructing the SDK at all.
  let journal = null;
  try {
    journal = opts.apply
      ? openJournal(workspaceDir, { app: spec.app && spec.app.name, solution: spec.solution && spec.solution.uniqueName, apply: true, phases: opts.phases })
      : null;
  } catch (err) {
    cleanup();
    throw err;
  }
  // Surface the live-progress files so a long build is observable even if this process's stdout is
  // buffered by the launching shell (e.g. piping through Select-Object). `build-status.json` holds the
  // current step; `build-log.jsonl` is the full trace.
  if (journal && journal.statusPath) {
    process.stderr.write(`▸ live progress: read "${journal.statusPath}" for the current step (or tail "${journal.path}").\n`);
  }
  // #3 (track the diff): on a DRY-RUN, if a prior apply left a snapshot, report which phases changed
  // since — so a small edit is visibly "only pages changed", not a re-read of the whole plan. Advisory
  // only (it does not yet gate --apply; see docs/app-builder-capabilities.md). Never fatal.
  const lastAppliedPath = baselinePath(workspaceDir);
  // #2 (content-aware diff): resolve a page codeFile / web-resource contentPath the SAME way the build
  // engine does — relative to the app folder (opts.appDir) — confined to it (deployed-baseline.js).
  const appDirAbs = path.resolve(opts.appDir || '.');
  const readContent = confinedReader(appDirAbs);
  // The environment and app a baseline must describe to count (see deployed-baseline.js).
  const baselineIdentity = { environment: dataverseOrigin(env), appUniqueName: appUniqueName(spec) };
  // AB#6726727: the same snapshot is the sitemap rewrite's baseline. Read BEFORE the apply, which
  // replaces it on success; a missing or mismatched one just means the spec wins and the build says so.
  if (opts.apply) opts.baselineSpec = readBaseline(workspaceDir, baselineIdentity) || undefined;
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
    // deps.verify: the real reconcile, wired to the live provision SDK. Only invoked when
    // opts.verify AND the build applied successfully. Constructed here (not in buildModelApp) so the
    // core stays free of SDK-reader wiring and fully injectable for tests.
    const deps = {
      log: (m) => process.stderr.write(m + '\n'),
      warn: (m) => process.stderr.write(`⚠ ${m}\n`),
      sdk, provisionSdk, journal, throttle, stepTally, publicationBarrier, sendObserver,
      ...(workflowEffectGate ? { workflowEffectGate } : {}),
      ...(previewHttpClient ? { previewHttpClient } : {}),
      // The role-privileges check must actually RUN here. verify-spec skips it unless BOTH
      // `rolePrivileges` and `entityPrivileges` readers are present, and `entityPrivileges` used to
      // need the raw client plus the org URL — omitting them degraded silently, so `--apply --verify`
      // reported a clean PASS having never checked what any persona's role grants. Caught live:
      // standalone verify ran 10 checks against the same app where the build's inline verify ran 8.
      // The reader now takes its privilege read off the SDK, so there is nothing left to forget.
      verify: async (s, verifyOpts) => {
        // The page reads go through a backend of their own, in a throwaway workspace — not the app folder's `.maker-workspace`, which
        // would be left holding a copy of every page read — removed as soon as this verify ends.
        const genpage = makeGenpageSdk(env, { throttle });
        try {
          return await verifySpec(s, readerFor(provisionSdk, appUniqueName(s), { genpage, workspaceDir, isolatedReader }), verifyOpts);
        } finally {
          // Awaited: a read the pass gave up on can still be running, and the workspace is removed only once the storage calls it had under way have settled. A folder it could not
          // remove holds page source, so it is a warning: the verify result is not changed by it.
          const leftOnDisk = leftOnDiskWarning(await genpage.dispose());
          if (leftOnDisk) deps.warn(leftOnDisk);
        }
      },
      // The set of LCIDs this organization actually has. Injected so the pure lib stays free of
      // transport; consulted for an EXPLICIT `--language-code` / spec `languageCode`, and by a declared
      // dashboard write that creates a tile (dashboard-reconcile.js tileCaptionLanguages).
      provisionedLanguages: () => readProvisionedLanguages(env),
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
      // changed-only flow, so a stale eligible snapshot would otherwise describe pre-apply state.
      //
      // FAIL CLOSED (#587 item 3). This used to be best-effort: the `{ ok, reason }` result was discarded
      // and a throw was swallowed with "never block a build". But "the snapshot could not be invalidated"
      // is not cosmetic — the snapshot is exactly what a later `--changed-only` run trusts to decide what
      // it may SKIP. If a full apply mutates the environment while an ELIGIBLE snapshot survives (lease
      // contention from a concurrent run, an unwritable workspace), that later run certifies pre-apply
      // state and can skip work this apply just made necessary.
      if (opts.apply) assertSnapshotInvalidated(applySnapshotStore, workspaceDir);
      r = await buildModelApp(spec, opts, deps);
    }
  } finally {
    cleanup();
  }
  // Still under the build lease: the baseline is this build's to write, and no other build of the app may write it meanwhile.
  persistAppliedBaseline(r, { spec, opts, workspaceDir, appDirAbs, baselineIdentity });
  // main() prints this once the lease is let go (emitResult calls process.exit). A build that applied cleanly but whose auto-verify found missing
  // artifacts exits NON-ZERO (the silent-partial signal auto-verify exists to raise), while r still carries the full build + verify detail.
  const ok = r.ok && (!r.verify || r.verify.ok);
  return { ok, payload: r };
}

if (require.main === module) {
  main().catch(async (err) => {
    await reportCompletion(completionRun, { ok: false, error: err });
    emitResult(false, err);
  });
}
module.exports = { buildModelApp, authorizationKeys, planFor, isTransientHalt, checkCollisions, discoverOpDiffState, envTruthy, parseLanguageCode, assertSnapshotInvalidated, persistAppliedBaseline, completionFor, reportCompletion };
