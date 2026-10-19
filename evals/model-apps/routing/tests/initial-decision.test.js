'use strict';
// The routing eval grades the decision an agent makes in its FIRST turn, and reports a plugin skill it
// reaches for only later — after a turn that chose none — separately, as a later fallback.
//
// WHY: the agent runs with a cut-down tool menu (skill, view, glob, grep: no file writes, no shell). A
// request that is plainly not for the plugin ("a generic React dashboard, no Power Platform") gets the
// right answer first — no skill applies, the agent looks at the empty workspace to start the work itself
// — and then, with nothing to build with, it asks for a skill as a stand-in. Counting that second turn as
// the routing decision made the case read as a description that pulls the request in. These tests pin the
// split at each layer: which turn a transcript's skill request came in, how a trial is graded on it, how
// the runner reports it, and the whole path against a fake agent that looks before it acts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const { TranscriptParser, parseTranscript } = require('../lib/transcript.js');
const { decisionOf, gradeTrial, summarizeCase } = require('../lib/grade.js');
const { parseArgs, runRouting, spawnTrial, DEFAULTS } = require('../run-routing.js');

const PLUGIN = { pluginName: 'model-apps', pluginSkills: ['app-builder', 'genpage', 'report-issue', 'telemetry'] };
const read = (name) => fs.readFileSync(path.join(__dirname, 'transcripts', name), 'utf8');
const without = (text, pattern) => text.split('\n').filter((line) => !pattern.test(line)).join('\n');
const turnsOf = (parser) => parser.skillCalls.map((c) => c.turn);

// ---------- which turn asked for the skill ----------

test('transcript(copilot): a skill asked for after a turn that only looked at the workspace is turn 1', () => {
  const p = parseTranscript('copilot', read('copilot-look-then-skill.jsonl'), PLUGIN);
  assert.equal(p.routedTo, 'genpage');
  assert.deepEqual(p.skillCalls.map((c) => [c.name, c.turn]), [['genpage', 1]]);
});

test('transcript(copilot): without turn_start events each assistant.message is its own turn', () => {
  const noMarkers = without(read('copilot-look-then-skill.jsonl'), /assistant\.turn_(start|end)/);
  assert.deepEqual(turnsOf(parseTranscript('copilot', noMarkers, PLUGIN)), [1]);
  assert.deepEqual(turnsOf(parseTranscript('copilot', read('copilot-app-builder.jsonl'), PLUGIN)), [0]);
  assert.deepEqual(turnsOf(parseTranscript('copilot', without(read('copilot-app-builder.jsonl'), /assistant\.turn_start/), PLUGIN)), [0]);
});

test('transcript(claude): the content blocks of one response share a turn, and the next response is the next turn', () => {
  const p = parseTranscript('claude', read('claude-look-then-skill.jsonl'), PLUGIN);
  assert.deepEqual(p.skillCalls.map((c) => [c.raw, c.turn]), [['model-apps:genpage', 1]]);
  // A text block and the skill call of the first response are two events of one turn.
  assert.deepEqual(turnsOf(parseTranscript('claude', read('claude-genpage.jsonl'), PLUGIN)), [0]);
});

test('transcript(claude): without message ids a tool result is what separates one response from the next', () => {
  const noIds = read('claude-look-then-skill.jsonl').replace(/"id":"msg_\d+",/g, '');
  assert.doesNotMatch(noIds, /msg_/);
  assert.deepEqual(turnsOf(parseTranscript('claude', noIds, PLUGIN)), [1]);
  assert.deepEqual(turnsOf(parseTranscript('claude', read('claude-genpage.jsonl'), PLUGIN)), [0], 'two events with nothing between them are one response');
});

test('transcript: a skill asked for in the same response as a workspace read is still the first turn', () => {
  const copilot = new TranscriptParser('copilot', PLUGIN);
  copilot.push(JSON.stringify({ type: 'assistant.turn_start', data: { turnId: '0' } }));
  copilot.push(JSON.stringify({ type: 'assistant.message', data: { content: '', toolRequests: [
    { toolCallId: 'a', name: 'view', arguments: { path: '.' } },
    { toolCallId: 'b', name: 'skill', arguments: { skill: 'genpage' } },
  ] } }));
  assert.deepEqual(turnsOf(copilot), [0]);
  const claude = new TranscriptParser('claude', PLUGIN);
  claude.push(JSON.stringify({ type: 'assistant', message: { id: 'msg_01', content: [{ type: 'tool_use', id: 'a', name: 'Read', input: {} }] } }));
  // The tool result of the first call can arrive before the response has finished streaming.
  claude.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] } }));
  claude.push(JSON.stringify({ type: 'assistant', message: { id: 'msg_01', content: [{ type: 'tool_use', id: 'b', name: 'Skill', input: { skill: 'model-apps:genpage' } }] } }));
  assert.deepEqual(turnsOf(claude), [0], 'one message id is one response, whatever arrived between its blocks');
});

test('transcript: a built-in skill in the first turn does not make the plugin skill of the next turn a first-turn decision', () => {
  const p = new TranscriptParser('copilot', PLUGIN);
  const ask = (turnId, id, skill) => {
    p.push(JSON.stringify({ type: 'assistant.turn_start', data: { turnId } }));
    p.push(JSON.stringify({ type: 'assistant.message', data: { toolRequests: [{ toolCallId: id, name: 'skill', arguments: { skill } }] } }));
  };
  ask('0', 'a', 'brainstorming');
  ask('1', 'b', 'app-builder');
  assert.deepEqual(p.skillCalls.map((c) => [c.name, c.ofPlugin, c.turn]), [['brainstorming', false, 0], ['app-builder', true, 1]]);
});

// ---------- grading on the first turn ----------

const call = (name, turn, ofPlugin = true) => ({ raw: name, name, ofPlugin, turn });
const trialOf = (...calls) => ({ routedTo: (calls.find((c) => c.ofPlugin) || {}).name || null, skillCalls: calls });
const NEGATIVE = { id: 21, prompt: 'p', expect: null };
const POSITIVE = { id: 1, prompt: 'p', expect: 'genpage' };

test('decisionOf: the first plugin skill is split by the turn that asked for it', () => {
  assert.deepEqual(decisionOf(trialOf(call('genpage', 0))), { initial: 'genpage', delayed: null, eventual: 'genpage', turn: 0 });
  assert.deepEqual(decisionOf(trialOf(call('genpage', 1))), { initial: null, delayed: 'genpage', eventual: 'genpage', turn: 1 });
  assert.deepEqual(decisionOf(trialOf(call('bash', 1, false))), { initial: null, delayed: null, eventual: null, turn: null });
  assert.deepEqual(decisionOf(trialOf()), { initial: null, delayed: null, eventual: null, turn: null });
  // The first PLUGIN skill decides, whatever was asked for before it.
  assert.equal(decisionOf(trialOf(call('bash', 0, false), call('app-builder', 1), call('genpage', 2))).delayed, 'app-builder');
  // A trial that carries only `routedTo` (a canned trial, an older results file) has no turn to split by.
  assert.deepEqual(decisionOf({ routedTo: 'genpage' }), { initial: 'genpage', delayed: null, eventual: 'genpage', turn: 0 });
  assert.deepEqual(decisionOf({ routedTo: null }), { initial: null, delayed: null, eventual: null, turn: null });
});

test('gradeTrial: graded on the first turn by default, so a later fallback is not the decision', () => {
  const fallback = trialOf(call('genpage', 1));
  const graded = gradeTrial(NEGATIVE, fallback);
  assert.equal(graded.status, 'pass');
  assert.equal(graded.outcome, 'none');
  assert.equal(graded.delayed, 'genpage');
  assert.equal(gradeTrial(NEGATIVE, fallback, 'eventual').status, 'fail', '--grade eventual counts it, as the runner always did');
  assert.equal(gradeTrial(NEGATIVE, trialOf(call('genpage', 0))).status, 'fail', 'a first-turn route on a negative case is still a mis-route');
});

test('gradeTrial: a case that expects a skill needs it in the first turn; asking late is reported, not credited', () => {
  const late = gradeTrial(POSITIVE, trialOf(call('genpage', 1)));
  assert.equal(late.status, 'fail');
  assert.equal(late.outcome, 'none');
  assert.match(late.reason, /none.*genpage.*after its first turn.*expected genpage/);
  assert.equal(gradeTrial(POSITIVE, trialOf(call('genpage', 1)), 'eventual').status, 'pass');
  assert.equal(gradeTrial(POSITIVE, trialOf(call('genpage', 0))).status, 'pass');
  assert.equal(gradeTrial(POSITIVE, trialOf(call('app-builder', 0))).status, 'fail');
});

test('gradeTrial: an errored trial stays an error on either basis', () => {
  for (const basis of ['initial', 'eventual']) {
    assert.equal(gradeTrial(NEGATIVE, { routedTo: null, error: 'boom', skillCalls: [] }, basis).status, 'error');
  }
});

test('gradeTrial: a trial that carries only routedTo is graded as before, on either basis', () => {
  for (const basis of ['initial', 'eventual']) {
    assert.equal(gradeTrial(POSITIVE, { routedTo: 'genpage' }, basis).status, 'pass');
    assert.equal(gradeTrial(NEGATIVE, { routedTo: 'genpage' }, basis).status, 'fail');
    assert.equal(gradeTrial(NEGATIVE, { routedTo: null }, basis).status, 'pass');
  }
});

test('summarizeCase: the first-turn outcomes are graded and the later fallbacks are counted beside them', () => {
  const trials = [trialOf(call('genpage', 1)), trialOf(call('app-builder', 1)), trialOf(), trialOf(call('genpage', 1))];
  const initial = summarizeCase(NEGATIVE, trials, 2 / 3);
  assert.equal(initial.status, 'pass');
  assert.deepEqual(initial.outcomes, { none: 4 });
  assert.deepEqual(initial.delayed, { genpage: 2, 'app-builder': 1 });
  const eventual = summarizeCase(NEGATIVE, trials, 2 / 3, 'eventual');
  assert.equal(eventual.status, 'fail');
  assert.deepEqual(eventual.outcomes, { genpage: 2, 'app-builder': 1, none: 1 });
  assert.deepEqual(eventual.delayed, { genpage: 2, 'app-builder': 1 }, 'the split is reported on either basis');
  assert.deepEqual(summarizeCase(NEGATIVE, [trialOf(), trialOf()], 1).delayed, {}, 'nothing later, nothing to report');
});

test('summarizeCase: a later fallback of an errored trial is not counted', () => {
  const errored = { ...trialOf(call('genpage', 1)), error: 'timed out' };
  const s = summarizeCase(NEGATIVE, [errored, trialOf()], 1);
  assert.deepEqual(s.delayed, {});
  assert.equal(s.valid, 1);
});

// ---------- the runner's report ----------

const EVALS = { evals: [
  { id: 21, tier: 'smoke', prompt: 'generic react dashboard, no Power Platform', expect: null, trap: 'a disclaimer that still names the plugin' },
  { id: 1, tier: 'smoke', prompt: 'add a page to my app', expect: 'genpage' },
] };
const collect = () => {
  const lines = [];
  return { write: (l) => lines.push(l), text: () => lines.join('\n') };
};
const fallbackTrials = () => [trialOf(call('genpage', 1)), trialOf(call('genpage', 1)), trialOf(), trialOf(call('app-builder', 1))];
const trialsFor = () => ({
  21: fallbackTrials(),
  1: [trialOf(call('genpage', 0)), trialOf(call('genpage', 0)), trialOf(call('genpage', 0)), trialOf(call('genpage', 0))],
});
const runner = (byId) => async (_opts, c) => byId[c.id].shift();

test('runRouting: a negative case whose agent looked first and then asked for a skill passes, and says so', async () => {
  const out = collect();
  const file = path.join(os.tmpdir(), `routing-initial-${process.pid}.json`);
  try {
    const { exitCode, results } = await runRouting({ ...DEFAULTS, runs: 4, out: file }, { evalsData: EVALS, plugin: PLUGIN, write: out.write, runTrial: runner(trialsFor()) });
    assert.equal(exitCode, 0, out.text());
    assert.match(out.text(), /^# agent .* · grade initial$/m);
    assert.match(out.text(), /^ok 1 - #21 \[smoke\] expect none — 4\/4 \(none×4\) · later: genpage×2, app-builder×1$/m);
    assert.match(out.text(), /^ok 2 - #1 \[smoke\] expect genpage — 4\/4 \(genpage×4\)$/m, 'a case with no later fallback reads as it always did');
    assert.match(out.text(), /^# later fallbacks: 3 trial\(s\) in 1 case\(s\) chose a plugin skill only after a first turn that chose none \(reported, not graded; --grade eventual counts them\)$/m);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.grade, 'initial');
    const negative = saved.cases.find((c) => c.id === 21);
    assert.deepEqual(negative.outcomes, { none: 4 });
    assert.deepEqual(negative.delayed, { genpage: 2, 'app-builder': 1 });
    assert.deepEqual(negative.trials.map((t) => [t.initial, t.delayed, t.turn]), [[null, 'genpage', 1], [null, 'genpage', 1], [null, null, null], [null, 'app-builder', 1]]);
    assert.equal(negative.trials[0].routedTo, 'genpage', 'routedTo is still the first plugin skill of the run');
    assert.equal(saved.cases.find((c) => c.id === 1).trials[0].turn, 0);
    assert.equal(results.summary.delayedTrials, 3);
    assert.equal(results.summary.delayedCases, 1);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('runRouting: --grade eventual counts the later fallback, as the runner did before the split', async () => {
  const out = collect();
  const { exitCode, results } = await runRouting({ ...DEFAULTS, runs: 4, grade: 'eventual' }, { evalsData: EVALS, plugin: PLUGIN, write: out.write, runTrial: runner(trialsFor()) });
  assert.equal(exitCode, 1, out.text());
  assert.match(out.text(), /^# agent .* · grade eventual$/m);
  assert.match(out.text(), /^not ok 1 - #21 \[smoke\] expect none — 1\/4 \(genpage×2, none×1, app-builder×1\) · later: genpage×2, app-builder×1$/m);
  assert.match(out.text(), /^# later fallbacks: 3 trial\(s\) in 1 case\(s\) chose a plugin skill only after a first turn that chose none \(counted: --grade eventual\)$/m);
  assert.equal(results.grade, 'eventual');
});

test('runRouting: a case that failed with later fallbacks explains them in its block', async () => {
  const out = collect();
  const evalsData = { evals: [{ id: 1, tier: 'smoke', prompt: 'add a page to my app', expect: 'genpage' }] };
  const { exitCode } = await runRouting({ ...DEFAULTS, runs: 2 }, {
    evalsData, plugin: PLUGIN, write: out.write,
    runTrial: runner({ 1: [trialOf(call('genpage', 1)), trialOf(call('genpage', 1))] }),
  });
  assert.equal(exitCode, 1);
  assert.match(out.text(), /^not ok 1 - #1 \[smoke\] expect genpage — 0\/2 \(none×2\) · later: genpage×2$/m);
  assert.match(out.text(), /^ {2}later: "genpage×2 — requested only after a first turn that chose none; not part of the grade \(--grade eventual counts it\)"$/m);
});

test('runRouting: --compare says when the earlier results were graded on a different decision', async () => {
  const prev = path.join(os.tmpdir(), `routing-prev-grade-${process.pid}.json`);
  try {
    // A results file written before the split has no `grade`: its rates counted every later skill request.
    fs.writeFileSync(prev, JSON.stringify({ cases: [{ id: 21, rate: 0.25 }] }));
    const out = collect();
    await runRouting({ ...DEFAULTS, runs: 4, compare: prev, eval: 21 }, { evalsData: EVALS, plugin: PLUGIN, write: out.write, runTrial: runner(trialsFor()) });
    assert.match(out.text(), /^# note: .*was graded on the eventual decision; this run is graded on the initial decision, so a delta can come from the grading \(--grade eventual compares like with like\)$/m);
    assert.match(out.text(), /^# delta #21: 0\.25 → 1\.00$/m);
    fs.writeFileSync(prev, JSON.stringify({ grade: 'initial', cases: [{ id: 21, rate: 1 }] }));
    const same = collect();
    await runRouting({ ...DEFAULTS, runs: 4, compare: prev, eval: 21 }, { evalsData: EVALS, plugin: PLUGIN, write: same.write, runTrial: runner(trialsFor()) });
    assert.doesNotMatch(same.text(), /# note:/);
  } finally {
    fs.rmSync(prev, { force: true });
  }
});

test('parseArgs: --grade takes initial or eventual and defaults to the first turn', () => {
  const fail = (message) => { throw new Error(message); };
  assert.equal(DEFAULTS.grade, 'initial');
  assert.equal(parseArgs([], { fail }).grade, 'initial');
  assert.equal(parseArgs(['--grade', 'eventual'], { fail }).grade, 'eventual');
  for (const argv of [['--grade'], ['--grade', 'first'], ['--grade', '--runs']]) {
    assert.throws(() => parseArgs(argv, { fail }), /--grade/, argv.join(' '));
  }
});

// ---------- the whole path against a fake agent that looks before it acts ----------

const FAKE_TURNS = path.join(__dirname, 'fake-agent-turns.js');
const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

async function until(condition, what) {
  const deadline = Date.now() + 60000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`${what} did not happen within 60000ms`);
    await sleep(10);
  }
}

function lookFirstTrial(mode, agent) {
  let child;
  const trial = spawnTrial({
    agent, bin: process.execPath, binArgs: [FAKE_TURNS], args: [], env: { FAKE_AGENT_MODE: mode },
    prompt: 'Build a generic React dashboard website. No Power Platform.', cwd: os.tmpdir(), timeoutMs: 60000, plugin: PLUGIN,
    loadedSkills: agent === 'copilot' ? PLUGIN.pluginSkills : undefined,
    onStart: (s) => { child = s.child; },
  });
  return { trial, child: () => child };
}

test('spawnTrial: an agent that looks at its workspace and then asks for a skill is a later fallback, in both CLIs', async () => {
  for (const agent of ['claude', 'copilot']) {
    const run = lookFirstTrial(`${agent}-look-then-route`, agent);
    const t = await run.trial;
    assert.equal(t.error, null, agent);
    assert.equal(t.routedTo, 'genpage', agent);
    assert.deepEqual(decisionOf(t), { initial: null, delayed: 'genpage', eventual: 'genpage', turn: 1 }, agent);
    assert.equal(gradeTrial(NEGATIVE, t).status, 'pass', `${agent}: the first turn chose none`);
    assert.equal(gradeTrial(NEGATIVE, t, 'eventual').status, 'fail', agent);
    // `*-look-then-route` never exits on its own, so it has gone only because the runner killed it at the request.
    await until(() => hasExited(run.child()), `the ${agent} agent being killed at its skill request`);
  }
});

test('spawnTrial: an agent that looks at its workspace and then answers in text decided none, with nothing later', async () => {
  for (const agent of ['claude', 'copilot']) {
    const t = await lookFirstTrial(`${agent}-look-then-answer`, agent).trial;
    assert.equal(t.error, null, agent);
    assert.equal(t.routedTo, null, agent);
    assert.deepEqual(decisionOf(t), { initial: null, delayed: null, eventual: null, turn: null }, agent);
  }
});
