'use strict';
// Append-only JSONL build journal for app-builder. DIAGNOSTIC ONLY: it records what a build
// run did and where it halted, so a crashed/failed run leaves a durable trace. It is NOT a replayed
// checkpoint — resume is "re-run the same command" (the build is idempotent: it reuses everything
// already created). Ordinary fs failures are guarded so journaling can NEVER throw into (and fail) a build.
// A link left at the journal directory or at build-log.jsonl is not one of those failures: following
// it would record the trace somewhere else, so that refusal propagates and halts the run.
// build-status.json stays best-effort — a missing snapshot must not fail the build — but a refusal
// there is warned once so it is not silent.
//
// It ALSO maintains `<dir>/build-status.json` — a single-object snapshot OVERWRITTEN on every step —
// so a long build's live progress is observable with one cheap read even when the launching shell
// buffers stdout (e.g. piping through Select-Object). Tail `build-log.jsonl` for the full trace, or
// read `build-status.json` for "where is it right now".

const path = require('node:path');
const { assertSafeOutputDir, writeFileSafe, appendFileSafe } = require('./safe-fs.js');

function append(file, obj) {
  appendFileSafe(file, JSON.stringify(obj) + '\n');
}

// A link at the journal directory or at the log name must halt. A directory that cannot be
// created — the parent is a file, or it cannot be inspected — is the existing best-effort
// case: journaling must not fail the build over a folder it cannot open.
// Only a link (or a hard link, which is the same class of shared name) halts the build.
// A realpath EIO, a directory that cannot be created, or any other resolution failure
// disables journaling — the previous best-effort contract — and is warned once.
function isLinkRefusal(err) {
  return !!(err && err.code === 'UNSAFE_OUTPUT' && (err.reason === 'link' || err.reason === 'hard-link'));
}

// Open (create/append) `<dir>/build-log.jsonl` and write a run-start header. Returns a recorder
// whose methods are all no-ops if the file couldn't be opened (e.g. an unwritable dir).
function openJournal(dir, meta = {}, deps = {}) {
  const fsOpts = deps.fs ? { fs: deps.fs } : {};
  let file = null;
  let statusFile = null;
  let steps = 0;
  let problemWarned = false;
  const startedAt = new Date().toISOString();
  const warnOnce = (message) => {
    if (problemWarned) return;
    problemWarned = true;
    try { process.stderr.write(`WARNING: ${message}\n`); } catch { /* still never fail the build */ }
  };
  // Overwrite the single-object status snapshot; failure to write it must never break the build.
  // A link at the status name is warned once — later steps would otherwise repeat it.
  const writeStatus = (snap) => {
    if (!statusFile) return;
    try {
      writeFileSafe(statusFile, JSON.stringify({ startedAt, ...meta, ...snap }, null, 2) + '\n');
    } catch (err) {
      if (err && err.code === 'UNSAFE_OUTPUT') warnOnce(err.message);
    }
  };
  try {
    // Final component only. A junctioned ancestor is the caller's choice; a link at this
    // directory would make both files land outside the folder that was named.
    assertSafeOutputDir(dir, { create: true, ...fsOpts });
    file = path.join(dir, 'build-log.jsonl');
    statusFile = path.join(dir, 'build-status.json');
    append(file, { ts: startedAt, event: 'run-start', ...meta });
    writeStatus({ state: 'running', steps: 0 });
  } catch (err) {
    if (isLinkRefusal(err)) throw err;
    if (err && err.code === 'UNSAFE_OUTPUT') warnOnce(err.message);
    file = null;
    statusFile = null;
  }
  return {
    path: file,
    statusPath: statusFile,
    record(event) {
      if (!file) return;
      steps += 1;
      const ts = new Date().toISOString();
      try { append(file, { ts, event: 'step', ...event }); } catch (err) {
        if (isLinkRefusal(err)) throw err;
      }
      // Snapshot the latest step so `build-status.json` always reflects the current phase/label.
      writeStatus({ state: 'running', steps, lastPhase: event && event.phase, lastLabel: event && event.label, lastStatus: event && event.status, updatedAt: ts });
    },
    close(summary = {}) {
      if (!file) return;
      const ts = new Date().toISOString();
      try { append(file, { ts, event: 'run-end', ...summary }); } catch (err) {
        if (isLinkRefusal(err)) throw err;
      }
      writeStatus({ state: summary && summary.status === 'halt' ? 'halted' : 'done', steps, endedAt: ts, ...summary });
    },
  };
}

module.exports = { openJournal };
