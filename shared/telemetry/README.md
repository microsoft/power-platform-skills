# Shared 1DS Telemetry Library

Canonical source for 1DS telemetry used by plugins in this repo. Each adopting plugin syncs a copy into its own tree via `sync-to-plugin.js`.

The repo-root copy under `shared/telemetry/` is **development-time only** — nothing here runs at user time. Only the synced copy under `plugins/<plugin>/scripts/lib/telemetry/` is wired into hooks.

Zero npm dependencies. Node stdlib only.

---

## What it does

Anonymous skill-run telemetry over the 1DS Common Schema 4.0 envelope. A detached dispatcher child posts to the configured collector URL; the hook that emitted the event returns before the POST happens.

```
hook (~5ms when disabled, ~3-5s when enabled)
  │
  └─ fireAndForget(event, opts)         ← shared/telemetry/lib/emit-spawn.js
       │
       └─ spawn(emit-dispatcher.js, detached)   ← runs in background
            ├─ read ikey.json
            ├─ kill switch (cfg.disabled) → exit
            ├─ env opt-out (TELEMETRY=0) → exit
            ├─ sanitizeData (FIELD_TYPES allowlist)
            ├─ build CS4.0 envelope
            └─ HTTPS POST to collector_url
```

## What is sent

Every event carries a fixed allowlist enforced by `lib/events.js`. Field names match the destination Kusto column names (camelCase).

**Identity / context (on every event):**

- `pluginName`, `pluginVersion` — read from the plugin's `.claude-plugin/plugin.json`
- `sessionId` — random UUID generated once per Node process; not persisted
- `correlationId` — joins `skill_started` ↔ `skill_completed`
- `osName`, `osVersion` — `process.platform` and OS release string
- `nodeVersion` — major version only, e.g. `v22`

**PAC + agent (when available, otherwise omitted):**

- `orgId`, `tenantId` — Dataverse org GUID and Entra tenant GUID, read from `pac auth who` if the user is signed in
- `pacCliVersion` — semver from `pac --version`
- `aiAgentName`, `aiAgentVersion` — host AI agent detected via env (Claude Code via `CLAUDECODE=1`, GitHub Copilot CLI via `COPILOT_CLI=1` + `COPILOT_CLI_BINARY_VERSION`). Honors `AI_AGENT_NAME` / `AI_AGENT_VERSION` overrides for testing.

**Per-event:**

- `skillName` (on every event)
- `outcome` (`success` | `failure`), `durationMs` (int), `errorClass` (Error constructor name only), `errorDescription` (`err.code` only — short non-PII metadata like `ENOENT`; `err.message` is never emitted) — on completed events
- `eventInfo` — caller-supplied JSON object (dynamic Kusto column). The caller is responsible for not putting PII in this payload.

## What is NEVER sent

File paths, cwd, env vars (except the telemetry kill switch), site names, Dataverse URLs, stack traces, `err.message` text, skill arguments, tool inputs, prompt text, usernames, hostnames.

`errorClass` is the `Error` constructor name only (e.g. `TypeError`). `errorDescription` is restricted to `err.code` (e.g. `ENOENT`, `ECONNREFUSED`) — the free-form `err.message` is never emitted because it can contain file paths, GUIDs, or other user context. The dispatcher also runs a defense-in-depth allowlist filter against `FIELD_TYPES` before serializing, so any field that bypasses the builders is dropped before it reaches the wire.

## Privacy posture

- **Default-on.** Anonymous telemetry is enabled by default. No first-run prompt.
- **Opt out** via `POWER_PLATFORM_SKILLS_TELEMETRY=0` (env kill switch).
- **Repo-side kill switch.** `ikey.json` carries a `disabled` flag. When `true`, every entry point — hooks and `emit-from-prompt` — short-circuits BEFORE any PAC shellout or process spawn. Ship `true` and flip to `false` only after the tenant-side Kusto stream and annotation are provisioned.

The `disabled` flag is checked at every layer that could perform user-facing work: the pretool/posttool hooks and `emit-from-prompt.js`. A disabled plugin emits zero side effects.

---

## Layout

```
shared/telemetry/
├─ ikey.json                 # template config (placeholder values)
├─ sync-to-plugin.js         # copies lib/ + ikey.json into a plugin
├─ lib/
│  ├─ events.js              # FIELD_TYPES allowlist + buildSkillStarted/Completed
│  ├─ emit-spawn.js          # fireAndForget — spawn detached dispatcher
│  ├─ emit-dispatcher.js     # detached child — kill switches, sanitize, POST
│  ├─ emit-from-prompt.js    # UserPromptSubmit hook helper — detect slash command + emit skill_started
│  ├─ pac-auth.js            # parses `pac auth who` for orgId / tenantId
│  ├─ agent-info.js          # detects AI agent host + reads `pac --version`
│  ├─ correlation.js         # writes/reads correlation IDs to disk (joins started ↔ completed across hook invocations)
│  ├─ session.js             # per-process session UUID
│  ├─ prompt-detector.js     # parses `/plugin:skill` slash commands from prompt text
│  ├─ scrubber.js            # legacy text-scrubbing helper (unused by default — kept for callers that need it)
│  └─ local-log.js           # appends events to ~/.power-platform-skills/events.jsonl when no real iKey is configured
└─ tests/                    # node:test coverage for every module above
```

---

## Adopting in a new plugin

These steps assume your plugin already lives under `plugins/<your-plugin>/` with a `.claude-plugin/plugin.json` and `hooks/hooks.json`.

### 1. Sync the library

From the repo root:

```bash
node shared/telemetry/sync-to-plugin.js --target plugins/<your-plugin>
```

This copies `shared/telemetry/lib/*` and `shared/telemetry/ikey.json` into `plugins/<your-plugin>/scripts/lib/telemetry/`.

### 2. Configure `ikey.json`

Edit `plugins/<your-plugin>/scripts/lib/telemetry/ikey.json`:

```json
{
  "instrumentationKey": "<your 1DS instrumentation key>",
  "collector_url": "https://<region>-mobile.events.data.microsoft.com/OneCollector/1.0/",
  "event_stream_name": "<your Kusto stream / annotation name>",
  "disabled": true
}
```

**Ship with `disabled: true`** until the tenant-side annotation, Kusto table, and FieldNameMappings are provisioned. Flip to `false` in a separate PR once verified.

### 3. Register hooks

In `plugins/<your-plugin>/hooks/hooks.json`, register the three hook scripts that ship with this library pattern. The Power Pages plugin's `hooks.json` is the reference example. Copy these three hook entry points into your `hooks/` directory:

- `run-skill-pretool-telemetry.js` — emits `skill_started` on `PreToolUse(Skill)`
- `run-skill-posttool-validation.js` — runs your validator + emits `skill_completed` on `PostToolUse(Skill)`
- `run-user-prompt-telemetry.js` — emits `skill_started` on `UserPromptSubmit` when the prompt is a tracked `/plugin:skill` slash command

These hooks must call out to your plugin's `scripts/lib/<plugin>-hook-utils.js` for the tracked-skill list. Adapt the imports to your plugin's layout.

### 4. Verify locally

Run the synced test suite:

```bash
node --test plugins/<your-plugin>/scripts/tests/
```

Then invoke one of your tracked skills with `disabled: true` and confirm via Claude Code's hook logs that no telemetry-related work happens. With `disabled: false` and a real iKey, set `POWER_PLATFORM_SKILLS_FAKE_HTTPS=/tmp/probe.json` and verify the probe file is written with the expected envelope shape.

---

## Updating the shared library

**DO NOT hand-edit** the synced copy under `plugins/<plugin>/scripts/lib/telemetry/lib/`. Edit `shared/telemetry/lib/` and re-run the sync:

```bash
node shared/telemetry/sync-to-plugin.js --target plugins/<plugin>
```

The sync overwrites `ikey.json` with the placeholder template — restore your plugin's real config with:

```bash
git checkout plugins/<plugin>/scripts/lib/telemetry/ikey.json
```

If you change the wire-level shape (envelope, transport, allowlist), update every adopting plugin's synced copy in the same PR.

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
- `emit-dispatcher.js` — `POWER_PLATFORM_SKILLS_FAKE_HTTPS` env var captures the would-be POST to a probe file
- `correlation.js` / `session.js` — `opts.configDir` redirects state to a temp directory

Follow this pattern for any new module.
