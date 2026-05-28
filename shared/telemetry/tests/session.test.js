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

test("getSessionId is unique across processes when no override is provided", () => {
  const script = `process.stdout.write(require('${sessionPath.replace(/\\/g, "\\\\")}').getSessionId());`;
  const a = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  const b = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.notEqual(a.stdout, b.stdout);
  assert.ok(a.stdout.length >= 32);
});

test("getSessionId honors the override (sessionId provided by hook payload)", () => {
  const { getSessionId, _resetCache } = require(sessionPath);
  _resetCache();
  const claudeSessionId = "abc-claude-session-123";
  assert.equal(getSessionId(claudeSessionId), claudeSessionId);
  // subsequent calls without override return the cached primed value
  assert.equal(getSessionId(), claudeSessionId);
  assert.equal(getSessionId(""), claudeSessionId);
  assert.equal(getSessionId(undefined), claudeSessionId);
});

test("getSessionId override wins over a previously cached UUID", () => {
  const { getSessionId, _resetCache } = require(sessionPath);
  _resetCache();
  const generated = getSessionId();
  const claudeSessionId = "xyz-claude-session-456";
  assert.equal(getSessionId(claudeSessionId), claudeSessionId);
  assert.notEqual(generated, claudeSessionId);
});

test("getSessionId is stable across multiple processes when same override is used", () => {
  const script = `process.stdout.write(require('${sessionPath.replace(/\\/g, "\\\\")}').getSessionId("primed-id-999"));`;
  const a = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  const b = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  assert.equal(a.stdout, "primed-id-999");
  assert.equal(b.stdout, "primed-id-999");
});
