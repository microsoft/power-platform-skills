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

// Tokenize only for detection: the original command is never reconstructed.
// Quotes keep `echo "npx --no-install pa"` from looking like an invocation.
// Backslash (Bash) and backtick (PowerShell) escapes include line continuations.
function tokens(command, shell) {
  const result = [];
  const escape = shell === 'bash' ? '\\' : '`';
  let word = '';
  let started = false;
  let quote = '';
  const flush = () => {
    if (started) result.push({ value: word, separator: false });
    word = '';
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === escape && quote !== "'" &&
        !(shell === 'bash' && quote === '"' && !/[$`"\\\r\n]/.test(command[i + 1] || ''))) {
      const next = command[++i];
      if (next === '\r' && command[i + 1] === '\n') i++;
      else if (next !== '\n' && next !== undefined) {
        word += next;
        started = true;
      }
    } else if (quote) {
      if (ch === quote) {
        if (shell === 'powershell' && command[i + 1] === quote) {
          word += ch;
          i++;
        } else quote = '';
      } else word += ch;
    } else if (ch === '$' && command[i + 1] === '{' && command.indexOf('}', i + 2) !== -1) {
      const end = command.indexOf('}', i + 2);
      word += command.slice(i, end + 1);
      started = true;
      i = end;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (ch === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i++;
      flush();
      result.push({ value: '\n', separator: true });
    } else if (';|&(){}\n'.includes(ch)) {
      flush();
      result.push({ value: ch, separator: true });
    } else if (/\s/.test(ch)) flush();
    else {
      word += ch;
      started = true;
    }
  }
  flush();
  return result;
}

function executable(value) {
  return value.split(/[\\/]/).pop().replace(/\.(cmd|exe|ps1)$/i, '').toLowerCase();
}

function invokesCli(command, shell) {
  // Do not interpret heredoc/here-string data as executable shell source.
  // Dynamically generated commands are outside this lexical hook's contract.
  if (shell === 'bash' ? /<<-?\s*\S/.test(command) : /@['"]\r?\n/.test(command)) return false;
  const words = tokens(command, shell);
  let start = true;
  let npx = false;
  let shellWrapper = '';
  let scriptNext = false;
  for (let index = 0; index < words.length; index++) {
    const token = words[index];
    if (token.separator) {
      start = true;
      npx = false;
      shellWrapper = '';
      scriptNext = false;
      continue;
    }
    const value = token.value;
    if (start) {
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(value)) continue;
      if (['if', 'then', 'else', 'elif', 'do', '!', 'command', 'exec', 'env'].includes(value)) continue;
      const name = executable(value);
      const definition = shell === 'bash' && words[index + 1]?.value === '(' && words[index + 2]?.value === ')';
      if (!definition && (['pa', 'power-apps'].includes(name) || value === '$PA' || value === '${PA}')) return true;
      npx = name === 'npx';
      shellWrapper = ['bash', 'sh'].includes(name) ? 'bash'
        : ['pwsh', 'powershell'].includes(name) ? 'powershell' : '';
      start = false;
    } else if (npx) {
      if (value === '--no-install' || value === '--') continue;
      if (['pa', 'power-apps'].includes(executable(value))) return true;
      npx = false;
    } else if (shellWrapper && scriptNext) {
      if (invokesCli(value, shellWrapper)) return true;
      shellWrapper = '';
    } else if (shellWrapper && ['-c', '-command'].includes(value.toLowerCase())) {
      scriptNext = true;
    }
  }
  return false;
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
  let source = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) source += chunk;
  try {
    const output = rewrite(JSON.parse(source));
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    // Attribution must not block a user's command, but failures must be visible.
    process.stderr.write(`[code-apps] CLI attribution was not applied: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { hostAgent, invokesCli, rewrite };
if (require.main === module || process.argv[1] === undefined) main();
