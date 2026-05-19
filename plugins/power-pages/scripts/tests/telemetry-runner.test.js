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
