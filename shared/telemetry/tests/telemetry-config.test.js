"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI = path.resolve(__dirname, "../lib/telemetry-config.js");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-cli-"));
}
function run(args, configDir, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "", // cleared by default; tests opt in via extraEnv
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      ...extraEnv,
    },
  });
}

test("off writes the per-plugin opt-out and confirms", () => {
  const dir = mkTmp();
  const { status, stdout } = run(["--action", "off", "--plugin", "power-pages"], dir);
  assert.equal(status, 0);
  assert.match(stdout, /OFF/);
  assert.match(stdout, /No personal data is collected/);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(cfg.telemetry["power-pages"], "off");
});

test("on writes the per-plugin opt-in and confirms", () => {
  const dir = mkTmp();
  run(["--action", "off", "--plugin", "power-pages"], dir);
  const { status, stdout } = run(["--action", "on", "--plugin", "power-pages"], dir);
  assert.equal(status, 0);
  assert.match(stdout, /ON/);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(cfg.telemetry["power-pages"], "on");
});

test("status reports ON by default and never reads ikey.json", () => {
  const dir = mkTmp();
  const { status, stdout } = run(["--action", "status", "--plugin", "power-pages"], dir);
  assert.equal(status, 0);
  assert.match(stdout, /Telemetry \(power-pages\): ON/);
  assert.match(stdout, /No personal data is collected/);
});

test("status reports OFF after opt-out", () => {
  const dir = mkTmp();
  run(["--action", "off", "--plugin", "power-pages"], dir);
  const { stdout } = run(["--action", "status", "--plugin", "power-pages"], dir);
  assert.match(stdout, /Telemetry \(power-pages\): OFF/);
  assert.match(stdout, /local diagnostic log is still kept/i);
});

test("usage error on bad action", () => {
  const dir = mkTmp();
  const { status, stdout } = run(["--action", "bogus", "--plugin", "power-pages"], dir);
  assert.equal(status, 2);
  assert.match(stdout, /Usage:/);
});

const ENV_NAME = "POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT";

test("status reflects the env opt-out when config is unset, with no env-var wording", () => {
  const dir = mkTmp(); // no slash choice stored
  const { status, stdout } = run(
    ["--action", "status", "--plugin", "power-pages"],
    dir,
    { [ENV_NAME]: "1" }
  );
  assert.equal(status, 0);
  assert.match(stdout, /Telemetry \(power-pages\): OFF/);
  assert.match(stdout, /local diagnostic log is still kept/i);
  // truthful-but-quiet: status must NOT name or explain the env var
  assert.ok(
    !/POWER_PLATFORM_SKILLS_TELEMETRY/.test(stdout),
    "status message must not mention the env var"
  );
});

test("status: env opt-out overrides a persisted 'on' choice → OFF", () => {
  const dir = mkTmp();
  run(["--action", "on", "--plugin", "power-pages"], dir); // store ON via slash skill
  const { stdout } = run(
    ["--action", "status", "--plugin", "power-pages"],
    dir,
    { [ENV_NAME]: "1" }
  );
  assert.match(stdout, /Telemetry \(power-pages\): OFF/);
});

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
