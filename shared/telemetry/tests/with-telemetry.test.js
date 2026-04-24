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

function parseInfo(ev) {
  return JSON.parse(ev.data.eventInfo);
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
  assert.equal(rec.events[0].name, "PagesPowerPlatformExtEvent");
  assert.equal(rec.events[0].data.eventName, "script_started");
  assert.equal(parseInfo(rec.events[0]).script_name, "verify-dataverse-access");
  assert.equal(rec.events[1].data.eventName, "script_completed");
  const completedInfo = parseInfo(rec.events[1]);
  assert.equal(completedInfo.outcome, "success");
  assert.equal(completedInfo.error_class, "");
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
  const info = parseInfo(rec.events[1]);
  assert.equal(info.outcome, "failure");
  assert.equal(info.error_class, "TypeError");
});

test("same correlation_id on started and completed", async () => {
  const rec = recorder();
  await withTelemetry(
    "x",
    async () => null,
    { emitter: rec.emit, pluginName: "power-pages", pluginVersion: "1.2.2" }
  );
  const a = parseInfo(rec.events[0]).correlation_id;
  const b = parseInfo(rec.events[1]).correlation_id;
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
