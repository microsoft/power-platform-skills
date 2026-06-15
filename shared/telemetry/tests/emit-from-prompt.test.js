"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { emitSkillStartedFromPrompt } = require("../lib/emit-from-prompt");

function mkTelemetryDir({ instrumentationKey, collectorUrl, eventStreamName, disabled }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-efp-"));
  fs.writeFileSync(
    path.join(tmp, "ikey.json"),
    JSON.stringify({
      event_stream_name: eventStreamName,
      disabled: disabled === true,
      default_region: "us",
      regions: { us: { instrumentation_key: instrumentationKey, collector_url: collectorUrl } },
    })
  );
  // Drop the region resolver beside ikey.json so the generic isProvisioned gate
  // behaves exactly like production (provisioned == default-region key present).
  fs.writeFileSync(
    path.join(tmp, "resolver.js"),
    "module.exports = {" +
      "async resolve() { return null; }," +
      "isProvisioned(cfg) {" +
      "  const e = cfg && cfg.regions && cfg.regions[(cfg && cfg.default_region) || 'us'];" +
      "  return !!(e && e.instrumentation_key);" +
      "} };"
  );
  return tmp;
}

const TRACKED = { "add-seo": {}, "create-site": {} };

function callWithStub({ promptText, telemetryDir, captured, pacAuth, agentInfo }) {
  return emitSkillStartedFromPrompt(promptText, {
    pluginName: "power-pages",
    pluginVersion: "1.2.3",
    trackedSkills: TRACKED,
    telemetryDir,
    _emit: (event, spawnOpts) => {
      captured.event = event;
      captured.spawnOpts = spawnOpts;
    },
    _readPacAuth: pacAuth === undefined ? () => null : () => pacAuth,
    _readAgentInfo: agentInfo === undefined ? () => ({}) : () => agentInfo,
  });
}

test("returns { emitted: false } when detection returns null", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  const result = callWithStub({
    promptText: "not a slash command",
    telemetryDir,
    captured,
  });
  assert.deepEqual(result, { emitted: false, skillName: null });
  assert.equal(captured.event, undefined);
});

test("returns { emitted: false } when default region has no instrumentation_key", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-efp-nokey-"));
  fs.writeFileSync(
    path.join(tmp, "ikey.json"),
    JSON.stringify({
      event_stream_name: "PowerPagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: { us: { collector_url: "https://x" } },
    })
  );
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
    _readPacAuth: () => null,
  });
  assert.deepEqual(result, { emitted: false, skillName: "add-seo" });
  assert.equal(captured.event, undefined);
});

test("emits skill_started with envelope name from ikey.json", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  const result = callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
  });
  assert.equal(result.emitted, true);
  assert.equal(result.skillName, "add-seo");
  assert.equal(captured.event.name, "PowerPagesPluginEvent");
  assert.equal(captured.event.data.eventName, "skill_started");
  assert.equal(captured.event.data.eventType, "Trace");
  assert.equal(captured.event.data.severity, "Info");
  assert.equal(captured.event.data.pluginName, "power-pages");
  assert.equal(captured.event.data.pluginVersion, "1.2.3");
  assert.equal(captured.event.data.skillName, "add-seo");
  assert.equal(typeof captured.event.data.sessionId, "string");
  assert.equal(typeof captured.event.data.correlationId, "string");
  assert.equal(typeof captured.event.data.osName, "string");
  assert.equal(typeof captured.event.data.osVersion, "string");
  assert.match(captured.event.data.nodeVersion, /^v\d+$/);
});

test("populates orgId/tenantId when PAC auth is present", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
    pacAuth: {
      orgId: "22222222-2222-2222-2222-222222222222",
      tenantId: "11111111-1111-1111-1111-111111111111",
    },
  });
  assert.equal(captured.event.data.orgId, "22222222-2222-2222-2222-222222222222");
  assert.equal(captured.event.data.tenantId, "11111111-1111-1111-1111-111111111111");
});

test("populates aiAgentName/aiAgentVersion/pacCliVersion when agentInfo is present", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
    agentInfo: {
      aiAgentName: "Claude Code",
      aiAgentVersion: "2.0.0",
      pacCliVersion: "1.36.0",
    },
  });
  assert.equal(captured.event.data.aiAgentName, "Claude Code");
  assert.equal(captured.event.data.aiAgentVersion, "2.0.0");
  assert.equal(captured.event.data.pacCliVersion, "1.36.0");
});

test("omits agent fields when agentInfo returns empty values", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
    agentInfo: { aiAgentName: "", aiAgentVersion: "", pacCliVersion: "" },
  });
  assert.equal(captured.event.data.aiAgentName, undefined);
  assert.equal(captured.event.data.aiAgentVersion, undefined);
  assert.equal(captured.event.data.pacCliVersion, undefined);
});

test("omits orgId/tenantId when PAC auth is absent", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
    pacAuth: null,
  });
  assert.equal(captured.event.data.orgId, undefined);
  assert.equal(captured.event.data.tenantId, undefined);
});

test("forwards POWER_PLATFORM_SKILLS_CONFIG_DIR and FAKE_HTTPS into spawn opts", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
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

test("forwards the plugin ikey.json path into spawn opts (so the dispatcher reads the plugin config, not shared/'s placeholder)", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  // Production-faithful: no IKEY_JSON override → ikeyPath resolves to telemetryDir/ikey.json.
  const prevOverride = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  delete process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const captured = {};
  try {
    callWithStub({
      promptText: "/power-pages:add-seo",
      telemetryDir,
      captured,
    });
  } finally {
    if (prevOverride === undefined) delete process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
    else process.env.POWER_PLATFORM_SKILLS_IKEY_JSON = prevOverride;
  }
  assert.equal(captured.spawnOpts.ikeyJsonPath, path.join(telemetryDir, "ikey.json"));
});

test("forwards pacAuth.cloud into spawn opts", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
    pacAuth: { cloud: "UsGov" },
  });
  assert.equal(captured.spawnOpts.cloud, "UsGov");
  assert.equal(captured.spawnOpts.iKey, undefined);
  assert.equal(captured.spawnOpts.collectorUrl, undefined);
});

test("spawn opts include empty cloud when pacAuth has no cloud", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  callWithStub({
    promptText: "/power-pages:add-seo",
    telemetryDir,
    captured,
    pacAuth: null,
  });
  assert.equal(captured.spawnOpts.cloud, "");
});

test("does not throw when ikey.json is missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-efp-noikey-"));
  const captured = {};
  assert.doesNotThrow(() =>
    emitSkillStartedFromPrompt("/power-pages:add-seo", {
      pluginName: "power-pages",
      pluginVersion: "1.2.3",
      trackedSkills: TRACKED,
      telemetryDir: tmp,
      _emit: (e, o) => {
        captured.event = e;
        captured.spawnOpts = o;
      },
      _readPacAuth: () => null,
    })
  );
  // Missing ikey.json → unreadable config fails CLOSED (disabled) → no emit.
  assert.equal(captured.event, undefined);
});

test("does not throw when _emit throws", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  assert.doesNotThrow(() =>
    emitSkillStartedFromPrompt("/power-pages:add-seo", {
      pluginName: "power-pages",
      pluginVersion: "1.2.3",
      trackedSkills: TRACKED,
      telemetryDir,
      _emit: () => {
        throw new Error("boom");
      },
      _readPacAuth: () => null,
    })
  );
});

test("disabled:true short-circuits BEFORE PAC / agent-info shellouts", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "x",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
    disabled: true,
  });
  const captured = {};
  let pacCalled = false;
  let agentCalled = false;
  const result = emitSkillStartedFromPrompt("/power-pages:add-seo", {
    pluginName: "power-pages",
    pluginVersion: "1.2.3",
    trackedSkills: TRACKED,
    telemetryDir,
    _emit: (e, o) => {
      captured.event = e;
      captured.spawnOpts = o;
    },
    _readPacAuth: () => {
      pacCalled = true;
      return null;
    },
    _readAgentInfo: () => {
      agentCalled = true;
      return {};
    },
  });
  assert.deepEqual(result, { emitted: false, skillName: "add-seo" });
  assert.equal(captured.event, undefined);
  assert.equal(pacCalled, false, "PAC must not be invoked when disabled");
  assert.equal(agentCalled, false, "agent-info must not be invoked when disabled");
});

test("missing instrumentationKey short-circuits BEFORE PAC / agent-info", () => {
  const telemetryDir = mkTelemetryDir({
    instrumentationKey: "",
    collectorUrl: "https://x",
    eventStreamName: "PowerPagesPluginEvent",
  });
  const captured = {};
  let pacCalled = false;
  const result = emitSkillStartedFromPrompt("/power-pages:add-seo", {
    pluginName: "power-pages",
    pluginVersion: "1.2.3",
    trackedSkills: TRACKED,
    telemetryDir,
    _emit: (e, o) => {
      captured.event = e;
      captured.spawnOpts = o;
    },
    _readPacAuth: () => {
      pacCalled = true;
      return null;
    },
  });
  assert.deepEqual(result, { emitted: false, skillName: "add-seo" });
  assert.equal(captured.event, undefined);
  assert.equal(pacCalled, false, "PAC must not be invoked when iKey is missing");
});
