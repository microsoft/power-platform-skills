'use strict';
// Pure-unit tests for the routing eval library: transcript parsing (both CLIs), grading, the
// evals.json validator, and the agent invocation flags. No agent is launched here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TranscriptParser, parseTranscript } = require('../lib/transcript.js');
const { gradeTrial, summarizeCase, validateEvals, acceptable } = require('../lib/grade.js');
const { buildInvocation, quoteForCmd, TELEMETRY_OPTOUT } = require('../lib/agents.js');

const PLUGIN = { pluginName: 'model-apps', pluginSkills: ['app-builder', 'genpage', 'report-issue', 'telemetry'] };
const sample = (name) => fs.readFileSync(path.join(__dirname, 'transcripts', name), 'utf8');

// ---------- transcript ----------

test('transcript(claude): namespaced Skill tool_use is the routing decision; init skills recorded', () => {
  const p = parseTranscript('claude', sample('claude-genpage.jsonl'), PLUGIN);
  assert.equal(p.routedTo, 'genpage');
  assert.deepEqual(p.skillCalls.map((c) => c.raw), ['model-apps:genpage']);
  assert.ok(p.loadedSkills.includes('model-apps:app-builder'));
  assert.equal(p.result.costUsd, 0.0123);
  assert.equal(p.decided, true);
});

test('transcript(copilot): unprefixed skill, de-duplicated across assistant.message and tool.execution_start', () => {
  const p = parseTranscript('copilot', sample('copilot-app-builder.jsonl'), PLUGIN);
  assert.equal(p.routedTo, 'app-builder');
  assert.equal(p.skillCalls.length, 1, 'the execution_start echo of the same toolCallId must not double-count');
  assert.equal(p.result.premiumRequests, 1);
  assert.equal(p.loadedSkills, null, 'Copilot does not report loaded skills');
});

test('transcript(copilot): a run that answers in text routes to none, and is decided by its result event', () => {
  const p = parseTranscript('copilot', sample('copilot-none.jsonl'), PLUGIN);
  assert.equal(p.routedTo, null);
  assert.equal(p.decided, true);
  assert.match(p.text, /Power Pages/);
});

test('transcript: a built-in or foreign-plugin skill is recorded but is not a routing decision', () => {
  const p = new TranscriptParser('claude', PLUGIN);
  const use = (id, skill) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Skill', input: { skill } }] } });
  p.push(use('a', 'design'));
  p.push(use('b', 'other-plugin:genpage')); // same skill name, different plugin
  assert.equal(p.routedTo, null);
  assert.equal(p.decided, false, 'the model may still route after a built-in skill');
  p.push(use('c', 'model-apps:app-builder'));
  assert.equal(p.routedTo, 'app-builder');
  assert.deepEqual(p.skillCalls.map((c) => c.ofPlugin), [false, false, true]);
});

test('transcript: an unprefixed name only counts when the plugin ships that skill', () => {
  const p = new TranscriptParser('copilot', PLUGIN);
  p.push(JSON.stringify({ type: 'assistant.message', data: { toolRequests: [{ toolCallId: 'x', name: 'skill', arguments: { skill: 'brainstorming' } }] } }));
  assert.equal(p.routedTo, null);
});

test('transcript: banners, blank lines, partial JSON and stderr noise are ignored, not fatal', () => {
  const p = new TranscriptParser('claude', PLUGIN);
  for (const l of ['', 'Warning: something', '{"type":"assistant","message":', '   ', '[]', 'null']) p.push(l);
  assert.deepEqual(p.skillCalls, []);
  assert.equal(p.decided, false);
});

test('transcript: resultError reports a failed terminal result for both CLIs and nothing for success', () => {
  const claude = (r) => { const p = new TranscriptParser('claude', PLUGIN); p.push(JSON.stringify({ type: 'result', ...r })); return p.resultError; };
  assert.equal(claude({ subtype: 'success', is_error: false }), null);
  assert.equal(claude({ subtype: 'error_max_turns', is_error: false }), 'claude result error_max_turns');
  assert.equal(claude({ subtype: 'success', is_error: true }), 'claude result success (is_error)');
  const copilot = (r) => { const p = new TranscriptParser('copilot', PLUGIN); p.push(JSON.stringify({ type: 'result', ...r })); return p.resultError; };
  assert.equal(copilot({ exitCode: 0 }), null);
  assert.equal(copilot({ exitCode: 1 }), 'copilot result exitCode 1');
  assert.equal(new TranscriptParser('claude', PLUGIN).resultError, null, 'no result yet is not a failure');
});

test('transcript: an unknown agent is rejected', () => {
  assert.throws(() => new TranscriptParser('gemini', PLUGIN), /unknown agent/);
});

// ---------- grading ----------

const CASE_GENPAGE = { id: 1, prompt: 'p', expect: 'genpage' };
const CASE_NONE = { id: 2, prompt: 'p', expect: null };
const CASE_AMBIG = { id: 3, prompt: 'p', expect: 'genpage', accept: ['app-builder'] };

test('grade: acceptable outcomes include accept[] and map null to "none"', () => {
  assert.deepEqual(acceptable(CASE_AMBIG), ['genpage', 'app-builder']);
  assert.deepEqual(acceptable(CASE_NONE), ['none']);
});

test('grade: trial pass/fail/error', () => {
  assert.equal(gradeTrial(CASE_GENPAGE, { routedTo: 'genpage' }).status, 'pass');
  const wrong = gradeTrial(CASE_GENPAGE, { routedTo: 'app-builder' });
  assert.equal(wrong.status, 'fail');
  assert.match(wrong.reason, /routed to app-builder, expected genpage/);
  assert.equal(gradeTrial(CASE_NONE, { routedTo: null }).status, 'pass');
  assert.equal(gradeTrial(CASE_NONE, { routedTo: 'genpage' }).status, 'fail');
  assert.equal(gradeTrial(CASE_AMBIG, { routedTo: 'app-builder' }).status, 'pass');
  assert.equal(gradeTrial(CASE_AMBIG, { routedTo: null }).status, 'fail', 'ambiguous ≠ anything goes');
  assert.equal(gradeTrial(CASE_GENPAGE, { routedTo: null, error: 'boom' }).status, 'error');
});

test('grade: a timed-out trial arrives as an error and is never graded as "none"', () => {
  const g = gradeTrial(CASE_NONE, { routedTo: null, timedOut: true, error: 'timed out before routing (3 transcript events, no decision)' });
  assert.equal(g.status, 'error', 'a negative case must not pass on a run that never finished');
});

test('summarize: threshold over non-error trials; 2/3 meets 0.67', () => {
  const t = (routedTo) => ({ routedTo });
  assert.equal(summarizeCase(CASE_GENPAGE, [t('genpage'), t('genpage'), t(null)], 0.67).status, 'pass');
  assert.equal(summarizeCase(CASE_GENPAGE, [t('genpage'), t(null), t(null)], 0.67).status, 'fail');
  assert.equal(summarizeCase(CASE_GENPAGE, [t('genpage'), t('genpage'), t(null)], 0.8).status, 'fail', 'tolerance is two-decimal, not a loophole');
  const s = summarizeCase(CASE_GENPAGE, [t('genpage'), t('genpage'), { routedTo: null, error: 'spawn' }], 1);
  assert.equal(s.status, 'pass', 'an errored trial is excluded, not counted as a fail');
  assert.equal(s.valid, 2);
  assert.deepEqual(s.errors, ['spawn']);
  assert.deepEqual(s.outcomes, { genpage: 2 });
});

test('summarize: every trial errored → error, never pass or fail', () => {
  const s = summarizeCase(CASE_NONE, [{ routedTo: null, error: 'not signed in' }], 0.67);
  assert.equal(s.status, 'error');
  assert.equal(s.rate, null);
});

test('validateEvals: the committed evals.json is valid', () => {
  const data = require('../evals.json');
  assert.deepEqual(validateEvals(data, PLUGIN.pluginSkills), []);
  // Coverage the suite exists for: every authoring skill is a positive target AND there are
  // negatives. If someone trims the file down to one shape, the eval stops measuring routing.
  const expects = new Set(data.evals.map((e) => e.expect));
  for (const want of ['genpage', 'app-builder', null]) assert.ok(expects.has(want), `no case expects ${want}`);
  assert.ok(data.evals.filter((e) => e.expect === null).length >= 3, 'keep at least 3 negative (bleed) cases');
});

test('validateEvals: rejects bad ids, prompts, unknown skills and a missing expect', () => {
  const errs = validateEvals({ evals: [
    { id: 1, tier: 'smoke', prompt: 'x', expect: 'genpage' },
    { id: 1, tier: 'smoke', prompt: 'x', expect: 'genpage' },
    { id: -2, tier: 'smoke', prompt: '', expect: 'genpages' },
    { id: 3, tier: 'smoke', prompt: 'x' },
    { id: 4, tier: 'smoke', prompt: 'x', expect: null, accept: ['canvas'] },
  ] }, PLUGIN.pluginSkills);
  const all = errs.join('\n');
  assert.match(all, /eval 1: duplicate id/);
  assert.match(all, /eval -2: id must be/);
  assert.match(all, /eval -2: prompt/);
  assert.match(all, /"genpages" is not a plugin skill/);
  assert.match(all, /eval 3: "expect" is required/);
  assert.match(all, /accept "canvas"/);
  assert.deepEqual(validateEvals({}, []), ['evals.json must have an "evals" array']);
});

// ---------- agent invocation ----------

test('agents(claude): isolation + read-only tool allowlist + stream-json + telemetry opt-out', () => {
  const inv = buildInvocation('claude', { pluginDir: '/p', model: 'sonnet' });
  assert.equal(inv.bin, 'claude');
  const a = inv.args.join(' ');
  for (const flag of ['-p', '--plugin-dir /p', '--restricted', '--strict-mcp-config',
    '--tools Skill,Read,Glob,Grep', '--output-format stream-json', '--verbose', '--no-session-persistence', '--model sonnet']) {
    assert.ok(a.includes(flag), `missing ${flag}`);
  }
  assert.equal(inv.env[TELEMETRY_OPTOUT], '1');
  assert.ok(!buildInvocation('claude', { pluginDir: '/p' }).args.includes('--model'), 'no --model unless asked: the CLI default applies');
  // --safe-mode was measured to drop the --plugin-dir plugin's skills, so every trial would be a
  // harness error; it must not creep back in as an "isolation" improvement.
  assert.ok(!inv.args.includes('--safe-mode'));
});

test('agents(copilot): isolated COPILOT_HOME required; variadic --available-tools is last', () => {
  assert.throws(() => buildInvocation('copilot', { pluginDir: '/p' }), /copilotHome/);
  const inv = buildInvocation('copilot', { pluginDir: '/p', copilotHome: '/h', model: 'm' });
  assert.equal(inv.env.COPILOT_HOME, '/h');
  assert.equal(inv.env[TELEMETRY_OPTOUT], '1');
  const i = inv.args.indexOf('--available-tools');
  assert.deepEqual(inv.args.slice(i), ['--available-tools', 'skill', 'view', 'glob', 'grep']);
  for (const flag of ['--no-custom-instructions', '--no-ask-user', '--disable-builtin-mcps', '--output-format']) {
    assert.ok(inv.args.includes(flag), `missing ${flag}`);
  }
  assert.deepEqual(inv.args.slice(inv.args.indexOf('--disable-mcp-server'), inv.args.indexOf('--disable-mcp-server') + 2), ['--disable-mcp-server', 'playwright']);
});

test('agents: quoteForCmd quotes paths with spaces and cmd metacharacters only', () => {
  assert.equal(quoteForCmd('--verbose'), '--verbose');
  assert.equal(quoteForCmd('C:\\Program Files\\x'), '"C:\\Program Files\\x"');
  assert.equal(quoteForCmd('a&b'), '"a&b"');
  assert.equal(quoteForCmd('Skill,Read'), '"Skill,Read"');
  assert.equal(quoteForCmd('say "hi"'), '"say ""hi"""');
});
