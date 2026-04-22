"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK = path.resolve(
  __dirname,
  "../../hooks/run-skill-posttool-validation.js"
);

function mkConfigDir(enabled) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-ho-"));
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({
      version: 1,
      prompt_version: 1,
      enabled,
      consented_at: new Date().toISOString(),
    })
  );
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

test("posttool hook exits 0 with no tracked skill (preserves existing behavior)", () => {
  const tmp = mkConfigDir(true);
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "nothing" } }),
    configDir: tmp,
  });
  assert.equal(status, 0);
});

test("posttool hook exits 0 when consent disabled (no emit, validator still runs)", () => {
  const tmp = mkConfigDir(false);
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "create-site" } }),
    configDir: tmp,
  });
  assert.equal(status, 0);
});
