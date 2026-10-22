"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT = path.resolve(
  __dirname,
  "../emit-localization-completed-telemetry.js"
);
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const invocationState = require("../lib/telemetry/invocation-state");

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
  fs.writeFileSync(
    path.join(configDir, "resolver.js"),
    `module.exports = require(${JSON.stringify(
      path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry", "resolver.js")
    )});\n`
  );
  return ikeyPath;
}

test("emits completion only from the explicit final workflow command", (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-completed-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-localized-"));
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);
  fs.writeFileSync(
    path.join(projectRoot, ".powerpages-localization.json"),
    JSON.stringify({
      locales: ["en-US", "fr-FR"],
      unavailableLocales: ["fr-FR"],
      bidirectionalReadiness: { status: "pending-remediation" },
      translationMethod: "agent",
    })
  );

  const originalConfigDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (originalConfigDir === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = originalConfigDir;
    }
  });
  invocationState.recordStart(
    "add-localization",
    "completion-session",
    projectRoot,
    Date.now() - 250
  );
  invocationState.markConfigured("add-localization", projectRoot);

  const result = spawnSync(
    process.execPath,
    [SCRIPT, "--projectRoot", projectRoot],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
        POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
      },
      timeout: 30_000,
    }
  );

  assert.equal(result.status, 0);
  assert.ok(waitForFile(probePath, 5_000), "completion dispatcher should write probe");
  const envelope = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  const eventInfo = JSON.parse(envelope.data.eventInfo);
  assert.equal(envelope.data.eventName, "skill_completed");
  assert.equal(envelope.data.skillName, "add-localization");
  assert.equal(envelope.data.sessionId, "completion-session");
  assert.equal(envelope.data.outcome, "success");
  assert.ok(envelope.data.durationMs >= 250);
  assert.equal(eventInfo.validationOutcome, "passed");
  assert.equal(eventInfo.bidirectionalReadiness, "pending-remediation");
  assert.equal(eventInfo.unavailableLocaleCount, 1);
  assert.equal(eventInfo.configuredLocaleCount, 2);
  assert.equal(eventInfo.translationMethod, "agent");
  assert.equal(
    invocationState.findActive(
      "add-localization",
      projectRoot,
      { requireConfigured: true }
    ),
    null
  );
});

test("emits an allowlisted failure when no manifest is available", (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-failed-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-localized-"));
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);
  const originalConfigDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (originalConfigDir === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = originalConfigDir;
    }
  });
  invocationState.recordStart(
    "add-localization",
    "failure-session",
    projectRoot,
    Date.now() - 250
  );
  invocationState.markConfigured("add-localization", projectRoot);

  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--projectRoot", projectRoot,
      "--outcome", "failure",
      "--validationOutcome", "failed",
      "--errorClass", "localization-build-failed",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
        POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
      },
      timeout: 30_000,
    }
  );

  assert.equal(result.status, 0);
  assert.ok(waitForFile(probePath, 5_000), "failure dispatcher should write probe");
  const envelope = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  const eventInfo = JSON.parse(envelope.data.eventInfo);
  assert.equal(envelope.data.sessionId, "failure-session");
  assert.equal(envelope.data.outcome, "failure");
  assert.equal(envelope.data.errorClass, "localization-build-failed");
  assert.equal(envelope.data.severity, "Error");
  assert.equal(eventInfo.validationOutcome, "failed");
  assert.equal(eventInfo.configuredLocaleCount, undefined);
  assert.equal(eventInfo.unavailableLocaleCount, undefined);
  assert.equal(
    invocationState.findActive(
      "add-localization",
      projectRoot,
      { requireConfigured: true }
    ),
    null
  );
});

test("rejects non-allowlisted failure classifications", (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-failed-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-localized-"));
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);
  const originalConfigDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (originalConfigDir === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = originalConfigDir;
    }
  });
  invocationState.recordStart(
    "add-localization",
    "invalid-failure-session",
    projectRoot
  );
  invocationState.markConfigured("add-localization", projectRoot);

  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--projectRoot", projectRoot,
      "--outcome", "failure",
      "--validationOutcome", "failed",
      "--errorClass", "C:\\customer\\private-error.txt",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
        POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
      },
      timeout: 30_000,
    }
  );

  assert.equal(result.status, 0);
  assert.equal(waitForFile(probePath, 250), false);
  assert.ok(
    invocationState.findActive(
      "add-localization",
      projectRoot,
      { requireConfigured: true }
    )
  );
});
