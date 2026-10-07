"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const invocationState = require("../lib/telemetry/invocation-state");

const HOOK = path.resolve(
  __dirname,
  "../../hooks/run-skill-posttool-validation.js"
);
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..");

function mkConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-ho-"));
}

function runHook({ input, configDir, ikeyPath, fakeProbe, preload }) {
  const args = preload ? ["--require", preload, HOOK] : [HOOK];
  return spawnSync(process.execPath, args, {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: "",
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath || "",
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe || "",
      POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: "",
    },
    timeout: 30_000,
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

test("posttool hook exits 0 with no tracked skill (preserves existing behavior)", () => {
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "nothing" } }),
    configDir: mkConfigDir(),
  });
  assert.equal(status, 0);
});

test("validation continues when the optional telemetry module cannot load", () => {
  const configDir = mkConfigDir();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-localized-"));
  const preload = path.join(configDir, "block-telemetry-load.js");
  fs.writeFileSync(
    preload,
    [
      '"use strict";',
      'const Module = require("node:module");',
      "const originalLoad = Module._load;",
      "Module._load = function (request, parent, isMain) {",
      '  if (String(request).includes("power-pages-telemetry")) {',
      '    throw new Error("simulated telemetry load failure");',
      "  }",
      "  return originalLoad.call(this, request, parent, isMain);",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(projectRoot, ".powerpages-localization.json"),
    JSON.stringify({
      locales: ["en-US", "fr-FR"],
      translationMethod: "agent",
    })
  );
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({
      dependencies: {
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
    })
  );
  fs.writeFileSync(
    path.join(projectRoot, "powerpages.config.json"),
    JSON.stringify({ siteName: "Telemetry Test" })
  );

  const result = runHook({
    input: JSON.stringify({
      cwd: projectRoot,
      session_id: "telemetry-load-failure-session",
      tool_input: { skill: "add-localization" },
    }),
    configDir,
    preload,
  });

  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /simulated telemetry load failure/);
});

test("does not emit completion when the Skill hook runs before implementation", (t) => {
  const configDir = mkConfigDir();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-localized-"));
  const probePath = path.join(configDir, "probe.json");
  const ikeyPath = writeProvisionedConfig(configDir);
  fs.writeFileSync(
    path.join(projectRoot, ".powerpages-localization.json"),
    JSON.stringify({
      locales: ["en-US", "fr-FR"],
      translationMethod: "agent",
    })
  );
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({
      dependencies: {
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
    })
  );
  fs.writeFileSync(
    path.join(projectRoot, "powerpages.config.json"),
    JSON.stringify({ siteName: "Telemetry Test" })
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

  const { status } = runHook({
    input: JSON.stringify({
      cwd: projectRoot,
      session_id: "completion-session",
      tool_input: { skill: "add-localization" },
    }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
  });

  assert.equal(status, 2);
  assert.equal(waitForFile(probePath, 250), false);
  assert.ok(
    invocationState.findActive(
      "add-localization",
      projectRoot,
      { requireConfigured: true, sessionId: "completion-session" }
    )
  );
});

test("unexpected hook errors do not emit or remove ambiguous state", (t) => {
  const configDir = mkConfigDir();
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
    "hook-error-session",
    projectRoot
  );
  invocationState.markConfigured("add-localization", projectRoot);

  const result = runHook({
    input: JSON.stringify({
      cwd: { invalid: true },
      session_id: "hook-error-session",
      tool_input: { skill: "add-localization" },
    }),
    configDir,
    ikeyPath,
    fakeProbe: probePath,
  });

  assert.equal(result.status, 0);
  assert.match(result.stderr, /Unexpected error/);
  assert.equal(fs.existsSync(probePath), false);
  assert.ok(invocationState.findActive(
    "add-localization",
    projectRoot,
    { sessionId: "hook-error-session" }
  ));
});
