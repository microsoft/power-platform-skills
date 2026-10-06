'use strict';
// Stand-in for an agent CLI in run-routing tests. Reads the prompt from stdin (as the real CLIs
// do), then behaves according to FAKE_AGENT_MODE:
//   route-then-hang  print a Claude init + Skill tool_use, then stay alive (the runner must kill it)
//   answer           print a text answer + result event and exit 0 (a "none" outcome)
//   crash            print to stderr and exit 3 before any decision (auth/install failure shape)
//   hang             print nothing and never exit (timeout path)
//   init-then-hang   print the init event, then never exit (timeout AFTER transcript output)
//   no-plugin        init event WITHOUT the plugin's skills, then a text answer (isolation guard)
//   claude-failed    Claude init + a FAILED result (error_during_execution), no skill call
//   copilot-failed   Copilot-format FAILED result (exitCode 1), no skill call
//   copilot-answer   Copilot-format successful text answer (exitCode 0), no skill call
// FAKE_AGENT_EXIT sets the process exit code for the *-failed modes (default 1), so a test can
// prove the failed RESULT alone is caught even when the process exits 0.
const mode = process.env.FAKE_AGENT_MODE;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const skills = ['model-apps:app-builder', 'model-apps:genpage', 'model-apps:report-issue', 'model-apps:telemetry'];

// `<agent> --plugin-dir <dir> ... skill list --json` — the Copilot skill-load preflight. Shape per
// FAKE_SKILL_LIST: ok (all four plugin skills + a builtin), missing (builtin only), leak (adds a
// personal skill), broken (exit 2), garbage (non-JSON).
const argv = process.argv.slice(2);
if (argv.includes('skill') && argv.includes('list')) {
  const path = require('node:path');
  const dir = argv[argv.indexOf('--plugin-dir') + 1];
  const plugin = ['app-builder', 'genpage', 'report-issue', 'telemetry'].map((name) => ({ name, source: 'plugin', path: path.join(dir, 'skills', name), enabled: true }));
  const builtin = { name: 'customize-cloud-agent', source: 'builtin', path: '/opt/copilot/builtin/customize-cloud-agent', enabled: true };
  const shape = process.env.FAKE_SKILL_LIST || 'ok';
  if (shape === 'broken') { process.stderr.write('Error: not signed in\n'); process.exit(2); }
  if (shape === 'garbage') { process.stdout.write('not json\n'); process.exit(0); }
  const list = shape === 'missing' ? [builtin]
    : shape === 'leak' ? [...plugin, builtin, { name: 'brainstorming', source: 'personal', path: '/home/u/.copilot/skills/brainstorming', enabled: true }]
      : [...plugin, builtin];
  process.stdout.write(JSON.stringify(list));
  process.exit(0);
}

let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  if (mode === 'crash') {
    process.stderr.write('Error: not signed in\n');
    process.exit(3);
  }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  const failExit = Number(process.env.FAKE_AGENT_EXIT || 1);
  if (mode === 'copilot-failed') {
    out({ type: 'user.message', data: { content: prompt.trim() } });
    out({ type: 'result', exitCode: 1, usage: { premiumRequests: 1 } });
    process.exit(failExit);
  }
  if (mode === 'copilot-answer') {
    out({ type: 'user.message', data: { content: prompt.trim() } });
    out({ type: 'assistant.message', data: { content: 'That is outside these skills.', toolRequests: [] } });
    out({ type: 'result', exitCode: 0, usage: { premiumRequests: 1 } });
    process.exit(0);
  }
  out({ type: 'system', subtype: 'init', skills: mode === 'no-plugin' ? ['design'] : skills });
  if (mode === 'init-then-hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'claude-failed') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, total_cost_usd: 0.001 });
    process.exit(failExit);
  }
  if (mode === 'route-then-hang') {
    const skill = /app/i.test(prompt) ? 'model-apps:app-builder' : 'model-apps:genpage';
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill } }] } });
    setInterval(() => {}, 1000);
    return;
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `no skill for: ${prompt.trim()}` }] } });
  out({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: 0.001 });
  process.exit(0);
});
