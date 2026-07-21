#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTelemetryChoice, effectiveTelemetryChoice } = require("./user-config");
const { pluginLogDir, latestSessionLog } = require("./local-log");

const ANONYMITY =
  "ℹ️  No personal data is collected. Telemetry is anonymous — it records only\n" +
  "   operational fields like skill name, plugin version, OS/Node versions,\n" +
  "   PAC CLI and agent versions, and Dataverse org/tenant IDs when available.\n" +
  "   It never includes file paths, prompts, tool inputs, site names, URLs,\n" +
  "   credentials, usernames, or hostnames.";

function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function configDir() {
  return (
    process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR ||
    path.join(os.homedir(), ".power-platform-skills")
  );
}

// --plugin wins; otherwise auto-detect from the plugin manifest 4 levels up
// (.../plugins/<plugin>/scripts/lib/telemetry/lib/telemetry-config.js).
function resolvePlugin() {
  const explicit = getArg("plugin");
  if (explicit) return explicit;
  try {
    const manifestPath = path.resolve(
      __dirname, "..", "..", "..", "..", ".claude-plugin", "plugin.json"
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.name || null;
  } catch {
    return null;
  }
}

function out(s) {
  process.stdout.write(s + "\n");
}

// Print where this plugin's local diagnostic logs live and name the newest
// session file, so a user can hand over exactly the log for the session they
// just hit a problem in. Reuses the shared layout helpers (DRY — no path logic
// is duplicated in the skill).
function emitLogLocations(dir, plugin) {
  out(`Logs directory: ${pluginLogDir(dir, plugin)}`);
  const latest = latestSessionLog(dir, plugin);
  if (latest) {
    out(`Most recent session: ${latest}`);
    out("ℹ️  Share that file when reporting an issue (it covers your latest session).");
  } else {
    out(`No local logs yet for ${plugin}.`);
  }
}

function main() {
  const action = getArg("action");
  const plugin = resolvePlugin();
  if (!plugin || !["on", "off", "status"].includes(action)) {
    out("Usage: telemetry-config.js --action <on|off|status> [--plugin <name>]");
    process.exit(2);
  }
  const dir = configDir();

  if (action === "status") {
    const on = effectiveTelemetryChoice(dir, plugin) !== "off"; // default ON; honors env override when no stored choice
    if (on) {
      out(`Telemetry (${plugin}): ON`);
      out(ANONYMITY);
      emitLogLocations(dir, plugin);
    } else {
      out(`Telemetry (${plugin}): OFF — nothing is transmitted.`);
      out(`A local diagnostic log is still kept.`);
      emitLogLocations(dir, plugin);
      out(`Re-enable anytime with /${plugin}:telemetry on.`);
      out(ANONYMITY);
    }
    process.exit(0);
  }

  if (!setTelemetryChoice(dir, plugin, action)) {
    out(`Could not update the telemetry setting (config dir not writable).`);
    process.exit(1);
  }
  if (action === "off") {
    out(`Telemetry (${plugin}): OFF — nothing is transmitted.`);
    out(`A local diagnostic log is still kept.`);
    emitLogLocations(dir, plugin);
    out(`Re-enable anytime with /${plugin}:telemetry on.`);
  } else {
    out(`Telemetry (${plugin}): ON`);
  }
  out(ANONYMITY);
  process.exit(0);
}

main();
