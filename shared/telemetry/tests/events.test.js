"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildSkillStarted,
  buildSkillCompleted,
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

// ---------------------------------------------------------------------------
// Type-safety tests — every column gets the right type or is dropped.
// ---------------------------------------------------------------------------

test("string fields drop non-string values (no silent coercion to '42' etc.)", () => {
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: 42, // wrong type
    pluginName: { not: "a string" }, // wrong type
    pluginVersion: ["1.0"], // wrong type
  });
  assert.equal(ev.data.skillName, undefined);
  assert.equal(ev.data.pluginName, undefined);
  // pluginVersion was set in `common` to "1.2.2" but caller passed array;
  // the array overwrites and gets dropped, so field is undefined.
  assert.equal(ev.data.pluginVersion, undefined);
});

test("string fields preserve empty strings (intentional for errorClass/errorDescription)", () => {
  const ev = buildSkillCompleted(ENVELOPE, {
    ...common,
    skillName: "x",
    outcome: "success",
    durationMs: 0,
    errorClass: "",
    errorDescription: "",
  });
  assert.equal(ev.data.errorClass, "");
  assert.equal(ev.data.errorDescription, "");
});

test("durationMs always lands as a non-negative integer (number type)", () => {
  const cases = [
    { input: 1234, expect: 1234 },
    { input: 1234.7, expect: 1234 }, // floor
    { input: -5, expect: 0 }, // negative clamp
    { input: Number.NaN, expect: 0 },
    { input: Number.POSITIVE_INFINITY, expect: 0 },
    { input: "1234", expect: 1234 }, // string-int coerced
    { input: "abc", expect: 0 }, // unparseable → 0
    { input: "", expect: 0 }, // empty string → 0 (NOT '' on the wire)
    { input: true, expect: 1 }, // boolean true coerces to 1 — drop guarded by clamp
  ];
  for (const { input, expect } of cases) {
    const ev = buildSkillCompleted(ENVELOPE, {
      ...common,
      skillName: "x",
      outcome: "success",
      durationMs: input,
      errorClass: "",
    });
    assert.equal(typeof ev.data.durationMs, "number", `input=${String(input)}`);
    assert.equal(ev.data.durationMs, expect, `input=${String(input)}`);
  }
});

test("durationMs absent when caller does not provide", () => {
  const ev = buildSkillCompleted(ENVELOPE, {
    ...common,
    skillName: "x",
    outcome: "success",
    errorClass: "",
  });
  // Field absent → Kusto column will be null. Better than sending 0 by default.
  assert.equal(ev.data.durationMs, undefined);
});

test("eventInfo drops non-object values (no Kusto dynamic-type confusion)", () => {
  const cases = [
    "a string", // strings rejected
    42,         // numbers rejected
    true,       // booleans rejected
    new Date(), // Date rejected
    /regex/,    // RegExp rejected
  ];
  for (const v of cases) {
    const ev = buildSkillStarted(ENVELOPE, {
      ...common,
      skillName: "x",
      eventInfo: v,
    });
    assert.equal(ev.data.eventInfo, undefined, `input=${String(v)}`);
  }
});

test("eventInfo accepts arrays (valid JSON for dynamic column)", () => {
  const ev = buildSkillStarted(ENVELOPE, {
    ...common,
    skillName: "x",
    eventInfo: [1, 2, 3],
  });
  assert.deepEqual(ev.data.eventInfo, [1, 2, 3]);
});

test("outcome enforces enum: only 'success' or 'failure' pass through", () => {
  const okSuccess = buildSkillCompleted(ENVELOPE, {
    ...common, skillName: "x", outcome: "success", errorClass: "",
  });
  const okFailure = buildSkillCompleted(ENVELOPE, {
    ...common, skillName: "x", outcome: "failure", errorClass: "",
  });
  const bogus = buildSkillCompleted(ENVELOPE, {
    ...common, skillName: "x", outcome: "weird", errorClass: "",
  });
  const numeric = buildSkillCompleted(ENVELOPE, {
    ...common, skillName: "x", outcome: 1, errorClass: "",
  });
  assert.equal(okSuccess.data.outcome, "success");
  assert.equal(okFailure.data.outcome, "failure");
  assert.equal(bogus.data.outcome, undefined);
  assert.equal(numeric.data.outcome, undefined);
});

test("null and undefined dropped uniformly across all types", () => {
  const ev = buildSkillCompleted(ENVELOPE, {
    pluginName: null,
    pluginVersion: undefined,
    sessionId: null,
    skillName: null,
    durationMs: null,
    outcome: null,
    eventInfo: null,
    errorClass: null,
    errorDescription: undefined,
  });
  assert.equal(ev.data.pluginName, undefined);
  assert.equal(ev.data.pluginVersion, undefined);
  assert.equal(ev.data.sessionId, undefined);
  assert.equal(ev.data.skillName, undefined);
  assert.equal(ev.data.durationMs, undefined);
  assert.equal(ev.data.outcome, undefined);
  assert.equal(ev.data.eventInfo, undefined);
  assert.equal(ev.data.errorClass, undefined);
  assert.equal(ev.data.errorDescription, undefined);
});

test("severity defaults to Info when outcome is dropped (invalid enum)", () => {
  // Even if outcome is a non-enum value, severity should fall back to Info,
  // not crash.
  const ev = buildSkillCompleted(ENVELOPE, {
    ...common, skillName: "x", outcome: "weird-value", errorClass: "",
  });
  assert.equal(ev.data.severity, "Info");
});

test("FIELD_TYPES is exported and covers every field used in builders", () => {
  const { FIELD_TYPES } = require("../lib/events");
  const usedFields = [
    "pluginName", "pluginVersion", "sessionId", "correlationId",
    "osName", "osVersion", "nodeVersion",
    "orgId", "tenantId", "pacCliVersion", "aiAgentName", "aiAgentVersion",
    "eventInfo",
    "skillName",
    "outcome", "durationMs", "errorClass", "errorDescription",
  ];
  for (const f of usedFields) {
    assert.ok(FIELD_TYPES[f], `FIELD_TYPES missing entry for "${f}"`);
  }
});
