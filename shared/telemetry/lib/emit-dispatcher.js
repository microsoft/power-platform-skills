#!/usr/bin/env node
"use strict";

const https = require("node:https");
const fs = require("node:fs");

const PLACEHOLDER_IKEY = "PLACEHOLDER_REPLACE_BEFORE_SHIPPING";

const IKEY = process.env.POWER_PLATFORM_SKILLS_IKEY || "";
const COLLECTOR_URL = process.env.POWER_PLATFORM_SKILLS_COLLECTOR || "";
const FAKE_PROBE = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "";

function exitSilently() {
  process.exit(0);
}

function readConsent() {
  try {
    const consent = require("./consent");
    return consent.read({
      configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || undefined,
    });
  } catch {
    return { state: "unset" };
  }
}

function buildEnvelope(event) {
  return {
    ver: "4.0",
    name: event.name,
    time: new Date().toISOString(),
    iKey: "o:" + IKEY.split("-")[0],
    baseType: "Ms.WebClient.TraceEvent",
    baseData: event.data,
    data: event.data,
  };
}

function writeProbe(path, { headers, body }) {
  try {
    fs.writeFileSync(path, JSON.stringify({ headers, body }), "utf8");
  } catch {
    // ignore
  }
}

// ---- Gate checks -----------------------------------------------------------
if (!IKEY || IKEY === PLACEHOLDER_IKEY || !COLLECTOR_URL) exitSilently();
if (readConsent().state !== "enabled") exitSilently();

// ---- Read stdin ------------------------------------------------------------
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    exitSilently();
  }

  const envelope = buildEnvelope(event);
  const body = JSON.stringify(envelope);
  const headers = {
    "Content-Type": "application/x-json-stream; charset=utf-8",
    "x-apikey": IKEY,
    "Content-Length": Buffer.byteLength(body),
  };

  // Test seam: if POWER_PLATFORM_SKILLS_FAKE_HTTPS is set, write the probe
  // payload to that file and exit without calling the real network.
  if (FAKE_PROBE) {
    writeProbe(FAKE_PROBE, { headers, body });
    exitSilently();
  }

  const url = new URL(COLLECTOR_URL);
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
