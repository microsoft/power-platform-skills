#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

let emitSpawn, eventsLib, sessionLib, pacAuthLib, agentInfoLib;
try {
  emitSpawn = require(path.join(TELEMETRY_DIR, "lib", "emit-spawn"));
  eventsLib = require(path.join(TELEMETRY_DIR, "lib", "events"));
  sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
  pacAuthLib = require(path.join(TELEMETRY_DIR, "lib", "pac-auth"));
  agentInfoLib = require(path.join(TELEMETRY_DIR, "lib", "agent-info"));
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
    return {
      ikey: cfg.instrumentationKey || "",
      collectorUrl: cfg.collector_url || "",
      eventStreamName: cfg.event_stream_name || "",
      disabled: cfg.disabled === true,
    };
  } catch {
    return { ikey: "", collectorUrl: "", eventStreamName: "", disabled: false };
  }
}

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
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
  // Fast-path opt-out: skip stdin read and every other side effect.
  if (process.env.POWER_PLATFORM_SKILLS_TELEMETRY === "0") process.exit(0);

  const raw = await readStdin();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const skillName = hookUtils.getTrackedSkillFromToolInput(parsed.tool_input);
  if (!skillName) process.exit(0);

  // Fast-path kill switch / unconfigured: gate BEFORE the pac shell-outs
  // (`pac auth who` ~3s + `pac --version` ~2s) so disabled / opted-out
  // hook invocations cost effectively nothing.
  const { ikey, collectorUrl, eventStreamName, disabled } = readIkey();
  if (disabled) process.exit(0);
  if (!ikey) process.exit(0);

  const correlation_id = crypto.randomUUID();

  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";
  const fakeProbe = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "";

  let pacAuth = null;
  try {
    pacAuth = pacAuthLib.readPacAuth();
  } catch {
    pacAuth = null;
  }

  let agentInfo = {};
  try {
    agentInfo = {
      ...agentInfoLib.readAiAgent(),
      pacCliVersion: agentInfoLib.readPacCliVersion(),
    };
  } catch {
    agentInfo = {};
  }

  const fields = {
    pluginName: "power-pages",
    pluginVersion: readPluginVersion(),
    sessionId: sessionLib.getSessionId(sessionLib.resolveHostSessionId(parsed)),
    correlationId: correlation_id,
    osName: osFriendlyName(process.platform),
    osVersion: os.release(),
    nodeVersion: "v" + String(process.versions.node).split(".")[0],
    skillName,
  };
  if (pacAuth && pacAuth.orgId) fields.orgId = pacAuth.orgId;
  if (pacAuth && pacAuth.tenantId) fields.tenantId = pacAuth.tenantId;
  if (agentInfo.aiAgentName) fields.aiAgentName = agentInfo.aiAgentName;
  if (agentInfo.aiAgentVersion) fields.aiAgentVersion = agentInfo.aiAgentVersion;
  if (agentInfo.pacCliVersion) fields.pacCliVersion = agentInfo.pacCliVersion;

  try {
    emitSpawn.fireAndForget(
      eventsLib.buildSkillStarted(eventStreamName, fields),
      { iKey: ikey, collectorUrl, configDir, fakeProbe }
    );
  } catch {
    // fail closed
  }

  process.exit(0);
})().catch(() => process.exit(0));
