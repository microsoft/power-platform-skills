"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  STUB_BANNER,
  TRAP_BANNER,
  startedMarker,
  writePacExecutable,
  isolatePath,
} = require("./fixtures/stub-pac/install.js");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const HOOK = path.join(PLUGIN_ROOT, "hooks", "run-skill-pretool-telemetry.js");
const SHIPPED_IKEY = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry", "ikey.json");

// A forbidden native `pac` is prepended to the parent PATH. Every hook spawn replaces
// PATH with only the stub directory, so this binary must never start — if a test
// starts inheriting PATH again, the trap runs and the suite fails.
let stubDir;
let trapDir;
let stubBuilt = false;
test.before(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modelapps-tel-pac-"));
  stubDir = path.join(root, "stub");
  trapDir = path.join(root, "trap");
  stubBuilt = writePacExecutable(stubDir, STUB_BANNER);
  writePacExecutable(trapDir, TRAP_BANNER);
  const delim = path.delimiter;
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === "PATH") process.env[key] = trapDir + delim + process.env[key];
  }
});

function mkTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "modelapps-tel-"));
}

function runHook({ input, configDir, ikeyPath, fakeProbe }) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: isolatePath(
      {
        ...process.env,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath || "",
        // Clear the CI/automation opt-out so the provisioned path still reaches its probe.
        POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: "",
        // Route emission to a local probe instead of a real OneCollector.
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe || "",
        // A developer machine may have the kill-switch set; the hook must still be exercised.
        MODEL_APPS_DISABLE_HOOKS: "",
      },
      stubDir
    ),
    // PATH holds only the stub pac, so this is not waiting on a real PAC cold start.
    timeout: 15_000,
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

test("ikey.json is never shipped enabled with the placeholder key", () => {
  const cfg = JSON.parse(fs.readFileSync(SHIPPED_IKEY, "utf8"));
  const keys = [cfg.instrumentationKey, ...Object.values(cfg.regions || {}).map((r) => r && r.instrumentation_key)];
  if (keys.includes("PLACEHOLDER_REPLACE_BEFORE_SHIPPING")) {
    // Unprovisioned placeholder must stay hard-off.
    assert.equal(cfg.disabled, true, "a placeholder key must ship disabled:true");
  }
  // A real (provisioned) key may ship staged (disabled:true) or live (disabled:false) —
  // both valid. The guard only forbids enabling a placeholder key.
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

test("shipped config + resolver → tracked skill is region-routed to this plugin's key (no network)", () => {
  const configDir = mkTemp();
  const probePath = path.join(configDir, "probe.json");
  const shipped = JSON.parse(fs.readFileSync(SHIPPED_IKEY, "utf8"));
  // The stub pac reports a Public-cloud org. Seed the shared org→region cache with "eu" so the
  // resolver routes from the cache instead of calling the Artemis gateway — the test stays offline,
  // and an EU key (not the US default) in the probe proves the shipped resolver.js did the routing.
  const cacheDir = path.join(configDir, "region-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, `${STUB_BANNER.orgId}.json`),
    JSON.stringify({ region: "eu", expiresAt: Date.now() + 60 * 60 * 1000 })
  );

  // No ikey override → the hook and dispatcher read the shipped ikey.json and load the resolver.js
  // beside it. FAKE_HTTPS swaps the POST for the probe file, so nothing reaches a real collector.
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "genpage" } }),
    configDir,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  assert.ok(waitForFile(probePath, 5000), "dispatcher should have written the probe");
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  const body = JSON.parse(probe.body);
  assert.equal(body.name, shipped.event_stream_name);
  // The shipped resolver's formatEnvelope reshapes the event into the Power Apps client `event` schema.
  assert.equal(body.data.clientType, "ModelAppsAIPlugin");
  assert.equal(body.data.event_Name, "skill_started");
  const dims = JSON.parse(body.data.customDimensions);
  assert.equal(dims.pluginName, "model-apps");
  assert.equal(dims.skillName, "genpage");
  assert.equal(dims.eventInfo, undefined, "model-apps must not send eventInfo/aadObjectId");
  // Without the native stub (no csc.exe on this Windows box) PAC is absent: no org, so the event
  // takes the US default instead of the cached EU route.
  const region = stubBuilt ? "eu" : "us";
  assert.equal(probe.headers["x-apikey"], shipped.regions[region].instrumentation_key);
  assert.equal(body.iKey, "o:" + shipped.regions[region].instrumentation_key.split("-")[0]);
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

test("provisioned hooks never use ambient PAC or credentials", (t) => {
  if (!stubBuilt) {
    t.skip("no C# compiler (csc.exe) on this Windows machine to build the native pac stub");
    return;
  }
  const configDir = mkTemp();
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);
  fs.rmSync(startedMarker(stubDir), { force: true });
  fs.rmSync(startedMarker(trapDir), { force: true });

  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "genpage" } }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
  });
  assert.equal(status, 0);
  assert.ok(waitForFile(probePath, 5000), "dispatcher should have written the probe");
  const probeText = fs.readFileSync(probePath, "utf8");
  const body = JSON.parse(JSON.parse(probeText).body);
  assert.equal(body.data.orgId, STUB_BANNER.orgId);
  assert.equal(body.data.tenantId, STUB_BANNER.tenantId);
  assert.equal(body.data.pacCliVersion, STUB_BANNER.version);
  assert.equal(body.data.eventInfo, undefined);
  assert.equal(probeText.includes(STUB_BANNER.objectId), false, "Entra object id must not be emitted");
  assert.equal(probeText.includes(STUB_BANNER.user), false, "user principal must not be emitted");
  assert.equal(probeText.includes("aadObjectId"), false);
  assert.equal(probeText.includes(TRAP_BANNER.orgId), false, "trap org must not be the source");
  assert.equal(fs.existsSync(startedMarker(stubDir)), true, "stub pac must have run");
  assert.equal(fs.existsSync(startedMarker(trapDir)), false, "ambient pac on the parent PATH must not start");
});
