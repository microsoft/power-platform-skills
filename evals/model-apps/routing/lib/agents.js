'use strict';

// How each supported agent CLI is launched for ONE routing trial. Kept apart from the runner so
// the exact flags are unit-tested and reviewed in one place: they decide what the eval measures.
//
// The trial must observe ROUTING, not the user's machine, so every invocation is isolated:
//   * cwd is a fresh empty temp dir — no repo AGENTS.md/CLAUDE.md can steer the model;
//   * only the plugin under test is loaded (`--plugin-dir`); the user's installed plugins and
//     skills are excluded (Claude: `--restricted`, which ignores user/project/local settings —
//     where installed plugins are enabled — and confines Read/Glob/Grep to the empty cwd so the
//     model cannot read the user's files; Copilot: a throwaway COPILOT_HOME, which is where
//     installed plugins and user skills live). NOT `--safe-mode`: it was measured to drop the
//     --plugin-dir plugin's skills too, which would make every trial a harness error. Residual
//     gap: a user-level ~/.claude/CLAUDE.md still loads for Claude — no flag skips it without
//     also dropping plugin skills; CI runners have none;
//   * MCP servers are off — the plugin's own Playwright server would otherwise launch a browser
//     per trial for nothing;
//   * the tool set is cut to "invoke a skill + read-only file tools". Routing happens before any
//     tool that could change anything, and the runner kills the agent as soon as a plugin skill
//     is chosen; the allowlist is what keeps a run that never routes from doing anything either.
//     The trade-off: a real session has more tools, so the model sees a slightly different menu.
//
// The prompt is sent on STDIN, never argv: on Windows the CLIs are `.cmd` shims that must be
// spawned through cmd.exe, where quoting an arbitrary natural-language prompt is unsafe.

const TELEMETRY_OPTOUT = 'POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT';

/**
 * @param {'claude'|'copilot'} agent
 * @param {{pluginDir: string, model?: string|null, maxTurns?: number, copilotHome?: string}} o
 * @returns {{bin: string, args: string[], env: Record<string,string>}}
 */
function buildInvocation(agent, { pluginDir, model = null, maxTurns = 4, copilotHome } = {}) {
  // CI and evals are not real usage: never let a hook a trial triggers transmit telemetry.
  const env = { [TELEMETRY_OPTOUT]: '1' };
  if (agent === 'claude') {
    const args = [
      '-p',
      '--plugin-dir', pluginDir,
      '--restricted',
      '--strict-mcp-config',
      '--tools', 'Skill,Read,Glob,Grep',
      '--output-format', 'stream-json',
      '--verbose', // required by Claude Code for stream-json in print mode
      '--no-session-persistence',
      '--max-turns', String(maxTurns),
    ];
    if (model) args.push('--model', model);
    return { bin: 'claude', args, env };
  }
  if (agent === 'copilot') {
    if (!copilotHome) throw new Error('copilot trials need an isolated copilotHome');
    env.COPILOT_HOME = copilotHome;
    const args = [
      '--plugin-dir', pluginDir,
      '--output-format', 'json',
      '--no-custom-instructions',
      '--no-ask-user',
      '--no-auto-update',
      '--disable-builtin-mcps',
      '--disable-mcp-server', 'playwright',
    ];
    if (model) args.push('--model', model);
    // Variadic flag LAST, so it cannot swallow a following option.
    args.push('--available-tools', 'skill', 'view', 'glob', 'grep');
    return { bin: 'copilot', args, env };
  }
  throw new Error(`unknown agent ${JSON.stringify(agent)}`);
}

/**
 * Quote one argument for cmd.exe (used only on Windows, where `.cmd` shims require a shell).
 * Our arguments are flags, tool names and file-system paths — never the prompt (stdin) — so
 * wrapping anything with spaces or cmd metacharacters in double quotes is sufficient.
 */
function quoteForCmd(arg) {
  const s = String(arg);
  return /[\s"&|<>^()%!,;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { buildInvocation, quoteForCmd, TELEMETRY_OPTOUT };
