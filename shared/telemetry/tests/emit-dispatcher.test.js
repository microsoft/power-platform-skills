"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DISPATCHER = path.resolve(__dirname, "../lib/emit-dispatcher.js");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-disp-"));
}

// Writes an ikey.json with `disabled: false` so the dispatcher's kill-switch
// gate doesn't block emission-path tests. Returns its path.
function mkEnabledIkey(tmp) {
  const p = path.join(tmp, "ikey.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      instrumentationKey: "placeholder",
      collector_url: "https://example.invalid/",
      event_stream_name: "PowerPagesPluginEvent",
      disabled: false,
    })
  );
  return p;
}

function runDispatcher({ event, env }) {
  const tmp = env.configDir;
  const ikeyJsonPath = env.ikeyJsonPath || mkEnabledIkey(tmp);
  return spawnSync(process.execPath, [DISPATCHER], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp,
      POWER_PLATFORM_SKILLS_IKEY: env.iKey || "",
      POWER_PLATFORM_SKILLS_COLLECTOR: env.collectorUrl || "",
      POWER_PLATFORM_SKILLS_TELEMETRY: env.off ? "0" : "",
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: env.fakeProbe || "",
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyJsonPath,
    },
  });
}

const fakeEvent = {
  name: "PowerPagesPluginEvent",
  data: {
    eventName: "skill_started",
    eventType: "Trace",
    severity: "Info",
    pluginName: "power-pages",
    skillName: "add-seo",
  },
};

test("dispatcher exits 0 when iKey is placeholder", () => {
  const tmp = mkTmp();
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "PLACEHOLDER_REPLACE_BEFORE_SHIPPING", collectorUrl: "https://x" },
  });
  assert.equal(status, 0);
});

test("dispatcher exits 0 when collector URL missing", () => {
  const tmp = mkTmp();
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "real-ikey", collectorUrl: "" },
  });
  assert.equal(status, 0);
});

test("dispatcher POSTs by default (no opt-out present)", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      fakeProbe: probePath,
    },
  });
  assert.equal(status, 0);
  assert.ok(
    fs.existsSync(probePath),
    "default-on: dispatcher must POST when no opt-out is set"
  );
});

test("dispatcher exits 0 when POWER_PLATFORM_SKILLS_TELEMETRY=0", () => {
  const tmp = mkTmp();
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "real-ikey", collectorUrl: "https://x", off: true },
  });
  assert.equal(status, 0);
});

test("dispatcher exits 0 on malformed stdin", () => {
  const tmp = mkTmp();
  const { status } = spawnSync(process.execPath, [DISPATCHER], {
    input: "not json",
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp,
      POWER_PLATFORM_SKILLS_IKEY: "real-ikey",
      POWER_PLATFORM_SKILLS_COLLECTOR: "https://x",
      POWER_PLATFORM_SKILLS_IKEY_JSON: mkEnabledIkey(tmp),
    },
  });
  assert.equal(status, 0);
});

test("dispatcher writes a probe file when fake-https points to one (happy path)", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      fakeProbe: probePath,
    },
  });
  assert.equal(status, 0);
  assert.ok(fs.existsSync(probePath), "expected dispatcher to write probe file");
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  assert.equal(probe.headers["x-apikey"], "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa");
  assert.equal(probe.headers["Content-Type"], "application/x-json-stream; charset=utf-8");
  assert.ok(probe.body.endsWith("\n"), "body must be newline-terminated for x-json-stream");
  const body = JSON.parse(probe.body);
  assert.deepEqual(Object.keys(body).sort(), ["data", "iKey", "name", "time", "ver"]);
  assert.equal(body.ver, "4.0");
  assert.equal(body.name, "PowerPagesPluginEvent");
  assert.equal(body.iKey, "o:real");
  assert.match(body.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(body.data, fakeEvent.data);
});

test("dispatcher strips unknown fields from event.data (defense-in-depth)", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const eventWithExtras = {
    name: "PowerPagesPluginEvent",
    data: {
      eventName: "skill_started",
      eventType: "Trace",
      severity: "Info",
      pluginName: "power-pages",
      skillName: "add-seo",
      // None of these should reach the wire — not in FIELD_TYPES allowlist.
      filePath: "/Users/secret/repo/file.ts",
      stackTrace: "Error: oops\n  at ...",
      rawPrompt: "user prompt text",
      tokenValue: "sk-abcd1234",
    },
  };
  const { status } = runDispatcher({
    event: eventWithExtras,
    env: {
      configDir: tmp,
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      fakeProbe: probePath,
    },
  });
  assert.equal(status, 0);
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  const body = JSON.parse(probe.body);
  assert.deepEqual(Object.keys(body.data).sort(), [
    "eventName",
    "eventType",
    "pluginName",
    "severity",
    "skillName",
  ]);
  assert.equal(body.data.filePath, undefined);
  assert.equal(body.data.stackTrace, undefined);
  assert.equal(body.data.rawPrompt, undefined);
  assert.equal(body.data.tokenValue, undefined);
});

test("dispatcher exits 0 when HTTPS connect is refused", () => {
  const tmp = mkTmp();
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://127.0.0.1:1/OneCollector/1.0/",
    },
  });
  assert.equal(status, 0);
});

test("dispatcher appends to events.jsonl when iKey is placeholder", () => {
  const tmp = mkTmp();
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      collectorUrl: "https://x",
    },
  });
  assert.equal(status, 0);
  const logFile = path.join(tmp, "events.jsonl");
  assert.ok(fs.existsSync(logFile), "expected events.jsonl to be written");
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.name, "PowerPagesPluginEvent");
  assert.equal(parsed.data.eventName, "skill_started");
});

test("dispatcher honours the repo kill switch (ikey.json disabled:true)", () => {
  // When the configured ikey.json has `disabled: true`, the dispatcher
  // must exit before either the HTTPS POST or the local-log path runs.
  const tmp = mkTmp();
  const disabledIkey = path.join(tmp, "ikey.json");
  fs.writeFileSync(
    disabledIkey,
    JSON.stringify({
      instrumentationKey: "x",
      collector_url: "https://x",
      event_stream_name: "X",
      disabled: true,
    })
  );
  const probePath = path.join(tmp, "probe.json");
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      fakeProbe: probePath,
      ikeyJsonPath: disabledIkey,
    },
  });
  assert.equal(status, 0);
  assert.ok(!fs.existsSync(probePath), "kill switch must skip POST");
  assert.ok(
    !fs.existsSync(path.join(tmp, "events.jsonl")),
    "kill switch must skip local log"
  );
});

test("dispatcher does NOT write events.jsonl when env opt-out is set (placeholder iKey)", () => {
  const tmp = mkTmp();
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      collectorUrl: "https://x",
      off: true,
    },
  });
  assert.equal(status, 0);
  assert.ok(
    !fs.existsSync(path.join(tmp, "events.jsonl")),
    "env opt-out must skip local log"
  );
});
