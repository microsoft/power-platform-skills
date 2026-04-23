"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSkillStarted,
  buildSkillCompleted,
  buildScriptStarted,
  buildScriptCompleted,
} = require("../lib/events");

const common = {
  plugin_name: "power-pages",
  plugin_version: "1.2.2",
  session_id: "sess-uuid",
  os_family: "linux",
  node_version: "v22",
};

test("buildSkillStarted emits { name, data } with allowlisted fields only", () => {
  const ev = buildSkillStarted({
    ...common,
    skill_name: "create-site",
    correlation_id: "corr-1",
  });
  assert.equal(ev.name, "skill_started");
  assert.deepEqual(Object.keys(ev.data).sort(), [
    "correlation_id",
    "node_version",
    "os_family",
    "plugin_name",
    "plugin_version",
    "session_id",
    "skill_name",
  ]);
  assert.equal(ev.data.plugin_name, "power-pages");
  assert.equal(ev.data.skill_name, "create-site");
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
  assert.equal(ev.name, "skill_completed");
  assert.equal(ev.data.outcome, "success");
  assert.equal(ev.data.duration_ms, 1234);
  assert.equal(ev.data.error_class, "");
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
  assert.equal(ev.data.tenant_id, undefined);
  assert.equal(ev.data.file_path, undefined);
  assert.equal(ev.data.error_message, undefined);
});

test("buildScriptStarted shape", () => {
  const ev = buildScriptStarted({
    ...common,
    script_name: "verify-dataverse-access",
    correlation_id: "c",
  });
  assert.equal(ev.name, "script_started");
  assert.equal(ev.data.script_name, "verify-dataverse-access");
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
  assert.equal(ev.data.duration_ms, 0);
});

test("builder tolerates empty/undefined input without throwing", () => {
  assert.deepEqual(buildSkillStarted(), { name: "skill_started", data: {} });
  assert.deepEqual(buildSkillStarted({}), { name: "skill_started", data: {} });
});
