'use strict';

// Node is already a plugin prerequisite. One launcher works on both platforms;
// the target tool name, NOT the shell running this hook, chooses command syntax.
const SHELLS = new Map([
  ['bash', 'bash'], ['sh', 'bash'],
  ['powershell', 'powershell'], ['pwsh', 'powershell'],
]);

function hostAgent(env) {
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  if (env.COPILOT_CLI === '1' || env.COPILOT_AGENT_SESSION_ID) return 'copilot-cli';
  return 'unknown';
}

function invokesCli(command, shell) {
  // Deliberately match only single-line, leading invocations, not shell grammar.
  // Skipping scripts also avoids treating multiline strings/comments as code.
  if (/[\r\n]/.test(command)) return false;
  if (shell === 'bash' ? /<<|`/.test(command) : /<#|#>|@\s*['"]|`/.test(command)) return false;
  let candidate = command.trimStart();
  // `using namespace System; ...` must stay ahead of executable statements.
  // Do not try to relocate declarations or parse a PowerShell preamble.
  if (shell === 'powershell' && /^using\b/i.test(candidate)) return false;

  // The only supported prelude is `cd app && ...` (or `cd app; ...` in
  // PowerShell), with a simple unquoted path or a literal single-quoted path.
  candidate = candidate.replace(
    shell === 'bash'
      ? /^cd\s+(?:[A-Za-z0-9_./\\:-]+|'[^'\r\n]+')\s*&&\s*/
      : /^cd\s+(?:[A-Za-z0-9_./\\:-]+|'[^'\r\n]+')\s*(?:&&|;)\s*/i,
    '',
  );
  if (shell === 'bash') {
    // Exact capture form: result="$(npx --no-install pa app list)".
    // Reject nested/escaped expressions rather than interpreting their contents.
    const capture = candidate.match(/^[A-Za-z_][A-Za-z_0-9]*="\$\(([^()"'`\\\r\n]+)\)"(?:\s*;|$)/);
    if (capture) candidate = capture[1].trimStart();
  } else {
    // PowerShell executes the RHS in both `$apps = npx ...` and `$apps=npx ...`.
    candidate = candidate.replace(/^\$[A-Za-z_][A-Za-z_0-9]*\s*=\s*/, '');
  }
  const cli = /^(?:npx(?:\.cmd|\.exe)?\s+--no-install\s+(?:pa|power-apps)|(?:\.\/node_modules\/\.bin\/)?(?:pa|power-apps)(?:\.cmd|\.exe|\.ps1)?)(?:\s+(?!\s*\()|$)/;
  return (shell === 'powershell' ? new RegExp(cli.source, 'i') : cli).test(candidate)
    || (shell === 'bash' && /^\$(?:PA|\{PA\})(?:\s+|$)/.test(candidate));
}

function rewrite(payload, env = process.env) {
  if (!payload || typeof payload !== 'object') return null;
  const native = typeof payload.toolName === 'string' && payload.toolArgs !== undefined;
  const toolName = payload.tool_name || payload.toolName || '';
  if (typeof toolName !== 'string') return null;
  const shell = SHELLS.get(toolName.toLowerCase());
  let input = payload.tool_input || payload.toolInput || payload.input || payload.toolArgs;
  // Some hook clients serialize toolArgs as JSON rather than an object.
  if (typeof input === 'string') input = JSON.parse(input);
  if (!shell || !input || typeof input.command !== 'string') return null;
  // Copilot's Claude-compatible event maps BOTH native bash and powershell to
  // "Bash". Only its native camelCase event retains the actual shell identity.
  // https://docs.github.com/en/copilot/reference/hooks-reference
  if (!native && hostAgent(env) === 'copilot-cli') return null;
  if (Object.hasOwn(env, 'PA_CLI_ORIGIN') || !invokesCli(input.command, shell)) return null;
  const origin = `plugin/${hostAgent(env)}`;
  // A prefix, rather than a subshell/script block, preserves cd, variable scope,
  // pipelines and the original command's exit status. Runtime checks also honor
  // values supplied by the tool environment; later inline assignments win.
  const prefix = shell === 'bash'
    ? `if [ "\${PA_CLI_ORIGIN+x}" != x ]; then export PA_CLI_ORIGIN='${origin}'; fi\n`
    : `if (-not (Test-Path Env:PA_CLI_ORIGIN)) { $env:PA_CLI_ORIGIN = '${origin}' }\n`;
  if (input.command.startsWith(prefix)) return null;
  const updatedInput = { ...input, command: prefix + input.command };
  // Native Copilot hooks use modifiedArgs, not Claude's updatedInput. Do not grant
  // permission as a side effect: leave normal shell approval policy intact.
  // https://code.claude.com/docs/en/hooks#pretooluse-decision-control
  return native ? { modifiedArgs: updatedInput }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } };
}

async function main() {
  try {
    let source = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) source += chunk;
    const output = rewrite(JSON.parse(source));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    // Attribution must not block a user's command, but failures must be visible.
    process.stderr.write(`[code-apps] CLI attribution was not applied: ${error.message}\n`);
  }
}

module.exports = { hostAgent, invokesCli, rewrite };
if (require.main === module || process.argv[1] === undefined) main();
