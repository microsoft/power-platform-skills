"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = require("../lib/telemetry/invocation-state");

test("persists correlation state without storing the project path", (t) => {
  const original = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-state-"));
  const projectRoot = path.join(configDir, "customer-project");
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = configDir;
  t.after(() => {
    if (original === undefined) {
      delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    } else {
      process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = original;
    }
  });

  const now = Date.now();
  assert.equal(state.projectHash({ invalid: "cwd" }), "");
  const file = state.recordStart(
    "add-localization",
    "host-session-123",
    projectRoot,
    now
  );
  assert.ok(file);
  const raw = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /customer-project/);
  assert.equal(state.findActive("add-localization", projectRoot).sessionId, "host-session-123");

  state.markConfigured("add-localization", projectRoot, now + 1);
  const configured = state.findActive(
    "add-localization",
    projectRoot,
    { requireConfigured: true }
  );
  assert.equal(configured.configuredAt, now + 1);
  assert.equal(
    state.findActive("add-localization", projectRoot, {
      requireConfigured: true,
      sessionId: "different-session",
    }),
    null
  );

  state.removeState(configured);
  assert.equal(
    state.findActive("add-localization", projectRoot, { requireConfigured: true }),
    null
  );
});
