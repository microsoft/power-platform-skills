#!/usr/bin/env node
"use strict";

/**
 * emit-telemetry.js
 *
 * Fires a single `skill_completed` 1DS event for the migrate-datamodel skill,
 * rolling up per-phase outcomes from migration-state.json into the dynamic
 * `eventInfo` column (Option A — one terminal event, phase summary embedded;
 * no per-phase live events, no shared-hook changes).
 *
 * Design contract:
 *   - READ-ONLY against the shared telemetry library (reached via the plugin's
 *     `scripts/lib/telemetry` symlink). Touches nothing shared.
 *   - Fails CLOSED: any error → exit 0, nothing thrown, migration unaffected.
 *   - Honors the same kill switch (ikey.json `disabled` / missing iKey) and the
 *     per-plugin user opt-out that the emit dispatcher enforces.
 *   - `eventInfo` carries only non-PII product signals (track, migration mode,
 *     template enum, per-phase status + duration). No site names, URLs, env
 *     names, slugs, or filesystem paths.
 *
 * USAGE
 *   node emit-telemetry.js --output-dir "<MIGRATION_SUBDIR>"
 *
 * The <MIGRATION_SUBDIR> is the per-migration folder printed by
 * `update-state.js --init` (the one holding migration-state.json).
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..");
const TELEMETRY_DIR = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry");

const SKILL_NAME = "migrate-datamodel";

function main() {
  let emitSpawn, eventsLib, sessionLib, pacAuthLib, agentInfoLib;
  try {
    emitSpawn = require(path.join(TELEMETRY_DIR, "lib", "emit-spawn"));
    eventsLib = require(path.join(TELEMETRY_DIR, "lib", "events"));
    sessionLib = require(path.join(TELEMETRY_DIR, "lib", "session"));
    pacAuthLib = require(path.join(TELEMETRY_DIR, "lib", "pac-auth"));
    agentInfoLib = require(path.join(TELEMETRY_DIR, "lib", "agent-info"));
  } catch {
    return; // telemetry library unavailable → no-op
  }

  const { ikey, collectorUrl, eventStreamName, disabled } = readIkey();
  // Repo-side hard-off / unconfigured: gate before any work so a disabled or
  // unconfigured plugin costs effectively nothing. (The per-plugin user opt-out
  // is enforced later by the detached dispatcher, which still writes the local
  // diagnostic mirror but skips the POST.)
  if (disabled || !ikey) return;

  const outputDir = parseOutputDir(process.argv.slice(2));
  const state = loadState(outputDir);
  if (!state) return; // no state → nothing meaningful to report

  const rollup = buildPhaseRollup(state);

  const fields = {
    pluginName: "power-pages",
    pluginVersion: readPluginVersion(),
    sessionId: safeCall(() => sessionLib.getSessionId(), crypto.randomUUID()),
    correlationId: crypto.randomUUID(),
    osName: osFriendlyName(process.platform),
    osVersion: os.release(),
    nodeVersion: "v" + String(process.versions.node).split(".")[0],
    skillName: SKILL_NAME,
    outcome: rollup.outcome,
    durationMs: rollup.durationMs,
    eventInfo: rollup.eventInfo,
  };

  if (rollup.outcome === "failure") {
    fields.errorClass = "phaseBlocked";
    fields.errorDescription = rollup.blockedPhaseId
      ? `phase-${rollup.blockedPhaseId}`
      : "phaseBlocked";
  }

  const pacAuth = safeCall(() => pacAuthLib.readPacAuth(), null);
  if (pacAuth && pacAuth.orgId) fields.orgId = pacAuth.orgId;
  if (pacAuth && pacAuth.tenantId) fields.tenantId = pacAuth.tenantId;

  const agentInfo = safeCall(
    () => ({
      ...agentInfoLib.readAiAgent(),
      pacCliVersion: agentInfoLib.readPacCliVersion(),
    }),
    {}
  );
  if (agentInfo.aiAgentName) fields.aiAgentName = agentInfo.aiAgentName;
  if (agentInfo.aiAgentVersion) fields.aiAgentVersion = agentInfo.aiAgentVersion;
  if (agentInfo.pacCliVersion) fields.pacCliVersion = agentInfo.pacCliVersion;

  try {
    emitSpawn.fireAndForget(eventsLib.buildSkillCompleted(eventStreamName, fields), {
      iKey: ikey,
      collectorUrl,
      configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "",
      fakeProbe: process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "",
      // lib/ is shared, so the dispatcher's __dirname default would hit shared/'s
      // placeholder ikey.json — point it at this plugin's real config.
      ikeyJsonPath: path.join(TELEMETRY_DIR, "ikey.json"),
    });
  } catch {
    // fail closed
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function parseOutputDir(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--output-dir" && argv[i + 1]) return argv[i + 1];
  }
  return "";
}

function loadState(outputDir) {
  if (!outputDir) return null;
  try {
    const p = path.join(outputDir, "migration-state.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Build the non-PII phase rollup + derive the terminal outcome and duration.
function buildPhaseRollup(state) {
  const phases = Array.isArray(state.phases) ? state.phases : [];

  const phaseSummaries = phases.map((p) => ({
    id: p.id,
    title: typeof p.title === "string" ? p.title : null, // static blueprint text, not user data
    status: p.status || "pending",
    durationMs: phaseDurationMs(p),
  }));

  const blocked = phaseSummaries.find((p) => p.status === "blocked");
  const completedCount = phaseSummaries.filter((p) => p.status === "completed").length;

  const outcome = blocked ? "failure" : "success";

  const eventInfo = {
    track: state.track || null, // "A" | "B" — product enum, not user data
    migrationMode: (state.site && state.site.migrationMode) || null,
    template: (state.site && state.site.template) || null,
    currentDataModel: (state.site && state.site.currentDataModel) || null,
    phasesTotal: phaseSummaries.length,
    phasesCompleted: completedCount,
    phasesBlocked: blocked ? 1 : 0,
    phases: phaseSummaries,
  };

  return {
    outcome,
    durationMs: skillDurationMs(state),
    blockedPhaseId: blocked ? blocked.id : null,
    eventInfo,
  };
}

function phaseDurationMs(phase) {
  const start = Date.parse(phase && phase.startedAt);
  const end = Date.parse(phase && phase.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

function skillDurationMs(state) {
  const start = Date.parse(state && state.skillStartedAt);
  const end = Date.parse(state && state.lastUpdatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return end - start;
}

function readPluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")
    );
    return manifest.version || "unknown";
  } catch {
    return "unknown";
  }
}

function readIkey() {
  const override = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const ikeyPath =
    override && override.trim() ? override : path.join(TELEMETRY_DIR, "ikey.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(ikeyPath, "utf8"));
    return {
      ikey: cfg.instrumentationKey || "",
      collectorUrl: cfg.collector_url || "",
      eventStreamName: cfg.event_stream_name || "",
      disabled: cfg.disabled === true,
    };
  } catch {
    // Missing/unreadable → fail CLOSED (disabled), matching the dispatcher's
    // kill-switch semantics so a missing config can't bypass the off-switch.
    return { ikey: "", collectorUrl: "", eventStreamName: "", disabled: true };
  }
}

function osFriendlyName(platform) {
  if (platform === "win32") return "Windows";
  if (platform === "darwin") return "Mac";
  if (platform === "linux") return "Linux";
  return platform;
}

function safeCall(fn, fallback) {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

try {
  main();
} catch {
  // Absolute fail-closed guard — telemetry must never break the skill.
}
process.exit(0);
