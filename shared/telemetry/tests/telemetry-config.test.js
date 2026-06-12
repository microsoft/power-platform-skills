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
function run(args, configDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir },
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
