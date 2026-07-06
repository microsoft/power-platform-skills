"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LOG_FILE_NAME = "events.jsonl";
const ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB per-session size safety cap
const MAX_LOG_AGE_DAYS = 14;
const MAX_LOG_AGE_MS = MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;

// pluginName and sessionId become DIRECTORY names on disk, so each must be
// reduced to a single safe path segment. This is a path-safety requirement — a
// malformed event record must never write outside telemetry/.
//
// The "." and ".." path-traversal segments are rejected on the RAW value up
// front (they must map to the sentinel, not to a mangled name). Everything else
// is then passed through an allowlist of [A-Za-z0-9_-]; any other char —
// including "." and "/" — collapses to "_". Dots are intentionally NOT in the
// allowlist so an input like "../evil" cannot leave a leading ".." fragment in
// the resulting segment (it becomes "__evil"). An input that reduces to empty
// falls back to the sentinel.
function sanitizeSegment(value, fallback) {
  if (typeof value !== "string") return fallback;
  if (value === "." || value === "..") return fallback;
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_");
  if (!cleaned) return fallback;
  return cleaned;
}

// <configDir>/telemetry/<plugin>/sessions — the directory that holds one
// subdirectory per session. Pure path helper, no I/O.
function pluginLogDir(configDir, pluginName) {
  const plugin = sanitizeSegment(pluginName, "unknown");
  return path.join(configDir, "telemetry", plugin, "sessions");
}

function sessionDir(configDir, pluginName, sessionId) {
  const session = sanitizeSegment(sessionId, "nosession");
  return path.join(pluginLogDir(configDir, pluginName), session);
}

// events.YYYYMMDDHHMMSS.old — UTC stamp so rolled files sort chronologically.
function rotationName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    now.getUTCFullYear().toString() +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  return `events.${stamp}.old`;
}

// Per-session size cap. A single session almost never reaches 10 MB; this is a
// safety valve against a pathological runaway session, not the primary
// retention mechanism (that is age-based pruning of whole session dirs).
function rotateIfNeeded(dir, logFile) {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > ROTATE_BYTES) {
      try {
        fs.renameSync(logFile, path.join(dir, rotationName()));
      } catch {
        // best effort: if rename fails (file locked, etc.), keep appending.
      }
    }
  } catch {
    // no existing log — nothing to rotate
  }
}

function appendLocal(record, { configDir } = {}) {
  if (!configDir) return;
  const data = (record && record.data) || {};
  // Deterministic path — derived purely from the record. No directory scan, so
  // the many short-lived dispatcher processes that may write the same session
  // concurrently cannot race on "find this session's file".
  const dir = sessionDir(configDir, data.pluginName, data.sessionId);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const logFile = path.join(dir, LOG_FILE_NAME);
  rotateIfNeeded(dir, logFile);
  try {
    fs.appendFileSync(logFile, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // swallow — fail closed; telemetry must never break a skill run
  }
  pruneOldSessions(configDir, data.pluginName);
}

// Best-effort age-based retention — the primary cleanup mechanism. Walk the
// plugin's session dirs and remove any whose events.jsonl was last written more
// than MAX_LOG_AGE_DAYS ago. A dir with no readable events.jsonl is judged by
// its OWN mtime, so a just-created-but-not-yet-written dir from a concurrent
// dispatcher process is not deleted out from under it. Never throws — telemetry
// cleanup must not affect a skill run.
function pruneOldSessions(configDir, pluginName, now = Date.now()) {
  const sessionsRoot = pluginLogDir(configDir, pluginName);
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return; // no sessions dir yet — nothing to prune
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(sessionsRoot, entry.name);
    try {
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(path.join(dir, LOG_FILE_NAME)).mtimeMs;
      } catch {
        // No readable log file — fall back to the directory's own mtime.
        mtimeMs = fs.statSync(dir).mtimeMs;
      }
      if (now - mtimeMs > MAX_LOG_AGE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // best effort per dir; skip on any error
    }
  }
}

// Absolute path to the events.jsonl in the most-recently-written session dir
// for a plugin, or null when there are none. "Most recent" = highest
// events.jsonl mtime (directory mtime when the file is absent). Read-only;
// the telemetry skill's status output uses this so a user can grab the log for
// the session they just hit a problem in.
function latestSessionLog(configDir, pluginName) {
  const sessionsRoot = pluginLogDir(configDir, pluginName);
  let entries;
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  let bestMtime = -Infinity;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const logFile = path.join(sessionsRoot, entry.name, LOG_FILE_NAME);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(logFile).mtimeMs;
    } catch {
      try {
        mtimeMs = fs.statSync(path.join(sessionsRoot, entry.name)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (mtimeMs > bestMtime) {
      bestMtime = mtimeMs;
      best = logFile;
    }
  }
  return best;
}

module.exports = {
  appendLocal,
  pluginLogDir,
  latestSessionLog,
  pruneOldSessions,
  sanitizeSegment,
  LOG_FILE_NAME,
  ROTATE_BYTES,
  MAX_LOG_AGE_DAYS,
};
