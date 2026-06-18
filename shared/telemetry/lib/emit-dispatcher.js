#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { FIELD_TYPES, pick } = require("./events");
const { loadResolver } = require("./resolver-loader");
const { isTransmissionOptedOut } = require("./user-config");

function exitSilently() {
  process.exit(0);
}
process.on("uncaughtException", exitSilently);
process.on("unhandledRejection", exitSilently);
process.stdin.on("error", exitSilently);

const PLACEHOLDER_IKEY = "PLACEHOLDER_REPLACE_BEFORE_SHIPPING";
const DEFAULT_LOCAL_DIR = path.join(os.homedir(), ".power-platform-skills");
const FAKE_PROBE = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "";
const CONFIG_DIR_ENV = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";
const CLOUD_ENV = process.env.POWER_PLATFORM_SKILLS_CLOUD || "";
// Override env vars — TEST seams only. Production resolves the iKey/collector
// via the plugin resolver / static config in ikey.json and never sets these.
const IKEY_OVERRIDE = process.env.POWER_PLATFORM_SKILLS_IKEY || "";
const COLLECTOR_OVERRIDE = process.env.POWER_PLATFORM_SKILLS_COLLECTOR || "";

function localConfigDir() {
  return CONFIG_DIR_ENV || DEFAULT_LOCAL_DIR;
}

// Anonymous telemetry is default-on. The user opt-out is per-plugin and lives in
// config.json (telemetry[<pluginName>] === "off"), written by the telemetry skill.
// It suppresses TRANSMISSION only; the local mirror is written before this gate.
function isUserOptedOut(pluginName) {
  return isTransmissionOptedOut(localConfigDir(), pluginName);
}

// Path to the ikey.json config. Overridable via POWER_PLATFORM_SKILLS_IKEY_JSON
// so tests can point at a temp file with their own disabled / region state.
function ikeyJsonPath() {
  return (
    process.env.POWER_PLATFORM_SKILLS_IKEY_JSON ||
    path.join(__dirname, "..", "ikey.json")
  );
}

// Returns the parsed ikey.json, or null when it is missing/unreadable. null is
// treated as the repo kill switch (fail CLOSED): if we cannot read the config
// we cannot confirm emission is authorized, so we suppress rather than risk a
// POST / local log in an unexpected state.
function readIkeyConfig() {
  try {
    return JSON.parse(fs.readFileSync(ikeyJsonPath(), "utf8"));
  } catch {
    return null;
  }
}

// Repo-side kill switch: a missing/unreadable config (null) or an explicit
// `"disabled": true` suppresses ALL events regardless of opt-out or region
// state. Lets infrastructure PRs land while the tenant-side annotation + Kusto
// table are still being provisioned. Flip `disabled` to false when ready.
function isDisabledByConfig(cfg) {
  return !cfg || cfg.disabled === true;
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
function buildEnvelope(eventName, time, sanitized, resolvedIKey, eventStreamName) {
  return {
    ver: "4.0",
    name: eventStreamName || eventName || "",
    time,
    iKey: "o:" + String(resolvedIKey || "").split("-")[0],
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

function writeLocalLog(record) {
  try {
    const { appendLocal } = require("./local-log");
    appendLocal(record, { configDir: localConfigDir() });
  } catch {
    // fail closed
  }
}

// ---- Read config + repo-side kill switch (applies before ANY side effect) --
// The `disabled` repo config (and an unreadable config) is the one true
// hard-off: no local log, no POST. The per-plugin user opt-out is NOT checked
// here — it suppresses transmission only, and is applied below AFTER the local
// mirror is written. cfg is reused for resolver context + static fallback in
// the stdin handler.
const cfg = readIkeyConfig();
if (isDisabledByConfig(cfg)) exitSilently();
const resolver = loadResolver(path.dirname(ikeyJsonPath()));

// ---- Read stdin ------------------------------------------------------------
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
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
  // irrespective of whether a real iKey resolves AND irrespective of the
  // per-plugin transmission opt-out. The file stays on the user's machine; it
  // is a local diagnostic mirror of what is (or would be) sent to Kusto, not
  // transmitted telemetry. (A `disabled: true` repo config wrote nothing — it
  // short-circuited before stdin was even read.)
  writeLocalLog(localRecord);

  // User opt-out (per plugin) — transmission only; the local mirror above is kept.
  const pluginName = event && event.data && event.data.pluginName;
  if (isUserOptedOut(pluginName)) return exitSilently();

  // Resolve the destination iKey + collector. Precedence: env override (test
  // seam) → plugin resolver.js (region/tenant/etc., owned by the plugin) →
  // static single-key config in ikey.json → none. The shared dispatcher knows
  // nothing about regions; the plugin's resolver.js owns that.
  let iKey = IKEY_OVERRIDE;
  let collectorUrl = COLLECTOR_OVERRIDE;
  if (!iKey || !collectorUrl) {
    if (resolver && typeof resolver.resolve === "function") {
      let resolved = null;
      try {
        resolved = await resolver.resolve({
          event,
          cfg,
          cloud: CLOUD_ENV,
          configDir: CONFIG_DIR_ENV || undefined,
        });
      } catch {
        // A plugin resolver threw/rejected — continue with no resolution rather
        // than letting the global unhandledRejection handler exit. The local
        // mirror was already written above; the static fallback below still
        // runs, so a transient resolver failure degrades to the configured
        // static key (or "no transmission") instead of crashing.
        resolved = null;
      }
      if (resolved) {
        iKey = iKey || resolved.iKey || "";
        collectorUrl = collectorUrl || resolved.collectorUrl || "";
      }
    }
    // Static fallback — documented precedence is resolver → static → none, so
    // this runs whether or not a resolver was present. A resolver that returns
    // nothing (or threw) still falls through to a configured static key rather
    // than silently disabling transmission.
    iKey = iKey || cfg.instrumentationKey || "";
    collectorUrl = collectorUrl || cfg.collector_url || "";
  }

  // Placeholder / unprovisioned mode → local mirror already written; no POST.
  const keyMissing = !iKey || iKey === PLACEHOLDER_IKEY || !collectorUrl;
  if (keyMissing) {
    return exitSilently();
  }

  // Real iKey → Common Schema envelope (reuses the same time + sanitized data
  // as the local mirror) → HTTPS POST.
  const envelope = buildEnvelope(event.name, time, sanitized, iKey, cfg.event_stream_name);
  const body = JSON.stringify(envelope) + "\n";
  const headers = {
    "Content-Type": "application/x-json-stream; charset=utf-8",
    "x-apikey": iKey,
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
    url = new URL(collectorUrl);
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
