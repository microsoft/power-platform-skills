# 1DS Telemetry Infrastructure — Design Spec

**Date:** 2026-04-20 (revised 2026-04-22)
**Status:** Draft — pending implementation plan
**Scope:** Add Microsoft 1DS (One Data Strategy) telemetry to the `power-platform-skills` plugin marketplace, wired into the `power-pages` plugin as the first consumer. A shared library under `shared/telemetry/` is the canonical source; other plugins adopt by running a sync script.

**2026-04-22 revision:** After reviewing the `agency-microsoft/playground/plugins/claude-telemetry` implementation and the POC results, this spec drops the `@microsoft/1ds-*` SDK and uses Node's built-in `https` module directly. Hooks also adopt a detached-child dispatcher pattern so they return in ~50 ms regardless of collector latency. Payload shape remains Common Schema 4.0 (what our POC verified via `acc:N`).

---

## 1. Goals and Non-Goals

### Goals

- Emit Microsoft 1DS telemetry events for skill lifecycle and Node script outcomes in the `power-pages` plugin.
- Establish a shared telemetry library at `shared/telemetry/` that additional plugins (`canvas-apps`, `code-apps`, `mcp-apps`, `model-apps`) can adopt without redesign.
- Respect user consent via an interactive first-run prompt; never emit without consent.
- Send only a strict allowlist of fields — no paths, inputs, IDs, or error messages.
- Fail closed: telemetry code never blocks or breaks a skill run.

### Non-Goals

- Wiring telemetry into the four non-`power-pages` plugins in this pass (they adopt later via the sync script).
- Instrumenting Dataverse HTTP calls individually (event volume too high for an initial rollout).
- Persisting events to disk when offline (no local queue; dropped events are acceptable).
- npm dependencies of any kind. The telemetry library is zero-dep — built on Node's `https`, `child_process`, and `fs` modules only.

---

## 2. Architectural Overview

### 2.1 Repository layout

The canonical source lives at `shared/telemetry/`. A sync script copies it into each adopting plugin. Only the synced copy under `plugins/<plugin>/scripts/lib/telemetry/` runs at user time; the `shared/` directory is development-time only (not shipped to users via the marketplace).

```
shared/telemetry/
├── README.md                          # Purpose, data sent, sync instructions
├── ikey.json                          # iKey + OneCollector URL (no secrets — iKey is a write-only identifier)
├── sync-to-plugin.js                  # Copies lib/ + ikey.json into a plugin. No package.json to copy.
├── lib/
│   ├── emit-dispatcher.js             # CLI: reads event JSON on stdin, POSTs Common Schema 4.0, exits
│   ├── emit-spawn.js                  # Tiny helper: spawns emit-dispatcher.js detached + hands it the JSON
│   ├── consent.js                     # Read/write ~/.power-platform-skills/telemetry.json
│   ├── events.js                      # Event builders with strict allowlists
│   ├── session.js                     # Per-process anonymized UUID
│   ├── scrubber.js                    # No-op placeholder for future PII regex
│   ├── check-consent.js               # CLI: stdout "NEEDS_PROMPT" | "ENABLED" | "DISABLED"
│   ├── record-consent.js              # CLI: --answer yes|no writes the consent file
│   └── with-telemetry.js              # Wrapper for plugin Node scripts; calls emit-spawn

plugins/power-pages/
├── scripts/lib/telemetry/             # Synced copy of shared/telemetry/lib + ikey.json
│                                      # Tracked in git; do NOT hand-edit; no node_modules here
├── hooks/
│   ├── hooks.json                     # Adds PreToolUse:Skill; keeps existing PostToolUse:Skill
│   ├── run-skill-pretool-telemetry.js # New: emits skill_started via emit-spawn
│   └── run-skill-posttool-validation.js  # Existing; extended to emit skill_completed via emit-spawn
└── references/
    └── telemetry-consent-reference.md # Shared Phase-1 pointer doc every SKILL.md includes
```

### 2.2 Runtime components

1. **Consent gate** (`lib/consent.js`) — Reads `~/.power-platform-skills/telemetry.json`. Hooks and the dispatcher read this synchronously; if missing or `enabled: false`, they exit 0 silently. The interactive prompt runs inside a skill's Phase 1 (hooks cannot invoke `AskUserQuestion`).
2. **Dispatcher** (`lib/emit-dispatcher.js`) — A standalone Node CLI. Reads one event JSON on stdin, reads `POWER_PLATFORM_SKILLS_IKEY` and `POWER_PLATFORM_SKILLS_COLLECTOR` from env, re-checks consent, wraps the event in a Common Schema 4.0 envelope, POSTs it via `https.request(...)`, and exits when the response arrives or 4 s passes. Runs in its own OS process; its runtime is independent of the caller.
3. **Spawn helper** (`lib/emit-spawn.js`) — Exposes `fireAndForget(event, { iKey, collectorUrl })`. Spawns the dispatcher with `{ detached: true, stdio: ['pipe', 'ignore', 'ignore'] }`, writes the event JSON to the child's stdin, calls `child.unref()`, and returns synchronously. The parent exits without waiting.
4. **Emitters** — Three call sites all use `fireAndForget`: the PreToolUse hook, the PostToolUse hook (after the existing validator), and the `withTelemetry(scriptName, asyncFn)` wrapper used inside instrumented scripts. No code path anywhere in the plugin awaits a network round-trip.
5. **Event builders** (`lib/events.js`) — Pure functions per event type that accept raw input and return a payload containing only allowlisted fields. `fireAndForget` accepts nothing else; a test enforces this.

### 2.3 Data flow for one skill run

Every emission point calls `emit-spawn.fireAndForget` synchronously and then returns. The parent process never waits for the HTTPS POST. A detached dispatcher child performs the POST in the background.

```
User invokes /create-site
      │
      ▼
Skill Phase 1 runs:
  1. Existing plugin-version check (unchanged).
  2. node check-consent.js
       - outputs "ENABLED"      → continue
       - outputs "DISABLED"     → continue (dispatchers will still spawn, then no-op)
       - outputs "NEEDS_PROMPT" → AskUserQuestion; then
                                  node record-consent.js --answer yes|no
      │
      ▼
Claude invokes Skill tool
      │
      ├─► PreToolUse:Skill hook
      │     run-skill-pretool-telemetry.js  (parent, runs under 30s hook timeout)
      │       1. read stdin, detect tracked skill name
      │       2. write correlation file (correlation_id + start_ts)
      │       3. build skill_started event via events.js
      │       4. emit-spawn.fireAndForget(event)   →  detached dispatcher child
      │                                                ├─ re-check consent
      │                                                ├─ POST to OneCollector
      │                                                └─ exit when response arrives
      │       5. parent exits 0   (≈ 50 ms)
      │
      ▼
Skill body runs. Instrumented Node scripts wrap their main() in withTelemetry():
  ├─ emit-spawn.fireAndForget(script_started)   →  detached dispatcher
  ├─ await asyncFn()
  └─ emit-spawn.fireAndForget(script_completed) →  detached dispatcher
      │
      ├─► PostToolUse:Skill hook
      │     run-skill-posttool-validation.js
      │       1. Run existing per-skill validator (unchanged).
      │       2. Read correlation file.
      │       3. emit-spawn.fireAndForget(skill_completed)   →  detached dispatcher
      │          outcome = "success" if validator exit 0, "failure" otherwise.
      │       4. Clear correlation file.
      │       5. Exit with the validator's status code (telemetry does not change it).
```

---

## 3. Event Schema

All events use the 1DS Common Schema 4.0 envelope. Custom per-event fields live under the envelope's `data` property.

### 3.1 Fields common to every event (allowlisted)

| Field | Source | Example |
|---|---|---|
| `plugin_name` | `plugins/power-pages/.claude-plugin/plugin.json` | `"power-pages"` |
| `plugin_version` | same | `"1.2.2"` |
| `session_id` | random UUIDv4 generated once per Node process (not persisted) | `"f7c2..."` |
| `os_family` | `process.platform` | `"win32"`, `"darwin"`, `"linux"` |
| `node_version` | `process.versions.node` → major only | `"v22"` |
| `correlation_id` | random UUIDv4 per skill or script invocation | `"a3e1..."` |

### 3.2 Event-specific fields

| Event | Additional fields |
|---|---|
| `skill_started` | `skill_name` |
| `skill_completed` | `skill_name`, `outcome` (`"success"` or `"failure"`), `duration_ms` (number), `error_class` (constructor name or `""`) |
| `script_started` | `script_name` (explicit string arg to `withTelemetry`) |
| `script_completed` | `script_name`, `outcome`, `duration_ms`, `error_class` |

### 3.3 Fields explicitly never sent

- `cwd`, absolute file paths
- Environment variables (except the telemetry consent flag, and only as a boolean)
- Tenant IDs, site names, site URLs, Dataverse org URLs
- Error `.message` strings, stack traces
- Skill arguments, tool inputs
- Usernames, email addresses, hostnames

Builders in `events.js` pick only allowlisted keys; unknown fields are dropped. A `node:test` asserts the final payload contains exactly the expected keyset for every event type.

---

## 4. Consent Flow

### 4.1 Consent file

Location: `~/.power-platform-skills/telemetry.json`

```json
{
  "version": 1,
  "enabled": true,
  "consented_at": "2026-04-20T18:04:00Z",
  "prompt_version": 1
}
```

- `version` — Schema version. A bump (e.g., to `2`) forces re-prompt on the next skill run.
- `prompt_version` — Version of the consent prompt text. Bump to force re-prompt (e.g., when the privacy statement URL changes).
- `enabled` — Boolean. Only `true` permits emission.
- `consented_at` — ISO 8601 timestamp.

A malformed or unreadable file is treated as "absent" → prompt again.

### 4.2 Prompt

The prompt is declared once in `shared/telemetry/references/telemetry-consent-reference.md` (synced into each plugin's `references/`). Every tracked SKILL.md adds this one-liner in Phase 1, immediately after the existing plugin-version check:

```markdown
> **Telemetry consent**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/check-consent.js"` —
> if it outputs `NEEDS_PROMPT`, use AskUserQuestion to ask the user per
> `${CLAUDE_PLUGIN_ROOT}/references/telemetry-consent-reference.md` and then run
> `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/record-consent.js" --answer yes|no`.
```

The AskUserQuestion payload (defined once in the reference doc):

- **Question:** "Share anonymous usage telemetry with Microsoft?"
- **Body:** "The power-pages plugin can send anonymous usage signals (skill name, success/failure, duration, OS family, plugin version) to Microsoft to help improve these tools. No paths, inputs, tenant data, or error messages are sent. The full field list is at `shared/telemetry/README.md` in the repo. Your answer is saved at `~/.power-platform-skills/telemetry.json`; edit that file any time to change it."
- **Options:**
  - `"Yes, enable telemetry"`
  - `"No, keep it off"`

### 4.3 Override

- `POWER_PLATFORM_SKILLS_TELEMETRY=0` — Disables emission regardless of the file. Checked by the dispatcher at the top of every run; dispatcher exits 0 without POSTing.
- Any other value (including `1`, unset, empty) — No effect. Emission is governed entirely by the consent file. The env var is a one-way off switch only; it cannot enable telemetry that the user has not explicitly consented to via the file.

### 4.4 Hook behavior when consent is absent

Both hooks exit 0 silently. No stderr noise (gate debug output behind `process.env.DEBUG`, matching the existing `run-skill-posttool-validation.js` convention). The prompt runs exclusively inside the skill body.

**Consequence:** the *very first* skill invocation on a fresh machine emits no events — the consent prompt happens during that run. Every subsequent run emits normally.

---

## 5. Hook Wiring

### 5.1 `plugins/power-pages/hooks/hooks.json` (new contents)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/run-skill-pretool-telemetry.js\"",
            "timeout": 30
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/run-skill-posttool-validation.js\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 5.2 `run-skill-pretool-telemetry.js` (new)

Reads `tool_input`, calls `getTrackedSkillFromToolInput()` (existing helper), builds the `skill_started` event via `events.js`, and calls `emit-spawn.fireAndForget(event, { iKey, collectorUrl })`. Writes the `correlation_id` + `start_ts` to a short-lived OS-temp file (`os.tmpdir()/ppskills-corr-<skillName>.json`) so the PostToolUse hook can join. Always exits 0.

### 5.3 `run-skill-posttool-validation.js` (extended)

The existing validator flow is preserved byte-for-byte. A new block runs *after* the validator:

```js
const corr = correlation.read({ skillName }) || {
  correlation_id: crypto.randomUUID(),
  start_ts: Date.now(),
};
const outcome = validatorStatus === 0 ? 'success' : 'failure';
const duration_ms = Date.now() - corr.start_ts;

emitSpawn.fireAndForget(
  events.buildSkillCompleted({
    ...common,
    skill_name: skillName,
    correlation_id: corr.correlation_id,
    outcome,
    duration_ms,
    error_class: '',  // PostToolUse does not carry thrown-error info
  }),
  { iKey, collectorUrl }
);
correlation.clear({ skillName });
process.exit(validatorStatus ?? 0);
```

Telemetry emission never changes the validator's exit code. `fireAndForget` is synchronous — it spawns the detached dispatcher and returns before the HTTPS POST completes.

### 5.4 `withTelemetry(scriptName, asyncFn)` (new)

Consumed from inside plugin scripts:

```js
const { withTelemetry } = require('./lib/telemetry/with-telemetry');

async function main() { /* existing script body */ }

if (require.main === module) {
  withTelemetry('deploy-site', main).catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
```

`withTelemetry` calls `emit-spawn.fireAndForget(script_started)`, awaits `asyncFn()`, then calls `emit-spawn.fireAndForget(script_completed)` with the computed outcome. Neither emission blocks on the network — each one spawns a detached dispatcher and returns synchronously. The wrapper rethrows the original error unchanged so existing error handling is preserved.

**Initial scripts to instrument** (chosen for signal value):

- `scripts/deploy-site.js` *(if present — verify during implementation)*
- `scripts/check-activation-status.js`
- `scripts/verify-dataverse-access.js`
- `scripts/render-audit-report.js`
- Each validator under `scripts/`

Low-value scripts (`generate-uuid.js`, template renderers) are not instrumented.

---

## 6. Dependencies and Install

### 6.1 No npm dependencies

The telemetry library uses only Node built-ins (`node:https`, `node:child_process`, `node:fs`, `node:os`, `node:path`, `node:crypto`). There is no `package.json`, no `node_modules`, and no `npm install` step. This removes the single biggest friction point flagged in the earlier draft: users installing the plugin via the marketplace get a working telemetry stack immediately.

### 6.2 OneCollector POST shape

The dispatcher builds a Common Schema 4.0 envelope per event (what our POC verified via `acc:N`):

```js
{
  ver: "4.0",
  name: event.name,                    // "PowerPlatformSkillsEvent"
  time: new Date().toISOString(),
  iKey: "o:" + IKEY.split("-")[0],
  baseType: "Ms.WebClient.TraceEvent",
  baseData: event.data,                // { eventName, eventType, severity, eventInfo }
  data: event.data
}
```

Request headers:

- `Content-Type: application/x-json-stream; charset=utf-8`
- `x-apikey: <IKEY>`
- `Content-Length: <bytes>`

Collector URL comes from `ikey.json`'s `collector_url` field. A 4 s per-request timeout in the dispatcher; no retries; no local queue.

### 6.3 iKey provisioning

`shared/telemetry/ikey.json`:

```json
{
  "ikey": "PLACEHOLDER_REPLACE_BEFORE_SHIPPING",
  "collector_url": "https://self.events.data.microsoft.com/OneCollector/1.0/"
}
```

The iKey is committed in plaintext (Microsoft OSS precedent: VS Code, dotnet SDK, Azure CLI). It is a write-only identifier, not a secret. The tenant token and iKey must be provisioned through whichever Microsoft 1DS tenant owns this data before the first commit that replaces the placeholder. Until then, the dispatcher detects the placeholder string and exits 0 without POSTing, so `ikey.json` can be safely present in source control throughout development.

---

## 7. Failure Modes

All failure paths exit cleanly and never break the user's skill run.

| Failure | Behavior |
|---|---|
| Consent file missing | Hook exits 0 silently. Skill Phase 1 triggers prompt. |
| Consent file `enabled: false` | Hook still calls `fireAndForget`, dispatcher starts, re-reads consent, exits 0 without POSTing. |
| `POWER_PLATFORM_SKILLS_TELEMETRY=0` | Dispatcher reads env var at startup and exits 0 without POSTing. |
| Consent file malformed | Treated as missing → re-prompt. |
| `ikey.json` missing or placeholder | Dispatcher exits 0 without POSTing. No stderr. |
| Collector returns 4xx / 5xx | Dispatcher reads body, exits 0. No retry, no local queue. |
| HTTPS POST times out | Dispatcher's 4 s `setTimeout` destroys the request and exits 0. |
| DNS failure / network unreachable | Dispatcher's `req.on("error")` handler exits 0. |
| `spawn(...)` fails (out of FDs, etc.) | `fireAndForget`'s `try { ... } catch {}` swallows. Hook/script continues. |
| Detached child killed by OS before POST completes | Event dropped. No retry. Acceptable. |
| Event builder receives unexpected field | Dropped silently by the builder's allowlist; caught by `node:test` in CI, not at runtime. |
| Hook script throws during stdin-parsing | Top-level `.catch(() => process.exit(0))`. |
| Dispatcher script throws | Top-level `.catch(() => process.exit(0))`. |
| Validator throws in PostToolUse | Telemetry still emits with `outcome: "failure"` (fire-and-forget runs *after* validator); validator exit code is preserved. |

**Non-negotiable rules:**

- Telemetry code cannot raise a visible error in the parent's shell.
- Telemetry emission never changes a hook's or script's exit code.
- No PII-carrying field ever reaches the dispatcher — `events.js` builders enforce the allowlist *before* `emit-spawn.fireAndForget`.

Enforced by `telemetry-hook-pretool.test.js`, `telemetry-hook-posttool.test.js`, and `emit-dispatcher.test.js`, which inject throws at every mockable seam and assert `exit(0)`.

---

## 8. Testing

### 8.1 Layout

Mirrors the existing `scripts/tests/` convention (node:test, PowerShell runner, zero external deps):

```
shared/telemetry/tests/                # Canonical tests
  ├── emit-dispatcher.test.js
  ├── emit-spawn.test.js
  ├── consent.test.js
  ├── correlation.test.js
  ├── events.test.js
  ├── session.test.js
  ├── scrubber.test.js
  ├── with-telemetry.test.js
  └── sync-to-plugin.test.js

plugins/power-pages/scripts/tests/     # Plugin-specific hook tests
  ├── telemetry-hook-pretool.test.js
  └── telemetry-hook-posttool.test.js
```

Shared tests exercise the library once in its canonical location. Plugin-specific hook tests live inside the plugin because they depend on the plugin's hook-utils helper and directory layout.

### 8.2 Assertions per file

- **emit-dispatcher** — no-op when consent disabled; no-op when iKey is placeholder; no-op when env off-switch set; `req.on("error")` exits 0; `setTimeout` exits 0; happy path POSTs the expected Common Schema envelope (verified via an injected fake `https` module).
- **emit-spawn** — parent returns in <100 ms; `unref()` called; detached child receives the event JSON on stdin; `spawn` throws → caller continues without throwing.
- **consent** — read/write round-trip; malformed file → treated as absent; version bump forces re-prompt; prompt_version bump forces re-prompt; default path under `~/.power-platform-skills/`.
- **correlation** — write/read round-trip; read on missing file returns null; clear removes the file; non-existent file clear does not throw.
- **events** — each builder returns exactly the allowlisted keyset; unknown input keys dropped; `error_class` is the constructor name, never a message; `duration_ms` clamped to a non-negative integer.
- **session** — stable within a process; unique across processes.
- **scrubber** — identity function; never throws.
- **with-telemetry** — success path fires two detached children; rejection path fires two detached children and rethrows the original error.
- **sync-to-plugin** — copies `lib/` + `ikey.json`; copies `references/telemetry-consent-reference.md`; idempotent; exits non-zero on missing `--target`.
- **hooks** — happy path calls `fireAndForget` exactly once; missing consent still calls `fireAndForget` (dispatcher handles the no-op); malformed stdin → `exit(0)`; tracked-skill detection returns null → no-op + exit 0.

### 8.3 Live end-to-end test

`tests/live-1ds-post.test.js`, skipped unless `RUN_1DS_LIVE_TEST=1`. Posts one synthetic event using the real iKey and asserts a 200 response. Not run in CI by default to avoid polluting production telemetry.

---

## 9. Rollout Sequence

1. Land `shared/telemetry/` (library with dispatcher, spawn helper, consent, correlation, events, session, scrubber, with-telemetry, CLIs, sync script, tests, `ikey.json` placeholder). No plugin wiring yet. No npm install required.
2. Run `node shared/telemetry/sync-to-plugin.js --target plugins/power-pages` to populate the synced copy. Commit the synced files.
3. Add `plugins/power-pages/hooks/run-skill-pretool-telemetry.js` and update `plugins/power-pages/hooks/hooks.json` to register the PreToolUse:Skill entry.
4. Extend `plugins/power-pages/hooks/run-skill-posttool-validation.js` to call `fireAndForget(skill_completed)` after the validator.
5. Add `plugins/power-pages/references/telemetry-consent-reference.md` (synced).
6. Add the Phase-1 one-liner to every tracked SKILL.md (per the list in `scripts/lib/powerpages-hook-utils.js`).
7. Wrap the chosen high-value scripts (§5.4) in `withTelemetry(...)`.
8. Update `plugins/power-pages/AGENTS.md`, root `AGENTS.md`, and `README.md` with telemetry conventions and a link to `shared/telemetry/README.md`. No install instructions needed.
9. Provision the real iKey through the 1DS tenant and replace the placeholder in `ikey.json`. Re-sync.
10. Manual smoke test on a marketplace-installed plugin (not `--plugin-dir` — see §10 for rationale): fresh machine, run a tracked skill, observe the consent prompt, confirm "Yes", re-run, confirm an event reaches the 1DS collector via the tenant dashboard.

---

## 10. Open Implementation Details

Resolved items (kept for traceability):

- ~~Exact `@microsoft/1ds-core-js` and `@microsoft/1ds-post-js` version pins.~~ **Resolved:** SDK dropped in the 2026-04-22 revision; Node built-in `https` used directly.
- ~~Whether `plugins/power-pages/scripts/lib/telemetry/node_modules/` should be `.gitignore`d.~~ **Resolved:** no `node_modules` directory exists; no npm deps.
- **Correlation mechanism:** OS temp file at `os.tmpdir()/ppskills-corr-<skillName>.json` written by the PreToolUse hook, read + cleared by the PostToolUse hook. Keyed by skill name only (not PID) because both hooks run in separate short-lived Node processes.
- **Stdin shape:** the existing `getTrackedSkillFromToolInput(toolInput)` helper is proven by the in-prod validator hook; our hook scripts reuse it unchanged.

Pending items (the implementer resolves during build):

- **Marketplace-install-only E2E verification.** The POC confirmed that `--plugin-dir` dev mode does not register plugin hooks. The rollout smoke test (§9 step 10) must happen against a marketplace-installed copy of the plugin. Document this in the plan.
- **Collector URL endpoint selection for the real tenant.** `ikey.json` ships with a US/default endpoint; the provisioning step (§6.3) updates it to whatever region the tenant lives in.

---

## 11. Out of Scope (future work)

- Rolling the shared library out to `canvas-apps`, `code-apps`, `mcp-apps`, `model-apps` (each is a run of `sync-to-plugin.js` plus per-plugin hook wiring).
- Dataverse API-call–level telemetry.
- Richer error-class taxonomy (HTTP status codes, known error kinds from `validation-helpers.js`).
- A local event queue for offline runs.
- An `opt-in` consent posture; today's posture is interactive-first-run per the brainstorm.
