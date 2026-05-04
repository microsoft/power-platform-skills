# 1DS Telemetry Rebuild — Design Spec

**Date:** 2026-05-04
**Status:** Draft — pending implementation plan
**Branch:** `users/amitjosh/1ds-infra`
**Supersedes:**
- `docs/superpowers/specs/2026-04-20-1ds-telemetry-design.md` (deleted)
- `docs/superpowers/plans/2026-04-22-1ds-telemetry.md` (deleted)
- `docs/superpowers/plans/2026-04-23-slash-command-telemetry.md` (deleted)
- `docs/superpowers/specs/2026-04-27-1ds-telemetry-team-presentation.md` (deleted)

**Still authoritative alongside this spec:**
- `docs/superpowers/specs/2026-04-23-slash-command-telemetry-design.md` — UserPromptSubmit hook architecture (envelope details there are superseded; plumbing rationale stands).
- `docs/superpowers/specs/2026-04-29-1ds-telemetry-plugin-adoption-guide.md` — multi-plugin adoption guide; aligns with the per-plugin-cluster model below.

---

## 1. Problem and Goals

### Problem

The previous design (April 20–27) routed events through the same `VscodeEvent` envelope name and `PagesPowerPlatformExtEvent` Kusto table that the Power Platform VSCode extension uses. This forced our payload to share a schema designed for an unrelated tool: per-event fields had to be flattened into a stringified `eventInfo` column, and our events became invisible filter-noise in someone else's table. Cross-plugin reuse was awkward because every adopting plugin had to ride the same shared table.

### Goals

- Each adopting plugin owns its own Kusto cluster, table, and `EventStreamingAnnotation`. The shared library at `shared/telemetry/` stays plugin-agnostic — it knows nothing about specific envelope names or column conventions.
- Per-event fields land as **first-class top-level Kusto columns**, not inside a stringified blob. Dashboards filter by `where SkillName == "add-seo"` instead of `where parse_json(EventInfo).skill_name == "add-seo"`.
- Capture `OrgId` and `TenantId` when the user is logged in via PAC CLI, best-effort.
- Replace the existing builders wholesale on this branch; no co-existence layer.
- Preserve every fail-closed invariant from prior designs — telemetry never blocks or alters user-facing flow.

### Non-Goals

- Provisioning the `EventStreamingAnnotation` and Kusto table — that's tenant-side work in a separate Geneva/Aria config repo. This spec ships a draft annotation file for handoff (§5).
- Backward-compatibility with the prior `VscodeEvent` shape. This branch is the rebuild.
- Multi-plugin rollout. The adoption guide handles cross-plugin onboarding once `power-pages` is stable on the new schema.

---

## 2. Architecture

```
plugin's ikey.json    ┐
                       ├──►  hook wrapper  ──►  events.js builder  ──►  fireAndForget  ──►  emit-dispatcher  ──►  HTTPS POST
PAC auth profile  ────┘                                                                                          │
                                                                                                                  ▼
                                                                                                  PowerPagesPluginEvent (Kusto table)
```

The shared library is unchanged conceptually:

- `lib/emit-dispatcher.js` — detached child that POSTs the envelope and exits. **Unchanged.**
- `lib/emit-spawn.js` — spawns the dispatcher with restricted env. **Unchanged.**
- `lib/consent.js`, `lib/local-log.js`, `lib/correlation.js`, `lib/session.js`, `lib/scrubber.js` — **Unchanged.**
- `lib/events.js` — **rewritten** for the new schema (§4).
- `lib/pac-auth.js` — **new** (§3).

The envelope name is per-plugin configuration carried alongside the iKey in `ikey.json`. Hook wrappers read it and pass it to the builders. The shared library never hard-codes a value.

---

## 3. Per-Plugin Configuration

`ikey.json` gains one new field:

```json
{
  "ikey": "<plugin's tenant iKey, write-only identifier>",
  "collector_url": "<region-appropriate OneCollector URL>",
  "event_stream_name": "PowerPagesPluginEvent"
}
```

Each adopting plugin sets its own `event_stream_name` to match the registered annotation for its own cluster. The dev-time `shared/telemetry/ikey.json` keeps the placeholder iKey + a placeholder stream name (`"PluginEventStreamPlaceholder"`). The synced plugin copy under `plugins/<plugin>/scripts/lib/telemetry/ikey.json` carries the real plugin-specific values.

---

## 4. Event Schema

### Envelope

```json
{
  "ver": "4.0",
  "name": "<event_stream_name from ikey.json>",
  "time": "<ISO 8601>",
  "iKey": "o:<32-hex prefix of full iKey>",
  "data": { /* see column set below */ }
}
```

Body is `JSON.stringify(envelope) + "\n"` for `application/x-json-stream` framing. Headers unchanged: `Content-Type: application/x-json-stream; charset=utf-8`, `x-apikey: <full iKey>`, `Content-Length: <bytes>`.

### Common columns (every event)

| Wire key (camelCase) | Kusto column | Type | Source | Always populated |
|---|---|---|---|---|
| `eventName` | `EventName` | string | per-event identifier | ✓ |
| `eventType` | `EventType` | string | always `"Trace"` | ✓ |
| `severity` | `Severity` | string | `"Info"` (default), `"Error"` for failure-outcome events | ✓ |
| `pluginName` | `PluginName` | string | from plugin's `.claude-plugin/plugin.json` | ✓ |
| `pluginVersion` | `PluginVersion` | string | from plugin's `.claude-plugin/plugin.json` | ✓ |
| `sessionId` | `SessionId` | string | per-process UUID via `getSessionId()` | ✓ |
| `correlationId` | `CorrelationId` | string | UUID joining started/completed pairs | ✓ |
| `osName` | `OsName` | string | mapped from `process.platform` (`Windows`/`Mac`/`Linux`) | ✓ |
| `osVersion` | `OsVersion` | string | from `os.release()` | ✓ |
| `nodeVersion` | `NodeVersion` | string | major version, e.g. `"v22"` | ✓ |
| `orgId` | `OrgId` | string | from active PAC auth profile | only when PAC active |
| `tenantId` | `TenantId` | string | from active PAC auth profile | only when PAC active |

### Skill-event columns (`skill_started`, `skill_completed`)

| Wire key | Kusto column | Notes |
|---|---|---|
| `skillName` | `SkillName` | Always populated for skill events (e.g., `"add-seo"`). |

### Script-event columns (`script_started`, `script_completed`)

| Wire key | Kusto column | Notes |
|---|---|---|
| `scriptName` | `ScriptName` | Always populated for script events (e.g., `"deploy-site"`). |

### Completion-event columns (`*_completed`)

| Wire key | Kusto column | Notes |
|---|---|---|
| `outcome` | `Outcome` | `"success"` or `"failure"`. Drives `Severity`. |
| `durationMs` | `DurationMs` | non-negative integer; clamped to 0 if negative. |
| `errorClass` | `ErrorClass` | constructor name only (e.g., `"TypeError"`); empty string on success. |

### Explicitly NOT sent

File paths, working directories, environment variables (except the telemetry off-switch), error messages, stack traces, prompt text, tool inputs, Dataverse URLs, user names, host names. The `pick()` allowlist in `lib/events.js` is the single chokepoint that enforces this — anything not in the per-event allowlist is dropped at the builder boundary.

### Severity mapping

`severity` defaults to `"Info"`. The `*_completed` builders set `severity = "Error"` when `outcome === "failure"`. No `Warning` level is currently emitted; future events that warrant it can override.

---

## 5. EventStreamingAnnotation Deliverable

For handoff to the tenant team that owns Geneva/Aria provisioning, the relevant annotation content is shown below. The implementation plan will save it as a standalone file under `docs/superpowers/handoff/` so it can be copied into the provisioning repo as-is.

```xml
<EventStreamingAnnotation name="^PowerPagesPluginEvent$">
  <Indexing>
    <Content><![CDATA[
    {
      "Interchange": {
        "CollectorEventMappingList": ["<iKey-32-hex-prefix>:PowerPagesPluginEvent"],
        "FieldNameMappings": [
          "data_eventName:EventName",
          "data_eventType:EventType",
          "data_severity:Severity",
          "data_pluginName:PluginName",
          "data_pluginVersion:PluginVersion",
          "data_sessionId:SessionId",
          "data_correlationId:CorrelationId",
          "data_osName:OsName",
          "data_osVersion:OsVersion",
          "data_nodeVersion:NodeVersion",
          "data_skillName:SkillName",
          "data_scriptName:ScriptName",
          "data_outcome:Outcome",
          "data_durationMs:DurationMs",
          "data_errorClass:ErrorClass",
          "data_orgId:OrgId",
          "data_tenantId:TenantId",
          "iKey:iKey",
          "ver:Ver"
        ],
        "IncludeFields": [
          "EventName", "EventType", "Severity",
          "PluginName", "PluginVersion",
          "SessionId", "CorrelationId",
          "OsName", "OsVersion", "NodeVersion",
          "SkillName", "ScriptName",
          "Outcome", "DurationMs", "ErrorClass",
          "OrgId", "TenantId",
          "iKey", "Ver"
        ],
        "EnableOriginalMessage": false
      }
    }
    ]]></Content>
  </Indexing>
</EventStreamingAnnotation>
```

The `<iKey-32-hex-prefix>` is the first 32 hex chars of the full iKey before any dash. The annotation registers the `(iKey, "PowerPagesPluginEvent")` tuple, without which OneCollector silently drops events even though it returns `acc:1`.

---

## 6. Components

### 6.1 `lib/events.js` (rewritten)

```js
const COMMON_FIELDS = [
  "pluginName", "pluginVersion", "sessionId", "correlationId",
  "osName", "osVersion", "nodeVersion", "orgId", "tenantId",
];
const SKILL_FIELDS = ["skillName"];
const SCRIPT_FIELDS = ["scriptName"];
const COMPLETED_FIELDS = ["outcome", "durationMs", "errorClass"];

function pick(input, keys) { /* same allowlist enforcement as before */ }
function clampDuration(ms) { /* unchanged */ }

function buildEvent(envelopeName, eventName, info, severity = "Info") {
  if (info.durationMs !== undefined) info.durationMs = clampDuration(info.durationMs);
  return {
    name: envelopeName,
    data: { eventName, eventType: "Trace", severity, ...info },
  };
}

function buildSkillStarted(envelopeName, input) {
  return buildEvent(envelopeName, "skill_started",
    pick(input, [...COMMON_FIELDS, ...SKILL_FIELDS]));
}

function buildSkillCompleted(envelopeName, input) {
  const severity = input.outcome === "failure" ? "Error" : "Info";
  return buildEvent(envelopeName, "skill_completed",
    pick(input, [...COMMON_FIELDS, ...SKILL_FIELDS, ...COMPLETED_FIELDS]),
    severity);
}

function buildScriptStarted(envelopeName, input) { /* analogous */ }
function buildScriptCompleted(envelopeName, input) { /* analogous; same severity rule */ }

module.exports = { buildSkillStarted, buildSkillCompleted, buildScriptStarted, buildScriptCompleted };
```

The envelope name is no longer a hard-coded constant inside the library — it comes from the caller, which reads it from `ikey.json`. No `COLLECTOR_EVENT_NAME` export.

### 6.2 `lib/pac-auth.js` (new)

```js
function readPacAuth() {
  // Returns { orgId: string, tenantId: string } when an active PAC profile
  // exists and is parseable; null otherwise. Synchronous. Never throws.
}
```

Reads PAC's profile file directly — no shell-out to `pac auth who`, which would add a hard dependency, slow down the hook, and risk timeouts. Profile path resolution:

- Windows: `%LOCALAPPDATA%/Microsoft/PowerAppsCLI/auth/<active>.json`
- Linux/Mac: `~/.local/share/Microsoft/PowerAppsCLI/auth/<active>.json`

If the directory or file is absent, `pac` is uninstalled, the format has changed, or the user has not authed, the function returns `null` and the resulting event simply omits `orgId`/`tenantId`.

The exact PAC profile structure to parse will be confirmed during implementation by inspecting a freshly authed `pac auth create` artifact. If the format proves unstable across PAC versions, the implementation falls back to omitting these fields rather than guessing.

### 6.3 Hook wrappers (modified)

`run-skill-pretool-telemetry.js`, `run-skill-posttool-validation.js`, and `run-user-prompt-telemetry.js` change as follows:

1. Read `event_stream_name` from `ikey.json` alongside `ikey` and `collector_url`.
2. Read PAC auth via `pac-auth.readPacAuth()`; spread result (or empty object) into the builder input.
3. Convert `process.platform` to a friendly OS name (`win32`→`"Windows"`, `darwin`→`"Mac"`, `linux`→`"Linux"`).
4. Read `os.release()` for `osVersion`.
5. Pass the envelope name as the first argument to the builder.

The hook wrappers themselves keep their existing structure — fail-closed try/catch envelopes, env-var forwarding, top-level `process.exit(0)`.

---

## 7. Failure-Mode Invariants (unchanged)

| Failure | Behavior |
|---|---|
| `ikey.json` missing or unreadable | Hook reads empty values; dispatcher exits 0 silently. No event emitted. |
| `event_stream_name` missing in `ikey.json` | Builder emits with envelope `name` set to `""`; the dispatcher still POSTs but the event will fail annotation matching at the tenant. Documented as "operator misconfiguration" — visible only via 0-row Kusto results, not user-facing failure. |
| PAC profile missing/unparseable | `orgId`/`tenantId` absent from event. No error. |
| HTTPS POST timeout (4 s) | Dispatcher exits 0 silently. |
| Consent `disabled` or `POWER_PLATFORM_SKILLS_TELEMETRY=0` | Dispatcher exits 0 silently after consent check; no POST. |
| Hook timeout (30 s) | Hook is killed; user prompt is unaffected. |

Telemetry never alters exit codes or blocks the parent process.

---

## 8. Privacy Invariants

- The `pick()` allowlist in `events.js` is the only place where field names enter the payload.
- Prompt text never reaches the dispatcher — only the detected `skillName` makes it past the hook boundary (this is the behavior already shipped by the slash-command telemetry design).
- `errorClass` is the constructor name only. Error messages and stack traces are explicitly out of scope.
- `orgId` and `tenantId` are GUIDs. No display names, email addresses, or UPNs are read from PAC's profile.
- The dispatcher's child env contains a fixed allowlist (PATH, SystemRoot, HOME, USERPROFILE, APPDATA, plus the four `POWER_PLATFORM_SKILLS_*` config vars). No ambient secrets leak.

---

## 9. Testing

| File | Coverage |
|---|---|
| `events.test.js` (rewritten) | Each builder returns the new shape; per-event allowlist enforced; severity mapping (`Info` for started, `Info` for success-completed, `Error` for failure-completed); `durationMs` clamped to non-negative; envelope `name` flows through from the parameter. |
| `pac-auth.test.js` (new) | Fixture-driven: profile present (returns `{orgId, tenantId}`), profile missing (returns `null`), profile unparseable (returns `null`), throws-on-read (returns `null`). Never throws. |
| `emit-dispatcher.test.js` (updated) | Probe body has the expected top-level keys (no nested `eventInfo`); `name` matches the configured envelope name; trailing newline; consent gating unchanged. |
| `emit-from-prompt.test.js` (updated) | Stubbed emitter captures the full event; assert all common fields populated; `pac-auth` mocked to return both fixed value and `null`. |
| Plugin integration test (`run-user-prompt-telemetry.test.js`) | Real hook invocation via `FAKE_HTTPS` probe; assert the wire body contains `name: "PowerPagesPluginEvent"` (or whatever the test ikey.json sets), top-level fields, and trailing newline. |

---

## 10. Migration on This Branch

The branch `users/amitjosh/1ds-infra` is the rebuild. The implementation plan will sequence the work as: rewrite `events.js`, add `pac-auth.js`, update three hook wrappers, update tests, re-sync to the plugin, fire a real event, verify the envelope shape end-to-end. No co-existence with the prior `VscodeEvent` shape.

The deleted spec/plan docs (listed at the top) were removed in this same change. The slash-command-telemetry-design and plugin-adoption-guide remain authoritative as noted.

---

## 11. Open Items (deferred to implementation plan)

- Confirm the exact PAC auth profile JSON structure (path resolution and field names) by inspecting an authed instance during implementation.
- Confirm the regional OneCollector URL each plugin should use (INT for testing, region-specific prod URLs from the VSCode constants table).
- Decide whether `osLabel` (e.g., `"Windows 10.0.26200"`) is worth a dedicated column or should be derivable from `OsName + OsVersion` at query time. (Default: derive at query time, no dedicated column.)
- Whether the dev-time placeholder `event_stream_name` should make the dispatcher take the local-log path automatically (parallel to how a placeholder iKey already does). Likely yes — added during implementation to keep dev-time behavior identical to the previous design.
