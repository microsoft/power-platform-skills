"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { detectSlashCommand } = require("./prompt-detector");
const { buildSkillStarted } = require("./events");
const { getSessionId } = require("./session");
const { fireAndForget } = require("./emit-spawn");
const { readPacAuth } = require("./pac-auth");
const { readPacCliVersion, readAiAgent } = require("./agent-info");

function readIkey(telemetryDir) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(telemetryDir, "ikey.json"), "utf8")
    );
    return {
      ikey: cfg.ikey || "",
      collectorUrl: cfg.collector_url || "",
      eventStreamName: cfg.event_stream_name || "",
    };
  } catch {
    return { ikey: "", collectorUrl: "", eventStreamName: "" };
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
    _emit, // test seam; defaults to fireAndForget
    _readPacAuth, // test seam; defaults to lib/pac-auth
    _readAgentInfo, // test seam; defaults to lib/agent-info
  } = opts;

  const skillName = detectSlashCommand(promptText, { pluginName, trackedSkills });
  if (!skillName) return { emitted: false, skillName: null };

  const { ikey, collectorUrl, eventStreamName } = readIkey(telemetryDir);

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
    sessionId: getSessionId(),
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
      iKey: ikey,
      collectorUrl,
      configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "",
      fakeProbe: process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "",
    });
  } catch {
    // fail closed — telemetry never propagates errors
  }

  return { emitted: true, skillName };
}

module.exports = { emitSkillStartedFromPrompt };
