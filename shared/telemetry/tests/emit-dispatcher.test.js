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

// Local-mirror path for fakeEvent under the per-session layout. fakeEvent has
// pluginName "power-pages" and NO sessionId, so it falls back to "nosession".
function mirrorPath(tmp) {
  return path.join(tmp, "telemetry", "power-pages", "sessions", "nosession", "events.jsonl");
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
  // Opt-out is a per-plugin config.json in the config dir (env var removed).
  if (env.off) {
    fs.writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({ telemetry: { "power-pages": "off" } })
    );
  }
  return spawnSync(process.execPath, [DISPATCHER], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp,
      POWER_PLATFORM_SKILLS_IKEY: env.iKey || "",
      POWER_PLATFORM_SKILLS_COLLECTOR: env.collectorUrl || "",
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: env.fakeProbe || "",
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyJsonPath,
      POWER_PLATFORM_SKILLS_CLOUD: env.cloud || "",
      POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT: env.optOut || "",
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

test("dispatcher exits 0 when the plugin is opted out via config.json", () => {
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

test("dispatcher stringifies eventInfo on the wire but keeps it an object in the local mirror", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const eventWithInfo = {
    name: "PowerPagesPluginEvent",
    data: {
      ...fakeEvent.data,
      eventInfo: { aadObjectId: "11111111-2222-3333-4444-555555555555" },
    },
  };
  const { status } = runDispatcher({
    event: eventWithInfo,
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
  assert.equal(
    typeof body.data.eventInfo,
    "string",
    "wire envelope must carry eventInfo as a JSON string leaf"
  );
  assert.deepEqual(JSON.parse(body.data.eventInfo), eventWithInfo.data.eventInfo);

  const mirror = mirrorPath(tmp);
  const mirrorLine = fs
    .readFileSync(mirror, "utf8")
    .trim()
    .split("\n")
    .pop();
  const mirrorRecord = JSON.parse(mirrorLine);
  assert.equal(
    typeof mirrorRecord.data.eventInfo,
    "object",
    "local mirror must keep eventInfo as a real object"
  );
  assert.deepEqual(mirrorRecord.data.eventInfo, eventWithInfo.data.eventInfo);
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
  const logFile = mirrorPath(tmp);
  assert.ok(fs.existsSync(logFile), "expected events.jsonl to be written");
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.name, "PowerPagesPluginEvent");
  assert.equal(parsed.data.eventName, "skill_started");
});

test("dispatcher ALSO appends to events.jsonl when a real iKey POSTs (irrespective of iKey presence)", () => {
  // The local log must mirror every event sent to the collector, not only the
  // placeholder/unprovisioned case. With a real iKey + fake-https probe, BOTH
  // the probe (the would-be POST) and events.jsonl (the local mirror) exist.
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
  assert.ok(fs.existsSync(probePath), "real iKey must still POST");
  const logFile = mirrorPath(tmp);
  assert.ok(
    fs.existsSync(logFile),
    "real iKey must ALSO write the local log"
  );
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.name, "PowerPagesPluginEvent");
  assert.equal(parsed.data.eventName, "skill_started");
  assert.equal(parsed.data.skillName, "add-seo");
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
    !fs.existsSync(path.join(tmp, "telemetry")),
    "kill switch must skip local log"
  );
});

test("dispatcher fails closed when ikey.json is missing/unreadable", () => {
  // The kill switch must suppress emission when its config can't be read —
  // no HTTPS POST and no local log — even though a real iKey is in env.
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      fakeProbe: probePath,
      ikeyJsonPath: path.join(tmp, "does-not-exist.json"),
    },
  });
  assert.equal(status, 0);
  assert.ok(!fs.existsSync(probePath), "missing config must skip POST");
  assert.ok(
    !fs.existsSync(path.join(tmp, "telemetry")),
    "missing config must skip local log"
  );
});

test("dispatcher writes the local mirror when opted out via config, but does NOT POST", () => {
  // A per-plugin config opt-out suppresses TRANSMISSION only — the local
  // diagnostic mirror is still written. With a real iKey + fake-https probe AND
  // the opt-out set, the local log exists and the probe (would-be POST) does not.
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      fakeProbe: probePath,
      off: true,
    },
  });
  assert.equal(status, 0);
  assert.ok(!fs.existsSync(probePath), "config opt-out must skip the POST");
  const logFile = mirrorPath(tmp);
  assert.ok(
    fs.existsSync(logFile),
    "config opt-out must still write the local mirror"
  );
  const parsed = JSON.parse(fs.readFileSync(logFile, "utf8").trim());
  assert.equal(parsed.name, "PowerPagesPluginEvent");
  assert.equal(parsed.data.eventName, "skill_started");
});

test("a DIFFERENT plugin's opt-out does not silence this plugin", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  // config opts out 'model-apps', but the event is for 'power-pages'
  fs.writeFileSync(
    path.join(tmp, "config.json"),
    JSON.stringify({ telemetry: { "model-apps": "off" } })
  );
  const { status } = runDispatcher({
    event: fakeEvent, // pluginName: "power-pages"
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
    "power-pages must still POST when only model-apps is off"
  );
});

test("local mirror records the same data + time that gets POSTed to Kusto", () => {
  // The on-disk record and the wire envelope share one sanitized `data` (== the
  // Kusto columns) and one `time`. The mirror intentionally omits the envelope-
  // only transport fields (ver, iKey).
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
  const wire = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  const local = JSON.parse(
    fs.readFileSync(mirrorPath(tmp), "utf8").trim()
  );
  assert.equal(local.name, wire.name);
  assert.equal(local.time, wire.time);
  assert.deepEqual(local.data, wire.data);
  assert.equal(local.ver, undefined, "local mirror omits envelope-only ver");
  assert.equal(local.iKey, undefined, "local mirror omits envelope-only iKey");
});

// ---- iKey/collector resolution (generic seam) -----------------------------

test("dispatcher uses static instrumentationKey/collector_url when no resolver is present", () => {
  // mkEnabledIkey writes a flat ikey.json (instrumentationKey + collector_url)
  // and there is no resolver.js beside it → the static fallback is used.
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "", collectorUrl: "", fakeProbe: probePath },
  });
  assert.equal(status, 0);
  assert.ok(fs.existsSync(probePath), "static-key config must POST");
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  assert.equal(probe.headers["x-apikey"], "placeholder");
});

test("dispatcher uses an injected resolver.js to pick iKey/collector", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const ikeyPath = path.join(tmp, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      event_stream_name: "PagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: {
        us: {
          instrumentation_key: "ikeyusresolved",
          collector_url: "https://example.invalid/OneCollector/1.0/",
        },
      },
    })
  );
  // resolver.js beside ikey.json — discovered by convention.
  fs.writeFileSync(
    path.join(tmp, "resolver.js"),
    "module.exports = {" +
      "async resolve({ cfg }) {" +
      "  const e = cfg.regions[cfg.default_region];" +
      "  return { iKey: e.instrumentation_key, collectorUrl: e.collector_url };" +
      "}," +
      "isProvisioned: () => true };"
  );
  const { status } = runDispatcher({
    event: { name: "PagesPluginEvent", data: { eventName: "skill_started", eventType: "Trace", severity: "Info" } },
    env: { configDir: tmp, iKey: "", collectorUrl: "", fakeProbe: probePath, ikeyJsonPath: ikeyPath },
  });
  assert.equal(status, 0);
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  assert.equal(probe.headers["x-apikey"], "ikeyusresolved");
});

test("dispatcher falls back to the static key when a resolver resolves to nothing", () => {
  // Documented precedence is resolver → static → none. A resolver present but
  // returning null/undefined must NOT suppress a configured static key.
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const ikeyPath = path.join(tmp, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      instrumentationKey: "static-ikey-32-chars-minimum-aaaaaaaaaaaa",
      collector_url: "https://example.invalid/OneCollector/1.0/",
      event_stream_name: "PagesPluginEvent",
      disabled: false,
    })
  );
  // resolver.js that always resolves to nothing (no region matched).
  fs.writeFileSync(
    path.join(tmp, "resolver.js"),
    "module.exports = { async resolve() { return null; }, isProvisioned: () => true };"
  );
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "", collectorUrl: "", fakeProbe: probePath, ikeyJsonPath: ikeyPath },
  });
  assert.equal(status, 0);
  assert.ok(fs.existsSync(probePath), "resolver→null must fall back to the static key and POST");
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  assert.equal(probe.headers["x-apikey"], "static-ikey-32-chars-minimum-aaaaaaaaaaaa");
});

test("dispatcher writes the mirror but does NOT POST when neither resolver nor static key resolves", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const ikeyPath = path.join(tmp, "ikey.json");
  // Region-shaped but unprovisioned: no static instrumentationKey, no resolver.js.
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      event_stream_name: "PagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: { us: { collector_url: "https://x" } },
    })
  );
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "", collectorUrl: "", fakeProbe: probePath, ikeyJsonPath: ikeyPath },
  });
  assert.equal(status, 0);
  assert.ok(!fs.existsSync(probePath), "no key resolved → no POST");
  assert.ok(fs.existsSync(mirrorPath(tmp)), "local mirror still written");
});

test("env opt-out (no config choice) suppresses the POST but still writes the mirror", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      fakeProbe: probePath,
      optOut: "1",
    },
  });
  assert.equal(status, 0);
  assert.ok(!fs.existsSync(probePath), "env opt-out must skip the POST");
  assert.ok(
    fs.existsSync(mirrorPath(tmp)),
    "env opt-out must still write the local mirror"
  );
});

test("env opt-out overrides a persisted 'on' choice (env wins) — no POST", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  fs.writeFileSync(
    path.join(tmp, "config.json"),
    JSON.stringify({ telemetry: { "power-pages": "on" } })
  );
  const { status } = runDispatcher({
    event: fakeEvent,
    env: {
      configDir: tmp,
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      fakeProbe: probePath,
      optOut: "1",
    },
  });
  assert.equal(status, 0);
  assert.ok(
    !fs.existsSync(probePath),
    "env opt-out has highest precedence → must skip the POST even with config 'on'"
  );
  assert.ok(
    fs.existsSync(mirrorPath(tmp)),
    "opt-out suppresses transmission only — the local mirror is still written"
  );
});
