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

// Per-process counter so concurrent writers never collide on the temp name.
let writeSeq = 0;

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
  // Write to a per-process temp file, then atomically rename over the target.
  // Each tracked-skill invocation spawns its own detached dispatcher, so several
  // processes can write this shared file at once. fs.rename replaces the
  // destination atomically (incl. on Windows via MoveFileEx), so a concurrent
  // reader always sees either the complete old or the complete new file — never
  // a torn/half-written one (which would miss for ALL orgs).
  //
  // The read-modify-write above is still last-writer-wins across DIFFERENT
  // orgIds, but that residual is rare (needs two parallel sessions on different
  // orgs writing the same instant) and self-heals on the next resolve, so a
  // heavier file lock isn't warranted for a best-effort 24h cache.
  const tmp = `${file}.tmp.${process.pid}.${writeSeq++}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(existing), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // fail closed: cache miss next time. Best-effort cleanup of the temp file.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp may not have been created; ignore
    }
  }
}

module.exports = { read, write, TTL_MS };
