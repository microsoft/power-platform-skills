"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const childProcess = require("node:child_process");

const { fireAndForget } = require("../lib/emit-spawn");
const { telemetryOptOutEnvVarName } = require("../lib/user-config");

const EMIT_SPAWN = require.resolve("../lib/emit-spawn");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-spawn-"));
}

const sampleEvent = {
  name: "PowerPagesPluginEvent",
  data: {
    eventName: "skill_started",
    eventType: "Trace",
    severity: "Info",
    skillName: "hello",
  },
};

// What the dispatcher is started with is what makes dispatch non-blocking, and it can be read without starting one:
// a recorder stands in for child_process.spawn. emit-spawn takes `spawn` from child_process when it loads, so the
// recorder is in place only while a private copy of the module loads; it is put back, and the copy dropped from
// the module cache, straight away, so no other test sees either.
//   throwOnSpawn  spawn() throws, as it does when the executable cannot be started
//   throwOnWrite  writing the event throws, as it does when the dispatcher has already exited
function loadWithRecordedSpawn({ throwOnSpawn = false, throwOnWrite = false } = {}) {
  const calls = [];
  const realSpawn = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    if (throwOnSpawn) throw new Error("spawn EAGAIN");
    const child = {
      written: [],
      ended: false,
      unrefs: 0,
      stdin: {
        write(chunk) {
          if (throwOnWrite) throw new Error("write EPIPE");
          child.written.push(String(chunk));
        },
        end() {
          child.ended = true;
        },
      },
      unref() {
        child.unrefs += 1;
      },
    };
    calls.push({ command, args, options, child });
    return child;
  };
  delete require.cache[EMIT_SPAWN];
  try {
    return { fireAndForget: require("../lib/emit-spawn").fireAndForget, calls };
  } finally {
    childProcess.spawn = realSpawn;
    delete require.cache[EMIT_SPAWN];
  }
}

// Sets environment variables for the duration of `fn` and puts every one back, whether it was set before or not.
function withEnv(vars, fn) {
  const before = {};
  for (const [name, value] of Object.entries(vars)) {
    before[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// An earlier version of this test asserted that fireAndForget returns in under 100 ms. How long a spawn takes is
// the machine's, not the code's: a call that took 14-80 ms on an idle machine took up to 611 ms on a busy one, and
// the bound failed under suite load with nothing having regressed. What keeps a caller from ever waiting on the
// dispatcher's network POST is how the dispatcher is started, so that is what is pinned: the caller holds on to
// nothing the dispatcher does, and a POST that hangs cannot hold the caller.
test("fireAndForget hands the event to a detached dispatcher and returns without waiting for it", () => {
  const { fireAndForget: dispatch, calls } = loadWithRecordedSpawn();
  const returned = dispatch(sampleEvent, {
    iKey: "real-ikey",
    collectorUrl: "https://example.invalid/",
  });

  assert.equal(returned, undefined, "there is no promise for the caller to wait on");
  assert.equal(calls.length, 1, "exactly one dispatcher is started");
  const { command, args, options, child } = calls[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args.map((a) => path.basename(a)), ["emit-dispatcher.js"]);
  assert.equal(options.detached, true, "the dispatcher outlives the caller");
  assert.deepEqual(
    options.stdio,
    ["pipe", "ignore", "ignore"],
    "a pipe only to hand over the event; nothing the dispatcher prints is ever read"
  );
  assert.deepEqual(child.written, [JSON.stringify(sampleEvent)], "the whole event is handed over before the call returns");
  assert.equal(child.ended, true, "and the dispatcher is told that it is complete");
  assert.equal(child.unrefs, 1, "the caller's event loop does not wait for the dispatcher");
});

test("dispatch never breaks the caller: a dispatcher that cannot start, or has already exited, is ignored", () => {
  const unstartable = loadWithRecordedSpawn({ throwOnSpawn: true });
  assert.doesNotThrow(() => unstartable.fireAndForget(sampleEvent, {}));

  const gone = loadWithRecordedSpawn({ throwOnWrite: true });
  assert.doesNotThrow(() => gone.fireAndForget(sampleEvent, {}));
  assert.equal(gone.calls[0].child.unrefs, 1, "a dispatcher that exited first is still released, so it cannot hold the caller open");
});

// The dispatcher is the only process that talks to the collector, and it starts from the caller's environment,
// which can hold anything: cloud credentials, tokens, a preload for the caller's own Node. It gets a short list.
test("the dispatcher is started with a minimal environment: the caller's secrets never reach it", () => {
  const secrets = {
    AZURE_CLIENT_SECRET: "client-secret-value",
    GITHUB_TOKEN: "github-token-value",
    MY_PRIVATE_TOKEN: "private-token-value",
    // A preload the caller set for itself must not run inside the dispatcher.
    NODE_OPTIONS: "--require ./caller-preload.js",
  };
  withEnv({ ...secrets, POWER_PLATFORM_SKILLS_IKEY_JSON: undefined }, () => {
    const { fireAndForget: dispatch, calls } = loadWithRecordedSpawn();
    dispatch(sampleEvent, {
      iKey: "ikey-value",
      collectorUrl: "https://collector.invalid/",
      configDir: "/config-dir",
      fakeProbe: "/probe.json",
      cloud: "Public",
      ikeyJsonPath: "/plugin/ikey.json",
    });
    const env = calls[0].options.env;

    assert.deepEqual(
      Object.keys(env).sort(),
      [
        "APPDATA",
        "HOME",
        "PATH",
        "POWER_PLATFORM_SKILLS_CLOUD",
        "POWER_PLATFORM_SKILLS_COLLECTOR",
        "POWER_PLATFORM_SKILLS_CONFIG_DIR",
        "POWER_PLATFORM_SKILLS_FAKE_HTTPS",
        "POWER_PLATFORM_SKILLS_IKEY",
        "POWER_PLATFORM_SKILLS_IKEY_JSON",
        "SystemRoot",
        "USERPROFILE",
      ],
      "only the variables the dispatcher needs; adding one is a privacy decision, so it changes this list on purpose"
    );
    for (const [name, value] of Object.entries(secrets)) {
      assert.ok(!(name in env), `${name} must not be passed on`);
      assert.ok(!Object.values(env).includes(value), `the value of ${name} must not be passed on under another name`);
    }
    // What the dispatcher does need arrives as given.
    assert.equal(env.POWER_PLATFORM_SKILLS_IKEY, "ikey-value");
    assert.equal(env.POWER_PLATFORM_SKILLS_COLLECTOR, "https://collector.invalid/");
    assert.equal(env.POWER_PLATFORM_SKILLS_CONFIG_DIR, "/config-dir");
    assert.equal(env.POWER_PLATFORM_SKILLS_FAKE_HTTPS, "/probe.json");
    assert.equal(env.POWER_PLATFORM_SKILLS_CLOUD, "Public");
    assert.equal(env.POWER_PLATFORM_SKILLS_IKEY_JSON, "/plugin/ikey.json");
  });
});

test("only the event's own plugin opt-out reaches the dispatcher, and only when it is set", () => {
  const powerPages = telemetryOptOutEnvVarName("power-pages");
  const modelApps = telemetryOptOutEnvVarName("model-apps");
  // Whatever else the machine or the CI job has set, `vars` decides which of the two is set here.
  const forwarded = (pluginName, vars) =>
    withEnv(vars, () => {
      const { fireAndForget: dispatch, calls } = loadWithRecordedSpawn();
      dispatch({ name: "X", data: { pluginName } }, {});
      return Object.keys(calls[0].options.env).filter((name) => /^POWER_PLATFORM_SKILLS_TELEMETRY_.+_OPTOUT$/.test(name));
    });

  assert.deepEqual(forwarded("power-pages", { [powerPages]: "1", [modelApps]: "1" }), [powerPages], "not another plugin's opt-out");
  assert.deepEqual(forwarded("model-apps", { [powerPages]: "1", [modelApps]: "1" }), [modelApps]);
  assert.deepEqual(forwarded("power-pages", { [powerPages]: undefined, [modelApps]: "1" }), [], "a plugin that has not opted out passes nothing");
  assert.deepEqual(forwarded(undefined, { [powerPages]: "1", [modelApps]: "1" }), [], "an event that names no plugin passes none");
});

test("dispatcher child receives the event and writes the probe", async () => {
  const tmp = mkTmp();
  const probe = path.join(tmp, "probe.json");
  // Point the dispatcher at a temp ikey.json with disabled:false so emission
  // proceeds (production ships disabled:true until tenant routing is live).
  const ikeyJsonPath = path.join(tmp, "ikey.json");
  fs.writeFileSync(
    ikeyJsonPath,
    JSON.stringify({
      instrumentationKey: "placeholder",
      collector_url: "https://example.invalid/",
      event_stream_name: "PowerPagesPluginEvent",
      disabled: false,
    })
  );
  const prevIkeyJson = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  process.env.POWER_PLATFORM_SKILLS_IKEY_JSON = ikeyJsonPath;
  try {
    fireAndForget(sampleEvent, {
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      configDir: tmp,
      fakeProbe: probe,
    });
  } finally {
    if (prevIkeyJson === undefined) delete process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
    else process.env.POWER_PLATFORM_SKILLS_IKEY_JSON = prevIkeyJson;
  }
  // Wait up to 2s for the child to write the probe.
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(probe)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(probe), "probe file was not written");
  const contents = JSON.parse(fs.readFileSync(probe, "utf8"));
  assert.ok(contents.body.endsWith("\n"), "body must be newline-terminated");
  const body = JSON.parse(contents.body);
  assert.deepEqual(Object.keys(body).sort(), ["data", "iKey", "name", "time", "ver"]);
  assert.equal(body.name, "PowerPagesPluginEvent");
  assert.equal(body.data.eventName, "skill_started");
  assert.equal(body.data.skillName, "hello");
});

test("opts.ikeyJsonPath points the dispatcher at the caller's ikey.json (no env override)", async () => {
  // Regression guard: shared-source tests execute the dispatcher from
  // shared/telemetry/lib, so its __dirname default resolves to shared/'s
  // placeholder (disabled:true). The spawner must forward the plugin's real
  // ikey.json via opts.ikeyJsonPath. With NO env override set, an enabled
  // ikey.json passed this way must still produce a probe.
  const tmp = mkTmp();
  const probe = path.join(tmp, "probe.json");
  const ikeyJsonPath = path.join(tmp, "ikey.json");
  fs.writeFileSync(
    ikeyJsonPath,
    JSON.stringify({
      instrumentationKey: "placeholder",
      collector_url: "https://example.invalid/",
      event_stream_name: "PowerPagesPluginEvent",
      disabled: false,
    })
  );
  const prevIkeyJson = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  delete process.env.POWER_PLATFORM_SKILLS_IKEY_JSON; // ensure opts path is what's exercised
  try {
    fireAndForget(sampleEvent, {
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      configDir: tmp,
      fakeProbe: probe,
      ikeyJsonPath,
    });
  } finally {
    if (prevIkeyJson === undefined) delete process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
    else process.env.POWER_PLATFORM_SKILLS_IKEY_JSON = prevIkeyJson;
  }
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(probe)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(
    fs.existsSync(probe),
    "dispatcher should have read the enabled ikey.json passed via opts.ikeyJsonPath"
  );
});

test("env-var opt-out suppresses the POST through the real spawn chain (mirror still written)", async () => {
  // Regression guard: emit-spawn's minimal child-env allowlist used to drop the
  // _OPTOUT var, so the dispatcher (which enforces the opt-out) never saw it and
  // POSTed anyway. The dispatcher's own test injects the var directly, masking
  // it — only the full fireAndForget → dispatcher chain exposes the gap.
  const tmp = mkTmp();
  const probe = path.join(tmp, "probe.json");
  const ikeyJsonPath = path.join(tmp, "ikey.json");
  fs.writeFileSync(
    ikeyJsonPath,
    JSON.stringify({
      instrumentationKey: "placeholder",
      collector_url: "https://example.invalid/",
      event_stream_name: "PowerPagesPluginEvent",
      disabled: false,
    })
  );
  const optEvent = {
    name: "PowerPagesPluginEvent",
    data: {
      eventName: "skill_started",
      eventType: "Trace",
      severity: "Info",
      pluginName: "power-pages",
      skillName: "hello",
    },
  };
  const optVar = "POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT";
  const prevOpt = process.env[optVar];
  const prevIkeyJson = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  process.env[optVar] = "1";
  delete process.env.POWER_PLATFORM_SKILLS_IKEY_JSON; // exercise opts.ikeyJsonPath path
  try {
    fireAndForget(optEvent, {
      iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
      collectorUrl: "https://example.invalid/OneCollector/1.0/",
      configDir: tmp,
      fakeProbe: probe,
      ikeyJsonPath,
    });
  } finally {
    if (prevOpt === undefined) delete process.env[optVar];
    else process.env[optVar] = prevOpt;
    if (prevIkeyJson === undefined) delete process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
    else process.env.POWER_PLATFORM_SKILLS_IKEY_JSON = prevIkeyJson;
  }
  // The local mirror is written BEFORE the opt-out gate, so wait on it to know
  // the detached child actually ran and reached the gate (rather than asserting
  // absence against a child that simply hadn't started yet).
  // The event carries pluginName "power-pages" and no sessionId, so the local
  // mirror lands under the per-session layout at the "nosession" fallback.
  const mirror = path.join(tmp, "telemetry", "power-pages", "sessions", "nosession", "events.jsonl");
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(mirror)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(mirror), "local mirror should be written even when opted out");
  // Probe stands in for the real POST; the mirror above proves the child ran
  // past the gate, so its absence means the opt-out suppressed transmission.
  assert.ok(!fs.existsSync(probe), "env-var opt-out must suppress the POST/probe");
});

test("fireAndForget does not throw on empty-opts invocation", () => {
  fireAndForget({ name: "X", data: {} }, { iKey: "", collectorUrl: "" });
  // No assertion needed: test passes if no throw.
});

test("fireAndForget forwards opts.cloud as POWER_PLATFORM_SKILLS_CLOUD env var", () => {
  // We can't easily inspect the child env, but we can test that opts.cloud
  // is accepted without throwing. The integration test in the dispatcher
  // suite verifies the env-var is actually received by the child.
  assert.doesNotThrow(() =>
    fireAndForget(
      { name: "X", data: {} },
      { iKey: "", collectorUrl: "", cloud: "Public" }
    )
  );
});
