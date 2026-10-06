# PCF telemetry control

The user invoked `/pcf:telemetry [on | off | status]` to control this plugin's
usage telemetry. Default to `status` when no argument is given.

## Steps

1. Read the action from `$ARGUMENTS`. Use `on`, `off` or `status`; if empty or
   unrecognized, use `status`.
2. Run the PCF control CLI:

   ```bash
   node "${PLUGIN_ROOT}/scripts/telemetry-config.js" --action <action>
   ```

3. Show stdout verbatim. If the command fails, show its error rather than
   claiming the preference was saved.

## What to know

- This build **ships disabled**, with placeholder instrumentation keys. Nothing
  is sent or logged until a provisioned release; `on` cannot override that.
- `on` and `off` save a per-user, per-plugin transmission preference as
  `telemetry["pcf"]` in `~/.power-platform-skills/config.json`. Other settings
  are preserved. The preference takes effect on the next event.
- `POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT=1` (or `true`) takes precedence
  over the saved preference and `on`. It disables transmission only.
- A provisioned release would send only `skill_started` base fields: skill,
  plugin/PAC/agent versions, OS/Node versions, session/correlation IDs, and
  `orgId`/`tenantId` when PAC is signed in. There is **no user object ID** and
  no `eventInfo` payload.
- File paths, cwd, environment variables, prompts, arguments, tool inputs, site
  names, Dataverse URLs, stack traces, error messages, credentials, usernames
  and hostnames are never sent.
- Once enabled, the local diagnostic mirror at
  `~/.power-platform-skills/telemetry/pcf/sessions/<sessionId>/events.jsonl`
  retains the same approved fields even after a transmission opt-out. This
  disabled build writes no mirror.
