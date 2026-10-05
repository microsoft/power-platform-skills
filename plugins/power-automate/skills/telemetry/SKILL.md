---
name: telemetry
description: >
  Use this skill when the user wants to enable, disable, turn on or off, opt out
  of, opt in to, or check the status of power-automate telemetry / anonymous
  usage data. Triggers: "disable telemetry", "turn off telemetry", "opt out of
  telemetry", "stop collecting usage data", "enable telemetry", "telemetry status".
user-invocable: true
argument-hint: "on | off | status"
allowed-tools: Bash
model: haiku
---

# Power Automate Telemetry Control

Enable, disable, or check the status of anonymous usage telemetry for the
`power-automate` plugin.

## What is collected

Telemetry is **anonymous**. It records only operational fields — skill name,
plugin version, OS/Node versions, agent name/version, and Dataverse org/tenant
IDs when available. It never includes file paths, prompts, tool inputs, flow
names, URLs, credentials, usernames, or hostnames. A local diagnostic log is
always kept, one file per session, under
`~/.power-platform-skills/telemetry/power-automate/sessions/<sessionId>/events.jsonl`
(nothing is transmitted when telemetry is OFF). Session logs older than 14 days
are pruned automatically.

## Workflow

1. Determine the action from the user's request / `$ARGUMENTS`:
   - `on` — opt in
   - `off` — opt out (nothing transmitted; local log still kept)
   - `status` (default) — report current state

2. Run the bundled config CLI and show its output verbatim:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/telemetry-config.js" --action <on|off|status> --plugin power-automate
   ```

3. Confirm the result to the user in one sentence.
