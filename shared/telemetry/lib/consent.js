"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const PROMPT_VERSION = 1;
const FILE_NAME = "telemetry.json";

function defaultConfigDir() {
  return path.join(os.homedir(), ".power-platform-skills");
}

function filePath(configDir) {
  return path.join(configDir || defaultConfigDir(), FILE_NAME);
}

function read({ configDir, env } = {}) {
  const e = env || process.env;
  if (e.POWER_PLATFORM_SKILLS_TELEMETRY === "0") {
    return { state: "disabled", record: null };
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath(configDir), "utf8");
  } catch {
    return { state: "unset" };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "unset" };
  }

  if (
    parsed.version !== SCHEMA_VERSION ||
    parsed.prompt_version !== PROMPT_VERSION
  ) {
    return { state: "unset" };
  }

  return {
    state: parsed.enabled ? "enabled" : "disabled",
    record: parsed,
  };
}

function write({ configDir, enabled }) {
  const dir = configDir || defaultConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    version: SCHEMA_VERSION,
    prompt_version: PROMPT_VERSION,
    enabled: Boolean(enabled),
    consented_at: new Date().toISOString(),
  };
  fs.writeFileSync(filePath(dir), JSON.stringify(record, null, 2), "utf8");
  return record;
}

module.exports = {
  SCHEMA_VERSION,
  PROMPT_VERSION,
  defaultConfigDir,
  read,
  write,
};
