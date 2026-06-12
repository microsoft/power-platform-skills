# Shared 1DS Telemetry Library

Canonical source for 1DS telemetry used by plugins in this repo. Each adopting plugin **symlinks** this library into its own tree: `plugins/<plugin>/scripts/lib/telemetry/lib` is a symlink to `shared/telemetry/lib`, so there is a single source of truth and no copy to keep in sync.

`shared/telemetry/lib` is the **only** copy of the library. The marketplace installer dereferences the per-plugin symlink into the installed plugin at install time, so the library ships without a per-plugin copy. Each plugin keeps its own real `ikey.json` next to the symlink.

Zero npm dependencies. Node stdlib only.

---

## What it does

Anonymous `skill_started` telemetry over the 1DS Common Schema 4.0 envelope. A detached dispatcher child posts to the configured collector URL; the hook that emitted the event returns before the POST happens.

```
hook (~5ms when disabled, ~3-5s otherwise — incl. when the user opted out)
  │
  └─ fireAndForget(event, opts)         ← shared/telemetry/lib/emit-spawn.js
       │
       └─ spawn(emit-dispatcher.js, detached)   ← runs in background
            ├─ read ikey.json
            ├─ kill switch (cfg.disabled) → exit   ← HARD OFF: no local log, no POST
            ├─ sanitizeData (FIELD_TYPES allowlist)
            ├─ appendLocal({time,name,data}) → events.jsonl   ← ALWAYS (the mirror)
            ├─ user opt-out (config.json telemetry[plugin]="off") → exit (mirror written, no POST)
            ├─ iKey missing/placeholder → exit (mirror already written, no POST)
            ├─ build CS4.0 envelope (same time + sanitized data)
            └─ HTTPS POST to collector_url
```

The local log is the on-disk **mirror** of what is (or would be) sent to Kusto:
each line is `{time, name, data}` where `data` is the sanitized payload whose
field names ARE the Kusto column names. It is written for **every** event that
clears the repo `disabled` kill switch — irrespective of whether a real iKey is
configured **and** irrespective of the user opt-out. Only the repo
`disabled: true` kill switch produces zero side effects.

The per-plugin user opt-out (`config.json` `telemetry[<plugin>] === "off"`, set
via `/<plugin>:telemetry off`) suppresses **transmission**, not the local
diagnostic mirror — so an opted-out run still writes `events.jsonl` (and pays the
same event-building cost as an enabled run), it just never POSTs.

## What is sent

Every event carries a fixed allowlist enforced by `lib/events.js`. Field names match the destination Kusto column names (camelCase).

**Identity / context (on every event):**

- `pluginName`, `pluginVersion` — read from the plugin's `.claude-plugin/plugin.json`
- `sessionId` — random UUID generated once per Node process; not persisted
- `correlationId` — a per-start unique ID generated inline at emit time
- `osName`, `osVersion` — `process.platform` and OS release string
- `nodeVersion` — major version only, e.g. `v22`

**PAC + agent (when available, otherwise omitted):**

- `orgId`, `tenantId` — Dataverse org GUID and Entra tenant GUID, read from `pac auth who` if the user is signed in
- `pacCliVersion` — semver from `pac --version`
- `aiAgentName`, `aiAgentVersion` — host AI agent detected via env in the hook process before the detached dispatcher is spawned. Claude Code (`CLAUDECODE=1`) reports `Claude Code` with the version read from its installed `package.json` via `CLAUDE_CODE_EXECPATH`; that `package.json` only exists for npm-global installs, so when it can't be read (e.g. the native installer's standalone binary) the version falls back to the dotted semver parsed out of `AI_AGENT` (`claude-code_<maj>-<min>-<patch>_agent`), which Claude Code sets regardless of install method. GitHub Copilot CLI (`COPILOT_CLI=1`) reports `Copilot CLI` with the version from `COPILOT_CLI_BINARY_VERSION` or `COPILOT_CLI_VERSION`. Codex, OpenCode, Hermes, and OpenClaw are detected from their agent-specific env flags/version variables (`CODEX_*`, `OPENCODE_*`, `HERMES_*`, `OPENCLAW_*`) or from `AI_AGENT` when it includes a recognizable agent name. Explicit `AI_AGENT_NAME` / `AI_AGENT_VERSION` env vars override detection (used for testing); when `AI_AGENT_NAME` is set but `AI_AGENT_VERSION` is empty, the version is backfilled from whichever detector matches.

**Per-event:**

- `skillName` (on every event)
- `eventInfo` — caller-supplied JSON object (dynamic Kusto column). The caller is responsible for not putting PII in this payload.

## What is NEVER sent

File paths, cwd, env vars (except the telemetry kill switch), site names, Dataverse URLs, stack traces, `err.message` text, skill arguments, tool inputs, prompt text, usernames, hostnames.

The dispatcher runs a defense-in-depth allowlist filter against `FIELD_TYPES` before serializing, so any field that bypasses the builders is dropped before it reaches the wire.

## Privacy posture

- **Default-on.** Anonymous telemetry is enabled by default. No first-run prompt.
- **Opt out of transmission** via `/<plugin>:telemetry off` (per-user, per-plugin). This writes `telemetry[<plugin>] = "off"` into `~/.power-platform-skills/config.json` and stops the network POST to the collector — **nothing leaves the machine** — but the local diagnostic mirror (`events.jsonl`) is still written so the user/developer can see exactly what would have been sent. It is therefore an opt-out of *transmission*, not of local logging. CI/headless can opt out by writing that file directly. Re-enable with `/<plugin>:telemetry on`.
- **Repo-side kill switch (true hard-off).** `ikey.json` carries a `disabled` flag. When `true`, every entry point — hooks and `emit-from-prompt` — short-circuits BEFORE any PAC shellout or process spawn, so there is **no POST and no local log**. Ship `true` and flip to `false` only after the tenant-side Kusto stream and annotation are provisioned.

The `disabled` flag is checked at every layer that could perform user-facing work: the pretool/posttool hooks and `emit-from-prompt.js`. A disabled plugin emits zero side effects. The per-plugin user opt-out, by contrast, is enforced inside the detached dispatcher AFTER the local mirror is written — so an opted-out run still produces `events.jsonl` (and incurs the same event-building cost as an enabled run) but never transmits.

---

## Layout

```
shared/telemetry/
├─ ikey.json                 # placeholder template config (each plugin keeps its own real ikey.json)
├─ lib/
│  ├─ events.js              # FIELD_TYPES allowlist + buildSkillStarted
│  ├─ emit-spawn.js          # fireAndForget — spawn detached dispatcher
│  ├─ emit-dispatcher.js     # detached child — kill switches, sanitize, POST
│  ├─ emit-from-prompt.js    # UserPromptSubmit hook helper — detect slash command + emit skill_started
│  ├─ pac-auth.js            # parses `pac auth who` for orgId / tenantId
│  ├─ agent-info.js          # detects AI agent host + reads `pac --version`
│  ├─ session.js             # per-process session UUID
│  ├─ prompt-detector.js     # parses `/plugin:skill` slash commands from prompt text
│  ├─ scrubber.js            # legacy text-scrubbing helper (unused by default — kept for callers that need it)
│  └─ local-log.js           # appends every emitted event to ~/.power-platform-skills/events.jsonl (irrespective of iKey), with 10 MB rotation
└─ tests/                    # node:test coverage for every module above
```

---

## Adopting in a new plugin

These steps assume your plugin already lives under `plugins/<your-plugin>/` with a `.claude-plugin/plugin.json` and `hooks/hooks.json`.

### 1. Link the library

Create a git symlink at `plugins/<your-plugin>/scripts/lib/telemetry/lib` pointing at the relative path to `shared/telemetry/lib`. From the `telemetry` directory that target is `../../../../../shared/telemetry/lib` (five levels up to the repo root).

Create it as a mode-`120000` blob so it works on every checkout regardless of local symlink privileges (the same way the skill-workflow symlinks under `skills/*/` were made):

```bash
# from the repo root
TARGET=plugins/<your-plugin>/scripts/lib/telemetry
mkdir -p "$TARGET"
hash=$(printf '../../../../../shared/telemetry/lib' | git hash-object -w --stdin)
git update-index --add --cacheinfo 120000,$hash,"$TARGET/lib"
git checkout -- "$TARGET/lib"
```

Now `scripts/lib/telemetry/lib` resolves to the shared library — there is no copy to keep in sync.

### 2. Configure `ikey.json`

Create `plugins/<your-plugin>/scripts/lib/telemetry/ikey.json` — a **real file, not symlinked** (it carries this plugin's config, distinct from `shared/`'s placeholder):

```json
{
  "instrumentationKey": "<your 1DS instrumentation key>",
  "collector_url": "https://<region>-mobile.events.data.microsoft.com/OneCollector/1.0/",
  "event_stream_name": "<your Kusto stream / annotation name>",
  "disabled": true
}
```

**Ship with `disabled: true`** until the tenant-side annotation, Kusto table, and FieldNameMappings are provisioned. Flip to `false` in a separate PR once verified.

**Posture rule:** the **committed** `ikey.json` must stay `disabled: true`. A working-tree `disabled: false` is a local experiment only — never commit it.

### 3. Register hooks

In `plugins/<your-plugin>/hooks/hooks.json`, register the three hook scripts that ship with this library pattern. The Power Pages plugin's `hooks.json` is the reference example. Copy these three hook entry points into your `hooks/` directory:

- `run-skill-pretool-telemetry.js` — emits `skill_started` on `PreToolUse(Skill)`
- `run-skill-posttool-validation.js` — runs your validator on `PostToolUse(Skill)`
- `run-user-prompt-telemetry.js` — emits `skill_started` on `UserPromptSubmit` when the prompt is a tracked `/plugin:skill` slash command

These hooks must call out to your plugin's `scripts/lib/<plugin>-hook-utils.js` for the tracked-skill list. Adapt the imports to your plugin's layout.

### 4. Verify locally

Run the plugin's test suite:

```bash
node --test plugins/<your-plugin>/scripts/tests/*.test.js
```

Then invoke one of your tracked skills with `disabled: true` and confirm via Claude Code's hook logs that no telemetry-related work happens. With `disabled: false` and a real iKey, set `POWER_PLATFORM_SKILLS_FAKE_HTTPS=/tmp/probe.json` and verify the probe file is written with the expected envelope shape.

---

## Updating the shared library

Edit `shared/telemetry/lib/` directly. Because each adopting plugin's `scripts/lib/telemetry/lib` is a **symlink** to this directory, the change is live for every plugin immediately — there is no copy to re-sync and nothing to propagate per-plugin.

Each plugin's `ikey.json` is a separate real file (not symlinked), so editing the shared library never touches a plugin's provisioned key.

If you change the wire-level shape (envelope, transport, allowlist), it applies to every adopting plugin at once — bump and validate accordingly.

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
- `session.js` — `_resetCache()` clears the per-process session-id cache between tests; `getSessionId(override)` accepts an explicit id (no filesystem state to redirect)

Follow this pattern for any new module.
