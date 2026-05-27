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
      _readAgentInfo: () => ({
        aiAgentName: "Claude Code",
        aiAgentVersion: "2.0.0",
        pacCliVersion: "1.36.0",
      }),
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
  // err.message ("boom") is intentionally NOT emitted — only err.code metadata.
  assert.equal(rec.events[1].data.errorDescription, "");
});

test("populates aiAgentName / aiAgentVersion / pacCliVersion from _readAgentInfo", async () => {
  const rec = recorder();
  await withTelemetry(
    "deploy-site",
    async () => null,
    {
      emitter: rec.emit,
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
      _readAgentInfo: () => ({
        aiAgentName: "Claude Code",
        aiAgentVersion: "2.0.0",
        pacCliVersion: "1.36.0",
      }),
    }
  );
  for (const ev of rec.events) {
    assert.equal(ev.data.aiAgentName, "Claude Code");
    assert.equal(ev.data.aiAgentVersion, "2.0.0");
    assert.equal(ev.data.pacCliVersion, "1.36.0");
  }
});

test("errorDescription captures err.code metadata, NEVER err.message", async () => {
  const rec = recorder();
  // err.message could contain PII (file paths, GUIDs, tokens), so the wrapper
  // only emits err.code — short non-PII metadata like "ENOENT".
  const piiMessage = "Failed to read /Users/secret-name/.ssh/id_rsa";
  await assert.rejects(
    withTelemetry(
      "deploy-site",
      async () => {
        const err = new Error(piiMessage);
        err.code = "ENOENT";
        throw err;
      },
      {
        emitter: rec.emit,
        envelopeName: ENVELOPE,
        pluginName: "power-pages",
        pluginVersion: "1.2.2",
        _readAgentInfo: () => ({}),
      }
    ),
    Error
  );
  assert.equal(rec.events[1].data.errorDescription, "ENOENT");
  // The PII-bearing message must not appear anywhere in the emitted payload.
  const payload = JSON.stringify(rec.events[1]);
  assert.ok(
    !payload.includes("secret-name"),
    "err.message must not be emitted under any field"
  );
});

test("errorDescription is empty string on success", async () => {
  const rec = recorder();
  await withTelemetry(
    "deploy-site",
    async () => null,
    {
      emitter: rec.emit,
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.2",
      _readAgentInfo: () => ({}),
    }
  );
  assert.equal(rec.events[1].data.errorDescription, "");
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
      _readAgentInfo: () => ({
        aiAgentName: "Claude Code",
        aiAgentVersion: "2.0.0",
        pacCliVersion: "1.36.0",
      }),
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
      _readAgentInfo: () => ({
        aiAgentName: "Claude Code",
        aiAgentVersion: "2.0.0",
        pacCliVersion: "1.36.0",
      }),
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
      _readAgentInfo: () => ({
        aiAgentName: "Claude Code",
        aiAgentVersion: "2.0.0",
        pacCliVersion: "1.36.0",
      }),
    }
  );
  assert.ok(Number.isInteger(rec.events[1].data.durationMs));
  assert.ok(rec.events[1].data.durationMs >= 0);
});

test("withTelemetry forwards opts.cloud into spawnOpts of the emitter", async () => {
  let capturedSpawnOpts;
  await withTelemetry(
    "deploy-site",
    async () => "ok",
    {
      emitter: (event, spawnOpts) => { capturedSpawnOpts = spawnOpts; },
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.3",
      cloud: "Public",
      _readAgentInfo: () => ({}),
    }
  );
  assert.equal(capturedSpawnOpts.cloud, "Public");
});

test("withTelemetry forwards empty cloud when not provided", async () => {
  let capturedSpawnOpts;
  await withTelemetry(
    "deploy-site",
    async () => "ok",
    {
      emitter: (event, spawnOpts) => { capturedSpawnOpts = spawnOpts; },
      envelopeName: ENVELOPE,
      pluginName: "power-pages",
      pluginVersion: "1.2.3",
      _readAgentInfo: () => ({}),
    }
  );
  assert.equal(capturedSpawnOpts.cloud, "");
});
