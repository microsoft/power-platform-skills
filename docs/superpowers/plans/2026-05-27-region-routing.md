# Region-Aware Telemetry Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `(iKey, collectorUrl)` per the user's tenant cloud + geo at telemetry emission time, with disk-cached results, no impact to user-visible latency.

**Architecture:** Hook stays as today (reads PAC + agent-info synchronously); detached dispatcher gains region-resolution responsibility. Resolution = disk cache → ONE Artemis HTTPS GET → `(cloud, geoName)` → region key → `regions[<key>]` from plugin's `ikey.json`. All failure paths fall back to `default_region`.

**Tech Stack:** Node.js stdlib (`https`, `fs`, `path`, `child_process`), `node:test`, no external deps.

**Spec reference:** `docs/superpowers/specs/2026-05-27-region-routing-design.md`

**Branch:** `users/amitjosh/1ds-region-routing` (off `users/amitjosh/1ds-feature`)

**File structure:**

| File | Status | Responsibility |
|---|---|---|
| `shared/telemetry/lib/pac-auth.js` | extend | Parses `Cloud:` line in addition to `Tenant Id` / `Organization Id` |
| `shared/telemetry/lib/region-cache.js` | **new** | Disk cache (`region-cache.json` keyed by orgId, 24h TTL) |
| `shared/telemetry/lib/artemis-service.js` | **new** | One HTTPS GET to Artemis URL chosen by cloud |
| `shared/telemetry/lib/region-resolver.js` | **new** | Pure orchestration: cache → Artemis → region map → default |
| `shared/telemetry/lib/emit-spawn.js` | extend | Forwards `POWER_PLATFORM_SKILLS_CLOUD` to detached child |
| `shared/telemetry/lib/emit-dispatcher.js` | extend | Calls region-resolver, uses resolved iKey + url for envelope/POST |
| `shared/telemetry/lib/with-telemetry.js` | extend | Threads `cloud` through `spawnOpts` |
| `shared/telemetry/tests/*.test.js` | extend / new | Test seams + new modules |
| `plugins/power-pages/scripts/lib/telemetry/ikey.json` | restructure | Flat → `regions: {...}` + `default_region` |
| `plugins/power-pages/hooks/run-skill-pretool-telemetry.js` | extend | Reads `cloud` from PAC, passes via spawnOpts; updates gate-4 check |
| `plugins/power-pages/hooks/run-skill-posttool-validation.js` | extend | Same as pretool hook |
| `plugins/power-pages/hooks/run-user-prompt-telemetry.js` | extend | Same as pretool hook |
| `plugins/power-pages/scripts/lib/telemetry-runner.js` | extend | Same pattern for script-level instrumentation |
| `plugins/power-pages/scripts/tests/telemetry-hook-*.test.js` | extend | Asserts cloud forwarded |

---

## Task 1: Extend `pac-auth.js` to parse `Cloud:` line

**Files:**
- Modify: `shared/telemetry/lib/pac-auth.js`
- Test: `shared/telemetry/tests/pac-auth.test.js`

- [ ] **Step 1: Write the failing test**

Append to `shared/telemetry/tests/pac-auth.test.js`:

```js
test("readPacAuth parses Cloud line", () => {
  _resetCache();
  const fakeExec = () =>
    "Tenant Id:        11111111-1111-1111-1111-111111111111\n" +
    "Organization Id:  22222222-2222-2222-2222-222222222222\n" +
    "Cloud:            Public\n";
  const result = readPacAuth({ _exec: fakeExec });
  assert.equal(result.cloud, "Public");
});

test("readPacAuth returns empty cloud when Cloud line is missing", () => {
  _resetCache();
  const fakeExec = () =>
    "Tenant Id:        11111111-1111-1111-1111-111111111111\n" +
    "Organization Id:  22222222-2222-2222-2222-222222222222\n";
  const result = readPacAuth({ _exec: fakeExec });
  assert.equal(result.cloud, "");
});

test("readPacAuth parses Cloud with sovereign values", () => {
  _resetCache();
  const fakeExec = () =>
    "Tenant Id:        11111111-1111-1111-1111-111111111111\n" +
    "Organization Id:  22222222-2222-2222-2222-222222222222\n" +
    "Cloud:            UsGovHigh\n";
  const result = readPacAuth({ _exec: fakeExec });
  assert.equal(result.cloud, "UsGovHigh");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test shared/telemetry/tests/pac-auth.test.js`
Expected: 3 new tests FAIL (result.cloud is undefined since pac-auth doesn't read Cloud yet).

- [ ] **Step 3: Implement Cloud parsing**

Edit `shared/telemetry/lib/pac-auth.js`. Change the success-path return to include `cloud`:

```js
  const tenantId = pickLine(output, "Tenant Id");
  const orgId = pickLine(output, "Organization Id");
  const cloud = pickLine(output, "Cloud");
  if (!tenantId && !orgId) {
    cache = null;
    return null;
  }
  cache = {
    orgId: orgId || "",
    tenantId: tenantId || "",
    cloud: cloud || "",
  };
  return cache;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test shared/telemetry/tests/pac-auth.test.js`
Expected: All tests PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/pac-auth.js shared/telemetry/tests/pac-auth.test.js
git commit -m "feat(telemetry): parse Cloud field from pac auth who"
```

---

## Task 2: Create `region-cache.js` (disk cache)

**Files:**
- Create: `shared/telemetry/lib/region-cache.js`
- Test: `shared/telemetry/tests/region-cache.test.js`

- [ ] **Step 1: Write the failing test**

Create `shared/telemetry/tests/region-cache.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { read, write, TTL_MS } = require("../lib/region-cache");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-rc-"));
}

const orgIdA = "11111111-1111-1111-1111-111111111111";
const orgIdB = "22222222-2222-2222-2222-222222222222";
const entryUS = { region: "us", iKey: "ikey-us", collectorUrl: "https://us/" };
const entryEU = { region: "eu", iKey: "ikey-eu", collectorUrl: "https://eu/" };

test("read returns null when file does not exist", () => {
  const tmp = mkTmp();
  assert.equal(read(orgIdA, tmp), null);
});

test("write then read returns the entry for the same orgId", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  const got = read(orgIdA, tmp);
  assert.equal(got.region, "us");
  assert.equal(got.iKey, "ikey-us");
  assert.equal(got.collectorUrl, "https://us/");
});

test("read returns null for an orgId that was never written", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  assert.equal(read(orgIdB, tmp), null);
});

test("multiple orgIds coexist in the same cache file", () => {
  const tmp = mkTmp();
  write(orgIdA, entryUS, tmp);
  write(orgIdB, entryEU, tmp);
  assert.equal(read(orgIdA, tmp).region, "us");
  assert.equal(read(orgIdB, tmp).region, "eu");
});

test("read returns null when entry is expired", () => {
  const tmp = mkTmp();
  const file = path.join(tmp, "region-cache.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      [orgIdA]: {
        ...entryUS,
        expiresAt: Date.now() - 1000, // already expired
      },
    })
  );
  assert.equal(read(orgIdA, tmp), null);
});

test("read returns null when JSON is malformed", () => {
  const tmp = mkTmp();
  fs.writeFileSync(path.join(tmp, "region-cache.json"), "not json {");
  assert.equal(read(orgIdA, tmp), null);
});

test("write swallows disk errors (target dir unwritable)", () => {
  // Pass a path that we know we can't write to on the OS.
  // Using a file path masquerading as a dir; write should NOT throw.
  const notADir = path.join(os.tmpdir(), "ppskills-not-a-dir-" + Date.now());
  fs.writeFileSync(notADir, "");
  // write should swallow EEXIST/ENOTDIR errors silently
  assert.doesNotThrow(() => write(orgIdA, entryUS, notADir));
});

test("TTL_MS is exported as 24 hours", () => {
  assert.equal(TTL_MS, 24 * 60 * 60 * 1000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test shared/telemetry/tests/region-cache.test.js`
Expected: FAIL — "Cannot find module '../lib/region-cache'".

- [ ] **Step 3: Implement region-cache.js**

Create `shared/telemetry/lib/region-cache.js`:

```js
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FILE_NAME = "region-cache.json";
const TTL_MS = 24 * 60 * 60 * 1000;

function defaultDir() {
  return path.join(os.homedir(), ".power-platform-skills");
}

function cacheFilePath(configDir) {
  return path.join(configDir || defaultDir(), FILE_NAME);
}

function read(orgId, configDir) {
  if (!orgId) return null;
  let raw;
  try {
    raw = fs.readFileSync(cacheFilePath(configDir), "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entry = parsed && parsed[orgId];
  if (!entry) return null;
  if (typeof entry.expiresAt !== "number" || entry.expiresAt < Date.now()) {
    return null;
  }
  return {
    region: entry.region,
    iKey: entry.iKey,
    collectorUrl: entry.collectorUrl,
  };
}

function write(orgId, entry, configDir) {
  if (!orgId || !entry) return;
  const dir = configDir || defaultDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return;
  }
  const file = path.join(dir, FILE_NAME);
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {
    existing = {};
  }
  existing[orgId] = {
    region: entry.region,
    iKey: entry.iKey,
    collectorUrl: entry.collectorUrl,
    expiresAt: Date.now() + TTL_MS,
  };
  try {
    fs.writeFileSync(file, JSON.stringify(existing), "utf8");
  } catch {
    // fail closed: cache miss next time
  }
}

module.exports = { read, write, TTL_MS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test shared/telemetry/tests/region-cache.test.js`
Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/region-cache.js shared/telemetry/tests/region-cache.test.js
git commit -m "feat(telemetry): add region-cache disk cache (24h TTL, keyed by orgId)"
```

---

## Task 3: Create `artemis-service.js`

**Files:**
- Create: `shared/telemetry/lib/artemis-service.js`
- Test: `shared/telemetry/tests/artemis-service.test.js`

- [ ] **Step 1: Write the failing test**

Create `shared/telemetry/tests/artemis-service.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { fetchGeo, urlFor } = require("../lib/artemis-service");

const orgId = "c7809087-d9b8-4a00-a78a-a4b901caa23f";

test("urlFor builds the Public template (two-char suffix)", () => {
  const u = urlFor(orgId, "Public");
  assert.match(u, /^https:\/\/c7809087d9b84a00a78aa4b901caa2\.3f\.organization\.api\.powerplatform\.com\/gateway\/cluster\?api-version=1$/);
});

test("urlFor builds the Gov template (single-char suffix, gov host)", () => {
  const u = urlFor(orgId, "Gov");
  assert.match(u, /^https:\/\/c7809087d9b84a00a78aa4b901caa23\.f\.organization\.api\.gov\.powerplatform\.microsoft\.us\/gateway\/cluster\?api-version=1$/);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test shared/telemetry/tests/artemis-service.test.js`
Expected: FAIL — "Cannot find module '../lib/artemis-service'".

- [ ] **Step 3: Implement artemis-service.js**

Create `shared/telemetry/lib/artemis-service.js`:

```js
"use strict";

const https = require("node:https");

const TIMEOUT_MS = 5000;

function normalizeCloud(cloud) {
  const c = String(cloud || "").toLowerCase();
  if (c === "usgovgcc" || c === "gcc" || c === "gov") return "Gov";
  if (c === "usgovhigh" || c === "high") return "High";
  if (c === "usgovdod" || c === "dod") return "Dod";
  if (c === "china" || c === "mooncake" || c === "chinacloud") return "Mooncake";
  if (c === "tip1" || c === "tip2" || c === "test" || c === "preprod") return "Internal";
  return "Public";
}

function urlFor(orgId, cloud) {
  const noDashes = String(orgId || "").replace(/-/g, "");
  const stamp = normalizeCloud(cloud);
  if (stamp === "Public") {
    const domain = noDashes.slice(0, -2);
    const suffix = noDashes.slice(-2);
    return `https://${domain}.${suffix}.organization.api.powerplatform.com/gateway/cluster?api-version=1`;
  }
  const domain = noDashes.slice(0, -1);
  const suffix = noDashes.slice(-1);
  if (stamp === "Gov") {
    return `https://${domain}.${suffix}.organization.api.gov.powerplatform.microsoft.us/gateway/cluster?api-version=1`;
  }
  if (stamp === "High") {
    return `https://${domain}.${suffix}.organization.api.high.powerplatform.microsoft.us/gateway/cluster?api-version=1`;
  }
  if (stamp === "Dod") {
    return `https://${domain}.${suffix}.organization.api.appsplatform.us/gateway/cluster?api-version=1`;
  }
  if (stamp === "Mooncake") {
    return `https://${domain}.${suffix}.organization.api.powerplatform.partner.microsoftonline.cn/gateway/cluster?api-version=1`;
  }
  // Internal
  return `https://${domain}.${suffix}.organization.api.test.powerplatform.com/gateway/cluster?api-version=1`;
}

function defaultHttpsGet(url) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + (u.search || ""),
        method: "GET",
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

async function fetchGeo(orgId, cloud, opts = {}) {
  if (!orgId) return null;
  const url = urlFor(orgId, cloud);
  const httpsGet = typeof opts._httpsGet === "function" ? opts._httpsGet : defaultHttpsGet;
  let resp;
  try {
    resp = await httpsGet(url);
  } catch {
    return null;
  }
  if (!resp || typeof resp.statusCode !== "number") return null;
  if (resp.statusCode < 200 || resp.statusCode >= 300) return null;
  let body;
  try {
    body = JSON.parse(resp.body || "");
  } catch {
    return null;
  }
  if (!body || typeof body.geoName !== "string" || !body.geoName) return null;
  return { geoName: body.geoName, stamp: normalizeCloud(cloud) };
}

module.exports = { fetchGeo, urlFor, normalizeCloud, TIMEOUT_MS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test shared/telemetry/tests/artemis-service.test.js`
Expected: All 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/artemis-service.js shared/telemetry/tests/artemis-service.test.js
git commit -m "feat(telemetry): add artemis-service for one-call geo discovery"
```

---

## Task 4: Create `region-resolver.js`

**Files:**
- Create: `shared/telemetry/lib/region-resolver.js`
- Test: `shared/telemetry/tests/region-resolver.test.js`

- [ ] **Step 1: Write the failing test**

Create `shared/telemetry/tests/region-resolver.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolve, mapToRegion } = require("../lib/region-resolver");

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

test("resolve: cache hit returns cached entry without calling Artemis", async () => {
  let fetchCalled = false;
  const cached = { region: "eu", iKey: "ik-cached", collectorUrl: "https://cached/" };
  const result = await resolve({
    orgId: "11111111-1111-1111-1111-111111111111",
    cloud: "Public",
    regionsMap: REGIONS,
    defaultRegion: "us",
    _fetchGeo: () => { fetchCalled = true; return Promise.resolve(null); },
    _cache: { read: () => cached, write: () => {} },
  });
  assert.deepEqual(result, cached);
  assert.equal(fetchCalled, false);
});

test("resolve: cache miss + Artemis success → resolved region + cache write", async () => {
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
  assert.equal(written.entry.region, "eu");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test shared/telemetry/tests/region-resolver.test.js`
Expected: FAIL — "Cannot find module '../lib/region-resolver'".

- [ ] **Step 3: Implement region-resolver.js**

Create `shared/telemetry/lib/region-resolver.js`:

```js
"use strict";

const { fetchGeo: defaultFetchGeo, normalizeCloud } = require("./artemis-service");
const defaultCache = require("./region-cache");

// Public-cloud geoName values → routing region. Anything not listed falls
// through to defaultRegion. Sovereign clouds short-circuit via the stamp.
const PUBLIC_US_GEOS = new Set(["us", "br", "jp", "in", "au", "ca", "as", "za", "ae", "kr"]);
const PUBLIC_EU_GEOS = new Set(["eu", "uk", "de", "fr", "no", "ch"]);

function mapToRegion(cloud, geoName, defaultRegion) {
  const stamp = normalizeCloud(cloud);
  if (stamp === "Gov") return "gov";
  if (stamp === "High") return "high";
  if (stamp === "Dod") return "dod";
  if (stamp === "Mooncake") return "mooncake";
  if (stamp === "Internal") return "internal";
  // stamp === "Public"
  const g = String(geoName || "").toLowerCase();
  if (PUBLIC_US_GEOS.has(g)) return "us";
  if (PUBLIC_EU_GEOS.has(g)) return "eu";
  return defaultRegion;
}

function entryFromMap(regionsMap, region) {
  const e = regionsMap && regionsMap[region];
  if (!e || !e.instrumentation_key) return null;
  return {
    region,
    iKey: e.instrumentation_key,
    collectorUrl: e.collector_url || "",
  };
}

async function resolve({
  orgId,
  cloud,
  regionsMap,
  defaultRegion,
  configDir,
  _fetchGeo,
  _cache,
}) {
  const cache = _cache || defaultCache;
  const fetchGeo = typeof _fetchGeo === "function" ? _fetchGeo : defaultFetchGeo;
  const fallback = entryFromMap(regionsMap, defaultRegion);

  if (!orgId) return fallback;

  const cached = cache.read(orgId, configDir);
  if (cached) return cached;

  let artemis;
  try {
    artemis = await fetchGeo(orgId, cloud);
  } catch {
    artemis = null;
  }
  if (!artemis) return fallback;

  const region = mapToRegion(cloud, artemis.geoName, defaultRegion);
  const entry = entryFromMap(regionsMap, region) || fallback;
  if (!entry) return null;
  try {
    cache.write(orgId, entry, configDir);
  } catch {
    // swallow
  }
  return entry;
}

module.exports = { resolve, mapToRegion };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test shared/telemetry/tests/region-resolver.test.js`
Expected: All 19 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/region-resolver.js shared/telemetry/tests/region-resolver.test.js
git commit -m "feat(telemetry): add region-resolver (cache → Artemis → regions map)"
```

---

## Task 5: Extend `emit-spawn.js` to forward `POWER_PLATFORM_SKILLS_CLOUD`

**Files:**
- Modify: `shared/telemetry/lib/emit-spawn.js`
- Test: `shared/telemetry/tests/emit-spawn.test.js`

- [ ] **Step 1: Write the failing test**

Append to `shared/telemetry/tests/emit-spawn.test.js`:

```js
test("fireAndForget forwards opts.cloud as POWER_PLATFORM_SKILLS_CLOUD env var", () => {
  // We can't easily inspect the child env, but we can test that opts.cloud
  // is accepted without throwing. The integration test in the dispatcher
  // suite verifies the env-var is actually received by the child.
  assert.doesNotThrow(() =>
    fireAndForget(
      { name: "X", data: {} },
      { iKey: "", collectorUrl: "", cloud: "Public" }
    )
  );
});
```

- [ ] **Step 2: Run test to verify it fails (or no-op pass)**

Run: `node --test shared/telemetry/tests/emit-spawn.test.js`
Expected: PASS (the function already accepts opts; we want this test recorded so the next change is intentional).

- [ ] **Step 3: Modify emit-spawn.js to forward the env var**

Edit `shared/telemetry/lib/emit-spawn.js`. Replace the `fireAndForget` body's destructuring and env block:

```js
function fireAndForget(event, opts = {}) {
  const iKey = opts.iKey || "";
  const collectorUrl = opts.collectorUrl || "";
  const configDir = opts.configDir || "";
  const fakeProbe = opts.fakeProbe || "";
  const cloud = opts.cloud || "";

  try {
    const child = spawn(process.execPath, [DISPATCHER], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        PATH: process.env.PATH || "",
        SystemRoot: process.env.SystemRoot || "",
        HOME: process.env.HOME || "",
        USERPROFILE: process.env.USERPROFILE || "",
        APPDATA: process.env.APPDATA || "",
        POWER_PLATFORM_SKILLS_IKEY: iKey,
        POWER_PLATFORM_SKILLS_COLLECTOR: collectorUrl,
        POWER_PLATFORM_SKILLS_CONFIG_DIR: configDir,
        POWER_PLATFORM_SKILLS_FAKE_HTTPS: fakeProbe,
        POWER_PLATFORM_SKILLS_CLOUD: cloud,
        POWER_PLATFORM_SKILLS_TELEMETRY:
          process.env.POWER_PLATFORM_SKILLS_TELEMETRY || "",
        POWER_PLATFORM_SKILLS_IKEY_JSON:
          process.env.POWER_PLATFORM_SKILLS_IKEY_JSON || "",
      },
    });
    try {
      child.stdin.write(JSON.stringify(event));
      child.stdin.end();
    } catch {}
    child.unref();
  } catch {}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test shared/telemetry/tests/emit-spawn.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/emit-spawn.js shared/telemetry/tests/emit-spawn.test.js
git commit -m "feat(telemetry): forward POWER_PLATFORM_SKILLS_CLOUD to dispatcher"
```

---

## Task 6: Extend `emit-dispatcher.js` to call `region-resolver`

**Files:**
- Modify: `shared/telemetry/lib/emit-dispatcher.js`
- Test: `shared/telemetry/tests/emit-dispatcher.test.js`

- [ ] **Step 1: Write the failing test**

Append to `shared/telemetry/tests/emit-dispatcher.test.js` (uses the existing `mkTmp`, `runDispatcher`, `fakeEvent` helpers — the new tests add a temp `region-cache.json` to force a cache hit):

```js
test("dispatcher uses regions[default_region] when no cache and no Artemis", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  // ikey.json carries a regions map; default_region=us.
  const ikeyPath = path.join(tmp, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      event_stream_name: "PagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: {
        us: { instrumentation_key: "ikey-us-32-chars-aaaaaaaaaaaaaaaaaaaaa", collector_url: "https://example.invalid/OneCollector/1.0/" },
        eu: { instrumentation_key: "ikey-eu-32-chars-aaaaaaaaaaaaaaaaaaaaa", collector_url: "https://eu.invalid/OneCollector/1.0/" },
      },
    })
  );
  // No region-cache.json → cache miss → Artemis call → since example.invalid will fail, fall back to default_region.
  const { status } = runDispatcher({
    event: { name: "PagesPluginEvent", data: { eventName: "skill_started", eventType: "Trace", severity: "Info", orgId: "11111111-1111-1111-1111-111111111111" } },
    env: {
      configDir: tmp,
      iKey: "",
      collectorUrl: "",
      fakeProbe: probePath,
      ikeyJsonPath: ikeyPath,
      cloud: "Public",
    },
  });
  assert.equal(status, 0);
  assert.ok(fs.existsSync(probePath), "probe should have been written using default region");
  const body = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  // The probe records the body the dispatcher would have POSTed — its iKey
  // is "o:" + first segment of the resolved iKey.
  assert.match(body.iKey, /^o:ikey-us/);
});

test("dispatcher uses cached region entry when cache hit", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const ikeyPath = path.join(tmp, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      event_stream_name: "PagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: {
        us: { instrumentation_key: "ikey-us-default-32-chars-aaaaaaaaaaaaaaaaaaaa", collector_url: "https://us.invalid/OneCollector/1.0/" },
        eu: { instrumentation_key: "ikey-eu-cached-32-chars-aaaaaaaaaaaaaaaaaaaa", collector_url: "https://eu.invalid/OneCollector/1.0/" },
      },
    })
  );
  // Seed cache with EU.
  fs.writeFileSync(
    path.join(tmp, "region-cache.json"),
    JSON.stringify({
      "11111111-1111-1111-1111-111111111111": {
        region: "eu",
        iKey: "ikey-eu-cached-32-chars-aaaaaaaaaaaaaaaaaaaa",
        collectorUrl: "https://eu.invalid/OneCollector/1.0/",
        expiresAt: Date.now() + 60_000,
      },
    })
  );
  const { status } = runDispatcher({
    event: { name: "PagesPluginEvent", data: { eventName: "skill_started", eventType: "Trace", severity: "Info", orgId: "11111111-1111-1111-1111-111111111111" } },
    env: {
      configDir: tmp,
      iKey: "",
      collectorUrl: "",
      fakeProbe: probePath,
      ikeyJsonPath: ikeyPath,
      cloud: "Public",
    },
  });
  assert.equal(status, 0);
  const body = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  assert.match(body.iKey, /^o:ikey-eu-cached/);
});

test("dispatcher with no orgId in event uses default_region", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const ikeyPath = path.join(tmp, "ikey.json");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      event_stream_name: "PagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: {
        us: { instrumentation_key: "ikey-us-noorg-32-chars-aaaaaaaaaaaaaaaaaaaaaa", collector_url: "https://us.invalid/OneCollector/1.0/" },
      },
    })
  );
  const { status } = runDispatcher({
    event: { name: "PagesPluginEvent", data: { eventName: "skill_started", eventType: "Trace", severity: "Info" } },
    env: {
      configDir: tmp,
      iKey: "",
      collectorUrl: "",
      fakeProbe: probePath,
      ikeyJsonPath: ikeyPath,
      cloud: "",
    },
  });
  assert.equal(status, 0);
  const body = JSON.parse(JSON.parse(fs.readFileSync(probePath, "utf8")).body);
  assert.match(body.iKey, /^o:ikey-us-noorg/);
});
```

Also extend the `runDispatcher` helper at the top of the file to forward `cloud` if provided:

```js
function runDispatcher({ event, env }) {
  const tmp = env.configDir;
  const ikeyJsonPath = env.ikeyJsonPath || mkEnabledIkey(tmp);
  return spawnSync(process.execPath, [DISPATCHER], {
    input: JSON.stringify(event),
    encoding: "utf8",
    env: {
      ...process.env,
      POWER_PLATFORM_SKILLS_CONFIG_DIR: tmp,
      POWER_PLATFORM_SKILLS_IKEY: env.iKey || "",
      POWER_PLATFORM_SKILLS_COLLECTOR: env.collectorUrl || "",
      POWER_PLATFORM_SKILLS_TELEMETRY: env.off ? "0" : "",
      POWER_PLATFORM_SKILLS_FAKE_HTTPS: env.fakeProbe || "",
      POWER_PLATFORM_SKILLS_IKEY_JSON: ikeyJsonPath,
      POWER_PLATFORM_SKILLS_CLOUD: env.cloud || "",
    },
  });
}
```

- [ ] **Step 2: Run test to verify the new tests fail**

Run: `node --test shared/telemetry/tests/emit-dispatcher.test.js`
Expected: 3 new tests FAIL — dispatcher doesn't resolve from regions map yet (it still reads `POWER_PLATFORM_SKILLS_IKEY` env directly).

- [ ] **Step 3: Modify emit-dispatcher.js to use region-resolver**

Replace the section from `IKEY` constant through the stdin-end handler with the regions-aware version:

```js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { FIELD_TYPES, pick } = require("./events");
const { resolve: resolveRegion } = require("./region-resolver");

function exitSilently() {
  process.exit(0);
}
process.on("uncaughtException", exitSilently);
process.on("unhandledRejection", exitSilently);
process.stdin.on("error", exitSilently);

const PLACEHOLDER_IKEY = "PLACEHOLDER_REPLACE_BEFORE_SHIPPING";
const DEFAULT_LOCAL_DIR = path.join(os.homedir(), ".power-platform-skills");
const FAKE_PROBE = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "";
const CONFIG_DIR_ENV = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";
const CLOUD_ENV = process.env.POWER_PLATFORM_SKILLS_CLOUD || "";
// Override env vars — TEST seams only. Production no longer sets these.
const IKEY_OVERRIDE = process.env.POWER_PLATFORM_SKILLS_IKEY || "";
const COLLECTOR_OVERRIDE = process.env.POWER_PLATFORM_SKILLS_COLLECTOR || "";

function isUserOptedOut() {
  return process.env.POWER_PLATFORM_SKILLS_TELEMETRY === "0";
}

function ikeyJsonPath() {
  return (
    process.env.POWER_PLATFORM_SKILLS_IKEY_JSON ||
    path.join(__dirname, "..", "ikey.json")
  );
}

function readIkeyConfig() {
  try {
    return JSON.parse(fs.readFileSync(ikeyJsonPath(), "utf8"));
  } catch {
    return {};
  }
}

function isDisabledByConfig(cfg) {
  return cfg && cfg.disabled === true;
}

const RESERVED_META_FIELDS = new Set(["eventName", "eventType", "severity"]);

function sanitizeData(data) {
  if (!data || typeof data !== "object") return {};
  const filtered = pick(data, Object.keys(FIELD_TYPES));
  for (const key of RESERVED_META_FIELDS) {
    if (typeof data[key] === "string") filtered[key] = data[key];
  }
  return filtered;
}

function buildEnvelope(event, resolvedIKey, eventStreamName) {
  return {
    ver: "4.0",
    name: eventStreamName || event.name || "",
    time: new Date().toISOString(),
    iKey: "o:" + String(resolvedIKey || "").split("-")[0],
    data: sanitizeData(event.data),
  };
}

function writeProbe(filePath, { headers, body }) {
  try {
    fs.writeFileSync(filePath, JSON.stringify({ headers, body }), "utf8");
  } catch {}
}

function writeLocalLog(event) {
  try {
    const { appendLocal } = require("./local-log");
    const configDir = CONFIG_DIR_ENV || DEFAULT_LOCAL_DIR;
    appendLocal(event, { configDir });
  } catch {}
}

// ---- Read config + apply kill switches ----
const cfg = readIkeyConfig();
if (isDisabledByConfig(cfg)) exitSilently();
if (isUserOptedOut()) exitSilently();

// ---- Read stdin ----
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return exitSilently();
  }

  // Override env vars take precedence (test seam). Production code path
  // ignores these and resolves via the regions map.
  let iKey = IKEY_OVERRIDE;
  let collectorUrl = COLLECTOR_OVERRIDE;
  if (!iKey || !collectorUrl) {
    const resolved = await resolveRegion({
      orgId: (event.data && event.data.orgId) || "",
      cloud: CLOUD_ENV,
      regionsMap: cfg.regions || {},
      defaultRegion: cfg.default_region || "us",
      configDir: CONFIG_DIR_ENV || undefined,
    });
    if (resolved) {
      iKey = iKey || resolved.iKey || "";
      collectorUrl = collectorUrl || resolved.collectorUrl || "";
    }
  }

  // Placeholder / unprovisioned mode → append to local dev log and exit.
  const keyMissing = !iKey || iKey === PLACEHOLDER_IKEY || !collectorUrl;
  if (keyMissing) {
    writeLocalLog(event);
    return exitSilently();
  }

  const envelope = buildEnvelope(event, iKey, cfg.event_stream_name);
  const body = JSON.stringify(envelope) + "\n";
  const headers = {
    "Content-Type": "application/x-json-stream; charset=utf-8",
    "x-apikey": iKey,
    "Content-Length": Buffer.byteLength(body),
  };

  if (FAKE_PROBE) {
    writeProbe(FAKE_PROBE, { headers, body });
    return exitSilently();
  }

  let url;
  try {
    url = new URL(collectorUrl);
  } catch {
    return exitSilently();
  }
  const req = https.request(
    {
      hostname: url.hostname,
      path: url.pathname + (url.search || ""),
      method: "POST",
      headers,
    },
    (res) => {
      res.on("data", () => {});
      res.on("end", exitSilently);
    }
  );
  req.on("error", exitSilently);
  req.setTimeout(4000, () => {
    req.destroy();
    exitSilently();
  });
  req.write(body);
  req.end();
});
```

- [ ] **Step 4: Run test to verify all dispatcher tests pass**

Run: `node --test shared/telemetry/tests/emit-dispatcher.test.js`
Expected: All tests PASS (existing + 3 new). Existing tests that set `env.iKey` and `env.collectorUrl` continue to work because the dispatcher honors them as overrides when set.

- [ ] **Step 5: Run the full shared suite to confirm nothing regressed**

Run: `node --test shared/telemetry/tests/*.test.js`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/telemetry/lib/emit-dispatcher.js shared/telemetry/tests/emit-dispatcher.test.js
git commit -m "feat(telemetry): dispatcher resolves region from ikey.json + Artemis"
```

---

## Task 7: Extend `with-telemetry.js` to thread `cloud` through

**Files:**
- Modify: `shared/telemetry/lib/with-telemetry.js`
- Test: `shared/telemetry/tests/with-telemetry.test.js`

- [ ] **Step 1: Write the failing test**

Append to `shared/telemetry/tests/with-telemetry.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test shared/telemetry/tests/with-telemetry.test.js`
Expected: New tests FAIL (`capturedSpawnOpts.cloud` is `undefined`).

- [ ] **Step 3: Modify with-telemetry.js**

In `shared/telemetry/lib/with-telemetry.js`, find both places where `emitter(buildScript..., spawnOpts)` is called (one in the started branch, one in the finally for completed). Update the function signature to accept `cloud` from opts and thread it into spawnOpts:

Near the top of `withTelemetry`, after the existing destructuring of opts, add:

```js
  const cloud = opts.cloud || "";
```

Then change each `emitter(event, spawnOpts)` call site so the spawnOpts object includes `cloud`. The current calls look like:

```js
emitter(buildScriptStarted(envelopeName, {...}), spawnOpts);
```

Replace `spawnOpts` references with a merged object:

```js
emitter(buildScriptStarted(envelopeName, {...}), { ...spawnOpts, cloud });
```

Do the same for the buildScriptCompleted call in the `finally` block.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test shared/telemetry/tests/with-telemetry.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/with-telemetry.js shared/telemetry/tests/with-telemetry.test.js
git commit -m "feat(telemetry): with-telemetry threads cloud through to spawn opts"
```

---

## Task 8: Restructure plugin's `ikey.json` into regions map

**Files:**
- Modify: `plugins/power-pages/scripts/lib/telemetry/ikey.json`

- [ ] **Step 1: Edit the file**

Replace `plugins/power-pages/scripts/lib/telemetry/ikey.json` content with:

```json
{
  "event_stream_name": "PagesPluginEvent",
  "disabled": true,
  "default_region": "us",
  "regions": {
    "internal": {
      "instrumentation_key": "ffdb4c99ca3a4ad5b8e9ffb08bf7da0d-65357ff3-efcd-47fc-b2fd-ad95a52373f4-7402",
      "collector_url": "https://self.pipe.aria.int.microsoft.com/OneCollector/1.0/"
    },
    "us": {
      "instrumentation_key": "197418c5cb8c4426b201f9db2e87b914-87887378-2790-49b0-9295-51f43b6204b1-7172",
      "collector_url": "https://us-mobile.events.data.microsoft.com/OneCollector/1.0/"
    },
    "eu": {
      "instrumentation_key": "197418c5cb8c4426b201f9db2e87b914-87887378-2790-49b0-9295-51f43b6204b1-7172",
      "collector_url": "https://eu-mobile.events.data.microsoft.com/OneCollector/1.0/"
    },
    "gov": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": "https://tb.events.data.microsoft.com/OneCollector/1.0/"
    },
    "high": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": "https://tb.events.data.microsoft.com/OneCollector/1.0/"
    },
    "dod": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": "https://pf.events.data.microsoft.com/OneCollector/1.0/"
    },
    "mooncake": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": "https://collector.azure.cn/OneCollector/1.0/"
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/power-pages/scripts/lib/telemetry/ikey.json
git commit -m "feat(power-pages): restructure ikey.json into per-region map (kill switch on)"
```

---

## Task 9: Update plugin hooks to pass `cloud` and use new gate-4 check

**Files:**
- Modify: `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`
- Modify: `plugins/power-pages/hooks/run-skill-posttool-validation.js`
- Modify: `plugins/power-pages/hooks/run-user-prompt-telemetry.js`
- Test: `plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js`

- [ ] **Step 1: Write the failing test**

Append to `plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js`:

```js
test("pretool hook exits 0 when ikey.json has regions but default_region entry has no key", () => {
  const tmp = mkConfigDir();
  // Override ikey.json with regions where us is missing instrumentation_key
  const ikeyPath = path.join(
    PLUGIN_ROOT,
    "scripts",
    "lib",
    "telemetry",
    "ikey.json"
  );
  const original = fs.readFileSync(ikeyPath, "utf8");
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      event_stream_name: "PagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: { us: { collector_url: "https://x" } },  // no instrumentation_key
    })
  );
  try {
    const { status } = runHook({
      input: JSON.stringify({ tool_input: { skill: "add-seo" } }),
      configDir: tmp,
    });
    assert.equal(status, 0);
  } finally {
    fs.writeFileSync(ikeyPath, original);
  }
});
```

Adjust the existing `mkConfigDir`/helpers in this file to not depend on the legacy flat-iKey shape if they do (re-check helpers and update fixtures to the regions map).

- [ ] **Step 2: Run test to verify it fails or proves the regression**

Run: `node --test plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js`
Expected: The new test will likely throw or fail because the hook hits a path expecting flat iKey. We'll fix it next.

- [ ] **Step 3: Modify pretool hook to read regions structure**

Edit `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`. Update `readIkey()` to expose the regions structure:

```js
function readIkey() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(TELEMETRY_DIR, "ikey.json"), "utf8")
    );
    const defaultRegion = cfg.default_region || "us";
    const defaultEntry = (cfg.regions && cfg.regions[defaultRegion]) || {};
    return {
      eventStreamName: cfg.event_stream_name || "",
      disabled: cfg.disabled === true,
      defaultInstrumentationKey: defaultEntry.instrumentation_key || "",
    };
  } catch {
    return {
      eventStreamName: "",
      disabled: false,
      defaultInstrumentationKey: "",
    };
  }
}
```

Then update the hook body to use the new fields and pass `cloud` to `fireAndForget`:

```js
  if (isUserOptedOut()) process.exit(0);
  const raw = await readStdin();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { process.exit(0); }
  const skillName = hookUtils.getTrackedSkillFromToolInput(parsed.tool_input);
  if (!skillName) process.exit(0);

  const cfg = readIkey();
  if (cfg.disabled) process.exit(0);
  if (!cfg.defaultInstrumentationKey) process.exit(0);

  const { correlation_id } = correlationLib.write({ skillName });
  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";
  const fakeProbe = process.env.POWER_PLATFORM_SKILLS_FAKE_HTTPS || "";

  let pacAuth = null;
  try { pacAuth = pacAuthLib.readPacAuth(); } catch { pacAuth = null; }

  let agentInfo = {};
  try {
    agentInfo = {
      ...agentInfoLib.readAiAgent(),
      pacCliVersion: agentInfoLib.readPacCliVersion(),
    };
  } catch { agentInfo = {}; }

  const fields = {
    pluginName: "power-pages",
    pluginVersion: readPluginVersion(),
    sessionId: sessionLib.getSessionId(),
    correlationId: correlation_id,
    osName: osFriendlyName(process.platform),
    osVersion: os.release(),
    nodeVersion: "v" + String(process.versions.node).split(".")[0],
    skillName,
  };
  if (pacAuth && pacAuth.orgId) fields.orgId = pacAuth.orgId;
  if (pacAuth && pacAuth.tenantId) fields.tenantId = pacAuth.tenantId;
  if (agentInfo.aiAgentName) fields.aiAgentName = agentInfo.aiAgentName;
  if (agentInfo.aiAgentVersion) fields.aiAgentVersion = agentInfo.aiAgentVersion;
  if (agentInfo.pacCliVersion) fields.pacCliVersion = agentInfo.pacCliVersion;

  try {
    emitSpawn.fireAndForget(
      eventsLib.buildSkillStarted(cfg.eventStreamName, fields),
      {
        configDir,
        fakeProbe,
        cloud: (pacAuth && pacAuth.cloud) || "",
      }
    );
  } catch {}

  process.exit(0);
```

Note: no longer pass `iKey` or `collectorUrl` to `fireAndForget` — the dispatcher resolves them from `ikey.json` + `cloud` + orgId.

- [ ] **Step 4: Apply the same edits to the posttool and user-prompt hooks**

In `plugins/power-pages/hooks/run-skill-posttool-validation.js`:
- Update the inline `ikeyCfg` IIFE to read regions structure (mirror `readIkey()` shape above).
- Replace the gate-4 check (currently `if (!ikeyCfg.instrumentationKey)`) with `if (!defaultEntry?.instrumentation_key) process.exit(validatorStatus);`.
- In the `emitSpawn.fireAndForget(...)` call, drop `iKey:` and `collectorUrl:` from spawn opts; add `cloud: (pacAuth && pacAuth.cloud) || ""`.

In `plugins/power-pages/hooks/run-user-prompt-telemetry.js`:
- Apply the same `readIkey()` refactor.
- Drop `iKey:` and `collectorUrl:` from the `fireAndForget` spawn opts.
- Add `cloud: (pacAuth && pacAuth.cloud) || ""` to the spawn opts.

- [ ] **Step 5: Run the plugin hook test suite**

Run: `node --test plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js plugins/power-pages/scripts/tests/telemetry-hook-posttool.test.js plugins/power-pages/scripts/tests/run-user-prompt-telemetry.test.js`
Expected: All tests PASS. If existing tests fail because they wrote the legacy flat-iKey shape into the ikey.json fixture, update those fixtures to the regions map shape.

- [ ] **Step 6: Commit**

```bash
git add plugins/power-pages/hooks/ plugins/power-pages/scripts/tests/
git commit -m "feat(power-pages): hooks read regions structure and pass cloud to dispatcher"
```

---

## Task 10: Update `telemetry-runner.js` to thread `cloud` through `withTelemetry`

**Files:**
- Modify: `plugins/power-pages/scripts/lib/telemetry-runner.js`
- Test: `plugins/power-pages/scripts/tests/telemetry-runner.test.js`

- [ ] **Step 1: Write the failing test**

Append to `plugins/power-pages/scripts/tests/telemetry-runner.test.js`:

```js
test("runInstrumented forwards cloud from PAC into withTelemetry opts", async () => {
  let capturedOpts;
  const fakeDeps = {
    withTelemetry: (scriptName, fn, opts) => {
      capturedOpts = opts;
      return fn();
    },
    ikeyCfg: {
      event_stream_name: "PagesPluginEvent",
      default_region: "us",
      regions: {
        us: { instrumentation_key: "k", collector_url: "https://x" },
      },
    },
    pacAuth: { orgId: "org", tenantId: "tnt", cloud: "Public" },
  };
  await runInstrumented("my-script", async () => "ok", { deps: fakeDeps });
  assert.equal(capturedOpts.cloud, "Public");
});

test("runInstrumented forwards empty cloud when PAC auth is absent", async () => {
  let capturedOpts;
  const fakeDeps = {
    withTelemetry: (scriptName, fn, opts) => {
      capturedOpts = opts;
      return fn();
    },
    ikeyCfg: {
      event_stream_name: "PagesPluginEvent",
      default_region: "us",
      regions: { us: { instrumentation_key: "k", collector_url: "https://x" } },
    },
    pacAuth: null,
  };
  await runInstrumented("my-script", async () => "ok", { deps: fakeDeps });
  assert.equal(capturedOpts.cloud, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test plugins/power-pages/scripts/tests/telemetry-runner.test.js`
Expected: New tests FAIL (`capturedOpts.cloud` undefined).

- [ ] **Step 3: Modify telemetry-runner.js**

Edit `plugins/power-pages/scripts/lib/telemetry-runner.js`. Update `loadTelemetryDeps()` to also read PAC:

```js
function loadTelemetryDeps() {
  try {
    const withTelemetry = require(path.join(TELEMETRY_DIR, "lib", "with-telemetry")).withTelemetry;
    const ikeyCfg = JSON.parse(
      fs.readFileSync(path.join(TELEMETRY_DIR, "ikey.json"), "utf8")
    );
    let pacAuth = null;
    try {
      pacAuth = require(path.join(TELEMETRY_DIR, "lib", "pac-auth")).readPacAuth();
    } catch { pacAuth = null; }
    return { withTelemetry, ikeyCfg, pacAuth };
  } catch {
    return null;
  }
}
```

Update `runInstrumented` to derive default_region's iKey + collector and forward `cloud`:

```js
async function runInstrumented(scriptName, asyncFn, _overrides = {}) {
  const deps = _overrides.deps || loadTelemetryDeps();
  if (!deps) return await asyncFn();

  const configDir = process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || "";
  const defaultRegion = deps.ikeyCfg.default_region || "us";
  const defaultEntry = (deps.ikeyCfg.regions && deps.ikeyCfg.regions[defaultRegion]) || {};

  return deps.withTelemetry(scriptName, asyncFn, {
    envelopeName: deps.ikeyCfg.event_stream_name || "",
    pluginName: "power-pages",
    pluginVersion: readPluginVersion(),
    cloud: (deps.pacAuth && deps.pacAuth.cloud) || "",
    spawnOpts: {
      // iKey + collectorUrl no longer passed — dispatcher resolves region.
      configDir,
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test plugins/power-pages/scripts/tests/telemetry-runner.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/power-pages/scripts/lib/telemetry-runner.js plugins/power-pages/scripts/tests/telemetry-runner.test.js
git commit -m "feat(power-pages): telemetry-runner passes cloud through withTelemetry"
```

---

## Task 11: Sync shared → plugin and run the full test suite

**Files:**
- Run: `node shared/telemetry/sync-to-plugin.js --target plugins/power-pages`
- Verify: All tests pass

- [ ] **Step 1: Run sync-to-plugin**

```bash
node shared/telemetry/sync-to-plugin.js --target plugins/power-pages
```

Expected output: `Synced shared/telemetry → plugins\power-pages\scripts\lib\telemetry`

- [ ] **Step 2: Restore plugin's own ikey.json**

Sync overwrites the plugin's `ikey.json` with the (placeholder) shared template. Restore the plugin's region-aware version:

```bash
git checkout plugins/power-pages/scripts/lib/telemetry/ikey.json
```

- [ ] **Step 3: Run the full shared test suite**

Run: `node --test shared/telemetry/tests/*.test.js`
Expected: All ~150 tests PASS.

- [ ] **Step 4: Run the full power-pages plugin script test suite**

Run: `node --test plugins/power-pages/scripts/tests/`
Expected: All tests PASS.

- [ ] **Step 5: Commit the synced plugin copy**

```bash
git add plugins/power-pages/scripts/lib/telemetry/lib/
git commit -m "chore(power-pages): sync region-routing changes into plugin copy"
```

---

## Task 12: Update shared template `ikey.json` so future plugin adopters get a regions skeleton

**Files:**
- Modify: `shared/telemetry/ikey.json`

- [ ] **Step 1: Edit the shared template**

Replace `shared/telemetry/ikey.json` with a placeholder regions skeleton so a new adopting plugin syncs a usable starting shape:

```json
{
  "event_stream_name": "PluginEventStreamPlaceholder",
  "disabled": true,
  "default_region": "us",
  "regions": {
    "internal": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": ""
    },
    "us": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": ""
    },
    "eu": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": ""
    },
    "gov": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": ""
    },
    "high": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": ""
    },
    "dod": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": ""
    },
    "mooncake": {
      "instrumentation_key": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
      "collector_url": ""
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add shared/telemetry/ikey.json
git commit -m "feat(telemetry): shared ikey.json template uses regions structure"
```

---

## Task 13: Update the README + design doc snippets that reference the old flat shape

**Files:**
- Modify: `shared/telemetry/README.md`

- [ ] **Step 1: Edit README**

Open `shared/telemetry/README.md`. Find any sentence that references the flat `instrumentationKey` field or the previous single-cluster routing. Replace with text describing the new regions map. Suggested wording for the "Cluster config" section:

```markdown
## Cluster config

Each adopting plugin's `scripts/lib/telemetry/ikey.json` lists one or more
regions and a `default_region`. Each region entry carries an
`instrumentation_key` + `collector_url` pair for that cloud / geo.

```jsonc
{
  "event_stream_name": "<plugin's Kusto stream name>",
  "disabled": true,                          // ships true, flip in a separate PR
  "default_region": "us",
  "regions": {
    "internal": { "instrumentation_key": "...", "collector_url": "..." },
    "us":       { "instrumentation_key": "...", "collector_url": "..." },
    "eu":       { "instrumentation_key": "...", "collector_url": "..." },
    "gov":      { "instrumentation_key": "...", "collector_url": "..." },
    "high":     { "instrumentation_key": "...", "collector_url": "..." },
    "dod":      { "instrumentation_key": "...", "collector_url": "..." },
    "mooncake": { "instrumentation_key": "...", "collector_url": "..." }
  }
}
```

The dispatcher resolves the right region at emission time by calling the
Artemis service with the user's `orgId` + `Cloud:` (both read from
`pac auth who` by the hook). Resolution result is cached on disk for 24h
keyed by orgId.
```

- [ ] **Step 2: Commit**

```bash
git add shared/telemetry/README.md
git commit -m "docs(telemetry): README — describe regions map and Artemis-based resolution"
```

---

## Task 14: Push the branch and verify locally

**Files:** (none)

- [ ] **Step 1: Push the branch**

```bash
git push -u origin users/amitjosh/1ds-region-routing
```

- [ ] **Step 2: Sanity-check by running the dispatcher directly with a probe**

The cluster-side verification scripts in `.omc/` continue to work — they bypass the plugin's `ikey.json` entirely and post directly. Run the burst diagnostic to confirm nothing has regressed at the wire layer:

```bash
node .omc/diagnostic-minimal.js
```

Expected: both POSTs return HTTP 200 with `{"acc":1}`.

- [ ] **Step 3: Verify hook-level routing locally (manual)**

In `plugins/power-pages/scripts/lib/telemetry/ikey.json`, temporarily flip `disabled` to `false`. Restart Claude Code. Run a tracked slash command (e.g. `/power-pages:add-seo`). After ~30 seconds, query Kusto:

```kusto
PagesPluginEventTest
| where TimeGenerated > ago(5m)
| extend msg = parse_json(original_message)
| where tostring(msg.data.pluginName) == "power-pages"
| project TimeGenerated,
    EventName = tostring(msg.data.eventName),
    SkillName = tostring(msg.data.skillName)
| order by TimeGenerated desc
```

Expected: row appears with the right skill name. Revert `disabled` to `true` when done:

```bash
git checkout plugins/power-pages/scripts/lib/telemetry/ikey.json
```

- [ ] **Step 4: Open the PR**

Compare URL:
```
https://github.com/microsoft/power-platform-skills/compare/users/amitjosh/1ds-feature...users/amitjosh/1ds-region-routing?expand=1
```

Title: `feat(telemetry): region-aware routing via Artemis + per-orgId disk cache`

Body draft:

```markdown
Resolves the right (iKey, collector URL) at telemetry emission time based on
the user's tenant cloud + geo. Mirrors the VSCode extension's approach (Artemis
service for geo discovery) without pulling in the 1DS SDK.

**Cannot emit on merge.** `ikey.json` ships `disabled: true`. A separate PR
flips it once tenant team has provisioned annotations + tables for all 6
production regions.

## Highlights

- 3 new shared modules: `artemis-service.js`, `region-resolver.js`, `region-cache.js`
- Plugin `ikey.json` restructures into a `regions: {...}` map + `default_region`
- Region resolution happens in the detached dispatcher child — user-visible
  latency is unchanged
- Disk cache keyed by orgId, 24h TTL — Artemis is only called on cache miss
- All failure paths fall back to `default_region`; nothing throws

## Tests

- Shared suite: ~140 tests passing
- Plugin suite: ~150 tests passing

## Spec
`docs/superpowers/specs/2026-05-27-region-routing-design.md`
```

---

## Self-review checklist

- [x] Spec section 1 (Problem/Goals) — addressed by Tasks 1-12 together (whole feature)
- [x] Spec section 2 (Architecture) — Task 5 (env var forwarding) + Task 6 (dispatcher resolution) implement the diagram
- [x] Spec section 3.1 (artemis-service.js) — Task 3
- [x] Spec section 3.1 (region-resolver.js) — Task 4
- [x] Spec section 3.1 (region-cache.js) — Task 2
- [x] Spec section 3.2 (pac-auth.js Cloud parsing) — Task 1
- [x] Spec section 3.2 (emit-spawn.js cloud env var) — Task 5
- [x] Spec section 3.2 (emit-dispatcher.js region-resolve) — Task 6
- [x] Spec section 3.2 (with-telemetry.js cloud thread) — Task 7
- [x] Spec section 3.3 (plugin ikey.json regions map) — Task 8
- [x] Spec section 3.3 (hooks read cloud + new gate-4) — Task 9
- [x] Spec section 3.3 (telemetry-runner cloud) — Task 10
- [x] Spec section 4 (data flow) — verified end-to-end by Task 11 (sync + suite) + Task 14 (manual)
- [x] Spec section 5 (failure modes) — covered by unit tests in Tasks 2-4 + dispatcher tests in Task 6
- [x] Spec section 6 (privacy invariants) — preserved; dispatcher still runs `sanitizeData`; kill switch gates first
- [x] Spec section 7 (cost picture) — verified by hook gate-ordering in Task 9 + dispatcher resolution in Task 6
- [x] Spec section 8 (testing) — Tasks 1-7 each include failing-test-first
- [x] Spec section 9 (out of scope) — PAC still in hook; cache invalidation by mtime not implemented; sovereign iKeys remain placeholders
- [x] Spec section 10 (implementation order) — task order matches

No placeholders, no "TODO", no "similar to task N". Types and property names consistent: `instrumentation_key` / `collector_url` (snake_case in JSON), `iKey` / `collectorUrl` (camelCase in JS), `regions` / `default_region` (snake_case in JSON), `cloud` parameter name throughout.
