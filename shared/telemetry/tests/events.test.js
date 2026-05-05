"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSkillStarted,
  buildSkillCompleted,
  buildScriptStarted,
  buildScriptCompleted,
} = require("../lib/events");

const ENVELOPE = "PowerPagesPluginEvent";

const common = {
  pluginName: "power-pages",
  pluginVersion: "1.2.2",
  sessionId: "sess-uuid",
  correlationId: "corr-1",
  osName: "Windows",
  osVersion: "10.0.26200",
  nodeVersion: "v22",
};

test("buildSkillStarted returns top-level fields with envelope name", () => {
  const ev = buildSkillStarted(ENVELOPE, { ...common, skillName: "add-seo" });
  assert.equal(ev.name, ENVELOPE);
  assert.equal(ev.data.eventName, "skill_started");
  assert.equal(ev.data.eventType, "Trace");
  assert.equal(ev.data.severity, "Info");
  assert.equal(ev.data.pluginName, "power-pages");
  assert.equal(ev.data.skillName, "add-seo");
  assert.equal(ev.data.osName, "Windows");
  assert.equal(ev.data.osVersion, "10.0.26200");
  assert.equal(ev.data.nodeVersion, "v22");
});

test("buildSkillCompleted with success outcome → severity Info", () => {
  const ev = buildSkillCompleted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    outcome: "success",
    durationMs: 1234,
    errorClass: "",
  });
  assert.equal(ev.data.eventName, "skill_completed");
  assert.equal(ev.data.severity, "Info");
  assert.equal(ev.data.outcome, "success");
  assert.equal(ev.data.durationMs, 1234);
  assert.equal(ev.data.errorClass, "");
});

test("buildSkillCompleted with failure outcome → severity Error", () => {
  const ev = buildSkillCompleted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    outcome: "failure",
    durationMs: 50,
    errorClass: "TypeError",
  });
  assert.equal(ev.data.severity, "Error");
  assert.equal(ev.data.outcome, "failure");
  assert.equal(ev.data.errorClass, "TypeError");
});

test("buildSkillStarted drops fields not in allowlist", () => {
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    tenantId: "11111111-1111-1111-1111-111111111111",
    orgId: "22222222-2222-2222-2222-222222222222",
    leaked_field: "SHOULD_NOT_APPEAR",
    file_path: "/etc/passwd",
    error_message: "secret",
  });
  assert.equal(ev.data.tenantId, "11111111-1111-1111-1111-111111111111");
  assert.equal(ev.data.orgId, "22222222-2222-2222-2222-222222222222");
  assert.equal(ev.data.leaked_field, undefined);
  assert.equal(ev.data.file_path, undefined);
  assert.equal(ev.data.error_message, undefined);
});

test("buildScriptStarted top-level shape", () => {
  const ev = buildScriptStarted(ENVELOPE, {
    ...common,
    scriptName: "deploy-site",
  });
  assert.equal(ev.name, ENVELOPE);
  assert.equal(ev.data.eventName, "script_started");
  assert.equal(ev.data.scriptName, "deploy-site");
});

test("buildScriptCompleted clamps negative durationMs to 0", () => {
  const ev = buildScriptCompleted(ENVELOPE, {
    ...common,
    scriptName: "deploy-site",
    outcome: "failure",
    durationMs: -5,
    errorClass: "Error",
  });
  assert.equal(ev.data.durationMs, 0);
  assert.equal(ev.data.severity, "Error");
});

test("buildScriptCompleted clamps non-finite durationMs to 0", () => {
  const ev = buildScriptCompleted(ENVELOPE, {
    ...common,
    scriptName: "deploy-site",
    outcome: "success",
    durationMs: Number.NaN,
    errorClass: "",
  });
  assert.equal(ev.data.durationMs, 0);
});

test("orgId/tenantId omitted when input is missing", () => {
  const ev = buildSkillStarted(ENVELOPE, { ...common, skillName: "add-seo" });
  assert.equal(ev.data.orgId, undefined);
  assert.equal(ev.data.tenantId, undefined);
});

test("severity is Info for *_started events even when outcome=failure is supplied (started has no outcome)", () => {
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    outcome: "failure",
  });
  assert.equal(ev.data.severity, "Info");
  assert.equal(ev.data.outcome, undefined);
});

test("envelope name flows through unchanged", () => {
  const ev = buildSkillStarted("CustomPluginEvent", {
    ...common,
    skillName: "x",
  });
  assert.equal(ev.name, "CustomPluginEvent");
});

test("data has stable key set across calls (no key drift)", () => {
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: "x",
    orgId: "o",
    tenantId: "t",
    pacCliVersion: "1.36.0",
    aiAgentName: "Claude Code",
    aiAgentVersion: "2.0.0",
    eventInfo: { detail: "anything" },
  });
  const expectedKeys = [
    "aiAgentName", "aiAgentVersion",
    "correlationId", "eventInfo", "eventName", "eventType",
    "nodeVersion", "orgId", "osName", "osVersion",
    "pacCliVersion",
    "pluginName", "pluginVersion", "sessionId", "severity",
    "skillName", "tenantId",
  ];
  assert.deepEqual(Object.keys(ev.data).sort(), expectedKeys);
});

test("eventInfo passes through as a dynamic object (not stringified)", () => {
  const eventInfo = { region: "us-west", attempt: 3, nested: { a: 1 } };
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    eventInfo,
  });
  assert.equal(typeof ev.data.eventInfo, "object");
  assert.deepEqual(ev.data.eventInfo, eventInfo);
});

test("buildSkillCompleted carries errorDescription", () => {
  const ev = buildSkillCompleted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    outcome: "failure",
    durationMs: 50,
    errorClass: "TypeError",
    errorDescription: "Cannot read properties of undefined (reading 'foo')",
  });
  assert.equal(ev.data.errorDescription, "Cannot read properties of undefined (reading 'foo')");
});

test("buildScriptCompleted carries errorDescription", () => {
  const ev = buildScriptCompleted(ENVELOPE, {
    ...common,
    scriptName: "deploy-site",
    outcome: "failure",
    durationMs: 12,
    errorClass: "Error",
    errorDescription: "boom",
  });
  assert.equal(ev.data.errorDescription, "boom");
});

test("AI agent + PAC CLI version pass through when supplied", () => {
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    aiAgentName: "Claude Code",
    aiAgentVersion: "2.0.0",
    pacCliVersion: "1.36.0",
  });
  assert.equal(ev.data.aiAgentName, "Claude Code");
  assert.equal(ev.data.aiAgentVersion, "2.0.0");
  assert.equal(ev.data.pacCliVersion, "1.36.0");
});

test("errorDescription dropped from *_started events (only allowed on completed)", () => {
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: "add-seo",
    errorDescription: "should not be here",
  });
  assert.equal(ev.data.errorDescription, undefined);
});
