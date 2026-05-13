"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const sessionPath = path.resolve(__dirname, "../lib/session.js");

test("getSessionId returns a non-empty string", () => {
  const { getSessionId } = require(sessionPath);
  const id = getSessionId();
  assert.equal(typeof id, "string");
  assert.ok(id.length >= 32, `expected UUID-length, got ${id}`);
});

test("getSessionId is stable within a process", () => {
  const { getSessionId } = require(sessionPath);
  assert.equal(getSessionId(), getSessionId());
});

test("getSessionId is unique across processes", () => {
  const script = `process.stdout.write(require('${sessionPath.replace(/\\/g, "\\\\")}').getSessionId());`;
  const a = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  const b = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.notEqual(a.stdout, b.stdout);
  assert.ok(a.stdout.length >= 32);
});
