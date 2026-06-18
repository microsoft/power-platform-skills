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

function runHook({ input, configDir, ikeyPath }) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyPath || "",
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
