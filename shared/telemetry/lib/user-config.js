"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_FILE_NAME = "config.json";

function configPath(configDir) {
  return path.join(configDir, CONFIG_FILE_NAME);
}

// Reads the whole config object; returns {} on any error (missing/corrupt).
function readConfig(configDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(configDir), "utf8"));
    // Arrays pass `typeof === "object"` but break the merge-write: setTelemetryChoice
    // would set `.telemetry` on the array and JSON.stringify would silently drop it,
    // reporting success while persisting nothing. Treat non-plain objects as empty.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Returns "on" | "off" | null (null = unset / not a valid value).
function readTelemetryChoice(configDir, pluginName) {
  if (!configDir || !pluginName) return null;
  const t = readConfig(configDir).telemetry;
  if (!t || typeof t !== "object") return null;
  const v = t[pluginName];
  return v === "on" || v === "off" ? v : null;
}

// Builds the per-plugin opt-out var name: POWER_PLATFORM_SKILLS_TELEMETRY_<PLUGIN>_OPTOUT
// where <PLUGIN> is the plugin name uppercased with non-alphanumeric runs -> "_".
function telemetryOptOutEnvVarName(pluginName) {
  return (
    "POWER_PLATFORM_SKILLS_TELEMETRY_" +
    String(pluginName).toUpperCase().replace(/[^A-Z0-9]+/g, "_") +
    "_OPTOUT"
  );
}

// True when the per-plugin opt-out env var is set to a truthy value (`1` or
// `true`, case-insensitive). Follows the dotnet `*_TELEMETRY_OPTOUT` convention:
// the var only disables — it is never used to re-enable. Unset / empty / `0` /
// `false` / anything else => not opted out. `env` is injectable so tests never
// mutate the real process.env.
function readTelemetryEnvOptOut(pluginName, env = process.env) {
  if (!pluginName) return false;
  const v = String(env[telemetryOptOutEnvVarName(pluginName)] || "").trim().toLowerCase();
  return v === "1" || v === "true";
}

// Resolves the effective on/off choice by precedence (highest first):
//   1. the env-var opt-out (when truthy => "off"; overrides everything below)
//   2. persisted config.json per-plugin choice (set via the slash skill)
//   3. null = default-on
// The env var has the highest precedence and can only force "off"; it never
// re-enables a config opt-out.
function effectiveTelemetryChoice(configDir, pluginName, env = process.env) {
  if (readTelemetryEnvOptOut(pluginName, env)) return "off";
  return readTelemetryChoice(configDir, pluginName) ?? null;
}

function isTransmissionOptedOut(configDir, pluginName, env = process.env) {
  return effectiveTelemetryChoice(configDir, pluginName, env) === "off";
}

// Merge-writes { telemetry: { [pluginName]: choice } }, preserving every other
// key. Returns true on success, false on bad input or I/O failure. Never throws.
function setTelemetryChoice(configDir, pluginName, choice) {
  if (!configDir || !pluginName) return false;
  if (choice !== "on" && choice !== "off") return false;
  try {
    fs.mkdirSync(configDir, { recursive: true });
  } catch {
    return false;
  }
  const cfg = readConfig(configDir);
  if (!cfg.telemetry || typeof cfg.telemetry !== "object") cfg.telemetry = {};
  cfg.telemetry[pluginName] = choice;
  try {
    fs.writeFileSync(configPath(configDir), JSON.stringify(cfg, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  readTelemetryChoice,
  setTelemetryChoice,
  isTransmissionOptedOut,
  telemetryOptOutEnvVarName,
  readTelemetryEnvOptOut,
  effectiveTelemetryChoice,
  CONFIG_FILE_NAME,
};
