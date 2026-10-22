#!/usr/bin/env node
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

let emitSpawn, eventsLib, sessionLib, agentInfoLib, resolverLoader, asyncExt;
try {
  emitSpawn = require(path.join(TELEMETRY_DIR, "lib", "emit-spawn"));
  eventsLib = require(path.join(TELEMETRY_DIR, "lib", "events"));
  sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
  agentInfoLib = require(path.join(TELEMETRY_DIR, "lib", "agent-info"));
  resolverLoader = require(path.join(TELEMETRY_DIR, "lib", "resolver-loader"));
  // Non-blocking, disk-cached PAC reads layered on top of the shared library,
  // which exposes only synchronous readers.
  asyncExt = require(path.join(TELEMETRY_DIR, "async-ext"));
} catch {
  process.exit(0);
}

let hookUtils;
try {
  hookUtils = require(path.join(PLUGIN_ROOT, "scripts", "lib", "pa-hook-utils"));
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
  // Test/override seam: POWER_PLATFORM_SKILLS_IKEY_JSON points at an alternate
  // ikey.json so tests can flip disabled/region state without mutating the
  // checked-in config file. Mirrors emit-dispatcher.js / emit-from-prompt.js.
  const override = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const ikeyPath =
    override && override.trim()
      ? override
      : path.join(TELEMETRY_DIR, "ikey.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(ikeyPath, "utf8"));
    return { cfg, ikeyPath, eventStreamName: cfg.event_stream_name || "", disabled: cfg.disabled === true };
  } catch {
    // ikey.json missing/unreadable → fail CLOSED (disabled: true), matching the
    // dispatcher's kill-switch semantics so a missing/corrupt config can't be
    // bypassed into an emit attempt.
    return { cfg: null, ikeyPath, eventStreamName: "", disabled: true };
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
  const raw = await readStdin();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const skillName = hookUtils.getTrackedSkillFromToolInput(parsed.tool_input);
  if (!skillName) process.exit(0);

  // Repo-side hard-off / unconfigured: gate BEFORE the pac shell-outs
  // (`pac auth who` ~3s + `pac --version` ~2s) so a disabled or unconfigured
  // plugin costs effectively nothing. The user opt-out is NOT a fast-path: the
  // enriched event is still built and dispatched so the detached dispatcher can
  // write the local diagnostic mirror; it reads the per-plugin config and skips
  // the POST. (Opting out therefore costs the same as an enabled run.)
  const { cfg, ikeyPath, eventStreamName, disabled } = readIkey();
  if (disabled) process.exit(0);
  const resolver = resolverLoader.loadResolver(path.dirname(ikeyPath));
  let provisioned;
  try {
    provisioned =
      resolver && typeof resolver.isProvisioned === "function"
        ? resolver.isProvisioned(cfg)
        : !!(cfg && cfg.instrumentationKey);
  } catch {
    // A plugin resolver threw — treat as not provisioned so a bad resolver
    // can't crash the pretool hook and impact the tool run (fail closed).
    provisioned = false;
  }
  if (!provisioned) process.exit(0);

  const correlation_id = crypto.randomUUID();

  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";
  const fakeProbe = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "";

  // Read the active PAC identity fresh on each hook invocation; only the
  // non-identity PAC version is cached on disk. Run both PAC calls in parallel.
  let pacAuth = null;
  let agentInfo = {};
  try {
    const [authResult, versionResult] = await Promise.all([
      asyncExt.readPacAuthAsync().catch(() => null),
      asyncExt.readPacCliVersionAsync().catch(() => ""),
    ]);
    pacAuth = authResult;
    agentInfo = {
      ...agentInfoLib.readAiAgent(),
      pacCliVersion: versionResult,
    };
  } catch {
    pacAuth = null;
    agentInfo = {};
  }

  const fields = {
    pluginName: "power-automate",
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
      {
        cloud: (pacAuth && pacAuth.cloud) || "",
        configDir,
        fakeProbe,
        // Point the dispatcher at the same ikey.json readIkey() used — the
        // override seam when set, otherwise this plugin's real config. This keeps
        // shared-source tests and plugin-bundled library copies from accidentally
        // falling back to shared/telemetry's placeholder ikey.json.
        ikeyJsonPath: ikeyPath,
      }
    );
  } catch {
    // fail closed
  }

  process.exit(0);
})().catch(() => process.exit(0));
