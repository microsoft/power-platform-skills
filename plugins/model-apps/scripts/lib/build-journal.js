'use strict';
// Append-only JSONL build journal for app-builder. DIAGNOSTIC ONLY: it records what a build
// run did and where it halted, so a crashed/failed run leaves a durable trace. It is NOT a replayed
// checkpoint — resume is "re-run the same command" (the build is idempotent: it reuses everything
// already created). Every fs op is guarded so journaling can NEVER throw into (and fail) a build.

const fs = require('node:fs');
const path = require('node:path');

function append(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// Open (create/append) `<dir>/build-log.jsonl` and write a run-start header. Returns a recorder
// whose methods are all no-ops if the file couldn't be opened (e.g. an unwritable dir).
function openJournal(dir, meta = {}) {
  let file = null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'build-log.jsonl');
    append(file, { ts: new Date().toISOString(), event: 'run-start', ...meta });
  } catch {
    file = null;
  }
  return {
    path: file,
    record(event) {
      if (!file) return;
      try { append(file, { ts: new Date().toISOString(), event: 'step', ...event }); } catch { /* never fail the build */ }
    },
    close(summary = {}) {
      if (!file) return;
      try { append(file, { ts: new Date().toISOString(), event: 'run-end', ...summary }); } catch { /* ignore */ }
    },
  };
}

module.exports = { openJournal };
