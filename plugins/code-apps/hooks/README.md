# CLI origin hook

The plugin supplies `PA_CLI_ORIGIN=plugin/claude-code`, `plugin/copilot-cli`, or
`plugin/unknown` before recognized Power Apps CLI invocations. Node (already a
plugin prerequisite) is the only hook interpreter; Python and jq are not needed.
Host detection uses `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`, then `COPILOT_CLI` /
`COPILOT_AGENT_SESSION_ID`. It does not inspect models, prompts, or user identity.

## Host contracts

- Copilot CLI loads the plugin-root `hooks.json` with native `preToolUse` events.
  The hook reads `toolName` / `toolArgs`, chooses syntax from the actual `bash` or
  `powershell` tool name, and returns `modifiedArgs`.
- Claude Code loads `hooks/hooks.json` with `PreToolUse` events. The hook reads
  `tool_name` / `tool_input` and returns `hookSpecificOutput.updatedInput`.
  Copilot's Claude-compatible event is deliberately ignored when Copilot host
  signals are present: its `Bash` alias represents both Bash and PowerShell.

The hook leaves permission decisions to the host, preserves all other tool input
fields, and never chooses target shell syntax from the operating system or the
shell executing the hook itself. Unknown tool names are unchanged.

References: [Copilot hooks](https://docs.github.com/en/copilot/reference/hooks-reference)
and [Claude hooks](https://code.claude.com/docs/en/hooks#pretooluse-decision-control).

## Detection and scope

Detection recognizes `npx --no-install pa`, the `power-apps` fallback, direct CLI
executables (including paths and Windows shim suffixes), and the documented
`$PA` / `${PA}` resolved prefix. It handles ordinary command chains, conditionals,
pipelines, comments, quoting, line continuations, and literal `bash -c` /
`pwsh -Command` wrappers. Quoted messages mentioning a CLI are not invocations.

This is a lexical detector, not a general shell interpreter: generated commands,
arbitrary variable aliases, scripts loaded from disk, heredocs and PowerShell
here-strings are not inspected. Use explicit CLI commands in supported shell
tools for automatic attribution. Scripts containing heredocs/here-strings are
left unchanged rather than interpreting their data as commands.

For a matching shell tool call, a conditional environment assignment is prepended
to the original command, without wrapping or reconstructing it. The variable is
scoped to that tool's shell process and inherited child processes (including
other commands in the same compound call). It does not modify the user's parent
shell. Parent values, even empty ones, are not replaced; later inline assignments
still win. Directory changes, quoting, pipelines, and command exit status retain
their original semantics.

Failures are reported on stderr as non-blocking hook errors, never as permission
denials. The hook does not send telemetry. Supporting CLI versions trim the
variable, default to `standalone` when empty/unset, and emit its entire value as
the existing `cliSource` common property, subject to CLI telemetry consent.
