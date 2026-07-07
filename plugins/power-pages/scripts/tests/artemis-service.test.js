"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchGeo, urlFor } = require("../lib/telemetry/region/artemis-service");

const orgId = "c7809087-d9b8-4a00-a78a-a4b901caa23f";

test("urlFor builds the Public template (two-char suffix)", () => {
  const u = urlFor(orgId, "Public");
  assert.match(u, /^https:\/\/c7809087d9b84a00a78aa4b901caa2\.3f\.organization\.api\.powerplatform\.com\/gateway\/cluster\?api-version=1$/);
});

test("urlFor builds the Gov template (single-char suffix, gov host)", () => {
  const u = urlFor(orgId, "Gov");
  assert.match(u, /^https:\/\/c7809087d9b84a00a78aa4b901caa23\.f\.organization\.api\.gov\.powerplatform\.microsoft\.us\/gateway\/cluster\?api-version=1$/);
});

test("urlFor builds the Gov template for the real PAC token 'UsGov' (GCC)", () => {
  const u = urlFor(orgId, "UsGov");
  assert.match(u, /api\.gov\.powerplatform\.microsoft\.us/);
  assert.doesNotMatch(u, /api\.powerplatform\.com\b/);
});

test("urlFor builds the High template", () => {
  const u = urlFor(orgId, "High");
  assert.match(u, /api\.high\.powerplatform\.microsoft\.us/);
});

test("urlFor builds the Dod template", () => {
  const u = urlFor(orgId, "Dod");
  assert.match(u, /api\.appsplatform\.us/);
});

test("urlFor builds the Mooncake template", () => {
  const u = urlFor(orgId, "Mooncake");
  assert.match(u, /powerplatform\.partner\.microsoftonline\.cn/);
});

test("urlFor builds the Internal template", () => {
  const u = urlFor(orgId, "Tip1");
  assert.match(u, /api\.test\.powerplatform\.com/);
});

test("urlFor falls back to Public when cloud is unknown or empty", () => {
  const u = urlFor(orgId, "WhoKnows");
  assert.match(u, /api\.powerplatform\.com\b/);
  assert.doesNotMatch(u, /\.gov\.|\.high\.|\.appsplatform\.|\.cn\b|\.test\./);
});

test("fetchGeo returns null when _httpsGet rejects", async () => {
  const result = await fetchGeo(orgId, "Public", {
    _httpsGet: () => Promise.reject(new Error("network down")),
  });
  assert.equal(result, null);
});

test("fetchGeo returns null on non-2xx status", async () => {
  const result = await fetchGeo(orgId, "Public", {
    _httpsGet: () => Promise.resolve({ statusCode: 404, body: "" }),
  });
  assert.equal(result, null);
});

test("fetchGeo returns null on malformed JSON", async () => {
  const result = await fetchGeo(orgId, "Public", {
    _httpsGet: () => Promise.resolve({ statusCode: 200, body: "<<<<<" }),
  });
  assert.equal(result, null);
});

test("fetchGeo returns null when body has no geoName", async () => {
  const result = await fetchGeo(orgId, "Public", {
    _httpsGet: () =>
      Promise.resolve({ statusCode: 200, body: JSON.stringify({ environment: "x" }) }),
  });
  assert.equal(result, null);
});

test("fetchGeo returns { geoName, stamp } on success", async () => {
  const result = await fetchGeo(orgId, "Public", {
    _httpsGet: () =>
      Promise.resolve({
        statusCode: 200,
        body: JSON.stringify({
          geoName: "us",
          environment: "prod",
          clusterNumber: 7,
        }),
      }),
  });
  assert.equal(result.geoName, "us");
  assert.equal(result.stamp, "Public");
});

test("fetchGeo uses the cloud-specific URL", async () => {
  let capturedUrl;
  await fetchGeo(orgId, "Mooncake", {
    _httpsGet: (u) => {
      capturedUrl = u;
      return Promise.resolve({
        statusCode: 200,
        body: JSON.stringify({ geoName: "cn", environment: "prod" }),
      });
    },
  });
  assert.match(capturedUrl, /\.partner\.microsoftonline\.cn/);
});

test("fetchGeo returns null when orgId is falsy (no HTTP call made)", async () => {
  let called = false;
  const fakeGet = () => { called = true; return Promise.resolve({ statusCode: 200, body: "{}" }); };
  assert.equal(await fetchGeo("", "Public", { _httpsGet: fakeGet }), null);
  assert.equal(await fetchGeo(null, "Public", { _httpsGet: fakeGet }), null);
  assert.equal(await fetchGeo(undefined, "Public", { _httpsGet: fakeGet }), null);
  assert.equal(called, false);
});
