# Shared 1DS Telemetry Library

Canonical source for 1DS telemetry used by plugins in this repo. Synced into each adopting plugin via `sync-to-plugin.js`.

**Not shipped to users directly.** The repo-root copy is development-time only. Each plugin ships its own synced copy under `plugins/<plugin>/scripts/lib/telemetry/`.

## What is sent

Every event carries a fixed allowlist enforced by `lib/events.js`. Field names match Kusto column names (camelCase).

**Identity / context (on every event):**

- `pluginName`, `pluginVersion` — read from the plugin's `.claude-plugin/plugin.json`
- `sessionId` — random UUID generated once per Node process; not persisted
- `correlationId` — joins `skill_started` ↔ `skill_completed` and `script_started` ↔ `script_completed`
- `osName`, `osVersion` — `process.platform` and OS release string
- `nodeVersion` — major version only, e.g. `v22`

**PAC + agent (when available, otherwise omitted):**

- `orgId`, `tenantId` — Dataverse org GUID and Entra tenant GUID, read from `pac auth who` if the user is signed in
- `pacCliVersion` — semver from `pac --version`
- `aiAgentName`, `aiAgentVersion` — host AI agent detected via env (Claude Code, Copilot CLI). Honors `AI_AGENT_NAME` / `AI_AGENT_VERSION` overrides

**Per-event:**

- `skillName` (skill events) or `scriptName` (script events)
- `outcome` (`success` | `failure`), `durationMs` (int), `errorClass` (Error constructor name only), `errorDescription` (truncated to 500 chars) — on completed events
- `eventInfo` — caller-supplied JSON object (dynamic Kusto column). The caller is responsible for not putting PII in this payload.

## What is NEVER sent

File paths, cwd, env vars (except the telemetry off-switch), site names, Dataverse URLs, stack traces, skill arguments, tool inputs, prompt text, usernames, hostnames.

Note: `errorClass` is the constructor name only (e.g. `TypeError`). `errorDescription` is the Error message truncated to 500 chars — callers should ensure exceptions don't include sensitive context before they bubble up.

## Privacy posture

- **Default-on.** Anonymous telemetry is enabled by default. No first-run prompt.
- **Opt out** via `POWER_PLATFORM_SKILLS_TELEMETRY=0` (env kill switch).
- **Repo-side kill switch.** `ikey.json` carries a `disabled` flag. When `true`, the dispatcher exits before any network or local-log path runs. Ships `true` and flips `false` only after the tenant-side Kusto stream is provisioned.

## Syncing into a plugin

```bash
node shared/telemetry/sync-to-plugin.js --target plugins/<plugin-name>
```

No install step — the library has no npm dependencies.

## Layout

See `docs/superpowers/specs/2026-05-04-1ds-telemetry-rebuild-design.md` for the full design spec.
