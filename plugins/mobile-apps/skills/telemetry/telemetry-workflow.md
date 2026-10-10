# Telemetry control workflow

The user invoked `/<plugin>:telemetry [on | off | status]` to control
usage telemetry for this plugin. Default to `status` when no argument is given.

## Steps

1. Read the action from `$ARGUMENTS`. It must be one of `on`, `off`, or `status`.
   If it is empty or anything else, use `status`.
2. Run the Mobile Apps telemetry-control wrapper. It delegates preference and
  log handling to the synced CLI, then replaces the generic PAC-aware disclosure
  with Mobile Apps' actual identifier-free payload description:

   ```bash
  node "${PLUGIN_ROOT}/scripts/lib/mobile-telemetry-config.js" --action <action>
   ```

3. Show the command's stdout to the user verbatim. Do not add or remove lines.

## What to know (for answering follow-ups)

- `off` stops transmission to Microsoft. **Nothing leaves the machine.** When
  the repository telemetry configuration is enabled, the sanitized local mirror
  remains under `~/.power-platform-skills/telemetry/<plugin>/sessions/`.
- `on` re-enables transmission. The choice is **per-user and per-plugin** and
  takes effect on the next event (no restart).
- Mobile Apps records operational and measured lifecycle fields such as
  skill/checkpoint names, plugin/agent/OS/Node versions, generated
  session/run/span/event IDs, durations, outcomes, fixed error classes,
  invocation source, and a random per-project app instance ID. Verified target
  operations can add environment, tenant, and Dataverse organization IDs. It
  never includes Entra user/object IDs, Dataverse user IDs, business records,
  document contents, file paths, prompts, tool inputs, URLs, credentials,
  usernames, email addresses, hostnames, or raw error descriptions.
- A repository configuration with `disabled: true` is a hard-off: it writes no
  local mirror and sends no event, regardless of the saved user preference.
- **Automation/CI** can disable telemetry by setting the opt-out env var
  `POWER_PLATFORM_SKILLS_TELEMETRY_<PLUGIN>_OPTOUT` (for Mobile Apps,
  `POWER_PLATFORM_SKILLS_TELEMETRY_MOBILE_APP_OPTOUT=1`) instead of running this
  command. Set it to `1` or `true` (the dotnet `*_TELEMETRY_OPTOUT` convention).
  `<PLUGIN>` is the plugin name uppercased with non-alphanumerics collapsed to `_`.
  This opt-out has the highest precedence — it overrides a saved choice from this
  command and even `on`. It suppresses transmission only, like `off`.