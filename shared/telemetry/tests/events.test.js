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

test("COLLECTOR_EVENT_NAME matches the Kusto table name", () => {
  assert.equal(COLLECTOR_EVENT_NAME, "PagesPowerPlatformExtEvent");
});

test("buildSkillStarted emits expected shape", () => {
  const ev = buildSkillStarted({
    ...common,
    skill_name: "create-site",
    correlation_id: "corr-1",
  });
  assert.equal(ev.name, COLLECTOR_EVENT_NAME);
  assert.equal(ev.data.EventName, "skill_started");
  assert.equal(ev.data.EventType, "Trace");
  assert.equal(ev.data.Severity, "Info");
  assert.deepEqual(Object.keys(ev.data.EventInfo).sort(), [
    "correlation_id",
    "node_version",
    "os_family",
    "plugin_name",
    "plugin_version",
    "session_id",
    "skill_name",
  ]);
  assert.equal(ev.data.EventInfo.plugin_name, "power-pages");
  assert.equal(ev.data.EventInfo.skill_name, "create-site");
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
  assert.equal(ev.data.EventName, "skill_completed");
  assert.equal(ev.data.EventInfo.outcome, "success");
  assert.equal(ev.data.EventInfo.duration_ms, 1234);
  assert.equal(ev.data.EventInfo.error_class, "");
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
  assert.equal(ev.data.EventInfo.tenant_id, undefined);
  assert.equal(ev.data.EventInfo.file_path, undefined);
  assert.equal(ev.data.EventInfo.error_message, undefined);
});

test("buildScriptStarted shape", () => {
  const ev = buildScriptStarted({
    ...common,
    script_name: "verify-dataverse-access",
    correlation_id: "c",
  });
  assert.equal(ev.data.EventName, "script_started");
  assert.equal(ev.data.EventInfo.script_name, "verify-dataverse-access");
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
  assert.equal(ev.data.EventInfo.duration_ms, 0);
});

test("EventInfo is an object (not a stringified JSON)", () => {
  const ev = buildSkillStarted({ ...common, skill_name: "x", correlation_id: "c" });
  assert.equal(typeof ev.data.EventInfo, "object");
  assert.ok(!Array.isArray(ev.data.EventInfo));
});
