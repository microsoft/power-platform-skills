# Telemetry simplification — skill-only events + session/correlation hardening

**Date:** 2026-05-28
**Status:** Draft — pending implementation plan
**Branch:** `users/amitjosh/1ds-feature` (or a follow-up branch off it)
**Scope:** Power Pages plugin + shared telemetry library

---

## 1. Problem and goals

### Problem

The current shared/telemetry library emits four event types: `skill_started`, `skill_completed`, `script_started`, `script_completed`. Audit of the live trace and code surface revealed two issues:

1. **Script events are redundant for validators.** Validators run inside the `PostToolUse(Skill)` hook; their pass/fail outcome is already captured by `skill_completed.outcome` (derived from the validator's exit code) and their wall-clock duration is included in `skill_completed.durationMs`. The `script_started`/`script_completed` pair adds storage cost and query noise without adding analytical value. Non-validator scripts wrapped in `runInstrumented` (e.g., `clear-site-cache.js`, `render-audit-report.js`) also turn out to be uninteresting from a telemetry standpoint — they don't represent user-visible work.

2. **Per-event sessionId in hook-emitted events.** Each hook spawns as a fresh Node process; the previous `session.js` cached a per-process random UUID, so every hook invocation in a single Claude Code session emitted events under a different `sessionId`. Joining a user's session in Kusto was effectively impossible. (Fixed in the preceding commit by sourcing `session_id` from the hook stdin payload; this spec ratifies that fix and extends it to be host-agnostic — Claude Code or GitHub Copilot CLI should both pass through.)

### Goals

- Reduce the emitted event vocabulary to exactly **two** event names: `skill_started` and `skill_completed`.
- Delete `with-telemetry.js`, `telemetry-runner.js`, and `runInstrumented` callsites — nothing in the library or the plugin wraps scripts anymore.
- Preserve the previously shipped fix for `sessionId` stability across hook invocations within one host-agent session.
- **Host-agent parity:** make `sessionId` source from whichever host the user is running under (Claude Code or GitHub Copilot CLI). The `aiAgentName` field already detects both via `agent-info.js`; sessionId sourcing should follow the same multi-host pattern.
- Preserve the existing disk-file mechanism for `correlationId` joining between the PreToolUse and PostToolUse hooks (different processes, must share state via disk).
- Add a small TTL sweep to `correlation.js` to prevent stale files when PostToolUse never fires (skill timeout, Claude Code killed, etc.).

### Non-goals

- Changing the wire-level envelope shape (CS4.0), the dispatcher, or the kill-switch model.
- Tracking individual scripts. Standalone scripts no longer emit telemetry; their effects are observable indirectly through `skill_completed` for the skill that called them.
- Fixing the "missing `skill_completed` events" observation (Finding E in section 8). Investigated separately after this cleanup lands.
- Renaming `eventName` to disambiguate the user-prompt `skill_started` from the pretool `skill_started`. In observed practice the two do not both fire for the same slash command, so the conflict is theoretical.

---

## 2. Architecture (post-cleanup)

```
Claude Code session
  │
  ├─ user types "/power-pages:add-seo"  ────► UserPromptSubmit hook
  │                                            │  emit skill_started
  │                                            │  (event 1: own correlationId)
  │                                            ▼
  │                                          dispatcher → 1DS
  │
  ├─ Claude Code invokes Skill tool      ────► PreToolUse(Skill) hook
  │                                            │  write correlation file (UUID X)
  │                                            │  emit skill_started
  │                                            │  (event 2: correlationId = X)
  │                                            ▼
  │                                          dispatcher → 1DS
  │
  └─ Skill body runs + validator runs    ────► PostToolUse(Skill) hook
                                                │  read correlation file → UUID X
                                                │  emit skill_completed
                                                │  (event 3: correlationId = X)
                                                ▼
                                              dispatcher → 1DS
```

All three events share `sessionId = Claude Code's session_id`. Events 2 and 3 share `correlationId` via the disk file. Event 1's `correlationId` is independent — the user-prompt hook fires before Claude Code commits to running the skill, so they're treated as distinct logical points.

---

## 3. Components

### 3.1 Deleted modules

| File | Reason |
|---|---|
| `shared/telemetry/lib/with-telemetry.js` | Wraps async fns with `script_started`/`script_completed`. Nothing emits script events anymore. |
| `shared/telemetry/tests/with-telemetry.test.js` | Tests for the deleted module. |
| `plugins/power-pages/scripts/lib/telemetry-runner.js` | Plugin-side wrapper that called `withTelemetry`. No scripts use it post-cleanup. |
| `plugins/power-pages/scripts/tests/telemetry-runner.test.js` | Tests for the deleted module. |

### 3.2 Modified shared modules

#### `shared/telemetry/lib/events.js`
- Remove `buildScriptStarted` and `buildScriptCompleted` exports.
- Remove `scriptName` from the `FIELD_TYPES` allowlist (orphaned after script builders are gone).
- The `outcome`, `durationMs`, `errorClass`, `errorDescription` fields stay — `skill_completed` still uses them.

#### `shared/telemetry/tests/events.test.js`
- Drop all `buildScriptStarted` / `buildScriptCompleted` tests.

#### `shared/telemetry/lib/correlation.js`
- `write({ skillName, tmpDir })` — before writing the new correlation file, scan the tmp dir for `ppskills-corr-*.json` whose mtime is older than 1 hour and unlink them. One-pass sweep, swallows errors. Bounds the leak when PostToolUse never fires.
- Add a one-line code comment documenting the concurrent-same-skill race (no structural fix: in normal single-agent Claude Code usage, two invocations of the same skill cannot overlap; cross-agent concurrent same-skill use is extremely rare).
- No API changes to `write` / `read` / `clear`.

#### `shared/telemetry/lib/session.js`
- Keep `getSessionId(override)` as-is (already supports the override pattern from the preceding fix).
- **Add** `resolveHostSessionId(payload, env = process.env)` helper that returns the first non-empty string match across known host conventions, in precedence order:
  1. `payload.session_id` — Claude Code's hook stdin payload (snake_case)
  2. `payload.sessionId` — camelCase fallback for any host that uses it
  3. `env.COPILOT_SESSION_ID` — GitHub Copilot CLI exposes its session ID via this env var, NOT through the hook payload
  4. `""` — no host session available; the caller's subsequent `getSessionId("")` will fall back to a per-process UUID
- Exported so each hook can call `getSessionId(resolveHostSessionId(parsed))` in one line. The hook doesn't need to know which host it's running under; the resolver picks the right source.
- Rationale: Claude Code and Copilot CLI surface session IDs through different channels (stdin payload vs env var). Putting the multi-channel logic in one helper keeps each hook a single line and lets a third host be added later without touching hook code — just extend the resolver.

#### `shared/telemetry/lib/emit-from-prompt.js`
- No code changes. Continues to emit `skill_started` on slash-command detection. Honors `cfg.disabled === true`, `POWER_PLATFORM_SKILLS_TELEMETRY=0`, and missing `instrumentationKey` as fast-path gates (from the preceding fix).

#### `shared/telemetry/lib/prompt-detector.js`
- No code changes. Still used by `emit-from-prompt`.

### 3.3 Modified plugin code

#### Validators (11 files under `skills/<name>/scripts/validate-*.js`)
- Remove `const { runInstrumented } = require("../../../scripts/lib/telemetry-runner");`
- Remove the `runInstrumented(scriptName, async () => { ... })` wrapper from each validator's entry point.
- The body of each validator becomes its own top-level `async function main()`; the file exits via the validator's own `process.exit(exitCode)`.
- The posttool hook still captures the validator's exit code as `validatorStatus` and emits it via `skill_completed.outcome`.

#### Standalone scripts using `runInstrumented`
- `plugins/power-pages/scripts/clear-site-cache.js`
- `plugins/power-pages/scripts/render-audit-report.js`
- Any other script that imports `telemetry-runner` (grep before plan).
- Each loses the `runInstrumented` wrapper the same way as validators.

#### `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`
- Replace `sessionLib.getSessionId(parsed && parsed.session_id)` with `sessionLib.getSessionId(sessionLib.resolveHostSessionId(parsed))`.

#### `plugins/power-pages/hooks/run-skill-posttool-validation.js`
- Replace `sessionLib.getSessionId(input && input.session_id)` with `sessionLib.getSessionId(sessionLib.resolveHostSessionId(input))`.

#### `plugins/power-pages/hooks/run-user-prompt-telemetry.js`
- Replace `sessionId: parsed.session_id` in the opts passed to `emitSkillStartedFromPrompt` with `sessionId: sessionLib.resolveHostSessionId(parsed)` (the hook imports `sessionLib` for this).

#### `plugins/power-pages/hooks/hooks.json`
- No code changes. All three hooks stay registered.

### 3.4 Plugin synced copies

After the shared library changes, run:

```bash
node shared/telemetry/sync-to-plugin.js --target plugins/power-pages
```

The sync deletes `with-telemetry.js` from the plugin's synced `lib/` copy (the sync-to-plugin script uses a directory copy, so dropping the source file removes it from the target on the next sync). Verify with `ls plugins/power-pages/scripts/lib/telemetry/lib/` after the sync.

### 3.5 Documentation updates

#### `shared/telemetry/README.md`
- Drop the entire "Step 4. (Optional) Wrap scripts with `runInstrumented`" section from the "Adopting in a new plugin" guide.
- Update the "Layout" tree to reflect `with-telemetry.js` is gone.
- Re-number remaining adoption steps if needed.

#### `plugins/power-pages/AGENTS.md`
- No changes needed; current telemetry blurb refers to the README, not the script wrapper.

---

## 4. Data flow

### Per-event population (after cleanup)

| Field | Event 1 (user-prompt) | Event 2 (pretool) | Event 3 (posttool) |
|---|---|---|---|
| `name` (envelope) | from `cfg.event_stream_name` | from `cfg.event_stream_name` | from `cfg.event_stream_name` |
| `eventName` | `skill_started` | `skill_started` | `skill_completed` |
| `eventType` / `severity` | `Trace` / `Info` | `Trace` / `Info` | `Trace` / `Info` or `Error` |
| `sessionId` | from host session via `resolveHostSessionId(parsed)` — Claude Code: `parsed.session_id`; Copilot CLI: `process.env.COPILOT_SESSION_ID` | same | same |
| `correlationId` | own UUID | UUID written to disk | UUID read from disk (= Event 2's) |
| `skillName` | parsed from `/power-pages:<name>` | parsed from `tool_input` | parsed from `tool_input` |
| `pluginName` / `pluginVersion` / `os*` / `nodeVersion` | populated | populated | populated |
| `orgId` / `tenantId` / `pacCliVersion` / `aiAgentName` / `aiAgentVersion` | populated when available | populated when available | populated when available |
| `outcome` / `durationMs` / `errorClass` / `errorDescription` | omitted | omitted | populated |

### Correlation lifecycle

```
PreToolUse fires
   │
   ├─ correlationLib.write({ skillName })
   │     ├─ sweep: unlink *.json older than 1h        [NEW]
   │     ├─ generate new UUID
   │     └─ write { correlation_id, start_ts } to ${tmpdir}/ppskills-corr-<skill>.json
   ▼
[Claude Code runs the skill body]
   ▼
PostToolUse fires
   ├─ run validator (if any)
   ├─ correlationLib.read({ skillName }) → { correlation_id, start_ts }
   ├─ emit skill_completed (uses correlation_id, durationMs = now - start_ts)
   └─ correlationLib.clear({ skillName })
```

### Failure modes

| Failure | Behavior | Result |
|---|---|---|
| User-prompt hook misdetects slash command | `detectSlashCommand` returns null | no event 1 |
| PreToolUse fires but validator step kills posttool (Claude Code crashes mid-execution) | correlation file remains; cleared by next pretool's TTL sweep after 1h | no event 3 for that run; no leak |
| Two concurrent invocations of same skill name | second pretool's write clobbers first's file; both posttools read the second's UUID | first skill_started orphans (no matching skill_completed); second skill_completed mapped to either start. Documented; not structurally fixed. |
| Correlation file unreadable / malformed | `read()` returns `null`; posttool falls back to generating its own UUID + using its own `startTs` | event 3 emits with orphaned correlationId and inflated duration (since startTs is hook entry, not skill entry). Logged via `errorClass`/`errorDescription` if posttool's catch triggers. |
| Neither hook payload nor `COPILOT_SESSION_ID` env var carries a usable session id | `resolveHostSessionId` returns `""`; `getSessionId("")` falls back to the cached value or a fresh UUID per process | sessionId no longer joins across events for that host. Mitigated by adding the host's actual channel (env var or payload field) to `resolveHostSessionId` once known. |

---

## 5. Privacy invariants (unchanged)

1. Field allowlist (`FIELD_TYPES`) still enforced by builders + dispatcher's `sanitizeData`.
2. Kill switch (`cfg.disabled === true`) still gates all three hooks + `emit-from-prompt` before any PAC shellout or process spawn.
3. Env opt-out (`POWER_PLATFORM_SKILLS_TELEMETRY=0`) still gates before PAC.
4. No payloads sent during region/geo resolution (Power Pages currently uses a flat ikey.json on this branch; that's separate).
5. `correlation.js` writes to the OS tmp dir using a safe-name encoding of the skill name; no PII can land in the path.

---

## 6. Testing plan

### Test deletions
- `shared/telemetry/tests/with-telemetry.test.js` — entire file
- `plugins/power-pages/scripts/tests/telemetry-runner.test.js` — entire file
- `shared/telemetry/tests/events.test.js` — `buildScriptStarted` / `buildScriptCompleted` test cases

### Test additions
- `shared/telemetry/tests/correlation.test.js`:
  - **TTL sweep test**: pre-populate the tmp dir with two `ppskills-corr-*.json` files — one mtime'd to `now`, one to `now - 70min`. Call `write({skillName, tmpDir})`. Assert the old one is gone and the new one exists.
  - **TTL sweep tolerates unrelated files**: pre-populate with `unrelated.json` and assert it survives.
  - **TTL sweep swallows readdir failures**: pass a non-existent `tmpDir`. Assert no throw. The subsequent `writeFileSync` inside `write()` will also fail and be swallowed per existing `correlation.js` semantics — no file is produced, no exception escapes.
- `shared/telemetry/tests/session.test.js`:
  - **`resolveHostSessionId` returns `payload.session_id` when present** (Claude Code shape).
  - **`resolveHostSessionId` returns `payload.sessionId` when only camelCase is present** (camelCase host fallback).
  - **`resolveHostSessionId` returns `env.COPILOT_SESSION_ID` when payload has no session id but env does** (Copilot CLI path).
  - **`resolveHostSessionId` prefers payload over env when both are present** (deterministic precedence — explicit host-passed ID wins).
  - **`resolveHostSessionId` returns `""` for null / undefined payload AND no env var** (safety fallback that lets `getSessionId` mint a UUID).

### Test count delta
- Existing shared: 122 (after recent fixes) → roughly 110–115 after removing `with-telemetry.test.js` + `script_*` builder tests.
- New: ~3 (TTL sweep).
- Existing plugin: 157 → ~154 after removing `telemetry-runner.test.js`.
- Target: shared ~115, plugin ~154, all green.

### Manual verification
1. Set `disabled: false` and a real ikey in `plugins/power-pages/scripts/lib/telemetry/ikey.json`.
2. Restart Claude Code.
3. Invoke a tracked skill via slash command and via natural-language ("please run add-seo").
4. Confirm in Kusto / local trace:
   - Two events for the slash command path (user-prompt skill_started + posttool skill_completed) OR three events if pretool also fires, all sharing sessionId; events 2+3 sharing correlationId. *(If the trace shows only event 1, that confirms Finding E and is investigated separately.)*
   - No `script_started` or `script_completed` events anywhere.
5. Run `node skills/add-seo/scripts/validate-seo.js` directly. Confirm it exits with the expected code and emits no telemetry.

---

## 7. Migration / breaking changes

For external adopters of `shared/telemetry/` (currently only Power Pages; spec applies to future adopters):

- `withTelemetry` and `runInstrumented` are no longer available. Any plugin that depended on them must drop the wrappers from their scripts.
- The synced library no longer ships `with-telemetry.js` or `lib/telemetry-runner.js` (plugin-side). The next sync after this change deletes those files from the synced copy.
- The hook event surface contracts (pretool/posttool/user-prompt) are unchanged. Adopters that registered those three hooks don't need any source change.
- The README's adoption guide drops step 4 (the optional script-wrapping step).

---

## 8. Out of scope (separate follow-ups)

- **Finding E — missing `skill_completed` events.** The local trace shows 9 `skill_started` and 0 `skill_completed`. After this cleanup lands and the wire shape is clean, invoke a tracked skill and trace what each hook process emits. Likely candidates:
  - PreToolUse(Skill) matches but PostToolUse(Skill) doesn't, because Claude Code's Skill tool emits a different `tool_name` for slash commands than for inline skill invocations
  - One of the disabled / opt-out / instrumentationKey gates trips in posttool but not pretool
  - Validator runs successfully but the catch block around `correlationLib.read` returns `null`, causing a fresh UUID and breaking the join — but `skill_completed` should still emit; needs trace to confirm
- **Unifying Event 1 and Event 2's eventName.** If observed practice ever shows both events firing for the same slash command and producing real double-counting, consider giving Event 1 a distinct eventName like `slash_command_detected`. Not warranted today.
- **Concurrent-same-skill correlation race.** Documented in section 4; not structurally fixed. Revisit if cross-agent concurrent skill use becomes common.
- **Confirming Copilot CLI's exact session-id surface.** This spec encodes `COPILOT_SESSION_ID` as the Copilot env var name. When a real Copilot CLI run can be inspected, verify the env var name is exact (case included) and that it stays stable across Copilot CLI versions. If Copilot ever migrates to a payload field, add it to `resolveHostSessionId` — no other code changes required.

---

## 9. Implementation order

Rough order the implementation plan will follow:

1. Delete `with-telemetry.js` + tests; delete `script_*` builders + their tests from `events.js`.
2. Add the TTL sweep + comment to `correlation.js`; write the 3 new tests; verify shared suite.
3. Delete `plugins/power-pages/scripts/lib/telemetry-runner.js` + tests.
4. Unwrap each validator (`skills/*/scripts/validate-*.js`) — 11 files.
5. Unwrap any other plugin scripts using `runInstrumented`.
6. Sync shared → plugin; verify `with-telemetry.js` is gone from the synced copy.
7. Run the full shared + plugin test suites.
8. Update `shared/telemetry/README.md` to drop step 4 and update the lib/ layout.
9. Commit each logical piece separately for clean review.
