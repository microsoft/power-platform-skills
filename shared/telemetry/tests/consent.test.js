"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const consentLib = require("../lib/consent");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-consent-"));
}

test("read returns { state: 'unset' } when file missing", () => {
  const tmp = mkTmp();
  const result = consentLib.read({ configDir: tmp });
  assert.deepEqual(result, { state: "unset" });
});

test("read returns { state: 'unset' } when file is malformed JSON", () => {
  const tmp = mkTmp();
  fs.writeFileSync(path.join(tmp, "telemetry.json"), "{not json");
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "unset");
});

test("write followed by read round-trips", () => {
  const tmp = mkTmp();
  consentLib.write({ configDir: tmp, enabled: true });
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "enabled");
  assert.equal(result.record.enabled, true);
  assert.equal(result.record.version, 1);
  assert.equal(result.record.prompt_version, 1);
  assert.ok(result.record.consented_at);
});

test("write enabled=false produces state: 'disabled'", () => {
  const tmp = mkTmp();
  consentLib.write({ configDir: tmp, enabled: false });
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "disabled");
  assert.equal(result.record.enabled, false);
});

test("read treats schema version bump as 'unset' (forces re-prompt)", () => {
  const tmp = mkTmp();
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({ version: 2, enabled: true, prompt_version: 1, consented_at: "x" })
  );
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "unset");
});

test("read treats prompt_version bump as 'unset' (forces re-prompt)", () => {
  const tmp = mkTmp();
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({ version: 1, enabled: true, prompt_version: 2, consented_at: "x" })
  );
  const result = consentLib.read({ configDir: tmp });
  assert.equal(result.state, "unset");
});

test("env var POWER_PLATFORM_SKILLS_TELEMETRY=0 overrides to 'disabled'", () => {
  const tmp = mkTmp();
  consentLib.write({ configDir: tmp, enabled: true });
  const result = consentLib.read({
    configDir: tmp,
    env: { POWER_PLATFORM_SKILLS_TELEMETRY: "0" },
  });
  assert.equal(result.state, "disabled");
});

test("env var POWER_PLATFORM_SKILLS_TELEMETRY=1 does NOT force-enable", () => {
  const tmp = mkTmp();
  const result = consentLib.read({
    configDir: tmp,
    env: { POWER_PLATFORM_SKILLS_TELEMETRY: "1" },
  });
  assert.equal(result.state, "unset");
});
