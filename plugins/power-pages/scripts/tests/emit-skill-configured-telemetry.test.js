"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(
  PLUGIN_ROOT,
  "scripts",
  "emit-skill-configured-telemetry.js"
);
const invocationState = require("../lib/telemetry/invocation-state");

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) sleep(25);
  return fs.existsSync(filePath);
}

test("emits approved localization configuration with the start-hook session", (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-config-event-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-config-project-"));
  const probePath = path.join(configDir, "probe.json");
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
    "configured-session",
    projectRoot
  );

  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--skillName", "add-localization",
      "--projectRoot", projectRoot,
      "--framework", "angular",
      "--operation", "add-languages",
      "--invocationSource", "direct",
      "--existingLocalizationDetected", "true",
      "--mode", "runtime",
      "--defaultLocale", "en-US",
      "--addedLocales", "ar-SA-x-customer,fr-FR",
      "--resultingLocales", "en-US,ar-SA-x-customer,fr-FR",
      "--packageName", "@jsverse/transloco",
      "--packageVersion", "8.0.0",
      "--packageSelection", "recommended",
      "--packageVerification", "verified",
      "--translationMethod", "blank",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: probePath,
        POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
      },
      timeout: 30_000,
    }
  );

  assert.equal(result.status, 0);
  assert.ok(waitForFile(probePath, 5_000), "configured dispatcher should write probe");
  const envelope = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  const eventInfo = JSON.parse(envelope.data.eventInfo);
  assert.equal(envelope.data.eventName, "skill_configured");
  assert.equal(envelope.data.sessionId, "configured-session");
  assert.deepEqual(eventInfo.addedLocales, ["ar-SA", "fr-FR"]);
  assert.equal(eventInfo.translationMethod, "blank");
  assert.equal(eventInfo.addedLocaleCount, undefined);
  assert.ok(
    invocationState.findActive(
      "add-localization",
      projectRoot,
      { requireConfigured: true }
    )
  );
});
