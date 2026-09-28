#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTelemetryChoice, effectiveTelemetryChoice } = require("./user-config");
const { pluginLogDir, latestSessionLog } = require("./local-log");

function dataDisclosure(plugin) {
  const pluginSpecific =
    plugin === "power-pages"
      ? "   Power Pages can also record the signed-in user's Entra object ID as\n" +
        "   eventInfo.aadObjectId when PAC exposes it, and the SPA framework of the\n" +
        "   Power Pages code site being worked in as eventInfo.framework when detected.\n" +
        "   The framework is one of react, vue, angular, or astro and describes the\n" +
        "   scaffold only — it is never a site name or path.\n"
      : plugin === "model-apps"
        ? "   Model Apps excludes the signed-in user's Entra object ID.\n"
        : "";
  return (
    "ℹ️  Usage telemetry records skill, plugin, PAC, agent, OS, Node, session,\n" +
    "   and correlation fields, plus Dataverse organization and Entra tenant IDs\n" +
    "   when PAC is signed in.\n" +
    pluginSpecific +
    "   When plugin telemetry is enabled, the local diagnostic log retains the same\n" +
    "   fields even when transmission is off. A plugin whose committed telemetry\n" +
    "   config has disabled: true is hard-disabled and writes no log.\n" +
    "   Events do not include file paths, prompts, tool inputs, site names,\n" +
    "   Dataverse URLs, credentials, usernames, or hostnames."
  );
}

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
      out(dataDisclosure(plugin));
      emitLogLocations(dir, plugin);
    } else {
      out(`Telemetry (${plugin}): OFF — nothing is transmitted.`);
      out(`The local diagnostic log is kept whenever telemetry is enabled for this plugin, even when transmission is OFF (opt-out stops transmission only).`);
      emitLogLocations(dir, plugin);
      out(`Re-enable with /${plugin}:telemetry on (an environment opt-out, if set, takes precedence and this command cannot override it).`);
      out(dataDisclosure(plugin));
    }
    process.exit(0);
  }

  if (!setTelemetryChoice(dir, plugin, action)) {
    out(`Could not update the telemetry setting (config dir not writable).`);
    process.exit(1);
  }
  if (action === "off") {
    out(`Telemetry (${plugin}): OFF — nothing is transmitted.`);
    out(`The local diagnostic log is kept whenever telemetry is enabled for this plugin, even when transmission is OFF (opt-out stops transmission only).`);
    emitLogLocations(dir, plugin);
    out(`Re-enable with /${plugin}:telemetry on (an environment opt-out, if set, takes precedence and this command cannot override it).`);
  } else if (effectiveTelemetryChoice(dir, plugin) === "off") {
    // The preference was saved as ON, but the highest-precedence environment
    // opt-out still forces transmission off — report the EFFECTIVE state so we
    // never claim ON while an opt-out is suppressing it.
    out(`Telemetry (${plugin}): preference saved as ON, but an environment opt-out is currently in effect — nothing is transmitted until it is cleared.`);
  } else {
    out(`Telemetry (${plugin}): ON`);
  }
  out(dataDisclosure(plugin));
  process.exit(0);
}

main();
