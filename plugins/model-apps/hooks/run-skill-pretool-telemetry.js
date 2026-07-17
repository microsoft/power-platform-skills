#!/usr/bin/env node
"use strict";

/**
 * PreToolUse(Skill) telemetry hook for the model-apps plugin.
 *
 * Emits an anonymous `skill_started` event when a tracked model-apps skill is
 * invoked via the Skill tool. Uses the shared 1DS library copied into this plugin
 * at scripts/lib/telemetry/lib. Mirrors the power-pages pretool hook — the only
 * plugin-specific bits are the pluginName ("model-apps"), the hook-utils import,
 * and this plugin's own ikey.json.
 *
 * Posture: this plugin ships ikey.json with `disabled: true` + a placeholder key,
 * so today the hook short-circuits at `if (disabled)` and emits nothing (no local
 * log, no POST). Once a real key + Kusto stream are provisioned and disabled is
 * flipped to false, the same code path emits. Every branch is fail-closed: a
 * missing lib, unreadable config, thrown resolver, or bad stdin all exit 0 so the
 * hook can never break a skill run.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

// Master kill-switch: MODEL_APPS_DISABLE_HOOKS=1 disables every model-apps hook
// (validators + telemetry emit) — an operator escape hatch. Checked before any
// requires/stdin/work so it is a clean no-op (exit 0). Telemetry also has its own
// finer-grained opt-out (ikey.json disabled, /model-apps:telemetry off, *_OPTOUT).
if (process.env.MODEL_APPS_DISABLE_HOOKS === "1" || process.env.MODEL_APPS_DISABLE_HOOKS === "true") {
  process.exit(0);
}

let emitSpawn, eventsLib, sessionLib, pacAuthLib, agentInfoLib, resolverLoader;
try {
  emitSpawn = require(path.join(TELEMETRY_DIR, "lib", "emit-spawn"));
  eventsLib = require(path.join(TELEMETRY_DIR, "lib", "events"));
  sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
  pacAuthLib = require(path.join(TELEMETRY_DIR, "lib", "pac-auth"));
  agentInfoLib = require(path.join(TELEMETRY_DIR, "lib", "agent-info"));
  resolverLoader = require(path.join(TELEMETRY_DIR, "lib", "resolver-loader"));
} catch {
  process.exit(0);
}

let hookUtils;
try {
  hookUtils = require(path.join(PLUGIN_ROOT, "scripts", "lib", "modelapps-hook-utils"));
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
  // ikey.json so tests can flip disabled/provisioned state without mutating the
  // checked-in config. Mirrors emit-dispatcher.js / emit-from-prompt.js.
  const override = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const ikeyPath =
    override && override.trim() ? override : path.join(TELEMETRY_DIR, "ikey.json");
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
  // (`pac auth who` + `pac --version`) so a disabled or unconfigured plugin costs
  // effectively nothing. The user opt-out is NOT a fast-path: the enriched event
  // is still built and dispatched so the detached dispatcher can write the local
  // diagnostic mirror; it reads the per-plugin config and skips the POST.
  const { cfg, ikeyPath, eventStreamName, disabled } = readIkey();
  if (disabled) process.exit(0);
  const resolver = resolverLoader.loadResolver(path.dirname(ikeyPath));
  let provisioned;
  try {
    provisioned =
      resolver && typeof resolver.isProvisioned === "function"
        ? resolver.isProvisioned(cfg)
        // Tier-1 static-key fallback (no resolver): a real key must be present AND
        // must not be the shipped placeholder sentinel. Without the sentinel check,
        // flipping `disabled:false` before replacing the key would still be treated
        // as provisioned — incurring the pac shellouts and a local-mirror write even
        // though the dispatcher can never POST a placeholder key. Matches the
        // dispatcher's own PLACEHOLDER_IKEY guard.
        : !!(cfg && cfg.instrumentationKey && cfg.instrumentationKey !== "PLACEHOLDER_REPLACE_BEFORE_SHIPPING");
  } catch {
    // A plugin resolver threw — treat as not provisioned so a bad resolver can't
    // crash the pretool hook and impact the tool run (fail closed).
    provisioned = false;
  }
  if (!provisioned) process.exit(0);

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
    pluginName: "model-apps",
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
  // model-apps intentionally does NOT send the Entra directory object id
  // (aadObjectId) that power-pages attaches as eventInfo — no user-level
  // identifier reaches telemetry. Org/tenant GUIDs (org-level) still flow.
  if (agentInfo.aiAgentName) fields.aiAgentName = agentInfo.aiAgentName;
  if (agentInfo.aiAgentVersion) fields.aiAgentVersion = agentInfo.aiAgentVersion;
  if (agentInfo.pacCliVersion) fields.pacCliVersion = agentInfo.pacCliVersion;

  try {
    emitSpawn.fireAndForget(eventsLib.buildSkillStarted(eventStreamName, fields), {
      cloud: (pacAuth && pacAuth.cloud) || "",
      configDir,
      fakeProbe,
      // Point the dispatcher at the same ikey.json readIkey() used — the override
      // seam when set, otherwise this plugin's real config — so a bundled library
      // copy never falls back to shared/telemetry's placeholder ikey.json.
      ikeyJsonPath: ikeyPath,
    });
  } catch {
    // fail closed
  }

  process.exit(0);
})().catch(() => process.exit(0));
