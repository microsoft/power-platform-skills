"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "run-user-prompt-telemetry.js");

function mkTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "modelapps-uptel-"));
}

function runHook({ input, configDir, ikeyPath, fakeProbe }) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath || "",
      POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: "",
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe || "",
    },
    timeout: 30_000,
  });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) sleep(25);
  return fs.existsSync(filePath);
}

function writeProvisionedConfig(configDir) {
  const ikeyPath = path.join(configDir, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      instrumentationKey: "test-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collector_url: "https://example.invalid/OneCollector/1.0/",
      event_stream_name: "ModelAppsTestStream",
      disabled: false,
    })
  );
  return ikeyPath;
}

test("exits 0 and emits nothing for a non-slash prompt", () => {
  const { status } = runHook({
    input: JSON.stringify({ prompt: "just a normal question" }),
    configDir: mkTemp(),
  });
  assert.equal(status, 0);
});

test("exits 0 and emits nothing for another plugin's slash command", () => {
  const configDir = mkTemp();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);
  const { status } = runHook({
    input: JSON.stringify({ prompt: "/power-pages:create-site" }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  assert.equal(waitForFile(probePath, 1500), false, "unrelated command must not emit");
});

test("provisioned config → /model-apps:genpage prompt emits skill_started, WITHOUT aadObjectId", () => {
  const configDir = mkTemp();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);

  const { status } = runHook({
    input: JSON.stringify({ prompt: "/model-apps:genpage build a dashboard", session_id: "s1" }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  assert.ok(waitForFile(probePath, 5000), "dispatcher should have written the probe");
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  const body = JSON.parse(probe.body);
  assert.equal(body.name, "ModelAppsTestStream");
  assert.equal(body.data.eventName, "skill_started");
  assert.equal(body.data.pluginName, "model-apps");
  assert.equal(body.data.skillName, "genpage");
  // The _readPacAuth wrapper strips objectId, so no user-level identifier is sent.
  assert.equal(body.data.eventInfo, undefined, "prompt path must not send eventInfo/aadObjectId");
});

test("bare /genpage prompt is also recognized (host may drop the plugin prefix)", () => {
  const configDir = mkTemp();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);
  const { status } = runHook({
    input: JSON.stringify({ prompt: "/genpage make a page" }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  assert.ok(waitForFile(probePath, 5000), "bare /genpage should emit");
  const body = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  assert.equal(body.data.skillName, "genpage");
});

test("exits 0 on malformed stdin", () => {
  const { status } = runHook({ input: "{not json", configDir: mkTemp() });
  assert.equal(status, 0);
});
