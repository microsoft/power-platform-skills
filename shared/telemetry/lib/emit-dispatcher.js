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

// Repo-side kill switch: when ikey.json contains "disabled": true, no events
// are emitted regardless of opt-out or iKey state. Lets the infrastructure
// PRs land while the tenant-side annotation + Kusto table are still being
// provisioned. Flip to false in a single PR when ready.
function isDisabledByConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(ikeyJsonPath(), "utf8"));
    return cfg.disabled === true;
  } catch {
    return false; // ikey.json missing/unreadable → fail open.
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

function buildEnvelope(event) {
  return {
    ver: "4.0",
    name: event.name,
    time: new Date().toISOString(),
    iKey: "o:" + IKEY,
    data: sanitizeData(event.data),
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
    const configDir =
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || DEFAULT_LOCAL_DIR;
    appendLocal(event, { configDir });
  } catch {
    // fail closed
  }
}

// ---- Repo-side kill switch (applies before placeholder / network logic) ----
if (isDisabledByConfig()) exitSilently();

// ---- User env-var opt-out --------------------------------------------------
if (isUserOptedOut()) exitSilently();

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

  // Placeholder / unprovisioned mode → append to local dev log and exit.
  const keyMissing = !IKEY || IKEY === PLACEHOLDER_IKEY || !COLLECTOR_URL;
  if (keyMissing) {
    writeLocalLog(event);
    return exitSilently();
  }

  // Real iKey → Common Schema envelope → HTTPS POST.
  const envelope = buildEnvelope(event);
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
