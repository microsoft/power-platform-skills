# Telemetry Resolver Decouple — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move artemis/region routing out of `shared/telemetry/` into the power-pages plugin, behind a generic, convention-discovered resolver contract, so the shared library is routing-agnostic and any plugin can bring its own routing or just use a static key.

**Architecture:** The shared background dispatcher selects the destination iKey/collector by precedence — env override (test seam) → a plugin `resolver.js` discovered by convention next to `ikey.json` → static `instrumentationKey`/`collector_url` in `ikey.json` → none. Power-pages ships a `resolver.js` that adapts its region trio (`region-resolver`/`region-cache`/`artemis-service`, now plugin-local) to the contract `{ resolve(ctx), isProvisioned(cfg) }`. The provisioning fast-gate in the shared `emit-from-prompt` and the plugin pretool hook is expressed through `isProvisioned`, so no shared file reads the region shape.

**Tech Stack:** Node.js (stdlib only), `node:test`. Spec: `docs/superpowers/specs/2026-06-15-telemetry-resolver-decouple-design.md`.

**Conventions (from the repo):**
- Run tests with the glob form: `node --test <dir>/*.test.js` (plain `<dir>/` flakes on local Node 22).
- `plugins/power-pages/scripts/lib/telemetry/lib` is a **symlink** to `shared/telemetry/lib`. The plugin's real files under `scripts/lib/telemetry/` are `ikey.json` and (new) `resolver.js` + `region/`.
- Commit messages end with the repo's `Co-Authored-By` trailer.

---

## File Structure

**New:**
- `shared/telemetry/lib/resolver-loader.js` — convention discovery of a plugin `resolver.js` (generic, ~12 lines).
- `shared/telemetry/tests/resolver-loader.test.js` — its tests.
- `plugins/power-pages/scripts/lib/telemetry/resolver.js` — power-pages adapter (region trio → contract).
- `plugins/power-pages/scripts/tests/resolver.test.js` — adapter tests.

**Moved (shared → plugin, real files):**
- `region-resolver.js`, `region-cache.js`, `artemis-service.js` → `plugins/power-pages/scripts/lib/telemetry/region/`
- `region-resolver.test.js`, `region-cache.test.js`, `artemis-service.test.js` → `plugins/power-pages/scripts/tests/`

**Modified:**
- `shared/telemetry/lib/emit-dispatcher.js` — drop the `region-resolver` require; resolve via loader + static fallback.
- `shared/telemetry/tests/emit-dispatcher.test.js` — replace the 3 region tests with static-key / injected-resolver / no-op tests.
- `shared/telemetry/lib/emit-from-prompt.js` — generic gate via `isProvisioned`.
- `shared/telemetry/tests/emit-from-prompt.test.js` — `mkTelemetryDir` also drops a stub `resolver.js`.
- `plugins/power-pages/hooks/run-skill-pretool-telemetry.js` — generic gate via `isProvisioned`.
- `shared/telemetry/README.md`, `AGENTS.md`, `plugins/power-pages/AGENTS.md` — docs.

**Removed:** the shared region trio + their shared tests (in the same task as the dispatcher flip, so no commit is ever broken).

---

## Task 1: Shared resolver-loader

**Files:**
- Create: `shared/telemetry/lib/resolver-loader.js`
- Test: `shared/telemetry/tests/resolver-loader.test.js`

- [ ] **Step 1: Write the failing test**

Create `shared/telemetry/tests/resolver-loader.test.js`:

```js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadResolver } = require("../lib/resolver-loader");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-rl-"));
}

test("loads a resolver.js sitting next to ikey.json", () => {
  const dir = mkTmp();
  fs.writeFileSync(
    path.join(dir, "resolver.js"),
    "module.exports = { resolve: async () => ({ iKey: 'k', collectorUrl: 'u' }), isProvisioned: () => true };"
  );
  const r = loadResolver(dir);
  assert.equal(typeof r.resolve, "function");
  assert.equal(r.isProvisioned({}), true);
});

test("returns null when no resolver.js is present", () => {
  assert.equal(loadResolver(mkTmp()), null);
});

test("returns null when the module throws on load", () => {
  const dir = mkTmp();
  fs.writeFileSync(path.join(dir, "resolver.js"), "throw new Error('boom');");
  assert.equal(loadResolver(dir), null);
});

test("returns null for a falsy dir", () => {
  assert.equal(loadResolver(""), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test shared/telemetry/tests/resolver-loader.test.js`
Expected: FAIL — `Cannot find module '../lib/resolver-loader'`.

- [ ] **Step 3: Write the implementation**

Create `shared/telemetry/lib/resolver-loader.js`:

```js
"use strict";

const path = require("node:path");

// Discover an optional, plugin-provided resolver module that owns iKey/collector
// selection (region routing, tenant routing, etc.). Convention: a `resolver.js`
// next to the plugin's ikey.json. The shared library never imports a resolver
// directly — it loads whatever the plugin drops here and calls the documented
// contract: { resolve({event, cfg, cloud, configDir}), isProvisioned(cfg) }.
//
// Returns the resolver module, or null when none is present or it fails to load
// (callers then fall back to static config / a generic gate — fail open).
function loadResolver(dir) {
  if (!dir) return null;
  try {
    return require(path.join(dir, "resolver.js"));
  } catch {
    return null;
  }
}

module.exports = { loadResolver };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test shared/telemetry/tests/resolver-loader.test.js`
Expected: PASS — `# pass 4  # fail 0`.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/lib/resolver-loader.js shared/telemetry/tests/resolver-loader.test.js
git commit -m "feat(telemetry): add generic resolver-loader (convention discovery)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Switchover — move region into power-pages, add the resolver adapter, generalize the dispatcher

This is the atomic decoupling step: the region files leave shared and the dispatcher stops requiring them in the **same** commit, so no commit is ever broken.

**Files:**
- Move: `shared/telemetry/lib/{region-resolver,region-cache,artemis-service}.js` → `plugins/power-pages/scripts/lib/telemetry/region/`
- Move: `shared/telemetry/tests/{region-resolver,region-cache,artemis-service}.test.js` → `plugins/power-pages/scripts/tests/`
- Create: `plugins/power-pages/scripts/lib/telemetry/resolver.js`
- Create: `plugins/power-pages/scripts/tests/resolver.test.js`
- Modify: `shared/telemetry/lib/emit-dispatcher.js` (requires + resolution block)
- Modify: `shared/telemetry/tests/emit-dispatcher.test.js` (replace 3 region tests)

- [ ] **Step 1: Move the region lib files (preserve history)**

```bash
mkdir -p plugins/power-pages/scripts/lib/telemetry/region
git mv shared/telemetry/lib/region-resolver.js  plugins/power-pages/scripts/lib/telemetry/region/region-resolver.js
git mv shared/telemetry/lib/region-cache.js      plugins/power-pages/scripts/lib/telemetry/region/region-cache.js
git mv shared/telemetry/lib/artemis-service.js   plugins/power-pages/scripts/lib/telemetry/region/artemis-service.js
```

The three files require each other via `./artemis-service` and `./region-cache` (siblings) — they moved together, so **no internal require changes are needed**.

- [ ] **Step 2: Move the region test files and fix their require paths**

```bash
git mv shared/telemetry/tests/region-resolver.test.js plugins/power-pages/scripts/tests/region-resolver.test.js
git mv shared/telemetry/tests/region-cache.test.js     plugins/power-pages/scripts/tests/region-cache.test.js
git mv shared/telemetry/tests/artemis-service.test.js  plugins/power-pages/scripts/tests/artemis-service.test.js
```

Then edit each moved test's `require` of the module under test (the test dirs differ in depth, so the relative path changes from `../lib/<x>` to `../lib/telemetry/region/<x>`):

- In `plugins/power-pages/scripts/tests/region-resolver.test.js`, change
  `const { resolve, mapToRegion } = require("../lib/region-resolver");` →
  `const { resolve, mapToRegion } = require("../lib/telemetry/region/region-resolver");`
- In `plugins/power-pages/scripts/tests/region-cache.test.js`, change
  `const { read, write, TTL_MS } = require("../lib/region-cache");` →
  `const { read, write, TTL_MS } = require("../lib/telemetry/region/region-cache");`
- In `plugins/power-pages/scripts/tests/artemis-service.test.js`, change
  `const { fetchGeo, urlFor } = require("../lib/artemis-service");` →
  `const { fetchGeo, urlFor } = require("../lib/telemetry/region/artemis-service");`

- [ ] **Step 3: Run the moved region tests to verify they still pass in their new home**

Run: `node --test plugins/power-pages/scripts/tests/region-resolver.test.js plugins/power-pages/scripts/tests/region-cache.test.js plugins/power-pages/scripts/tests/artemis-service.test.js`
Expected: PASS (same counts as before the move; `# fail 0`).

- [ ] **Step 4: Write the resolver adapter test (failing)**

Create `plugins/power-pages/scripts/tests/resolver.test.js`:

```js
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
```

- [ ] **Step 5: Run it to verify it fails**

Run: `node --test plugins/power-pages/scripts/tests/resolver.test.js`
Expected: FAIL — `Cannot find module '../lib/telemetry/resolver'`.

- [ ] **Step 6: Write the resolver adapter**

Create `plugins/power-pages/scripts/lib/telemetry/resolver.js`:

```js
"use strict";

// Power-pages telemetry resolver: region routing via Artemis geo + cloud stamp.
// Implements the shared dispatcher's resolver contract. All artemis/region code
// lives in ./region/ — shared/telemetry knows nothing about it.
const { resolve: resolveRegion } = require("./region/region-resolver");

// Resolve the destination iKey/collector for THIS event's org region.
async function resolve({ event, cfg, cloud, configDir }) {
  return resolveRegion({
    orgId: (event && event.data && event.data.orgId) || "",
    cloud,
    regionsMap: (cfg && cfg.regions) || {},
    defaultRegion: (cfg && cfg.default_region) || "us",
    configDir,
  });
}

// Sync fast-gate: is the default region's key configured? Lets the hooks skip
// the ~3-5s pac shellout when the plugin isn't provisioned yet.
function isProvisioned(cfg) {
  const dr = (cfg && cfg.default_region) || "us";
  const entry = cfg && cfg.regions && cfg.regions[dr];
  return !!(entry && entry.instrumentation_key);
}

module.exports = { resolve, isProvisioned };
```

- [ ] **Step 7: Run the resolver test to verify it passes**

Run: `node --test plugins/power-pages/scripts/tests/resolver.test.js`
Expected: PASS — `# pass 3  # fail 0`.

- [ ] **Step 8: Generalize the dispatcher — swap the require**

In `shared/telemetry/lib/emit-dispatcher.js`, replace this line (near line 9):

```js
const { resolve: resolveRegion } = require("./region-resolver");
```

with:

```js
const { loadResolver } = require("./resolver-loader");
```

- [ ] **Step 9: Generalize the dispatcher — discover the resolver after cfg is read**

In `shared/telemetry/lib/emit-dispatcher.js`, find:

```js
const cfg = readIkeyConfig();
if (isDisabledByConfig(cfg)) exitSilently();
```

and add a third line immediately after:

```js
const cfg = readIkeyConfig();
if (isDisabledByConfig(cfg)) exitSilently();
const resolver = loadResolver(path.dirname(ikeyJsonPath()));
```

- [ ] **Step 10: Generalize the dispatcher — replace the resolution block**

In `shared/telemetry/lib/emit-dispatcher.js`, replace this block:

```js
  // Resolve the iKey + collector for this org's region. Override env vars take
  // precedence (test seam); production resolves via the regions map in cfg.
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
```

with:

```js
  // Resolve the destination iKey + collector. Precedence: env override (test
  // seam) → plugin resolver.js (region/tenant/etc., owned by the plugin) →
  // static single-key config in ikey.json → none. The shared dispatcher knows
  // nothing about regions; the plugin's resolver.js owns that.
  let iKey = IKEY_OVERRIDE;
  let collectorUrl = COLLECTOR_OVERRIDE;
  if (!iKey || !collectorUrl) {
    if (resolver && typeof resolver.resolve === "function") {
      const resolved = await resolver.resolve({
        event,
        cfg,
        cloud: CLOUD_ENV,
        configDir: CONFIG_DIR_ENV || undefined,
      });
      if (resolved) {
        iKey = iKey || resolved.iKey || "";
        collectorUrl = collectorUrl || resolved.collectorUrl || "";
      }
    } else {
      iKey = iKey || cfg.instrumentationKey || "";
      collectorUrl = collectorUrl || cfg.collector_url || "";
    }
  }
```

- [ ] **Step 11: Replace the 3 region tests in the dispatcher test**

In `shared/telemetry/tests/emit-dispatcher.test.js`, delete the three tests whose names are:
- `"dispatcher uses regions[default_region] when no cache and no Artemis"`
- `"dispatcher uses cached region entry when cache hit"`
- `"dispatcher with no orgId in event uses default_region"`

(and the `// ---- Region routing ----` comment banner above them, if present).

Append these three tests at the end of the file (they reuse the existing `mkTmp`, `runDispatcher`, `mkEnabledIkey`, `fakeEvent` helpers):

```js
// ---- iKey/collector resolution (generic seam) -----------------------------

test("dispatcher uses static instrumentationKey/collector_url when no resolver is present", () => {
  // mkEnabledIkey writes a flat ikey.json (instrumentationKey + collector_url)
  // and there is no resolver.js beside it → the static fallback is used.
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "", collectorUrl: "", fakeProbe: probePath },
  });
  assert.equal(status, 0);
  assert.ok(fs.existsSync(probePath), "static-key config must POST");
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  assert.equal(probe.headers["x-apikey"], "placeholder");
});

test("dispatcher uses an injected resolver.js to pick iKey/collector", () => {
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
        us: {
          instrumentation_key: "ikeyusresolved",
          collector_url: "https://example.invalid/OneCollector/1.0/",
        },
      },
    })
  );
  // resolver.js beside ikey.json — discovered by convention.
  fs.writeFileSync(
    path.join(tmp, "resolver.js"),
    "module.exports = {" +
      "async resolve({ cfg }) {" +
      "  const e = cfg.regions[cfg.default_region];" +
      "  return { iKey: e.instrumentation_key, collectorUrl: e.collector_url };" +
      "}," +
      "isProvisioned: () => true };"
  );
  const { status } = runDispatcher({
    event: { name: "PagesPluginEvent", data: { eventName: "skill_started", eventType: "Trace", severity: "Info" } },
    env: { configDir: tmp, iKey: "", collectorUrl: "", fakeProbe: probePath, ikeyJsonPath: ikeyPath },
  });
  assert.equal(status, 0);
  const probe = JSON.parse(fs.readFileSync(probePath, "utf8"));
  assert.equal(probe.headers["x-apikey"], "ikeyusresolved");
});

test("dispatcher writes the mirror but does NOT POST when neither resolver nor static key resolves", () => {
  const tmp = mkTmp();
  const probePath = path.join(tmp, "probe.json");
  const ikeyPath = path.join(tmp, "ikey.json");
  // Region-shaped but unprovisioned: no static instrumentationKey, no resolver.js.
  fs.writeFileSync(
    ikeyPath,
    JSON.stringify({
      event_stream_name: "PagesPluginEvent",
      disabled: false,
      default_region: "us",
      regions: { us: { collector_url: "https://x" } },
    })
  );
  const { status } = runDispatcher({
    event: fakeEvent,
    env: { configDir: tmp, iKey: "", collectorUrl: "", fakeProbe: probePath, ikeyJsonPath: ikeyPath },
  });
  assert.equal(status, 0);
  assert.ok(!fs.existsSync(probePath), "no key resolved → no POST");
  assert.ok(fs.existsSync(path.join(tmp, "events.jsonl")), "local mirror still written");
});
```

- [ ] **Step 12: Run the shared dispatcher suite + the moved/plugin tests**

Run: `node --test shared/telemetry/tests/emit-dispatcher.test.js`
Expected: PASS — `# fail 0`.

Run: `node --test plugins/power-pages/scripts/tests/resolver.test.js plugins/power-pages/scripts/tests/region-resolver.test.js plugins/power-pages/scripts/tests/region-cache.test.js plugins/power-pages/scripts/tests/artemis-service.test.js`
Expected: PASS — `# fail 0`.

- [ ] **Step 13: Verify no region/artemis references remain in shared**

Run: `grep -rn "region-resolver\|region-cache\|artemis" shared/telemetry/ || echo CLEAN`
Expected: `CLEAN`.

- [ ] **Step 14: Commit**

```bash
git add shared/telemetry/lib/emit-dispatcher.js shared/telemetry/tests/emit-dispatcher.test.js \
  plugins/power-pages/scripts/lib/telemetry/region plugins/power-pages/scripts/lib/telemetry/resolver.js \
  plugins/power-pages/scripts/tests/region-resolver.test.js plugins/power-pages/scripts/tests/region-cache.test.js \
  plugins/power-pages/scripts/tests/artemis-service.test.js plugins/power-pages/scripts/tests/resolver.test.js
git commit -m "refactor(telemetry): move region routing into power-pages behind resolver contract

Region trio relocates to plugins/power-pages/.../telemetry/region/; power-pages
ships resolver.js adapting it to the shared dispatcher's resolve()/isProvisioned()
contract. Shared dispatcher resolves via convention-discovered resolver.js with a
static-key fallback and no longer knows about regions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Generalize the provisioning fast-gate

Make the `emit-from-prompt` (shared) and pretool-hook (plugin) gates use `isProvisioned` instead of reading the region shape.

**Files:**
- Modify: `shared/telemetry/lib/emit-from-prompt.js`
- Modify: `shared/telemetry/tests/emit-from-prompt.test.js`
- Modify: `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`

- [ ] **Step 1: Update `emit-from-prompt.test.js` `mkTelemetryDir` to drop a stub resolver**

In `shared/telemetry/tests/emit-from-prompt.test.js`, replace the `mkTelemetryDir` function:

```js
function mkTelemetryDir({ instrumentationKey, collectorUrl, eventStreamName, disabled }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ppskills-efp-"));
  fs.writeFileSync(
    path.join(tmp, "ikey.json"),
    JSON.stringify({
      event_stream_name: eventStreamName,
      disabled: disabled === true,
      default_region: "us",
      regions: { us: { instrumentation_key: instrumentationKey, collector_url: collectorUrl } },
    })
  );
  // Drop the region resolver beside ikey.json so the generic isProvisioned gate
  // behaves exactly like production (provisioned == default-region key present).
  fs.writeFileSync(
    path.join(tmp, "resolver.js"),
    "module.exports = {" +
      "async resolve() { return null; }," +
      "isProvisioned(cfg) {" +
      "  const e = cfg && cfg.regions && cfg.regions[(cfg && cfg.default_region) || 'us'];" +
      "  return !!(e && e.instrumentation_key);" +
      "} };"
  );
  return tmp;
}
```

- [ ] **Step 2: Run the emit-from-prompt suite to confirm it still passes BEFORE changing the lib**

Run: `node --test shared/telemetry/tests/emit-from-prompt.test.js`
Expected: PASS (the lib still reads `defaultInstrumentationKey`; the extra `resolver.js` file is inert for now). `# fail 0`.

> If any test fails here, the stub `resolver.js` is being picked up early — it is not (the lib doesn't load it yet). Investigate before proceeding.

- [ ] **Step 3: Update `emit-from-prompt.js` — add the loader require**

In `shared/telemetry/lib/emit-from-prompt.js`, add to the require block near the top (after the existing `require("./emit-spawn")` line):

```js
const { loadResolver } = require("./resolver-loader");
```

- [ ] **Step 4: Update `emit-from-prompt.js` — `readIkey` returns cfg + dir, not the region key**

Replace the whole `readIkey` function with:

```js
function readIkey(telemetryDir) {
  // Test/override seam: POWER_PLATFORM_SKILLS_IKEY_JSON points at an alternate
  // ikey.json so tests don't have to mutate the checked-in config file.
  const override = process.env.POWER_PLATFORM_SKILLS_IKEY_JSON;
  const ikeyPath =
    override && override.trim() ? override : path.join(telemetryDir, "ikey.json");
  const dir = path.dirname(ikeyPath);
  try {
    const cfg = JSON.parse(fs.readFileSync(ikeyPath, "utf8"));
    return { cfg, dir, eventStreamName: cfg.event_stream_name || "", disabled: cfg.disabled === true };
  } catch {
    return { cfg: null, dir, eventStreamName: "", disabled: false };
  }
}
```

- [ ] **Step 5: Update `emit-from-prompt.js` — the gate**

Replace this block:

```js
  const { eventStreamName, disabled, defaultInstrumentationKey } = readIkey(telemetryDir);
  if (disabled) return { emitted: false, skillName };
  if (!defaultInstrumentationKey) return { emitted: false, skillName };
```

with:

```js
  const { cfg, dir, eventStreamName, disabled } = readIkey(telemetryDir);
  if (disabled) return { emitted: false, skillName };
  // Provisioning fast-gate (generic): a plugin resolver decides "is there a key
  // worth paying the pac shellout for?"; default is "static key present".
  const resolver = loadResolver(dir);
  const provisioned =
    resolver && typeof resolver.isProvisioned === "function"
      ? resolver.isProvisioned(cfg)
      : !!(cfg && cfg.instrumentationKey);
  if (!provisioned) return { emitted: false, skillName };
```

- [ ] **Step 6: Run the emit-from-prompt suite**

Run: `node --test shared/telemetry/tests/emit-from-prompt.test.js`
Expected: PASS — `# fail 0`. (Provisioned cases have a key in `regions.us`; unprovisioned/missing cases resolve to `false` exactly as before.)

> Note: the existing `"does not throw when ikey.json is missing"` test uses a dir with no `ikey.json` and no `resolver.js` → `cfg` is null, `loadResolver` returns null → `provisioned = !!(null && ...) = false` → no emit. Behavior preserved.

- [ ] **Step 7: Update the pretool hook — add the loader require**

In `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`, the modules are required from `TELEMETRY_DIR/lib`. Add `resolverLoader` to that `try` block alongside the others:

```js
  resolverLoader = require(path.join(TELEMETRY_DIR, "lib", "resolver-loader"));
```

Declare it in the same `let` list as `emitSpawn, eventsLib, ...` at the top.

- [ ] **Step 8: Update the pretool hook — `readIkey` returns cfg**

Replace the hook's `readIkey` function with:

```js
function readIkey() {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(TELEMETRY_DIR, "ikey.json"), "utf8")
    );
    return { cfg, eventStreamName: cfg.event_stream_name || "", disabled: cfg.disabled === true };
  } catch {
    return { cfg: null, eventStreamName: "", disabled: false };
  }
}
```

- [ ] **Step 9: Update the pretool hook — the gate**

Replace this block:

```js
  const { eventStreamName, disabled, defaultInstrumentationKey } = readIkey();
  if (disabled) process.exit(0);
  if (!defaultInstrumentationKey) process.exit(0);
```

with:

```js
  const { cfg, eventStreamName, disabled } = readIkey();
  if (disabled) process.exit(0);
  const resolver = resolverLoader.loadResolver(TELEMETRY_DIR);
  const provisioned =
    resolver && typeof resolver.isProvisioned === "function"
      ? resolver.isProvisioned(cfg)
      : !!(cfg && cfg.instrumentationKey);
  if (!provisioned) process.exit(0);
```

- [ ] **Step 10: Run the pretool/posttool hook tests**

Run: `node --test plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js plugins/power-pages/scripts/tests/telemetry-hook-posttool.test.js`
Expected: PASS — `# fail 0`. (The real plugin `resolver.js` + `ikey.json` exist after Task 2; the "regions but no key" test resolves to `isProvisioned == false` → exit 0.)

- [ ] **Step 11: Commit**

```bash
git add shared/telemetry/lib/emit-from-prompt.js shared/telemetry/tests/emit-from-prompt.test.js \
  plugins/power-pages/hooks/run-skill-pretool-telemetry.js
git commit -m "refactor(telemetry): generic provisioning fast-gate via resolver.isProvisioned

emit-from-prompt (shared) and the pretool hook no longer read the region shape;
they call the plugin resolver's isProvisioned, defaulting to a static-key check.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Docs, memory, and full verification

**Files:**
- Modify: `shared/telemetry/README.md`
- Modify: `AGENTS.md`, `plugins/power-pages/AGENTS.md`
- Modify: `C:\Users\amitjoshi\.claude\projects\C--repos-power-platform-skills\memory\project_telemetry_design.md`

- [ ] **Step 1: Rewrite the README "Region routing" + layout + adoption sections**

In `shared/telemetry/README.md`:

1. Replace the `### Region routing` subsection (under "What it does") with:

```markdown
### Custom routing (the resolver contract)

The destination iKey/collector is **not** hard-coded and the shared library is
routing-agnostic. A plugin may drop a `resolver.js` next to its `ikey.json`:

```js
module.exports = {
  // async; may do network I/O (must cache). Returns { iKey, collectorUrl } or null.
  async resolve({ event, cfg, cloud, configDir }) { /* ... */ },
  // optional sync fast-gate so hooks skip the ~3-5s pac shellout when unprovisioned.
  isProvisioned(cfg) { return true; },
};
```

The dispatcher discovers it by convention (sibling of `ikey.json`) and resolves
by precedence: env override (test seam) → `resolver.js` → static
`instrumentationKey`/`collector_url` in `ikey.json` → none. Power-pages ships a
`resolver.js` that does Artemis geo + cloud-stamp region routing; that code lives
entirely in `plugins/power-pages/scripts/lib/telemetry/region/`.
```

2. In the **Layout** block, remove the `region-resolver.js` / `region-cache.js` / `artemis-service.js` lines, and add `resolver-loader.js` (`# discovers an optional plugin resolver.js next to ikey.json`).

3. In **Adopting in a new plugin**, replace the single region-shaped `ikey.json` step with the two tiers:
   - *Tier 1 — one static key:* flat `ikey.json` (`instrumentationKey`, `collector_url`, `event_stream_name`, `disabled`); no resolver.
   - *Tier 2 — custom routing:* add a `resolver.js` next to `ikey.json` implementing `resolve()` (+ optional `isProvisioned()`); `ikey.json` in whatever shape the resolver wants.

   (Use the exact wording from spec §8 "Onboarding".)

- [ ] **Step 2: Update AGENTS.md (root + plugin)**

- In `plugins/power-pages/AGENTS.md` "Telemetry" section, change the symlink note to add: region routing lives in `scripts/lib/telemetry/region/` and is wired through `scripts/lib/telemetry/resolver.js` (the resolver contract); shared is routing-agnostic.
- In root `AGENTS.md` "Shared Telemetry" section, add one sentence: per-plugin iKey/collector routing is pluggable via a `resolver.js` next to the plugin's `ikey.json`; shared ships only the contract + a static-key fallback.

- [ ] **Step 3: Update the memory file**

Edit `C:\Users\amitjoshi\.claude\projects\C--repos-power-platform-skills\memory\project_telemetry_design.md` — under region routing, note it now lives in `plugins/power-pages/.../telemetry/region/` behind a `resolver.js` (`resolve`/`isProvisioned`) discovered by convention; shared dispatcher is routing-agnostic with a static-key fallback.

- [ ] **Step 4: Full verification — both suites + lint + no-region-in-shared**

```bash
node --test shared/telemetry/tests/*.test.js
node --test plugins/power-pages/scripts/tests/*.test.js
node plugins/power-pages/scripts/lint-skills-alm.js
grep -rn "region-resolver\|region-cache\|artemis" shared/telemetry/ || echo "CLEAN: no region/artemis in shared"
```
Expected: both suites `# fail 0`; `alm-lint: 0 findings`; `CLEAN: no region/artemis in shared`.

> Re-run the plugin suite once if 1-2 pac-dependent tests flake (known timing flakiness) — they pass on rerun.

- [ ] **Step 5: Commit**

```bash
git add shared/telemetry/README.md AGENTS.md plugins/power-pages/AGENTS.md
git commit -m "docs(telemetry): document the resolver contract + onboarding tiers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Resolver contract (§3) → Task 2 (`resolver.js`) + Task 1 (loader). ✓
- Dispatcher precedence env→resolver→static→none (§4) → Task 2 Steps 8-10. ✓
- `resolver-loader.js` (§5) → Task 1. ✓
- Generic `isProvisioned` fast-gate, option i (§6) → Task 3. ✓
- File moves / layout (§7) → Task 2 Steps 1-3. ✓
- Onboarding tiers (§8) → Task 4 Step 1. ✓
- `ikey.json` shapes (§9) → covered in dispatcher static path (Task 2) + README tiers (Task 4). ✓
- Test plan (§10): move region tests (T2 S1-3), new loader test (T1), new resolver test (T2 S4-7), dispatcher rewrite (T2 S11), emit-from-prompt gate tests (T3 S1), acceptance greps (T2 S13, T4 S4). ✓
- Docs (§11) → Task 4. ✓
- §14 dedup follow-up is explicitly out of scope; not planned. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows the command + expected output. The README rewrite (Task 4 Step 1) points to spec §8 for the onboarding wording rather than re-pasting it — acceptable since the exact source text is in the committed spec.

**Type/name consistency:** `loadResolver(dir)` (Task 1) is called identically in the dispatcher (Task 2 S9), `emit-from-prompt` (Task 3 S5), and the pretool hook (Task 3 S9, via `resolverLoader.loadResolver`). The contract methods `resolve({event,cfg,cloud,configDir})` / `isProvisioned(cfg)` match between `resolver.js` (Task 2 S6), the dispatcher call (Task 2 S10), and both gates (Task 3). `readIkey` returns `{ cfg, ... }` consistently in both callers after Task 3.
