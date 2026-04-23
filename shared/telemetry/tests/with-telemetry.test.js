"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { withTelemetry } = require("../lib/with-telemetry");

function recorder() {
  const events = [];
  return {
    events,
    emit: (e) => events.push(e),
  };
}

test("success path emits script_started and script_completed", async () => {
  const rec = recorder();
  const result = await withTelemetry(
    "verify-dataverse-access",
    async () => 42,
    { emitter: rec.emit, pluginName: "power-pages", pluginVersion: "1.2.2" }
  );
  assert.equal(result, 42);
  assert.equal(rec.events.length, 2);
  assert.equal(rec.events[0].name, "script_started");
  assert.equal(rec.events[0].data.script_name, "verify-dataverse-access");
  assert.equal(rec.events[1].name, "script_completed");
  assert.equal(rec.events[1].data.outcome, "success");
  assert.equal(rec.events[1].data.error_class, "");
});

test("failure path emits script_completed with outcome=failure and rethrows", async () => {
  const rec = recorder();
  await assert.rejects(
    withTelemetry(
      "x",
      async () => {
        throw new TypeError("boom");
      },
      { emitter: rec.emit, pluginName: "power-pages", pluginVersion: "1.2.2" }
    ),
    TypeError
  );
  assert.equal(rec.events.length, 2);
  assert.equal(rec.events[1].data.outcome, "failure");
  assert.equal(rec.events[1].data.error_class, "TypeError");
});

test("same correlation_id on started and completed", async () => {
  const rec = recorder();
  await withTelemetry(
    "x",
    async () => null,
    { emitter: rec.emit, pluginName: "power-pages", pluginVersion: "1.2.2" }
  );
  const a = rec.events[0].data.correlation_id;
  const b = rec.events[1].data.correlation_id;
  assert.equal(a, b);
  assert.ok(a.length >= 32);
});

test("emit is called synchronously before asyncFn starts (fire-and-forget)", async () => {
  const rec = recorder();
  let asyncFnSeenEventsAtStart = -1;
  await withTelemetry(
    "x",
    async () => {
      asyncFnSeenEventsAtStart = rec.events.length;
      return null;
    },
    { emitter: rec.emit, pluginName: "power-pages", pluginVersion: "1.2.2" }
  );
  // script_started must have been emitted before asyncFn ran.
  assert.equal(asyncFnSeenEventsAtStart, 1);
});

test("throwing emitter does not break the wrapper", async () => {
  const throwingEmitter = () => {
    throw new Error("emit blew up");
  };
  const result = await withTelemetry(
    "x",
    async () => 99,
    { emitter: throwingEmitter, pluginName: "power-pages", pluginVersion: "1.2.2" }
  );
  assert.equal(result, 99);
});
