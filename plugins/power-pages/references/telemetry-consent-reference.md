# Telemetry Privacy & Opt-Out Reference

Anonymous usage telemetry from this plugin is **enabled by default** so that signal is collected without disrupting the user's flow. There is no first-run prompt. Users who do not want telemetry collected can opt out at any time via either of the methods below.

## What is sent

Strict allowlist enforced by `lib/events.js`. Every event carries:
- `plugin_name`, `plugin_version` — from the plugin's `.claude-plugin/plugin.json`
- `session_id` — random UUID generated once per Node process (not persisted)
- `os_family` — `win32` | `darwin` | `linux`
- `node_version` — major version only, e.g. `v22`
- `correlation_id` — joins `_started` ↔ `_completed`
- `skill_name` (skill events) or `script_name` (script events)
- `outcome` (`success` | `failure`), `duration_ms`, `error_class` (constructor name only) — completed events

## What is NEVER sent

File paths, cwd, env vars (except the telemetry off-switch), tenant IDs, site names, site URLs, Dataverse org URLs, error `.message` strings, stack traces, skill arguments, tool inputs, usernames, email addresses, hostnames.

## How to opt out

### Option 1 — Environment variable (one-way kill switch)

```
POWER_PLATFORM_SKILLS_TELEMETRY=0
```

Set this in your shell, profile, or CI environment. Any other value (`1`, empty, unset) has no effect — the variable is opt-out only and cannot enable telemetry.

### Option 2 — Persistent opt-out via consent file

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/record-consent.js" --answer no
```

Writes `~/.power-platform-skills/telemetry.json` with `{"enabled": false}`. The file is honored on every subsequent run regardless of schema version. To re-enable:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/record-consent.js" --answer yes
```

Or simply delete the file — default-on resumes.

## Checking current state

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/check-consent.js"
```

Output is binary: `ENABLED` or `DISABLED`. The env kill switch and consent file are both reflected.

## For plugin authors

There is **no Phase-1 consent check in skills**. Default-on means skills do not need to gate on consent state — emission is governed entirely by the consent file and env var, both of which are checked inside the dispatcher.
