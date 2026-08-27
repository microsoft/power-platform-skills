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
  assert.match(stdout, /Dataverse organization and Entra tenant IDs/);
  assert.match(stdout, /eventInfo\.aadObjectId/);
  assert.match(stdout, /when PAC exposes it/);
  assert.match(stdout, /eventInfo\.framework/);
  assert.match(stdout, /react, vue, angular, or astro/);
  assert.match(stdout, /never a site name or path/);
  assert.match(stdout, /When plugin telemetry is enabled/);
  assert.match(stdout, /committed telemetry\s+config has disabled: true/);
  assert.match(stdout, /hard-disabled and writes no log/);
  assert.doesNotMatch(stdout, /anonymous/i);
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

test("on reports the env opt-out override instead of falsely claiming ON", () => {
  // The highest-precedence env opt-out forces transmission off; `on` saves the
  // preference but must NOT report plain "ON" while the env var suppresses it.
  const dir = mkTmp();
  const { status, stdout } = run(["--action", "on", "--plugin", "power-pages"], dir, {
    POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "1",
  });
  assert.equal(status, 0);
  assert.match(stdout, /preference saved as ON/i);
  assert.match(stdout, /environment opt-out is currently in effect/i);
  assert.doesNotMatch(stdout, /^Telemetry \(power-pages\): ON$/m);
  // The preference is still persisted (so it takes effect once the env var clears).
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
  assert.equal(cfg.telemetry["power-pages"], "on");
});

test("status reports ON by default and never reads ikey.json", () => {
  const dir = mkTmp();
  const { status, stdout } = run(["--action", "status", "--plugin", "power-pages"], dir);
  assert.equal(status, 0);
  assert.match(stdout, /Telemetry \(power-pages\): ON/);
  assert.match(stdout, /Dataverse organization and Entra tenant IDs/);
  assert.match(stdout, /eventInfo\.aadObjectId/);
  assert.match(stdout, /when PAC exposes it/);
  assert.match(stdout, /eventInfo\.framework/);
  assert.match(stdout, /react, vue, angular, or astro/);
  assert.match(stdout, /never a site name or path/);
  assert.match(stdout, /When plugin telemetry is enabled/);
  assert.match(stdout, /committed telemetry\s+config has disabled: true/);
  assert.match(stdout, /hard-disabled and writes no log/);
  assert.doesNotMatch(stdout, /anonymous/i);
});

test("status discloses Model Apps identifiers without claiming an Entra user object ID", () => {
  const dir = mkTmp();
  const { status, stdout } = run(["--action", "status", "--plugin", "model-apps"], dir);
  assert.equal(status, 0);
  assert.match(stdout, /Dataverse organization and Entra tenant IDs/);
  assert.match(stdout, /Model Apps excludes the signed-in user's Entra object ID/);
  assert.doesNotMatch(stdout, /anonymous/i);
});

test("status discloses Mobile Apps fields without PAC or Dataverse identifiers", () => {
  const dir = mkTmp();
  const { status, stdout } = run(
    ["--action", "status", "--plugin", "mobile-app"],
    dir,
    { POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT: "" }
  );
  assert.equal(status, 0);
  assert.match(stdout, /invocation source/);
  assert.match(stdout, /random per-project app\s+instance ID/);
  assert.doesNotMatch(stdout, /Usage telemetry records[^\n]*PAC/);
  assert.doesNotMatch(stdout, /Dataverse organization and Entra tenant IDs/);
});

test("status reports OFF after opt-out", () => {
  const dir = mkTmp();
  run(["--action", "off", "--plugin", "power-pages"], dir);
  const { stdout } = run(["--action", "status", "--plugin", "power-pages"], dir);
  assert.match(stdout, /Telemetry \(power-pages\): OFF/);
  assert.match(stdout, /local diagnostic log is kept whenever telemetry is enabled/i);
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
  assert.match(stdout, /local diagnostic log is kept whenever telemetry is enabled/i);
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
  assert.match(stdout, /local diagnostic log is kept whenever telemetry is enabled/i);
  assert.match(stdout, /Logs directory:/);
});
