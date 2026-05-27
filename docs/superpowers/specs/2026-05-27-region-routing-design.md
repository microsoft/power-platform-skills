# Region-Aware Telemetry Routing — Design Spec

**Date:** 2026-05-27
**Status:** Draft — pending implementation plan
**Branch:** `users/amitjosh/1ds-region-routing`
**Scope:** Power Pages plugin only. Each adopting plugin will own its own region configuration; the shared library remains plugin-agnostic.
**Reference:** `C:\repos\powerplatform-vscode\src\common\OneDSLoggerTelemetry` + `C:\repos\powerplatform-vscode\src\common\services\ArtemisService.ts`

---

## 1. Problem and Goals

### Problem

The Power Pages plugin currently emits telemetry to a single (iKey, collector URL) pair carried in `ikey.json`. That works for one cluster but cannot honour data-residency requirements as the plugin reaches more customers:

- Public-cloud customers in EU should route to the EU collector + EU-aware Kusto table, not US.
- Sovereign-cloud customers (GccHigh, DoD, China) cannot reach the Public collector at all — those events are silently dropped at the network layer.
- The VSCode Power Platform extension already solves this via the 1DS SDK + a static (geo → endpoint, iKey) map + Artemis Service for geo discovery. We need the equivalent for the plugin, but without pulling in the 1DS SDK.

### Goals

- Resolve the right (iKey, collector URL) pair at telemetry emission time based on the user's tenant geography.
- Use the same authoritative source VSCode uses for geo: the Artemis service (`*.organization.api.<cloud>.powerplatform.com`).
- Cache the resolved region per orgId so the cost is paid once per cache window, not once per skill invocation.
- Keep the hook's user-visible latency unchanged from today. All region-resolution I/O happens in the detached dispatcher child.
- Preserve every fail-closed invariant: any failure in the region path falls back to a default region, never throws into the user's session.

### Non-Goals

- Multi-plugin rollout. Each adopting plugin will own its own `regions` config in its own `ikey.json`. The shared library only knows about the *structure* of a region entry, never specific iKey values.
- Provisioning the 6 production iKeys. Tenant team work; this spec assumes they'll be supplied.
- Refactoring the existing hook → dispatcher boundary beyond what's needed for region routing. Moving PAC shellouts to the dispatcher is out of scope; the user chose to keep PAC in the hook for now.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Claude Code session                                                │
│                                                                     │
│  user prompt / Skill tool call                                      │
│        │                                                            │
│        ▼                                                            │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  hook (~3-5s on first emit, ~5ms when gates trip)            │   │
│  │   ├─ stdin → detect tracked skill                            │   │
│  │   ├─ gate 1: env opt-out                                     │   │
│  │   ├─ gate 2: tracked skill regex                             │   │
│  │   ├─ gate 3: ikey.json disabled flag                         │   │
│  │   ├─ gate 4: regions[default_region] exists                  │   │
│  │   ├─ pac auth who     (3s)   → orgId, tenantId, cloud        │   │
│  │   ├─ pac --version    (2s)   → pacCliVersion                 │   │
│  │   ├─ agent-info             → aiAgentName, aiAgentVersion   │   │
│  │   ├─ buildSkillStarted(name, fields)   ← FIELD_TYPES filter │   │
│  │   └─ fireAndForget(event, { cloud, configDir, fakeProbe })  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                │                                    │
│                          (detached, unref'd)                        │
│                                ▼                                    │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  emit-dispatcher (background — user never waits)             │   │
│  │   ├─ read ikey.json (regions, default_region, name, disabled)│   │
│  │   ├─ read stdin event                                         │   │
│  │   ├─ region-resolver(orgId, cloud)                            │   │
│  │   │    ├─ disk cache hit (24h TTL)? use it                    │   │
│  │   │    ├─ miss → artemis-service.fetchGeo(orgId, cloud)       │   │
│  │   │    │   └─ ONE HTTPS GET to cloud-specific URL             │   │
│  │   │    ├─ map (cloud, geoName) → region key                   │   │
│  │   │    ├─ regions[region] || regions[default_region]         │   │
│  │   │    └─ write cache                                         │   │
│  │   ├─ sanitizeData (defense-in-depth FIELD_TYPES)              │   │
│  │   ├─ build CS4.0 envelope with resolved iKey                  │   │
│  │   └─ HTTPS POST to resolved collectorUrl                      │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

The shared library gains 3 new modules (`artemis-service.js`, `region-resolver.js`, `region-cache.js`). `emit-dispatcher.js` is extended to call the resolver. `pac-auth.js` parses one additional line (`Cloud:`). Plugin-side, `ikey.json` is restructured from flat to multi-region, hooks pass one additional env var, and `telemetry-runner.js` follows the same uniform pattern.

---

## 3. Components

### 3.1 New shared modules

#### `shared/telemetry/lib/artemis-service.js` (~50 LOC)

```
exports.fetchGeo(orgId, cloud, opts?) → Promise<{ geoName, stamp } | null>
```

- Single HTTPS GET to the Artemis URL chosen by `cloud`. No fan-out (we already know the cloud from PAC).
- 5-second timeout. Any failure (network, non-2xx, JSON parse, missing `geoName` in body) returns `null` — never throws.
- Test seam: `opts._httpsGet` injects a fake.

URL templates by cloud (mirroring VSCode's `convertGuidToUrls` but only the chosen one is hit):

| `cloud` (from PAC, case-insensitive) | URL template |
|---|---|
| `Public` (or missing/unknown) | `https://{domain}.{suffix2}.organization.api.powerplatform.com/gateway/cluster?api-version=1` |
| `UsGovGcc` / `Gcc` / `Gov` | `https://{domain}.{suffix1}.organization.api.gov.powerplatform.microsoft.us/gateway/cluster?api-version=1` |
| `UsGovHigh` / `High` | `https://{domain}.{suffix1}.organization.api.high.powerplatform.microsoft.us/gateway/cluster?api-version=1` |
| `UsGovDod` / `Dod` | `https://{domain}.{suffix1}.organization.api.appsplatform.us/gateway/cluster?api-version=1` |
| `China` / `Mooncake` / `ChinaCloud` | `https://{domain}.{suffix1}.organization.api.powerplatform.partner.microsoftonline.cn/gateway/cluster?api-version=1` |
| `Tip1` / `Tip2` / `Test` / `Preprod` | `https://{domain}.{suffix1}.organization.api.test.powerplatform.com/gateway/cluster?api-version=1` |

Where:
- `orgIdNoDashes = orgId.replace(/-/g, "")`
- For Public: `domain = orgIdNoDashes.slice(0, -2)`, `suffix2 = orgIdNoDashes.slice(-2)` (two-digit zone suffix)
- For all other clouds: `domain = orgIdNoDashes.slice(0, -1)`, `suffix1 = orgIdNoDashes.slice(-1)` (one-digit zone suffix)

#### `shared/telemetry/lib/region-resolver.js` (~80 LOC)

```
exports.resolve({
  orgId,                  // from PAC; may be empty
  cloud,                  // from PAC; may be empty
  regionsMap,             // from ikey.json
  defaultRegion,          // from ikey.json (e.g., "us")
  configDir?,             // for cache file location
  opts?: { _fetchGeo?, _cache? }  // test seams
}) → Promise<{ region, iKey, collectorUrl } | null>
```

- Pure orchestration: cache → Artemis → region map → default.
- Returns `regionsMap[defaultRegion]` on any failure path.
- Returns `null` only if both the resolved region and `defaultRegion` are missing from `regionsMap` (genuinely unconfigured); the dispatcher's existing keyMissing path then handles it.

The `mapToRegion(cloud, geoName)` switch:

| `cloud` | `geoName` | Returns |
|---|---|---|
| `Public` (or missing) | `us`, `br`, `jp`, `in`, `au`, `ca`, `as`, `za`, `ae`, `kr` | `us` |
| `Public` (or missing) | `eu`, `uk`, `de`, `fr`, `no`, `ch` | `eu` |
| `Public` (or missing) | anything else | `default_region` |
| `UsGovGcc` / `Gcc` / `Gov` | (ignored) | `gov` |
| `UsGovHigh` / `High` | (ignored) | `high` |
| `UsGovDod` / `Dod` | (ignored) | `dod` |
| `China` / `Mooncake` / `ChinaCloud` | (ignored) | `mooncake` |
| `Tip1` / `Tip2` / `Test` / `Preprod` | (ignored) | `internal` |

For sovereign clouds, `geoName` is captured for the event payload (`data.userRegion` or equivalent context) but does not influence routing — the cloud alone determines the region.

#### `shared/telemetry/lib/region-cache.js` (~40 LOC)

```
exports.read(orgId, configDir?) → { region, iKey, collectorUrl } | null
exports.write(orgId, entry, configDir?) → void
```

- File: `${configDir || ~/.power-platform-skills}/region-cache.json`.
- JSON keyed by `orgId`. Each entry has `expiresAt = now + 24h`.
- Read returns `null` if file missing, JSON malformed, entry missing, or `expiresAt < now`.
- Write swallows disk errors (full disk, permissions).
- 24-hour TTL is a module-level constant — easy to tune.

### 3.2 Extended shared modules

#### `shared/telemetry/lib/pac-auth.js`

Add `cloud` to the returned object:

```js
return {
  orgId: orgId || "",
  tenantId: tenantId || "",
  cloud: cloud || "",     // NEW — parsed from "Cloud:" line of `pac auth who`
};
```

Same shellout; one additional regex match against `pickLine(output, "Cloud")`.

#### `shared/telemetry/lib/emit-dispatcher.js`

After the existing kill-switch and stdin-read gates, before building the envelope:

```js
const { resolve } = require("./region-resolver");
const cloud = process.env.POWER_PLATFORM_SKILLS_CLOUD || "";
const orgId = (event.data && event.data.orgId) || "";
const resolved = await resolve({
  orgId,
  cloud,
  regionsMap: cfg.regions || {},
  defaultRegion: cfg.default_region || "us",
  configDir: process.env.POWER_PLATFORM_SKILLS_CONFIG_DIR || undefined,
});
if (!resolved) return writeLocalLogAndExit(event);  // genuinely unconfigured
const IKEY = resolved.iKey;
const COLLECTOR_URL = resolved.collectorUrl;
// ... existing envelope build + POST
```

`POWER_PLATFORM_SKILLS_IKEY` and `POWER_PLATFORM_SKILLS_COLLECTOR` env vars become test-only overrides — production no longer sets them from the hook.

#### `shared/telemetry/lib/emit-spawn.js`

Forward one additional env var into the detached child:

```js
POWER_PLATFORM_SKILLS_CLOUD: process.env.POWER_PLATFORM_SKILLS_CLOUD || cloud || "",
```

#### `shared/telemetry/lib/with-telemetry.js`

Accepts `cloud` in opts and threads it into `spawnOpts.cloud` for `fireAndForget`. The pattern matches the existing way `configDir`, `fakeProbe`, etc. flow through.

### 3.3 Plugin-side changes

#### `plugins/power-pages/scripts/lib/telemetry/ikey.json` (restructured)

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
      "instrumentation_key": "<tenant-team-provisioned>",
      "collector_url": "https://tb.events.data.microsoft.com/OneCollector/1.0/"
    },
    "high": {
      "instrumentation_key": "<tenant-team-provisioned>",
      "collector_url": "https://tb.events.data.microsoft.com/OneCollector/1.0/"
    },
    "dod": {
      "instrumentation_key": "<tenant-team-provisioned>",
      "collector_url": "https://pf.events.data.microsoft.com/OneCollector/1.0/"
    },
    "mooncake": {
      "instrumentation_key": "<tenant-team-provisioned>",
      "collector_url": "https://collector.azure.cn/OneCollector/1.0/"
    }
  }
}
```

`us` and `eu` share the iKey (same as VSCode's `US_AND_EU`). Sovereign cloud iKeys await tenant provisioning; placeholder values are safe because `disabled: true` ships.

#### `plugins/power-pages/hooks/*.js` and `plugins/power-pages/scripts/lib/telemetry-runner.js`

Three hooks + the runner each gain ~5 LOC:

- Read `cloud` from `pac-auth.js`'s returned object (already calling `readPacAuth()` for orgId/tenantId).
- Pass `cloud` in `spawnOpts` to `fireAndForget` so `emit-spawn` can forward it.
- Update the gate-4 check from `if (!ikey) process.exit(0)` to `if (!cfg.regions?.[cfg.default_region]?.instrumentation_key) process.exit(0)`.

---

## 4. Data flow — first run vs steady state

### First run after `disabled: false` ships

1. Hook runs (~3-5s for PAC + agent-info), spawns detached child, returns.
2. Detached child reads `ikey.json` → `disabled: false`, proceeds.
3. `region-resolver` reads cache → miss.
4. Calls Artemis with `(orgId, cloud=Public)` → 1 HTTPS GET (~200-500ms). User session unaffected (child is detached).
5. Artemis returns `{ geoName: "us", stamp: "PROD" }`.
6. `mapToRegion("Public", "us")` → `"us"`. Looks up `regions.us`, gets iKey + collector URL.
7. Writes cache entry with `expiresAt = now + 24h`.
8. Builds CS4.0 envelope with the resolved iKey + name (`event_stream_name`).
9. POSTs to `us-mobile.events.data.microsoft.com`.
10. Row lands in `PagesPluginEvent` Kusto table.

### Steady state (subsequent hook invocations)

Steps 1-2 unchanged. Step 3 returns a cache hit. Steps 4-7 skipped. Steps 8-10 proceed normally. **Dispatcher cost: ~5ms file read + ~50-200ms HTTPS POST**, all detached.

---

## 5. Failure modes

Every failure resolves to "telemetry still emits to some cluster" or "telemetry exits silently". Never a thrown exception in the hook caller.

| Failure | Behavior | Result |
|---|---|---|
| `pac auth who` fails or PAC not installed | `pac-auth.js` catches, returns `null` | Event emits without `orgId`/`tenantId`/`cloud` — `region-resolver` short-circuits to `default_region` |
| `Cloud:` missing in PAC output | `pac-auth.js` returns `cloud: ""` | Artemis URL defaults to Public template; matches typical user |
| `region-cache.json` corrupted | `region-cache.read()` returns `null` | Cache miss → fresh Artemis call; cache overwritten on success |
| Artemis network failure / proxy / DNS | `artemis-service.fetchGeo()` returns `null` | `region-resolver` returns `regionsMap[default_region]` |
| Artemis timeout (5s) | Same as above | Same |
| Unknown `cloud` value | `artemis-service` treats as Public | Public URL tried; geoName drives region, default if unknown |
| `regions[<resolved>]` missing in config | `region-resolver` falls back to `regions[default_region]` | Default region used |
| `regions[default_region]` also missing | `region-resolver` returns `null`; dispatcher's existing keyMissing path takes over (local JSONL or silent exit) | No throw |
| Dispatcher process crashes | Existing `process.on("uncaughtException")` handler exits 0 | User never knows |

---

## 6. Privacy and security invariants

1. **`FIELD_TYPES` allowlist still applies twice.** Builders in `events.js` filter event fields; `sanitizeData()` in the dispatcher re-applies the same filter. Region routing does NOT change event payload contents.
2. **Kill switch wins.** `ikey.json` `disabled: true` short-circuits BEFORE region resolution runs. No Artemis call, no cache write, no POST.
3. **Env opt-out wins.** `POWER_PLATFORM_SKILLS_TELEMETRY=0` short-circuits BEFORE region resolution.
4. **Artemis call doesn't expose PII.** Only the orgId GUID is sent (no user-identifiable data). The URL is the public org-gateway URL, same one used by every PAC client.
5. **Cache file lives in user's home directory** (`~/.power-platform-skills/region-cache.json`), not in the repo or a shared temp dir.
6. **No iKey rotation logic** in code. iKeys are rotated by editing `ikey.json` in a PR; the resolver picks up new values on next dispatcher start (no in-memory cache of iKey state).

---

## 7. Cost picture

| State | Hook cost | Dispatcher cost (background) |
|---|---|---|
| `disabled: true` (production default) | ~5ms (gate 3 short-circuit) | n/a — no spawn |
| `POWER_PLATFORM_SKILLS_TELEMETRY=0` | ~5ms (gate 1 short-circuit) | n/a |
| `disabled: false` + cache hit (>99% of cases) | ~3-5s (unchanged: existing PAC shellouts) | ~50-200ms (cache read + envelope build + POST) |
| `disabled: false` + cache miss (first per 24h) | ~3-5s (unchanged) | ~200-700ms (cache miss + Artemis + cache write + POST) |
| `disabled: false` + Artemis fails | ~3-5s | ~10ms then POST to `default_region` |

User-visible latency is unchanged from today.

---

## 8. Testing

Following the existing `node:test` pattern (hermetic, no network, no real PAC).

### Unit tests (new files)

| File | Coverage |
|---|---|
| `shared/telemetry/tests/artemis-service.test.js` | URL construction per cloud (~7 cases); fail paths (network, non-2xx, bad JSON, missing geoName, timeout); unknown cloud falls back to Public |
| `shared/telemetry/tests/region-resolver.test.js` | No-orgId → default; cache hit; cache miss + Artemis success; Artemis fail → default; switch over `(cloud, geoName)` per row in §3 table; missing default_region in map → returns null |
| `shared/telemetry/tests/region-cache.test.js` | Missing file → null; malformed JSON → null; expired entry → null; fresh entry returned; write creates file with TTL; concurrent multi-orgId entries coexist |

### Unit tests (extending existing files)

| File | Additions |
|---|---|
| `shared/telemetry/tests/pac-auth.test.js` | Parses `Cloud:` in addition to existing fields; missing `Cloud:` returns empty string |
| `shared/telemetry/tests/emit-dispatcher.test.js` | Dispatcher uses cache-hit values for POST; cache miss + injected fake Artemis routes to resolved cluster; missing orgId → default_region; `regions.gov` entry routed to GOV endpoint when env CLOUD=Gov; FAKE_HTTPS probe captures resolved iKey/url |
| `plugins/power-pages/scripts/tests/telemetry-hook-pretool.test.js` | Hook reads `cloud` from PAC and forwards as env var to detached child; missing cloud → empty string forwarded |

### E2E verification

The diagnostic scripts in `.omc/` are reused: a burst script targeting each cluster's iKey + collector URL, run once per cluster to verify the tenant-side annotations and tables are wired up for all 6 regions. This is manual / one-time, not part of CI.

### Test count delta

- Existing: 110 shared + ~10 plugin
- New: ~25 (artemis 7 + resolver 10 + cache 6 + pac-auth 2)
- Extending: ~4
- Target: ~150 tests passing

---

## 9. Out of scope (deferred work)

- **Moving PAC shellouts to the dispatcher.** Would reduce hook latency from 3-5s to ~5ms in the enabled state. Considered, declined for this iteration: keeps the scope tight and preserves the existing event-construction-in-hook invariant.
- **Active cache invalidation on PAC profile change.** Watching `%LOCALAPPDATA%\Microsoft\PowerAppsCli` mtime would catch org switches instantly; instead we rely on orgId-keyed cache (different org = different cache entry, no staleness) and the 24h TTL safety net.
- **Per-plugin extension of the resolver.** This spec is for power-pages only. When canvas-apps / code-apps / model-apps adopt, the resolver code is already shared; they add their own `regions` map in their own `ikey.json`.
- **Provisioning the 4 sovereign-cloud iKeys.** Tenant-team work, separate from code. Placeholder values are safe while `disabled: true` ships.
- **Removing the env-var test seams** (`POWER_PLATFORM_SKILLS_IKEY`, `POWER_PLATFORM_SKILLS_COLLECTOR`, `POWER_PLATFORM_SKILLS_FAKE_HTTPS`, `POWER_PLATFORM_SKILLS_IKEY_JSON`). They're still useful for tests; production no longer sets them but they remain as overrides.

---

## 10. Implementation order

Roughly the order the implementation plan will follow:

1. Extend `pac-auth.js` to parse `Cloud:` + tests.
2. Create `region-cache.js` (no external deps) + tests.
3. Create `artemis-service.js` (only depends on Node `https`) + tests.
4. Create `region-resolver.js` (depends on the previous two) + tests.
5. Extend `emit-spawn.js` to forward `POWER_PLATFORM_SKILLS_CLOUD`.
6. Extend `emit-dispatcher.js` to call `region-resolver` + update tests.
7. Restructure `plugins/power-pages/scripts/lib/telemetry/ikey.json` (regions map).
8. Update three hooks + `telemetry-runner.js` to pass `cloud` through.
9. Update plugin's hook tests for the new env var.
10. Sync to plugin via `sync-to-plugin.js` and run the full suite.
11. E2E verification with diagnostic scripts against each provisioned cluster.
