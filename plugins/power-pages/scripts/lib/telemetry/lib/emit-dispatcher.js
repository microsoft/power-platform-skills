#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { FIELD_TYPES, pick } = require("./events");
const { resolve: resolveRegion } = require("./region-resolver");

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
// Override env vars — TEST seams only. Production no longer sets these.
const IKEY_OVERRIDE = process.env.POWER_PLATFORM_SKILLS_IKEY || "";
const COLLECTOR_OVERRIDE = process.env.POWER_PLATFORM_SKILLS_COLLECTOR || "";

// Anonymous telemetry is default-on. The single user-facing opt-out is the
// POWER_PLATFORM_SKILLS_TELEMETRY=0 env kill switch.
function isUserOptedOut() {
  return process.env.POWER_PLATFORM_SKILLS_TELEMETRY === "0";
}

// Path to the ikey.json config. Overridable via POWER_PLATFORM_SKILLS_IKEY_JSON
// so tests can point at a temp file with their own disabled / iKey state.
function ikeyJsonPath() {
  return (
    process.env.POWER_PLATFORM_SKILLS_IKEY_JSON ||
    path.join(__dirname, "..", "ikey.json")
  );
}

function readIkeyConfig() {
  try {
    return JSON.parse(fs.readFileSync(ikeyJsonPath(), "utf8"));
  } catch {
    return {}; // ikey.json missing/unreadable → fail open.
  }
}

// Repo-side kill switch: when ikey.json contains "disabled": true, no events
// are emitted regardless of opt-out or iKey state. Lets infrastructure PRs
// land while tenant-side annotation + Kusto table are being provisioned.
function isDisabledByConfig(cfg) {
  return cfg && cfg.disabled === true;
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

function buildEnvelope(event, resolvedIKey, eventStreamName) {
  return {
    ver: "4.0",
    name: eventStreamName || event.name || "",
    time: new Date().toISOString(),
    iKey: "o:" + String(resolvedIKey || "").split("-")[0],
    data: sanitizeData(event.data),
  };
}

function writeProbe(filePath, { headers, body }) {
  try {
    fs.writeFileSync(filePath, JSON.stringify({ headers, body }), "utf8");
  } catch { /* ignore */ }
}

function writeLocalLog(event) {
  try {
    const { appendLocal } = require("./local-log");
    const configDir = CONFIG_DIR_ENV || DEFAULT_LOCAL_DIR;
    appendLocal(event, { configDir });
  } catch { /* fail closed */ }
}

// ---- Read config + apply kill switches ----
const cfg = readIkeyConfig();
if (isDisabledByConfig(cfg)) exitSilently();
if (isUserOptedOut()) exitSilently();

// ---- Read stdin ----
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

  // Override env vars take precedence (test seam). Production code path
  // ignores these and resolves via the regions map.
  let iKey = IKEY_OVERRIDE;
  let collectorUrl = COLLECTOR_OVERRIDE;
  if (!iKey || !collectorUrl) {
    const resolved = await resolveRegion({
      orgId: (event.data && event.data.orgId) || "",
      cloud: CLOUD_ENV,
      regionsMap: cfg.regions || {},
      defaultRegion: cfg.default_region || "us",
      configDir: CONFIG_DIR_ENV || undefined,
    });
    if (resolved) {
      iKey = iKey || resolved.iKey || "";
      collectorUrl = collectorUrl || resolved.collectorUrl || "";
    }
  }

  // Placeholder / unprovisioned mode → append to local dev log and exit.
  const keyMissing = !iKey || iKey === PLACEHOLDER_IKEY || !collectorUrl;
  if (keyMissing) {
    writeLocalLog(event);
    return exitSilently();
  }

  const envelope = buildEnvelope(event, iKey, cfg.event_stream_name);
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
