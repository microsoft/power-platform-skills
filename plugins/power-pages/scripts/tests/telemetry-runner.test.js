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
      event_stream_name: "PagesPluginEvent",
      default_region: "us",
      regions: { us: { instrumentation_key: "key-value", collector_url: "https://x" } },
    },
    pacAuth: null,
  };
  await runInstrumented("my-script", async () => "ok", { deps: fakeDeps });
  assert.equal(captured.envelopeName, "PagesPluginEvent");
});

test("runInstrumented no longer leaks iKey/collectorUrl via spawnOpts (dispatcher resolves region)", async () => {
  let captured;
  const fakeDeps = {
    withTelemetry: (scriptName, fn, opts) => {
      captured = opts;
      return fn();
    },
    ikeyCfg: {
      event_stream_name: "PagesPluginEvent",
      default_region: "us",
      regions: { us: { instrumentation_key: "k", collector_url: "https://x" } },
    },
    pacAuth: null,
  };
  await runInstrumented("my-script", async () => "ok", { deps: fakeDeps });
  assert.equal(captured.spawnOpts.iKey, undefined);
  assert.equal(captured.spawnOpts.collectorUrl, undefined);
});

test("runInstrumented forwards cloud from PAC into withTelemetry opts", async () => {
  let capturedOpts;
  const fakeDeps = {
    withTelemetry: (scriptName, fn, opts) => {
      capturedOpts = opts;
      return fn();
    },
    ikeyCfg: {
      event_stream_name: "PagesPluginEvent",
      default_region: "us",
      regions: {
        us: { instrumentation_key: "k", collector_url: "https://x" },
      },
    },
    pacAuth: { orgId: "org", tenantId: "tnt", cloud: "Public" },
  };
  await runInstrumented("my-script", async () => "ok", { deps: fakeDeps });
  assert.equal(capturedOpts.cloud, "Public");
});

test("runInstrumented forwards empty cloud when PAC auth is absent", async () => {
  let capturedOpts;
  const fakeDeps = {
    withTelemetry: (scriptName, fn, opts) => {
      capturedOpts = opts;
      return fn();
    },
    ikeyCfg: {
      event_stream_name: "PagesPluginEvent",
      default_region: "us",
      regions: { us: { instrumentation_key: "k", collector_url: "https://x" } },
    },
    pacAuth: null,
  };
  await runInstrumented("my-script", async () => "ok", { deps: fakeDeps });
  assert.equal(capturedOpts.cloud, "");
});
