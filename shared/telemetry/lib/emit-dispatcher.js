#!/usr/bin/env node
"use strict";

const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FIELD_TYPES, pick } = require("./events");

function exitSilently() {
  process.exit(0);
}

process.on("uncaughtException", exitSilently);
process.on("unhandledRejection", exitSilently);
process.stdin.on("error", exitSilently);

const PLACEHOLDER_IKEY = "PLACEHOLDER_REPLACE_BEFORE_SHIPPING";
const DEFAULT_LOCAL_DIR = path.join(os.homedir(), ".power-platform-skills");

const IKEY = process.env.POWER_PLATFORM_SKILLS_IKEY || "";
const COLLECTOR_URL = process.env.POWER_PLATFORM_SKILLS_COLLECTOR || "";
const FAKE_PROBE = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "";

const { isTransmissionOptedOut } = require("./user-config");

// Anonymous telemetry is default-on. The user opt-out is per-plugin and lives in
// config.json (telemetry[<pluginName>] === "off"), written by the telemetry skill.
// It suppresses TRANSMISSION only; the local mirror is written before this gate.
function localConfigDir() {
  return process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || DEFAULT_LOCAL_DIR;
}
function isUserOptedOut(pluginName) {
  return isTransmissionOptedOut(localConfigDir(), pluginName);
}

// Path to the ikey.json config. Overridable via POWER_PLATFORM_SKILLS_IKEY_JSON
// so tests can point at a temp file with their own disabled / iKey state.
function ikeyJsonPath() {
  return (
    process.env.POWER_PLATFORM_SKILLS_IKEY_JSON ||
    path.join(__dirname, "..", "ikey.json")
  );
}

// Repo-side kill switch: when ikey.json contains "disabled": true, no events
// are emitted regardless of opt-out or iKey state. Lets the infrastructure
// PRs land while the tenant-side annotation + Kusto table are still being
// provisioned. Flip to false in a single PR when ready.
function isDisabledByConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ikeyJsonPath(), "utf8"));
    return cfg.disabled === true;
  } catch {
    // ikey.json missing/unreadable → fail CLOSED (treat as disabled). The
    // config is a kill switch; if we can't read it we cannot confirm emission
    // is authorized, so we suppress rather than risk a POST / local log in an
    // unexpected state.
    return true;
  }
}

// Reserved meta fields that builders always write into event.data. They are
// not user-facing telemetry columns, so they live outside FIELD_TYPES but
// must survive sanitization.
const RESERVED_META_FIELDS = new Set(["eventName", "eventType", "severity"]);

// Defense-in-depth allowlist filter. The builders in events.js are the
// intended entry point and already enforce FIELD_TYPES, but the dispatcher
// receives JSON over stdin from a separate process and cannot assume that.
// Re-run pick() against FIELD_TYPES here so any field that bypasses the
// builders is dropped before it reaches the wire.
function sanitizeData(data) {
  if (!data || typeof data !== "object") return {};
  const filtered = pick(data, Object.keys(FIELD_TYPES));
  for (const key of RESERVED_META_FIELDS) {
    if (typeof data[key] === "string") filtered[key] = data[key];
  }
  return filtered;
}

// Build the CS4.0 envelope from a pre-sanitized payload + timestamp. Both are
// computed once in the stdin handler and shared with the local mirror so the
// on-disk record and the wire envelope carry byte-identical `data` and `time`.
function buildEnvelope(name, time, sanitized) {
  return {
    ver: "4.0",
    name,
    time,
    iKey: "o:" + IKEY.split("-")[0],
    data: sanitized,
  };
}

function writeProbe(filePath, { headers, body }) {
  try {
    fs.writeFileSync(filePath, JSON.stringify({ headers, body }), "utf8");
  } catch {
    // ignore
  }
}

function writeLocalLog(event) {
  try {
    const { appendLocal } = require("./local-log");
    appendLocal(event, { configDir: localConfigDir() });
  } catch {
    // fail closed
  }
}

// ---- Repo-side kill switch (applies before ANY side effect) ----------------
// The `disabled` repo config is the one true hard-off: no local log, no POST.
// The per-plugin user opt-out is NOT checked here — it suppresses transmission
// only, and is applied below AFTER the local mirror is written.
if (isDisabledByConfig()) exitSilently();

// ---- Read stdin ------------------------------------------------------------
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return exitSilently();
  }

  // Compute the sanitized payload + timestamp ONCE. The sanitized data is
  // exactly what lands in Kusto (its field names ARE the Kusto column names);
  // the local mirror and the wire envelope share it so they can never diverge.
  const time = new Date().toISOString();
  const sanitized = sanitizeData(event.data);
  const localRecord = { time, name: event.name, data: sanitized };

  // Mirror to the local log for EVERY event that clears the repo kill switch —
  // irrespective of whether a real iKey is configured AND irrespective of the
  // per-plugin transmission opt-out. The file stays on the user's machine; it
  // is a local diagnostic mirror of what is (or would be) sent to Kusto, not
  // transmitted telemetry. (A `disabled: true` repo config wrote nothing — it
  // short-circuited before stdin was even read.)
  writeLocalLog(localRecord);

  // User opt-out (per plugin) — transmission only; the local mirror above is kept.
  const pluginName = event && event.data && event.data.pluginName;
  if (isUserOptedOut(pluginName)) return exitSilently();

  // Placeholder / unprovisioned mode → local mirror already written; no POST.
  const keyMissing = !IKEY || IKEY === PLACEHOLDER_IKEY || !COLLECTOR_URL;
  if (keyMissing) {
    return exitSilently();
  }

  // Real iKey → Common Schema envelope (reuses the same time + sanitized data
  // as the local mirror) → HTTPS POST.
  const envelope = buildEnvelope(event.name, time, sanitized);
  const body = JSON.stringify(envelope) + "\n";
  const headers = {
    "Content-Type": "application/x-json-stream; charset=utf-8",
    "x-apikey": IKEY,
    "Content-Length": Buffer.byteLength(body),
  };

  // Test seam: if POWER_PLATFORM_SKILLS_FAKE_HTTPS is set, write the probe
  // payload to that file and exit without calling the real network.
  if (FAKE_PROBE) {
    writeProbe(FAKE_PROBE, { headers, body });
    return exitSilently();
  }

  let url;
  try {
    url = new URL(COLLECTOR_URL);
  } catch {
    return exitSilently();
  }
  const req = https.request(
    {
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + (url.search || ""),
      method: "POST",
      headers,
    },
    (res) => {
      res.on("data", () => {});
      res.on("end", exitSilently);
    }
  );
  req.on("error", exitSilently);
  req.setTimeout(4000, () => {
    req.destroy();
    exitSilently();
  });
  req.write(body);
  req.end();
});
