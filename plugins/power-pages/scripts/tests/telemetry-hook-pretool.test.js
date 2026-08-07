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

function runHook({ input, configDir, ikeyPath, fakeProbe }) {  return spawnSync(process.execPath, [HOOK], {
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

test("pretool hook reports the site framework in eventInfo from the payload cwd", () => {
  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);

  const { status } = runHook({
    input: JSON.stringify({
      tool_input: { skill: "add-seo" },
      // Claude Code puts the host session's working directory on the hook
      // payload (same field run-skill-posttool-validation.js reads).
      cwd: mkSite({ "@angular/core": "^19.1.0", rxjs: "~7.8.0" }),
    }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
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
  assert.equal(eventInfo.framework, "angular");
});

test("pretool hook finds a site in a CHILD of cwd (recommended create-site layout)", () => {
  // create-site's recommended target is "New folder in current directory", which
  // leaves powerpages.config.json one level BELOW the host cwd that later hooks
  // report. Guards the root-discovery path that makes the metric representative.
  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-parent-"));
  const site = path.join(parent, "contoso-portal");
  fs.mkdirSync(site);
  fs.writeFileSync(path.join(site, "powerpages.config.json"), "{}");
  fs.writeFileSync(
    path.join(site, "package.json"),
    JSON.stringify({ dependencies: { react: "^19.0.0" } })
  );

  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "add-seo" }, cwd: parent }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  assert.ok(waitForFile(probePath, 5_000), "dispatcher should have written probe");
  const body = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  assert.equal(JSON.parse(body.data.eventInfo).framework, "react");
});

test("pretool hook omits framework when cwd is not a Power Pages code site", () => {
  const configDir = mkConfigDir();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);

  const { status } = runHook({
    input: JSON.stringify({
      tool_input: { skill: "add-seo" },
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-nosite-")),
    }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
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
