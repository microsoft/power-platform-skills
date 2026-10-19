#!/usr/bin/env node
'use strict';
// write-app-spec-doc: render `model-app-plan.md` — the readable design document — from an App Spec.
//
// /app-builder Phase 1 used to write this document freehand from a prose checklist, which produced an
// abbreviated counts summary that drifted from the spec. Rendering it deterministically means the
// document is always complete and always matches what will actually build, and can be regenerated
// after any spec edit.
//
// Usage:
//   node write-app-spec-doc.js --spec @<working-dir>/app-spec.json [--env <orgUrl>] [--out <path>]
//
// Output: { "ok": true, "docPath": "...", "bytes": N, "warnings": [...] }
// `warnings` echoes the design gaps rendered into the document (no jobs, unmapped jobs, no pages, a new table no role is
// given access to, and — with --env — what the environment says about who can open the app) so the orchestrator can
// surface them in chat rather than leaving them buried in a file the user may not open.
//
// --env <orgUrl> labels the document with the environment AND reads, read-only, which security roles the app has associated
// with it there (lib/app-roles.js), so the document can say who can already open the app and keep that apart from the privileges
// on the tables the spec introduces. A spec with no personas[] authors no role, and who can open an app that already exists is
// decided by the roles associated with it — so without the read the document says what the spec authors and nothing more.
// The read never costs the document: a read that cannot be made (no sign-in, no permission, a URL that is no Dataverse
// environment) is reported in the document and in `warnings` as "not checked", and the command still writes it and exits 0.

const path = require('node:path');
const { assertSafeOutputDir, writeFileSafe } = require('./lib/safe-fs.js');
const { parseArgs, validateFlags, readJsonArg, emitResult, requireDataverseOrigin } = require('./lib/dataverse-auth.js');
const { migrateAppSpec } = require('./lib/app-spec.js');
const { renderAppSpecDoc } = require('./lib/app-spec-doc.js');
const { appAccessModel, uncoveredTables, uncoveredTablesWarning } = require('./lib/app-access.js');
const { withThrowawaySdk } = require('./lib/throwaway-sdk.js');
const { appRolesOf } = require('./lib/app-roles.js');

// The design gaps the document calls out, returned as data. Kept here (not in the pure renderer)
// because the renderer's contract is "markdown in one string"; the CLI is what talks to the caller.
// Shape-guarded for the same reason the renderer is: this runs against work-in-progress specs during
// authoring, and it must not be the thing that crashes the flow.
// `opts` is what the renderer was given: { envUrl, appAccess } — `appAccess` the answer of a read of the environment (lib/app-roles.js), absent without --env.
function designGaps(spec, opts = {}) {
  const out = [];
  const s = spec && typeof spec === 'object' ? spec : {};
  const personas = Array.isArray(s.personas) ? s.personas.filter((p) => p && typeof p === 'object') : [];
  const jobs = personas.flatMap((p) => (Array.isArray(p.jobs) ? p.jobs : [])
    .filter((j) => j && typeof j === 'object')
    .map((j) => ({ persona: p.persona, job: j })));
  if (!jobs.length) {
    // What is true of the spec — it records no jobs and, with no personas, authors no role — and not what the deployed app does: who can open it is decided
    // by the roles associated with it (lib/app-access.js), which a spec that authors none leaves as they are.
    out.push(personas.length
      ? 'no jobs-to-be-done captured (the personas declare no jobs) — the app has no recorded purpose'
      : 'no jobs-to-be-done captured (personas[] is empty) — the app has no recorded purpose, and this spec authors no security role, so it does not say who can open the app');
  }
  const unmapped = jobs.filter(({ job }) => !(Array.isArray(job.surfaces) && job.surfaces.length));
  if (unmapped.length) {
    out.push(`${unmapped.length} job(s) not mapped to a surface: ${unmapped.map(({ persona, job }) => `${persona} → ${job.name}`).join('; ')}`);
  }
  if (!(Array.isArray(s.pages) && s.pages.length)) {
    out.push('no generative pages — per the genpage-first policy, overview/dashboard/analytics/wizard surfaces should be pages');
  }
  const undescribed = (Array.isArray(s.entities) ? s.entities : [])
    .filter((e) => e && typeof e === 'object' && !e.existing && (e.vectorIcon || e.icon)
      && !(typeof e.iconDescription === 'string' && e.iconDescription.trim()))
    .map((e) => e.schemaName || '?');
  if (undescribed.length) {
    out.push(`${undescribed.length} table icon(s) have no description (${undescribed.join(', ')}) — the user cannot approve an icon they cannot picture`);
  }
  const withoutAccess = uncoveredTables(s);
  if (withoutAccess.length) out.push(uncoveredTablesWarning(withoutAccess));

  // What the environment said (--env), from the same model the document is written from. The administrator-only conclusion is drawn here, and only here, on that
  // evidence: the app has no role (or does not exist yet) AND no persona of this spec gets it — a persona that opts out (`appAccess: false`) is a role the build
  // does not associate.
  const model = appAccessModel(s, opts && opts.appAccess);
  const where = opts && typeof opts.envUrl === 'string' && opts.envUrl.trim() ? opts.envUrl.trim() : 'the environment';
  const app = model.appUnique ? `app '${model.appUnique}'` : 'the app';
  const noPersonaGetsApp = model.personas.gets.length === 0;
  if (model.state === 'unreadable') {
    out.push(`the roles associated with ${app} could not be read from ${where} (${model.reason}) — who can open it was not checked`);
  } else if (model.state === 'absent' && noPersonaGetsApp) {
    out.push(`${app} does not exist in ${where} yet and this spec associates no role with it, so once built it opens only for administrators and other makers until a role is associated with it`);
  } else if (model.state === 'read') {
    if (!model.roles.length && noPersonaGetsApp) {
      out.push(`${app} exists in ${where} with no role associated with it, so only administrators and other makers can open it, and this spec associates none with it`);
    }
    // A grant whose role is certainly not among the app's. One that names only a name and has a role of that name among them is not said: which role it is cannot be told.
    for (const grant of model.grants) {
      if (grant.status === 'not-associated') {
        out.push(`roleGrants[] role "${grant.label}" is not among the roles associated with ${app}, so its users get the privileges but may not be able to open the app`);
      }
    }
  }
  return out;
}

// What the environment holds of the app's roles, for the app this spec names. Never throws and never writes: a read that cannot be made is an answer
// ({ state: 'unreadable', reason }) the document words as "not checked" — `--env` has only ever labelled the document, and must not start to fail it.
async function discoverAppAccess(env, spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const named = s.app && typeof s.app === 'object' && !Array.isArray(s.app) ? s.app : {};
  const prefix = s.solution && typeof s.solution === 'object' ? s.solution.publisherPrefix : undefined;
  const hasText = (v) => typeof v === 'string' && v.trim() !== '';
  // appUniqueName derives `<prefix>_<name>` and does not refuse a spec that has no name: it would look up an app called "contoso_undefined".
  if (!hasText(named.uniqueName) && !(hasText(named.name) && hasText(prefix))) {
    return { state: 'unreadable', appUnique: '', reason: 'the spec does not name the app (it needs app.uniqueName, or app.name and solution.publisherPrefix)' };
  }
  // Loaded here, not when the module does: it is the build engine's own derivation (app.uniqueName, else the publisher prefix and the app's name), so the
  // app looked up is the app the build would find — and the engine is a large module that a run without --env has no use for.
  const { appUniqueName } = require('./lib/sdk-build.js');
  const appUnique = appUniqueName(s);
  let origin;
  try {
    origin = requireDataverseOrigin(env);
  } catch (err) {
    return { state: 'unreadable', appUnique, reason: String(err.message).slice(0, 200) };
  }
  try {
    return await withThrowawaySdk({ env: origin, prefix: 'app-doc-' }, (make) => appRolesOf(make(), appUnique));
  } catch (err) {
    // The HTTP client could not be made, or the SDK would not start: appRolesOf answers its own failures, so this is what is left.
    return { state: 'unreadable', appUnique, reason: (err && err.message ? String(err.message) : 'read failed').slice(0, 200) };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const USAGE = 'Usage: node scripts/write-app-spec-doc.js --spec @<app-folder>/app-spec.json [--env <orgUrl>] [--out <path>]';
  const flagError = validateFlags(argv, { known: ['spec', 'env', 'out'], needValue: ['spec', 'env', 'out'] });
  if (flagError) {
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  const specArg = flags.spec || positional[0];
  if (!specArg) {
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }

  const specPath = path.resolve(specArg.startsWith('@') ? specArg.slice(1) : specArg);
  let spec;
  try {
    spec = migrateAppSpec(readJsonArg('@' + specPath));
  } catch (e) {
    emitResult(false, new Error(`cannot read app spec at ${specPath}: ${e.message}`));
    return;
  }

  // The environment is read only when --env was given, and before anything is rendered: both the document and the warnings say what it answered.
  const opts = { envUrl: flags.env };
  if (flags.env) opts.appAccess = await discoverAppAccess(flags.env, spec);
  const markdown = renderAppSpecDoc(spec, opts);
  // Compute the gaps BEFORE writing: a failure here used to leave a written document behind and then
  // exit with a raw stack, so the caller saw a crash next to a file that looked fine.
  const warnings = designGaps(spec, opts);
  // Default next to the spec, which is the working directory the skill created in Phase 0.
  const docPath = flags.out ? path.resolve(flags.out) : path.join(path.dirname(specPath), 'model-app-plan.md');
  // A link at the document directory, or at the document name, would put the plan wherever
  // it points. Refuse that instead of following it. A normal directory is created if missing.
  try {
    assertSafeOutputDir(path.dirname(docPath), { create: true });
    writeFileSafe(docPath, markdown, { encoding: 'utf8' });
  } catch (e) {
    emitResult(false, e instanceof Error ? e : new Error(String(e)));
    return;
  }

  emitResult(true, { ok: true, docPath, bytes: Buffer.byteLength(markdown, 'utf8'), warnings });
}

if (require.main === module) main().catch((err) => emitResult(false, err instanceof Error ? err : new Error(String(err))));

module.exports = { main, designGaps, discoverAppAccess };
