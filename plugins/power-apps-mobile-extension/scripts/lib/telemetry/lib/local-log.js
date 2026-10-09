"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LOG_FILE_NAME = "events.jsonl";
const ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB per-session size safety cap
const MAX_LOG_AGE_DAYS = 14;
const MAX_LOG_AGE_MS = MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;

// pluginName and sessionId become DIRECTORY names, so each is reduced to one safe
// path segment — a malformed record must never write outside telemetry/. Reject
// "." / ".." outright, then collapse anything outside [A-Za-z0-9_-] to "_". Dots
// are excluded so "../evil" can't leave a ".." fragment (it becomes "___evil");
// an empty result falls back to the sentinel.
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
  let created;
  try {
    // mkdirSync(recursive) returns the first path it created, or undefined if the
    // dir already existed — a free "is this a brand-new session?" signal.
    created = fs.mkdirSync(dir, { recursive: true });
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
  // The retention sweep scans every session dir, so run it only on a session's
  // first event (when we just created its dir), not on every append.
  if (created) pruneOldSessions(configDir, data.pluginName);
}

// Best-effort age-based retention — the primary cleanup mechanism. Remove any
// session dir whose events.jsonl was last written more than MAX_LOG_AGE_DAYS ago;
// a dir with no readable log is judged by its OWN mtime, so a just-created dir from
// a concurrent dispatcher isn't deleted out from under it. Never throws.
function pruneOldSessions(configDir, pluginName, now = Date.now()) {
  if (!configDir) return; // fail closed: pluginLogDir -> path.join would throw on undefined
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

// Absolute path to the most-recently-written session's events.jsonl for a plugin,
// or null when there are none ("most recent" = highest events.jsonl mtime). Dirs
// without a readable events.jsonl are skipped so the returned path always exists —
// status surfaces it for the user to share, and a phantom path would point them at
// a file that isn't there. Read-only.
function latestSessionLog(configDir, pluginName) {
  if (!configDir) return null; // fail closed: pluginLogDir -> path.join would throw on undefined
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
      // Skip dirs without a readable events.jsonl so `best` can't point at a missing file.
      mtimeMs = fs.statSync(logFile).mtimeMs;
    } catch {
      continue;
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
