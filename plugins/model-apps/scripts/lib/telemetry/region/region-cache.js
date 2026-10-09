"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR_NAME = "region-cache";
const TTL_MS = 24 * 60 * 60 * 1000;

// orgId comes from `pac auth who` ("Organization Id") — a Dataverse org GUID.
// Validate the shape before using it as a filename: defensive against a
// malformed/spoofed value containing path separators (`/`, `\`, `..`), and it
// doubles as the falsy-orgId guard.
const ORG_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function defaultDir() {
  return path.join(os.homedir(), ".power-platform-skills");
}

function cacheDir(configDir) {
  return path.join(configDir || defaultDir(), DIR_NAME);
}

function entryFile(orgId, configDir) {
  return path.join(cacheDir(configDir), `${orgId}.json`);
}

// Returns the cached { region } for an org, or null when missing / unreadable /
// malformed / expired. Only the plugin-INDEPENDENT org→region mapping is cached;
// the caller maps region→iKey from its own regionsMap (so a cache shared across
// plugins can never hand one plugin another plugin's key).
function read(orgId, configDir) {
  if (!ORG_ID_RE.test(String(orgId || ""))) return null;
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(entryFile(orgId, configDir), "utf8"));
  } catch {
    return null;
  }
  if (
    !entry ||
    typeof entry.expiresAt !== "number" ||
    entry.expiresAt < Date.now()
  ) {
    return null;
  }
  return { region: entry.region };
}

// Per-process counter so concurrent writers never collide on the temp name.
let writeSeq = 0;

function write(orgId, entry, configDir) {
  if (!ORG_ID_RE.test(String(orgId || "")) || !entry || !entry.region) return;
  const dir = cacheDir(configDir);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const file = path.join(dir, `${orgId}.json`);
  const payload = JSON.stringify({
    region: entry.region,
    expiresAt: Date.now() + TTL_MS,
  });
  // Per-org file + atomic rename: each org owns its own file, so concurrent
  // detached dispatchers (one per skill invocation) writing DIFFERENT orgs can
  // never clobber each other — the shared read-modify-write is gone, and
  // same-org concurrent writes are idempotent (identical content). The temp name
  // is per-process so writers don't collide; rename is an atomic replace (incl.
  // Windows via MoveFileEx) so a reader never sees a torn/half-written file.
  const tmp = `${file}.tmp.${process.pid}.${writeSeq++}`;
  try {
    fs.writeFileSync(tmp, payload, "utf8");
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
