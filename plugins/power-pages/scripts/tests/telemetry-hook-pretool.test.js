"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.resolve(
  __dirname,
  "../../hooks/run-skill-pretool-telemetry.js"
);

function mkConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-ph-"));
}

function runHook({ input, configDir, off, fakeProbe, ikeyPath }) {
  // Opt-out is a per-plugin config.json in the config dir (env var removed).
  if (off) {
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ telemetry: { "power-pages": "off" } })
    );
  }
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe || "",
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath || "",
    },
    timeout: 30_000,
  });
}

// Synchronous sleep that parks the thread instead of busy-spinning the CPU.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    sleep(25);
  }
  return fs.existsSync(filePath);
}

test("exits 0 and emits nothing when tool_input has no tracked skill", () => {
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "other-plugin:foo" } }),
    configDir: mkConfigDir(),
  });
  assert.equal(status, 0);
});

test("config opt-out still writes the local mirror but does NOT POST", () => {
  // A per-plugin config opt-out suppresses transmission only. With an enabled
  // ikey.json (via the override seam) + a fake-https probe + the opt-out set, the
  // hook builds and dispatches the event; the dispatcher writes events.jsonl and
  // skips the POST.
  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = path.join(configDir, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      instrumentationKey: "test-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collector_url: "https://example.invalid/OneCollector/1.0/",
      event_stream_name: "PagesPluginEvent",
      disabled: false,
    })
  );
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir,
    fakeProbe: probePath,
    ikeyPath,
    off: true,
  });
  assert.equal(status, 0);
  assert.ok(
    waitForFile(path.join(configDir, "events.jsonl"), 5_000),
    "opt-out must still write the local mirror"
  );
  assert.ok(!fs.existsSync(probePath), "opt-out must skip the POST");
});

test("exits 0 when malformed stdin", () => {
  const { status } = runHook({ input: "{not json", configDir: mkConfigDir() });
  assert.equal(status, 0);
});

test("exits 0 when skill is tracked (placeholder iKey → no-op emit)", () => {
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir: mkConfigDir(),
  });
  assert.equal(status, 0);
});

test("emits skill_started for a tracked skill when pointed at an enabled ikey.json via the override seam", () => {
  // Exercises the enabled emit path without mutating the checked-in ikey.json:
  // the hook's readIkey() honors POWER_PLATFORM_SKILLS_IKEY_JSON.
  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = path.join(configDir, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      instrumentationKey: "test-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collector_url: "https://example.invalid/OneCollector/1.0/",
      event_stream_name: "PagesPluginEvent",
      disabled: false,
    })
  );

  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir,
    fakeProbe: probePath,
    ikeyPath,
  });
  assert.equal(status, 0);
  assert.ok(waitForFile(probePath, 5_000), "dispatcher should have written probe");
  const body = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  assert.equal(body.name, "PagesPluginEvent");
  assert.equal(body.data.eventName, "skill_started");
  assert.equal(body.data.skillName, "create-site");
});

test("fails closed (no emit) when override ikey.json path does not exist", () => {
  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir,
    fakeProbe: probePath,
    ikeyPath: path.join(configDir, "does-not-exist.json"),
  });
  assert.equal(status, 0);
  sleep(500);
  assert.ok(!fs.existsSync(probePath), "missing config must fail closed (no emit)");
});
