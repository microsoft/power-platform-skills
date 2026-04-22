"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { appendLocal, LOG_FILE_NAME, ROTATE_BYTES } = require("../lib/local-log");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-local-log-"));
}

test("exports the log filename and rotate threshold", () => {
  assert.equal(LOG_FILE_NAME, "events.jsonl");
  assert.equal(typeof ROTATE_BYTES, "number");
  assert.ok(ROTATE_BYTES >= 1024 * 1024);
});

test("appendLocal creates the configDir and writes one JSON line", () => {
  const tmp = mkTmp();
  const nested = path.join(tmp, "sub", "dir"); // doesn't exist yet
  appendLocal({ name: "X", data: { eventName: "hello" } }, { configDir: nested });
  const logFile = path.join(nested, LOG_FILE_NAME);
  assert.ok(fs.existsSync(logFile));
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.name, "X");
  assert.equal(parsed.data.eventName, "hello");
});

test("appendLocal appends multiple events on subsequent calls", () => {
  const tmp = mkTmp();
  appendLocal({ name: "A", data: {} }, { configDir: tmp });
  appendLocal({ name: "B", data: {} }, { configDir: tmp });
  appendLocal({ name: "C", data: {} }, { configDir: tmp });
  const contents = fs.readFileSync(path.join(tmp, LOG_FILE_NAME), "utf8");
  const names = contents
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).name);
  assert.deepEqual(names, ["A", "B", "C"]);
});

test("appendLocal rotates when file exceeds ROTATE_BYTES", () => {
  const tmp = mkTmp();
  const logFile = path.join(tmp, LOG_FILE_NAME);
  // Pre-fill log with > ROTATE_BYTES of data
  const filler = "x".repeat(1024);
  const lines = Math.ceil(ROTATE_BYTES / filler.length) + 1;
  fs.writeFileSync(logFile, Array(lines).fill(filler).join("\n") + "\n");
  assert.ok(fs.statSync(logFile).size > ROTATE_BYTES);

  appendLocal({ name: "AFTER-ROTATE", data: {} }, { configDir: tmp });

  const olds = fs
    .readdirSync(tmp)
    .filter((f) => f.startsWith("events.") && f.endsWith(".old"));
  assert.equal(olds.length, 1, `expected one rotated file, found ${olds.length}`);

  const fresh = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(fresh.length, 1);
  assert.equal(JSON.parse(fresh[0]).name, "AFTER-ROTATE");
});

test("appendLocal never throws even when configDir is not writable", () => {
  // Pass a path that cannot be created as a directory because a file exists there
  const tmp = mkTmp();
  const blocker = path.join(tmp, "blocker");
  fs.writeFileSync(blocker, "i am a file, not a directory");
  // Calling appendLocal with `blocker` as configDir should not throw.
  appendLocal({ name: "X", data: {} }, { configDir: blocker });
});
