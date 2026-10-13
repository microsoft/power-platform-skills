"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { deriveAuditMetrics } = require("../lib/audit-report-validation");
const {
  MAX_EVENT_INFO_BYTES,
  assertSafeOutgoingEvent,
} = require("../lib/audit-telemetry-gate");
const {
  beginRun,
  buildCompletionEvent,
  completeRun,
} = require("../emit-audit-permissions-telemetry");

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CORRELATION_ID = "33333333-3333-4333-8333-333333333333";
const SECRET = "SITE_SECRET_123";

function context(eventInfo, outcome, durationMs) {
  return {
    pluginName: "power-pages",
    pluginVersion: "2.7.2",
    sessionId: SESSION_ID,
    correlationId: CORRELATION_ID,
    osName: "Mac",
    osVersion: "25.0.0",
    nodeVersion: "v22",
    skillName: "audit-permissions",
    aiAgentName: "Copilot CLI",
    aiAgentVersion: "1.0.3",
    eventInfo,
    outcome,
    durationMs,
  };
}

function metricsData() {
  return {
    FINDINGS_DATA: [
      {
        id: "AH1",
        severity: "major",
        dimension: "anonymous-access-hygiene",
        title: "t",
        reasoning: "r",
        fix: "f",
        rootCause: "permissions",
        rootCauseReason: "x",
      },
    ],
    SCORECARD_DATA: {
      categories: [
        { name: "Over-Exposure (Security)", score: 4.21 },
        { name: "Under-Exposure (Usability & Coverage)", score: 5 },
        { name: "Correctness (Validity & Alignment)", score: 5 },
      ],
    },
  };
}

function successEvent() {
  const auditPermissions = {
    schemaVersion: 1,
    auditRunId: RUN_ID,
    reportGenerated: true,
    ...deriveAuditMetrics(metricsData()),
  };
  return buildCompletionEvent(
    "PagesAIPluginEvent",
    context({ auditPermissions }, "success", 42731)
  );
}

function failureEvent() {
  return buildCompletionEvent(
    "PagesAIPluginEvent",
    context(
      {
        auditPermissions: {
          schemaVersion: 1,
          auditRunId: RUN_ID,
          reportGenerated: false,
          failureStage: "report_validation",
        },
      },
      "failure",
      9124
    )
  );
}

function rejects(mutate, label) {
  for (const make of [successEvent, failureEvent]) {
    const event = make();
    const applied = mutate(event);
    if (applied === false) continue;
    assert.throws(
      () => assertSafeOutgoingEvent(event),
      (error) => {
        assert.match(error.message, /^outgoing_event_rejected:[A-Za-z_]+$/, label);
        assert.doesNotMatch(error.message, new RegExp(SECRET), `${label}: message must not echo values`);
        return true;
      },
      label
    );
  }
}

test("accepts the real success and failure completion events", () => {
  assert.doesNotThrow(() => assertSafeOutgoingEvent(successEvent()));
  assert.doesNotThrow(() => assertSafeOutgoingEvent(failureEvent()));
});

test("rejects extra keys at every level", () => {
  rejects((e) => { e.siteName = SECRET; }, "envelope key");
  rejects((e) => { e.data.siteName = SECRET; }, "top-level key");
  rejects((e) => { e.data.orgId = RUN_ID; }, "orgId");
  rejects((e) => { e.data.tenantId = RUN_ID; }, "tenantId");
  rejects((e) => { e.data.eventInfo.framework = "react"; }, "eventInfo.framework");
  rejects((e) => { e.data.eventInfo.aadObjectId = RUN_ID; }, "eventInfo.aadObjectId");
  rejects((e) => { e.data.eventInfo.auditPermissions.table = SECRET; }, "payload key");
  rejects((e) => {
    if (!e.data.eventInfo.auditPermissions.dimensions) return false;
    e.data.eventInfo.auditPermissions.dimensions.tableCoverage.table = SECRET;
    return true;
  }, "nested payload key");
});

test("rejects free-form text in enum and identifier slots", () => {
  rejects((e) => {
    if (!e.data.eventInfo.auditPermissions.verdict) return false;
    e.data.eventInfo.auditPermissions.verdict = SECRET;
    return true;
  }, "verdict text");
  rejects((e) => {
    if (e.data.outcome !== "failure") return false;
    e.data.eventInfo.auditPermissions.failureStage = SECRET;
    return true;
  }, "failureStage text");
  rejects((e) => { e.data.eventInfo.auditPermissions.auditRunId = SECRET; }, "run id text");
  rejects((e) => {
    e.data.eventInfo.auditPermissions.auditRunId = "11111111-1111-1111-8111-111111111111";
  }, "non-v4 run id");
  rejects((e) => { e.data.sessionId = SECRET; }, "session id text");
  rejects((e) => { e.data.correlationId = SECRET; }, "correlation id text");
});

test("rejects paths, URLs, and UPNs in standard context fields", () => {
  rejects((e) => { e.data.osVersion = "/Users/maker/contoso-site"; }, "path");
  rejects((e) => { e.data.aiAgentName = "https://private.example"; }, "url");
  rejects((e) => { e.data.pluginVersion = "maker@contoso.onmicrosoft.com"; }, "upn");
  rejects((e) => { e.data.nodeVersion = "v22 /tmp"; }, "node version");
  rejects((e) => { e.name = "Pages/Event"; }, "stream name");
});

test("rejects arrays, bad numbers, and wrong value types", () => {
  rejects((e) => { e.data.eventInfo.auditPermissions.extra = [SECRET]; }, "array");
  rejects((e) => {
    if (e.data.outcome !== "success") return false;
    e.data.eventInfo.auditPermissions.majorIssueCount = -1;
    return true;
  }, "negative count");
  rejects((e) => {
    if (e.data.outcome !== "success") return false;
    e.data.eventInfo.auditPermissions.scores.overExposure = Number.NaN;
    return true;
  }, "NaN score");
  rejects((e) => { e.data.durationMs = -5; }, "negative duration");
  rejects((e) => { e.data.durationMs = 1.5; }, "fractional duration");
  rejects((e) => { e.data.eventInfo = SECRET; }, "eventInfo string");
});

test("rejects inconsistent lifecycle combinations", () => {
  rejects((e) => { e.data.eventName = "audit_permissions_run_started"; }, "start event");
  rejects((e) => { e.data.eventName = "skill_started"; }, "other event");
  rejects((e) => {
    e.data.outcome = e.data.outcome === "success" ? "failure" : "success";
  }, "outcome/payload mismatch");
  rejects((e) => { e.data.severity = e.data.severity === "Info" ? "Error" : "Info"; }, "severity");
  rejects((e) => {
    if (e.data.outcome !== "success") return false;
    e.data.eventInfo.auditPermissions.reportGenerated = false;
    return true;
  }, "success without report");
});

test("worst-case realistic success payload stays inside the size budget", () => {
  const event = successEvent();
  const payload = event.data.eventInfo.auditPermissions;
  // Large counters are the only way a valid payload grows.
  for (const map of [payload.categories, payload.dimensions]) {
    for (const counts of Object.values(map)) {
      counts.major = 999999;
      counts.minor = 999999;
    }
  }
  const size = Buffer.byteLength(JSON.stringify(event.data.eventInfo), "utf8");
  assert.ok(size < MAX_EVENT_INFO_BYTES, `payload ${size} bytes must stay below ${MAX_EVENT_INFO_BYTES}`);
});

function makeTempEnv(t, streamName) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-gate-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ikeyPath = path.join(dir, "ikey.json");
  const writeIkey = (name) => fs.writeFileSync(
    ikeyPath,
    JSON.stringify({ disabled: false, event_stream_name: name }),
    "utf8"
  );
  writeIkey(streamName);
  return {
    dir,
    writeIkey,
    env: { POWER_PLATFORM_SKILLS_CONFIG_DIR: dir, POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath },
  };
}

test("a gate rejection sends nothing and does not consume the run", (t) => {
  // An invalid stream name makes the otherwise-valid event fail the gate.
  const { dir, env, writeIkey } = makeTempEnv(t, "Pages/Event");
  const emitted = [];
  const emit = (event) => emitted.push(event);
  let next = 0;
  const ids = [RUN_ID, SESSION_ID];
  beginRun({ env, randomUUID: () => ids[next++], monotonicNow: () => 1_000_000_000n });

  assert.throws(
    () => completeRun(
      { runId: RUN_ID, outcome: "failure", failureStage: "audit_checks" },
      { env, emit, monotonicNow: () => 2_000_000_000n }
    ),
    /outgoing_event_rejected:stream_name/
  );
  assert.equal(emitted.length, 0, "a rejected event must never reach the dispatcher");
  assert.equal(
    fs.existsSync(path.join(dir, "telemetry", "power-pages", "audit-runs", `${RUN_ID}.completed`)),
    false,
    "a rejected event must not claim the completion slot"
  );

  writeIkey("PagesAIPluginEvent");
  const completed = completeRun(
    { runId: RUN_ID, outcome: "failure", failureStage: "audit_checks" },
    { env, emit, monotonicNow: () => 2_000_000_000n }
  );
  assert.equal(completed.outcome, "failure");
  assert.equal(emitted.length, 1);
});

test("an unsafe host agent name is omitted rather than leaked or blocking the event", (t) => {
  const { env } = makeTempEnv(t, "PagesAIPluginEvent");
  const previous = { name: process.env.AI_AGENT_NAME, version: process.env.AI_AGENT_VERSION };
  process.env.AI_AGENT_NAME = `/Users/maker/${SECRET}`;
  process.env.AI_AGENT_VERSION = "1.0.0";
  t.after(() => {
    for (const [key, value] of [["AI_AGENT_NAME", previous.name], ["AI_AGENT_VERSION", previous.version]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const emitted = [];
  const emit = (event) => emitted.push(event);
  let next = 0;
  const ids = [RUN_ID, SESSION_ID];
  beginRun({ env, randomUUID: () => ids[next++], monotonicNow: () => 1_000_000_000n });
  completeRun(
    { runId: RUN_ID, outcome: "failure", failureStage: "audit_checks" },
    { env, emit, monotonicNow: () => 2_000_000_000n }
  );

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].data.aiAgentName, undefined);
  assert.equal(emitted[0].data.aiAgentVersion, "1.0.0");
  assert.doesNotMatch(JSON.stringify(emitted[0]), new RegExp(SECRET));
});
