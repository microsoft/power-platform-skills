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
  CONFIG_FILE_NAME,
};
