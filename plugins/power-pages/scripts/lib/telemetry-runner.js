"use strict";

const path = require("node:path");
const fs = require("node:fs");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

function readPluginVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    ).version || "unknown";
  } catch {
    return "unknown";
  }
}

function loadTelemetryDeps() {
  try {
    const withTelemetry = require(path.join(TELEMETRY_DIR, "lib", "with-telemetry")).withTelemetry;
    const ikeyCfg = JSON.parse(
      fs.readFileSync(path.join(TELEMETRY_DIR, "ikey.json"), "utf8")
    );
    let pacAuth = null;
    try {
      pacAuth = require(path.join(TELEMETRY_DIR, "lib", "pac-auth")).readPacAuth();
    } catch { pacAuth = null; }
    return { withTelemetry, ikeyCfg, pacAuth };
  } catch {
    return null;
  }
}

async function runInstrumented(scriptName, asyncFn, _overrides = {}) {
  const deps = _overrides.deps || loadTelemetryDeps();
  if (!deps) return await asyncFn();

  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";

  return deps.withTelemetry(scriptName, asyncFn, {
    envelopeName: deps.ikeyCfg.event_stream_name || "",
    pluginName: "power-pages",
    pluginVersion: readPluginVersion(),
    cloud: (deps.pacAuth && deps.pacAuth.cloud) || "",
    spawnOpts: {
      // iKey + collectorUrl no longer passed — dispatcher resolves region.
      configDir,
    },
  });
}

module.exports = { runInstrumented };
