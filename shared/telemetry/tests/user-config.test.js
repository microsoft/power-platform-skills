"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  readTelemetryChoice,
  setTelemetryChoice,
  isTransmissionOptedOut: _isTransmissionOptedOut,
  telemetryOptOutEnvVarName,
  readTelemetryEnvOptOut,
  effectiveTelemetryChoice,
  CONFIG_FILE_NAME,
} = require("../lib/user-config");

// Wrap so this suite defaults to an EMPTY env instead of process.env. That keeps
// every pre-existing assertion deterministic regardless of any
// POWER_PLATFORM_SKILLS_TELEMETRY_*_OPTOUT var set in the CI environment. Tests
// that exercise the opt-out pass an explicit env object as the third argument.
function isTransmissionOptedOut(dir, plugin, env = {}) {
  return _isTransmissionOptedOut(dir, plugin, env);
}

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

test("telemetryOptOutEnvVarName derives an uppercase, underscore-separated _OPTOUT name", () => {
  assert.equal(
    telemetryOptOutEnvVarName("power-pages"),
    "POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT"
  );
  // runs of non-alphanumerics collapse to a single underscore
  assert.equal(
    telemetryOptOutEnvVarName("model--apps.v2"),
    "POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_V2_OPTOUT"
  );
});

test("readTelemetryEnvOptOut is true only for truthy values (1/true, case-insensitive)", () => {
  const name = "POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT";
  assert.equal(readTelemetryEnvOptOut("power-pages", { [name]: "1" }), true);
  assert.equal(readTelemetryEnvOptOut("power-pages", { [name]: "true" }), true);
  assert.equal(readTelemetryEnvOptOut("power-pages", { [name]: " TRUE " }), true);
});

test("readTelemetryEnvOptOut is false for unset / falsy / garbage / missing plugin", () => {
  const name = "POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT";
  assert.equal(readTelemetryEnvOptOut("power-pages", {}), false);
  assert.equal(readTelemetryEnvOptOut("power-pages", { [name]: "0" }), false);
  assert.equal(readTelemetryEnvOptOut("power-pages", { [name]: "false" }), false);
  assert.equal(readTelemetryEnvOptOut("power-pages", { [name]: "" }), false);
  assert.equal(readTelemetryEnvOptOut("power-pages", { [name]: "yes" }), false);
  assert.equal(readTelemetryEnvOptOut("", { [name]: "1" }), false);
});

test("effectiveTelemetryChoice: env opt-out wins over a persisted 'on' choice", () => {
  const dir = mkTmp();
  const name = "POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT";
  setTelemetryChoice(dir, "power-pages", "on");
  // env var has the highest precedence and forces "off"
  assert.equal(effectiveTelemetryChoice(dir, "power-pages", { [name]: "1" }), "off");
});

test("effectiveTelemetryChoice: falls back to config / default-on when opt-out is not set", () => {
  const dir = mkTmp();
  const name = "POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT";
  // not set => config choice governs
  setTelemetryChoice(dir, "power-pages", "on");
  assert.equal(effectiveTelemetryChoice(dir, "power-pages", { [name]: "0" }), "on");
  // a falsy opt-out never re-enables a config opt-out
  setTelemetryChoice(dir, "power-pages", "off");
  assert.equal(effectiveTelemetryChoice(dir, "power-pages", { [name]: "false" }), "off");
  // neither set => default-on (null)
  assert.equal(effectiveTelemetryChoice(mkTmp(), "power-pages", {}), null);
});

test("isTransmissionOptedOut: env opt-out opts out even when config says on", () => {
  const dir = mkTmp();
  const name = "POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT";
  setTelemetryChoice(dir, "power-pages", "on");
  assert.equal(isTransmissionOptedOut(dir, "power-pages", { [name]: "true" }), true);
});

test("isTransmissionOptedOut: config off still opts out with no env var set", () => {
  const dir = mkTmp();
  setTelemetryChoice(dir, "power-pages", "off");
  assert.equal(isTransmissionOptedOut(dir, "power-pages", {}), true);
});
