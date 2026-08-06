"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolve, mapToRegion } = require("../lib/telemetry/region/region-resolver");

const REGIONS = {
  internal: { instrumentation_key: "ik-int", collector_url: "https://int/" },
  us:       { instrumentation_key: "ik-us",  collector_url: "https://us/"  },
  eu:       { instrumentation_key: "ik-eu",  collector_url: "https://eu/"  },
  gov:      { instrumentation_key: "ik-gov", collector_url: "https://gov/" },
  high:     { instrumentation_key: "ik-hi",  collector_url: "https://hi/"  },
  dod:      { instrumentation_key: "ik-dod", collector_url: "https://dod/" },
  mooncake: { instrumentation_key: "ik-mc",  collector_url: "https://mc/"  },
};

const noopCache = {
  read: () => null,
  write: () => {},
};

test("mapToRegion: Public + us → us", () => {
  assert.equal(mapToRegion("Public", "us", "us"), "us");
});

test("mapToRegion: Public + eu → eu", () => {
  assert.equal(mapToRegion("Public", "eu", "us"), "eu");
});

test("mapToRegion: Public + in (Asia-Pacific) → us", () => {
  assert.equal(mapToRegion("Public", "in", "us"), "us");
});

test("mapToRegion: Public + uk → eu", () => {
  assert.equal(mapToRegion("Public", "uk", "us"), "eu");
});

test("mapToRegion: Public + unknown geo → default", () => {
  assert.equal(mapToRegion("Public", "mars", "us"), "us");
});

test("mapToRegion: Gov → gov (geo ignored)", () => {
  assert.equal(mapToRegion("Gov", "us", "us"), "gov");
});

test("mapToRegion: UsGov (real PAC GCC token) → gov (geo ignored)", () => {
  assert.equal(mapToRegion("UsGov", "us", "us"), "gov");
});

test("mapToRegion: UsGovHigh → high (geo ignored)", () => {
  assert.equal(mapToRegion("UsGovHigh", "anything", "us"), "high");
});

test("mapToRegion: Dod → dod", () => {
  assert.equal(mapToRegion("Dod", "us", "us"), "dod");
});

test("mapToRegion: China → mooncake", () => {
  assert.equal(mapToRegion("China", "cn", "us"), "mooncake");
});

test("mapToRegion: Tip1 → internal", () => {
  assert.equal(mapToRegion("Tip1", "us", "us"), "internal");
});

test("mapToRegion: empty cloud → treated as Public", () => {
  assert.equal(mapToRegion("", "eu", "us"), "eu");
});

test("resolve: no orgId → default region without calling Artemis or cache", async () => {
  let cacheReadCalled = false;
  let fetchCalled = false;
  const result = await resolve({
    orgId: "",
    cloud: "Public",
    regionsMap: REGIONS,
    defaultRegion: "us",
    _fetchGeo: () => { fetchCalled = true; return Promise.resolve({ geoName: "us", stamp: "Public" }); },
    _cache: { read: () => { cacheReadCalled = true; return null; }, write: () => {} },
  });
  assert.equal(result.region, "us");
  assert.equal(result.iKey, "ik-us");
  assert.equal(result.collectorUrl, "https://us/");
  assert.equal(fetchCalled, false);
  assert.equal(cacheReadCalled, false);
});

test("resolve: cache hit maps the cached region to THIS plugin's iKey (not a cached key)", async () => {
  let fetchCalled = false;
  // Cache holds region only. The iKey must come from regionsMap, never the cache —
  // this is what stops a shared cache from misrouting one plugin's events to
  // another plugin's collector.
  const result = await resolve({
    orgId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    regionsMap: REGIONS,
    defaultRegion: "us",
    _fetchGeo: () => { fetchCalled = true; return Promise.resolve(null); },
    _cache: { read: () => ({ region: "eu" }), write: () => {} },
  });
  assert.equal(result.region, "eu");
  assert.equal(result.iKey, "ik-eu");
  assert.equal(result.collectorUrl, "https://eu/");
  assert.equal(fetchCalled, false);
});

test("resolve: cache hit on a region missing from regionsMap → falls back to default", async () => {
  const partial = { us: REGIONS.us };
  const result = await resolve({
    orgId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    regionsMap: partial,
    defaultRegion: "us",
    _fetchGeo: () => Promise.resolve(null),
    _cache: { read: () => ({ region: "eu" }), write: () => {} },
  });
  assert.equal(result.region, "us"); // default fallback, since partial has no eu
});

test("resolve: cache miss + Artemis success → region-only cache write", async () => {
  let written;
  const result = await resolve({
    orgId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    regionsMap: REGIONS,
    defaultRegion: "us",
    _fetchGeo: () => Promise.resolve({ geoName: "eu", stamp: "Public" }),
    _cache: {
      read: () => null,
      write: (orgId, entry) => { written = { orgId, entry }; },
    },
  });
  assert.equal(result.region, "eu");
  assert.equal(result.iKey, "ik-eu");
  // Only the plugin-independent region is persisted — no iKey/collectorUrl.
  assert.deepEqual(written.entry, { region: "eu" });
});

test("resolve: unrecognized geo (falls back to defaultRegion) is NOT cached", async () => {
  let writeCalled = false;
  const result = await resolve({
    orgId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    regionsMap: REGIONS,
    defaultRegion: "eu",
    _fetchGeo: () => Promise.resolve({ geoName: "mars", stamp: "Public" }),
    _cache: { read: () => null, write: () => { writeCalled = true; } },
  });
  assert.equal(result.region, "eu"); // defaultRegion
  assert.equal(writeCalled, false, "a per-plugin default fallback must not be cached");
});

test("resolve: cache miss + Artemis null → default region, no cache write", async () => {
  let writeCalled = false;
  const result = await resolve({
    orgId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    regionsMap: REGIONS,
    defaultRegion: "us",
    _fetchGeo: () => Promise.resolve(null),
    _cache: {
      read: () => null,
      write: () => { writeCalled = true; },
    },
  });
  assert.equal(result.region, "us");
  assert.equal(result.iKey, "ik-us");
  assert.equal(writeCalled, false);
});

test("resolve: regions map missing the resolved key → falls back to default", async () => {
  const partial = { us: REGIONS.us };
  const result = await resolve({
    orgId: "11111111-1111-1111-1111-111111111111",
    cloud: "Gov",
    regionsMap: partial,
    defaultRegion: "us",
    _fetchGeo: () => Promise.resolve({ geoName: "us", stamp: "Gov" }),
    _cache: noopCache,
  });
  assert.equal(result.region, "us");
});

test("resolve: regions map missing default too → returns null", async () => {
  const result = await resolve({
    orgId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    regionsMap: {},
    defaultRegion: "us",
    _fetchGeo: () => Promise.resolve({ geoName: "us", stamp: "Public" }),
    _cache: noopCache,
  });
  assert.equal(result, null);
});

test("resolve: empty cloud + Artemis returns us → us region", async () => {
  const result = await resolve({
    orgId: "11111111-1111-1111-1111-111111111111",
    cloud: "",
    regionsMap: REGIONS,
    defaultRegion: "us",
    _fetchGeo: () => Promise.resolve({ geoName: "us", stamp: "Public" }),
    _cache: noopCache,
  });
  assert.equal(result.region, "us");
});

test("resolve: Mooncake cloud + ignored geo → mooncake region", async () => {
  const result = await resolve({
    orgId: "11111111-1111-1111-1111-111111111111",
    cloud: "Mooncake",
    regionsMap: REGIONS,
    defaultRegion: "us",
    _fetchGeo: () => Promise.resolve({ geoName: "cn", stamp: "Mooncake" }),
    _cache: noopCache,
  });
  assert.equal(result.region, "mooncake");
  assert.equal(result.iKey, "ik-mc");
});
