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

function mkConfigDir(enabled) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-ph-"));
  if (enabled !== undefined) {
    fs.writeFileSync(
      path.join(tmp, "telemetry.json"),
      JSON.stringify({
        version: 1,
        prompt_version: 1,
        enabled,
        consented_at: new Date().toISOString(),
      })
    );
  }
  return tmp;
}

function runHook({ input, configDir }) {
  return spawnSync(process.execPath, [HOOK], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
    },
  });
}

test("exits 0 and emits nothing when tool_input has no tracked skill", () => {
  const tmp = mkConfigDir(true);
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "other-plugin:foo" } }),
    configDir: tmp,
  });
  assert.equal(status, 0);
});

test("exits 0 when consent unset", () => {
  const tmp = mkConfigDir(undefined);
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir: tmp,
  });
  assert.equal(status, 0);
});

test("exits 0 when malformed stdin", () => {
  const tmp = mkConfigDir(true);
  const { status } = runHook({ input: "{not json", configDir: tmp });
  assert.equal(status, 0);
});

test("exits 0 even when consent enabled and skill tracked (placeholder iKey → no-op emit)", () => {
  const tmp = mkConfigDir(true);
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir: tmp,
  });
  assert.equal(status, 0);
});
