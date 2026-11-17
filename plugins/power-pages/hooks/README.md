# Power Pages hooks

`PreToolUse` and `UserPromptSubmit` collect skill-usage telemetry.
`PostToolUse` runs skill validators and preserves their exit status.

## Portable command quoting

The shared manifest uses only `type`, `command` and `timeout`; it does not depend on host-specific fields such as `powershell`.
The same `command` runs in POSIX shells and Windows PowerShell.

A nested `-Command "..."` invocation can strip the double quotes around inline JavaScript, making PowerShell parse JavaScript such as `||` and `path.resolve(root,'hooks',...)` itself.
This reproduces the parser failure reported in [#788](https://github.com/microsoft/power-platform-skills/issues/788), but does not identify which layer in the original sandbox loses the quotes.
The JavaScript is single-quoted and contains no string literals or shell interpolation.
String constants are ordinary command arguments read through Node's `process.argv`: the path module name, the relative hook filename, the missing-root diagnostic and, for telemetry, the exit event name.
This avoids both nested double quotes and shell-specific single-quote escaping.
Node resolves `PLUGIN_ROOT` or `CLAUDE_PLUGIN_ROOT`, so spaces and shell metacharacters in installation paths do not become shell syntax.

Telemetry-only commands register an exit listener that resets Node's exit code to zero, including module-load failures and explicit telemetry exits; diagnostics remain on stderr.
The validation command has no exit listener and retains its normal failure behavior.
POSIX shells preserve Node's exit code; PowerShell's `-Command` reports a native nonzero exit as status 1.
Do not add telemetry's exit listener to the validation hook.

`scripts/tests/hook-commands.test.js` exercises the registered commands with isolated hook bodies and smoke-tests the installed scripts with unrelated input.
It rejects host-specific command fields and executes `command` itself rather than selecting an override in test code.
The existing `power-pages-script-tests` workflow discovers this test and runs it on Linux, macOS and Windows, including direct/nested Windows PowerShell 5.1 and PowerShell 7 launches.
On a non-Windows machine with PowerShell installed, set `HOOK_TEST_POWERSHELL` to its executable to run the PowerShell cases locally.
