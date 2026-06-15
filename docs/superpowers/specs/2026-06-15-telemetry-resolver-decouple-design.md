# Telemetry: decouple region routing from shared via a pluggable resolver

- **Date:** 2026-06-15
- **Status:** Proposed (awaiting review)
- **Owner:** power-pages plugin
- **Related:** `2026-05-27-region-routing-design.md` (introduced artemis region routing), the `main` → `1ds-region-routing` merge (adopted symlink lib sharing + config.json opt-out)

## 1. Problem

Region-based routing (Artemis geo lookup → per-region iKey/collector) is a **power-pages-specific** concern, but it currently lives in the **shared** telemetry library:

- `shared/telemetry/lib/region-resolver.js`, `region-cache.js`, `artemis-service.js`
- The shared `emit-dispatcher.js` hard-`require`s `region-resolver` and resolves the iKey/collector at emit time.
- `emit-from-prompt.js` and the pretool hook read the `regions` shape from `ikey.json` as a "is it provisioned?" fast-gate.

Other teams adopting the shared library may want artemis-style routing, **their own** routing (tenant-based, static map, etc.), or **none at all**. Baking artemis into shared forces every adopter into power-pages' model and shape.

## 2. Goals / Non-goals

**Goals**
- Remove all artemis/region **logic** from `shared/telemetry/`. It lives only in power-pages.
- Give the shared library a small, generic, documented extension point so **any** plugin can plug in its own iKey/collector resolution — or use a zero-config static key.
- Keep resolution in the **detached background dispatcher** (no new foreground latency; no `emit-from-prompt` restructure beyond the gate).
- Preserve all current behavior for power-pages (region routing unchanged at runtime).
- Keep the symlinked-`lib` sharing model, the `config.json` opt-out, the `disabled` kill switch, the local-mirror semantics, sanitization, and the CS4.0 envelope **unchanged**.

**Non-goals**
- No change to opt-out, kill switch, local mirror, sanitization, envelope, or transport.
- No change to `emit-spawn.js` wiring (resolver is discovered from the already-forwarded `ikey.json` path).
- No move of `emit-from-prompt.js` out of shared (it stays generic).
- No new npm dependencies.

## 3. The resolver contract

A **resolver** is a plain Node module a plugin places next to its `ikey.json`. It owns iKey/collector selection. Shared never imports it directly — it discovers and calls it through this contract:

```js
module.exports = {
  // REQUIRED. Async; may do network I/O (must cache). Returns the destination
  // for THIS event, or null when it can't resolve one.
  async resolve({ event, cfg, cloud, configDir }) {
    return { iKey: "<1DS key>", collectorUrl: "https://.../OneCollector/1.0/" };
  },

  // OPTIONAL. Sync, cheap, no I/O. Lets the foreground hooks skip the ~3-5s
  // pac shellout when the plugin isn't provisioned yet. Defaults to true.
  isProvisioned(cfg) { return true; },
};
```

Context passed to `resolve`:
- `event` — the parsed event (`event.data.orgId` is available for geo/tenant routing).
- `cfg` — the parsed `ikey.json` (the resolver interprets its own shape; shared does not).
- `cloud` — `POWER_PLATFORM_SKILLS_CLOUD` (from `pac auth who`), `""` if unknown.
- `configDir` — resolved config dir (for the resolver's own caching, e.g. region cache).

## 4. Dispatcher resolution (shared, generic)

The dispatcher discovers an optional resolver **by convention** — a `resolver.js` sibling of the resolved `ikey.json`. There is no resolver-path override: tests exercise the seam by writing a stub `resolver.js` next to the temp `ikey.json` they already create. iKey/collector are chosen by this precedence:

1. **Env override** `POWER_PLATFORM_SKILLS_IKEY` / `_COLLECTOR` (existing test seam) — unchanged.
2. **Injected resolver** `resolver.js` (if present) — `await resolver.resolve({event, cfg, cloud, configDir})`.
3. **Static config** — `cfg.instrumentationKey` + `cfg.collector_url` (zero-effort single-key plugins).
4. **None** → `keyMissing` → local mirror already written, no POST (unchanged).

Sketch of the changed block in `emit-dispatcher.js` (replaces the current `resolveRegion(...)` call; the surrounding kill-switch / opt-out / local-mirror / POST logic is untouched):

```js
const { loadResolver } = require("./resolver-loader");
const resolver = loadResolver(path.dirname(ikeyJsonPath())); // null when absent

// ...inside the stdin handler, after the local mirror + opt-out gate:
let iKey = IKEY_OVERRIDE;
let collectorUrl = COLLECTOR_OVERRIDE;
if (!iKey || !collectorUrl) {
  if (resolver && typeof resolver.resolve === "function") {
    const r = await resolver.resolve({
      event, cfg, cloud: CLOUD_ENV, configDir: CONFIG_DIR_ENV || undefined,
    });
    if (r) { iKey = iKey || r.iKey || ""; collectorUrl = collectorUrl || r.collectorUrl || ""; }
  } else {
    iKey = iKey || cfg.instrumentationKey || "";
    collectorUrl = collectorUrl || cfg.collector_url || "";
  }
}
```

The dispatcher no longer knows the words "region" or "artemis", and no longer reads `cfg.regions` / `cfg.default_region` (the resolver does).

## 5. Shared helper: `resolver-loader.js`

A ~15-line shared helper so the dispatcher and `emit-from-prompt` discover the resolver the same way:

```js
"use strict";
const path = require("node:path");

// Discover an optional resolver module: the conventional resolver.js next to the
// plugin's ikey.json. Returns null when none is found or it fails to load
// (fail open → static/no-op path).
function loadResolver(dir) {
  try { return require(path.join(dir, "resolver.js")); } catch { return null; }
}

module.exports = { loadResolver };
```

## 6. Provisioning fast-gate (generic)

The "skip the pac shellout when unprovisioned" optimization becomes generic. `emit-from-prompt.js` and the pretool hook:

- read only generic fields from `ikey.json` (`event_stream_name`, `disabled`, plus the raw `cfg`);
- gate on `cfg.disabled` (unchanged hard-off);
- then ask the resolver: `const provisioned = resolver?.isProvisioned ? resolver.isProvisioned(cfg) : !!cfg.instrumentationKey;`
- if not provisioned → return without the pac shellout.

Power-pages' `isProvisioned` checks "default-region key present", preserving today's behavior. A static-key plugin gets the `!!cfg.instrumentationKey` default. A plugin shipping `disabled: true` (the recommended pre-provisioning posture) is gated by `disabled` regardless.

## 7. File layout — before / after

**Before (shared owns region):**
```
shared/telemetry/lib/        region-resolver.js  region-cache.js  artemis-service.js
shared/telemetry/tests/      region-resolver.test.js  region-cache.test.js  artemis-service.test.js
plugins/power-pages/scripts/lib/telemetry/   ikey.json   lib -> shared/telemetry/lib
```

**After (shared generic; power-pages owns region):**
```
shared/telemetry/lib/        resolver-loader.js            # NEW, generic (~15 lines)
                             # region-resolver/region-cache/artemis-service REMOVED
shared/telemetry/tests/      resolver-loader.test.js       # NEW
                             # region-*/artemis tests REMOVED (moved)
plugins/power-pages/scripts/lib/telemetry/
    ikey.json                                              # region shape (unchanged)
    resolver.js                                            # NEW adapter (~30 lines)
    lib -> shared/telemetry/lib                            # symlink (unchanged)
    region/                                                # MOVED here (real files)
        region-resolver.js  region-cache.js  artemis-service.js
plugins/power-pages/scripts/tests/
    resolver.test.js                                       # NEW
    region-resolver.test.js  region-cache.test.js  artemis-service.test.js   # MOVED
```

power-pages `resolver.js` (the adapter):

```js
"use strict";
const { resolve: resolveRegion } = require("./region/region-resolver");

async function resolve({ event, cfg, cloud, configDir }) {
  return resolveRegion({
    orgId: (event && event.data && event.data.orgId) || "",
    cloud,
    regionsMap: cfg.regions || {},
    defaultRegion: cfg.default_region || "us",
    configDir,
  });
}

function isProvisioned(cfg) {
  const dr = (cfg && cfg.default_region) || "us";
  const entry = cfg && cfg.regions && cfg.regions[dr];
  return !!(entry && entry.instrumentation_key);
}

module.exports = { resolve, isProvisioned };
```

> Note: `resolver.js` lives next to `ikey.json` (a real plugin file), and `require`s `./region/...` relative to itself. The dispatcher runs from the symlinked `lib/`, but discovers `resolver.js` via `dirname(ikey.json path)` — which the hooks already pass as `POWER_PLATFORM_SKILLS_IKEY_JSON`. No `emit-spawn` change is needed.

## 8. Onboarding

**Power-pages (migration):**
1. `git mv` the region trio (`region-resolver.js`, `region-cache.js`, `artemis-service.js`) and their tests into `plugins/power-pages/scripts/lib/telemetry/region/` and `.../scripts/tests/`.
2. Add `plugins/power-pages/scripts/lib/telemetry/resolver.js` (the ~30-line adapter above) + `resolver.test.js`.
3. `ikey.json` unchanged (keeps `default_region` + `regions`).
4. Generalize the pretool hook / `emit-from-prompt` gate to call `isProvisioned` (behavior identical).

**New plugin — Tier 1 "one static key, no routing":**
1. Symlink `scripts/lib/telemetry/lib` → `shared/telemetry/lib` (as today).
2. Write a **flat** `ikey.json`: `{ instrumentationKey, collector_url, event_stream_name, disabled }`.
3. Register the 3 hooks.
   No resolver. The dispatcher's static-config path is used. (Simpler than today.)

**New plugin — Tier 2 "bring your own routing":**
1–3 as Tier 1, but `ikey.json` in whatever shape the resolver wants, plus
4. Drop a `resolver.js` next to `ikey.json` implementing `resolve()` (+ optional `isProvisioned()`).
   The dispatcher auto-discovers and calls it. The plugin owns its routing; shared is untouched.

## 9. `ikey.json` shapes

- **Region (power-pages):** `{ event_stream_name, disabled, default_region, regions: { <r>: { instrumentation_key, collector_url } } }` — interpreted by power-pages' resolver only.
- **Static (generic):** `{ event_stream_name, disabled, instrumentationKey, collector_url }` — interpreted by the dispatcher's static fallback.

Both keep `disabled` (kill switch) and `event_stream_name` (generic, read by callers for the envelope name).

## 10. Test plan

**Move (no logic change):** `region-resolver.test.js`, `region-cache.test.js`, `artemis-service.test.js` → `plugins/power-pages/scripts/tests/`. Fix relative `require` paths to `../lib/telemetry/region/...`.

**New:**
- `shared/telemetry/tests/resolver-loader.test.js` — conventional `resolver.js` in the dir is loaded; missing/broken module → null.
- `plugins/power-pages/scripts/tests/resolver.test.js` — `resolve` maps region lookup; `isProvisioned` true/false by default-region key.

**Rewrite `shared/telemetry/tests/emit-dispatcher.test.js`:**
- Drop the 3 region-specific tests (default_region / cache-hit / no-orgId) — they move to the plugin resolver/region tests.
- Add: static-key path (`instrumentationKey`/`collector_url` in `ikey.json` → POST), injected-resolver path (write a stub `resolver.js` next to the temp `ikey.json` returning a fixed iKey → POST uses it), and no-resolver-no-static path (→ no POST, local mirror written). Keep all kill-switch / opt-out / local-mirror / sanitize tests unchanged.

**Adjust `emit-from-prompt.test.js`:** gate tests use the generic `isProvisioned`/static path; an injected stub resolver drives the provisioned/unprovisioned cases.

**Power-pages integration:** a plugin-level test that runs the symlinked dispatcher with the real `resolver.js` discovered by convention and asserts the region iKey is selected (mirrors today's region tests, but through the new seam).

**Acceptance:** `node --test shared/telemetry/tests/*.test.js` and `node --test plugins/power-pages/scripts/tests/*.test.js` both green; `lint-skills-alm.js` clean; no `region`/`artemis` strings remain under `shared/telemetry/`.

## 11. Docs

- `shared/telemetry/README.md` — replace the "Region routing" section with "Custom routing (resolver contract)" + the Tier-1/Tier-2 onboarding; update the layout block; document `resolver.js` discovery and the static `ikey.json` shape.
- Root `AGENTS.md` / `plugins/power-pages/AGENTS.md` — note that region/artemis lives in `plugins/power-pages/.../telemetry/region/` behind the resolver contract; shared is routing-agnostic.
- `[[project_telemetry_design]]` memory — update to reflect the resolver seam.

## 12. Effort & risk

**Effort:** ~one focused session. ~90 lines of real new/changed logic (adapter + dispatcher block + two gates + loader), ~170 lines of test scaffolding (new + rewrite), ~80 lines of docs. ~643 lines of region code/tests **relocate** unchanged via `git mv`.

**Risks (both contained):**
1. **Resolver discovery path** — `dirname(ikeyJsonPath())` must point at the plugin's real telemetry dir even though the dispatcher runs from the symlinked `lib/`. Mitigation: discovery keys off `POWER_PLATFORM_SKILLS_IKEY_JSON` (already passed by hooks); `loadResolver` fails open to the static/no-op path; tests write a stub `resolver.js` beside the temp `ikey.json`.
2. **Test-coverage equivalence** — moving region tests + rewriting dispatcher tests must not drop a case. Mitigation: explicit acceptance grep for `region`/`artemis` under `shared/telemetry/`, and the integration test that exercises the real resolver through the seam.

## 13. Decisions (confirmed)

- Discovery by **convention** only (`resolver.js` beside `ikey.json`); no resolver-path env var — tests drop a stub `resolver.js` beside the temp `ikey.json`. ✓
- **Static-key fallback** kept as the zero-effort default. ✓
- Resolution stays in the **background dispatcher**. ✓
