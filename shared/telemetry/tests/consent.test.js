"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const consentLib = require("../lib/consent");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-consent-"));
}

test("read returns { state: 'enabled' } when file is missing (default-on)", () => {
  const tmp = mkTmp();
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "enabled");
  assert.equal(result.record, null);
});

test("read returns { state: 'enabled' } when file is malformed JSON (default-on)", () => {
  const tmp = mkTmp();
  fs.writeFileSync(path.join(tmp, "telemetry.json"), "{not json");
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "enabled");
});

test("write followed by read round-trips", () => {
  const tmp = mkTmp();
  consentLib.write({ configDir: tmp, enabled: true });
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "enabled");
  assert.equal(result.record.enabled, true);
  assert.equal(result.record.version, 1);
  assert.ok(result.record.recorded_at);
});

test("write enabled=false produces state: 'disabled'", () => {
  const tmp = mkTmp();
  consentLib.write({ configDir: tmp, enabled: false });
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "disabled");
  assert.equal(result.record.enabled, false);
});

test("explicit opt-out is preserved across schema versions", () => {
  const tmp = mkTmp();
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({ version: 99, enabled: false })
  );
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "disabled");
});

test("future schema version with enabled=true falls back to default-on", () => {
  const tmp = mkTmp();
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({ version: 99, enabled: true })
  );
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "enabled");
});

test("env var POWER_PLATFORM_SKILLS_TELEMETRY=0 overrides to 'disabled'", () => {
  const tmp = mkTmp();
  consentLib.write({ configDir: tmp, enabled: true });
  const result = consentLib.read({
    configDir: tmp,
    env: { POWER_PLATFORM_SKILLS_TELEMETRY: "0" },
  });
  assert.equal(result.state, "disabled");
});

test("env var POWER_PLATFORM_SKILLS_TELEMETRY=1 has no effect (file missing → enabled by default)", () => {
  const tmp = mkTmp();
  const result = consentLib.read({
    configDir: tmp,
    env: { POWER_PLATFORM_SKILLS_TELEMETRY: "1" },
  });
  assert.equal(result.state, "enabled");
});

test("check-consent CLI prints ENABLED when file is missing (default-on)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  const cli = path.resolve(__dirname, "../lib/check-consent.js");
  const { stdout, status } = spawnSync(process.execPath, [cli], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "ENABLED");
});

test("check-consent CLI prints ENABLED when file has enabled=true", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  consentLib.write({ configDir: tmp, enabled: true });
  const cli = path.resolve(__dirname, "../lib/check-consent.js");
  const { stdout, status } = spawnSync(process.execPath, [cli], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "ENABLED");
});

test("check-consent CLI prints DISABLED when file has enabled=false", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  consentLib.write({ configDir: tmp, enabled: false });
  const cli = path.resolve(__dirname, "../lib/check-consent.js");
  const { stdout, status } = spawnSync(process.execPath, [cli], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "DISABLED");
});

test("record-consent CLI --answer yes writes enabled=true", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  const cli = path.resolve(__dirname, "../lib/record-consent.js");
  const { status } = spawnSync(process.execPath, [cli, "--answer", "yes"], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.equal(status, 0);
  assert.equal(consentLib.read({ configDir: tmp }).state, "enabled");
});

test("record-consent CLI --answer no writes enabled=false", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  const cli = path.resolve(__dirname, "../lib/record-consent.js");
  const { status } = spawnSync(process.execPath, [cli, "--answer", "no"], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.equal(status, 0);
  assert.equal(consentLib.read({ configDir: tmp }).state, "disabled");
});

test("record-consent CLI exits non-zero on invalid --answer", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
  const cli = path.resolve(__dirname, "../lib/record-consent.js");
  const { status } = spawnSync(process.execPath, [cli, "--answer", "maybe"], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp },
    encoding: "utf8",
  });
  assert.notEqual(status, 0);
});
