# CLI attribution safety

The plugin registers no pre-tool hooks in Copilot, Claude, or portable clients.
The empty hook configurations preserve package paths without running commands.
Installing the plugin must not intercept unrelated commands or require Node
before the user can inspect or repair their environment.

Only CLI commands initiated by a Code Apps skill receive attribution.
Follow [CLI binary resolution](../shared/cli-binary.md#command-scoped-attribution).
The command receives `PA_CLI_ORIGIN=plugin` unless the user supplied an origin.
The CLI detects the AI tool from its existing environment markers.
The plugin does not guess host identity or set `PA_PLUGIN_REPORT_AGENT`.

Attribution variables apply to one CLI child process, not the parent shell,
other commands in a compound call, user settings, or later tasks.
Commands keep their arguments, exit status, and normal approval requirements.
Missing Node affects only commands that themselves require Node.
Attribution does not change telemetry consent or send telemetry independently.

Restart existing client sessions after updating. A running session can retain
previously loaded hook definitions until it reloads the plugin.
