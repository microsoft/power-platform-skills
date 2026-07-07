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
// the resulting segment (it becomes "___evil"). An input that reduces to empty
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

// One-time cleanup of the pre-per-session layout. Before this feature the mirror
// was a single flat <configDir>/events.jsonl (rotated to <configDir>/events.<stamp>.old
// directly in the config root). Those files are never written again, so delete
// them on the first write we do — they only sit at the config ROOT, so this can
// never touch the new per-session tree under <configDir>/telemetry/. Best-effort
// and never throws: a leftover diagnostic file must not break a skill run.
function removeLegacyFlatLog(configDir) {
  try {
    fs.rmSync(path.join(configDir, LOG_FILE_NAME), { force: true });
  } catch {
    // ignore — the legacy file may not exist or may be locked
  }
  let entries;
  try {
    entries = fs.readdirSync(configDir);
  } catch {
    return; // config dir unreadable — nothing more to clean
  }
  for (const name of entries) {
    // Legacy rotations were named events.<UTCstamp>.old at the config root. The
    // new layout's .old files live inside telemetry/**, so matching on this
    // root listing only cannot delete a current per-session rotation.
    if (name.startsWith("events.") && name.endsWith(".old")) {
      try {
        fs.rmSync(path.join(configDir, name), { force: true });
      } catch {
        // best effort per file
      }
    }
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
  removeLegacyFlatLog(configDir);
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
// events.jsonl mtime. Session dirs without a readable events.jsonl are skipped,
// so the returned path always points at a file that exists — the telemetry
// skill's status output surfaces this path for the user to share, and returning
// a phantom path (e.g. an orphaned/interrupted session dir with no log yet)
// would tell them to grab a file that isn't there. Read-only.
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
      // Only sessions with a readable events.jsonl are candidates; a dir without
      // one is skipped so `best` can never point at a non-existent file.
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
  removeLegacyFlatLog,
  sanitizeSegment,
  LOG_FILE_NAME,
  ROTATE_BYTES,
  MAX_LOG_AGE_DAYS,
};
