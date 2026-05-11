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
