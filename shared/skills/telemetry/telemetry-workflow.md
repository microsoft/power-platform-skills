# Telemetry control workflow

The user invoked `/<plugin>:telemetry [on | off | status]` to control anonymous
usage telemetry for this plugin. Default to `status` when no argument is given.

## Steps

1. Read the action from `$ARGUMENTS`. It must be one of `on`, `off`, or `status`.
   If it is empty or anything else, use `status`.
2. Run the synced CLI (it auto-detects the plugin from the plugin manifest):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/lib/telemetry-config.js" --action <action>
   ```

3. Show the command's stdout to the user verbatim. Do not add or remove lines.

## What to know (for answering follow-ups)

- `off` stops transmission to Microsoft. **Nothing leaves the machine.** A local
  diagnostic log is still written at `~/.power-platform-skills/events.jsonl`.
- `on` re-enables transmission. The choice is **per-user and per-plugin** and
  takes effect on the next event (no restart).
- **No personal data is ever collected.** Telemetry is anonymous: it records only
  things like skill name, plugin version, OS, and Node version. It never includes
  file paths, prompts, tool inputs, site names, URLs, credentials, usernames, or
  hostnames.
