"use strict";

const PLUGIN_NAME = "power-apps-mobile-extension";
const STREAM_NAME = "event";
const TRACKED_SKILLS = Object.freeze([
  "design-native-extension-feature",
  "generate-native-extension",
  "generate-pcf-companion",
  "test-native-extension",
  "generate-ppmplugin",
  "publish-pcf-companion",
  "debug-extension",
  "generate-ppmplugin-manifest",
  "build-android-binary",
  "build-ios-binary",
  "assemble-ppmplugin",
  "audit-ppmplugin",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^v?\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/;
const AGENTS = new Set([
  "Claude Code", "Copilot CLI", "GitHub Copilot", "GitHub Copilot CLI",
  "Codex", "OpenCode", "Hermes", "OpenClaw",
]);

function matches(value, pattern, maxLength = 128) {
  return typeof value === "string" && value.length <= maxLength && pattern.test(value);
}

function sanitizeData(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (input.pluginName !== PLUGIN_NAME || input.eventName !== "skill_started" ||
      input.eventType !== "Trace" || input.severity !== "Info" ||
      !TRACKED_SKILLS.includes(input.skillName) ||
      !matches(input.pluginVersion, VERSION, 64) ||
      !matches(input.sessionId, /^[A-Za-z0-9_-]+$/) ||
      !matches(input.correlationId, UUID) ||
      !["Windows", "Mac", "Linux"].includes(input.osName) ||
      !matches(input.osVersion, /^[0-9][A-Za-z0-9._+-]*$/, 80) ||
      !matches(input.nodeVersion, /^v\d+$/, 16)) return null;

  const data = {
    eventName: "skill_started",
    eventType: "Trace",
    severity: "Info",
    pluginName: PLUGIN_NAME,
    pluginVersion: input.pluginVersion,
    skillName: input.skillName,
    sessionId: input.sessionId,
    correlationId: input.correlationId,
    osName: input.osName,
    osVersion: input.osVersion,
    nodeVersion: input.nodeVersion,
  };
  for (const key of ["orgId", "tenantId"]) {
    if (matches(input[key], UUID)) data[key] = input[key];
  }
  if (AGENTS.has(input.aiAgentName)) data.aiAgentName = input.aiAgentName;
  if (data.aiAgentName && matches(input.aiAgentVersion, VERSION, 64)) {
    data.aiAgentVersion = input.aiAgentVersion;
  }
  if (matches(input.pacCliVersion, VERSION, 64)) data.pacCliVersion = input.pacCliVersion;
  if (input.eventInfo && !Array.isArray(input.eventInfo) &&
      matches(input.eventInfo.aadObjectId, UUID)) {
    data.eventInfo = { aadObjectId: input.eventInfo.aadObjectId };
  }
  return data;
}

function buildEnvelope(data, time, instrumentationKey) {
  const sanitized = sanitizeData(data);
  if (!sanitized || !Number.isFinite(Date.parse(time))) return null;
  const { eventName, ...dimensions } = sanitized;
  return {
    ver: "4.0",
    name: STREAM_NAME,
    time,
    iKey: "o:" + instrumentationKey.split("-")[0],
    data: {
      clientType: PLUGIN_NAME,
      event_Name: eventName,
      timestamp: time,
      session_Id: sanitized.sessionId,
      customDimensions: JSON.stringify(dimensions),
    },
  };
}

module.exports = { PLUGIN_NAME, STREAM_NAME, TRACKED_SKILLS, UUID, sanitizeData, buildEnvelope };
