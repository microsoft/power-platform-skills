"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const FILE_NAME = "telemetry.json";

function defaultConfigDir() {
  return path.join(os.homedir(), ".power-platform-skills");
}

function filePath(configDir) {
  return path.join(configDir || defaultConfigDir(), FILE_NAME);
}

// Default posture is enabled. The consent file exists primarily to record an
// explicit opt-out (`enabled: false`). A missing or unparseable file falls
// back to enabled. The `POWER_PLATFORM_SKILLS_TELEMETRY=0` env var is a
// one-way kill switch that overrides everything.
function read({ configDir, env } = {}) {
  const e = env || process.env;
  if (e.POWER_PLATFORM_SKILLS_TELEMETRY === "0") {
    return { state: "disabled", record: null };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath(configDir), "utf8");
  } catch {
    return { state: "enabled", record: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "enabled", record: null };
  }

  // Explicit opt-out is preserved regardless of schema version.
  if (parsed && parsed.enabled === false) {
    return { state: "disabled", record: parsed };
  }

  return { state: "enabled", record: parsed || null };
}

function write({ configDir, enabled }) {
  const dir = configDir || defaultConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    version: SCHEMA_VERSION,
    enabled: Boolean(enabled),
    recorded_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath(dir), JSON.stringify(record, null, 2), "utf8");
  return record;
}

module.exports = {
  SCHEMA_VERSION,
  defaultConfigDir,
  read,
  write,
};
