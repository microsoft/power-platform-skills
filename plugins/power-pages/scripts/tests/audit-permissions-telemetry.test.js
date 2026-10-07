"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  deriveAuditMetrics,
  validateAuditMetrics,
} = require("../lib/audit-report-validation");
const {
  beginRun,
  completeRun,
} = require("../emit-audit-permissions-telemetry");

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const SCRIPT_PATH = path.join(__dirname, "..", "emit-audit-permissions-telemetry.js");
const PRIVATE_SENTINELS = [
  "SITE_SECRET_123",
  "TABLE_SECRET_123",
  "ROLE_SECRET_123",
  "/private/site/path",
  "https://private.example",
];

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-telemetry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ikeyPath = path.join(dir, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      disabled: false,
      event_stream_name: "PagesAIPluginEvent",
      instrumentationKey: "test-key",
      collector_url: "https://example.invalid/OneCollector/1.0/",
    }),
    "utf8"
  );
  return {
    dir,
    env: {
      POWER_PLATFORM_SKILLS_CONFIG_DIR: dir,
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
    },
  };
}

function findings() {
  return [
    {
      id: "AH1",
      severity: "major",
      dimension: "anonymous-access-hygiene",
      title: `Public access to ${PRIVATE_SENTINELS[1]}`,
      table: PRIVATE_SENTINELS[1],
      permission: PRIVATE_SENTINELS[2],
      reasoning: `Found in ${PRIVATE_SENTINELS[3]}`,
      fix: `Review ${PRIVATE_SENTINELS[4]}`,
      details: PRIVATE_SENTINELS[0],
      rootCause: "permissions",
      rootCauseReason: `Permission references ${PRIVATE_SENTINELS[2]}`,
    },
    {
      id: "IS1",
      severity: "minor",
      dimension: "internal-consistency",
      title: "Missing plan",
      reasoning: "The plan is missing.",
      fix: "Create the plan.",
    },
  ];
}

function scorecard() {
  return {
    categories: [
      { name: "Over-Exposure (Security)", score: 4.21 },
      { name: "Under-Exposure (Usability & Coverage)", score: 5 },
      { name: "Correctness (Validity & Alignment)", score: 4.8 },
    ],
    reportPaths: [{ label: PRIVATE_SENTINELS[0], path: PRIVATE_SENTINELS[3] }],
  };
}

function auditData() {
  return {
    SITE_NAME: PRIVATE_SENTINELS[0],
    AUDIT_DESC: PRIVATE_SENTINELS[4],
    SUMMARY: PRIVATE_SENTINELS[2],
    FINDINGS_DATA: findings(),
    INVENTORY_DATA: [{
      name: PRIVATE_SENTINELS[2],
      table: PRIVATE_SENTINELS[1],
      roles: [PRIVATE_SENTINELS[2]],
    }],
    SCORECARD_DATA: scorecard(),
  };
}

function reportHtml(data) {
  return "<!doctype html><html><body>" +
    '<div id="summaryBox">Sensitive access exists. Needs revision.</div>' +
    "<script>\n" +
    `const FINDINGS = ${JSON.stringify(data.FINDINGS_DATA)};\n` +
    `const INVENTORY = ${JSON.stringify(data.INVENTORY_DATA)};\n` +
    `const SCORECARD = ${JSON.stringify(data.SCORECARD_DATA)};\n` +
    "</script></body></html>";
}

function writeAuditArtifacts(dir, data = auditData()) {
  const dataPath = path.join(dir, "audit-data.json");
  const reportPath = path.join(dir, "permissions-audit.html");
  fs.writeFileSync(dataPath, JSON.stringify(data), "utf8");
  fs.writeFileSync(reportPath, reportHtml(data), "utf8");
  return { dataPath, reportPath };
}

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++];
}

function sleep(ms) {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(wait, 0, 0, ms);
}

function latestMirror(configDir) {
  const sessionsDir = path.join(configDir, "telemetry", "power-pages", "sessions");
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(sessionsDir, entry.name, "events.jsonl");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function waitForMirror(configDir, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let mirror = latestMirror(configDir);
  while (!mirror && Date.now() < deadline) {
    sleep(25);
    mirror = latestMirror(configDir);
  }
  return mirror;
}

test("derives a closed aggregate metric shape without private report values", () => {
  const metrics = deriveAuditMetrics(auditData());
  assert.deepEqual(metrics.categories, {
    overExposure: { major: 1, minor: 0 },
    underExposure: { major: 0, minor: 0 },
    correctness: { major: 0, minor: 1 },
  });
  assert.equal(metrics.majorRootCauses.permissions, 1);
  assert.equal(metrics.scores.overExposure, 4.21);
  const serialized = JSON.stringify(metrics);
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.doesNotMatch(serialized, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.throws(
    () => validateAuditMetrics({ ...metrics, siteName: PRIVATE_SENTINELS[0] }),
    /invalid properties/
  );
});

test("emits correlated start and successful completion with measured duration", (t) => {
  const { dir, env } = makeTempDir(t);
  const { dataPath, reportPath } = writeAuditArtifacts(dir);
  const emitted = [];
  const emit = (event, options) => emitted.push({ event, options });

  const started = beginRun({
    env,
    emit,
    randomUUID: uuidSequence(RUN_ID, SESSION_ID),
    monotonicNow: () => 1_000_000_000n,
    wallClockNow: () => 1_000,
  });
  const completed = completeRun({
    runId: started.auditRunId,
    outcome: "success",
    data: dataPath,
    report: reportPath,
  }, {
    env,
    emit,
    monotonicNow: () => 3_500_000_000n,
  });

  assert.equal(completed.outcome, "success");
  assert.equal(completed.reportGenerated, true);
  assert.equal(completed.durationMs, 2500);
  assert.equal(emitted.length, 2);

  const start = emitted[0];
  const terminal = emitted[1];
  assert.equal(start.event.data.eventName, "audit_permissions_run_started");
  assert.equal(terminal.event.data.eventName, "audit_permissions_run_completed");
  assert.equal(start.event.data.eventInfo.auditPermissions.auditRunId, RUN_ID);
  assert.equal(terminal.event.data.eventInfo.auditPermissions.auditRunId, RUN_ID);
  assert.notEqual(start.event.data.correlationId, terminal.event.data.correlationId);
  assert.equal(terminal.event.data.outcome, "success");
  assert.equal(terminal.event.data.durationMs, 2500);
  assert.equal(start.options.cloud, "");
  assert.equal(terminal.options.cloud, "");
  assert.equal("routingOrgId" in start.options, false);
  assert.equal("routingOrgId" in terminal.options, false);

  const serialized = JSON.stringify(emitted.map(({ event }) => event));
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.doesNotMatch(serialized, new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("emits a closed failure payload and rejects a duplicate completion", (t) => {
  const { env } = makeTempDir(t);
  const emitted = [];
  const emit = (event) => emitted.push(event);
  beginRun({
    env,
    emit,
    randomUUID: uuidSequence(RUN_ID, SESSION_ID),
    monotonicNow: () => 5_000_000_000n,
  });
  const completed = completeRun({
    runId: RUN_ID,
    outcome: "failure",
    failureStage: "report_rendering",
  }, {
    env,
    emit,
    monotonicNow: () => 5_750_000_000n,
  });
  assert.deepEqual(completed, {
    auditRunId: RUN_ID,
    durationMs: 750,
    outcome: "failure",
    reportGenerated: false,
  });
  const payload = emitted[1].data.eventInfo.auditPermissions;
  assert.deepEqual(payload, {
    schemaVersion: 1,
    auditRunId: RUN_ID,
    reportGenerated: false,
    failureStage: "report_rendering",
  });
  assert.throws(
    () => completeRun({
      runId: RUN_ID,
      outcome: "failure",
      failureStage: "report_rendering",
    }, {
      env,
      emit,
      monotonicNow: () => 6_000_000_000n,
    }),
    (error) => error && error.code === "EEXIST"
  );
});

test("converts invalid success metrics into a fixed metrics-validation failure", (t) => {
  const { dir, env } = makeTempDir(t);
  const data = auditData();
  const artifacts = writeAuditArtifacts(dir, data);
  data.SCORECARD_DATA.categories[0].score = 5;
  fs.writeFileSync(artifacts.dataPath, JSON.stringify(data), "utf8");
  const emitted = [];
  beginRun({
    env,
    emit: (event) => emitted.push(event),
    randomUUID: uuidSequence(RUN_ID, SESSION_ID),
    monotonicNow: () => 10_000_000_000n,
  });
  const completed = completeRun({
    runId: RUN_ID,
    outcome: "success",
    data: artifacts.dataPath,
    report: artifacts.reportPath,
  }, {
    env,
    emit: (event) => emitted.push(event),
    monotonicNow: () => 11_000_000_000n,
  });
  assert.equal(completed.outcome, "failure");
  assert.equal(completed.reportGenerated, false);
  assert.equal(
    emitted[1].data.eventInfo.auditPermissions.failureStage,
    "metrics_validation"
  );
  assert.equal(emitted[1].data.eventInfo.auditPermissions.scores, undefined);
});

test("an invalid completion does not consume the run, so a corrected retry still records it", (t) => {
  const { env } = makeTempDir(t);
  const emitted = [];
  const emit = (event) => emitted.push(event);
  beginRun({
    env,
    emit,
    randomUUID: uuidSequence(RUN_ID, SESSION_ID),
    monotonicNow: () => 1_000_000_000n,
  });

  assert.throws(
    () => completeRun(
      { runId: RUN_ID, outcome: "failure", failureStage: "typo_stage" },
      { env, emit, monotonicNow: () => 2_000_000_000n }
    ),
    /invalid_failure_stage/
  );
  assert.throws(
    () => completeRun(
      { runId: RUN_ID, outcome: "bogus" },
      { env, emit, monotonicNow: () => 2_000_000_000n }
    ),
    /invalid_outcome/
  );
  // Monotonic clock moved backwards (e.g. reboot between start and complete).
  assert.throws(
    () => completeRun(
      { runId: RUN_ID, outcome: "failure", failureStage: "audit_checks" },
      { env, emit, monotonicNow: () => 1n }
    ),
    /invalid_duration/
  );
  assert.equal(emitted.length, 1, "rejected completions must not emit");

  const completed = completeRun(
    { runId: RUN_ID, outcome: "failure", failureStage: "audit_checks" },
    { env, emit, monotonicNow: () => 2_000_000_000n }
  );
  assert.equal(completed.outcome, "failure");
  assert.equal(completed.durationMs, 1000);
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].data.eventInfo.auditPermissions.failureStage, "audit_checks");
});

test("environment opt-out keeps the lifecycle event local and suppresses transmission", (t) => {
  const { dir, env } = makeTempDir(t);
  const probePath = path.join(dir, "probe.json");
  const result = spawnSync(process.execPath, [SCRIPT_PATH, "--action", "start"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: "",
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
      POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "1",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const start = JSON.parse(result.stdout);
  assert.equal(start.status, "started");
  assert.match(start.auditRunId, /^[0-9a-f-]{36}$/i);

  const mirror = waitForMirror(dir);
  assert.ok(mirror, "opted-out lifecycle event should remain in the local mirror");
  const record = JSON.parse(fs.readFileSync(mirror, "utf8").trim());
  assert.equal(record.data.eventName, "audit_permissions_run_started");
  assert.equal(record.data.eventInfo.auditPermissions.auditRunId, start.auditRunId);
  assert.equal(fs.existsSync(probePath), false, "opt-out must suppress the collector POST");
});
