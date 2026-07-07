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
      // Clear the workflow-wide opt-out backstop (set in power-pages-script-tests.yml)
      // so the provisioned test still exercises the real emit path to its probe.
      POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
      // Routes emission to a local probe instead of the real OneCollector.
      // Without it, the provisioned path (checked-in ikey.json ships enabled +
      // a real key) would POST a fake event to prod telemetry on every CI run.
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

function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    sleep(25);
  }
  return fs.existsSync(filePath);
}

// Writes an isolated, provisioned telemetry config into configDir (temp
// ikey.json + a resolver.js sibling — the dispatcher discovers region routing
// by that convention) so emission runs against an example.invalid key instead
// of the checked-in prod config. Returns the ikey path.
function writeProvisionedConfig(configDir) {
  const ikeyPath = path.join(configDir, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      // Mirror the shipped ikey.json stream name so the asserted envelope name
      // matches real production behavior (the checked-in config uses this).
      event_stream_name: "PagesAIPluginEvent",
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
  // Regression guard: previously ran the real hook with no ikey override and no
  // probe, so once the checked-in config went live it POSTed a fake create-site
  // event to prod on every CI run. Override seam + probe keep it isolated.
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
  assert.equal(body.name, "PagesAIPluginEvent");
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
      event_stream_name: "PagesAIPluginEvent",
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
