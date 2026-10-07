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
const PRETOOL_HOOK = path.join(
  PLUGIN_ROOT,
  "hooks",
  "run-skill-pretool-telemetry.js"
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

function writeTelemetryConfig(configDir) {
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

function runStart({ configDir, hostRoot, ikeyPath, sessionId, skillName, probeName }) {
  return spawnSync(
    process.execPath,
    [PRETOOL_HOOK],
    {
      input: JSON.stringify({
        cwd: hostRoot,
        session_id: sessionId,
        tool_input: { skill: skillName },
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: path.join(configDir, probeName),
        POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
      },
      timeout: 30_000,
    }
  );
}

function runCreateSiteConfigured({ configDir, projectRoot, ikeyPath, probeName }) {
  const probePath = path.join(configDir, probeName);
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--skillName", "create-site",
      "--projectRoot", projectRoot,
      "--framework", "react",
      "--siteContentLocale", "en-US",
      "--purpose", "company-portal",
      "--audience", "internal",
      "--choiceSource", "prompt",
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
  assert.ok(waitForFile(probePath, 5_000), "configured dispatcher should write probe");
  return JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
}

function invocationFileCount(configDir, skillName) {
  const dir = path.join(
    configDir,
    "telemetry",
    "power-pages",
    "invocations",
    skillName
  );
  try {
    return fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

test("emits approved localization configuration with the start-hook session", (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-config-event-"));
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-config-host-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-config-project-"));
  const probePath = path.join(configDir, "probe.json");
  const startProbePath = path.join(configDir, "start-probe.json");
  const ikeyPath = writeTelemetryConfig(configDir);

  const originalConfigDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (originalConfigDir === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = originalConfigDir;
    }
  });
  const startResult = spawnSync(
    process.execPath,
    [PRETOOL_HOOK],
    {
      input: JSON.stringify({
        cwd: hostRoot,
        session_id: "configured-session",
        tool_input: { skill: "add-localization" },
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: "",
        POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: startProbePath,
        POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
      },
      timeout: 30_000,
    }
  );
  assert.equal(startResult.status, 0);

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

test("create-site finalizes normal and ambiguous invocation state", (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-create-config-"));
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-create-host-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-create-project-"));
  const ikeyPath = writeTelemetryConfig(configDir);
  const originalConfigDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (originalConfigDir === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = originalConfigDir;
    }
  });

  assert.equal(
    runStart({
      configDir,
      hostRoot,
      ikeyPath,
      sessionId: "create-session-1",
      skillName: "create-site",
      probeName: "start-1.json",
    }).status,
    0
  );
  const first = runCreateSiteConfigured({
    configDir,
    projectRoot,
    ikeyPath,
    probeName: "configured-1.json",
  });
  assert.equal(first.data.sessionId, "create-session-1");
  assert.equal(invocationFileCount(configDir, "create-site"), 0);

  assert.equal(
    runStart({
      configDir,
      hostRoot,
      ikeyPath,
      sessionId: "create-session-2",
      skillName: "create-site",
      probeName: "start-2.json",
    }).status,
    0
  );
  const second = runCreateSiteConfigured({
    configDir,
    projectRoot,
    ikeyPath,
    probeName: "configured-2.json",
  });
  assert.equal(second.data.sessionId, "create-session-2");
  assert.equal(invocationFileCount(configDir, "create-site"), 0);

  assert.equal(
    runStart({
      configDir,
      hostRoot,
      ikeyPath,
      sessionId: "abandoned-session",
      skillName: "create-site",
      probeName: "start-abandoned.json",
    }).status,
    0
  );
  assert.equal(
    runStart({
      configDir,
      hostRoot,
      ikeyPath,
      sessionId: "retry-session",
      skillName: "create-site",
      probeName: "start-retry.json",
    }).status,
    0
  );
  const ambiguous = runCreateSiteConfigured({
    configDir,
    projectRoot,
    ikeyPath,
    probeName: "configured-ambiguous.json",
  });
  assert.notEqual(ambiguous.data.sessionId, "abandoned-session");
  assert.notEqual(ambiguous.data.sessionId, "retry-session");
  assert.equal(invocationFileCount(configDir, "create-site"), 0);

  assert.equal(
    runStart({
      configDir,
      hostRoot,
      ikeyPath,
      sessionId: "recovered-session",
      skillName: "create-site",
      probeName: "start-recovered.json",
    }).status,
    0
  );
  const recovered = runCreateSiteConfigured({
    configDir,
    projectRoot,
    ikeyPath,
    probeName: "configured-recovered.json",
  });
  assert.equal(recovered.data.sessionId, "recovered-session");
  assert.equal(invocationFileCount(configDir, "create-site"), 0);
});
