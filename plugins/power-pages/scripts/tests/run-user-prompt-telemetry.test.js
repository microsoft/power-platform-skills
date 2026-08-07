"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "run-user-prompt-telemetry.js");

function mkConfigDir() {
  // An isolated config dir. Emission is NOT gated by any telemetry.json here —
  // the per-plugin opt-out is a config.json with telemetry[plugin] = "off"
  // (see user-config.js); tests that need opt-out write that file explicitly.
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-upt-"));
}

function runHook({ prompt, configDir, fakeProbe, ikeyPath, cwd }) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(cwd ? { prompt, cwd } : { prompt }),
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe || "",
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath || "",
      // Clear the workflow-wide opt-out backstop (set in power-pages-script-tests.yml)
      // so the emit-detection test still exercises the real path to its probe.
      POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
    },
    // The enabled path shells out to `pac auth who` + `pac --version`, each
    // capped at 8s (see lib/pac-auth.js). The hook's documented budget is ~30s;
    // a 10s spawn timeout sits right on the cold-start cost and flakes when pac
    // is installed. Match the hook budget so the integration path is reliable.
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

// Writes an isolated, provisioned telemetry config into configDir (temp
// ikey.json + a resolver.js sibling — the dispatcher discovers region routing by
// that convention) so emission runs against an example.invalid key instead of
// the checked-in prod config. Returns the ikey path.
function writeProvisionedConfig(configDir) {
  const ikeyPath = path.join(configDir, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
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
  // The dispatcher discovers region routing via a resolver.js next to ikey.json.
  // Mirror the shipped plugin layout by dropping one beside the temp config that
  // re-exports the real region resolver from scripts/lib/telemetry/resolver.js.
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

// Materializes a Power Pages code site (config marker + package.json) so the
// framework detector has something to find from the hook's reported cwd.
function mkSite(deps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-site-"));
  fs.writeFileSync(
    path.join(root, "powerpages.config.json"),
    JSON.stringify({ siteName: "Test Site", compiledPath: "dist" })
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "test-site", dependencies: deps })
  );
  return root;
}

test("hook emits PagesAIPluginEvent with top-level fields for tracked slash command", () => {
  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  // Point the hook at a temp ikey.json via the override seam instead of
  // mutating the checked-in scripts/lib/telemetry/ikey.json (which would race
  // with other test files running in parallel).
  const ikeyPath = writeProvisionedConfig(configDir);

  const { status } = runHook({
    prompt: "/power-pages:add-seo",
    configDir,
    fakeProbe: probePath,
    ikeyPath,
  });
  assert.equal(status, 0);
  assert.ok(waitForFile(probePath, 5_000), "dispatcher should have written probe");
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  assert.ok(probe.body.endsWith("\n"), "body must be newline-terminated");
  const body = JSON.parse(probe.body);
  assert.deepEqual(Object.keys(body).sort(), ["data", "iKey", "name", "time", "ver"]);
  assert.equal(body.name, "PagesAIPluginEvent");
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
});

test("hook reports the site framework in eventInfo from the payload cwd", () => {
  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);

  const { status } = runHook({
    prompt: "/power-pages:add-seo",
    configDir,
    fakeProbe: probePath,
    ikeyPath,
    cwd: mkSite({ vue: "^3.5.0", "vue-router": "^4.5.0" }),
  });
  assert.equal(status, 0);
  assert.ok(waitForFile(probePath, 5_000), "dispatcher should have written probe");
  const body = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  // eventInfo is JSON-stringified for the wire (the tenant-side field mapping
  // flattens data.<key> and doesn't recurse) — see emit-dispatcher buildEnvelope.
  assert.equal(typeof body.data.eventInfo, "string");
  const eventInfo = JSON.parse(body.data.eventInfo);
  // Asserted WITHOUT requiring aadObjectId: `framework` must survive whether or
  // not `pac auth who` surfaces an object id (it won't on a CI runner with no
  // pac / no signed-in user). Regression guard against rebuilding eventInfo
  // inside the objectId guard, which would drop the framework on every
  // unauthenticated run.
  assert.equal(eventInfo.framework, "vue");
});

test("hook omits framework when cwd is not a Power Pages code site", () => {
  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);

  const { status } = runHook({
    prompt: "/power-pages:add-seo",
    configDir,
    fakeProbe: probePath,
    ikeyPath,
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-nosite-")),
  });
  assert.equal(status, 0);
  assert.ok(waitForFile(probePath, 5_000), "dispatcher should have written probe");
  const body = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  const eventInfo =
    typeof body.data.eventInfo === "string" ? JSON.parse(body.data.eventInfo) : {};
  assert.ok(
    !("framework" in eventInfo),
    "no framework key should be emitted outside a Power Pages code site"
  );
});

test("hook exits 0 and emits nothing for an unrelated prompt", () => {  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  const { status } = runHook({
    prompt: "just some user text",
    configDir,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  // Give any (wrongly) spawned dispatcher a chance to write before asserting
  // that nothing was emitted.
  sleep(500);
  assert.ok(!fs.existsSync(probePath), "unrelated prompt must not emit");
});

test("hook exits 0 on malformed stdin", () => {
  const configDir = mkConfigDir();
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
  const configDir = mkConfigDir();
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
