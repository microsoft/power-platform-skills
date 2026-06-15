"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { detectSlashCommand } = require("./prompt-detector");
const { buildSkillStarted } = require("./events");
const { getSessionId } = require("./session");
const { fireAndForget } = require("./emit-spawn");
const { loadResolver } = require("./resolver-loader");
const { readPacAuth } = require("./pac-auth");
const { readPacCliVersion, readAiAgent } = require("./agent-info");

function readIkey(telemetryDir) {
  // Test/override seam: POWER_PLATFORM_SKILLS_IKEY_JSON points at an alternate
  // ikey.json so tests don't have to mutate the checked-in config file.
  const override = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const ikeyPath =
    override && override.trim() ? override : path.join(telemetryDir, "ikey.json");
  const dir = path.dirname(ikeyPath);
  try {
    const cfg = JSON.parse(fs.readFileSync(ikeyPath, "utf8"));
    return { cfg, dir, ikeyPath, eventStreamName: cfg.event_stream_name || "", disabled: cfg.disabled === true };
  } catch {
    return { cfg: null, dir, ikeyPath, eventStreamName: "", disabled: false };
  }
}

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

function emitSkillStartedFromPrompt(promptText, opts = {}) {
  const {
    pluginName,
    pluginVersion,
    trackedSkills,
    telemetryDir,
    sessionId, // primed from Claude Code's hook payload (parsed.session_id)
    _emit, // test seam; defaults to fireAndForget
    _readPacAuth, // test seam; defaults to lib/pac-auth
    _readAgentInfo, // test seam; defaults to lib/agent-info
  } = opts;

  const skillName = detectSlashCommand(promptText, { pluginName, trackedSkills });
  if (!skillName) return { emitted: false, skillName: null };

  // Repo-side hard-off: short-circuit BEFORE any PAC / agent-info shellouts
  // (~3-5s combined) so a disabled or half-provisioned plugin pays effectively
  // no cost. The user opt-out is NOT checked here: the event is still built and
  // dispatched so the detached dispatcher can write the local diagnostic mirror;
  // the dispatcher reads the per-plugin config and skips the POST when opted out.
  const { cfg, dir, ikeyPath, eventStreamName, disabled } = readIkey(telemetryDir);
  if (disabled) return { emitted: false, skillName };
  // Provisioning fast-gate (generic): a plugin resolver decides "is there a key
  // worth paying the pac shellout for?"; default is "static key present".
  const resolver = loadResolver(dir);
  const provisioned =
    resolver && typeof resolver.isProvisioned === "function"
      ? resolver.isProvisioned(cfg)
      : !!(cfg && cfg.instrumentationKey);
  if (!provisioned) return { emitted: false, skillName };

  const pacReader = typeof _readPacAuth === "function" ? _readPacAuth : readPacAuth;
  let pacAuth = null;
  try {
    pacAuth = pacReader();
  } catch {
    pacAuth = null;
  }

  const agentReader =
    typeof _readAgentInfo === "function"
      ? _readAgentInfo
      : () => ({
          ...readAiAgent(),
          pacCliVersion: readPacCliVersion(),
        });
  let agentInfo;
  try {
    agentInfo = agentReader() || {};
  } catch {
    agentInfo = {};
  }

  const fields = {
    pluginName,
    pluginVersion: pluginVersion || "unknown",
    sessionId: getSessionId(sessionId),
    correlationId: crypto.randomUUID(),
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

  const event = buildSkillStarted(eventStreamName, fields);

  const emit = typeof _emit === "function" ? _emit : fireAndForget;
  try {
    emit(event, {
      cloud: (pacAuth && pacAuth.cloud) || "",
      configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "",
      fakeProbe: process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "",
      ikeyJsonPath: ikeyPath,
    });
  } catch {
    // fail closed — telemetry never propagates errors
  }

  return { emitted: true, skillName };
}

module.exports = { emitSkillStartedFromPrompt };
