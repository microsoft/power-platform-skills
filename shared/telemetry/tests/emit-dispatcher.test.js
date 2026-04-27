"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DISPATCHER = path.resolve(__dirname, "../lib/emit-dispatcher.js");

function mkConsent(enabled) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-disp-"));
  if (enabled !== undefined) {
    fs.writeFileSync(
      path.join(tmp, "telemetry.json"),
      JSON.stringify({
        version: 1,
        enabled,
        recorded_at: new Date().toISOString(),
      })
    );
  }
  return tmp;
}

function runDispatcher({ event, env }) {
  return spawnSync(process.execPath, [DISPATCHER], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: env.configDir,
      POWER_PLATFORM_SKILLS_IKEY: env.iKey || "",
      POWER_PLATFORM_SKILLS_COLLECTOR: env.collectorUrl || "",
      POWER_PLATFORM_SKILLS_TELEMETRY: env.off ? "0" : "",
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: env.fakeProbe || "",
    },
  });
}

const fakeEvent = {
  name: "VscodeEvent",
  data: {
    eventName: "skill_started",
    eventType: "Trace",
    severity: "Info",
    eventInfo: JSON.stringify({ plugin_name: "power-pages", skill_name: "add-seo" }),
  },
};

test("dispatcher exits 0 when iKey is placeholder", () => {
  const tmp = mkConsent(true);
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "PLACEHOLDER_REPLACE_BEFORE_SHIPPING", collectorUrl: "https://x" },
  });
  assert.equal(status, 0);
});

test("dispatcher exits 0 when collector URL missing", () => {
  const tmp = mkConsent(true);
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "real-ikey", collectorUrl: "" },
  });
  assert.equal(status, 0);
});

test("dispatcher exits 0 when consent disabled", () => {
  const tmp = mkConsent(false);
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "real-ikey", collectorUrl: "https://x" },
  });
  assert.equal(status, 0);
});

test("dispatcher proceeds when consent file is absent (default-on)", () => {
  const tmp = mkConsent(undefined);
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
    "default-on: dispatcher must POST when consent file is absent"
  );
});

test("dispatcher exits 0 when POWER_PLATFORM_SKILLS_TELEMETRY=0", () => {
  const tmp = mkConsent(true);
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "real-ikey", collectorUrl: "https://x", off: true },
  });
  assert.equal(status, 0);
});

test("dispatcher exits 0 on malformed stdin", () => {
  const tmp = mkConsent(true);
  const { status } = spawnSync(process.execPath, [DISPATCHER], {
    input: "not json",
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp,
      POWER_PLATFORM_SKILLS_IKEY: "real-ikey",
      POWER_PLATFORM_SKILLS_COLLECTOR: "https://x",
    },
  });
  assert.equal(status, 0);
});

test("dispatcher writes a probe file when fake-https points to one (happy path)", () => {
  const tmp = mkConsent(true);
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
  assert.equal(body.name, "VscodeEvent");
  assert.equal(body.iKey, "o:real");
  assert.match(body.time, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(body.data, fakeEvent.data);
});

test("dispatcher exits 0 when HTTPS connect is refused", () => {
  const tmp = mkConsent(true);
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

test("dispatcher appends to events.jsonl when iKey is placeholder + consent enabled", () => {
  const tmp = mkConsent(true);
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
  assert.equal(parsed.name, "VscodeEvent");
  assert.equal(parsed.data.eventName, "skill_started");
});

test("dispatcher does NOT write events.jsonl when consent is disabled (placeholder iKey)", () => {
  const tmp = mkConsent(false);
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      collectorUrl: "https://x",
    },
  });
  assert.equal(status, 0);
  assert.ok(
    !fs.existsSync(path.join(tmp, "events.jsonl")),
    "consent-disabled run must not write local log"
  );
});
