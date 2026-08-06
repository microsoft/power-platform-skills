# Telemetry control workflow

The user invoked `/<plugin>:telemetry [on | off | status]` to control anonymous
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
- **No personal data is collected.** Telemetry records fields such as skill name,
  plugin version, OS, and Node version.
  Collector events and diagnostic mirrors never include Dataverse organization
  IDs, Entra tenant IDs, Entra user object IDs, file paths, prompts, tool inputs,
  site names, URLs, credentials, usernames, or hostnames.
- Power Pages uses the Dataverse organization ID locally to select the public-cloud
  collector region.
  The resolver sends it to the Power Platform organization API to obtain the
  environment geo.
  The ID is excluded from the collector event and diagnostic mirror, and it is
  hashed before it is used as a region-cache filename.
  Older raw-ID cache filenames are renamed to the hashed form the next time
  telemetry resolves a region.
  Sovereign clouds route from the PAC cloud stamp without an organization lookup.
- **Automation/CI** can disable telemetry by setting the opt-out env var
  `POWER_PLATFORM_SKILLS_TELEMETRY_<PLUGIN>_OPTOUT` (e.g.
  `POWER_PLATFORM_SKILLS_TELEMETRY_POWER_PAGES_OPTOUT=1`) instead of running this
  command. Set it to `1` or `true` (the dotnet `*_TELEMETRY_OPTOUT` convention).
  `<PLUGIN>` is the plugin name uppercased with non-alphanumerics collapsed to `_`.
  This opt-out has the highest precedence — it overrides a saved choice from this
  command and even `on`. It suppresses transmission only, like `off`.
