"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { emitSkillStartedFromPrompt } = require("../lib/emit-from-prompt");

function mkTelemetryDir(ikeyJson) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-efp-"));
  fs.writeFileSync(path.join(tmp, "ikey.json"), JSON.stringify(ikeyJson));
  return tmp;
}

const TRACKED = { "add-seo": {}, "create-site": {} };

function callWithStub({ promptText, telemetryDir, captured }) {
  return emitSkillStartedFromPrompt(promptText, {
    pluginName: "power-pages",
    pluginVersion: "1.2.3",
    trackedSkills: TRACKED,
    telemetryDir,
    _emit: (event, spawnOpts) => {
      captured.event = event;
      captured.spawnOpts = spawnOpts;
    },
  });
}

test("returns { emitted: false } when detection returns null", () => {
  const telemetryDir = mkTelemetryDir({ ikey: "whatever", collector_url: "https://x" });
  const captured = {};
  const result = callWithStub({
    promptText: "not a slash command",
    telemetryDir,
    captured,
  });
  assert.deepEqual(result, { emitted: false, skillName: null });
  assert.equal(captured.event, undefined);
});

test("emits skill_started envelope with expected shape on match", () => {
  const telemetryDir = mkTelemetryDir({
    ikey: "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
    collector_url: "https://x",
  });
  const captured = {};
  const result = callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
  });
  assert.equal(result.emitted, true);
  assert.equal(result.skillName, "add-seo");
  assert.equal(captured.event.name, "PowerPlatformSkillsEvent");
  assert.equal(captured.event.data.eventName, "skill_started");
  const info = JSON.parse(captured.event.data.eventInfo);
  assert.equal(info.plugin_name, "power-pages");
  assert.equal(info.plugin_version, "1.2.3");
  assert.equal(info.skill_name, "add-seo");
  assert.equal(typeof info.correlation_id, "string");
  assert.ok(info.correlation_id.length > 0);
  assert.equal(typeof info.session_id, "string");
  assert.equal(typeof info.os_family, "string");
  assert.match(info.node_version, /^v\d+$/);
});

test("passes iKey and collectorUrl from ikey.json into spawn opts", () => {
  const telemetryDir = mkTelemetryDir({
    ikey: "real-ikey-value",
    collector_url: "https://collector.example/",
  });
  const captured = {};
  callWithStub({
    promptText: "/power-pages:create-site",
    telemetryDir,
    captured,
  });
  assert.equal(captured.spawnOpts.iKey, "real-ikey-value");
  assert.equal(captured.spawnOpts.collectorUrl, "https://collector.example/");
});

test("forwards POWER_PLATFORM_SKILLS_CONFIG_DIR and _FAKE_HTTPS into spawn opts", () => {
  const telemetryDir = mkTelemetryDir({ ikey: "x", collector_url: "https://x" });
  const prevCfg = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const prevProbe = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS;
  process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = "/tmp/fake-config";
  process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS = "/tmp/fake-probe.json";
  const captured = {};
  try {
    callWithStub({
      promptText: "/power-pages:add-seo",
      telemetryDir,
      captured,
    });
  } finally {
    if (prevCfg === undefined) delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
    else process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = prevCfg;
    if (prevProbe === undefined) delete process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS;
    else process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS = prevProbe;
  }
  assert.equal(captured.spawnOpts.configDir, "/tmp/fake-config");
  assert.equal(captured.spawnOpts.fakeProbe, "/tmp/fake-probe.json");
});

test("spawn opts get empty strings when env vars are unset", () => {
  const telemetryDir = mkTelemetryDir({ ikey: "x", collector_url: "https://x" });
  const prevCfg = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  const prevProbe = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS;
  delete process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR;
  delete process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS;
  const captured = {};
  try {
    callWithStub({
      promptText: "/power-pages:add-seo",
      telemetryDir,
      captured,
    });
  } finally {
    if (prevCfg !== undefined) process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR = prevCfg;
    if (prevProbe !== undefined) process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS = prevProbe;
  }
  assert.equal(captured.spawnOpts.configDir, "");
  assert.equal(captured.spawnOpts.fakeProbe, "");
});

test("tolerates missing ikey.json — falls through to empty ikey/collector", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-efp-noikey-"));
  const captured = {};
  const result = emitSkillStartedFromPrompt("/power-pages:add-seo", {
    pluginName: "power-pages",
    pluginVersion: "1.2.3",
    trackedSkills: TRACKED,
    telemetryDir: tmp,
    _emit: (event, spawnOpts) => {
      captured.event = event;
      captured.spawnOpts = spawnOpts;
    },
  });
  assert.equal(result.emitted, true);
  assert.equal(captured.spawnOpts.iKey, "");
  assert.equal(captured.spawnOpts.collectorUrl, "");
});

test("does not throw when _emit throws internally (fail-closed)", () => {
  const telemetryDir = mkTelemetryDir({ ikey: "x", collector_url: "https://x" });
  assert.doesNotThrow(() =>
    emitSkillStartedFromPrompt("/power-pages:add-seo", {
      pluginName: "power-pages",
      pluginVersion: "1.2.3",
      trackedSkills: TRACKED,
      telemetryDir,
      _emit: () => {
        throw new Error("boom");
      },
    })
  );
});
