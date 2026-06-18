#!/usr/bin/env node

// Writes a per-run structured trace for a git-configure invocation and prunes
// old traces. Unlike the single overwrite-on-each-run last-git-configure.json
// marker, traces are append-only history: one file per run under
// docs/inner-loop/git-configure-traces/<UTC-iso>.json. This gives operators a
// debuggable record of "what happened on each run" — phase timings, gate
// decisions, helper exit codes, mutations performed, and the final state.
//
// SECURITY: a trace MUST NEVER capture raw helper stdout or any token value.
// Callers pass structured, pre-redacted fields only (arg NAMES, not values;
// exit codes, not output). This helper does not read tokens or stdout itself.
//
// Retention: at the start of each run we delete trace files older than
// RETENTION_DAYS (default 30) AND cap the directory at MAX_FILES (default 100),
// whichever is stricter, so the folder can't grow unbounded.
//
// Output (library): { ok, tracePath, pruned: <count> } | { ok:false, error }
//
// Usage (library):
//   const { writeRunTrace } = require('./write-run-trace');
//   writeRunTrace({ projectRoot, trace: { mode, phases, gates, mutations, finalState } });

'use strict';

const fs = require('fs');
const path = require('path');

const TRACES_SUBDIR = 'docs/inner-loop/git-configure-traces';
const RETENTION_DAYS = 30;
const MAX_FILES = 100;

// Keys a trace may legitimately carry. Anything else is dropped defensively so
// a careless caller can't smuggle a token/stdout into the on-disk record.
const ALLOWED_TRACE_KEYS = Object.freeze([
  'skill', 'mode', 'envHost', 'startedAt', 'finishedAt', 'durationMs',
  'phases', 'gates', 'mutations', 'warnings', 'finalState', 'status', 'markerVersion',
]);

// Redact a trace object down to the allowed key set. Shallow — nested objects
// are passed through, so callers must not nest raw stdout under an allowed key.
function redactTrace(trace) {
  const safe = {};
  if (!trace || typeof trace !== 'object') return safe;
  for (const k of ALLOWED_TRACE_KEYS) {
    if (trace[k] !== undefined) safe[k] = trace[k];
  }
  return safe;
}

function isoForFilename(d) {
  // 2026-06-13T19:11:04.163Z → 2026-06-13T19-11-04-163Z (filename-safe).
  return d.toISOString().replace(/[:.]/g, '-');
}

/**
 * Prune traces older than RETENTION_DAYS and cap the directory at MAX_FILES.
 * @returns {number} count of files deleted
 */
function pruneTraces(dir, { now = Date.now, retentionDays = RETENTION_DAYS, maxFiles = MAX_FILES } = {}) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch { return 0; }

  let pruned = 0;
  const cutoff = now() - retentionDays * 24 * 60 * 60 * 1000;
  const surviving = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
    if (mtime && mtime < cutoff) {
      try { fs.unlinkSync(full); pruned++; } catch { /* best-effort */ }
    } else {
      surviving.push({ full, mtime });
    }
  }

  // Cap by count: delete the oldest beyond maxFiles.
  if (surviving.length > maxFiles) {
    surviving.sort((a, b) => a.mtime - b.mtime); // oldest first
    const excess = surviving.length - maxFiles;
    for (let i = 0; i < excess; i++) {
      try { fs.unlinkSync(surviving[i].full); pruned++; } catch { /* best-effort */ }
    }
  }
  return pruned;
}

/**
 * @param {object} input
 * @param {string} input.projectRoot
 * @param {object} input.trace          Structured, pre-redacted trace fields.
 * @param {() => number} [input._nowImpl]  DI for clock (tests).
 * @param {() => Date}   [input._dateImpl] DI for filename timestamp (tests).
 * @returns {{ ok: boolean, tracePath?: string, pruned?: number, error?: string }}
 */
function writeRunTrace({ projectRoot, trace, _nowImpl, _dateImpl } = {}) {
  if (!projectRoot) return { ok: false, error: 'projectRoot is required' };
  const dir = path.join(projectRoot, TRACES_SUBDIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `cannot create traces dir: ${e.message}` };
  }

  const pruned = pruneTraces(dir, { now: _nowImpl || Date.now });

  const stamp = _dateImpl ? _dateImpl() : new Date();
  const tracePath = path.join(dir, `${isoForFilename(stamp)}.json`);
  const payload = redactTrace(trace);
  payload.tracedAt = stamp.toISOString();
  try {
    fs.writeFileSync(tracePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: `cannot write trace: ${e.message}` };
  }
  return { ok: true, tracePath, pruned };
}

module.exports = {
  writeRunTrace,
  pruneTraces,
  redactTrace,
  TRACES_SUBDIR,
  RETENTION_DAYS,
  MAX_FILES,
  ALLOWED_TRACE_KEYS,
};
