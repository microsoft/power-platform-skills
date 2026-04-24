"use strict";

// 1DS envelope `name` — this is a routing token that the tenant-side
// EventStreamingAnnotation binds to an output stream. The iKey + envelope.name
// tuple must appear in the annotation's CollectorEventMappingList or events
// will be dropped silently after OneCollector returns acc:1 (wire-layer ack).
//
// For this tenant, the annotation is:
//   name="^PowerPlatformExtensionEvent$"
//   CollectorEventMappingList: "ffdb4c99...:VscodeEvent"
// so events land in the PowerPlatformExtensionEvent Kusto table.
const COLLECTOR_EVENT_NAME = "VscodeEvent";

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

// Shape matches the 1ds-core-js SDK convention used by the power-platform
// VSCode extension: camelCase data keys, stringified `eventInfo`. The Kusto
// ingestion mapping populates PascalCase columns (EventName, EventType, etc.)
// from these camelCase payload keys.
function envelope(eventName, info) {
  if (info.duration_ms !== undefined) {
    info.duration_ms = clampDuration(info.duration_ms);
  }
  return {
    name: COLLECTOR_EVENT_NAME,
    data: {
      eventName: eventName,
      eventType: "Trace",
      severity: "Info",
      eventInfo: JSON.stringify(info),
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
