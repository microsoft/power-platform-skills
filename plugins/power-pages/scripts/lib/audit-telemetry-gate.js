"use strict";

// Final outbound gate for audit-permissions completion telemetry.
//
// This is the LAST check before an event is handed to the bundled shared
// dispatcher (fireAndForget). That dispatcher re-filters top-level fields
// against its FIELD_TYPES allowlist, but it validates `eventInfo` only as "some
// object" and never inspects nested keys or values. Without this gate, a future
// bug that copied a finding title, table name, or path into
// `eventInfo.auditPermissions` would reach the local mirror and the collector.
//
// The gate is deliberately a VALIDATOR, not a sanitizer: it never rewrites or
// drops parts of an event. Any mismatch rejects the whole event (fail closed),
// because a partially "cleaned" event would still prove that something
// unexpected tried to get through. Error messages are fixed strings and never
// echo a rejected value, so a rejection cannot itself become a leak.
//
// Rules:
//   - only `audit_permissions_run_completed` is accepted; run start is local
//     state only and emits nothing, so no other event shape may pass
//   - envelope and top-level keys are a closed set with typed, bounded values
//   - `eventInfo` contains exactly `auditPermissions`
//   - `auditPermissions` matches an exact shape for success or failure
//   - NO free-form text anywhere in `auditPermissions`: every string must be a
//     known enum value, or a UUID v4 in the `auditRunId` slot
//   - serialized size caps on `eventInfo` and the whole event

const {
  SCORING_STATUSES,
  VERDICTS,
  validateAuditMetrics,
} = require("./audit-report-validation");

const EVENT_COMPLETED = "audit_permissions_run_completed";
const METRICS_SCHEMA_VERSION = 1;

const FAILURE_STAGES = Object.freeze([
  "site_verification",
  "configuration_gathering",
  "schema_validation",
  "relationship_discovery",
  "audit_checks",
  "scoring",
  "root_cause_attribution",
  "report_rendering",
  "report_validation",
  "metrics_validation",
  "unknown_controlled_failure",
]);

// crypto.randomUUID() always produces RFC 4122 version 4, variant 10xx, e.g.
//   5d0602d4-01f1-40e0-aa89-102b70ba4bda
// Only lowercase hex is accepted because randomUUID() never emits uppercase.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Standard context values (plugin/OS/agent versions and names) are short
// product tokens such as "2.7.2", "Mac", "25.0.0", "6.5.0-1025-azure",
// "10.0.26200", "Copilot CLI", "Claude Code". The charset excludes '/', '\',
// ':', '@', and quotes, so a path, URL, UPN, or JSON fragment cannot pass.
const CONTEXT_TOKEN_RE = /^[A-Za-z0-9 ._+-]{1,64}$/;
const NODE_MAJOR_RE = /^v[0-9]{1,3}$/;
const STREAM_NAME_RE = /^[A-Za-z0-9_]{0,64}$/;

const MAX_EVENT_INFO_BYTES = 2048;
const MAX_EVENT_BYTES = 4096;

const COMMON_KEYS = Object.freeze([
  "eventName",
  "eventType",
  "severity",
  "pluginName",
  "pluginVersion",
  "sessionId",
  "correlationId",
  "osName",
  "osVersion",
  "nodeVersion",
  "skillName",
  "eventInfo",
  "outcome",
  "durationMs",
]);
const OPTIONAL_CONTEXT_KEYS = Object.freeze(["pacCliVersion", "aiAgentName", "aiAgentVersion"]);

// Every string that may legitimately appear in `auditPermissions`, other than
// the run id. Anything else is treated as free-form text and rejected.
const ALLOWED_PAYLOAD_STRINGS = new Set([...SCORING_STATUSES, ...VERDICTS, ...FAILURE_STAGES]);

function reject(code) {
  throw new Error(`outgoing_event_rejected:${code}`);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.every((key) => allowed.has(key)) && required.every((key) => keys.includes(key));
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// Walk the payload and reject any free-form text, array, or non-finite number.
// Structure is checked separately; this is a value-level backstop that holds
// even if a structural rule were loosened by mistake.
function assertNoFreeFormValues(value, key, depth) {
  if (depth > 4) reject("payload_too_deep");
  if (typeof value === "string") {
    if (key === "auditRunId") {
      if (!UUID_V4_RE.test(value)) reject("run_id");
      return;
    }
    if (!ALLOWED_PAYLOAD_STRINGS.has(value)) reject("free_form_string");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) reject("number");
    return;
  }
  if (typeof value === "boolean") return;
  if (Array.isArray(value)) reject("array");
  if (!isPlainObject(value)) reject("value_type");
  for (const [childKey, child] of Object.entries(value)) {
    assertNoFreeFormValues(child, childKey, depth + 1);
  }
}

function assertPayloadShape(payload, outcome) {
  if (!isPlainObject(payload)) reject("payload");
  if (payload.schemaVersion !== METRICS_SCHEMA_VERSION) reject("schema_version");
  if (typeof payload.auditRunId !== "string" || !UUID_V4_RE.test(payload.auditRunId)) {
    reject("run_id");
  }

  if (outcome === "failure") {
    if (!hasExactKeys(payload, ["schemaVersion", "auditRunId", "reportGenerated", "failureStage"])) {
      reject("failure_shape");
    }
    if (payload.reportGenerated !== false) reject("failure_report_generated");
    if (!FAILURE_STAGES.includes(payload.failureStage)) reject("failure_stage");
    return;
  }

  // Success: the only route to `outcome: success` is a validated report.
  if (payload.reportGenerated !== true) reject("success_report_generated");
  const { schemaVersion, auditRunId, reportGenerated, ...metrics } = payload;
  void auditRunId;
  void reportGenerated;
  try {
    validateAuditMetrics({ schemaVersion, ...metrics });
  } catch {
    reject("success_metrics");
  }
}

function assertContext(data) {
  if (data.eventType !== "Trace") reject("event_type");
  if (data.pluginName !== "power-pages") reject("plugin_name");
  if (data.skillName !== "audit-permissions") reject("skill_name");
  if (!UUID_V4_RE.test(String(data.sessionId))) reject("session_id");
  if (!UUID_V4_RE.test(String(data.correlationId))) reject("correlation_id");
  if (!NODE_MAJOR_RE.test(String(data.nodeVersion))) reject("node_version");
  for (const key of ["pluginVersion", "osName", "osVersion"]) {
    if (typeof data[key] !== "string" || !CONTEXT_TOKEN_RE.test(data[key])) reject(key);
  }
  for (const key of OPTIONAL_CONTEXT_KEYS) {
    if (data[key] !== undefined && (typeof data[key] !== "string" || !CONTEXT_TOKEN_RE.test(data[key]))) {
      reject(key);
    }
  }
}

// Throws on any violation; returns the (unchanged) event when it is safe.
function assertSafeOutgoingEvent(event) {
  if (!hasExactKeys(event, ["name", "data"])) reject("envelope");
  if (typeof event.name !== "string" || !STREAM_NAME_RE.test(event.name)) reject("stream_name");

  const data = event.data;
  if (!isPlainObject(data)) reject("data");
  if (data.eventName !== EVENT_COMPLETED) reject("event_name");
  if (!hasExactKeys(data, COMMON_KEYS, OPTIONAL_CONTEXT_KEYS)) reject("keys");
  if (data.outcome !== "success" && data.outcome !== "failure") reject("outcome");
  if (data.severity !== (data.outcome === "failure" ? "Error" : "Info")) reject("severity");
  if (!Number.isSafeInteger(data.durationMs) || data.durationMs < 0) reject("duration");

  assertContext(data);

  if (!hasExactKeys(data.eventInfo, ["auditPermissions"])) reject("event_info");
  const payload = data.eventInfo.auditPermissions;
  assertPayloadShape(payload, data.outcome);
  assertNoFreeFormValues(payload, "", 0);

  if (byteLength(data.eventInfo) > MAX_EVENT_INFO_BYTES) reject("event_info_size");
  if (byteLength(event) > MAX_EVENT_BYTES) reject("event_size");
  return event;
}

function isSafeContextToken(value) {
  return typeof value === "string" && CONTEXT_TOKEN_RE.test(value);
}

module.exports = {
  EVENT_COMPLETED,
  FAILURE_STAGES,
  MAX_EVENT_BYTES,
  MAX_EVENT_INFO_BYTES,
  UUID_V4_RE,
  assertSafeOutgoingEvent,
  isSafeContextToken,
};
