#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");

const {
  deriveAuditMetrics,
  validateAuditMetrics,
  validateReport,
} = require("./lib/audit-report-validation");
const { pick } = require("./lib/telemetry/lib/events");
const { fireAndForget } = require("./lib/telemetry/lib/emit-spawn");
const { readAiAgent } = require("./lib/telemetry/lib/agent-info");

const PLUGIN_ROOT = path.resolve(__dirname, "..");
const TELEMETRY_DIR = path.join(__dirname, "lib", "telemetry");
const DEFAULT_CONFIG_DIR = path.join(os.homedir(), ".power-platform-skills");
const RUN_STATE_VERSION = 1;
const METRICS_SCHEMA_VERSION = 1;
const MAX_STATE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FAILURE_STAGES = new Set([
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

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) {
      args[token.slice(2)] = value;
      index += 1;
    } else {
      args[token.slice(2)] = true;
    }
  }
  return args;
}

function configDir(env = process.env) {
  return env.POWER_PLATFORM_SKILLS_CONFIG_DIR || DEFAULT_CONFIG_DIR;
}

function runsDir(dir) {
  return path.join(dir, "telemetry", "power-pages", "audit-runs");
}

function statePath(dir, auditRunId) {
  if (!UUID_RE.test(auditRunId)) throw new Error("invalid_run_id");
  return path.join(runsDir(dir), `${auditRunId}.json`);
}

function completionPath(dir, auditRunId) {
  if (!UUID_RE.test(auditRunId)) throw new Error("invalid_run_id");
  return path.join(runsDir(dir), `${auditRunId}.completed`);
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    );
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readTelemetryConfig(env = process.env) {
  const ikeyPath =
    env.POWER_PLATFORM_SKILLS_IKEY_JSON ||
    path.join(TELEMETRY_DIR, "ikey.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(ikeyPath, "utf8"));
    return {
      cfg,
      ikeyPath,
      eventStreamName: typeof cfg.event_stream_name === "string" ? cfg.event_stream_name : "",
    };
  } catch {
    return { cfg: null, ikeyPath, eventStreamName: "" };
  }
}

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

function eventContext(sessionId, eventInfo, outcome, durationMs) {
  const agent = readAiAgent();
  const fields = {
    pluginName: "power-pages",
    pluginVersion: readPluginVersion(),
    sessionId,
    correlationId: crypto.randomUUID(),
    osName: osFriendlyName(process.platform),
    osVersion: os.release(),
    nodeVersion: `v${String(process.versions.node).split(".")[0]}`,
    skillName: "audit-permissions",
    eventInfo,
  };
  if (agent.aiAgentName) fields.aiAgentName = agent.aiAgentName;
  if (agent.aiAgentVersion) fields.aiAgentVersion = agent.aiAgentVersion;
  if (outcome !== undefined) fields.outcome = outcome;
  if (durationMs !== undefined) fields.durationMs = durationMs;
  return fields;
}

function buildLifecycleEvent(eventStreamName, eventName, input) {
  const allowed = [
    "pluginName",
    "pluginVersion",
    "sessionId",
    "correlationId",
    "osName",
    "osVersion",
    "nodeVersion",
    "pacCliVersion",
    "aiAgentName",
    "aiAgentVersion",
    "eventInfo",
    "skillName",
  ];
  if (eventName === "audit_permissions_run_completed") {
    allowed.push("outcome", "durationMs");
  }
  const data = pick(input, allowed);
  return {
    name: eventStreamName,
    data: {
      eventName,
      eventType: "Trace",
      severity: data.outcome === "failure" ? "Error" : "Info",
      ...data,
    },
  };
}

function dispatch(event, telemetry, env = process.env, emit = fireAndForget) {
  emit(event, {
    // Audit lifecycle events intentionally carry no PAC identity. The existing
    // Power Pages resolver therefore selects the configured default region.
    cloud: "",
    configDir: configDir(env),
    fakeProbe: env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "",
    ikeyJsonPath: telemetry.ikeyPath,
  });
}

function writeState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function readState(filePath) {
  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const expectedKeys = ["auditRunId", "sessionId", "startedMonotonicNs", "startedAt", "version"];
  const actualKeys = Object.keys(state).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== [...expectedKeys].sort()[index]) ||
    state.version !== RUN_STATE_VERSION ||
    !UUID_RE.test(state.auditRunId) ||
    !UUID_RE.test(state.sessionId) ||
    typeof state.startedMonotonicNs !== "string" ||
    !/^[0-9]+$/.test(state.startedMonotonicNs) ||
    typeof state.startedAt !== "string"
  ) {
    throw new Error("invalid_run_state");
  }
  return state;
}

function pruneRunState(dir, now = Date.now()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f-]+\.(?:json|completed)$/i.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    try {
      if (now - fs.statSync(filePath).mtimeMs > MAX_STATE_AGE_MS) {
        fs.rmSync(filePath, { force: true });
      }
    } catch {
      // State retention is best-effort and cannot affect an audit.
    }
  }
}

function beginRun(options = {}) {
  const env = options.env || process.env;
  const dir = configDir(env);
  const auditRunId = (options.randomUUID || crypto.randomUUID)();
  const sessionId = (options.randomUUID || crypto.randomUUID)();
  const telemetry = readTelemetryConfig(env);
  const startedMonotonicNs = (options.monotonicNow || process.hrtime.bigint)();
  const state = {
    version: RUN_STATE_VERSION,
    auditRunId,
    sessionId,
    startedAt: new Date(options.wallClockNow ? options.wallClockNow() : Date.now()).toISOString(),
    startedMonotonicNs: startedMonotonicNs.toString(),
  };
  const filePath = statePath(dir, auditRunId);
  writeState(filePath, state);
  pruneRunState(path.dirname(filePath), options.wallClockNow ? options.wallClockNow() : Date.now());

  const eventInfo = {
    auditPermissions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      auditRunId,
    },
  };
  const event = buildLifecycleEvent(
    telemetry.eventStreamName,
    "audit_permissions_run_started",
    eventContext(sessionId, eventInfo)
  );
  dispatch(event, telemetry, env, options.emit);
  return { auditRunId };
}

function acquireCompletion(dir, auditRunId) {
  const filePath = completionPath(dir, auditRunId);
  fs.writeFileSync(filePath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  return filePath;
}

function durationFromState(state, monotonicNow = process.hrtime.bigint) {
  const elapsedNs = monotonicNow() - BigInt(state.startedMonotonicNs);
  if (elapsedNs < 0n) throw new Error("invalid_duration");
  const elapsedMs = elapsedNs / 1_000_000n;
  return Number(elapsedMs > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : elapsedMs);
}

function successPayload(args) {
  if (!args.data || !args.report) throw new Error("missing_success_input");
  let report;
  try {
    report = validateReport(path.resolve(args.report));
  } catch {
    const error = new Error("report_validation");
    error.failureStage = "report_validation";
    throw error;
  }
  let data;
  let metrics;
  try {
    data = JSON.parse(fs.readFileSync(path.resolve(args.data), "utf8"));
    metrics = deriveAuditMetrics(data);
    validateAuditMetrics(metrics);
  } catch {
    const error = new Error("metrics_validation");
    error.failureStage = "metrics_validation";
    throw error;
  }
  if (
    !isDeepStrictEqual(report.findings, data.FINDINGS_DATA) ||
    !isDeepStrictEqual(report.scorecard, data.SCORECARD_DATA)
  ) {
    const error = new Error("report_data_mismatch");
    error.failureStage = "metrics_validation";
    throw error;
  }
  const payload = {
    schemaVersion: METRICS_SCHEMA_VERSION,
    auditRunId: args.runId,
    reportGenerated: true,
    ...metrics,
  };
  validateLifecyclePayload(payload, "success");
  return payload;
}

function failurePayload(runId, failureStage) {
  if (!FAILURE_STAGES.has(failureStage)) throw new Error("invalid_failure_stage");
  const payload = {
    schemaVersion: METRICS_SCHEMA_VERSION,
    auditRunId: runId,
    reportGenerated: false,
    failureStage,
  };
  validateLifecyclePayload(payload, "failure");
  return payload;
}

function validateLifecyclePayload(payload, outcome) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("invalid_lifecycle_payload");
  }
  if (!UUID_RE.test(payload.auditRunId || "") || payload.schemaVersion !== METRICS_SCHEMA_VERSION) {
    throw new Error("invalid_lifecycle_identity");
  }
  if (outcome === "failure") {
    const keys = Object.keys(payload).sort();
    const expected = ["auditRunId", "failureStage", "reportGenerated", "schemaVersion"].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
      throw new Error("invalid_failure_payload");
    }
    if (payload.reportGenerated !== false || !FAILURE_STAGES.has(payload.failureStage)) {
      throw new Error("invalid_failure_payload");
    }
    return payload;
  }
  if (outcome !== "success" || payload.reportGenerated !== true) {
    throw new Error("invalid_success_payload");
  }
  const {
    auditRunId,
    reportGenerated,
    ...metrics
  } = payload;
  void auditRunId;
  void reportGenerated;
  validateAuditMetrics(metrics);
  return payload;
}

function completeRun(args, options = {}) {
  const env = options.env || process.env;
  const dir = configDir(env);
  if (!UUID_RE.test(args.runId || "")) throw new Error("invalid_run_id");
  if (fs.existsSync(completionPath(dir, args.runId))) {
    const error = new Error("already_completed");
    error.code = "EEXIST";
    throw error;
  }
  const state = readState(statePath(dir, args.runId));
  if (state.auditRunId !== args.runId) throw new Error("run_state_mismatch");

  // Validate caller input and compute the duration BEFORE claiming the
  // completion marker. Claiming first would let a mistyped failure stage (or a
  // negative cross-reboot duration) consume the run's single completion slot
  // without emitting a terminal event, so a corrected retry could never record it.
  let outcome = args.outcome;
  let auditPermissions;
  if (outcome === "success") {
    try {
      auditPermissions = successPayload(args);
    } catch (error) {
      outcome = "failure";
      auditPermissions = failurePayload(
        args.runId,
        FAILURE_STAGES.has(error?.failureStage) ? error.failureStage : "metrics_validation"
      );
    }
  } else if (outcome === "failure") {
    auditPermissions = failurePayload(args.runId, args.failureStage);
  } else {
    throw new Error("invalid_outcome");
  }

  const durationMs = durationFromState(state, options.monotonicNow);
  acquireCompletion(dir, args.runId);
  const telemetry = readTelemetryConfig(env);
  const event = buildLifecycleEvent(
    telemetry.eventStreamName,
    "audit_permissions_run_completed",
    eventContext(
      state.sessionId,
      { auditPermissions },
      outcome,
      durationMs
    )
  );
  dispatch(event, telemetry, env, options.emit);
  try {
    fs.rmSync(statePath(dir, args.runId), { force: true });
  } catch {
    // The completion tombstone still prevents a duplicate terminal event.
  }
  return {
    auditRunId: args.runId,
    durationMs,
    outcome,
    reportGenerated: auditPermissions.reportGenerated,
  };
}

function fixedFailure(code) {
  process.stderr.write(`${JSON.stringify({ status: "error", code })}\n`);
  process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv);
  try {
    if (args.action === "start") {
      process.stdout.write(`${JSON.stringify({ status: "started", ...beginRun() })}\n`);
      return;
    }
    if (args.action === "complete") {
      const result = completeRun({
        runId: args.runId,
        outcome: args.outcome,
        data: args.data,
        report: args.report,
        failureStage: args.failureStage,
      });
      process.stdout.write(`${JSON.stringify({ status: "completed", ...result })}\n`);
      return;
    }
    fixedFailure("AUDIT_TELEMETRY_USAGE");
  } catch (error) {
    const duplicate = error && error.code === "EEXIST" && args.action === "complete";
    fixedFailure(duplicate ? "AUDIT_TELEMETRY_ALREADY_COMPLETED" : "AUDIT_TELEMETRY_FAILED");
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  FAILURE_STAGES,
  beginRun,
  buildLifecycleEvent,
  completeRun,
  durationFromState,
  failurePayload,
  parseArgs,
  pruneRunState,
  successPayload,
  validateLifecyclePayload,
};
