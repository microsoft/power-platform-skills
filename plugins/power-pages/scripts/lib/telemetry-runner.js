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
    return {
      withTelemetry: require(path.join(TELEMETRY_DIR, "lib", "with-telemetry"))
        .withTelemetry,
      ikeyCfg: JSON.parse(
        fs.readFileSync(path.join(TELEMETRY_DIR, "ikey.json"), "utf8")
      ),
    };
  } catch {
    return null;
  }
}

async function runInstrumented(scriptName, asyncFn) {
  const deps = loadTelemetryDeps();
  if (!deps) return asyncFn();

  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";

  return deps.withTelemetry(scriptName, asyncFn, {
    pluginName: "power-pages",
    pluginVersion: readPluginVersion(),
    spawnOpts: {
      iKey: deps.ikeyCfg.ikey,
      collectorUrl: deps.ikeyCfg.collector_url,
      configDir,
    },
  });
}

module.exports = { runInstrumented };
