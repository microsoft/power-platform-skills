"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { fireAndForget } = require("../lib/emit-spawn");

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

test("fireAndForget returns synchronously (<100 ms)", () => {
  const start = Date.now();
  fireAndForget(sampleEvent, {
    iKey: "real-ikey",
    collectorUrl: "https://example.invalid/",
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `expected <100ms, got ${elapsed}ms`);
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
  // Regression guard: the dispatcher lives in shared/telemetry/lib, so its
  // __dirname default resolves to shared/'s placeholder (disabled:true). When
  // lib/ is shared via symlink or relative require, the spawner must forward
  // the plugin's real ikey.json via opts.ikeyJsonPath. With NO env override
  // set, an enabled ikey.json passed this way must still produce a probe.
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
