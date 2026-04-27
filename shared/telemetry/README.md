# Shared 1DS Telemetry Library

Canonical source for 1DS telemetry used by plugins in this repo. Synced into each adopting plugin via `sync-to-plugin.js`.

**Not shipped to users directly.** The repo-root copy is development-time only. Each plugin ships its own synced copy under `plugins/<plugin>/scripts/lib/telemetry/`.

## What is sent

Every event carries a fixed allowlist:

- `plugin_name`, `plugin_version` — from the plugin's `.claude-plugin/plugin.json`
- `session_id` — random UUID generated once per Node process (not persisted)
- `os_family` — `win32` | `darwin` | `linux`
- `node_version` — major version only, e.g. `v22`
- `correlation_id` — joins `skill_started` ↔ `skill_completed` and `script_started` ↔ `script_completed`
- `skill_name` (skill events) or `script_name` (script events)
- `outcome` (`success` | `failure`), `duration_ms`, `error_class` (constructor name only) — completed events

## What is NEVER sent

File paths, cwd, env vars (except the telemetry off-switch), tenant IDs, site names, Dataverse URLs, error messages, stack traces, skill arguments, tool inputs, usernames, hostnames.

## Privacy posture

- **Default-on.** Anonymous telemetry is enabled by default. No first-run prompt.
- **Opt out** via `POWER_PLATFORM_SKILLS_TELEMETRY=0` (env kill switch) or by writing `{"enabled": false}` to `~/.power-platform-skills/telemetry.json` (use `record-consent.js --answer no`).
- See `references/telemetry-consent-reference.md` for the full opt-out documentation.

## Syncing into a plugin

```bash
node shared/telemetry/sync-to-plugin.js --target plugins/<plugin-name>
```

No install step — the library has no npm dependencies.

## Layout

See `docs/superpowers/specs/2026-04-20-1ds-telemetry-design.md` for the full design spec.
