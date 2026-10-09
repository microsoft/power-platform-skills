---
name: telemetry
description: "Enable, disable, or check usage telemetry transmission for Power Apps Mobile Extension skills. Use for 'turn off telemetry', 'opt out', 'enable telemetry', or 'telemetry status'. Opt-out stops transmission only; local diagnostic logs continue when the plugin is enabled."
user-invocable: true
argument-hint: "on | off | status"
allowed-tools: Read, Bash
---

# Telemetry Transmission Preference

1. Read [shared-instructions.md](../../shared/shared-instructions.md). This control
   requires Node.js but does not require PAC, authentication or native build tools.
2. Read the action from the user's request: `on`, `off`, or `status`. Missing or
   invalid arguments mean `status`.
3. Run the local control, using the absolute installed plugin root provided by the
   host (`PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT`):

   ```text
   node "<plugin-root>/scripts/telemetry-config.js" --action <on|off|status>
   ```

   Resolve the root from the installed skill location if necessary, never from an
   arbitrary file in the control project. Do not run an install or sign-in command.
4. Show the command output verbatim. If it fails, report the failure instead of
   claiming the preference was saved. Do not modify the plugin's telemetry config.

The choice is per-user and per-plugin. `off` stops collector transmission on
subsequent events; it does not stop local logging or delete existing data.
The environment opt-out overrides a saved `on` choice. The maintainer-controlled
hard-disabled configuration overrides both and stops collection and local logging.
This skill is excluded from usage telemetry. See [telemetry.md](../../shared/telemetry.md)
for fields, locations, routing and the maintainer-controlled release switch.