"use strict";

const COMMON_FIELDS = [
  "pluginName",
  "pluginVersion",
  "sessionId",
  "correlationId",
  "osName",
  "osVersion",
  "nodeVersion",
  "orgId",
  "tenantId",
  "pacCliVersion",
  "aiAgentName",
  "aiAgentVersion",
  "eventInfo",
];

const SKILL_FIELDS = ["skillName"];
const SCRIPT_FIELDS = ["scriptName"];
const COMPLETED_FIELDS = ["outcome", "durationMs", "errorClass", "errorDescription"];

function pick(input, keys) {
  const out = {};
  if (!input) return out;
  for (const k of keys) {
    if (input[k] !== undefined) out[k] = input[k];
  }
  return out;
}

function clampDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function buildEvent(envelopeName, eventName, info, severity) {
  if (info.durationMs !== undefined) {
    info.durationMs = clampDuration(info.durationMs);
  }
  return {
    name: envelopeName,
    data: { eventName, eventType: "Trace", severity, ...info },
  };
}

function buildSkillStarted(envelopeName, input) {
  return buildEvent(
    envelopeName,
    "skill_started",
    pick(input, [...COMMON_FIELDS, ...SKILL_FIELDS]),
    "Info"
  );
}

function buildSkillCompleted(envelopeName, input) {
  const severity = input && input.outcome === "failure" ? "Error" : "Info";
  return buildEvent(
    envelopeName,
    "skill_completed",
    pick(input, [...COMMON_FIELDS, ...SKILL_FIELDS, ...COMPLETED_FIELDS]),
    severity
  );
}

function buildScriptStarted(envelopeName, input) {
  return buildEvent(
    envelopeName,
    "script_started",
    pick(input, [...COMMON_FIELDS, ...SCRIPT_FIELDS]),
    "Info"
  );
}

function buildScriptCompleted(envelopeName, input) {
  const severity = input && input.outcome === "failure" ? "Error" : "Info";
  return buildEvent(
    envelopeName,
    "script_completed",
    pick(input, [...COMMON_FIELDS, ...SCRIPT_FIELDS, ...COMPLETED_FIELDS]),
    severity
  );
}

module.exports = {
  buildSkillStarted,
  buildSkillCompleted,
  buildScriptStarted,
  buildScriptCompleted,
};
