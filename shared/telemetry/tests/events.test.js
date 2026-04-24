"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSkillStarted,
  buildSkillCompleted,
  buildScriptStarted,
  buildScriptCompleted,
  COLLECTOR_EVENT_NAME,
} = require("../lib/events");

const common = {
  plugin_name: "power-pages",
  plugin_version: "1.2.2",
  session_id: "sess-uuid",
  os_family: "linux",
  node_version: "v22",
};

test("COLLECTOR_EVENT_NAME matches the annotation's CollectorEventMappingList entry", () => {
  // The tenant EventStreamingAnnotation binds iKey + envelope.name to a stream.
  // Our iKey's mapping entry is "<iKey>:VscodeEvent" — envelope.name must match.
  assert.equal(COLLECTOR_EVENT_NAME, "VscodeEvent");
});

test("buildSkillStarted emits camelCase data with stringified eventInfo", () => {
  const ev = buildSkillStarted({
    ...common,
    skill_name: "create-site",
    correlation_id: "corr-1",
  });
  assert.equal(ev.name, COLLECTOR_EVENT_NAME);
  assert.equal(ev.data.eventName, "skill_started");
  assert.equal(ev.data.eventType, "Trace");
  assert.equal(ev.data.severity, "Info");
  assert.equal(typeof ev.data.eventInfo, "string");
  const info = JSON.parse(ev.data.eventInfo);
  assert.deepEqual(Object.keys(info).sort(), [
    "correlation_id",
    "node_version",
    "os_family",
    "plugin_name",
    "plugin_version",
    "session_id",
    "skill_name",
  ]);
});

test("buildSkillCompleted includes outcome, duration_ms, error_class", () => {
  const ev = buildSkillCompleted({
    ...common,
    skill_name: "create-site",
    correlation_id: "corr-1",
    outcome: "success",
    duration_ms: 1234,
    error_class: "",
  });
  assert.equal(ev.data.eventName, "skill_completed");
  const info = JSON.parse(ev.data.eventInfo);
  assert.equal(info.outcome, "success");
  assert.equal(info.duration_ms, 1234);
  assert.equal(info.error_class, "");
});

test("builder drops unknown fields (allowlist enforcement)", () => {
  const ev = buildSkillStarted({
    ...common,
    skill_name: "x",
    correlation_id: "c",
    tenant_id: "SHOULD_NOT_APPEAR",
    file_path: "/etc/passwd",
    error_message: "nope",
  });
  const info = JSON.parse(ev.data.eventInfo);
  assert.equal(info.tenant_id, undefined);
  assert.equal(info.file_path, undefined);
  assert.equal(info.error_message, undefined);
});

test("buildScriptStarted shape", () => {
  const ev = buildScriptStarted({
    ...common,
    script_name: "verify-dataverse-access",
    correlation_id: "c",
  });
  assert.equal(ev.data.eventName, "script_started");
  const info = JSON.parse(ev.data.eventInfo);
  assert.equal(info.script_name, "verify-dataverse-access");
});

test("buildScriptCompleted enforces non-negative duration_ms", () => {
  const ev = buildScriptCompleted({
    ...common,
    script_name: "s",
    correlation_id: "c",
    outcome: "failure",
    duration_ms: -5,
    error_class: "TypeError",
  });
  const info = JSON.parse(ev.data.eventInfo);
  assert.equal(info.duration_ms, 0);
});
