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
  envVarName,
  parseBool,
  FLAGS_PATH,
};

// CLI: `node feature-flags.js <flag>` → exit 0 (enabled) / 1 (disabled) / 2 (usage).
if (require.main === module) {
  const flag = process.argv[2];
  if (!flag) {
    process.stderr.write('Usage: node feature-flags.js <flag>\n');
    process.exit(2);
  }
  const on = isEnabled(flag);
  process.stdout.write((on ? 'enabled' : 'disabled') + '\n');
  process.exit(on ? 0 : 1);
}
