'use strict';
// Stand-in for an agent CLI in run-routing tests. Reads the prompt from stdin (as the real CLIs
// do), then behaves according to FAKE_AGENT_MODE:
//   route-then-hang  print a Claude init + Skill tool_use, then stay alive (the runner must kill it)
//   answer           print a text answer + result event and exit 0 (a "none" outcome)
//   crash            print to stderr and exit 3 before any decision (auth/install failure shape)
//   hang             print nothing and never exit (timeout path)
//   init-then-hang   print the init event, then never exit (timeout AFTER transcript output)
//   no-plugin        init event WITHOUT the plugin's skills, then a text answer (isolation guard)
const mode = process.env.FAKE_AGENT_MODE;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const skills = ['model-apps:app-builder', 'model-apps:genpage', 'model-apps:report-issue', 'model-apps:telemetry'];

let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  if (mode === 'crash') {
    process.stderr.write('Error: not signed in\n');
    process.exit(3);
  }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  out({ type: 'system', subtype: 'init', skills: mode === 'no-plugin' ? ['design'] : skills });
  if (mode === 'init-then-hang') { setInterval(() => {}, 1000); return; }
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
