#!/usr/bin/env node
'use strict';

// Central feature-flag gate for the /genpage skill.
//
// WHY: a GenPage capability typically spans several repos that ship on independent
// cadences — a pac CLI verb, a host/authoring runtime, and a maker/admin ECS setting.
// Until ALL of them are live in PROD, the skill must behave exactly as it did before
// the capability existed. A committed, default-OFF flag lets us merge the skill code
// ahead of release and flip it on in a follow-up (or per-run via env var) once
// its dependencies are available.
//
// A flag is flipped to `true` FIRST and removed in a later change, not both at once.
// Flipping is reversible in one line if the rollout turns out to be incomplete in some
// tenant; deleting the gate in the same change that enables the feature leaves no way
// back except a revert. Once a release has shipped with the flag on and no rollback was
// needed, remove it so unknown flags fail closed instead of staying permanently probed.
// `custom-api` went that way: on by default since 2.18.0, with its platform dependencies
// live in every region, it was removed, so Custom API discovery, authoring and upload are
// always available and GENPAGE_ENABLE_CUSTOM_API no longer means anything. Nothing may ask
// for it any more: as an unknown flag it would read as disabled.
//
// Precedence (highest first), mirroring the telemetry opt-out convention in
// AGENTS.md where an env var overrides committed config:
//   1. env var  GENPAGE_ENABLE_<FLAG>
//   2. committed feature-flags.json at the plugin root
//   3. default: false  (fail-closed — unknown/unset flags are OFF)
//
// CLI probe (so an LLM-driven skill step can gate on the exit code):
//   node scripts/lib/feature-flags.js <flag>
//     prints "enabled"  + exit 0  when the flag is ON
//     prints "disabled" + exit 1  when the flag is OFF

const fs = require('node:fs');
const path = require('node:path');

// The committed flag file lives at the plugin root; from scripts/lib that's two up.
const FLAGS_PATH = path.resolve(__dirname, '..', '..', 'feature-flags.json');

// Catalog of every flag the skill knows about, with lifecycle status so makers
// and devs can see what is experimental / in-progress vs GA. `status` is one of
// 'experimental' | 'in-progress' | 'ga'. Keep this the single source of truth —
// feature-flags.json only carries the on/off value; this catalog carries the
// metadata (what it enables, what it depends on, how to turn it on).
const FLAGS = {
  'custom-telemetry': {
    status: 'in-progress',
    summary:
      'Custom page telemetry — a generated page reporting its own events, metrics, traces and ' +
      "exceptions to the customer's Application Insights resource via an optional props.appInsights " +
      'surface, emitted only when the maker explicitly asks to measure or track something.',
    dependencies:
      'the page telemetry facade in the UCI host runtime, the GenUX authoring control ' +
      '(power-platform-ux), the AIBuilder CoderAgent telemetry prompt, and the ' +
      'GenUxEnableCustomTelemetry ECS setting — all live in PROD.',
    enableEnv: 'GENPAGE_ENABLE_CUSTOM_TELEMETRY=1',
  },
  'dataverse-operations': {
    status: 'experimental',
    summary:
      'Built-in Dataverse operation authoring — offers exactly WhoAmI and RetrieveVersion, two reviewed unbound Functions with no ' +
      'inputs, as explicitly selected, user-triggered page bindings called with dataApi.executeFunction. The offer comes from a ' +
      'fixed catalogue: it does not check the environment, the player runtime or the signed-in user privileges.',
    dependencies:
      'the shared pai-gen-ux-action-runtime and a host runtime that implements executeFunction, the page `actionBindings` ' +
      'the plugin writes into config.json (genpage-upload.js --actions), and the GenUxPluginActionAllowList ECS setting.',
    enableEnv: 'GENPAGE_ENABLE_DATAVERSE_OPERATIONS=1',
  },
};

// Flag names the skill knows about, derived from the catalog. Used to validate the
// committed file (catch typo'd keys that would silently stay OFF — or, after a flip
// to true, an unintended key) and to enumerate state via `describe()`.
const KNOWN_FLAGS = Object.keys(FLAGS);

// Truthy env values follow the common CLI convention (dotnet/bash style):
// 1/true/yes/on enable; 0/false/no/off disable; anything else (including unset
// or empty) returns null so the caller defers to the next precedence layer
// rather than guessing.
function parseBool(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (v === '') return null;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return null;
}

// 'dataverse-operations' -> GENPAGE_ENABLE_DATAVERSE_OPERATIONS. Non-alphanumeric runs in a flag name
// collapse to a single '_' so multi-word flags still map to a legal env var name.
function envVarName(flag) {
  return 'GENPAGE_ENABLE_' + String(flag).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function readFlagsFile(flagsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(flagsPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A missing, unreadable, or invalid config is fail-closed: treat as no flags
    // set so a corrupt file can never silently enable an unreleased feature.
    return {};
  }
}

/**
 * Returns whether a named feature flag is enabled.
 *
 * @param {string} flag  Flag name (e.g. 'dataverse-operations').
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]  Env source (defaults to process.env).
 * @param {object} [opts.flags]           Pre-loaded flags map (skips file read).
 * @param {string} [opts.flagsPath]       Alternate flags file path (defaults to
 *                                         the committed plugin-root file).
 * @returns {boolean}
 */
function isEnabled(flag, opts = {}) {
  if (!Object.prototype.hasOwnProperty.call(FLAGS, flag)) return false;

  const env = opts.env || process.env;
  const envValue = parseBool(env[envVarName(flag)]);
  if (envValue !== null) return envValue; // env override wins for known flags only

  const flags = opts.flags || readFlagsFile(opts.flagsPath || FLAGS_PATH);
  // Strictly === true; anything else (false, missing, non-boolean) is OFF.
  return flags[flag] === true;
}

// The built-in operation gate: it decides the offer and the authoring of WhoAmI and RetrieveVersion only (references/dataverse-operations.md).
function isDataverseOperationsEnabled(opts) {
  return isEnabled('dataverse-operations', opts);
}

// The fail-closed gate for list-dataverse-operations.js: exit 3 = "feature off", with one constant line. The line goes to stderr and the
// process ends at once, so the write is made blocking first — on Linux and macOS a pipe's writes are otherwise queued and the exit cuts them off
// (output-redaction.js). `exit`/`write` are injectable for unit testing.
function exitIfDataverseOperationsDisabled(opts = {}) {
  if (isDataverseOperationsEnabled(opts)) return undefined;
  require('./output-redaction.js').makeWritesBlocking(process.stderr);
  const exit = opts.exit || process.exit;
  const write = opts.write || ((s) => process.stderr.write(s));
  write(dataverseOperationsDisabledMessage() + '\n');
  return exit(3);
}

// Returns the effective state of every known flag plus where the value came from
// (env override / committed file / default). Powers the `--list` command and any
// observability that wants to record the gate decision in a workflow log.
function describe(opts = {}) {
  const env = opts.env || process.env;
  const flags = opts.flags || readFlagsFile(opts.flagsPath || FLAGS_PATH);
  return KNOWN_FLAGS.map((flag) => {
    const envVal = parseBool(env[envVarName(flag)]);
    const source = envVal !== null
      ? 'env'
      : Object.prototype.hasOwnProperty.call(flags, flag)
        ? 'file'
        : 'default';
    return { flag, enabled: isEnabled(flag, { env, flags }), source, status: FLAGS[flag].status };
  });
}

// Returns human-readable warnings for a flags object: unknown keys (typos that
// would silently do nothing) and non-boolean values. Keys starting with '_' are
// treated as documentation (the committed file uses `_comment`). Returns [] when
// the file is clean.
function validateFlags(flags) {
  const warnings = [];
  for (const [key, value] of Object.entries(flags || {})) {
    if (key.startsWith('_')) continue;
    if (!KNOWN_FLAGS.includes(key)) {
      warnings.push(`unknown flag "${key}" (known flags: ${KNOWN_FLAGS.join(', ')})`);
    } else if (typeof value !== 'boolean') {
      warnings.push(`flag "${key}" should be a boolean, got ${typeof value} (${JSON.stringify(value)})`);
    }
  }
  return warnings;
}

// The one line list-dataverse-operations.js prints when the built-in operation gate is OFF. Byte-stable: the skill text quotes it, and a test
// reads it through a pipe. It says what OFF does NOT mean — existing bindings stay, and the platform's own governance still decides a call.
function dataverseOperationsDisabledMessage() {
  return (
    'Dataverse built-in operation authoring is disabled (feature flag "dataverse-operations" is OFF). ' +
    'Set GENPAGE_ENABLE_DATAVERSE_OPERATIONS=1 to offer WhoAmI and RetrieveVersion. ' +
    'Existing bindings are preserved; runtime governance and user privileges still apply.'
  );
}

module.exports = {
  isEnabled,
  isDataverseOperationsEnabled,
  dataverseOperationsDisabledMessage,
  exitIfDataverseOperationsDisabled,
  describe,
  validateFlags,
  envVarName,
  parseBool,
  FLAGS,
  KNOWN_FLAGS,
  FLAGS_PATH,
};

// CLI:
//   node feature-flags.js <flag>   → exit 0 (enabled) / 1 (disabled) / 2 (usage)
//   node feature-flags.js --list   → prints every known flag's state + source,
//                                    plus any validation warnings for the file.
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--list') {
    // The list ends with a warning for each bad entry of the flags file, and the process exits right after it: the writes are
    // made blocking first, or a pipe on Linux and macOS takes only what fits at once (output-redaction.js).
    require('./output-redaction.js').makeWritesBlocking(process.stdout, process.stderr);
    for (const { flag, enabled, source, status } of describe()) {
      process.stdout.write(
        `${flag}: ${enabled ? 'enabled' : 'disabled'} (status: ${status}, source: ${source})\n`
      );
      process.stdout.write(`  ${FLAGS[flag].summary}\n`);
      process.stdout.write(`  enable: ${FLAGS[flag].enableEnv} (or set "${flag}": true in feature-flags.json)\n`);
    }
    for (const w of validateFlags(readFlagsFile(FLAGS_PATH))) {
      process.stderr.write(`warning: ${w}\n`);
    }
    process.exit(0);
  }
  if (!arg) {
    process.stderr.write('Usage: node feature-flags.js <flag> | --list\n');
    process.exit(2);
  }
  const on = isEnabled(arg);
  process.stdout.write((on ? 'enabled' : 'disabled') + '\n');
  process.exit(on ? 0 : 1);
}
