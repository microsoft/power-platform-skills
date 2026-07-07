# Per-session local telemetry logs — design

**Date:** 2026-06-18
**Status:** Approved (design); ready for implementation plan
**Area:** `shared/telemetry/` (local diagnostic mirror), `plugins/power-pages` telemetry skill

## Problem

The 1DS telemetry pipeline writes a **local diagnostic mirror** of every event to
`~/.power-platform-skills/events.jsonl` (`shared/telemetry/lib/local-log.js`). This is the
file a user is expected to share when something goes wrong.

Today it is a **single flat file**:

- It mixes events from **every adopting plugin** (today `power-pages`; more on demand).
- It mixes events from **every Claude/host session** ever run.
- It only rotates on size (10 MB → `events.<stamp>.old`).

So when a user hits a problem, there is no clean, scoped file to hand over — the one file is a
soup of unrelated plugins and sessions. The goal of this change is: **the file a user needs to
share for a given problem is obvious and self-contained.**

## Decisions (from brainstorming)

1. **Restructure the on-disk layout** so the right file is obvious. No `share`/`export` command;
   no changes to the `report-issue` skill.
2. **Split per-plugin and per-session**, with each session in its own directory.
3. **Path:** `~/.power-platform-skills/telemetry/<pluginName>/sessions/<sessionId>/events.jsonl`.
4. **Retention:** age-based — delete session directories whose log is older than **14 days**.
5. Discoverability is via the telemetry skill's `status` output, which names the most-recent
   session log.

## On-disk layout

```
~/.power-platform-skills/
├── config.json                                   # unchanged — opt-out choices live here
└── telemetry/
    └── <pluginName>/                             # e.g. power-pages
        └── sessions/
            └── <sessionId>/
                ├── events.jsonl                  # this session's events (always this name)
                └── events.<stamp>.old            # only if this session exceeded the size cap (rare)
```

> The pre-per-session flat `events.jsonl` (and its `events.<stamp>.old` rotations),
> which sat directly at the config root, are **deleted** best-effort on the first
> write after this ships. See *Backward compatibility*.

- The log file is **always** `events.jsonl`; the session identity is carried by the **directory
  name**, not the filename.
- `config.json` stays at the config root. All event logs move under `telemetry/`.

## Components

### `shared/telemetry/lib/local-log.js` (rewritten)

This module owns the layout. `configDir` continues to mean the **config root**
(`~/.power-platform-skills` or the `POWER_PLATFORM_SKILLS_CONFIG_DIR` override) — callers are
unchanged; the module derives the rest.

**Constants**

- `ROTATE_BYTES = 10 * 1024 * 1024` — per-session size safety cap (unchanged value).
- `MAX_LOG_AGE_DAYS = 14` — retention window.
- `LOG_FILE_NAME = "events.jsonl"` — retained, but now the per-session filename.

**`appendLocal(record, { configDir })`** — the existing entry point, called by the dispatcher's
`writeLocalLog`. New behavior:

1. Derive identity from the record: `plugin = record.data.pluginName`, `session = record.data.sessionId`.
2. **Sanitize** both with `sanitizeSegment()` — collapse anything outside `[A-Za-z0-9_-]` to `_`
   (dots are intentionally **not** in the allowlist, so a raw `../evil` cannot leave a `..` fragment
   behind — it collapses to `___evil`), and reject exact `.`/`..`/empty → fallbacks `unknown` (plugin)
   and `nosession` (session). These values become **directory names**, so this is a path-safety
   requirement, not cosmetic.
3. Resolve `sessionDir = <configDir>/telemetry/<plugin>/sessions/<session>` and `mkdir -p`.
   (`mkdir` failure → return silently, as today.)
4. `logFile = sessionDir/events.jsonl`.
5. **Size rollover:** if `logFile` exists and is larger than `ROTATE_BYTES`, rename it to
   `events.<stamp>.old` inside the same session dir (reuse the existing `rotationName()` /
   `rotateIfNeeded()` logic, now operating on the session dir). Best-effort; if rename fails, keep
   appending.
6. Append `JSON.stringify(record) + "\n"` to `logFile`.
7. **Retention sweep** (best-effort): see below.
8. **Legacy cleanup** (best-effort): `removeLegacyFlatLog(configDir)` — see below.

The path is **deterministic** — no directory scan to find "this session's file". This also removes
the multi-process race that a glob-by-session approach would have (the dispatcher runs as a fresh,
short-lived process per event, so several may write the same session concurrently).

**`pruneOldSessions(configDir, plugin)`** — best-effort retention:

- List `telemetry/<plugin>/sessions/*`.
- For each session dir, stat its `events.jsonl`; if its `mtime` is more than `MAX_LOG_AGE_DAYS`
  days old, recursively remove the **whole session directory** (`fs.rmSync(dir, { recursive: true,
  force: true })`).
- A session dir whose `events.jsonl` is missing/unreadable is treated as a candidate for removal
  (orphan) — but only if the directory's own mtime is past the window, to avoid racing a dir that
  was just created but not yet written.
- Entirely wrapped in try/catch; never throws, never changes control flow. Runs on every
  `appendLocal` after the write (cheap: a single `readdir` + `stat` per session dir; session counts
  are small in practice and bounded by the 14-day window).

**`pluginLogDir(configDir, plugin)`** → `<configDir>/telemetry/<plugin>/sessions` (sanitized
plugin). Pure path helper, no I/O.

**`latestSessionLog(configDir, plugin)`** → absolute path to the `events.jsonl` in the
most-recently-modified session directory, or `null` when there are none. "Most recent" = highest
`events.jsonl` mtime (falls back to directory mtime when the file is absent). Used by the telemetry
skill's `status` output. Read-only; returns `null` on any error.

**`removeLegacyFlatLog(configDir)`** — best-effort one-time cleanup of the pre-per-session layout.
Deletes `<configDir>/events.jsonl` and any `<configDir>/events.<stamp>.old` rotations that sit at the
config **root**. The new layout's `.old` files live under `telemetry/**`, so matching only the root
listing can never delete a current per-session rotation. Entirely wrapped in try/catch; never throws.
Runs on every `appendLocal` after the retention sweep.

**Exports:** `appendLocal`, `pluginLogDir`, `latestSessionLog`, `pruneOldSessions`,
`removeLegacyFlatLog`, `LOG_FILE_NAME`, `ROTATE_BYTES`, `MAX_LOG_AGE_DAYS`.

### `shared/telemetry/lib/emit-dispatcher.js` (no behavioral change)

`writeLocalLog(localRecord)` already calls `appendLocal(localRecord, { configDir: localConfigDir() })`
where `localConfigDir()` returns the config **root**. `localRecord` is `{ time, name, data: sanitized }`
and `data` carries `pluginName` + `sessionId` (both in `events.js` `COMMON_FIELDS`). No change needed
here beyond confirming the record still carries those two fields. The local mirror continues to be
written for every event that clears the repo kill switch, before the transmission opt-out gate.

### `plugins/power-pages/scripts/lib/telemetry/lib/telemetry-config.js` (status / off output)

Replace the single `logPath()` line with directory + latest-session output, reusing the new shared
helpers (DRY — no path logic duplicated in the skill):

- `status` (ON):
  ```
  Telemetry (power-pages): ON
  <anonymity blurb>
  Logs directory:       ~/.power-platform-skills/telemetry/power-pages/sessions/
  Most recent session:  ~/.power-platform-skills/telemetry/power-pages/sessions/<sessionId>/events.jsonl
  ℹ️  Share that file when reporting an issue (it covers your latest session).
  ```
- `status` (OFF) and the `off` confirmation keep their existing wording about "a local diagnostic
  log is still kept", but point at the **logs directory** and name the most-recent session file via
  `latestSessionLog`.
- When `latestSessionLog` returns `null`: print `No local logs yet for power-pages.` instead of a
  "most recent session" line.

`telemetry-config.js` currently computes its own `logPath()` from `configDir()`. It must instead
`require` the shared `local-log.js` (resolvable via the plugin's `lib/telemetry/lib` symlink) and
call `pluginLogDir` / `latestSessionLog`. The local `logPath()` helper is removed.

## Backward compatibility

- The legacy `~/.power-platform-skills/events.jsonl` (and its `events.<stamp>.old` rotations) are
  **deleted** by a best-effort one-time cleanup (`removeLegacyFlatLog`) that `appendLocal` runs after
  each write. Only files at the config **root** are removed, so the new per-session tree under
  `telemetry/` is never touched. No code ever read the legacy file; removing it just reclaims the
  stale diagnostic data.
- No config schema change. `config.json` and the opt-out env var are untouched.

## Testing

- **`shared/telemetry/tests/local-log.test.js`** (rewritten):
  - `appendLocal` writes to `telemetry/<plugin>/sessions/<session>/events.jsonl` derived from
    `record.data`.
  - Multiple events for the **same** `(plugin, session)` append to one file in order.
  - Different sessions / different plugins land in distinct directories.
  - Filesystem-unsafe `pluginName` / `sessionId` (e.g. containing `/`, `..`, spaces) are sanitized
    to safe single segments; missing values fall back to `unknown` / `nosession`.
  - Size rollover: a pre-filled `events.jsonl` > `ROTATE_BYTES` is rotated to `events.<stamp>.old`
    in the same session dir, and the new event lands in a fresh `events.jsonl`.
  - Retention: a session dir whose `events.jsonl` mtime is > 14 days old is removed on the next
    `appendLocal`; a fresh one is kept. (Use `fs.utimesSync` to backdate.)
  - Never throws when the target is not writable (existing guarantee).
  - `latestSessionLog` returns the newest session's `events.jsonl`, and `null` when none exist.
- **`telemetry-config.test.js`** (updated): `status` / `off` output names the logs directory and
  the latest session file; `No local logs yet` path when empty.
- **`emit-dispatcher.test.js`** (checked/updated): any assertion about the local mirror path moves
  to the new layout.
- Run with the project's Node test glob convention: `node --test shared/telemetry/tests/*.test.js`
  (per the test-runner note — `node --test <dir>/` flakes on local Node 22; use the `*.test.js`
  glob).

## Out of scope

- No `share` / `export` / bundle command.
- No changes to the `report-issue` skill. (Future option, not part of this work: `report-issue`
  could call `latestSessionLog` to point the user at the file to attach.)
- No change to what fields are logged, the transmission path, opt-out precedence, or the repo kill
  switch.

## Constants summary

| Constant | Value | Meaning |
|---|---|---|
| `LOG_FILE_NAME` | `events.jsonl` | Per-session log filename |
| `ROTATE_BYTES` | `10 * 1024 * 1024` | Per-session size safety cap |
| `MAX_LOG_AGE_DAYS` | `14` | Retention window for session directories |
