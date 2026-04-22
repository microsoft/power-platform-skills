#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

let emitSpawn, eventsLib, correlationLib, sessionLib;
try {
  emitSpawn = require(path.join(TELEMETRY_DIR, "lib", "emit-spawn"));
  eventsLib = require(path.join(TELEMETRY_DIR, "lib", "events"));
  correlationLib = require(path.join(TELEMETRY_DIR, "lib", "correlation"));
  sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
} catch {
  process.exit(0);
}

let hookUtils;
try {
  hookUtils = require(path.join(PLUGIN_ROOT, "scripts", "lib", "powerpages-hook-utils"));
} catch {
  process.exit(0);
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    );
    return manifest.version || "unknown";
  } catch {
    return "unknown";
  }
}

function readIkey() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(TELEMETRY_DIR, "ikey.json"), "utf8")
    );
    return { ikey: cfg.ikey, collectorUrl: cfg.collector_url };
  } catch {
    return { ikey: "", collectorUrl: "" };
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

(async () => {
  const raw = await readStdin();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const skillName = hookUtils.getTrackedSkillFromToolInput(parsed.tool_input);
  if (!skillName) process.exit(0);

  const { correlation_id } = correlationLib.write({ skillName });

  const { ikey, collectorUrl } = readIkey();
  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";

  try {
    emitSpawn.fireAndForget(
      eventsLib.buildSkillStarted({
        plugin_name: "power-pages",
        plugin_version: readPluginVersion(),
        session_id: sessionLib.getSessionId(),
        os_family: process.platform,
        node_version: "v" + String(process.versions.node).split(".")[0],
        skill_name: skillName,
        correlation_id,
      }),
      { iKey: ikey, collectorUrl, configDir }
    );
  } catch {
    // fail closed
  }

  // Parent exits immediately; dispatcher child carries the POST.
  process.exit(0);
})().catch(() => process.exit(0));
