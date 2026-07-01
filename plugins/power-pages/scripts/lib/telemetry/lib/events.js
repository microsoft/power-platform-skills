"use strict";

// Per-field type metadata. Drives the type-aware picker so the wire payload
// always matches the Kusto column type. Types and defaults:
//
//   "string"     — Kusto column type `string`. Empty strings ARE sent (lets
//                  errorClass/errorDescription distinguish "explicit empty"
//                  from "not present"). Non-strings are dropped.
//   "int"        — Kusto column type `int`. Coerced via Number(); non-finite
//                  or negative values clamp to 0. Sent as number, not string.
//   "object"     — Kusto column type `dynamic` (JSON). Plain objects and
//                  arrays pass through; primitives, Date, RegExp, etc. are
//                  dropped to avoid Kusto type confusion. Validated here as a
//                  real object; emit-dispatcher.js re-serializes it to a JSON
//                  string just before it hits the wire (see buildEnvelope),
//                  so the Kusto side must `parse_json()` / `todynamic()` it.
//   "enum:a|b|c" — Kusto column type `string`. Only the listed values are
//                  accepted; anything else is dropped.
//
// Both `null` and `undefined` are dropped uniformly. Empty string is allowed
// only for "string" types (deliberate — see above).
const FIELD_TYPES = {
  // Common — identity / context
  pluginName: "string",
  pluginVersion: "string",
  sessionId: "string",
  correlationId: "string",
  osName: "string",
  osVersion: "string",
  nodeVersion: "string",
  // Common — PAC + agent
  orgId: "string",
  tenantId: "string",
  pacCliVersion: "string",
  aiAgentName: "string",
  aiAgentVersion: "string",
  // Common — caller-supplied dynamic JSON
  eventInfo: "object",
  // Skill
  skillName: "string",
  // Completed-only
  outcome: "enum:success|failure",
  durationMs: "int",
  errorClass: "string",
  errorDescription: "string",
};

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
const COMPLETED_FIELDS = ["outcome", "durationMs", "errorClass", "errorDescription"];

function isPlainStructured(v) {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return true;
  // Only plain objects (prototype Object.prototype or null) pass through —
  // class instances like Date, RegExp, Map, Set, and Error are rejected so
  // the dynamic `eventInfo` field can't carry unexpected shapes.
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function clampInt(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// Type-aware pick. Drops null/undefined for every type. For each kept value,
// validates against its declared type and coerces as needed.
function pick(input, keys) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const k of keys) {
    const v = input[k];
    if (v === undefined || v === null) continue;
    const type = FIELD_TYPES[k];
    if (type === "string") {
      if (typeof v === "string") out[k] = v;
    } else if (type === "int") {
      out[k] = clampInt(v);
    } else if (type === "object") {
      if (isPlainStructured(v)) out[k] = v;
    } else if (typeof type === "string" && type.startsWith("enum:")) {
      const allowed = type.slice(5).split("|");
      if (typeof v === "string" && allowed.includes(v)) out[k] = v;
    }
    // unknown types: drop (defensive — no field should hit this branch).
  }
  return out;
}

function buildEvent(envelopeName, eventName, info, severity) {
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

module.exports = {
  buildSkillStarted,
  buildSkillCompleted,
  FIELD_TYPES,
  pick,
};
