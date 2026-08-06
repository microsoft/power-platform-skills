"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const resolver = require("../lib/telemetry/resolver");

const REGIONS = {
  us: { instrumentation_key: "ikeyus", collector_url: "https://us.invalid/" },
  eu: { instrumentation_key: "ikeyeu", collector_url: "https://eu.invalid/" },
};

test("isProvisioned is true when the default region has a key", () => {
  assert.equal(resolver.isProvisioned({ default_region: "us", regions: REGIONS }), true);
});

test("isProvisioned is false when the default-region key is missing", () => {
  assert.equal(
    resolver.isProvisioned({ default_region: "us", regions: { us: { collector_url: "x" } } }),
    false
  );
  assert.equal(resolver.isProvisioned({}), false);
  assert.equal(resolver.isProvisioned(null), false);
});

test("resolve falls back to the default region with no orgId (no network)", async () => {
  const r = await resolver.resolve({
    event: { data: {} },
    cfg: { default_region: "us", regions: REGIONS },
    cloud: "Public",
    configDir: undefined,
  });
  assert.equal(r.iKey, "ikeyus");
  assert.equal(r.collectorUrl, "https://us.invalid/");
});
