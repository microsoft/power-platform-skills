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

// Builds the per-plugin override var name: POWER_PLATFORM_SKILLS_TELEMETRY_<PLUGIN>
// where <PLUGIN> is the plugin name uppercased with non-alphanumeric runs -> "_".
function telemetryEnvVarName(pluginName) {
  return (
    "POWER_PLATFORM_SKILLS_TELEMETRY_" +
    String(pluginName).toUpperCase().replace(/[^A-Z0-9]+/g, "_")
  );
}

// Reads the env-var override: "on" | "off" | null (null = unset/unrecognized).
// `env` is injectable so tests never mutate the real process.env.
function readTelemetryEnvChoice(pluginName, env = process.env) {
  if (!pluginName) return null;
  const v = String(env[telemetryEnvVarName(pluginName)] || "").trim().toLowerCase();
  return v === "on" || v === "off" ? v : null;
}

function isTransmissionOptedOut(configDir, pluginName) {
  return readTelemetryChoice(configDir, pluginName) === "off";
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
  telemetryEnvVarName,
  readTelemetryEnvChoice,
  CONFIG_FILE_NAME,
};
