"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "run-user-prompt-telemetry.js");

function mkConfigDir(enabled = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-upt-"));
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({
      version: 1,
      enabled,
      recorded_at: new Date().toISOString(),
    })
  );
  return tmp;
}

function runHook({ prompt, configDir, fakeProbe }) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt }),
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe || "",
    },
    timeout: 10_000,
  });
}

test("hook emits PowerPagesPluginEvent with top-level fields for tracked slash command", () => {
  const configDir = mkConfigDir(true);
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = path.join(
    PLUGIN_ROOT,
    "scripts",
    "lib",
    "telemetry",
    "ikey.json"
  );
  const original = fs.readFileSync(ikeyPath, "utf8");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      ikey: "test-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collector_url: "https://example.invalid/OneCollector/1.0/",
      event_stream_name: "PowerPagesPluginEvent",
    })
  );

  try {
    const { status } = runHook({
      prompt: "/power-pages:add-seo",
      configDir,
      fakeProbe: probePath,
    });
    assert.equal(status, 0);
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(probePath) && Date.now() < deadline) {
      // busy-wait
    }
    assert.ok(fs.existsSync(probePath), "dispatcher should have written probe");
    const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
    assert.ok(probe.body.endsWith("\n"), "body must be newline-terminated");
    const body = JSON.parse(probe.body);
    assert.deepEqual(Object.keys(body).sort(), ["data", "iKey", "name", "time", "ver"]);
    assert.equal(body.name, "PowerPagesPluginEvent");
    assert.equal(body.ver, "4.0");
    assert.match(body.iKey, /^o:/);
    assert.equal(body.data.eventName, "skill_started");
    assert.equal(body.data.eventType, "Trace");
    assert.equal(body.data.severity, "Info");
    assert.equal(body.data.pluginName, "power-pages");
    assert.equal(body.data.skillName, "add-seo");
    assert.equal(typeof body.data.sessionId, "string");
    assert.equal(typeof body.data.correlationId, "string");
    assert.equal(typeof body.data.osName, "string");
    assert.equal(typeof body.data.osVersion, "string");
    assert.match(body.data.nodeVersion, /^v\d+$/);
  } finally {
    fs.writeFileSync(ikeyPath, original);
  }
});

test("hook exits 0 and emits nothing for an unrelated prompt", () => {
  const configDir = mkConfigDir(true);
  const probePath = path.join(configDir, "probe.json");
  const { status } = runHook({
    prompt: "just some user text",
    configDir,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  const deadline = Date.now() + 500;
  while (!fs.existsSync(probePath) && Date.now() < deadline) {
    // spin
  }
  assert.ok(!fs.existsSync(probePath), "unrelated prompt must not emit");
});

test("hook exits 0 on malformed stdin", () => {
  const configDir = mkConfigDir(true);
  const { status } = spawnSync(process.execPath, [HOOK], {
    input: "not json",
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    },
    timeout: 10_000,
  });
  assert.equal(status, 0);
});

test("hook exits 0 on empty stdin", () => {
  const configDir = mkConfigDir(true);
  const { status } = spawnSync(process.execPath, [HOOK], {
    input: "",
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    },
    timeout: 10_000,
  });
  assert.equal(status, 0);
});
