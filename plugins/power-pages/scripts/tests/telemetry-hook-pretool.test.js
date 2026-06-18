"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "../..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "run-skill-pretool-telemetry.js");

function mkConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-ph-"));
}

function runHook({ input, configDir, ikeyPath, fakeProbe }) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath || "",
      // Route any actual emission to a local probe file instead of POSTing to
      // the production OneCollector. CRITICAL for the provisioned/enabled path:
      // the checked-in ikey.json now ships disabled:false + a real instrumentation
      // key, so a hook test that reaches fireAndForget without a probe would emit
      // a fake create-site event to prod telemetry on every CI run.
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe || "",
    },
    // The provisioned path shells out to `pac auth who` + `pac --version`, each
    // capped at 8s (see lib/pac-auth.js). Match the hook's ~30s budget so the
    // integration path doesn't flake on pac cold-start when pac is installed.
    timeout: 30_000,
  });
}

// Synchronous sleep that parks the thread instead of busy-spinning the CPU.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Poll for a file up to timeoutMs, sleeping between checks so the test runner
// stays responsive. Returns whether the file exists at the end.
function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    sleep(25);
  }
  return fs.existsSync(filePath);
}

// Writes an isolated, fully-provisioned telemetry config (temp ikey.json +
// resolver.js) into configDir and returns the ikey path. Mirrors the shipped
// plugin layout: the dispatcher discovers region routing via a resolver.js
// sibling of ikey.json, so the region isProvisioned() gate runs against a
// real-shaped (but example.invalid) key rather than the checked-in prod config.
function writeProvisionedConfig(configDir) {
  const ikeyPath = path.join(configDir, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      event_stream_name: "PagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: {
        us: {
          instrumentation_key: "test-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
          collector_url: "https://example.invalid/OneCollector/1.0/",
        },
      },
    })
  );
  const shippedResolver = path.join(
    PLUGIN_ROOT,
    "scripts",
    "lib",
    "telemetry",
    "resolver.js"
  );
  fs.writeFileSync(
    path.join(configDir, "resolver.js"),
    `module.exports = require(${JSON.stringify(shippedResolver)});\n`
  );
  return ikeyPath;
}

test("exits 0 and emits nothing when tool_input has no tracked skill", () => {
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "other-plugin:foo" } }),
    configDir: mkConfigDir(),
  });
  assert.equal(status, 0);
});

test("exits 0 when malformed stdin", () => {
  const { status } = runHook({ input: "{not json", configDir: mkConfigDir() });
  assert.equal(status, 0);
});

test("exits 0 and emits skill_started to probe when skill is tracked (provisioned)", () => {
  // Regression guard: this test previously ran the real hook with no ikey
  // override and no FAKE_HTTPS probe. Once the checked-in ikey.json flipped to
  // disabled:false with a real US instrumentation key, that produced a real
  // HTTPS POST of a fake `create-site` skill_started event to the production
  // OneCollector on every CI run (3 OS × every PR). Isolate via the override
  // seam + a fake probe so the tracked-skill emit path is exercised WITHOUT
  // touching prod telemetry.
  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);

  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  assert.ok(waitForFile(probePath, 5_000), "dispatcher should have written probe");
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  const body = JSON.parse(probe.body);
  assert.equal(body.name, "PagesPluginEvent");
  assert.equal(body.data.eventName, "skill_started");
  assert.equal(body.data.pluginName, "power-pages");
  assert.equal(body.data.skillName, "create-site");
});

test("pretool hook exits 0 when ikey.json has regions but default_region entry has no key", () => {
  // Point the hook at a temp ikey.json via the override seam instead of
  // mutating the checked-in scripts/lib/telemetry/ikey.json (which would race
  // with other test files running in parallel and leave the repo dirty on
  // interrupt).
  const configDir = mkConfigDir();
  const ikeyPath = path.join(configDir, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      event_stream_name: "PagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: { us: { collector_url: "https://x" } },
    })
  );
  // Mirror the shipped layout: a resolver.js beside ikey.json so the region
  // isProvisioned() gate actually runs (default_region 'us' has a collector but
  // no instrumentation_key → not provisioned → exit 0).
  const shippedResolver = path.join(
    PLUGIN_ROOT,
    "scripts",
    "lib",
    "telemetry",
    "resolver.js"
  );
  fs.writeFileSync(
    path.join(configDir, "resolver.js"),
    `module.exports = require(${JSON.stringify(shippedResolver)});\n`
  );

  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "add-seo" } }),
    configDir,
    ikeyPath,
  });
  assert.equal(status, 0);
});
