# Interactive Telemetry Toggle — Design Spec

- **Date:** 2026-06-08
- **Status:** Approved design (pre-implementation)
- **Topic:** Give users an interactive, on-demand command to enable/disable telemetry, and replace the env-var opt-out with a single host-neutral config file.

---

## 1. Summary

Add a per-plugin command — `/<plugin>:telemetry on | off | status` — that lets a user
turn anonymous telemetry on or off at any time. The choice persists in a single
host-neutral file in the user's home directory and is honored by the telemetry
dispatcher at emit time (no session restart). The existing
`POWER_PLATFORM_SKILLS_TELEMETRY` environment-variable opt-out is **removed
entirely** so there is exactly one user-facing off-switch.

Disabling stops **transmission only** — the local diagnostic mirror
(`~/.power-platform-skills/events.jsonl`) is still written, consistent with the
behavior shipped earlier today (commit `5a876b3`).

## 2. Goals / Non-goals

**Goals**
- One discoverable, interactive control to enable/disable telemetry.
- A single, host-neutral persistence mechanism that works under any AI host
  (Claude Code, GitHub Copilot CLI, Codex, …) and takes effect immediately.
- Per-plugin granularity (disabling one plugin's telemetry leaves others on).
- Clear, honest user messaging that no personal data is collected.

**Non-goals (YAGNI)**
- No first-run consent prompt — the privacy posture stays **default-on, no prompt**.
- No per-project scope — the choice is per-user (machine-wide for a given plugin).
- No "purge/delete local log" action and no toggle for local logging itself.
- No exposure of the internal `ikey.json` `disabled` provisioning flag.

## 3. Locked decisions (from brainstorming)

| # | Decision |
|---|----------|
| 1 | **Trigger:** on-demand command/skill (not a first-run prompt). |
| 2 | **Scope:** per-user (home dir, applies across all projects), **keyed by plugin name**. |
| 3 | **"off" means transmission only** — local `events.jsonl` mirror is still written. |
| 4 | **Coverage:** host-neutral config file read by the shared telemetry gates; effect is immediate. |
| 5 | **Remove the `POWER_PLATFORM_SKILLS_TELEMETRY` env var entirely** — config file is the single off-switch. CI/headless opts out by writing the file. |
| 6 | **Effect is per-plugin** — the dispatcher gates on the emitting `pluginName`. |
| 7 | **Placement:** shared skill workflow + thin per-plugin wrapper; toggle logic in the synced `shared/telemetry/lib/`. |
| 8 | **The `telemetry` skill is excluded from its own usage tracking.** |
| 9 | **The internal `disabled` flag is hidden** — the command only reads/writes the user config. |
| 10 | **Every command prints an anonymity reassurance** message. |

## 4. Architecture

### 4.1 Config file (single source of truth)

```
~/.power-platform-skills/config.json
```

- Same directory as the local log, resolved with the existing precedence:
  `POWER_PLATFORM_SKILLS_CONFIG_DIR` (test seam) → `os.homedir()/.power-platform-skills`.
- Schema — per-plugin keys:

```jsonc
{
  "telemetry": {
    "power-pages": "off"   // "on" | "off"; absent key ⇒ default ON
  }
}
```

- Read at **emit time** by the detached dispatcher, so a toggle takes effect on
  the next event with no restart.
- Writes **merge** (never clobber other plugins' keys or future top-level keys),
  `mkdir -p` the directory, and fail safe (telemetry/config code never throws into
  a caller).

### 4.2 Precedence (two layers)

| Layer | Source | Effect | Visible to user? |
|-------|--------|--------|------------------|
| 1. Repo hard-off | *this plugin's* `ikey.json` `disabled: true` | no POST **and** no local log | **No** (internal) |
| 2. User opt-out | `config.telemetry[<plugin>] === "off"` | no POST; local mirror **still written** | Yes (the command) |
| default | key absent, `disabled:false` | **ON** (transmits) | n/a |

- Most-restrictive-wins: if `disabled:true`, nothing happens regardless of the
  user config (and the user is never shown this internal state).
- The user command operates **only** on layer 2.

## 5. Components

### 5.1 Shared config module — `shared/telemetry/lib/user-config.js` (new)
Single source of truth, synced into each adopting plugin's `scripts/lib/telemetry/`.

- `readTelemetryChoice(configDir, pluginName)` → `"on" | "off" | null` (null = unset)
- `setTelemetryChoice(configDir, pluginName, choice)` → merge-write `{ telemetry: { [pluginName]: choice } }`
- `isTransmissionOptedOut(configDir, pluginName)` → `readTelemetryChoice(...) === "off"`
- Conventions: `configDir` injectable test seam; fail-closed `try/catch`; no deps.

### 5.2 Dispatcher + spawn rewiring
- `shared/telemetry/lib/emit-dispatcher.js`:
  - `isUserOptedOut()` → `isTransmissionOptedOut(configDir, event.data.pluginName)`.
    (The gate already runs **after** the event is parsed, so `pluginName` is available
    and the local mirror is already written before this check — unchanged ordering.)
  - Remove the `POWER_PLATFORM_SKILLS_TELEMETRY` read and the `isUserOptedOut`
    env-var implementation.
- `shared/telemetry/lib/emit-spawn.js`: delete the `POWER_PLATFORM_SKILLS_TELEMETRY`
  forwarding entry from the spawned child's env.

### 5.3 Env-var removal (revert of part of `5a876b3`)
Strip `POWER_PLATFORM_SKILLS_TELEMETRY` from:
- `shared/telemetry/lib/emit-dispatcher.js`, `shared/telemetry/lib/emit-spawn.js`
- `shared/telemetry/lib/emit-from-prompt.js` (comment), `plugins/power-pages/hooks/run-skill-pretool-telemetry.js` (comment)
- `shared/telemetry/README.md`, `shared/telemetry/TELEMETRY_FLOW.html`
- `plugins/power-pages/AGENTS.md` / `CLAUDE.md` telemetry sections
- Re-point the dispatcher tests' `{ off: true }` seam: write a `config.json` in the
  temp `configDir` instead of setting the env var.

### 5.4 CLI entry — `shared/telemetry/lib/telemetry-config.js` (new, synced)
Deterministic, no host coupling. Args: `--action <on|off|status>`, `--plugin <name>`,
optional `--configDir` (test seam). Uses `user-config.js`. Prints the human-readable
result + the anonymity line. **Does not read `ikey.json`** (internal state hidden).

### 5.5 Shared skill + per-plugin wrapper
- `shared/skills/telemetry/telemetry-workflow.md` — the workflow (parse action → run
  the synced CLI → print result), plus the canonical **anonymity message** text.
- `shared/skills/telemetry/SKILL.template.md` — frontmatter + reference, with
  `{{PLUGIN_NAME}}` placeholder.
- `plugins/power-pages/skills/telemetry/SKILL.md` — thin wrapper exposing
  `/power-pages:telemetry`; `argument-hint: on | off | status`; passes `--plugin power-pages`.
- No phases / Dataverse / validators — it is a trivial read/write skill.

### 5.6 Tracking exclusion
- `plugins/power-pages/scripts/lib/powerpages-hook-utils.js` (and the equivalent
  derivation in any future adopter) excludes the `telemetry` skill from the
  tracked-skills set, so checking/toggling telemetry never emits a `skill_started`
  event.

### 5.7 User-facing docs
- Add a **"Telemetry & privacy"** section to `plugins/power-pages/README.md`: the
  command, the config file path, what is/never collected, "nothing leaves the
  machine when off," and the local-log location.
- Update the README skill count + skill list (plugin convention).

## 6. Data flow

### `/<plugin>:telemetry status`
Reads only `config.telemetry[<plugin>]` (default ON) and prints:
```
Telemetry (power-pages): ON
ℹ️  No personal data is collected. Telemetry is anonymous — it records only
   things like skill name, plugin version, OS, and Node version. It never
   includes file paths, prompts, tool inputs, site names, URLs, credentials,
   usernames, or hostnames.
Local log: ~/.power-platform-skills/events.jsonl
```

### `/<plugin>:telemetry off`
`setTelemetryChoice(dir, plugin, "off")` (merge), then:
```
Telemetry (power-pages): OFF — nothing is transmitted.
A local diagnostic log is still kept at ~/.power-platform-skills/events.jsonl.
Re-enable anytime with /power-pages:telemetry on.
ℹ️  No personal data is collected … (same anonymity line)
```

### `/<plugin>:telemetry on`
`setTelemetryChoice(dir, plugin, "on")`, then `Telemetry (power-pages): ON` + the
anonymity line. No mention of internal provisioning state.

### Runtime (unchanged except the gate)
`hook → fireAndForget → emit-dispatcher (detached)`: parse event → write local
mirror → **`isTransmissionOptedOut(configDir, pluginName)` → exit before POST if
off** → keyMissing exit → POST. The repo `disabled:true` hard-off still
short-circuits before any side effect.

## 7. Anonymity message (canonical)
Defined once in `shared/skills/telemetry/telemetry-workflow.md`, sourced from the
README "What is NEVER sent" list, so every adopting plugin shows identical wording.

## 8. Testing

- **`user-config.test.js`** — read/write/merge; default-on when key absent;
  **per-plugin isolation** (writing `power-pages` leaves other keys intact);
  fail-safe when the dir/file is unwritable.
- **`emit-dispatcher.test.js`** — replace the env-var `{ off: true }` seam with a
  written `config.json`; assert: `power-pages:"off"` ⇒ no POST **and** local mirror
  still written; a **different** plugin's `"off"` does **not** silence power-pages;
  no file ⇒ POST; `disabled:true` ⇒ neither (unchanged).
- **`telemetry-config.test.js`** (CLI) — `on/off/status` produce the correct file
  state + output; status reflects the config only (never `ikey.json`).
- **Tracking exclusion** — assert the `telemetry` skill is absent from the
  tracked-skills set (`powerpages-hook-utils` test).
- **Cleanup** — remove/repoint the env-var tests added earlier today; update the
  README skill count/list; re-run `sync-to-plugin.js`.
- Commands: `node --test shared/telemetry/tests/*.test.js` and
  `node --test plugins/power-pages/scripts/tests/*.test.js` (per the `*.test.js`
  glob convention; pac-dependent tests may flake on tight timeouts).

## 9. File-by-file change list

**Shared (edit source, then `node shared/telemetry/sync-to-plugin.js --target plugins/power-pages`)**
- `shared/telemetry/lib/user-config.js` — **new**
- `shared/telemetry/lib/telemetry-config.js` — **new** (CLI)
- `shared/telemetry/lib/emit-dispatcher.js` — gate reads config (by pluginName); drop env var
- `shared/telemetry/lib/emit-spawn.js` — drop env-var forwarding
- `shared/telemetry/lib/emit-from-prompt.js` — drop env-var comment
- `shared/telemetry/README.md`, `shared/telemetry/TELEMETRY_FLOW.html` — docs
- `shared/telemetry/tests/*` — repoint seams; add config tests
- `shared/skills/telemetry/telemetry-workflow.md` — **new**
- `shared/skills/telemetry/SKILL.template.md` — **new**

**Plugin (power-pages)**
- `plugins/power-pages/skills/telemetry/SKILL.md` — **new** wrapper
- `plugins/power-pages/scripts/lib/powerpages-hook-utils.js` — exclude `telemetry` from tracking
- `plugins/power-pages/hooks/run-skill-pretool-telemetry.js` — drop env-var comment
- `plugins/power-pages/README.md` — "Telemetry & privacy" section + skill count/list
- `plugins/power-pages/scripts/lib/telemetry/**` — regenerated by sync (not hand-edited)
- `plugins/power-pages/scripts/tests/*` — config-based seams; tracking-exclusion test
- `plugins/power-pages/AGENTS.md` (`CLAUDE.md`) — telemetry section reflects the config toggle

## 10. Migration / compatibility
- Anyone currently relying on `POWER_PLATFORM_SKILLS_TELEMETRY=0` must switch to the
  config file (`{ "telemetry": { "<plugin>": "off" } }`) or the command. Since the
  env var shipped only earlier today and telemetry is shipped `disabled:true`, the
  blast radius is effectively nil; call it out in the commit/PR body.

## 11. Open questions
None — all resolved during brainstorming.
