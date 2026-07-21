"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  appendLocal,
  pluginLogDir,
  latestSessionLog,
  pruneOldSessions,
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
  // "../evil" -> "___evil" (each of ".", ".", "/" collapses to "_"); "a/b c"
  // -> "a_b_c" — the point is that nothing escapes outside telemetry/.
  assert.ok(fs.existsSync(sessionLog(root, "___evil", "a_b_c")));
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

test("appendLocal does NOT prune on a repeat append to an existing session", () => {
  const root = mkTmp();
  // Establish an existing session, then age a second session's log past the window.
  appendLocal({ name: "keep", data: { pluginName: "power-pages", sessionId: "keep" } }, { configDir: root });
  appendLocal({ name: "old", data: { pluginName: "power-pages", sessionId: "old" } }, { configDir: root });
  const oldLog = sessionLog(root, "power-pages", "old");
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldLog, fifteenDaysAgo, fifteenDaysAgo);

  // A second append to the EXISTING "keep" session must not create a dir, so the
  // sweep is skipped and the aged "old" session survives until a new session starts.
  appendLocal({ name: "keep2", data: { pluginName: "power-pages", sessionId: "keep" } }, { configDir: root });

  assert.ok(fs.existsSync(path.dirname(oldLog)), "old session dir kept — no sweep on repeat append");
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

test("pruneOldSessions is a silent no-op when configDir is missing", () => {
  // Documented contract is "never throws"; a falsy configDir must not reach path.join.
  pruneOldSessions(undefined, "power-pages");
});

test("latestSessionLog returns null when no sessions exist", () => {
  const root = mkTmp();
  assert.equal(latestSessionLog(root, "power-pages"), null);
});

test("latestSessionLog returns null when configDir is missing", () => {
  // User-facing status path must fail closed rather than throw from path.join.
  assert.equal(latestSessionLog(undefined, "power-pages"), null);
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

test("latestSessionLog skips session dirs that have no events.jsonl", () => {
  const root = mkTmp();
  // A real session that actually wrote a log.
  appendLocal({ name: "A", data: { pluginName: "power-pages", sessionId: "real" } }, { configDir: root });

  // An orphaned session dir with no events.jsonl (e.g. mkdir succeeded but the
  // process died before the first append). Make it NEWER than the real one so a
  // naive dir-mtime scan would wrongly prefer it — the returned path must still
  // be the real log, because status surfaces this path for the user to share.
  const orphanDir = path.join(pluginLogDir(root, "power-pages"), "orphan");
  fs.mkdirSync(orphanDir, { recursive: true });

  assert.equal(latestSessionLog(root, "power-pages"), sessionLog(root, "power-pages", "real"));
});

test("latestSessionLog returns null when every session dir lacks a log", () => {
  const root = mkTmp();
  fs.mkdirSync(path.join(pluginLogDir(root, "power-pages"), "orphan"), { recursive: true });
  assert.equal(latestSessionLog(root, "power-pages"), null);
});
