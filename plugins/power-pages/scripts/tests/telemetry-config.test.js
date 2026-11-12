"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const CLI = path.join(PLUGIN_ROOT, "scripts", "telemetry-config.js");

function run(t, args, env = {}) {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-pages-config-"));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  return {
    configDir,
    ...spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
        ...env,
      },
    }),
  };
}

for (const action of ["on", "off", "status"]) {
  test(`${action} includes shared and non-SPA disclosures`, (t) => {
    const result = run(t, ["--action", action]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /eventInfo\.framework/);
    assert.match(result.stdout, /template_used and non_spa_creation_success/);
    assert.match(result.stdout, /non_spa_creation_failure with a shared correlationId/);
    assert.match(result.stdout, /eventInfo\.templateId, eventInfo\.templateKind \(non-spa\)/);
    assert.match(result.stdout, /eventInfo\.audience \(internal\/external\)/);
    assert.match(result.stdout, /non-spa-creations/);
    assert.match(result.stdout, /even when transmission is off/);
    assert.match(result.stdout, /older than 14 days/);
    assert.match(result.stdout, /Hard-off writes none/);
    if (action !== "status") {
      const config = JSON.parse(fs.readFileSync(path.join(result.configDir, "config.json"), "utf8"));
      assert.deepEqual(config.telemetry, { "power-pages": action });
    } else {
      assert.equal(fs.existsSync(path.join(result.configDir, "config.json")), false);
    }
  });
}

test("on preserves the environment opt-out", (t) => {
  const result = run(t, ["--action", "on"], {
    POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preference saved as ON, but an environment opt-out/);
  assert.doesNotMatch(result.stdout, /^Telemetry \(power-pages\): ON$/m);
});

test("invalid arguments fail without changing preferences or printing the disclosure", (t) => {
  for (const args of [[], ["--action", "invalid"], ["--action", "on", "--plugin", "model-apps"]]) {
    const result = run(t, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stdout, /non_spa_creation_success/);
    assert.equal(fs.existsSync(path.join(result.configDir, "config.json")), false);
  }
});

test("shared CLI failures propagate without a success disclosure", (t) => {
  const configFile = path.join(os.tmpdir(), `ppskills-config-file-${process.pid}`);
  fs.writeFileSync(configFile, "not a directory");
  t.after(() => fs.rmSync(configFile, { force: true }));
  const result = run(t, ["--action", "on"], {
    POWER_PLATFORM_SKILLS_CONFIG_DIR: configFile,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Could not update the telemetry setting/);
  assert.doesNotMatch(result.stdout, /non_spa_creation_success/);
});

test("telemetry workflow routes Power Pages through its plugin-specific CLI", () => {
  const workflow = fs.readFileSync(path.join(PLUGIN_ROOT, "skills", "telemetry", "telemetry-workflow.md"), "utf8");
  assert.match(workflow, /For Power Pages, run its plugin-specific CLI/);
  assert.match(workflow, /node "\$\{PLUGIN_ROOT\}\/scripts\/telemetry-config\.js" --action <action>/);
});
