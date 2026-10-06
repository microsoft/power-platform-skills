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

- Usage telemetry is **enabled and default-on**, with no first-run prompt.
  PCF shares model-apps' 1DS tenant and keys.
- `status` reports the actual build state, effective transmission preference
  and local mirror location without changing settings.
- `on` and `off` save a per-user, per-plugin transmission preference as
  `telemetry["pcf"]` in `~/.power-platform-skills/config.json`. Other settings
  are preserved. The preference takes effect on the next event.
- `POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT=1` (or `true`) takes precedence
  over the saved preference and `on`. It disables transmission only.
- Only `skill_started` base fields are sent: skill,
  plugin/PAC/agent versions, OS/Node versions, session/correlation IDs, and
  `orgId`/`tenantId` when PAC is signed in. There is **no user object ID** and
  no `eventInfo` payload.
- File paths, cwd, environment variables, prompts, arguments, tool inputs, site
  names, Dataverse URLs, stack traces, error messages, credentials, usernames
  and hostnames are never sent.
- The local diagnostic mirror at
  `~/.power-platform-skills/telemetry/pcf/sessions/<sessionId>/events.jsonl`
  retains the same approved fields even after a transmission opt-out.
