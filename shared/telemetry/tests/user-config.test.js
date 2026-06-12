"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  readTelemetryChoice,
  setTelemetryChoice,
  isTransmissionOptedOut,
  CONFIG_FILE_NAME,
} = require("../lib/user-config");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cfg-"));
}
function readRaw(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE_NAME), "utf8"));
}

test("readTelemetryChoice returns null when no config file exists", () => {
  const dir = mkTmp();
  assert.equal(readTelemetryChoice(dir, "power-pages"), null);
  assert.equal(isTransmissionOptedOut(dir, "power-pages"), false);
});

test("setTelemetryChoice writes a per-plugin key and reads back", () => {
  const dir = mkTmp();
  assert.equal(setTelemetryChoice(dir, "power-pages", "off"), true);
  assert.equal(readTelemetryChoice(dir, "power-pages"), "off");
  assert.equal(isTransmissionOptedOut(dir, "power-pages"), true);
  assert.deepEqual(readRaw(dir), { telemetry: { "power-pages": "off" } });
});

test("setTelemetryChoice is per-plugin isolated and preserves other keys", () => {
  const dir = mkTmp();
  // seed an unrelated top-level key + another plugin's choice
  fs.writeFileSync(
    path.join(dir, CONFIG_FILE_NAME),
    JSON.stringify({ schemaVersion: 1, telemetry: { "model-apps": "off" } })
  );
  setTelemetryChoice(dir, "power-pages", "off");
  const raw = readRaw(dir);
  assert.equal(raw.schemaVersion, 1, "must preserve unrelated keys");
  assert.equal(raw.telemetry["model-apps"], "off", "must not touch other plugins");
  assert.equal(raw.telemetry["power-pages"], "off");
  // a different plugin is unaffected by power-pages being off
  assert.equal(isTransmissionOptedOut(dir, "code-apps"), false);
});

test("setTelemetryChoice flips off -> on", () => {
  const dir = mkTmp();
  setTelemetryChoice(dir, "power-pages", "off");
  setTelemetryChoice(dir, "power-pages", "on");
  assert.equal(readTelemetryChoice(dir, "power-pages"), "on");
  assert.equal(isTransmissionOptedOut(dir, "power-pages"), false);
});

test("setTelemetryChoice rejects invalid input without throwing", () => {
  const dir = mkTmp();
  assert.equal(setTelemetryChoice(dir, "power-pages", "maybe"), false);
  assert.equal(setTelemetryChoice(dir, "", "off"), false);
  assert.equal(readTelemetryChoice(dir, "power-pages"), null);
});

test("readTelemetryChoice tolerates a corrupt config file (returns null)", () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), "{ not json");
  assert.equal(readTelemetryChoice(dir, "power-pages"), null);
});

test("an array config.json is ignored — setTelemetryChoice still persists", () => {
  const dir = mkTmp();
  // A JSON array passes `typeof === "object"`. Without the array guard, the write
  // would set `.telemetry` on the array, JSON.stringify would drop it, and the
  // choice would silently vanish while setTelemetryChoice returned true.
  fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify(["junk"]));
  assert.equal(setTelemetryChoice(dir, "power-pages", "off"), true);
  assert.equal(readTelemetryChoice(dir, "power-pages"), "off");
  assert.deepEqual(readRaw(dir), { telemetry: { "power-pages": "off" } });
});

test("setTelemetryChoice fails safe (returns false) when the dir cannot be created", () => {
  const dir = mkTmp();
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "i am a file");
  // configDir is a path *under* a file, so mkdir must fail
  assert.equal(setTelemetryChoice(path.join(blocker, "sub"), "power-pages", "off"), false);
});
