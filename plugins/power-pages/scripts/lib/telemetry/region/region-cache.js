"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FILE_NAME = "region-cache.json";
const TTL_MS = 24 * 60 * 60 * 1000;

function defaultDir() {
  return path.join(os.homedir(), ".power-platform-skills");
}

function cacheFilePath(configDir) {
  return path.join(configDir || defaultDir(), FILE_NAME);
}

function read(orgId, configDir) {
  if (!orgId) return null;
  let raw;
  try {
    raw = fs.readFileSync(cacheFilePath(configDir), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = parsed && parsed[orgId];
  if (!entry) return null;
  if (typeof entry.expiresAt !== "number" || entry.expiresAt < Date.now()) {
    return null;
  }
  return {
    region: entry.region,
    iKey: entry.iKey,
    collectorUrl: entry.collectorUrl,
  };
}

function write(orgId, entry, configDir) {
  if (!orgId || !entry) return;
  const dir = configDir || defaultDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const file = path.join(dir, FILE_NAME);
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    existing = {};
  }
  existing[orgId] = {
    region: entry.region,
    iKey: entry.iKey,
    collectorUrl: entry.collectorUrl,
    expiresAt: Date.now() + TTL_MS,
  };
  try {
    fs.writeFileSync(file, JSON.stringify(existing), "utf8");
  } catch {
    // fail closed: cache miss next time
  }
}

module.exports = { read, write, TTL_MS };
