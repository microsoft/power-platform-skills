# Shared 1DS Telemetry Library

Canonical source for 1DS telemetry used by plugins in this repo. Each adopting plugin keeps a physical copy of this library in its own tree at `plugins/<plugin>/scripts/lib/telemetry/lib`, so plugin-host installs and Windows checkouts never depend on symlink behavior.

`shared/telemetry/lib` is the canonical source. Per-plugin copies must be refreshed from it whenever the shared library changes. Each plugin keeps its own real `ikey.json` next to the copied library.

Zero npm dependencies. Node stdlib only.

---

## What it does

Anonymous `skill_started` telemetry over the 1DS Common Schema 4.0 envelope. A detached dispatcher child resolves the destination iKey + collector URL (env override → plugin `resolver.js` → static key in `ikey.json`), then POSTs the event; the hook that emitted it returns before the POST happens.

```
hook (~5ms when disabled, ~3-5s otherwise — incl. when the user opted out)
  │
  └─ fireAndForget(event, opts)         ← shared/telemetry/lib/emit-spawn.js
       │
       └─ spawn(emit-dispatcher.js, detached)   ← runs in background
            ├─ read ikey.json (null/unreadable → HARD OFF)
            ├─ kill switch (cfg.disabled) → exit   ← HARD OFF: no local log, no POST
            ├─ sanitizeData (FIELD_TYPES allowlist)
            ├─ appendLocal({time,name,data}) → telemetry/<plugin>/sessions/<sessionId>/events.jsonl   ← ALWAYS (the mirror)
            ├─ user opt-out (env var POWER_PLATFORM_SKILLS_TELEMETRY_<PLUGIN>_OPTOUT=1 OR config.json choice "off"; env wins) → exit (mirror written, no POST)
            ├─ resolve destination → iKey + collector_url   ← resolver.js (plugin) or static key
            ├─ iKey missing/placeholder → exit (mirror already written, no POST)
            ├─ build CS4.0 envelope (same time + sanitized data)
            └─ HTTPS POST to the resolved collector_url
```

The local log is the on-disk **mirror** of what is (or would be) sent to Kusto:
each line is `{time, name, data}` where `data` is the sanitized payload whose
field names ARE the Kusto column names. It is written for **every** event that
clears the repo `disabled` kill switch — irrespective of whether a real iKey is
resolved **and** irrespective of the user opt-out. Only the repo
`disabled: true` kill switch (or a missing/unreadable `ikey.json`) produces zero
side effects.

The per-plugin user opt-out (`config.json` `telemetry[<plugin>] === "off"`, set
via `/<plugin>:telemetry off`) suppresses **transmission**, not the local
diagnostic mirror — so an opted-out run still writes the session's `events.jsonl`
(and pays the same event-building cost as an enabled run), it just never POSTs.

The mirror is laid out per-plugin, per-session at
`~/.power-platform-skills/telemetry/<pluginName>/sessions/<sessionId>/events.jsonl`,
so a user can hand over one self-contained file per problem. Session directories
older than 14 days are pruned best-effort whenever a new session starts, and an
individual session log is rotated to `events.<stamp>.old` if it ever exceeds 10 MB.

### Custom routing (the resolver contract)

The destination iKey/collector is **not** hard-coded, and the shared library is
routing-agnostic. A plugin may drop a `resolver.js` next to its `ikey.json` to
own that decision:

```js
module.exports = {
  // async; may do network I/O (must cache). Returns { iKey, collectorUrl } or null.
  async resolve({ event, cfg, cloud, configDir }) { /* ... */ },
  // optional sync fast-gate so hooks skip the ~3-5s pac shellout when unprovisioned.
  isProvisioned(cfg) { return true; },
};
```

The dispatcher discovers it by convention (a `resolver.js` sibling of `ikey.json`)
and resolves the destination by precedence: env override (test seam) →
`resolver.js` → static `instrumentationKey`/`collector_url` in `ikey.json` → none.
The power-pages plugin ships a `resolver.js` that does Artemis geo + cloud-stamp
region routing; that implementation lives entirely in
`plugins/power-pages/scripts/lib/telemetry/region/` — the shared library knows
nothing about it.

## What is sent

Every event carries a fixed allowlist enforced by `lib/events.js`. Field names match the destination Kusto column names (camelCase).

**Identity / context (on every event):**

- `pluginName`, `pluginVersion` — read from the plugin's `.claude-plugin/plugin.json`
- `sessionId` — random UUID generated once per Node process; not persisted
- `correlationId` — a per-start unique ID generated inline at emit time
- `osName`, `osVersion` — `process.platform` and OS release string
- `nodeVersion` — major version only, e.g. `v22`

**PAC + agent (when available, otherwise omitted):**

- `orgId`, `tenantId` — Dataverse org GUID and Entra tenant GUID, read from `pac auth who` if the user is signed in (`orgId` is passed to the plugin resolver — power-pages uses it for Artemis region routing)
- `pacCliVersion` — semver from `pac --version`
- `aiAgentName`, `aiAgentVersion` — host AI agent detected via env in the hook process before the detached dispatcher is spawned. Claude Code (`CLAUDECODE=1`) reports `Claude Code` with the version read from its installed `package.json` via `CLAUDE_CODE_EXECPATH`; that `package.json` only exists for npm-global installs, so when it can't be read (e.g. the native installer's standalone binary) the version falls back to the dotted semver parsed out of `AI_AGENT` (`claude-code_<maj>-<min>-<patch>_agent`), which Claude Code sets regardless of install method. GitHub Copilot CLI (`COPILOT_CLI=1`) reports `Copilot CLI` with the version from `COPILOT_CLI_BINARY_VERSION` or `COPILOT_CLI_VERSION`. Codex, OpenCode, Hermes, and OpenClaw are detected from their agent-specific env flags/version variables (`CODEX_*`, `OPENCODE_*`, `HERMES_*`, `OPENCLAW_*`) or from `AI_AGENT` when it includes a recognizable agent name. Explicit `AI_AGENT_NAME` / `AI_AGENT_VERSION` env vars override detection (used for testing); when `AI_AGENT_NAME` is set but `AI_AGENT_VERSION` is empty, the version is backfilled from whichever detector matches.

**Per-event:**

- `skillName` (on every event)
- `eventInfo` — caller-supplied JSON object (dynamic Kusto column). The caller is responsible for not putting PII in this payload. Power Pages populates it with `aadObjectId` (the signed-in user's Entra ID / AAD directory object id, parsed from `pac auth who`) when available; the field is omitted when `pac auth who` doesn't surface an object id. On the wire it is sent as a JSON **string** (re-serialized by `emit-dispatcher.js`, not the local mirror) because the tenant-side field mapping flattens `data.<key>` to a single `data_<key>` leaf and does not recurse into nested objects — the Kusto side must `parse_json()` / `todynamic()` it back into a dynamic value.

## What is NEVER sent

File paths, cwd, env vars, site names, Dataverse URLs, stack traces, `err.message` text, skill arguments, tool inputs, prompt text, usernames, hostnames.

The dispatcher runs a defense-in-depth allowlist filter against `FIELD_TYPES` before serializing, so any field that bypasses the builders is dropped before it reaches the wire.

## Privacy posture

- **Default-on.** Anonymous telemetry is enabled by default. No first-run prompt.
- **Opt out of transmission** via `/<plugin>:telemetry off` (per-user, per-plugin). This writes `telemetry[<plugin>] = "off"` into `~/.power-platform-skills/config.json` and stops the network POST to the collector — **nothing leaves the machine** — but the local diagnostic mirror (a per-session `events.jsonl`) is still written so the user/developer can see exactly what would have been sent. It is therefore an opt-out of *transmission*, not of local logging. CI/headless can opt out by writing that file directly. Re-enable with `/<plugin>:telemetry on`.
- **Opt out for automation** via the per-plugin opt-out env var
  `POWER_PLATFORM_SKILLS_TELEMETRY_<PLUGIN>_OPTOUT` (e.g.
  `POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT=1`). Set it to `1` or `true`
  (the dotnet `*_TELEMETRY_OPTOUT` convention) to disable transmission; it only
  disables, never re-enables. It has the **highest precedence** — it overrides a
  persisted `config.json` choice and `/<plugin>:telemetry on`. The dispatcher reads
  it inside the transmission gate, after the local mirror is written, so it
  suppresses transmission only — the local mirror is still written.
- **Repo-side kill switch (true hard-off).** `ikey.json` carries a `disabled` flag. When `true` (or when `ikey.json` is missing/unreadable), every entry point — hooks, `emit-from-prompt`, and the dispatcher — short-circuits BEFORE any PAC shellout or process spawn, so there is **no POST and no local log**. Ship `true` and flip to `false` only after the tenant-side Kusto stream and annotation are provisioned.

The `disabled` flag is checked at every layer that could perform user-facing work: the pretool/posttool hooks and `emit-from-prompt.js`. A disabled plugin emits zero side effects. The per-plugin user opt-out, by contrast, is enforced inside the detached dispatcher AFTER the local mirror is written — so an opted-out run still produces the session's `events.jsonl` (and incurs the same event-building cost as an enabled run) but never transmits.

---

## Layout

```
shared/telemetry/
├─ ikey.json                 # placeholder template config (each plugin keeps its own real ikey.json)
├─ lib/
│  ├─ events.js              # FIELD_TYPES allowlist + buildSkillStarted
│  ├─ emit-spawn.js          # fireAndForget — spawn detached dispatcher
│  ├─ emit-dispatcher.js     # detached child — kill switches, opt-out, destination resolve (resolver.js or static key), sanitize, POST
│  ├─ emit-from-prompt.js    # UserPromptSubmit hook helper — detect slash command + emit skill_started
│  ├─ resolver-loader.js     # discovers an optional plugin resolver.js next to ikey.json
│  ├─ user-config.js         # reads/writes the per-plugin telemetry opt-out in config.json
│  ├─ telemetry-config.js    # CLI behind /<plugin>:telemetry on|off|status
│  ├─ pac-auth.js            # parses `pac auth who` for orgId / tenantId / cloud
│  ├─ agent-info.js          # detects AI agent host + reads `pac --version`
│  ├─ session.js             # per-process session UUID
│  ├─ prompt-detector.js     # parses `/plugin:skill` slash commands from prompt text
│  ├─ scrubber.js            # legacy text-scrubbing helper (unused by default — kept for callers that need it)
│  └─ local-log.js           # appends every emitted event to ~/.power-platform-skills/telemetry/<plugin>/sessions/<sessionId>/events.jsonl (irrespective of iKey), with 14-day session retention and a 10 MB per-session rollover
└─ tests/                    # node:test coverage for every module above
```

---

## Adopting in a new plugin

These steps assume your plugin already lives under `plugins/<your-plugin>/` with a `.claude-plugin/plugin.json` and `hooks/hooks.json`.

### 1. Copy the library

Copy `shared/telemetry/lib` into `plugins/<your-plugin>/scripts/lib/telemetry/lib`.

Use a physical directory, not a Git symlink. Some Windows checkouts and plugin hosts materialize symlinks as plain link files, which makes hook-time `require()` calls fail before the dispatcher can write the local diagnostic log. Any recursive copy command is fine; examples:

```powershell
$target = "plugins/<your-plugin>/scripts/lib/telemetry/lib"
Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath "shared/telemetry/lib" -Destination $target -Recurse -Force
```

```bash
target="plugins/<your-plugin>/scripts/lib/telemetry/lib"
rm -rf "$target"
mkdir -p "$(dirname "$target")"
cp -R shared/telemetry/lib "$target"
```

Now `scripts/lib/telemetry/lib` is self-contained inside the plugin directory. Commit the copied files together with any shared library change.

### 2. Configure `ikey.json`

Create `plugins/<your-plugin>/scripts/lib/telemetry/ikey.json` as a real file (it carries this plugin's config, distinct from `shared/`'s placeholder).

**Tier 1 — one static key (no routing).** Create a flat
`plugins/<your-plugin>/scripts/lib/telemetry/ikey.json`:

```json
{
  "instrumentationKey": "<your 1DS instrumentation key>",
  "collector_url": "https://<region>-mobile.events.data.microsoft.com/OneCollector/1.0/",
  "event_stream_name": "<your Kusto stream / annotation name>",
  "disabled": true
}
```

No resolver needed — the dispatcher uses the static `instrumentationKey` / `collector_url`.

**Tier 2 — bring your own routing.** Shape `ikey.json` however your resolver wants,
and drop a `resolver.js` next to it implementing `resolve()` (and optionally
`isProvisioned()`). The dispatcher auto-discovers and calls it; the shared library
is never touched. (Power-pages is the reference example: see
`plugins/power-pages/scripts/lib/telemetry/resolver.js` + `region/`.)

**Ship with `disabled: true`** until the tenant-side annotation, Kusto table, and
FieldNameMappings are provisioned. Keep it `disabled: true` for as long as the plugin is
unprovisioned; once the tenant-side stream is live you flip it to `disabled: false` and the
committed `ikey.json` ships enabled (as `power-pages` does — see the CI opt-out guidance in
the repo-root `AGENTS.md`).

**Provision a fresh key — never copy another plugin's.** Your `ikey.json` must carry
this plugin's own instrumentation key(s) and `event_stream_name`. Do not lift another
adopter's `ikey.json` (e.g. power-pages') wholesale — that mis-attributes your events to
their Kusto stream. This is CI-enforced by `scripts/validate-telemetry-ikeys.js` (run in
the `validate-repository-metadata` workflow), which fails if the same key or
`event_stream_name` appears under two different plugins. Run it locally after editing
`ikey.json`:

```bash
node scripts/validate-telemetry-ikeys.js
```

### 3. Register hooks

In `plugins/<your-plugin>/hooks/hooks.json`, register the three hook scripts that ship with this library pattern. The Power Pages plugin's `hooks.json` is the reference example. Copy these three hook entry points into your `hooks/` directory:

- `run-skill-pretool-telemetry.js` — emits `skill_started` on `PreToolUse(Skill)`
- `run-skill-posttool-validation.js` — runs your validator on `PostToolUse(Skill)`
- `run-user-prompt-telemetry.js` — emits `skill_started` on `UserPromptSubmit` when the prompt is a tracked `/plugin:skill` slash command

These hooks must call out to your plugin's `scripts/lib/<plugin>-hook-utils.js` for the tracked-skill list, and pass `ikeyJsonPath` (the plugin's own `ikey.json`) into `fireAndForget` so the dispatcher reads the plugin's config rather than `shared/`'s placeholder. Adapt the imports to your plugin's layout.

### 4. Verify locally

Run the plugin's test suite:

```bash
node --test plugins/<your-plugin>/scripts/tests/*.test.js
```

Then invoke one of your tracked skills with `disabled: true` and confirm via Claude Code's hook logs that no telemetry-related work happens. With `disabled: false` and a real iKey, set `POWER_PLATFORM_SKILLS_FAKE_HTTPS=/tmp/probe.json` and verify the probe file is written with the expected envelope shape.

---

## Updating the shared library

Edit `shared/telemetry/lib/` directly, then refresh each adopting plugin's copied `scripts/lib/telemetry/lib` directory from it in the same change.

Each plugin's `ikey.json` is separate, so refreshing the copied library must not overwrite a plugin's provisioned key.

If you change the wire-level shape (envelope, transport, allowlist), refresh every adopting plugin copy, bump as needed, and validate accordingly.

## Strict allowlist

`shared/telemetry/lib/events.js` enforces exactly the fields documented above. Never add a field to a builder without:

1. Adding it to `FIELD_TYPES` in `events.js`
2. Adding the corresponding column to the Kusto stream / annotation
3. Updating this README's "What is sent" section

## Test seams

Every module exposes injectable test seams via `opts._xxx` properties so tests run hermetically (no real network, no real PAC shellouts):

- `pac-auth.js` — `opts._exec` swaps `execFileSync`
- `agent-info.js` — `opts._exec` swaps `execFileSync`
- `emit-from-prompt.js` — `opts._emit`, `opts._readPacAuth`, `opts._readAgentInfo`
- `emit-dispatcher.js` — `POWER_PLATFORM_SKILLS_FAKE_HTTPS` env var captures the would-be POST to a probe file; `POWER_PLATFORM_SKILLS_IKEY` / `POWER_PLATFORM_SKILLS_COLLECTOR` bypass resolver.js / static-key resolution
- `session.js` — `_resetCache()` clears the per-process session-id cache between tests; `getSessionId(override)` accepts an explicit id (no filesystem state to redirect)

Follow this pattern for any new module.
