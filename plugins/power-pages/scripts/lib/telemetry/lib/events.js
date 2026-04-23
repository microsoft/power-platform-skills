"use strict";

// Table name for the Kusto destination; the 1DS OneCollector routes events
// with `envelope.name` == this value into the matching typed table.
const COLLECTOR_EVENT_NAME = "PagesPowerPlatformExtEvent";

const COMMON_FIELDS = [
  "plugin_name",
  "plugin_version",
  "session_id",
  "os_family",
  "node_version",
  "correlation_id",
];

const SKILL_FIELDS = ["skill_name"];
const SCRIPT_FIELDS = ["script_name"];
const COMPLETED_FIELDS = ["outcome", "duration_ms", "error_class"];

function pick(input, keys) {
  const out = {};
  for (const k of keys) {
    if (input && input[k] !== undefined) {
      out[k] = input[k];
    }
  }
  return out;
}

function clampDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function envelope(eventName, info) {
  if (info.duration_ms !== undefined) {
    info.duration_ms = clampDuration(info.duration_ms);
  }
  return {
    name: COLLECTOR_EVENT_NAME,
    data: {
      EventName: eventName,
      EventType: "Trace",
      Severity: "Info",
      EventInfo: info,
    },
  };
}

function buildSkillStarted(input) {
  return envelope("skill_started", pick(input, [...COMMON_FIELDS, ...SKILL_FIELDS]));
}

function buildSkillCompleted(input) {
  return envelope(
    "skill_completed",
    pick(input, [...COMMON_FIELDS, ...SKILL_FIELDS, ...COMPLETED_FIELDS])
  );
}

function buildScriptStarted(input) {
  return envelope("script_started", pick(input, [...COMMON_FIELDS, ...SCRIPT_FIELDS]));
}

function buildScriptCompleted(input) {
  return envelope(
    "script_completed",
    pick(input, [...COMMON_FIELDS, ...SCRIPT_FIELDS, ...COMPLETED_FIELDS])
  );
}

module.exports = {
  COLLECTOR_EVENT_NAME,
  buildSkillStarted,
  buildSkillCompleted,
  buildScriptStarted,
  buildScriptCompleted,
};
