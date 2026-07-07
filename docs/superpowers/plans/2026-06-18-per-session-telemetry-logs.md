# Per-session Local Telemetry Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the local telemetry diagnostic mirror from a single flat `~/.power-platform-skills/events.jsonl` into per-plugin, per-session files at `~/.power-platform-skills/telemetry/<pluginName>/sessions/<sessionId>/events.jsonl`, with 14-day age-based retention, so a user can hand over one self-contained file per problem.

**Architecture:** `shared/telemetry/lib/local-log.js` owns the on-disk layout. `appendLocal` derives the plugin + session from the event record's `data` and writes a deterministic per-session path (no directory scan, so concurrent short-lived dispatcher processes never race). New read helpers (`pluginLogDir`, `latestSessionLog`) let the `power-pages` telemetry skill's `status`/`off` output point the user at the latest session log. Retention prunes session directories older than 14 days, best-effort, on every write.

**Tech Stack:** Node.js (CommonJS, `node:fs`/`node:path`), `node:test` runner, zero npm dependencies.

**Spec:** `docs/superpowers/specs/2026-06-18-per-session-telemetry-logs-design.md`

---

## File Structure

- **Modify** `shared/telemetry/lib/local-log.js` — full rewrite of the layout. Adds `sanitizeSegment`, `pluginLogDir`, `latestSessionLog`, `pruneOldSessions`, the `MAX_LOG_AGE_DAYS` constant; changes `appendLocal` to write the per-session path. Keeps `LOG_FILE_NAME` (now the per-session filename) and `ROTATE_BYTES` (now a per-session size cap).
- **Modify** `shared/telemetry/lib/telemetry-config.js` — `status`/`off` output uses the new shared helpers instead of the local `logPath()`; `logPath()` is removed.
- **Modify** `shared/telemetry/tests/local-log.test.js` — rewritten for the new layout, sanitization, rollover, retention, and `latestSessionLog`.
- **Modify** `shared/telemetry/tests/telemetry-config.test.js` — assert the new `status`/`off` output (logs directory line, "No local logs yet", and naming an existing session log).
- **Modify** `shared/telemetry/tests/emit-dispatcher.test.js` — local-mirror path assertions move to the new per-session path (`nosession` fallback, since `fakeEvent` has no `sessionId`).

**No change** to `emit-dispatcher.js` (it already calls `appendLocal(localRecord, { configDir: localConfigDir() })` with the config root and a record whose `data` carries `pluginName` + `sessionId`). The legacy flat `events.jsonl` (and its `.old` rotations) is deleted best-effort via `removeLegacyFlatLog(configDir)` on the first `appendLocal` after this ships.

> **Note on the plugin copy:** `plugins/power-pages/scripts/lib/telemetry/lib` is a **mirrored physical copy** of `shared/telemetry/lib` (not a symlink — plugin hosts don't reliably dereference symlinks). Edit the files under `shared/telemetry/` first, then re-sync the copied files under `plugins/power-pages/scripts/lib/telemetry/lib` in the same change.

> **Test command (important):** Run a single test file with the explicit `*.test.js` path, e.g. `node --test shared/telemetry/tests/local-log.test.js`. Do NOT use `node --test shared/telemetry/tests/` (directory form) — it flakes on local Node 22.

---

## Task 1: New per-session write path in `local-log.js`

**Files:**
- Modify: `shared/telemetry/lib/local-log.js`
- Test: `shared/telemetry/tests/local-log.test.js`

- [ ] **Step 1: Replace the test file with the new-layout tests**

Overwrite `shared/telemetry/tests/local-log.test.js` with:

```javascript
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  appendLocal,
  pluginLogDir,
  sanitizeSegment,
  LOG_FILE_NAME,
  ROTATE_BYTES,
  MAX_LOG_AGE_DAYS,
} = require("../lib/local-log");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-local-log-"));
}

// Path where an event for (plugin, session) should land under the new layout.
function sessionLog(root, plugin, session) {
  return path.join(root, "telemetry", plugin, "sessions", session, LOG_FILE_NAME);
}

test("exports filename, rotate threshold, and retention window", () => {
  assert.equal(LOG_FILE_NAME, "events.jsonl");
  assert.equal(typeof ROTATE_BYTES, "number");
  assert.ok(ROTATE_BYTES >= 1024 * 1024);
  assert.equal(MAX_LOG_AGE_DAYS, 14);
});

test("appendLocal writes to telemetry/<plugin>/sessions/<session>/events.jsonl", () => {
  const root = mkTmp();
  const record = {
    name: "X",
    data: { eventName: "hello", pluginName: "power-pages", sessionId: "sess-1" },
  };
  appendLocal(record, { configDir: root });

  const logFile = sessionLog(root, "power-pages", "sess-1");
  assert.ok(fs.existsSync(logFile), "expected per-session events.jsonl");
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.name, "X");
  assert.equal(parsed.data.eventName, "hello");
});

test("appendLocal appends multiple events for the same session in order", () => {
  const root = mkTmp();
  const base = { pluginName: "power-pages", sessionId: "sess-1" };
  appendLocal({ name: "A", data: { ...base } }, { configDir: root });
  appendLocal({ name: "B", data: { ...base } }, { configDir: root });
  appendLocal({ name: "C", data: { ...base } }, { configDir: root });

  const contents = fs.readFileSync(sessionLog(root, "power-pages", "sess-1"), "utf8");
  const names = contents.trim().split("\n").map((l) => JSON.parse(l).name);
  assert.deepEqual(names, ["A", "B", "C"]);
});

test("different sessions and plugins land in distinct directories", () => {
  const root = mkTmp();
  appendLocal({ name: "A", data: { pluginName: "power-pages", sessionId: "s1" } }, { configDir: root });
  appendLocal({ name: "B", data: { pluginName: "power-pages", sessionId: "s2" } }, { configDir: root });
  appendLocal({ name: "C", data: { pluginName: "model-apps", sessionId: "s1" } }, { configDir: root });

  assert.ok(fs.existsSync(sessionLog(root, "power-pages", "s1")));
  assert.ok(fs.existsSync(sessionLog(root, "power-pages", "s2")));
  assert.ok(fs.existsSync(sessionLog(root, "model-apps", "s1")));
});

test("missing pluginName/sessionId fall back to unknown/nosession", () => {
  const root = mkTmp();
  appendLocal({ name: "A", data: { eventName: "x" } }, { configDir: root });
  assert.ok(fs.existsSync(sessionLog(root, "unknown", "nosession")));
});

test("filesystem-unsafe plugin/session are sanitized to one safe segment", () => {
  const root = mkTmp();
  appendLocal(
    { name: "A", data: { pluginName: "../evil", sessionId: "a/b c" } },
    { configDir: root }
  );
  // "../evil" -> "__evil"; "a/b c" -> "a_b_c" — no escape outside telemetry/
  assert.ok(fs.existsSync(sessionLog(root, "__evil", "a_b_c")));
  // nothing was written outside the telemetry tree
  assert.ok(!fs.existsSync(path.join(root, "evil")));
});

test("sanitizeSegment collapses unsafe chars and rejects dot segments", () => {
  assert.equal(sanitizeSegment("power-pages", "fb"), "power-pages");
  assert.equal(sanitizeSegment("a/b", "fb"), "a_b");
  assert.equal(sanitizeSegment("..", "fb"), "fb");
  assert.equal(sanitizeSegment(".", "fb"), "fb");
  assert.equal(sanitizeSegment("", "fb"), "fb");
  assert.equal(sanitizeSegment(undefined, "fb"), "fb");
});

test("appendLocal never throws when the target is not writable", () => {
  const root = mkTmp();
  // A file where the plugin directory needs to be — mkdir of a subpath fails.
  fs.mkdirSync(path.join(root, "telemetry"), { recursive: true });
  fs.writeFileSync(path.join(root, "telemetry", "power-pages"), "i am a file");
  appendLocal(
    { name: "X", data: { pluginName: "power-pages", sessionId: "s1" } },
    { configDir: root }
  );
});

test("appendLocal is a no-op when configDir is missing", () => {
  // Must not throw; nothing to assert beyond that.
  appendLocal({ name: "X", data: { pluginName: "p", sessionId: "s" } }, {});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test shared/telemetry/tests/local-log.test.js`
Expected: FAIL — the current module exports `appendLocal` but writes the flat `events.jsonl`, and does not export `pluginLogDir`/`sanitizeSegment`/`MAX_LOG_AGE_DAYS`.

- [ ] **Step 3: Rewrite `local-log.js` with the new layout (no rollover/prune yet)**

Replace the entire contents of `shared/telemetry/lib/local-log.js` with:

```javascript
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LOG_FILE_NAME = "events.jsonl";
const ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB per-session size safety cap
const MAX_LOG_AGE_DAYS = 14;
const MAX_LOG_AGE_MS = MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;

// pluginName and sessionId become DIRECTORY names on disk, so each must be
// reduced to a single safe path segment. Anything outside this allowlist is
// collapsed to "_"; values that would escape the tree or vanish (".", "..",
// empty, non-string) fall back to a fixed sentinel. This is a path-safety
// requirement — a malformed event record must never write outside telemetry/.
function sanitizeSegment(value, fallback) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
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
  try {
    fs.appendFileSync(logFile, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // swallow — fail closed; telemetry must never break a skill run
  }
}

module.exports = {
  appendLocal,
  pluginLogDir,
  sanitizeSegment,
  LOG_FILE_NAME,
  ROTATE_BYTES,
  MAX_LOG_AGE_DAYS,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test shared/telemetry/tests/local-log.test.js`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/local-log.js shared/telemetry/tests/local-log.test.js
git commit -m "telemetry(local-log): write per-plugin per-session events.jsonl"
```

---

## Task 2: Per-session size rollover

**Files:**
- Modify: `shared/telemetry/lib/local-log.js`
- Test: `shared/telemetry/tests/local-log.test.js`

- [ ] **Step 1: Add the rollover test**

Append to `shared/telemetry/tests/local-log.test.js`:

```javascript
test("appendLocal rotates a session log that exceeds ROTATE_BYTES", () => {
  const root = mkTmp();
  const dir = path.join(root, "telemetry", "power-pages", "sessions", "s1");
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, LOG_FILE_NAME);

  // Pre-fill the session log with > ROTATE_BYTES of data.
  const filler = "x".repeat(1024);
  const lines = Math.ceil(ROTATE_BYTES / filler.length) + 1;
  fs.writeFileSync(logFile, Array(lines).fill(filler).join("\n") + "\n");
  assert.ok(fs.statSync(logFile).size > ROTATE_BYTES);

  appendLocal(
    { name: "AFTER-ROTATE", data: { pluginName: "power-pages", sessionId: "s1" } },
    { configDir: root }
  );

  // The oversized file was renamed to events.<stamp>.old in the SAME session dir.
  const olds = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("events.") && f.endsWith(".old"));
  assert.equal(olds.length, 1, `expected one rotated file, found ${olds.length}`);

  const fresh = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(fresh.length, 1);
  assert.equal(JSON.parse(fresh[0]).name, "AFTER-ROTATE");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test shared/telemetry/tests/local-log.test.js`
Expected: FAIL — `appendLocal` currently appends past `ROTATE_BYTES` (no rotation), so `olds.length` is `0` and the fresh-file line count is wrong.

- [ ] **Step 3: Add `rotationName` + `rotateIfNeeded` and call it in `appendLocal`**

In `shared/telemetry/lib/local-log.js`, add these two functions immediately above `appendLocal`:

```javascript
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
```

Then, in `appendLocal`, add the `rotateIfNeeded` call between computing `logFile` and the append:

```javascript
  const logFile = path.join(dir, LOG_FILE_NAME);
  rotateIfNeeded(dir, logFile);
  try {
    fs.appendFileSync(logFile, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // swallow — fail closed; telemetry must never break a skill run
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test shared/telemetry/tests/local-log.test.js`
Expected: PASS (all tests, including the rollover test).

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/local-log.js shared/telemetry/tests/local-log.test.js
git commit -m "telemetry(local-log): per-session 10MB size rollover"
```

---

## Task 3: Age-based retention (`pruneOldSessions`)

**Files:**
- Modify: `shared/telemetry/lib/local-log.js`
- Test: `shared/telemetry/tests/local-log.test.js`

- [ ] **Step 1: Add the retention test**

Append to `shared/telemetry/tests/local-log.test.js`:

```javascript
const { pruneOldSessions } = require("../lib/local-log");

test("appendLocal prunes session dirs older than 14 days, keeps recent ones", () => {
  const root = mkTmp();
  // An OLD session: write it, then backdate its events.jsonl 15 days.
  appendLocal({ name: "old", data: { pluginName: "power-pages", sessionId: "old" } }, { configDir: root });
  const oldLog = sessionLog(root, "power-pages", "old");
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldLog, fifteenDaysAgo, fifteenDaysAgo);

  // A NEW write in another session triggers the prune sweep.
  appendLocal({ name: "new", data: { pluginName: "power-pages", sessionId: "new" } }, { configDir: root });

  assert.ok(!fs.existsSync(path.dirname(oldLog)), "old session dir should be pruned");
  assert.ok(fs.existsSync(sessionLog(root, "power-pages", "new")), "new session kept");
});

test("pruneOldSessions removes an orphan dir only when its own mtime is past the window", () => {
  const root = mkTmp();
  const sessionsRoot = pluginLogDir(root, "power-pages");
  // Orphan dir (no events.jsonl) backdated 15 days -> removed.
  const stale = path.join(sessionsRoot, "stale-orphan");
  fs.mkdirSync(stale, { recursive: true });
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, fifteenDaysAgo, fifteenDaysAgo);
  // Fresh orphan dir (no events.jsonl, just created) -> kept (race guard).
  const fresh = path.join(sessionsRoot, "fresh-orphan");
  fs.mkdirSync(fresh, { recursive: true });

  pruneOldSessions(root, "power-pages");

  assert.ok(!fs.existsSync(stale), "stale orphan dir pruned");
  assert.ok(fs.existsSync(fresh), "fresh orphan dir kept");
});

test("pruneOldSessions never throws when the sessions dir does not exist", () => {
  const root = mkTmp();
  pruneOldSessions(root, "never-used-plugin"); // must be a silent no-op
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test shared/telemetry/tests/local-log.test.js`
Expected: FAIL — `pruneOldSessions` is not exported / not defined; the old session dir is not removed.

- [ ] **Step 3: Add `pruneOldSessions`, call it from `appendLocal`, export it**

In `shared/telemetry/lib/local-log.js`, add `pruneOldSessions` below `appendLocal`:

```javascript
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
```

Add the call as the last line of `appendLocal` (after the append `try/catch`):

```javascript
  pruneOldSessions(configDir, data.pluginName);
}
```

Add `pruneOldSessions` to `module.exports`:

```javascript
module.exports = {
  appendLocal,
  pluginLogDir,
  pruneOldSessions,
  sanitizeSegment,
  LOG_FILE_NAME,
  ROTATE_BYTES,
  MAX_LOG_AGE_DAYS,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test shared/telemetry/tests/local-log.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/local-log.js shared/telemetry/tests/local-log.test.js
git commit -m "telemetry(local-log): 14-day age-based session retention"
```

---

## Task 4: `latestSessionLog` discoverability helper

**Files:**
- Modify: `shared/telemetry/lib/local-log.js`
- Test: `shared/telemetry/tests/local-log.test.js`

- [ ] **Step 1: Add the discoverability test**

Append to `shared/telemetry/tests/local-log.test.js`:

```javascript
const { latestSessionLog } = require("../lib/local-log");

test("latestSessionLog returns null when no sessions exist", () => {
  const root = mkTmp();
  assert.equal(latestSessionLog(root, "power-pages"), null);
});

test("latestSessionLog returns the most-recently-written session's log", () => {
  const root = mkTmp();
  appendLocal({ name: "A", data: { pluginName: "power-pages", sessionId: "old" } }, { configDir: root });
  appendLocal({ name: "B", data: { pluginName: "power-pages", sessionId: "new" } }, { configDir: root });

  // Make "old" clearly older so mtime ordering is deterministic.
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(sessionLog(root, "power-pages", "old"), tenMinAgo, tenMinAgo);

  assert.equal(latestSessionLog(root, "power-pages"), sessionLog(root, "power-pages", "new"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test shared/telemetry/tests/local-log.test.js`
Expected: FAIL — `latestSessionLog` is not exported / not defined.

- [ ] **Step 3: Add `latestSessionLog` and export it**

In `shared/telemetry/lib/local-log.js`, add below `pruneOldSessions`:

```javascript
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
```

Add `latestSessionLog` to `module.exports`:

```javascript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test shared/telemetry/tests/local-log.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/local-log.js shared/telemetry/tests/local-log.test.js
git commit -m "telemetry(local-log): add latestSessionLog helper"
```

---

## Task 5: Update `telemetry-config.js` status/off output

**Files:**
- Modify: `shared/telemetry/lib/telemetry-config.js`
- Test: `shared/telemetry/tests/telemetry-config.test.js`

- [ ] **Step 1: Add tests for the new output**

Append to `shared/telemetry/tests/telemetry-config.test.js` (after the existing tests; `fs`/`os`/`path` are already imported at the top of that file):

```javascript
const { appendLocal } = require("../lib/local-log");

test("status names the logs directory and says none yet when empty", () => {
  const dir = mkTmp();
  const { status, stdout } = run(["--action", "status", "--plugin", "power-pages"], dir);
  assert.equal(status, 0);
  assert.match(stdout, /Logs directory:/);
  assert.match(stdout, /No local logs yet for power-pages/);
});

test("status names the most recent session log when one exists", () => {
  const dir = mkTmp();
  // Seed a session log under the new layout via the real writer.
  appendLocal(
    { name: "X", data: { pluginName: "power-pages", sessionId: "sess-9" } },
    { configDir: dir }
  );
  const { stdout } = run(["--action", "status", "--plugin", "power-pages"], dir);
  assert.match(stdout, /Most recent session:/);
  assert.match(stdout, /sess-9/);
  assert.match(stdout, /Share that file when reporting an issue/);
});

test("off output names the logs directory too", () => {
  const dir = mkTmp();
  const { stdout } = run(["--action", "off", "--plugin", "power-pages"], dir);
  assert.match(stdout, /local diagnostic log is still kept/i);
  assert.match(stdout, /Logs directory:/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test shared/telemetry/tests/telemetry-config.test.js`
Expected: FAIL — the current output prints `Local log: <...>/events.jsonl` and contains no `Logs directory:` / `No local logs yet` / `Most recent session:` lines.

- [ ] **Step 3: Rewrite the output in `telemetry-config.js`**

In `shared/telemetry/lib/telemetry-config.js`:

(a) Add the shared require near the top, after the existing `require("./user-config")` line:

```javascript
const { pluginLogDir, latestSessionLog } = require("./local-log");
```

(b) Delete the `logPath()` function entirely:

```javascript
function logPath() {
  return path.join(configDir(), "events.jsonl");
}
```

(c) Add a shared output helper just above `function main()`:

```javascript
// Print where this plugin's local diagnostic logs live and name the newest
// session file, so a user can hand over exactly the log for the session they
// just hit a problem in. Reuses the shared layout helpers (DRY — no path logic
// is duplicated in the skill).
function emitLogLocations(dir, plugin) {
  out(`Logs directory: ${pluginLogDir(dir, plugin)}`);
  const latest = latestSessionLog(dir, plugin);
  if (latest) {
    out(`Most recent session: ${latest}`);
    out("ℹ️  Share that file when reporting an issue (it covers your latest session).");
  } else {
    out(`No local logs yet for ${plugin}.`);
  }
}
```

(d) In the `status` branch, replace the ON/OFF bodies that referenced `logPath()`:

```javascript
  if (action === "status") {
    const on = effectiveTelemetryChoice(dir, plugin) !== "off"; // default ON; honors env override when no stored choice
    if (on) {
      out(`Telemetry (${plugin}): ON`);
      out(ANONYMITY);
      emitLogLocations(dir, plugin);
    } else {
      out(`Telemetry (${plugin}): OFF — nothing is transmitted.`);
      out(`A local diagnostic log is still kept.`);
      emitLogLocations(dir, plugin);
      out(`Re-enable anytime with /${plugin}:telemetry on.`);
      out(ANONYMITY);
    }
    process.exit(0);
  }
```

(e) In the action-write branch, replace the `off` body that referenced `logPath()`:

```javascript
  if (action === "off") {
    out(`Telemetry (${plugin}): OFF — nothing is transmitted.`);
    out(`A local diagnostic log is still kept.`);
    emitLogLocations(dir, plugin);
    out(`Re-enable anytime with /${plugin}:telemetry on.`);
  } else {
    out(`Telemetry (${plugin}): ON`);
  }
  out(ANONYMITY);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test shared/telemetry/tests/telemetry-config.test.js`
Expected: PASS — both the existing tests (still match `OFF` / `local diagnostic log is still kept` / `Telemetry (power-pages): ON`) and the three new tests.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/telemetry-config.js shared/telemetry/tests/telemetry-config.test.js
git commit -m "telemetry(skill): status/off output points at per-session logs"
```

---

## Task 6: Update `emit-dispatcher.test.js` mirror-path assertions

**Files:**
- Test: `shared/telemetry/tests/emit-dispatcher.test.js`

> `emit-dispatcher.js` needs no change — only its test asserts the old flat path. `fakeEvent` carries `pluginName: "power-pages"` and **no `sessionId`**, so its local mirror now lands at `tmp/telemetry/power-pages/sessions/nosession/events.jsonl`.

- [ ] **Step 1: Add a mirror-path helper**

In `shared/telemetry/tests/emit-dispatcher.test.js`, add this helper right after the `mkTmp` function (near the top):

```javascript
// Local-mirror path for fakeEvent under the per-session layout. fakeEvent has
// pluginName "power-pages" and NO sessionId, so it falls back to "nosession".
function mirrorPath(tmp) {
  return path.join(tmp, "telemetry", "power-pages", "sessions", "nosession", "events.jsonl");
}
```

- [ ] **Step 2: Fix the two NEGATIVE assertions first (mirror must NOT exist)**

Some tests assert the local log was NOT written (the cases where the kill switch / fail-closed gate fires before the mirror). For **every** assertion of the form:

```javascript
    !fs.existsSync(path.join(tmp, "events.jsonl")),
```

replace it with:

```javascript
    !fs.existsSync(path.join(tmp, "telemetry")),
```

There are exactly **two** such occurrences — in the tests `"dispatcher honours the repo kill switch (ikey.json disabled:true)"` and `"dispatcher fails closed when ikey.json is missing/unreadable"`.

Verify none remain: searching the file for `!fs.existsSync(path.join(tmp, "events.jsonl"))` must return zero matches after this step. (This must be done BEFORE Step 3's blanket replace, so the negative assertions aren't rewritten to a positive path.)

- [ ] **Step 3: Fix the POSITIVE assertions (mirror written + contents)**

Replace every remaining `path.join(tmp, "events.jsonl")` with `mirrorPath(tmp)`. These appear in the tests that assert the local mirror WAS written and inspect its contents:
- `"dispatcher appends to events.jsonl when iKey is placeholder"`
- `"dispatcher ALSO appends to events.jsonl when a real iKey POSTs ..."`
- `"dispatcher writes the local mirror when opted out via config, but does NOT POST"`
- and any other `path.join(tmp, "events.jsonl")` still present (e.g. the readFileSync content assertions and the "local mirror still written" checks).

After this step, searching the file for `path.join(tmp, "events.jsonl")` must return zero matches.

- [ ] **Step 4: Run the dispatcher tests to verify they pass**

Run: `node --test shared/telemetry/tests/emit-dispatcher.test.js`
Expected: PASS. (The dispatcher writes the mirror to the new per-session path; the negative cases write nothing under `telemetry/`.)

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/tests/emit-dispatcher.test.js
git commit -m "test(telemetry): assert per-session mirror path in dispatcher tests"
```

---

## Task 7: Full telemetry suite green

**Files:** none (verification only)

- [ ] **Step 1: Run the whole telemetry test suite, file by file**

The directory form of `node --test` flakes on local Node 22, so run each file. Run:

```bash
node --test shared/telemetry/tests/local-log.test.js
node --test shared/telemetry/tests/telemetry-config.test.js
node --test shared/telemetry/tests/emit-dispatcher.test.js
node --test shared/telemetry/tests/user-config.test.js
node --test shared/telemetry/tests/events.test.js
```

Expected: every file reports `pass` with `0` failures. (`user-config` and `events` are unrelated but confirm nothing regressed.)

- [ ] **Step 2: Confirm no stray references to the old flat path remain in the telemetry library**

Search `shared/telemetry/lib/` for `"events.jsonl"`. Expected: the only definition is `LOG_FILE_NAME` in `local-log.js`; `telemetry-config.js` no longer constructs `events.jsonl` and no longer defines `logPath()`.

- [ ] **Step 3: Final commit (if Step 1/2 surfaced any fixes; otherwise skip)**

```bash
git add -A shared/telemetry
git commit -m "telemetry: finalize per-session local log layout"
```

---

## Notes for the implementer

- **Edit `shared/telemetry/` first, then re-sync the plugin copy.** `power-pages` bundles a **mirrored physical copy** at `scripts/lib/telemetry/lib` (not a symlink), so the same change must refresh both trees.
- **Delete the legacy flat log best-effort.** `appendLocal` calls `removeLegacyFlatLog(configDir)`, which removes the pre-per-session `~/.power-platform-skills/events.jsonl` (and its `.old` rotations) on the first write after this ships. Its contents are not migrated — it is ephemeral diagnostic data.
- **Out of scope:** no `share`/`export` command and no change to the `report-issue` skill. (Future option, not in this plan: `report-issue` could call `latestSessionLog` to point the user at the file to attach.)
- After all tasks, update the telemetry prose in `plugins/power-pages/CLAUDE.md` and `shared/telemetry/README.md` if they name the old `events.jsonl` path — check with: search those two files for `events.jsonl`. (Documentation-only; do it as a final docs commit if matches are found.)
