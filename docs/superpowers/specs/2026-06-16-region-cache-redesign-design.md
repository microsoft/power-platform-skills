# Region cache redesign — plugin-independent, per-org, race-free

**Date:** 2026-06-16
**Context:** PR #190 (1DS region routing). Review by priyanshu92 on `region-cache.js`.

## Problem

`region-cache.js` caches an org's resolved telemetry destination so each emit
doesn't re-hit Artemis. The current design has three issues, in increasing
severity:

1. **Torn reads** — `write()` did a non-atomic `writeFileSync` of the whole
   file; a concurrent reader could see a half-written file → cache miss for all
   orgs. (Already mitigated in `df0ea69` via temp-file + atomic rename.)
2. **Cross-org lost-update** — `write()` does read-modify-write of one shared
   file keyed by orgId. Two detached dispatchers (one spawned per skill
   invocation) writing different orgs can interleave so the last writer clobbers
   the other org's entry (`A reads {}`, `B reads {}`, `A writes {A}`, `B writes
   {B}` → A lost). Cost: premature eviction before the 24h TTL → an extra ≤5s
   Artemis round-trip. Self-healing but undermines the TTL contract.
3. **Cross-plugin misrouting (latent correctness bug)** — the cache path is
   machine-global and plugin-agnostic (`~/.power-platform-skills/region-cache.json`),
   keyed by **orgId only**, but it stores **plugin-specific** values (`iKey` /
   `collectorUrl` come from each plugin's `ikey.json`). The shared telemetry lib
   is built for multiple adopters ("Others adopt on demand"). The moment a second
   plugin adopts region routing, it would read the first plugin's cached `iKey`
   for the same org and POST its events to the wrong plugin's collector/table.
   Latent today (power-pages is the only adopter), real on the next adopter.

Root cause of (2) and (3): the cache **conflates** plugin-independent data
(org → region, a property of the org's geo/tenant) with plugin-dependent data
(region → iKey, a property of each plugin's config). Only the region resolution
is expensive (the Artemis call); region → iKey is a free in-memory lookup.

## Design

Cache **only the plugin-independent org → region mapping**, and split it into
**per-org files**.

### `region-cache.js`
- Layout: `<configDir|~/.power-platform-skills>/region-cache/<orgId>.json`,
  one file per org. Each file: `{ "region": "<region>", "expiresAt": <ms> }`.
  No `iKey` / `collectorUrl` — those are no longer cached.
- `read(orgId, configDir)` → `{ region }` or `null` (missing / malformed /
  expired). `write(orgId, entry, configDir)` persists `{ region, expiresAt }`.
- `orgId` is validated against a GUID regex before use as a filename
  (defensive against path separators; also subsumes the falsy-orgId guard).
- Writes stay atomic: per-process temp file (`<file>.tmp.<pid>.<seq>`) + `rename`.

Per-org files remove the shared read-modify-write entirely, so the cross-org
lost-update (issue 2) **cannot occur** — different orgs touch different files,
and same-org concurrent writes are idempotent (identical content).

### `region-resolver.js`
- Add `deriveRegion(cloud, geoName)` → region string, or **`null`** when the geo
  is unrecognized (i.e. would fall back to the per-plugin `defaultRegion`).
  `mapToRegion` stays as a thin wrapper (`deriveRegion(...) || defaultRegion`)
  so its existing tests are unaffected.
- On **cache hit**: map the cached region → this plugin's iKey via the existing
  `entryFromMap(regionsMap, cached.region)` (falling back to the default-region
  entry). The iKey therefore always comes from the *calling* plugin's config —
  closing issue 3, and turning the shared cache into a cross-plugin *benefit*
  (a second plugin reuses the org→region resolution instead of re-calling Artemis).
- On **cache miss + Artemis success**: cache the region **only when it was
  derived** (`deriveRegion` non-null). A `defaultRegion` fallback is per-plugin
  and must not be cached, or another plugin with a different default could read
  the wrong region.

## Non-goals / accepted residuals
- **Old `region-cache.json`** is orphaned, not migrated (it's a cache). No
  cleanup step — it simply stops being read. (YAGNI; revisit if litter matters.)
- **Same-instant same-org writes** still race but are idempotent → harmless.
- No file locking — unjustified for a best-effort 24h cache.

## Testing
- `region-cache.test.js`: rewrite the three tests that assumed the single-file
  layout (coexist / expired / malformed) to the per-org path; change fixtures to
  region-only; keep the atomic "no temp litter" test; add a GUID-guard test
  (non-GUID orgId → no read/write, no path traversal).
- `region-resolver.test.js`: update the cache-hit test to assert the iKey is
  taken from `regionsMap` (not the cached value) — the core of the fix; assert
  the written cache entry is region-only.
- Full telemetry suite must stay green.
