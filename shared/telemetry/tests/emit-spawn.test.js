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

function mkConsent(tmp, enabled) {
  fs.writeFileSync(
    path.join(tmp, "telemetry.json"),
    JSON.stringify({
      version: 1,
      enabled,
      recorded_at: new Date().toISOString(),
    })
  );
}

const sampleEvent = {
  name: "VscodeEvent",
  data: {
    eventName: "skill_started",
    eventType: "Trace",
    severity: "Info",
    eventInfo: JSON.stringify({ skill_name: "hello" }),
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
  mkConsent(tmp, true);
  const probe = path.join(tmp, "probe.json");
  fireAndForget(sampleEvent, {
    iKey: "real-ikey-32-chars-minimum-aaaaaaaaaaaaaa",
    collectorUrl: "https://example.invalid/OneCollector/1.0/",
    configDir: tmp,
    fakeProbe: probe,
  });
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
  assert.equal(body.name, "VscodeEvent");
  assert.equal(body.data.eventName, "skill_started");
  assert.equal(JSON.parse(body.data.eventInfo).skill_name, "hello");
});

test("fireAndForget does not throw on empty-opts invocation", () => {
  fireAndForget({ name: "X", data: {} }, { iKey: "", collectorUrl: "" });
  // No assertion needed: test passes if no throw.
});
