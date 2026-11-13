import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeMetrics } from '@microsoft/vally';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parse as parseYaml } from 'yaml';
import { evaluate, outcomeRecord, parseArgs } from '../run.mjs';
import { loadSuites, repoRoot, trialGraders } from '../suites.mjs';
import { DEFAULT_MODELS } from '../models.mjs';

test('only the skills being improved have Vally suites; legacy-only skills remain unselected', async () => {
  const suites = await loadSuites();
  assert.deepEqual(suites.map(suite => suite.name), ['create-site', 'setup-auth']);
  assert.ok(suites.every(suite => suite.stimuli.length >= 4));
  assert.ok(suites.every(suite => !suite.stimuli.some(stimulus =>
    stimulus.environment?.files?.some(file => file.src.startsWith('checks/')))));
  await assert.rejects(() => loadSuites({ skill: 'setup-datamodel' }), /No evaluation suite/);
});

test('manual workflow selects available suites and rejects skills without one', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-selection-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow = parseYaml(await readFile(path.join(repoRoot, '.github/workflows/power-pages-evals.yml'), 'utf8'));
  const command = workflow.jobs.select.steps.find(step => step.id === 'select').run;
  const script = /node --input-type=module <<'JS'\n([\s\S]+)\nJS\s*$/.exec(command)?.[1];
  assert.ok(script, 'the matrix selector must be executable without model dependencies');
  for (const [selected, expected] of [['all', ['create-site', 'setup-auth']], ['create-site', ['create-site']]]) {
    const output = path.join(root, selected);
    execFileSync(process.execPath, ['--input-type=module', '-'], {
      input: script, cwd: repoRoot,
      env: { ...process.env, SELECTED_SKILL: selected, GITHUB_OUTPUT: output, MODELS: '', JUDGE_MODEL: '', REASONING_EFFORT: '', JUDGE_REASONING_EFFORT: '' },
    });
    const matrix = JSON.parse((await readFile(output, 'utf8')).trim().slice('matrix='.length));
    assert.deepEqual([...new Set(matrix.map(item => item.skill))], expected);
    assert.deepEqual([...new Set(matrix.map(item => item.model))], DEFAULT_MODELS);
    assert.equal(matrix.length, expected.length * DEFAULT_MODELS.length);
  }
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-'], {
    input: script, cwd: repoRoot, stdio: 'pipe',
    env: { ...process.env, SELECTED_SKILL: 'setup-datamodel', GITHUB_OUTPUT: path.join(root, 'missing') },
  }), /Unknown Power Pages evaluation suite/);
});

test('CLI rejects ambiguous models, missing paired settings, and invalid run counts', () => {
  assert.throws(() => parseArgs(['run', '--model', 'test']), /judge-model/);
  assert.throws(() => parseArgs(['run', '--runs', '0']), /runs/);
  assert.throws(() => parseArgs(['validate', '--case', 'x']), /requires --skill/);
  assert.throws(() => parseArgs(['validate', '--unexpected', 'x']), /Invalid option/);
  assert.throws(() => parseArgs(['run', '--runs', '1', '--runs', '2']), /Duplicate option/);
  assert.throws(() => parseArgs(['run', '--model', 'auto', '--judge-model', 'test']), /explicit model IDs/);
  assert.throws(() => parseArgs(['run', '--model', 'test', '--judge-model', 'test']), /different model/);
  assert.throws(() => parseArgs(['run', '--model', 'test', '--judge-model', 'judge', '--reasoning-effort', 'invalid']), /reasoning effort/);
  const options = parseArgs(['run', '--model', 'test', '--judge-model', 'judge', '--local-auth', '--reasoning-effort', 'high']);
  assert.equal(options.localAuth, true);
  assert.equal(options.reasoningEffort, 'high');
  assert.equal(options.judgeReasoningEffort, 'medium');
});

test('required artifact failures cannot be averaged away by a high rubric score', () => {
  const record = outcomeRecord({
    stimulus: { name: 'model', tags: { kind: 'capability' } }, variant: 'skilled', trial: 0,
    trajectory: { endReason: 'completed', metrics: {} },
    grade: { score: 0.99, details: [
      { name: 'artifact-correctness', passed: false },
      { name: 'artifact-quality', passed: true },
    ] },
  });
  assert.equal(record.status, 'failed');
  assert.equal(record.score, 0.99);
  const error = outcomeRecord({
    stimulus: { name: 'model', tags: { kind: 'capability' } }, variant: 'baseline', trial: 0,
    trajectory: { endReason: 'completed', metrics: {} },
    grade: { score: 1, details: [{ name: 'quality', passed: false, status: 'error' }] },
  });
  assert.equal(error.status, 'error');
  assert.equal(error.score, null);
});

test('dormancy is checked on treatment without manufacturing baseline routing wins', async () => {
  const [suite] = await loadSuites({ skill: 'setup-auth' });
  const stimulus = suite.stimuli.find(item => item.tags.kind === 'dormancy');
  const skilled = trialGraders(stimulus, { suite, variant: 'skilled', evidenceDir: '/evidence' });
  assert.ok(skilled.some(grader => grader.type === 'skill-invocation' && grader.config.disallowed.includes('setup-auth')));
});

test('real Vally setup persists isolated trials and accounts for missing or failed judge calls', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-pipeline-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [suite] = await loadSuites({ skill: 'setup-auth' });
  const invocations = [];
  let judgeCalls = 0;
  const executor = {
    name: 'test-offline', shutdown: async () => {},
    execute: async (stimulus, options) => {
      assert.equal(options.reasoningEffort, 'high');
      invocations.push({ workDir: options.workDir, skills: options.skills.map(skill => skill.name) });
      return {
        id: `test-${invocations.length}`, stimulus, workDir: options.workDir,
        output: 'This is a test-only executor with no generated deliverable.', events: [],
        metrics: {
          ...computeMetrics([]), wallTimeMs: 1,
          reportedTokenUsage: invocations.length === 1
            ? { inputTokens: 110, outputTokens: 24, cacheReadTokens: 80, cacheWriteTokens: null }
            : null,
        }, endReason: 'completed',
        metadata: { model: options.model, skillsLoaded: [], executor: 'test-offline', sessionID: 'test-only' },
      };
    },
  };
  const judge = {
    supportsWorkspaceDelivery: true, shutdown: async () => {},
    judge: async options => {
      assert.equal(options.reasoningEffort, 'low');
      assert.equal(options.model, 'test-judge');
      judgeCalls++;
      assert.ok(options.workspace.evidenceFiles.length > 0);
      if (judgeCalls === 3) throw new Error('test judge failure');
      return {
        args: {
          rubric_scores: [{ criterion: 'test-only rubric', score: 5, reasoning: 'Deterministic test, not model evidence' }],
          overall_score: 5, overall_reasoning: 'Deterministic test, not model evidence',
        }, latencyMs: 0, remindersUsed: 0,
        ...(judgeCalls !== 2 ? { tokenUsage: { inputTokens: 40, outputTokens: 10 } } : {}),
      };
    },
  };
  const out = path.join(root, 'run');
  const { summary } = await evaluate({
    skill: 'setup-auth', case: suite.stimuli[0].name, runs: 2,
    model: 'test-model', judgeModel: 'test-judge', reasoningEffort: 'high', judgeReasoningEffort: 'low', out,
  }, { executor, judge });
  assert.deepEqual(invocations.map(invocation => invocation.skills), [
    [], ['setup-auth'], ['setup-auth'], [],
  ]);
  assert.notEqual(invocations[0].workDir, invocations[1].workDir);
  assert.ok(invocations.every(invocation => !invocation.workDir.startsWith(repoRoot)));
  assert.deepEqual(summary.suites[0].results.map(result => result.status), ['failed', 'failed', 'error', 'failed']);
  assert.equal(summary.schemaVersion, 3);
  assert.equal(summary.reasoningEffort, 'high');
  assert.equal(summary.judgeReasoningEffort, 'low');
  assert.equal(summary.suites[0].results[0].tokens, 134);
  assert.deepEqual(summary.suites[0].results[0].agentUsage, {
    inputTokens: 110, outputTokens: 24, cacheReadTokens: 80, cacheWriteTokens: null,
  });
  assert.deepEqual(summary.suites[0].results[0].judgeUsage, {
    calls: 1, reportedCalls: 1, inputTokens: 40, outputTokens: 10,
  });
  assert.equal(summary.suites[0].results[1].tokens, null);
  assert.equal(summary.suites[0].results[1].agentUsage, null);
  assert.deepEqual(summary.suites[0].results[1].judgeUsage, {
    calls: 1, reportedCalls: 0, inputTokens: 0, outputTokens: 0,
  });
  assert.deepEqual(summary.suites[0].results[2].judgeUsage, {
    calls: 1, reportedCalls: 0, inputTokens: 0, outputTokens: 0,
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'summary.json'), 'utf8')), summary);
  const published = await readFile(path.join(out, 'summary.json'), 'utf8');
  const require = createRequire(import.meta.url);
  const { validateSummary } = require('../../../site/lib/evaluations.js');
  assert.equal(validateSummary(summary), summary);
  assert.ok(!published.includes('test-only executor'));
  assert.ok(!published.includes(root));
  assert.ok(!published.includes('overall_reasoning'));
  assert.equal(JSON.parse(await readFile(path.join(out, 'review-index.json'), 'utf8')).cases.length, 4);
});

test('judge startup failure persists the intended sample as incomplete evidence', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-interrupted-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = path.join(root, 'run');
  await assert.rejects(() => evaluate({
    skill: 'setup-auth', runs: 1, model: 'test-model', judgeModel: 'test-judge', out,
  }, {
    executor: { shutdown: async () => {} },
    createJudge: async () => { throw new Error('test judge startup failure'); },
  }), /test judge startup failure/);
  const summary = JSON.parse(await readFile(path.join(out, 'summary.json'), 'utf8'));
  assert.ok(summary.suites[0].expectedCases.length > 1);
  assert.deepEqual(summary.suites[0].results, []);
  const require = createRequire(import.meta.url);
  assert.equal(require('../../../site/lib/evaluations.js').validateSummary(summary), summary);
});

test('a grading exception preserves the completed agent usage in the error summary', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-grade-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [suite] = await loadSuites({ skill: 'setup-auth' });
  const executor = {
    name: 'test-offline', shutdown: async () => {},
    execute: async (stimulus, options) => ({
      id: 'test', stimulus, workDir: options.workDir, output: '', events: [],
      endReason: 'completed',
      metrics: { ...computeMetrics([]), wallTimeMs: 1, reportedTokenUsage: {
        inputTokens: 25, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null,
      } },
      metadata: { model: options.model, skillsLoaded: [], executor: 'test-offline', sessionID: 'test' },
    }),
  };
  const { summary } = await evaluate({
    skill: 'setup-auth', case: suite.stimuli[0].name, runs: 1,
    model: 'test-model', judgeModel: 'test-judge', out: path.join(root, 'run'),
  }, {
    executor, judge: { shutdown: async () => {} },
    gradeTrajectory: async () => { throw new Error('test grading exception'); },
  });
  for (const result of summary.suites[0].results) {
    assert.equal(result.status, 'error');
    assert.equal(result.tokens, 30);
    assert.equal(result.agentUsage.inputTokens, 25);
    assert.equal(result.judgeUsage.calls, 0);
  }
});
