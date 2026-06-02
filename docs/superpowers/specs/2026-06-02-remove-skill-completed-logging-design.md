# Design: Remove the `skill_completed` logging flow

**Date:** 2026-06-02
**Branch:** `users/amitjosh/1ds-feature`
**Status:** Approved — ready for implementation plan

## Goal

Stop emitting the `skill_completed` 1DS telemetry event and tear out the
disk-based correlation infrastructure that existed only to join a start event to
its completion. Keep `skill_started` fully intact (with a per-start inline
`correlationId`), keep the `buildSkillCompleted` builder and its fields in
`events.js` as dormant-but-available code, and preserve the PostToolUse
validator behavior unchanged.

## Background

Today the telemetry layer emits two events:

- **`skill_started`** — emitted from two places:
  - `run-skill-pretool-telemetry.js` (`PreToolUse(Skill)`), which calls
    `correlationLib.write()` to persist a correlation file to tmp and reuse its
    UUID.
  - `run-user-prompt-telemetry.js` (`UserPromptSubmit`) via
    `emit-from-prompt.js`, which already generates its `correlationId` inline
    with `crypto.randomUUID()` and does **not** touch `correlation.js`.
- **`skill_completed`** — emitted from `run-skill-posttool-validation.js`
  (`PostToolUse(Skill)`). It reads the correlation file to join with the start,
  computes `outcome` / `durationMs` / `errorClass` / `errorDescription`, emits
  the event, then clears the correlation file.

`correlation.js` (disk read/write/clear/sweep) exists **solely** to join
`skill_started` ↔ `skill_completed`. Its only consumers are the two hook
scripts above.

## Decisions

Two scoping decisions were made during brainstorming:

1. **Keep `correlationId`, drop disk.** Remove the disk-based correlation
   persistence (`correlation.js`), but keep a `correlationId` on `skill_started`
   generated inline per start — matching the pattern `emit-from-prompt.js`
   already uses.
2. **Keep the fields.** Leave `buildSkillCompleted`, `COMPLETED_FIELDS`, and the
   completed-only `FIELD_TYPES` entries in `events.js` untouched. The removal is
   a *flow* change (stop emitting), not a *schema* change. `events.js` and
   `events.test.js` are not modified.

## Architecture change

**Before:** `skill_started` (pretool + user-prompt) writes a correlation file to
tmp → `skill_completed` (posttool) reads it to join, computes outcome / duration
/ error fields, then deletes the file.

**After:** Only `skill_started` is emitted. Its `correlationId` is generated
inline with `crypto.randomUUID()` in both emission paths. No tmp files, no
posttool telemetry, no join. The `correlationId` column survives on
`skill_started` as a standalone per-start unique ID that joins to nothing.

## Scope — file-by-file changes

### 1. `plugins/power-pages/hooks/run-skill-posttool-validation.js`

Strip the entire telemetry emission block (the section that runs the env opt-out
check, loads `ikey.json`, requires the telemetry libs, builds the fields object,
calls `buildSkillCompleted`, calls `fireAndForget`, and calls
`correlationLib.clear`).

Preserve exactly:

- stdin read/parse
- tracked-skill detection via `getTrackedSkillFromToolInput`
- validator lookup + `spawnSync` execution
- the `process.exit(validatorStatus)` contract (telemetry never changed the exit
  code; that must remain true)

Remove now-unused imports and helpers: `os`, the `TELEMETRY_DIR` constant, and
`osFriendlyName`. The file reverts to a pure validation runner.

### 2. `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`

Replace the correlation-file write:

```js
const { correlation_id } = correlationLib.write({ skillName });
```

with an inline UUID:

```js
const correlation_id = require("node:crypto").randomUUID();
```

Drop the `correlationLib` require from the top-of-file require block. Everything
else (the `skill_started` field build + `fireAndForget` emit) stays unchanged.

### 3. `shared/telemetry/lib/events.js`

**UNCHANGED.** `buildSkillCompleted`, `COMPLETED_FIELDS`, and the completed
`FIELD_TYPES` entries (`outcome`, `durationMs`, `errorClass`,
`errorDescription`) all stay. `correlationId` remains in `FIELD_TYPES` and
`COMMON_FIELDS` so `skill_started` continues to carry it.

### 4. `shared/telemetry/lib/correlation.js`

**Delete.** Zero remaining consumers once both hooks stop using it.

### 5. Re-sync + manual delete of stale synced copy

`sync-to-plugin.js` only copies, it never deletes (`copyDir` overwrites
existing files but leaves orphans). So:

1. Run `node shared/telemetry/sync-to-plugin.js --target plugins/power-pages`
   (a no-op for `events.js` since it is unchanged, but keeps the copy honest).
2. **Manually delete** the stale synced copy:
   `plugins/power-pages/scripts/lib/telemetry/lib/correlation.js`.
3. Restore the plugin's real `ikey.json` if the sync overwrote it with the
   placeholder template (`git checkout plugins/power-pages/scripts/lib/telemetry/ikey.json`).

### 6. Tests

- **Delete** `shared/telemetry/tests/correlation.test.js`.
- `shared/telemetry/tests/events.test.js` stays untouched (the builder and
  fields remain).
- Inspect `plugins/power-pages/scripts/tests/` for any test that exercises the
  posttool hook's `skill_completed` emission or the correlation disk flow;
  update or remove it. `run-user-prompt-telemetry.test.js` (the `skill_started`
  prompt path) stays.

### 7. Docs

- `shared/telemetry/README.md` — note that `skill_completed` is no longer
  emitted; remove `correlation.js` from the Layout block and the
  started↔completed join description; reframe `correlationId` as a per-start
  unique ID rather than a join key.
- `plugins/power-pages/AGENTS.md` (and any root telemetry notes) — drop
  `skill_completed` / correlation references where they describe the live flow.
- Add a short "builder retained, not wired" note where `buildSkillCompleted` is
  described, so a future reader knows the dormant code is intentional.

## Expected logging behavior after the change

Applies to the local dev trace (`~/.power-platform-skills/events.jsonl`) and the
Kusto table `PagesPowerPlatformExtEvent` alike — both fed by `emit-dispatcher.js`.

**Gone:**

- Every `"eventName": "skill_completed"` row.
- The four completed-only fields on the wire: `outcome`, `durationMs`,
  `errorClass`, `errorDescription`.
- `severity: "Error"` rows (only ever produced by a failed `skill_completed`).
  After this, all emitted events are `severity: "Info"`.

**Unchanged:**

- `"eventName": "skill_started"` — one per tracked skill invocation. A single
  slash-command run can still produce two started events (one from
  `UserPromptSubmit`, one from `PreToolUse(Skill)`); a model-auto-invoked skill
  produces just the `PreToolUse` one.
- `correlationId` rides on every `skill_started`, now a standalone UUID that
  joins to nothing.

**Analytics impact:** invocation counts and slices by plugin / OS / agent / org
/ tenant still work. Completion rate, success-vs-failure, error types, and skill
duration are no longer measurable. The Kusto table keeps its
`outcome`/`durationMs`/`errorClass`/`errorDescription` columns; they simply stop
receiving data. No Kusto schema change required.

**Caveat:** while `ikey.json` ships with `"disabled": true`, nothing is logged
regardless; the above describes behavior once telemetry is switched on.

## Testing / verification

- `node --test shared/telemetry/tests/` green (correlation test removed; events
  test still passes).
- `node --test plugins/power-pages/scripts/tests/` green.
- Manual: invoke a tracked skill with a real iKey and
  `POWER_PLATFORM_SKILLS_FAKE_HTTPS=<probe>` set; confirm the probe captures a
  `skill_started` envelope and that **no** `skill_completed` is produced by the
  PostToolUse hook.
- Manual: confirm the PostToolUse validator still runs and the hook's exit code
  still mirrors the validator's status (telemetry removal did not alter control
  flow).

## Out of scope

- No changes to `events.js` field schema or the `buildSkillCompleted` builder.
- No Kusto table / annotation / FieldNameMappings changes.
- No changes to `emit-from-prompt.js` (already inline-UUID, already
  `skill_started`-only).
- No changes to the `skill_started` emission paths beyond the pretool hook's
  inline-UUID swap.
