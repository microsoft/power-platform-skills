# 1DS Telemetry — Design Review

**Date:** 2026-04-27
**Author:** Amit Joshi
**Status:** Implemented on `users/amitjosh/1ds-telemetry`; not yet rolled out to other plugins
**Audience:** Engineering peers
**Purpose:** Critique the approach. The full internal spec lives at `docs/superpowers/specs/2026-04-20-1ds-telemetry-design.md` — this doc is meant to stand alone.

---

## 1. TL;DR

- We added Microsoft 1DS telemetry to the `power-platform-skills` plugin marketplace, wired into `power-pages` as the first consumer.
- The shared library lives at `shared/telemetry/` and is **synced** into each adopting plugin via `sync-to-plugin.js`. Only the synced copy ships to users.
- Events follow the **1DS Common Schema 4.0** envelope and route through the tenant's event-streaming annotation to a Kusto stream.
- The collector POST runs in a **detached child process** (`emit-dispatcher.js`); the parent never waits on the network.
- Only **strict allowlisted fields** are sent. No paths, inputs, tenant data, error messages, or stack traces. Zero npm dependencies.
- **Privacy posture: default-on, opt-out.** No first-run prompt. Users disable via `POWER_PLATFORM_SKILLS_TELEMETRY=0` (env kill switch) or `record-consent.js --answer no` (persistent opt-out file).
- Status: code paths land events end-to-end with the placeholder iKey (local JSONL trace) and with the real iKey (Kusto landing verified). What's deferred: offline queue, rollout to the other 4 plugins, richer error taxonomy.

---

## 2. Goals & Non-Goals

### Goals

- Emit lifecycle telemetry (`skill_started` / `skill_completed`) for every tracked skill in `power-pages`, plus `script_started` / `script_completed` for high-value Node scripts.
- Establish a shared library that other plugins (`canvas-apps`, `code-apps`, `mcp-apps`, `model-apps`) can adopt later by running the sync script — no library redesign.
- Default-on for anonymous, allowlist-only telemetry. Provide a documented opt-out path (env kill switch + persistent consent file).
- **Fail closed:** telemetry code never blocks, slows, or breaks a skill run.

### Non-Goals

- Wiring telemetry into the four non-`power-pages` plugins in this pass.
- Offline retry queue. (A dev-time JSONL trace exists when the iKey is the placeholder, but it is one-way and never replayed.)
- Any npm dependency. The library is built on Node built-ins (`https`, `child_process`, `fs`, `crypto`).

---

## 3. Architecture at a Glance

### 3.1 Components

| Component | What it does |
|---|---|
| `lib/emit-dispatcher.js` | Standalone CLI. Reads one event JSON on stdin, builds the Common Schema envelope, POSTs over `node:https`, exits. Re-checks consent at startup. |
| `lib/emit-spawn.js` | `fireAndForget(event, opts)`. Spawns the dispatcher detached, writes the event JSON to its stdin, calls `child.unref()`, returns synchronously. |
| `lib/events.js` | Pure builders per event type. Each builder picks only allowlisted keys; unknown fields are dropped. |
| `lib/consent.js` / `check-consent.js` / `record-consent.js` | Read/write `~/.power-platform-skills/telemetry.json`. Binary state: `ENABLED` (default if file is absent) or `DISABLED` (only if user explicitly opted out, or `POWER_PLATFORM_SKILLS_TELEMETRY=0`). |
| `lib/correlation.js` | Joins `_started` ↔ `_completed`. Hook path uses an OS temp file keyed by skill name; in-process scripts use a UUID held in closure. |
| `lib/local-log.js` | Dev-only fallback. When the iKey is the placeholder, the dispatcher appends each event to `~/.power-platform-skills/events.jsonl`. |
| `lib/with-telemetry.js` | `withTelemetry(scriptName, asyncFn)` wrapper. Fires `script_started`, awaits, fires `script_completed`. Rethrows the original error unchanged. |
| `lib/prompt-detector.js` + `lib/emit-from-prompt.js` | Slash-command path. Detects `/plugin:skill` in user input and emits `skill_started` directly (see §4). |
| `hooks/run-skill-pretool-telemetry.js` | `PreToolUse:Skill` hook. Builds and emits `skill_started`; writes correlation file. |
| `hooks/run-skill-posttool-validation.js` | `PostToolUse:Skill` hook. After the existing validator runs, reads the correlation file and emits `skill_completed`. Validator's exit code is preserved. |

### 3.2 Data flow for one skill run

```
User input ──┐
             │
             ├── (slash path)   prompt-detector.js → emit-from-prompt.js
             │                       └── fireAndForget(skill_started)
             │
             ▼
Claude invokes Skill tool
             │
             ├── PreToolUse:Skill hook (parent)
             │      ├─ build skill_started, write corr file
             │      └─ fireAndForget(event)  ──► detached emit-dispatcher
             │                                       ├─ re-check consent
             │                                       ├─ POST OneCollector (4 s timeout)
             │                                       └─ exit
             │      parent exits ~50 ms
             ▼
   Skill body runs (instrumented scripts use withTelemetry)
             │
             ├── PostToolUse:Skill hook
             │      ├─ run validator (existing, unchanged)
             │      ├─ read corr file → compute outcome / duration_ms
             │      └─ fireAndForget(skill_completed) ──► detached dispatcher
             │      exits with validator's status code
```

The parent process never waits for the HTTPS POST.

---

## 4. What Gets Tracked

### 4.1 Event types (4 total)

| Event | Emitted by | Carries |
|---|---|---|
| `skill_started` | Hook path **and** slash path | common fields + `skill_name` |
| `skill_completed` | `PostToolUse:Skill` hook only | common fields + `skill_name` + `outcome` + `duration_ms` + `error_class` |
| `script_started` | `withTelemetry()` wrapper around instrumented Node scripts | common fields + `script_name` |
| `script_completed` | `withTelemetry()` wrapper | common fields + `script_name` + `outcome` + `duration_ms` + `error_class` |

**Common fields** on every event: `plugin_name`, `plugin_version`, `session_id` (per-process UUID), `os_family`, `node_version` (major only, e.g. `v22`), `correlation_id`.

**Initial instrumented scripts:** `deploy-site.js`, `check-activation-status.js`, `verify-dataverse-access.js`, `render-audit-report.js`, and the per-skill validators. Low-value scripts (template renderers, UUID generators) are intentionally not instrumented.

### 4.2 Slash-command skills vs auto-invoked skills

There are two ways a skill gets activated, and they hit telemetry differently:

| Activation | Path | `skill_started` source | `skill_completed` source |
|---|---|---|---|
| **User types `/power-pages:create-site`** | Slash path | `prompt-detector.js` → `emit-from-prompt.js` | `PostToolUse:Skill` hook (when Claude invokes the Skill tool in response) |
| **Claude auto-invokes `Skill` tool** (no leading slash) | Hook path | `PreToolUse:Skill` hook | `PostToolUse:Skill` hook |

**Why both paths exist.** The hook path alone leaves a gap during local plugin development: `claude --plugin-dir` does not register plugin hooks, so dev-mode runs would emit nothing. The slash path closes that gap by detecting tracked-skill invocation directly from the prompt text. In production (marketplace install), both paths are active; the slash path catches user-typed invocations even before the Skill tool runs, and the hook path handles every Skill-tool invocation regardless of how the user got there.

**Verified end-to-end:** `skill_completed` is reliably emitted from `run-skill-posttool-validation.js` after the per-skill validator runs. `outcome` is derived from validator exit status, `duration_ms` from the correlation file written by `PreToolUse:Skill`, and the event reaches Kusto via the same dispatcher path as `skill_started`.

**Trade-off / open concern.** When a user types a slash command in a marketplace install, both paths fire `skill_started` — once from the prompt detector, once from the PreToolUse hook — with different `correlation_id`s. `skill_completed` is single-emission and joins **only** the hook-path `skill_started` (it reads the correlation file PreToolUse wrote). The slash-path `skill_started` is therefore an **orphan** — no completion event matches its `correlation_id`. This is a known cost of the current design and shapes one of the open questions in §8.

### 4.3 What is never tracked

File paths, cwd, env vars (except the telemetry off-switch), tenant IDs, site names, site URLs, Dataverse org URLs, error `.message` strings, stack traces, skill arguments, tool inputs, usernames, email addresses, hostnames. The `events.js` builders enforce the allowlist *before* `fireAndForget` is called; a `node:test` asserts the keyset for every event type in CI.

---

## 5. Key Design Decisions

Each decision is paired with the alternative we rejected and the residual risk that survived the choice.

### 5.1 Raw `node:https` instead of `@microsoft/1ds-*` SDK

- **Decision.** The dispatcher constructs the Common Schema 4.0 envelope by hand and POSTs via `node:https`.
- **Why.** The SDK pulls in transitive npm deps and forces an `npm install` step into a marketplace plugin that otherwise has none. POC results showed identical Kusto landing whether we used the SDK or hand-built the envelope; both go through the same OneCollector endpoint with the same iKey + envelope.name routing.
- **Rejected.** `@microsoft/1ds-core-js` + `@microsoft/1ds-post-js`. The deps + install friction outweighed the modest amount of envelope-construction code we'd save (≈40 lines).
- **Residual risk.** When 1DS evolves the wire format, we own the migration. Mitigated by the small surface in the dispatcher.

### 5.2 Detached child dispatcher instead of inline POST

- **Decision.** Every emission point spawns `emit-dispatcher.js` as a detached child, writes the event JSON to its stdin, calls `child.unref()`, and returns synchronously.
- **Why.** Hooks have a 30 s timeout and are on the user's critical path. An inline POST would tie hook completion to collector latency. Detached dispatch returns in ~50 ms regardless of network conditions.
- **Rejected.** (a) Inline `await https.request(...)` — kills hook responsiveness on slow networks. (b) An in-memory queue flushed on process exit — Claude Code hooks run in short-lived Node processes; there's no lifecycle to flush against.
- **Residual risk.** If the OS kills the detached child before the POST completes (process supervisor, antivirus), the event is dropped. We accept this; no retry, no local queue.

### 5.3 Strict allowlist event builders instead of a runtime PII scrubber

- **Decision.** `events.js` builders pick exactly the allowlisted keys from their input; anything else is dropped at construction time. No regex-based scrubber on the wire.
- **Why.** A scrubber's correctness depends on its regex catching every leak shape; an allowlist's correctness depends on you remembering to add a key. The latter fails safe — forgetting to add a field means it doesn't ship, not that it leaks. CI tests assert the exact keyset per event type.
- **Rejected.** A runtime scrubber that walks the payload and redacts patterns. We may need it later if the event surface grows, but today's 4-event surface doesn't justify the false-positive risk.
- **Residual risk.** Low. The allowlist sits at one chokepoint (`events.js`) and is enforced by tests.

### 5.4 Default-on, opt-out instead of interactive prompt or opt-in

- **Decision.** Anonymous telemetry is enabled by default. There is no Phase-1 consent prompt in skills. The user opts out via either of two paths: (a) `POWER_PLATFORM_SKILLS_TELEMETRY=0` env var (one-way kill switch, takes effect immediately, no file written); (b) `record-consent.js --answer no` writes `{"enabled": false}` to `~/.power-platform-skills/telemetry.json`, honored across sessions and schema versions. Documentation lives at `references/telemetry-consent-reference.md` and is linked from the plugin README and AGENTS.md.
- **Why.** The previous design used an interactive first-run prompt (we shipped that posture briefly). It costs us the very first invocation on every fresh machine (the prompt runs *during* that skill, gating all telemetry behind it), adds friction the user did not ask for, and increases the surface where things can go wrong (Phase-1 line in every SKILL.md, AskUserQuestion plumbing, two CLI handshake calls per first run). Allowlisted, anonymous telemetry that ships zero PII is a defensible default-on candidate; the value of the data hinges on capturing the bulk of usage with low friction.
- **Rejected.** (a) **Opt-in (default-off, no prompt):** loses >90% of signal — users don't know to enable. (b) **Interactive first-run prompt** (the previous posture): more friction; loses the first invocation per machine; complicates every SKILL.md; the prompt itself becomes a code path that can break. (c) **Default-on with a one-time banner:** considered, but a printed banner in a hooked CLI environment is easy to miss and hard to suppress without confusing fresh users.
- **Residual risk.** Default-on without a prompt requires the team to be confident that (i) the allowlist is genuinely PII-free for every event type, (ii) opt-out paths are discoverable in docs, and (iii) we never silently expand the allowlist without a privacy review. The schema-finalization question in §8 directly tests (i) and (iii).

### 5.5 Sync script instead of git submodule or npm package

- **Decision.** `node shared/telemetry/sync-to-plugin.js --target plugins/<name>` copies `lib/` + `ikey.json` + the consent reference doc into the plugin. The synced files are committed alongside the plugin; the `shared/` copy is dev-time only.
- **Why.** Submodules add clone-time complexity and break for users who pull the marketplace plugin without recursive flags. An npm package would force `npm install` into every plugin. A sync script is a 30-line copy operation that produces a self-contained plugin.
- **Rejected.** (a) Git submodule. (b) Private npm package. (c) Symlinks (Windows + corp policy).
- **Residual risk.** Drift. If someone hand-edits the synced copy in a plugin, it diverges from `shared/`. Mitigated by README guidance ("never hand-edit the synced copies") and by re-running sync as part of any telemetry change. Could be hardened with a CI check that compares hashes.

---

## 6. Limitations & Known Weak Points

| # | Limitation | Notes |
|---|---|---|
| 1 | Only `power-pages` is wired today | Other 4 plugins adopt later via sync script + per-plugin hook wiring. |
| 2 | No offline queue / retry | Events lost on network failure or 4 s timeout. Acceptable for usage-signal telemetry; not for billing. |
| 3 | Detached child can be killed by the OS | Process supervisors / antivirus may kill a child before POST completes. Event silently dropped. |
| 4 | Slash-path duplicate `skill_started` + orphan correlation | A slash invocation fires `skill_started` twice (prompt path + hook path) with different `correlation_id`s. `skill_completed` joins only the hook-path one — the slash-path event has no matching completion. |
| 5 | Correlation file keyed by skill name (not PID) | Two concurrent runs of the same skill in the same shell would race the correlation file. Not currently observed in practice. |
| 6 | `--plugin-dir` dev mode emits nothing via the hook path | Slash path covers the gap, but auto-invoked skills in dev mode are invisible. E2E verification must be done against a marketplace install. |
| 7 | Scrubber is a no-op | We never run user content through a scrubber. Allowlist is the only defense; if a future event type leaks a field, scrubber won't catch it. |
| 8 | `error_class` is constructor name only | Loses HTTP status codes, error subkinds. Future work to introduce a richer taxonomy without leaking messages. |
| 9 | iKey + collector URL are shared across plugins | One tenant routes everything. If a plugin needs its own data segregation, this needs revisiting (see §8). |

---

## 7. Hard-Won Learnings

These shaped the current design and are worth surfacing because they will shape future 1DS work in this org.

**`envelope.name` is a routing token, not the Kusto table name.** The tenant's `EventStreamingAnnotation` binds `(iKey, envelope.name)` tuples to Kusto streams via `CollectorEventMappingList`. Our annotation requires `envelope.name == "VscodeEvent"`; any other value passes wire-layer validation but never matches the annotation, so the event is silently dropped. We learned this after a day of perfectly successful POSTs that produced zero rows in Kusto.

**`acc:1` is wire-layer ack only, not proof of ingestion.** OneCollector returns `{"acc":1}` once it has parsed the JSON envelope — before any tenant routing. Our smoke test originally asserted `acc:1` and reported "ingestion verified." It wasn't. Real verification requires querying Kusto for the event by `correlation_id`.

**Kusto column mapping is `data_camelCase` → `PascalCase`.** The ingestion mapping populates `EventName`, `EventType`, etc. from `data.eventName`, `data.eventType`. Builders in `events.js` therefore emit camelCase keys, and `eventInfo` is a JSON-stringified string (the column type is `string`, not `dynamic` — passing an object yields a column-level type error and a partial drop).

**`claude --plugin-dir` does not register plugin hooks.** Local development through `--plugin-dir` exercises every code path *except* the hooks. End-to-end verification of the hook-path emissions has to happen against a marketplace-installed copy of the plugin. This is also why the slash-command path exists.

---

## 8. Open Questions for the Team

These are the calls I'd actually like pushback on.

1. **Schema finalization.** Today's 4-event surface (`skill_started/completed`, `script_started/completed`) with the current allowlist — is this the schema we commit to for v1, or do we want to lock in additional fields (e.g., `plugin_install_method`, `claude_code_version`, `tenant_region` if it can be derived without leaking) before we replay data against it? A schema change post-launch is expensive because Kusto's column mapping is annotation-bound.
2. **Local offline queue.** Should we add a write-through queue for events that fail to POST, flushed on the next emission? The argument for: improves data quality on flaky networks. The argument against: adds disk I/O on every emission and complicates the "fire and truly forget" guarantee. My current default is YAGNI; happy to be talked out of it.
3. **Detached `child.unref()` on Windows + corporate endpoint blocks.** On some corp setups the dispatcher child can be quarantined or its outbound POST blocked silently. Do we want a graceful inline fallback (with a tight timeout, e.g. 500 ms) for environments where detach is unreliable, or do we accept silent drops as the price of fail-closed?
4. **iKey + collector URL — shared across plugins or per-plugin?** Today every plugin's synced copy carries the same `ikey.json`. If `code-apps` or `model-apps` ever needs separate Kusto segregation (different team owning the dashboard), we'd need per-plugin iKeys. Easier to decide now than to migrate later.

---

## 9. Appendix

### 9.1 Wire format

```js
// Envelope POSTed to OneCollector (Content-Type: application/x-json-stream)
{
  ver: "4.0",
  name: "VscodeEvent",                        // tenant routing token
  time: "2026-04-27T18:04:00.000Z",
  iKey: "o:" + IKEY.split("-")[0],
  data: {
    eventName: "skill_started",               // event type
    eventType: "Trace",
    severity: "Info",
    eventInfo: JSON.stringify({               // stringified — column type is string
      plugin_name: "power-pages",
      plugin_version: "1.2.2",
      session_id: "f7c2...",
      os_family: "win32",
      node_version: "v22",
      correlation_id: "a3e1...",
      skill_name: "create-site"
    })
  }
}
```

Headers: `Content-Type: application/x-json-stream; charset=utf-8`, `x-apikey: <IKEY>`, `Content-Length`.
Body framing: `JSON.stringify(envelope) + "\n"`.

### 9.2 Failure-mode matrix (compressed)

| Failure | Behavior |
|---|---|
| Consent file missing | Default-on: dispatcher proceeds with POST. No prompt. |
| Consent file `{enabled: false}` | `fireAndForget` still spawns; dispatcher re-checks and exits without POST (or local log). |
| `POWER_PLATFORM_SKILLS_TELEMETRY=0` | Dispatcher reads env, exits without POST. |
| Placeholder iKey | Dispatcher appends to `~/.power-platform-skills/events.jsonl` (dev-only). |
| Collector 4xx/5xx, DNS failure, TLS error | Dispatcher exits 0. No retry. |
| 4 s timeout | Dispatcher destroys request, exits 0. |
| `spawn()` fails | `fireAndForget`'s try/catch swallows; parent continues. |
| Validator throws in PostToolUse | `skill_completed` still emits with `outcome: "failure"`; validator exit code preserved. |

### 9.3 Repository layout

```
shared/telemetry/                       # canonical, dev-time only
├── README.md
├── ikey.json
├── sync-to-plugin.js
├── lib/                                # 13 .js files
├── references/telemetry-consent-reference.md
└── tests/                              # 12 *.test.js files (node:test)

plugins/power-pages/
├── scripts/lib/telemetry/              # synced copy — what users actually run
├── hooks/
│   ├── hooks.json
│   ├── run-skill-pretool-telemetry.js
│   └── run-skill-posttool-validation.js
└── references/telemetry-consent-reference.md
```

### 9.4 References

- Full internal design: `docs/superpowers/specs/2026-04-20-1ds-telemetry-design.md`
- Privacy / opt-out reference: `shared/telemetry/references/telemetry-consent-reference.md`
- Library README: `shared/telemetry/README.md`
- Local dev trace: `~/.power-platform-skills/events.jsonl`
