"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { EventEmitter } = require("node:events");

const resolver = require("../lib/telemetry/resolver");

const SHIPPED_IKEY = path.join(__dirname, "..", "lib", "telemetry", "ikey.json");
const ORG_ID = "00000000-0000-0000-0000-0000000000aa";

const REGIONS = {
  internal: { instrumentation_key: "ik-int", collector_url: "https://int.invalid/" },
  us:       { instrumentation_key: "ik-us",  collector_url: "https://us.invalid/"  },
  eu:       { instrumentation_key: "ik-eu",  collector_url: "https://eu.invalid/"  },
  gov:      { instrumentation_key: "ik-gov", collector_url: "https://gov.invalid/" },
  high:     { instrumentation_key: "ik-hi",  collector_url: "https://hi.invalid/"  },
  dod:      { instrumentation_key: "ik-dod", collector_url: "https://dod.invalid/" },
  mooncake: { instrumentation_key: "ik-mc",  collector_url: "https://mc.invalid/"  },
};
const CFG = { default_region: "us", regions: REGIONS };

function mkTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "modelapps-resolver-"));
}

// Replace https.request (which artemis-service calls at request time) for the duration of `fn`, so a
// test can both answer the Artemis gateway call and prove whether it was made. Never touches the network.
async function withFakeHttps(geoName, fn) {
  const calls = [];
  const original = https.request;
  https.request = (opts, onResponse) => {
    calls.push(opts.hostname);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.setEncoding = () => {};
      onResponse(res);
      res.emit("data", JSON.stringify({ geoName }));
      res.emit("end");
    };
    return req;
  };
  try {
    return { result: await fn(), calls };
  } finally {
    https.request = original;
  }
}

test("isProvisioned: true when the default region has a real key + collector", () => {
  assert.equal(resolver.isProvisioned(CFG), true);
});

test("isProvisioned: false when the default region is missing, keyless or a placeholder", () => {
  assert.equal(resolver.isProvisioned(null), false);
  assert.equal(resolver.isProvisioned({}), false);
  assert.equal(resolver.isProvisioned({ regions: { us: { collector_url: "https://x/" } } }), false);
  assert.equal(resolver.isProvisioned({ regions: { us: { instrumentation_key: "k" } } }), false);
  assert.equal(
    resolver.isProvisioned({
      regions: { us: { instrumentation_key: "PLACEHOLDER_REPLACE_BEFORE_SHIPPING", collector_url: "https://x/" } },
    }),
    false
  );
});

test("Public cloud without an org (PAC signed out) → default region, no gateway call", async () => {
  const { result, calls } = await withFakeHttps("eu", () =>
    resolver.resolve({ event: { data: {} }, cfg: CFG, cloud: "", configDir: mkTemp() })
  );
  assert.deepEqual(result, { region: "us", iKey: "ik-us", collectorUrl: "https://us.invalid/" });
  assert.deepEqual(calls, []);
});

test("Public cloud with an org → routed by the org's geo (EU data boundary)", async () => {
  const { result, calls } = await withFakeHttps("eu", () =>
    resolver.resolve({ event: { data: { orgId: ORG_ID } }, cfg: CFG, cloud: "Public", configDir: mkTemp() })
  );
  assert.equal(result.iKey, "ik-eu");
  assert.equal(result.collectorUrl, "https://eu.invalid/");
  assert.equal(calls.length, 1, "public routing must consult the Artemis gateway once");
  assert.match(calls[0], /\.organization\.api\.powerplatform\.com$/);
});

for (const [cloud, region] of [
  ["UsGov", "gov"],
  ["UsGovHigh", "high"],
  ["UsGovDod", "dod"],
  ["China", "mooncake"],
  ["Tip1", "internal"],
  ["Tip2", "internal"],
  ["Preprod", "internal"],
]) {
  test(`${cloud} → ${region} from the PAC stamp alone (no Artemis call, no public fallback)`, async () => {
    const { result, calls } = await withFakeHttps("us", () =>
      resolver.resolve({ event: { data: { orgId: ORG_ID } }, cfg: CFG, cloud, configDir: mkTemp() })
    );
    assert.equal(result.region, region);
    assert.equal(result.iKey, REGIONS[region].instrumentation_key);
    assert.deepEqual(calls, []);
  });
}

test("sovereign cloud with no configured entry → null (never the public default)", async () => {
  const cfg = { default_region: "us", regions: { us: REGIONS.us, eu: REGIONS.eu } };
  const r = await resolver.resolve({ event: { data: { orgId: ORG_ID } }, cfg, cloud: "UsGovHigh", configDir: mkTemp() });
  assert.equal(r, null);
});

test("unrecognized cloud stamp → null (fail closed, no gateway call)", async () => {
  const { result, calls } = await withFakeHttps("us", () =>
    resolver.resolve({ event: { data: { orgId: ORG_ID } }, cfg: CFG, cloud: "USNat", configDir: mkTemp() })
  );
  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

// --- The committed config -----------------------------------------------------------------------

// Collector per region, matching the 1DS OneCollector endpoints for each cluster category.
const EXPECTED_COLLECTORS = {
  internal: "https://us-mobile.events.data.microsoft.com/OneCollector/1.0/",
  us: "https://us-mobile.events.data.microsoft.com/OneCollector/1.0/",
  eu: "https://eu-mobile.events.data.microsoft.com/OneCollector/1.0/",
  gov: "https://tb.events.data.microsoft.com/OneCollector/1.0/",
  high: "https://tb.events.data.microsoft.com/OneCollector/1.0/",
  dod: "https://pf.events.data.microsoft.com/OneCollector/1.0/",
  mooncake: "https://collector.azure.cn/OneCollector/1.0/",
};

test("shipped ikey.json is live, region-routed, and has a real key + the right collector per region", () => {
  const cfg = JSON.parse(fs.readFileSync(SHIPPED_IKEY, "utf8"));
  assert.equal(cfg.disabled, false);
  assert.equal(cfg.event_stream_name, "ModelAppsAIPluginEvent");
  assert.equal(cfg.default_region, "us");
  // No top-level static key: the dispatcher's static fallback must have nothing to fall back TO, so a
  // resolver that returns null (sovereign gap, unknown cloud) really does send nothing.
  assert.equal(cfg.instrumentationKey, undefined);
  assert.equal(cfg.collector_url, undefined);
  assert.deepEqual(Object.keys(cfg.regions).sort(), Object.keys(EXPECTED_COLLECTORS).sort());
  for (const [region, entry] of Object.entries(cfg.regions)) {
    // 1DS tenant tokens are "<32 hex tenant id>-<guid>-<4 digits>".
    assert.match(entry.instrumentation_key, /^[0-9a-f]{32}-[0-9a-f-]{36}-\d{4}$/, `${region} key shape`);
    assert.equal(entry.collector_url, EXPECTED_COLLECTORS[region], `${region} collector`);
  }
  // US and EU are the same public tenant; only the data-boundary collector differs.
  assert.equal(cfg.regions.us.instrumentation_key, cfg.regions.eu.instrumentation_key);
  assert.equal(resolver.isProvisioned(cfg), true);
});
