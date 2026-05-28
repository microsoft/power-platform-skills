"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { runInstrumented } = require("../lib/telemetry-runner");

test("runInstrumented awaits the async fn and returns its value", async () => {
  const result = await runInstrumented("dummy-script", async () => 123);
  assert.equal(result, 123);
});

test("runInstrumented rethrows errors from the fn", async () => {
  await assert.rejects(
    runInstrumented("dummy-script", async () => {
      throw new Error("nope");
    }),
    /nope/
  );
});

test("runInstrumented forwards envelopeName from ikey.json event_stream_name", async () => {
  let captured;
  const fakeDeps = {
    withTelemetry: (scriptName, fn, opts) => {
      captured = opts;
      return fn();
    },
    ikeyCfg: {
      instrumentationKey: "key-value",
      collector_url: "https://x",
      event_stream_name: "PowerPagesPluginEvent",
    },
  };
  await runInstrumented("my-script", async () => "ok", { deps: fakeDeps });
  assert.equal(captured.envelopeName, "PowerPagesPluginEvent");
});

test("runInstrumented reads iKey from instrumentationKey property (not legacy 'ikey')", async () => {
  let captured;
  const fakeDeps = {
    withTelemetry: (scriptName, fn, opts) => {
      captured = opts;
      return fn();
    },
    ikeyCfg: {
      instrumentationKey: "the-real-key",
      ikey: "DO-NOT-READ-THIS-LEGACY-FIELD",
      collector_url: "https://x",
      event_stream_name: "PowerPagesPluginEvent",
    },
  };
  await runInstrumented("my-script", async () => "ok", { deps: fakeDeps });
  assert.equal(captured.spawnOpts.iKey, "the-real-key");
});

test("disabled:true short-circuits BEFORE withTelemetry (no PAC, no spawn)", async () => {
  let withTelemetryCalled = false;
  const fakeDeps = {
    withTelemetry: () => {
      withTelemetryCalled = true;
      return null;
    },
    ikeyCfg: {
      instrumentationKey: "key-value",
      collector_url: "https://x",
      event_stream_name: "PowerPagesPluginEvent",
      disabled: true,
    },
  };
  const result = await runInstrumented(
    "my-script",
    async () => "raw-fn-return",
    { deps: fakeDeps }
  );
  assert.equal(result, "raw-fn-return");
  assert.equal(withTelemetryCalled, false);
});

test("POWER_PLATFORM_SKILLS_TELEMETRY=0 short-circuits BEFORE withTelemetry", async () => {
  let withTelemetryCalled = false;
  const fakeDeps = {
    withTelemetry: () => {
      withTelemetryCalled = true;
      return null;
    },
    ikeyCfg: {
      instrumentationKey: "key-value",
      collector_url: "https://x",
      event_stream_name: "PowerPagesPluginEvent",
    },
  };
  const prev = process.env.POWER_PLATFORM_SKILLS_TELEMETRY;
  process.env.POWER_PLATFORM_SKILLS_TELEMETRY = "0";
  let result;
  try {
    result = await runInstrumented(
      "my-script",
      async () => "raw-fn-return",
      { deps: fakeDeps }
    );
  } finally {
    if (prev === undefined) delete process.env.POWER_PLATFORM_SKILLS_TELEMETRY;
    else process.env.POWER_PLATFORM_SKILLS_TELEMETRY = prev;
  }
  assert.equal(result, "raw-fn-return");
  assert.equal(withTelemetryCalled, false);
});

test("missing instrumentationKey short-circuits BEFORE withTelemetry", async () => {
  let withTelemetryCalled = false;
  const fakeDeps = {
    withTelemetry: () => {
      withTelemetryCalled = true;
      return null;
    },
    ikeyCfg: {
      instrumentationKey: "",
      collector_url: "https://x",
      event_stream_name: "PowerPagesPluginEvent",
    },
  };
  const result = await runInstrumented(
    "my-script",
    async () => "raw-fn-return",
    { deps: fakeDeps }
  );
  assert.equal(result, "raw-fn-return");
  assert.equal(withTelemetryCalled, false);
});
