#!/usr/bin/env node
"use strict";

/**
 * emit-telemetry.js
 *
 * Fires a single `skill_completed` 1DS event for the migrate-datamodel skill,
 * deriving only terminal outcome and elapsed duration from migration-state.json.
 * Migration details stay local; no new eventInfo fields are transmitted.
 *
 * Design contract:
 *   - READ-ONLY against the shared telemetry library (reached via the plugin's
 *     bundled `scripts/lib/telemetry` library). Touches nothing shared.
 *   - Fails CLOSED: any error → exit 0, nothing thrown, migration unaffected.
 *   - Honors the same kill switch (ikey.json `disabled` / missing iKey) and the
 *     per-plugin user opt-out that the emit dispatcher enforces.
 *   - `eventInfo` carries only the existing approved aadObjectId when available.
 *     No template names, phase text, site URLs or filesystem paths are emitted.
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

  const { cfg, ikeyPath, eventStreamName, disabled } = readIkey();
  // Repo-side hard-off / unconfigured: gate before any work so a disabled or
  // unconfigured plugin costs effectively nothing. (The per-plugin user opt-out
  // is enforced later by the detached dispatcher, which still writes the local
  // diagnostic mirror but skips the POST.)
  if (disabled) return;
  const { loadResolver } = require(path.join(TELEMETRY_DIR, "lib", "resolver-loader"));
  const resolver = loadResolver(path.dirname(ikeyPath));
  if (!(resolver ? resolver.isProvisioned(cfg) : cfg.instrumentationKey)) return;

  const outputDir = parseOutputDir(process.argv.slice(2));
  const state = loadState(outputDir);
  if (!state) return; // no state → nothing meaningful to report

  const rollup = buildPhaseRollup(state);
  if (!rollup) return; // Pending/in-progress state is not a successful completion.

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
    eventInfo: {},
  };

  if (rollup.outcome === "failure") {
    fields.errorClass = "phaseBlocked";
    fields.errorDescription = "phaseBlocked";
  }

  const pacAuth = safeCall(() => pacAuthLib.readPacAuth(), null);
  if (pacAuth && pacAuth.orgId) fields.orgId = pacAuth.orgId;
  if (pacAuth && pacAuth.tenantId) fields.tenantId = pacAuth.tenantId;
  if (pacAuth && pacAuth.objectId) fields.eventInfo.aadObjectId = pacAuth.objectId;

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
      cloud: (pacAuth && pacAuth.cloud) || "",
      configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "",
      fakeProbe: process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "",
      // lib/ is shared, so the dispatcher's __dirname default would hit shared/'s
      // placeholder ikey.json — point it at this plugin's real config.
      ikeyJsonPath: ikeyPath,
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

// Only derive approved top-level metrics; user-editable migration fields stay local.
function buildPhaseRollup(state) {
  if (!state || !Array.isArray(state.phases) || state.phases.length === 0 ||
      state.phases.some((phase) => !phase || typeof phase !== "object")) return null;
  const blocked = state.phases.find((p) => p.status === "blocked");
  if (!blocked && !state.phases.every((p) => p.status === "completed")) return null;
  const outcome = blocked ? "failure" : "success";
  return {
    outcome,
    durationMs: skillDurationMs(state),
  };
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
      cfg,
      ikeyPath,
      eventStreamName: cfg.event_stream_name || "",
      disabled: cfg.disabled === true,
    };
  } catch {
    // Missing/unreadable → fail CLOSED (disabled), matching the dispatcher's
    // kill-switch semantics so a missing config can't bypass the off-switch.
    return { cfg: null, ikeyPath, eventStreamName: "", disabled: true };
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

if (require.main === module) {
  try {
    main();
  } catch {
    // Telemetry must never interrupt migration.
  }
}

module.exports = { main, buildPhaseRollup, readIkey };
