"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { withTelemetry } = require("../lib/with-telemetry");

const ENVELOPE = "PowerPagesPluginEvent";

function recorder() {
  const events = [];
  return {
    events,
    emit: (e) => events.push(e),
  };
}

test("success path emits started + completed with envelope name", async () => {
  const rec = recorder();
  const result = await withTelemetry(
    "deploy-site",
    async () => 42,
    {
      emitter: rec.emit,
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
    }
  );
  assert.equal(result, 42);
  assert.equal(rec.events.length, 2);
  assert.equal(rec.events[0].name, ENVELOPE);
  assert.equal(rec.events[0].data.eventName, "script_started");
  assert.equal(rec.events[0].data.scriptName, "deploy-site");
  assert.equal(rec.events[1].name, ENVELOPE);
  assert.equal(rec.events[1].data.eventName, "script_completed");
  assert.equal(rec.events[1].data.outcome, "success");
  assert.equal(rec.events[1].data.errorClass, "");
});

test("failure path emits completed with outcome=failure and severity=Error", async () => {
  const rec = recorder();
  await assert.rejects(
    withTelemetry(
      "deploy-site",
      async () => {
        throw new TypeError("boom");
      },
      {
        emitter: rec.emit,
        envelopeName: ENVELOPE,
        pluginName: "power-pages",
        pluginVersion: "1.2.2",
      }
    ),
    TypeError
  );
  assert.equal(rec.events.length, 2);
  assert.equal(rec.events[1].data.outcome, "failure");
  assert.equal(rec.events[1].data.errorClass, "TypeError");
  assert.equal(rec.events[1].data.severity, "Error");
});

test("started and completed share the same correlationId", async () => {
  const rec = recorder();
  await withTelemetry(
    "deploy-site",
    async () => null,
    {
      emitter: rec.emit,
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
    }
  );
  assert.equal(rec.events[0].data.correlationId, rec.events[1].data.correlationId);
  assert.ok(rec.events[0].data.correlationId.length >= 32);
});

test("emit is called synchronously before asyncFn starts", async () => {
  const rec = recorder();
  let asyncFnSeenEventsAtStart = -1;
  await withTelemetry(
    "deploy-site",
    async () => {
      asyncFnSeenEventsAtStart = rec.events.length;
      return null;
    },
    {
      emitter: rec.emit,
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
    }
  );
  assert.equal(asyncFnSeenEventsAtStart, 1);
});

test("throwing emitter does not break the wrapper", async () => {
  const result = await withTelemetry(
    "deploy-site",
    async () => 99,
    {
      emitter: () => {
        throw new Error("emit blew up");
      },
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
    }
  );
  assert.equal(result, 99);
});

test("durationMs is non-negative integer on success", async () => {
  const rec = recorder();
  await withTelemetry(
    "deploy-site",
    async () => null,
    {
      emitter: rec.emit,
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
    }
  );
  assert.ok(Number.isInteger(rec.events[1].data.durationMs));
  assert.ok(rec.events[1].data.durationMs >= 0);
});
