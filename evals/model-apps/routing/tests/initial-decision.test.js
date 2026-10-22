'use strict';
// The routing eval grades the WHOLE trial: the first model-apps skill the agent asks for, at ANY turn. That
// is the grade it always had, and these tests keep it exactly as strict. What was added is a separate signal,
// the INITIAL decision — the skill the agent asked for in its first turn, or none — reported beside the
// grade and never in place of it.
//
// WHY the signal: the agent runs with a cut-down tool menu (skill, view, glob, grep: no file writes, no
// shell). A request that is plainly not for the plugin ("a generic React dashboard, no Power Platform") can
// get the right answer first — no skill applies, the agent looks at the empty workspace to start the work
// itself — and then, with nothing to build with, ask for a skill as a stand-in. The grade counts that
// request, so the case fails, and the initial decision says the first turn was right: a reader can tell the
// stand-in from a description that pulls the request in.
// WHY the grade must not move: a negative case exists to fail when the agent reaches for the plugin on a
// request that is not for it. If the first turn decided, any trial that reads the workspace first would slip
// past every negative case. These tests pin the split at each layer: which turn a transcript's skill request
// came in, that the grade of every committed case is the original one, how a trial and a case report the
// initial decision, how the runner prints it, and the whole path against a fake agent that looks before it
// acts.
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

// ---------- the grade is the whole trial, exactly as it was before the first turn was told apart ----------

const call = (name, turn, ofPlugin = true) => ({ raw: name, name, ofPlugin, turn });
const trialOf = (...calls) => ({ routedTo: (calls.find((c) => c.ofPlugin) || {}).name || null, skillCalls: calls });
const NEGATIVE = { id: 21, prompt: 'p', expect: null };
const POSITIVE = { id: 1, prompt: 'p', expect: 'genpage' };
const CASES = require('../evals.json').evals;
const caseById = (id) => CASES.find((c) => c.id === id);
// The negatives among the first 20 committed cases: the assertions the first-turn signal must leave as strict
// as they were.
const ORIGINAL_NEGATIVES = [3, 12, 13, 14, 15];

// The rule as it stood before the first turn was told apart, written out here so that nothing under test can
// move it: the first plugin skill the agent asked for, at any turn, must be one the case accepts.
const ORIGINAL_RULE_PASSES = (evalCase, trial) => {
  const accepted = [evalCase.expect, ...(evalCase.accept || [])].map((s) => (s == null ? 'none' : s));
  return accepted.includes(trial.routedTo == null ? 'none' : trial.routedTo);
};
const TRIAL_SHAPES = [
  trialOf(),
  ...['genpage', 'app-builder', 'report-issue', 'telemetry'].flatMap((skill) => [0, 1, 2].map((turn) => trialOf(call(skill, turn)))),
  trialOf(call('bash', 0, false), call('genpage', 1)),
  trialOf(call('brainstorming', 0, false)),
  { routedTo: 'genpage' },
  { routedTo: null },
];
const shapeLabel = (trial) => JSON.stringify(trial.skillCalls ? trial.skillCalls.map((c) => `${c.name}@${c.turn}`) : trial.routedTo);
// Enough shapes for every kind of three-trial case verdict: none, each of two skills in the first and in a
// later turn, and the two forms of a trial that carries only `routedTo`.
const VERDICT_SHAPES = [
  trialOf(), trialOf(call('genpage', 0)), trialOf(call('genpage', 1)), trialOf(call('app-builder', 0)), trialOf(call('app-builder', 1)),
  { routedTo: 'genpage' }, { routedTo: null },
];

test('the original negative cases are still negatives, and case 1 still expects /genpage', () => {
  for (const id of ORIGINAL_NEGATIVES) assert.equal(caseById(id).expect, null, `#${id}`);
  assert.equal(caseById(1).expect, 'genpage');
});

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

test('gradeTrial: a plugin skill asked for after a first turn that chose none is still the routing decision', () => {
  const fallback = trialOf(call('genpage', 1));
  const graded = gradeTrial(NEGATIVE, fallback);
  assert.equal(graded.status, 'fail', 'a negative case fails when the agent reaches for the plugin, in whatever turn');
  assert.equal(graded.outcome, 'genpage');
  assert.equal(graded.delayed, 'genpage');
  assert.match(graded.reason, /^routed to genpage \(asked for only after its first turn\), expected none$/);
  assert.equal(gradeTrial(NEGATIVE, trialOf(call('genpage', 0))).status, 'fail', 'and in the first turn');
  assert.equal(gradeTrial(NEGATIVE, trialOf()).status, 'pass');
  assert.equal(gradeTrial(POSITIVE, trialOf(call('genpage', 1))).status, 'pass', 'a right skill asked for late still passes a positive case, as it did');
  assert.equal(gradeTrial(POSITIVE, trialOf(call('genpage', 0))).status, 'pass');
  assert.equal(gradeTrial(POSITIVE, trialOf(call('app-builder', 0))).status, 'fail');
  assert.equal(gradeTrial(POSITIVE, trialOf(call('app-builder', 1))).status, 'fail');
});

test('gradeTrial: the initial decision is reported beside the grade and does not change it', () => {
  const late = gradeTrial(NEGATIVE, trialOf(call('genpage', 1)));
  assert.deepEqual(late.initial, { outcome: 'none', status: 'pass' }, 'the first turn chose none, which is what a negative case wants');
  const lateRight = gradeTrial(POSITIVE, trialOf(call('genpage', 1)));
  assert.equal(lateRight.status, 'pass');
  assert.deepEqual(lateRight.initial, { outcome: 'none', status: 'fail' }, 'the right skill came, but not in the first turn');
  const first = gradeTrial(POSITIVE, trialOf(call('genpage', 0)));
  assert.deepEqual([first.status, first.initial, first.delayed], ['pass', { outcome: 'genpage', status: 'pass' }, null]);
  const wrong = gradeTrial(NEGATIVE, trialOf(call('genpage', 0)));
  assert.deepEqual([wrong.status, wrong.initial, wrong.delayed], ['fail', { outcome: 'genpage', status: 'fail' }, null]);
});

test('gradeTrial: an errored trial stays an error, with no decision of either kind', () => {
  const graded = gradeTrial(NEGATIVE, { routedTo: null, error: 'boom', skillCalls: [] });
  assert.equal(graded.status, 'error');
  assert.equal(graded.initial, undefined);
});

test('gradeTrial: a trial that carries only routedTo is graded as before, and that is its initial decision too', () => {
  assert.equal(gradeTrial(POSITIVE, { routedTo: 'genpage' }).status, 'pass');
  assert.equal(gradeTrial(NEGATIVE, { routedTo: 'genpage' }).status, 'fail');
  assert.equal(gradeTrial(NEGATIVE, { routedTo: null }).status, 'pass');
  const graded = gradeTrial(NEGATIVE, { routedTo: 'genpage' });
  assert.deepEqual([graded.initial, graded.delayed], [{ outcome: 'genpage', status: 'fail' }, null]);
  assert.equal(graded.reason, 'routed to genpage, expected none');
});

test('the grade of every committed case is the original one, whatever turn the agent asked for its skill in', () => {
  assert.ok(CASES.length >= 35, 'the original cases and the ones added since');
  for (const evalCase of CASES) {
    for (const trial of TRIAL_SHAPES) {
      const want = ORIGINAL_RULE_PASSES(evalCase, trial) ? 'pass' : 'fail';
      assert.equal(gradeTrial(evalCase, trial).status, want, `#${evalCase.id} ${shapeLabel(trial)}`);
    }
    // The verdict of a case, at the default threshold: 2 of 3 trials must pass the original rule.
    for (const a of VERDICT_SHAPES) {
      for (const b of VERDICT_SHAPES) {
        for (const c of VERDICT_SHAPES) {
          const passing = [a, b, c].filter((trial) => ORIGINAL_RULE_PASSES(evalCase, trial)).length;
          const s = summarizeCase(evalCase, [a, b, c], 2 / 3);
          assert.equal(s.status, passing >= 2 ? 'pass' : 'fail', `#${evalCase.id} ${[a, b, c].map(shapeLabel).join(' ')}`);
          assert.equal(s.passes, passing);
        }
      }
    }
  }
});

test('summarizeCase: the whole trial is graded, and the initial decision is counted beside it', () => {
  const trials = [trialOf(call('genpage', 1)), trialOf(call('app-builder', 1)), trialOf(), trialOf(call('genpage', 1))];
  const s = summarizeCase(NEGATIVE, trials, 2 / 3);
  assert.equal(s.status, 'fail', 'three of the four trials reached for the plugin, after a first turn that did not');
  assert.equal(s.passes, 1);
  assert.deepEqual(s.outcomes, { genpage: 2, 'app-builder': 1, none: 1 });
  assert.deepEqual(s.delayed, { genpage: 2, 'app-builder': 1 });
  assert.deepEqual(s.initial, { passes: 4, valid: 4, rate: 1, outcomes: { none: 4 } });
  // The same lateness on a positive case: it passes, and the initial decision says it was late.
  const late = summarizeCase(POSITIVE, [trialOf(call('genpage', 1)), trialOf(call('genpage', 1)), trialOf(call('genpage', 0))], 2 / 3);
  assert.equal(late.status, 'pass');
  assert.deepEqual(late.initial, { passes: 1, valid: 3, rate: 1 / 3, outcomes: { none: 2, genpage: 1 } });
  const clean = summarizeCase(NEGATIVE, [trialOf(), trialOf()], 1);
  assert.deepEqual(clean.delayed, {}, 'nothing later, nothing to report');
  assert.deepEqual(clean.initial, { passes: 2, valid: 2, rate: 1, outcomes: { none: 2 } });
});

test('summarizeCase: an errored trial counts in neither signal, and a case of errors has no rate in either', () => {
  const errored = { ...trialOf(call('genpage', 1)), error: 'timed out' };
  const s = summarizeCase(NEGATIVE, [errored, trialOf()], 1);
  assert.deepEqual(s.delayed, {});
  assert.equal(s.valid, 1);
  assert.deepEqual(s.initial, { passes: 1, valid: 1, rate: 1, outcomes: { none: 1 } });
  const all = summarizeCase(NEGATIVE, [errored], 1);
  assert.equal(all.status, 'error');
  assert.equal(all.rate, null);
  assert.deepEqual(all.initial, { passes: 0, valid: 0, rate: null, outcomes: {} });
});

// ---------- the transcripts of an agent that reads the workspace first and then asks for a skill ----------

const FIXTURES = { copilot: 'copilot-look-then-skill.jsonl', claude: 'claude-look-then-skill.jsonl' };
const trialFromFixture = (agent) => {
  const parsed = parseTranscript(agent, read(FIXTURES[agent]), PLUGIN);
  return { routedTo: parsed.routedTo, skillCalls: parsed.skillCalls };
};

test('a transcript that reads the workspace and then asks for /genpage fails every original negative case, in both CLIs', () => {
  for (const agent of Object.keys(FIXTURES)) {
    const trial = trialFromFixture(agent);
    assert.deepEqual(decisionOf(trial), { initial: null, delayed: 'genpage', eventual: 'genpage', turn: 1 }, agent);
    for (const id of ORIGINAL_NEGATIVES) {
      const graded = gradeTrial(caseById(id), trial);
      assert.equal(graded.status, 'fail', `${agent} #${id}`);
      assert.equal(graded.outcome, 'genpage', `${agent} #${id}`);
      assert.deepEqual(graded.initial, { outcome: 'none', status: 'pass' }, `${agent} #${id}: no plugin skill in the first turn, reported beside the failure`);
    }
    assert.equal(gradeTrial(caseById(1), trial).status, 'pass', `${agent}: the /genpage case still passes, as it did`);
    assert.equal(gradeTrial(caseById(2), trial).status, 'fail', `${agent}: and the /app-builder case still fails`);
  }
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

test('runRouting: a negative case whose agent looked first and then asked for a skill fails, and says its first turn chose none', async () => {
  const out = collect();
  const file = path.join(os.tmpdir(), `routing-initial-${process.pid}.json`);
  try {
    const { exitCode, results } = await runRouting({ ...DEFAULTS, runs: 4, out: file }, { evalsData: EVALS, plugin: PLUGIN, write: out.write, runTrial: runner(trialsFor()) });
    assert.equal(exitCode, 1, out.text());
    assert.match(out.text(), /^not ok 1 - #21 \[smoke\] expect none — 1\/4 \(genpage×2, none×1, app-builder×1\) · first turn: 4\/4 \(none×4\) · later: genpage×2, app-builder×1$/m);
    assert.match(out.text(), /^ok 2 - #1 \[smoke\] expect genpage — 4\/4 \(genpage×4\)$/m, 'a case with no later fallback reads as it always did');
    assert.match(out.text(), /^# cases 2 \(pass 1, fail 1, error 0\)$/m);
    assert.match(out.text(), /^# later fallbacks: 3 trial\(s\) in 1 case\(s\) chose a plugin skill only after a first turn that chose none \(counted in the grade; the first-turn decision is shown beside each case\)$/m);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal('grade' in saved, false, 'there is one grade, and it is the whole trial');
    const negative = saved.cases.find((c) => c.id === 21);
    assert.equal(negative.status, 'fail');
    assert.equal(negative.rate, 1 / 4);
    assert.deepEqual(negative.outcomes, { genpage: 2, none: 1, 'app-builder': 1 });
    assert.deepEqual(negative.delayed, { genpage: 2, 'app-builder': 1 });
    assert.deepEqual(negative.initial, { passes: 4, valid: 4, rate: 1, outcomes: { none: 4 } });
    assert.deepEqual(negative.trials.map((t) => [t.initial, t.delayed, t.turn]), [[null, 'genpage', 1], [null, 'genpage', 1], [null, null, null], [null, 'app-builder', 1]]);
    assert.equal(negative.trials[0].routedTo, 'genpage', 'routedTo is still the first plugin skill of the run');
    const positive = saved.cases.find((c) => c.id === 1);
    assert.deepEqual(positive.initial, { passes: 4, valid: 4, rate: 1, outcomes: { genpage: 4 } });
    assert.equal(positive.trials[0].turn, 0);
    assert.equal(results.summary.fail, 1);
    assert.equal(results.summary.delayedTrials, 3);
    assert.equal(results.summary.delayedCases, 1);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('runRouting: every original negative case fails on a run that read the workspace first and then asked for /genpage, in both CLIs', async () => {
  const cases = ORIGINAL_NEGATIVES.map(caseById);
  for (const agent of Object.keys(FIXTURES)) {
    const out = collect();
    const trials = Object.fromEntries(cases.map((c) => [c.id, Array.from({ length: 3 }, () => trialFromFixture(agent))]));
    const { exitCode, results } = await runRouting({ ...DEFAULTS, runs: 3, agent }, { evalsData: { evals: cases }, plugin: PLUGIN, write: out.write, runTrial: runner(trials) });
    assert.equal(exitCode, 1, `${agent}\n${out.text()}`);
    assert.equal(results.summary.fail, cases.length, agent);
    assert.equal(results.summary.pass, 0, agent);
    for (const c of cases) {
      assert.match(out.text(), new RegExp(`^not ok \\d+ - #${c.id} \\[${c.tier}\\] expect none — 0/3 \\(genpage×3\\) · first turn: 3/3 \\(none×3\\) · later: genpage×3$`, 'm'), `${agent} #${c.id}`);
    }
  }
});

test('runRouting: a positive case whose agent asks for the right skill only in turn 1 passes, and says it came late', async () => {
  const out = collect();
  const { exitCode } = await runRouting({ ...DEFAULTS, runs: 3 }, {
    evalsData: { evals: [caseById(1)] }, plugin: PLUGIN, write: out.write,
    runTrial: runner({ 1: [1, 2, 3].map(() => trialFromFixture('copilot')) }),
  });
  assert.equal(exitCode, 0, out.text());
  assert.match(out.text(), /^ok 1 - #1 \[smoke\] expect genpage — 3\/3 \(genpage×3\) · first turn: 0\/3 \(none×3\) · later: genpage×3$/m);
});

test('runRouting: a case that failed on later fallbacks says in its block that they are counted', async () => {
  const out = collect();
  const evalsData = { evals: [{ id: 21, tier: 'smoke', prompt: 'react, no Power Platform', expect: null, trap: 'a disclaimer' }] };
  const { exitCode } = await runRouting({ ...DEFAULTS, runs: 2 }, {
    evalsData, plugin: PLUGIN, write: out.write,
    runTrial: runner({ 21: [trialOf(call('genpage', 1)), trialOf(call('genpage', 1))] }),
  });
  assert.equal(exitCode, 1);
  assert.match(out.text(), /^not ok 1 - #21 \[smoke\] expect none — 0\/2 \(genpage×2\) · first turn: 2\/2 \(none×2\) · later: genpage×2$/m);
  assert.match(out.text(), /^ {2}later: "genpage×2 — asked for only after a first turn that chose none; counted in the grade, as is any skill the agent asks for"$/m);
});

test('runRouting: --compare compares the grade, as before, and adds no note about the first turn', async () => {
  const prev = path.join(os.tmpdir(), `routing-prev-grade-${process.pid}.json`);
  try {
    fs.writeFileSync(prev, JSON.stringify({ cases: [{ id: 21, rate: 0.75 }] }));
    const out = collect();
    await runRouting({ ...DEFAULTS, runs: 4, compare: prev, eval: 21 }, { evalsData: EVALS, plugin: PLUGIN, write: out.write, runTrial: runner(trialsFor()) });
    assert.match(out.text(), /^# delta #21: 0\.75 → 0\.25$/m);
    assert.doesNotMatch(out.text(), /# note:/);
  } finally {
    fs.rmSync(prev, { force: true });
  }
});

test('the initial decision is only ever reported: no option and no trial field makes it the grade', async () => {
  const fail = (message) => { throw new Error(message); };
  assert.equal('grade' in DEFAULTS, false);
  for (const argv of [['--grade', 'initial'], ['--grade', 'eventual']]) {
    assert.throws(() => parseArgs(argv, { fail }), /unknown argument "--grade"/, argv.join(' '));
  }
  // Nor through the programmatic seam the tests use.
  const out = collect();
  const { exitCode } = await runRouting({ ...DEFAULTS, runs: 4, grade: 'initial' }, { evalsData: EVALS, plugin: PLUGIN, write: out.write, runTrial: runner(trialsFor()) });
  assert.equal(exitCode, 1, out.text());
  assert.match(out.text(), /^not ok 1 - #21 /m);
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

test('spawnTrial: an agent that looks at its workspace and then asks for a skill is graded on that request, in both CLIs', async () => {
  for (const agent of ['claude', 'copilot']) {
    const run = lookFirstTrial(`${agent}-look-then-route`, agent);
    const t = await run.trial;
    assert.equal(t.error, null, agent);
    assert.equal(t.routedTo, 'genpage', agent);
    assert.deepEqual(decisionOf(t), { initial: null, delayed: 'genpage', eventual: 'genpage', turn: 1 }, agent);
    const graded = gradeTrial(NEGATIVE, t);
    assert.equal(graded.status, 'fail', `${agent}: the request is the routing decision, as it always was`);
    assert.deepEqual(graded.initial, { outcome: 'none', status: 'pass' }, `${agent}: reported beside it, the first turn chose none`);
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
