'use strict';
// Stand-in for an agent CLI in run-routing tests whose run takes MORE THAN ONE turn: it looks at its
// (empty) workspace first and only then acts — the shape of the runs that made the routing eval tell a
// first-turn decision from a later one. fake-agent.js covers the single-turn shapes. Reads the prompt
// from stdin like the real CLIs, then behaves according to FAKE_AGENT_MODE:
//   claude-look-then-route    turn 0 reads the workspace (a text block and a tool call of ONE response,
//                             as two events), a tool result comes back, turn 1 asks for a skill, then the
//                             process stays alive (the runner must kill it at the skill request)
//   copilot-look-then-route   the same in Copilot's JSON events, with turn_start / turn_end around each turn
//   claude-look-then-answer   turn 0 reads the workspace, turn 1 answers in text and the run ends successfully
//   copilot-look-then-answer  the same in Copilot's JSON events
// FAKE_AGENT_SKILL names the skill turn 1 asks for (default genpage).
const mode = process.env.FAKE_AGENT_MODE;
const skill = process.env.FAKE_AGENT_SKILL || 'genpage';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const claudeSkills = ['model-apps:app-builder', 'model-apps:genpage', 'model-apps:report-issue', 'model-apps:telemetry'];

function claude(finalTurn) {
  out({ type: 'system', subtype: 'init', skills: claudeSkills });
  out({ type: 'assistant', message: { id: 'msg_01', role: 'assistant', content: [{ type: 'text', text: 'No skill applies; I will look at the workspace first.' }] } });
  out({ type: 'assistant', message: { id: 'msg_01', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'Glob', input: { pattern: '**/*' } }] } });
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'No files found' }] } });
  if (finalTurn === 'route') {
    out({ type: 'assistant', message: { id: 'msg_02', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_02', name: 'Skill', input: { skill: `model-apps:${skill}` } }] } });
    setInterval(() => {}, 1000);
    return;
  }
  out({ type: 'assistant', message: { id: 'msg_02', role: 'assistant', content: [{ type: 'text', text: 'There is no tool here to build that.' }] } });
  out({ type: 'result', subtype: 'success', num_turns: 2, total_cost_usd: 0.001 });
  process.exit(0);
}

function copilot(finalTurn, prompt) {
  out({ type: 'user.message', data: { content: prompt.trim() } });
  out({ type: 'assistant.turn_start', data: { turnId: '0' } });
  out({ type: 'assistant.message', data: { messageId: 'm1', content: '', toolRequests: [{ toolCallId: 'toolu_01', name: 'view', arguments: { path: '<workspace>' } }] } });
  out({ type: 'tool.execution_start', data: { toolCallId: 'toolu_01', toolName: 'view', arguments: { path: '<workspace>' } } });
  out({ type: 'tool.execution_complete', data: { toolCallId: 'toolu_01', success: true } });
  out({ type: 'assistant.turn_end', data: { turnId: '0' } });
  out({ type: 'assistant.turn_start', data: { turnId: '1' } });
  if (finalTurn === 'route') {
    out({ type: 'assistant.message', data: { messageId: 'm2', content: '', toolRequests: [{ toolCallId: 'toolu_02', name: 'skill', arguments: { skill } }] } });
    setInterval(() => {}, 1000);
    return;
  }
  out({ type: 'assistant.message', data: { messageId: 'm2', content: 'There is no tool here to build that.', toolRequests: [] } });
  out({ type: 'assistant.turn_end', data: { turnId: '1' } });
  out({ type: 'result', exitCode: 0, usage: { premiumRequests: 1 } });
  process.exit(0);
}

let prompt = '';
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  const [agent, , , final] = String(mode).split('-');
  if (agent === 'claude') claude(final);
  else if (agent === 'copilot') copilot(final, prompt);
  else { process.stderr.write(`unknown FAKE_AGENT_MODE ${mode}\n`); process.exit(3); }
});
