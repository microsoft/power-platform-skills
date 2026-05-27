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

function runHook({ input, configDir, off }) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_TELEMETRY: off ? "0" : "",
    },
  });
}

test("exits 0 and emits nothing when tool_input has no tracked skill", () => {
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "other-plugin:foo" } }),
    configDir: mkConfigDir(),
  });
  assert.equal(status, 0);
});

test("exits 0 when env opt-out is set", () => {
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir: mkConfigDir(),
    off: true,
  });
  assert.equal(status, 0);
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

test("pretool hook exits 0 when ikey.json has regions but default_region entry has no key", () => {
  const tmp = mkConfigDir();
  const PLUGIN_ROOT = path.resolve(__dirname, "../..");
  const ikeyPath = path.join(PLUGIN_ROOT, "scripts", "lib", "telemetry", "ikey.json");
  const original = fs.readFileSync(ikeyPath, "utf8");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      event_stream_name: "PagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: { us: { collector_url: "https://x" } },
    })
  );
  try {
    const { status } = runHook({
      input: JSON.stringify({ tool_input: { skill: "add-seo" } }),
      configDir: tmp,
    });
    assert.equal(status, 0);
  } finally {
    fs.writeFileSync(ikeyPath, original);
  }
});
