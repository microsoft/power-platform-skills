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

function mkConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-ho-"));
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
  const { status } = runHook({
    input: JSON.stringify({ tool_input: { skill: "nothing" } }),
    configDir: mkConfigDir(),
  });
  assert.equal(status, 0);
});
