#!/usr/bin/env node
'use strict';
// lint-app-spec: validate and lint an App Spec WITHOUT touching an environment.
//
// WHY this exists (#560): `validateAppSpec` (the hard schema/deploy gate) and `lintAppSpec` (the
// authoring guardrails) were library exports with no entry point, and `build-model-app.js` has no
// lint-only flag. A headless author — a CI job, or an agent authoring a spec outside the interactive
// skill flow — had to reach in with `node -e "require('./lib/spec-lint.js')..."`, which is both
// undiscoverable and easy to get wrong (it is the MIGRATED spec that must be validated, not the
// file as written; see below).
//
// This runs the gates a build runs on load, plus the authoring guardrails:
//   1. migrateAppSpec  — upgrade a legacy spec to schemaVersion 2 (mints page keys, rewrites
//                        name-refs). Skipping it lints a shape the build never sees.
//   2. validateAppSpec — the hard gate. Its errors are what `--apply` refuses on.
//   3. lintAppSpec     — advisory guardrails: errors AND warnings. NOTE: `build-model-app.js` does
//                        NOT run this; it migrates and validates only. The `lint:` findings here
//                        are therefore ADDITIONAL to what the builder reports, which is the point —
//                        the skill's plan gate is where they are meant to be caught.
//
// Exit codes: 0 when there are no errors from either step (warnings alone do not fail, so a CI job
// can gate on correctness without being blocked by advice), 1 otherwise. `--strict` also fails on
// warnings, for a pipeline that wants them treated as errors.
//
// `--profile` selects validateAppSpec's strictness and DEFAULTS TO `plan`, not `deploy`. The deploy
// profile requires every generative page to be IMPLEMENTED (`source.kind: 'tsx'` with a codeFile),
// which a spec legitimately lacks until generate-pages runs — and that is exactly when the
// authoring flow invokes this. `plan` relaxes only that; it does NOT relax any other rule (a
// persona job still requires `privileges[]` under every profile). Pass `--profile deploy` to gate
// a final, deployable spec.
//
// Usage:
//   node lint-app-spec.js --spec @<app-folder>/app-spec.json
//                         [--profile design|plan|deploy|structural] [--strict] [--json]

const { parseArgs, readJsonArg, emitResult } = require('./lib/dataverse-auth.js');
const { validateAppSpec, migrateAppSpec, VALIDATION_PROFILES } = require('./lib/app-spec.js');
const { lintAppSpec } = require('./lib/spec-lint.js');

const USAGE = 'Usage: node lint-app-spec.js --spec @<path-to-app-spec.json> [--profile design|plan|deploy|structural] [--strict] [--json]';

// Pure core: spec in, report out. Exported so tests can assert the contract without spawning a
// process or writing fixture files to disk.
//
// `profile` selects how strict `validateAppSpec` is. It matters more than it looks: the DEPLOY
// profile requires every generative page to be implemented (`source.kind: 'tsx'` with a codeFile),
// which is deliberately not true while pages are still intents. Defaulting to deploy made this CLI
// reject a perfectly normal work-in-progress spec at the two gates the authoring flow actually runs
// it at, so the default is `plan`, the same profile the builder's own dry run uses. `plan` relaxes
// ONLY that rule — a persona job still requires `privileges[]` under every profile. A caller
// checking a FINAL, deployable spec
// (a CI gate before `--apply`) should pass `--profile deploy` explicitly.
function lintSpec(rawSpec, opts) {
  const profile = (opts && opts.profile) || 'plan';
  if (!VALIDATION_PROFILES.includes(profile)) {
    return { ok: false, profile, errors: [`unknown profile '${profile}' (valid: ${VALIDATION_PROFILES.join(', ')})`], warnings: [] };
  }
  const spec = migrateAppSpec(rawSpec);

  // validateAppSpec is the gate `--apply` enforces, so its findings are reported FIRST and tagged
  // as such: an author who fixes lint advice while a schema error stands has fixed nothing.
  const validation = validateAppSpec(spec, { profile });
  const validationErrors = (validation && validation.errors) || [];
  // validateAppSpec also emits non-blocking advisories the build narrates (e.g. a Customer-column
  // description Dataverse will not store). Dropping them here would make this CLI quieter than the
  // build it stands in for, and would let `--strict` pass on a spec the build warns about.
  const validationWarnings = (validation && validation.warnings) || [];

  // A spec that fails the schema gate can put lintAppSpec in front of shapes it never expects
  // (a null entity, a string where a list belongs). The lint already guards its own collections,
  // but it is downstream advice either way — keep a crash from masking the real, already-known
  // schema errors. The crash is REPORTED, not swallowed, so a genuine lint defect still surfaces.
  let lint = { ok: true, errors: [], warnings: [] };
  try {
    lint = lintAppSpec(spec) || lint;
  } catch (err) {
    lint = { ok: false, errors: [`lint could not run on this spec: ${err.message}`], warnings: [] };
  }

  const errors = [
    ...validationErrors.map((e) => `schema: ${e}`),
    ...((lint.errors || []).map((e) => `lint: ${e}`)),
  ];
  const warnings = [
    ...validationWarnings.map((w) => `schema: ${w}`),
    ...((lint.warnings || []).map((w) => `lint: ${w}`)),
  ];

  return { ok: errors.length === 0, profile, errors, warnings, schemaVersion: spec && spec.schemaVersion };
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  // parseArgs yields `true` for a bare `--flag` and a string for `--flag=value` / `--flag value`.
  // For a VALUE-taking flag, that bare `true` is a usage error and must be rejected rather than
  // coerced: a bare `--profile` silently falling back to the default would skip a `deploy` gate a
  // CI job believed it had requested, and a bare `--spec` would reach readJsonArg and surface as
  // "spec is not an object" — a gate report about a file the caller never named.
  const isOn = (v) => v === true || v === 'true';
  const specArg = flags.spec;
  if (specArg === undefined) return emitResult(false, new Error(USAGE));
  if (typeof specArg !== 'string') return emitResult(false, new Error(`--spec needs a path\n${USAGE}`));
  if (flags.profile !== undefined && typeof flags.profile !== 'string') {
    return emitResult(false, new Error(`--profile needs one of: ${VALIDATION_PROFILES.join(', ')}\n${USAGE}`));
  }

  let rawSpec;
  try {
    rawSpec = readJsonArg(specArg.startsWith('@') ? specArg : '@' + specArg);
  } catch (err) {
    // A spec that is not readable/parseable is the single most common "why did nothing happen"
    // failure, so name the file and the parser's own message rather than a generic gate error.
    return emitResult(false, new Error(`could not read spec ${specArg}: ${err.message}`));
  }

  const report = lintSpec(rawSpec, { profile: flags.profile });
  const strict = isOn(flags.strict);
  const failed = !report.ok || (strict && report.warnings.length > 0);

  if (isOn(flags.json)) {
    // Deliberately NOT emitResult: its structured-failure branch reports
    // "Operation completed with N error(s)" off `payload.errors`, which for a warnings-only
    // `--strict` failure prints "0 error(s)" next to a non-zero exit — and the payload's own `ok`
    // must describe the COMMAND's outcome, not just whether errors were found.
    process.stdout.write(JSON.stringify({ ...report, ok: !failed }) + '\n');
    if (failed) {
      process.stderr.write(
        report.errors.length > 0
          ? `app spec has ${report.errors.length} error(s); see stdout JSON\n`
          : `app spec has ${report.warnings.length} warning(s) and --strict was set; see stdout JSON\n`
      );
    }
    process.exit(failed ? 1 : 0);
  }

  for (const e of report.errors) process.stderr.write(`ERROR  ${e}\n`);
  for (const w of report.warnings) process.stderr.write(`WARN   ${w}\n`);
  process.stdout.write(
    `${failed ? 'FAIL' : 'OK'} [profile: ${report.profile}] — ${report.errors.length} error(s), ${report.warnings.length} warning(s)` +
      `${strict && report.errors.length === 0 && report.warnings.length > 0 ? ' (failed by --strict)' : ''}\n`
  );
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main();
}

module.exports = { lintSpec };
