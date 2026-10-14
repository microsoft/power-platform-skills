"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { PLUGIN_NAME, STREAM_NAME, TRACKED_SKILLS, sanitizeData, buildEnvelope } = require("../lib/telemetry/schema");
const os = require("node:os");
const { dispatch, fireAndForget } = require("../lib/telemetry/dispatcher");
const { resolveDestination, CACHE_TTL_MS } = require("../lib/telemetry/routing");
const { setTelemetryChoice, telemetryOptOutEnvVarName } = require("../lib/telemetry/lib/user-config");
const { handle, invocation } = require("../../hooks/run-telemetry");
const { run: control } = require("../telemetry-config");
const { spawnSync } = require("node:child_process");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { appendLocal, pruneOldSessions, ROTATE_BYTES } = require("../lib/telemetry/lib/local-log");

function fixture(context, disabled = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pam-telemetry-test-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { ...require("../lib/telemetry/ikey.json"), disabled };
  const configPath = path.join(directory, "ikey.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { directory, config, configPath, env: { POWER_PLATFORM_SKILLS_CONFIG_DIR: directory } };
}

function sample() {
  return {
    eventName: "skill_started", eventType: "Trace", severity: "Info",
    pluginName: PLUGIN_NAME, pluginVersion: "0.1.0", skillName: "generate-ppmplugin",
    sessionId: "test-session", correlationId: "00000000-0000-4000-8000-000000000001",
    osName: "Mac", osVersion: "24.0.0", nodeVersion: "v20",
  };
}

test("ships enabled with the agreed stream and only ROW/EU endpoints", () => {
  const config = require("../lib/telemetry/ikey.json");
  assert.equal(config.disabled, false);
  assert.equal(STREAM_NAME, "event");
  assert.equal(config.event_stream_name, STREAM_NAME);
  assert.deepEqual(Object.keys(config.regions), ["us", "eu"]);
  assert.equal(config.regions.us.instrumentation_key,
    "5c3a61f48d7c4522912765ae7465ab5c-f9cba087-ed82-4591-93d0-ce7eb8bbfcf5-7021");
  assert.equal(config.regions.us.instrumentation_key, config.regions.eu.instrumentation_key);
  assert.equal(config.regions.us.collector_url, "https://browser.events.data.microsoft.com/OneCollector/1.0/");
  assert.equal(config.regions.eu.collector_url, "https://eu-mobile.events.data.microsoft.com/OneCollector/1.0/");
});

test("PAC wrapper uses absolute native executables without a shell", () => {
  const script = String.raw`
    const assert = require("node:assert/strict");
    const childProcess = require("node:child_process");
    const calls = [];
    childProcess.execFileSync = (...args) => { calls.push(args); return "metadata"; };
    const { pacExec } = require(${JSON.stringify(path.resolve(__dirname, "../../hooks/run-telemetry"))});
    const executable = "C:\\trusted-tools\\pac.exe";
    const dependencies = {
      platform: "win32", env: { PATH: ";.;relative;C:\\trusted-tools", PATHEXT: ".CMD;.BAT" },
      exists: candidate => candidate === executable,
    };
    for (const args of [["auth", "who"], ["--version"]]) {
      assert.equal(pacExec("pac", args, { timeout: 1000 }, dependencies), "metadata");
      const call = calls.at(-1);
      assert.equal(call[0], executable);
      assert.deepEqual(call[1], args);
      assert.equal(call[2].shell, false);
      assert.equal(call[2].windowsHide, true);
      assert.equal(call[2].timeout, 1000);
    }
    assert.throws(() => pacExec("pac", ["auth", "create"], {}, dependencies));
    assert.throws(() => pacExec("cmd.exe", ["--version"], {}, dependencies));
    assert.throws(() => pacExec("pac", ["--version"], {}, {
      ...dependencies, exists: () => false,
    }), { code: "ENOENT" });
    assert.equal(calls.length, 2);
  `;
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 3000 });
  assert.equal(result.status, 0, result.stderr);
});

test("tracks exactly the 12 workflow skills, never the telemetry control", () => {
  const skillsDir = path.resolve(__dirname, "../../skills");
  assert.deepEqual([...TRACKED_SKILLS].sort(), fs.readdirSync(skillsDir).filter(name => name !== "telemetry").sort());
});

test("keeps the reviewed fields and only aadObjectId within eventInfo", () => {
  const data = sanitizeData({
    ...sample(), orgId: "00000000-0000-4000-8000-000000000002",
    tenantId: "00000000-0000-4000-8000-000000000003", aiAgentName: "Copilot CLI",
    aiAgentVersion: "0.0.1", pacCliVersion: "1.40.1", prompt: "private content",
    outcome: "success", durationMs: 10, eventInfo: {
      aadObjectId: "00000000-0000-4000-8000-000000000004",
      framework: "react", prompt: "private content", nested: { secret: "never" },
    },
  });
  assert.deepEqual(Object.keys(data.eventInfo), ["aadObjectId"]);
  assert.equal(Object.keys(data).length, 17);
  assert.ok(!JSON.stringify(data).includes("private"));
  assert.ok(!("outcome" in data));
  const envelope = buildEnvelope(data, "2026-09-27T00:00:00.000Z", "project-test-key");
  assert.equal(envelope.name, STREAM_NAME);
  assert.equal(envelope.iKey, "o:project");
  const dimensions = JSON.parse(envelope.data.customDimensions);
  assert.deepEqual({ eventName: envelope.data.event_Name, ...dimensions }, data);
  assert.deepEqual(dimensions.eventInfo, data.eventInfo);
  assert.equal(typeof data.eventInfo, "object");
});

test("builds the shared event wire shape without changing the local payload", () => {
  const data = { ...sample(), clientType: "PowerAppsNative", prompt: "private content", eventInfo: { prompt: "private content" } };
  const original = JSON.stringify(data);
  const time = "2026-10-08T19:27:21.096Z";
  const { eventName, ...dimensions } = sample();
  assert.deepEqual(buildEnvelope(data, time, "project-test-key"), {
    ver: "4.0", name: "event", time, iKey: "o:project",
    data: {
      clientType: "power-apps-mobile-extension",
      event_Name: eventName, timestamp: time, session_Id: data.sessionId,
      customDimensions: JSON.stringify(dimensions),
    },
  });
  assert.equal(JSON.stringify(data), original);
  assert.equal(buildEnvelope(data, "invalid timestamp", "project-test-key"), null);
  assert.equal(buildEnvelope({ ...data, pluginName: "mobile-app" }, time, "project-test-key"), null);
});

test("omits absent or invalid optional identifiers and metadata", () => {
  const data = sanitizeData({ ...sample(), orgId: "https://private.example", tenantId: "email@example.test",
    eventInfo: [{ aadObjectId: "private" }], aiAgentName: "private host", pacCliVersion: "version with private path" });
  assert.deepEqual(data, sample());
});

test("rejects untracked names, invalid event metadata and unsafe session paths", () => {
  for (const override of [
    { skillName: "telemetry" }, { skillName: "arbitrary customer name" },
    { eventName: "skill_completed" }, { pluginName: "power-pages" },
    { sessionId: "../outside" }, { correlationId: "not-a-uuid" },
    { osVersion: "private host" }, { nodeVersion: "v20.1.0" }, { pluginVersion: "1.customer-name" },
  ]) assert.equal(sanitizeData({ ...sample(), ...override }), null);
});

test("hard-off, missing, malformed and partial config cause no logging, routing or spawn", async context => {
  const fixtureData = fixture(context);
  const unexpected = () => { throw new Error("Unexpected telemetry work"); };
  for (const content of ["{", "null", "[]", "{}", JSON.stringify({ ...fixtureData.config, disabled: true })]) {
    fs.writeFileSync(fixtureData.configPath, content);
    const options = { ...fixtureData, appendLocal: unexpected, post: unexpected, spawn: unexpected };
    assert.equal(await dispatch({ name: STREAM_NAME, data: sample() }, options), "disabled");
    fireAndForget({ name: STREAM_NAME, data: sample() }, options);
  }
  fs.rmSync(fixtureData.configPath);
  assert.equal(await dispatch({ name: STREAM_NAME, data: sample() }, fixtureData), "disabled");
  assert.ok(!fs.existsSync(path.join(fixtureData.directory, "telemetry")));
});

test("user opt-out retains a sanitized mirror with identity but performs no routing or post", async context => {
  const fixtureData = fixture(context);
  setTelemetryChoice(fixtureData.directory, PLUGIN_NAME, "off");
  let networkCalls = 0;
  const data = { ...sample(), orgId: "00000000-0000-4000-8000-000000000002",
    eventInfo: { aadObjectId: "00000000-0000-4000-8000-000000000003", prompt: "private" } };
  const result = await dispatch({ name: STREAM_NAME, data, cloud: "Public" }, {
    ...fixtureData, routing: { fetchGeo: () => { networkCalls++; return "eu"; } },
    post: () => { networkCalls++; return true; },
  });
  assert.equal(result, "opted-out");
  assert.equal(networkCalls, 0);
  const log = path.join(fixtureData.directory, "telemetry", PLUGIN_NAME, "sessions", "test-session", "events.jsonl");
  const record = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.equal(record.data.orgId, data.orgId);
  assert.deepEqual(record.data.eventInfo, { aadObjectId: data.eventInfo.aadObjectId });
  assert.ok(!fs.existsSync(path.join(fixtureData.directory, "telemetry", PLUGIN_NAME, "region-cache")));
});

test("env opt-out overrides saved on; disabled env value does not override saved off", async context => {
  const fixtureData = fixture(context);
  for (const [choice, envValue] of [["on", "1"], ["on", " TRUE "], ["off", "false"]]) {
    setTelemetryChoice(fixtureData.directory, PLUGIN_NAME, choice);
    let posts = 0;
    assert.equal(await dispatch({ name: STREAM_NAME, data: sample() }, {
      ...fixtureData, env: { ...fixtureData.env, [telemetryOptOutEnvVarName(PLUGIN_NAME)]: envValue },
      post: () => { posts++; return true; },
    }), "opted-out");
    assert.equal(posts, 0);
  }
});

test("enabled unauthenticated event defaults to ROW; enabled public org routes to EU", async context => {
  const fixtureData = fixture(context);
  for (const [region, additions, cloud] of [["us", {}, ""], ["eu", { orgId: "00000000-0000-4000-8000-000000000002" }, "Public"]]) {
    let sent;
    assert.equal(await dispatch({ name: STREAM_NAME, data: { ...sample(), ...additions }, cloud }, {
      ...fixtureData, routing: { fetchGeo: async () => "eu" },
      post: async (target, envelope) => { sent = { target, envelope }; return true; },
    }), "accepted");
    assert.equal(sent.target.region, region);
    assert.equal(sent.envelope.name, STREAM_NAME);
    const dimensions = JSON.parse(sent.envelope.data.customDimensions);
    assert.deepEqual({ eventName: sent.envelope.data.event_Name, ...dimensions }, { ...sample(), ...additions });
    assert.equal(sent.envelope.data.session_Id, sample().sessionId);
    assert.equal(sent.envelope.data.timestamp, sent.envelope.time);
  }
});

test("never routes unsupported clouds or unknown authenticated regions to ROW", async context => {
  const { config, directory } = fixture(context);
  const data = { ...sample(), orgId: "00000000-0000-4000-8000-000000000002" };
  for (const cloud of ["Gov", "USGov", "High", "Dod", "Mooncake", "China", "Internal", "future-cloud", ""]) {
    let lookups = 0;
    assert.equal(await resolveDestination(config, data, cloud, directory, { fetchGeo: () => { lookups++; return "us"; } }), null);
    assert.equal(lookups, 0);
  }
  for (const geo of [null, "unrecognized"]) {
    assert.equal(await resolveDestination(config, data, "Public", directory, { fetchGeo: async () => geo }), null);
  }
  assert.equal(await resolveDestination(config, { ...sample(), tenantId: data.orgId }, "", directory), null);
});

test("region cache avoids repeated lookup, expires and refreshes", async context => {
  const { config, directory } = fixture(context);
  const data = { ...sample(), orgId: "00000000-0000-4000-8000-000000000002" };
  let lookups = 0;
  const now = Date.now();
  const fetchGeo = async () => { lookups++; return "eu"; };
  await resolveDestination(config, data, "Public", directory, { fetchGeo, now });
  await resolveDestination(config, data, "Public", directory, { fetchGeo, now: now + 100 });
  assert.equal(lookups, 1);
  await resolveDestination(config, data, "Public", directory, { fetchGeo, now: now + CACHE_TTL_MS + 1 });
  assert.equal(lookups, 2);
});

test("dispatcher rejects malformed events before any mirror or network", async context => {
  const fixtureData = fixture(context);
  let writes = 0;
  for (const input of [null, {}, { name: "PAMAIPluginEvent", data: sample() }, { name: STREAM_NAME, data: { ...sample(), skillName: "telemetry" } }]) {
    assert.equal(await dispatch(input, { ...fixtureData, appendLocal: () => { writes++; } }), "invalid");
  }
  assert.equal(writes, 0);
});

test("telemetry failures stay non-blocking and do not retry or replay", async context => {
  const fixtureData = fixture(context);
  let posts = 0;
  assert.equal(await dispatch({ name: STREAM_NAME, data: sample() }, {
    ...fixtureData, appendLocal: () => { throw new Error("disk unavailable"); },
    post: () => { posts++; throw new Error("offline"); },
  }), "failed");
  assert.equal(posts, 1);
});

test("detached child gets only allowed env and sanitized fields, not secrets", context => {
  const fixtureData = fixture(context);
  let options;
  let serialized;
  fireAndForget({ name: STREAM_NAME, data: { ...sample(), secret: "private" }, cloud: "private" }, {
    ...fixtureData, env: { ...fixtureData.env, AZURE_CLIENT_SECRET: "private", NODE_OPTIONS: "--require malicious", PATH: "/bin" },
    spawn: (executable, args, childOptions) => {
      options = childOptions;
      return { on() {}, unref() {}, stdin: { on() {}, end(value) { serialized = value; } } };
    },
  });
  assert.equal(options.env.AZURE_CLIENT_SECRET, undefined);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  assert.equal(options.cwd, os.tmpdir());
  assert.ok(!serialized.includes("private"));
  assert.equal(JSON.parse(serialized).cloud, "unsupported");
});

test("transmission controls do not claim success when configuration is unwritable", context => {
  const { directory } = fixture(context);
  const notDirectory = path.join(directory, "not-a-directory");
  fs.writeFileSync(notDirectory, "not a directory");
  const result = control("off", { env: { POWER_PLATFORM_SKILLS_CONFIG_DIR: notDirectory } });
  assert.equal(result.code, 1);
  assert.match(result.output, /not writable/);
});

test("recognizes qualified prompt and both host tool-input shapes", () => {
  assert.equal(invocation("prompt", { prompt: `/${PLUGIN_NAME}:generate-native-extension confidential args` }), "generate-native-extension");
  assert.equal(invocation("pretool", { tool_name: "Skill", tool_input: { skill: `${PLUGIN_NAME}:audit-ppmplugin` } }), "audit-ppmplugin");
  assert.equal(invocation("pretool", { toolName: "skill", toolArgs: JSON.stringify({ skill: `${PLUGIN_NAME}:test-native-extension` }) }), "test-native-extension");
  assert.equal(invocation("prompt", { prompt: "/generate-ppmplugin" }), "generate-ppmplugin");
  assert.equal(invocation("prompt", { prompt: "/generate-native-extension", pluginName: PLUGIN_NAME }), "generate-native-extension");
});

test("emits a start for every bare workflow skill across prompt and tool payloads", context => {
  const fixtureData = fixture(context);
  const captured = [];
  const options = { ...fixtureData,
    readAuth: () => null, readAgent: () => ({}), readPacVersion: () => "",
    emit: event => captured.push(event),
  };
  for (const skill of TRACKED_SKILLS) {
    const invocations = [
      ["prompt", { prompt: `/${skill} private arguments` }],
      ["pretool", { tool_name: "Skill", tool_input: { skill } }],
      ["pretool", { toolName: "skill", toolInput: { skill } }],
      ["pretool", { toolName: "skill", toolArgs: JSON.stringify({ skill }) }],
    ];
    for (const [mode, payload] of invocations) {
      const before = captured.length;
      assert.equal(handle(mode, payload, options), true, `${mode}: ${skill}`);
      assert.equal(captured.length, before + 1);
      assert.equal(captured[before].name, STREAM_NAME);
      assert.equal(captured[before].data.eventName, "skill_started");
      assert.equal(captured[before].data.pluginName, PLUGIN_NAME);
      assert.equal(captured[before].data.skillName, skill);
    }
  }
  assert.equal(captured.length, TRACKED_SKILLS.length * 4);
  assert.ok(!JSON.stringify(captured).includes("private arguments"));
});

test("ignores other plugins, prose, telemetry control and untracked names", () => {
  for (const prompt of ["please /generate-ppmplugin", "/telemetry off", `/${PLUGIN_NAME}:telemetry off`,
    "/another-plugin:generate-native-extension", "/power-pages:create-site", "/unrelated"]) {
    assert.equal(invocation("prompt", { prompt }), null);
  }
  assert.equal(invocation("pretool", { tool_name: "Bash", tool_input: { skill: `${PLUGIN_NAME}:generate-ppmplugin` } }), null);
  assert.equal(invocation("pretool", { toolArgs: "invalid json" }), null);
});

test("explicit other-plugin hints skip all telemetry work for every tracked skill", context => {
  const fixtureData = fixture(context);
  let work = 0;
  const unexpected = () => { work++; };
  const options = { ...fixtureData,
    readAuth: unexpected, readAgent: unexpected, readPacVersion: unexpected, emit: unexpected,
  };
  for (const skill of TRACKED_SKILLS) {
    for (const name of [skill, `${PLUGIN_NAME}:${skill}`]) {
      const invocations = [
        ["prompt", { prompt: `/${name}`, pluginName: "another-plugin" }],
        ["pretool", { toolName: "skill", toolArgs: { skill: name, pluginName: "another-plugin" } }],
        ["pretool", { tool_name: "Skill", tool_input: JSON.stringify({ skill: name, plugin_name: "another-plugin" }) }],
        ["pretool", { toolName: "skill", toolInput: { skill: name }, plugin_name: "another-plugin" }],
      ];
      for (const [mode, payload] of invocations) {
        assert.equal(handle(mode, payload, options), false, `${mode}: ${name}`);
      }
    }
  }
  assert.equal(work, 0);
});

test("hook hard-off and untracked invocations skip PAC, agent work and emit", context => {
  const fixtureData = fixture(context);
  const disabledFixture = fixture(context, true);
  let work = 0;
  const options = { readAuth: () => { work++; }, readAgent: () => { work++; }, readPacVersion: () => { work++; }, emit: () => { work++; } };
  assert.equal(handle("prompt", { prompt: "/generate-ppmplugin" }, { ...disabledFixture, ...options }), false);
  assert.equal(handle("prompt", { prompt: "/unrelated" }, { ...fixtureData, ...options }), false);
  assert.equal(work, 0);
});

test("hook emits starts only, groups host session and generates per-event IDs", context => {
  const fixtureData = fixture(context);
  const captured = [];
  const options = { ...fixtureData,
    readAuth: () => ({ orgId: "00000000-0000-4000-8000-000000000002", tenantId: "00000000-0000-4000-8000-000000000003",
      objectId: "00000000-0000-4000-8000-000000000004", cloud: "Public", username: "private" }),
    readAgent: () => ({ aiAgentName: "Copilot CLI", aiAgentVersion: "0.0.1" }), readPacVersion: () => "1.40.1",
    emit: event => captured.push(event),
  };
  for (let count = 0; count < 2; count++) assert.equal(handle("prompt", { prompt: "/generate-ppmplugin private", session_id: "shared-session" }, options), true);
  assert.equal(captured[0].data.sessionId, captured[1].data.sessionId);
  assert.notEqual(captured[0].data.correlationId, captured[1].data.correlationId);
  assert.equal(captured[0].data.eventName, "skill_started");
  assert.equal(captured[0].data.pluginVersion, require("../../.plugin/plugin.json").version);
  assert.equal(captured[0].data.eventInfo.aadObjectId, "00000000-0000-4000-8000-000000000004");
  assert.ok(!JSON.stringify(captured).includes("private"));
});

test("PAC and agent failures still produce a minimal start without sign-in", context => {
  const fixtureData = fixture(context);
  let captured;
  const fail = () => { throw new Error("not installed"); };
  assert.equal(handle("prompt", { prompt: "/audit-ppmplugin" }, {
    ...fixtureData, readAuth: fail, readAgent: fail, readPacVersion: fail, emit: event => { captured = event; },
  }), true);
  assert.equal(captured.data.orgId, undefined);
  assert.equal(captured.data.eventInfo, undefined);
  assert.equal(captured.cloud, "");
});

test("control reports enabled, opted-out and hard-disabled states without changing the release switch", context => {
  const fixtureData = fixture(context);
  fs.writeFileSync(path.join(fixtureData.directory, "config.json"), JSON.stringify({ other: 42, telemetry: { "power-pages": "off" } }));
  assert.match(control("status", { env: fixtureData.env }).output, /transmission: ON \(default\)/);
  const result = control("on", { env: fixtureData.env });
  assert.equal(result.code, 0);
  assert.match(result.output, /transmission: ON/);
  const saved = JSON.parse(fs.readFileSync(path.join(fixtureData.directory, "config.json"), "utf8"));
  assert.equal(saved.telemetry[PLUGIN_NAME], "on");
  assert.equal(saved.telemetry["power-pages"], "off");
  assert.equal(saved.other, 42);
  assert.match(control("off", fixtureData).output, /logging continues/);
  assert.match(control("on", { ...fixtureData, env: { ...fixtureData.env, [telemetryOptOutEnvVarName(PLUGIN_NAME)]: "1" } }).output, /transmission: OFF/);
  const disabledFixture = fixture(context, true);
  const disabledOutput = control("on", disabledFixture).output;
  assert.match(disabledOutput, /HARD-DISABLED/);
  assert.match(disabledOutput, /Transmission choice after the release gate: OFF/);
  assert.doesNotMatch(disabledOutput, /Transmission choice after the release gate: ON/);
  assert.equal(JSON.parse(fs.readFileSync(disabledFixture.configPath, "utf8")).disabled, true);
  assert.ok(!fs.existsSync(path.join(fixtureData.directory, "telemetry")));
});

test("control status is read-only and invalid action defaults to status", context => {
  const fixtureData = fixture(context);
  assert.equal(control("unexpected", fixtureData).code, 0);
  assert.ok(!fs.existsSync(path.join(fixtureData.directory, "config.json")));
});

test("actual shipped hooks and dispatcher ignore untracked or invalid input without side effects", context => {
  const fixtureData = fixture(context);
  for (const [script, args] of [["../../hooks/run-telemetry.js", ["prompt"]], ["../lib/telemetry/dispatcher.js", []]]) {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, script), ...args], {
      input: JSON.stringify({ prompt: "/unrelated", name: "invalid", data: sample() }),
      encoding: "utf8", timeout: 3000, env: { PATH: "", ...fixtureData.env },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  assert.ok(!fs.existsSync(path.join(fixtureData.directory, "telemetry")));
});

test("refuses missing flag, redirected endpoints and unprovisioned keys", async context => {
  const fixtureData = fixture(context);
  for (const mutation of [
    config => { delete config.disabled; },
    config => { config.regions.eu.collector_url = "https://unapproved.example/"; },
    config => { config.regions.us.instrumentation_key = "PLACEHOLDER_REPLACE_BEFORE_SHIPPING"; },
    config => { config.event_stream_name = "PAMAIPluginEvent"; },
  ]) {
    const config = JSON.parse(JSON.stringify(fixtureData.config));
    mutation(config);
    fs.writeFileSync(fixtureData.configPath, JSON.stringify(config));
    assert.equal(await dispatch({ name: STREAM_NAME, data: sample() }, fixtureData), "disabled");
  }
});

test("real request builder uses CS4.0, approved URL and x-apikey without real network", async context => {
  const fixtureData = fixture(context);
  let recorded;
  let requests = 0;
  context.mock.method(https, "request", (url, options, callback) => {
    requests++;
    const request = new EventEmitter();
    request.destroy = () => {};
    request.end = body => {
      recorded = { url, options, body };
      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.resume = () => {};
        callback(response);
        response.emit("end");
      });
    };
    return request;
  });
  const data = { ...sample(), eventInfo: { aadObjectId: "00000000-0000-4000-8000-000000000003" },
    orgId: "00000000-0000-4000-8000-000000000002" };
  assert.equal(await dispatch({ name: STREAM_NAME, data, cloud: "Public" }, { ...fixtureData, routing: { fetchGeo: async () => "eu" } }), "accepted");
  assert.equal(requests, 1);
  assert.equal(recorded.url, fixtureData.config.regions.eu.collector_url);
  assert.equal(recorded.options.headers["x-apikey"], fixtureData.config.regions.eu.instrumentation_key);
  assert.equal(recorded.options.headers["Content-Length"], Buffer.byteLength(recorded.body));
  assert.ok(recorded.body.endsWith("\n"));
  const envelope = JSON.parse(recorded.body);
  assert.equal(envelope.name, STREAM_NAME);
  assert.equal(envelope.ver, "4.0");
  assert.deepEqual({ eventName: envelope.data.event_Name, ...JSON.parse(envelope.data.customDimensions) }, data);
  assert.equal(envelope.data.timestamp, envelope.time);
  assert.equal(envelope.data.session_Id, data.sessionId);
  const log = path.join(fixtureData.directory, "telemetry", PLUGIN_NAME, "sessions", "test-session", "events.jsonl");
  const record = JSON.parse(fs.readFileSync(log, "utf8"));
  assert.equal(envelope.time, record.time);
  assert.deepEqual(record.data, data);
});

test("public region lookup uses only validated org URL and parses geo response", async context => {
  const fixtureData = fixture(context);
  let requested;
  context.mock.method(https, "get", (url, callback) => {
    requested = url;
    const request = new EventEmitter();
    request.destroy = () => {};
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.setEncoding = () => {};
      callback(response);
      response.emit("data", JSON.stringify({ geoName: "eu" }));
      response.emit("end");
    });
    return request;
  });
  const destination = await resolveDestination(fixtureData.config, { ...sample(), orgId: "00000000-0000-4000-8000-000000000002" }, "Public", fixtureData.directory);
  assert.equal(destination.region, "eu");
  assert.equal(new URL(requested).hostname, "000000000000400080000000000000.02.organization.api.powerplatform.com");
});

test("mirror cleanup prunes stale sessions and rollover preserves old contents", context => {
  const { directory } = fixture(context);
  const options = { configDir: directory };
  appendLocal({ data: sample() }, options);
  const sessions = path.join(directory, "telemetry", PLUGIN_NAME, "sessions");
  const old = path.join(sessions, "test-session", "events.jsonl");
  const staleTime = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, staleTime, staleTime);
  appendLocal({ data: { ...sample(), sessionId: "new-session" } }, options);
  assert.ok(!fs.existsSync(old));
  const recent = path.join(sessions, "new-session", "events.jsonl");
  fs.truncateSync(recent, ROTATE_BYTES + 1);
  appendLocal({ data: { ...sample(), sessionId: "new-session" } }, options);
  assert.equal(fs.readdirSync(path.dirname(recent)).filter(name => name.endsWith(".old")).length, 1);
  pruneOldSessions(directory, PLUGIN_NAME);
  assert.ok(fs.existsSync(recent));
});

test("registered hook commands honor hard-disable even with spaces in plugin root", context => {
  const fixtureData = fixture(context);
  const copiedRoot = path.join(fixtureData.directory, "plugin with spaces");
  fs.cpSync(path.resolve(__dirname, "../.."), copiedRoot, { recursive: true });
  fs.writeFileSync(path.join(copiedRoot, "scripts/lib/telemetry/ikey.json"), JSON.stringify({ ...fixtureData.config, disabled: true }));
  const hooks = require("../../hooks/hooks.json").hooks;
  assert.deepEqual(Object.keys(hooks), ["PreToolUse", "UserPromptSubmit"]);
  for (const name of Object.keys(hooks)) {
    const command = hooks[name][0].hooks[0].command;
    for (const rootVariable of ["PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"]) {
      const result = spawnSync(command, {
        shell: true, input: JSON.stringify({ prompt: `/${PLUGIN_NAME}:generate-ppmplugin`, tool_input: { skill: `${PLUGIN_NAME}:generate-ppmplugin` } }),
        env: { PATH: path.dirname(process.execPath), [rootVariable]: copiedRoot, ...fixtureData.env },
        timeout: 3000, encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    }
  }
  assert.ok(!fs.existsSync(path.join(fixtureData.directory, "telemetry")));
});

test("support skill and all relative documentation links are self-contained", () => {
  const root = path.resolve(__dirname, "../..");
  const skill = fs.readFileSync(path.join(root, "skills/telemetry/SKILL.md"), "utf8");
  for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) {
    const target = path.resolve(root, "skills/telemetry", match[1]);
    assert.ok(target.startsWith(root + path.sep));
    assert.ok(fs.existsSync(target), target);
  }
  assert.equal(fs.readFileSync(path.join(root, ".plugin/plugin.json"), "utf8"), fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8"));
});
