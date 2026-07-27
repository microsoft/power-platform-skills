# Telemetry control workflow

The user invoked `/model-apps:telemetry [on | off | status]` to control anonymous
usage telemetry for this plugin. Default to `status` when no argument is given.

## Steps

1. Read the action from `$ARGUMENTS`. It must be one of `on`, `off`, or `status`.
   If it is empty or anything else, use `status`.
2. Run the synced CLI (it auto-detects the plugin from the plugin manifest):

   ```bash
   node "${PLUGIN_ROOT}/scripts/lib/telemetry/lib/telemetry-config.js" --action <action>
   ```

3. Show the command's stdout to the user verbatim. Do not add or remove lines.

## What to know (for answering follow-ups)

- `off` stops transmission to Microsoft. **Nothing leaves the machine.**
- `on` re-enables transmission. The choice is **per-user and per-plugin** and
  takes effect on the next event (no restart).
- **Anonymous — no personal data.** It records operational fields only: skill name,
  plugin/PAC/agent versions, OS/Node versions, and Dataverse org/tenant GUIDs when
  signed in. It never includes file paths, prompts, tool inputs, entity/table names,
  URLs, credentials, usernames, hostnames, or any user-level identifier (no Entra
  object id).
- Once telemetry is enabled (provisioned), the local diagnostic mirror is written
  for every event — even when you've opted out of transmission — at
  `~/.power-platform-skills/telemetry/model-apps/sessions/<sessionId>/events.jsonl`.
  While telemetry ships disabled (`disabled: true`), nothing is written. `status`
  prints the mirror's location so you can hand over one self-contained file when
  filing an issue.
- **Automation/CI** can disable telemetry by setting the opt-out env var
  `POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT` to `1` or `true` (the dotnet
  `*_TELEMETRY_OPTOUT` convention) instead of running this command. This opt-out
  has the highest precedence — it overrides a saved choice from this command and
  even `on`. It suppresses transmission only, like `off`.
