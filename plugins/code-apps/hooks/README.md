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

Detection uses anchored checks for single-line commands, not a tokenizer or shell
parser. It recognizes these leading invocation forms:

- `npx --no-install pa ...` and `npx --no-install power-apps ...`.
- Direct `pa` / `power-apps`, optionally under `./node_modules/.bin/`, with
  `.cmd`, `.exe`, or `.ps1` suffixes; `npx.cmd` / `npx.exe` also work.
- Bash's documented `$PA` / `${PA}` resolved prefix.
- Bash captures such as `result="$(npx --no-install pa app list)"`, optionally
  followed by `; ...`. The substitution must be simple: no nested parentheses,
  quoted arguments, escapes, or backticks.
- PowerShell captures such as `$apps = npx --no-install pa app list` and
  `$apps=power-apps list-codeapps`.

An optional `cd app && ...` prefix is supported in either shell, as is
`cd app; ...` in PowerShell. The path must be simple and unquoted or a literal
single-quoted path (for example, `cd 'my app' && ...`). Arguments, pipelines, and
later commands are retained verbatim once a leading CLI invocation is found.
Literal quoted messages and comments mentioning a CLI do not trigger attribution.

**Deliberate narrowing:** the hook no longer searches arbitrary command chains,
conditionals, function bodies, arbitrary executable paths, call operators, or shell wrappers
(`bash -c` / `pwsh -Command`). Multiline scripts, line continuations, heredocs,
here-strings, PowerShell block comments, backticks, and more complex captures are
left unchanged. Likewise, a CLI appearing only after another command (other than
the simple `cd` prefix) is not detected. Resolve `$PA` separately from its
invocation. Use a supported leading invocation when automatic attribution is
needed; unsupported syntax still executes normally without added attribution.

PowerShell scripts beginning with `using` declarations are left unchanged. The
hook never inserts a statement before, moves, or parses a required preamble.

For a matching shell tool call, a conditional environment assignment is prepended
to the original command, without wrapping or reconstructing it. The variable is
scoped to that tool's shell process and inherited child processes (including
other commands in the same compound call). It does not modify the user's parent
shell. Parent values, even empty ones, are not replaced; later inline assignments
still win. Directory changes, quoting, pipelines, and command exit status retain
their original semantics.

Handled failures (including malformed input, a missing plugin root, or failure to
load the hook module) report a diagnostic on stderr and exit successfully with no
rewrite, never a permission denial. Node must be available to run the launcher;
interpreter launch failures and host timeouts are outside the script's control.
The hook does not send telemetry. Supporting CLI versions trim the
variable, default to `standalone` when empty/unset, and emit its entire value as
the existing `cliSource` common property, subject to CLI telemetry consent.
