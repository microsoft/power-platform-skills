#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTelemetryChoice, effectiveTelemetryChoice } = require("./user-config");

const ANONYMITY =
  "ℹ️  No personal data is collected. Telemetry is anonymous — it records only\n" +
  "   things like skill name, plugin version, OS, and Node version. It never\n" +
  "   includes file paths, prompts, tool inputs, site names, URLs, credentials,\n" +
  "   usernames, or hostnames.";

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

function logPath() {
  return path.join(configDir(), "events.jsonl");
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
      out(`Local log: ${logPath()}`);
    } else {
      out(`Telemetry (${plugin}): OFF — nothing is transmitted.`);
      out(`A local diagnostic log is still kept at ${logPath()}.`);
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
    out(`A local diagnostic log is still kept at ${logPath()}.`);
    out(`Re-enable anytime with /${plugin}:telemetry on.`);
  } else {
    out(`Telemetry (${plugin}): ON`);
  }
  out(ANONYMITY);
  process.exit(0);
}

main();
