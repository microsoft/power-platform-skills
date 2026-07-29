#!/usr/bin/env node
'use strict';

// Central feature-flag gate for the /genpage skill.
//
// WHY: connector support spans three repos that ship on independent cadences —
// the pac CLI connector verbs (PowerPlatform-Scale-AdminTools), the GenUX
// authoring control (power-platform-ux), and the maker/admin ECS setting. Until
// ALL of them are live in PROD, the skill must behave exactly as it did before
// connectors existed. A committed, default-OFF flag lets us merge the skill code
// ahead of GA and flip it on in a one-line follow-up PR (or per-run via env var)
// once the dependencies are released — instead of carrying an un-merged branch.
//
// Precedence (highest first), mirroring the telemetry opt-out convention in
// AGENTS.md where an env var overrides committed config:
//   1. env var  GENPAGE_ENABLE_<FLAG>   (e.g. GENPAGE_ENABLE_CONNECTORS)
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

// 'connectors' -> GENPAGE_ENABLE_CONNECTORS. Non-alphanumeric runs in a flag name
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
 * @param {string} flag  Flag name (e.g. 'connectors').
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]  Env source (defaults to process.env).
 * @param {object} [opts.flags]           Pre-loaded flags map (skips file read).
 * @param {string} [opts.flagsPath]       Alternate flags file path (defaults to
 *                                         the committed plugin-root file).
 * @returns {boolean}
 */
function isEnabled(flag, opts = {}) {
  const env = opts.env || process.env;
  const envValue = parseBool(env[envVarName(flag)]);
  if (envValue !== null) return envValue; // env override wins

  const flags = opts.flags || readFlagsFile(opts.flagsPath || FLAGS_PATH);
  // Strictly === true; anything else (false, missing, non-boolean) is OFF.
  return flags[flag] === true;
}

function isConnectorsEnabled(opts) {
  return isEnabled('connectors', opts);
}

// Catalog of every flag the skill knows about, with lifecycle status so makers
// and devs can see what is experimental / in-progress vs GA. `status` is one of
// 'experimental' | 'in-progress' | 'ga'. Keep this the single source of truth —
// feature-flags.json only carries the on/off value; this catalog carries the
// metadata (what it enables, what it depends on, how to turn it on).
const FLAGS = {
  connectors: {
    status: 'in-progress',
    summary:
      'GenPage connector authoring (SharePoint, weather, Office 365, SQL, custom REST) ' +
      'and ALM packaging of connection references.',
    dependencies:
      'pac CLI connector verbs (PowerPlatform-Scale-AdminTools), the GenUX authoring ' +
      'control (power-platform-ux), and the maker/admin ECS setting — all live in PROD.',
    enableEnv: 'GENPAGE_ENABLE_CONNECTORS=1',
  },
};

// Flag names the skill knows about, derived from the catalog. Used to validate the
// committed file (catch typo'd keys that would silently stay OFF — or, after a flip
// to true, an unintended key) and to enumerate state via `describe()`.
const KNOWN_FLAGS = Object.keys(FLAGS);

// Fail-closed gate shared by every connector script entry point. Centralizing it
// (instead of each script inlining the same `if (!isConnectorsEnabled()) exit 3`)
// keeps the disabled message and exit code (3 = "feature off", distinct from
// 1 = runtime/usage error) consistent and prevents drift. `exit`/`write` are
// injectable for unit testing.
function exitIfConnectorsDisabled(opts = {}) {
  const exit = opts.exit || process.exit;
  const write = opts.write || ((s) => process.stderr.write(s));
  if (!isConnectorsEnabled(opts)) {
    write(connectorsDisabledMessage() + '\n');
    return exit(3);
  }
  return undefined;
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

// Standard operator-facing message printed when a connector entrypoint is invoked
// while the flag is OFF. Centralized so every connector script speaks with one voice.
function connectorsDisabledMessage() {
  return (
    'Connector support is disabled (feature flag "connectors" is OFF). ' +
    'GenPage connectors require the pac CLI connector verbs, the GenUX authoring ' +
    'control, and the maker/admin setting to all be live in PROD. To enable for a ' +
    'single run set GENPAGE_ENABLE_CONNECTORS=1, or flip "connectors" to true in ' +
    'plugins/model-apps/feature-flags.json once the dependencies are released.'
  );
}

module.exports = {
  isEnabled,
  isConnectorsEnabled,
  connectorsDisabledMessage,
  exitIfConnectorsDisabled,
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
