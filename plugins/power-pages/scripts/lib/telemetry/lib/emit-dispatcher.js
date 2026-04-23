#!/usr/bin/env node
"use strict";

const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

function exitSilently() {
  process.exit(0);
}

process.on("uncaughtException", exitSilently);
process.on("unhandledRejection", exitSilently);
process.stdin.on("error", exitSilently);

const PLACEHOLDER_IKEY = "PLACEHOLDER_REPLACE_BEFORE_SHIPPING";

const IKEY = process.env.POWER_PLATFORM_SKILLS_IKEY || "";
const COLLECTOR_URL = process.env.POWER_PLATFORM_SKILLS_COLLECTOR || "";
const FAKE_PROBE = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "";

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
    data: event.data || {},
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
    const consentLib = require("./consent");
    const configDir =
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR ||
      consentLib.defaultConfigDir();
    appendLocal(event, { configDir });
  } catch {
    // fail closed
  }
}

// ---- Consent gate (applies to BOTH network POST and local log) -------------
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
