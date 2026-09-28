'use strict';
// Append-only JSONL build journal for app-builder. DIAGNOSTIC ONLY: it records what a build
// run did and where it halted, so a crashed/failed run leaves a durable trace. It is NOT a replayed
// checkpoint — resume is "re-run the same command" (the build is idempotent: it reuses everything
// already created). Every fs op is guarded so journaling can NEVER throw into (and fail) a build.
//
// It ALSO maintains `<dir>/build-status.json` — a single-object snapshot OVERWRITTEN on every step —
// so a long build's live progress is observable with one cheap read even when the launching shell
// buffers stdout (e.g. piping through Select-Object). Tail `build-log.jsonl` for the full trace, or
// read `build-status.json` for "where is it right now".

const fs = require('node:fs');
const path = require('node:path');

function append(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Open (create/append) `<dir>/build-log.jsonl` and write a run-start header. Returns a recorder
// whose methods are all no-ops if the file couldn't be opened (e.g. an unwritable dir).
function openJournal(dir, meta = {}) {
  let file = null;
  let statusFile = null;
  let steps = 0;
  const startedAt = new Date().toISOString();
  // Overwrite the single-object status snapshot; failure to write it must never break the build.
  const writeStatus = (snap) => {
    if (!statusFile) return;
    try { fs.writeFileSync(statusFile, JSON.stringify({ startedAt, ...meta, ...snap }, null, 2) + '\n'); } catch { /* never fail the build */ }
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'build-log.jsonl');
    statusFile = path.join(dir, 'build-status.json');
    append(file, { ts: startedAt, event: 'run-start', ...meta });
    writeStatus({ state: 'running', steps: 0 });
  } catch {
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
      try { append(file, { ts, event: 'step', ...event }); } catch { /* never fail the build */ }
      // Snapshot the latest step so `build-status.json` always reflects the current phase/label.
      writeStatus({ state: 'running', steps, lastPhase: event && event.phase, lastLabel: event && event.label, lastStatus: event && event.status, updatedAt: ts });
    },
    close(summary = {}) {
      if (!file) return;
      const ts = new Date().toISOString();
      try { append(file, { ts, event: 'run-end', ...summary }); } catch { /* ignore */ }
      writeStatus({ state: summary && summary.status === 'halt' ? 'halted' : 'done', steps, endedAt: ts, ...summary });
    },
  };
}

module.exports = { openJournal };
