# Telemetry Consent Reference

Every tracked Power Pages skill runs this check in Phase 1 before any other work.

## Phase-1 one-liner for SKILL.md

Add this line immediately after the existing plugin-version check:

```markdown
> **Telemetry consent**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/check-consent.js"` — if the output is `NEEDS_PROMPT`, use AskUserQuestion to ask the user with the wording below, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/record-consent.js" --answer yes|no`.
```

## Prompt wording

When `check-consent.js` prints `NEEDS_PROMPT`, use AskUserQuestion with:

- **Question:** "Share anonymous usage telemetry with Microsoft?"
- **Body:** "The power-pages plugin can send anonymous usage signals (skill name, success/failure, duration, OS family, plugin version) to Microsoft to help improve these tools. No paths, inputs, tenant data, or error messages are sent. Your answer is saved at `~/.power-platform-skills/telemetry.json`; edit that file any time to change it."
- **Options:**
  - `"Yes, enable telemetry"` — runs `record-consent.js --answer yes`
  - `"No, keep it off"` — runs `record-consent.js --answer no`

## What is and is not sent

Sent (allowlist):
- `plugin_name`, `plugin_version`, `session_id` (random per-process UUID), `os_family`, `node_version`, `correlation_id`, `skill_name` or `script_name`, `outcome`, `duration_ms`, `error_class` (constructor name only).

Never sent:
- File paths, cwd, env vars (except the telemetry off-switch), tenant IDs, site names, site URLs, Dataverse URLs, error messages, stack traces, skill arguments, tool inputs, usernames.

## Override

Setting `POWER_PLATFORM_SKILLS_TELEMETRY=0` disables emission regardless of the file. Any other value is ignored — the env var is a one-way off switch.
