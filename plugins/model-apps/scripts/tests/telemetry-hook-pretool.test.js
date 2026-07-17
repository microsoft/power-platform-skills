"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "run-skill-pretool-telemetry.js");
const SHIPPED_IKEY = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry", "ikey.json");

function mkTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "modelapps-tel-"));
}

function runHook({ input, configDir, ikeyPath, fakeProbe }) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath || "",
      // Clear the CI/automation opt-out so the provisioned path still reaches its probe.
      POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: "",
      // Route emission to a local probe instead of a real OneCollector.
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe || "",
    },
    // The provisioned path shells out to `pac auth who` + `pac --version`; give it
    // room so pac cold-start doesn't flake when pac is installed.
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

// Tier-1 (flat static key, no resolver) provisioned config, isolated to a temp dir
// so emission runs against example.invalid instead of any real collector.
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

test("shipped ikey.json is disabled with a placeholder key (never ship enabled unprovisioned)", () => {
  const cfg = JSON.parse(fs.readFileSync(SHIPPED_IKEY, "utf8"));
  assert.equal(cfg.disabled, true, "ikey.json must ship disabled:true until provisioned");
  assert.equal(cfg.instrumentationKey, "PLACEHOLDER_REPLACE_BEFORE_SHIPPING");
});

test("exits 0 and emits nothing when tool_input has no tracked skill", () => {
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "other-plugin:foo" } }),
    configDir: mkTemp(),
  });
  assert.equal(status, 0);
});

test("exits 0 on malformed stdin", () => {
  const { status } = runHook({ input: "{not json", configDir: mkTemp() });
  assert.equal(status, 0);
});

test("shipped disabled config → tracked skill emits nothing (no probe, hard-off)", () => {
  const configDir = mkTemp();
  const probePath = path.join(configDir, "probe.json");
  // No ikey override → the hook reads the shipped ikey.json (disabled:true) and
  // short-circuits before spawning the dispatcher.
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "genpage" } }),
    configDir,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  assert.equal(waitForFile(probePath, 1500), false, "disabled config must not write a probe");
});

test("provisioned Tier-1 config → tracked skill emits skill_started to the probe", () => {
  const configDir = mkTemp();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);

  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "genpage" } }),
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
  assert.equal(body.data.eventInfo, undefined, "model-apps must not send eventInfo/aadObjectId");
});

test("enabled config but placeholder key → treated as unprovisioned (no probe)", () => {
  // Flipping disabled:false before replacing the placeholder must NOT emit: the
  // hook's Tier-1 provisioned check rejects the sentinel, so no dispatch happens.
  const configDir = mkTemp();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = path.join(configDir, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      instrumentationKey: "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      collector_url: "https://example.invalid/OneCollector/1.0/",
      event_stream_name: "ModelAppsTestStream",
      disabled: false,
    })
  );
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "genpage" } }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  assert.equal(waitForFile(probePath, 1500), false, "placeholder key must not emit a probe");
});
