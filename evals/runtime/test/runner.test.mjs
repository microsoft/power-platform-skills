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
import { buildMatrix, selectCases, selectRetryJobs } from '../experiment-matrix.mjs';

test('only covered skills have Vally suites; legacy-only skills remain unselected', async () => {
  const suites = await loadSuites();
  assert.deepEqual(suites.map(suite => suite.name), [
    'add-localization', 'add-seo', 'create-site', 'create-webroles',
    'integrate-webapi', 'migrate-bootstrap', 'setup-auth', 'setup-datamodel',
  ]);
  assert.ok(suites.every(suite => suite.stimuli.length >= 4));
  assert.ok(suites.every(suite => !suite.stimuli.some(stimulus =>
    stimulus.environment?.files?.some(file => file.src.startsWith('checks/')))));
  await assert.rejects(() => loadSuites({ skill: 'deploy-site' }), /No evaluation suite/);
});

test('browser jobs use a Linux image supported by the pinned Playwright version', async t => {
  const validation = parseYaml(await readFile(path.join(repoRoot, '.github/workflows/power-pages-eval-validation.yml'), 'utf8'));
  const evaluation = parseYaml(await readFile(path.join(repoRoot, '.github/workflows/power-pages-evals.yml'), 'utf8'));
  assert.ok(validation.jobs.validate.strategy.matrix.os.includes('ubuntu-24.04'));
  assert.ok(!validation.jobs.validate.strategy.matrix.os.includes('ubuntu-latest'));
  assert.equal(evaluation.jobs.evaluate['runs-on'], 'ubuntu-24.04');
  const browsers = await mkdtemp(path.join(tmpdir(), 'pp-playwright-test-'));
  t.after(() => rm(browsers, { recursive: true, force: true }));
  const output = execFileSync(process.execPath, [
    path.join(repoRoot, 'evals/runtime/node_modules/playwright/cli.js'), 'install', '--dry-run', 'chromium',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'ubuntu24.04-x64', PLAYWRIGHT_BROWSERS_PATH: browsers },
  });
  assert.match(output, /Download url:.*linux64\/chrome-linux64\.zip/);
});

test('Linux browser jobs configure the sandbox after installing Chromium', async () => {
  for (const [file, job] of [
    ['power-pages-eval-validation.yml', 'validate'],
    ['power-pages-evals.yml', 'evaluate'],
  ]) {
    const workflow = parseYaml(await readFile(path.join(repoRoot, '.github/workflows', file), 'utf8'));
    const steps = workflow.jobs[job].steps;
    const install = steps.findIndex(step => step.run?.includes('playwright/cli.js install --with-deps chromium'));
    const sandbox = steps.findIndex(step => step.run === 'bash evals/runtime/setup-linux-chromium-sandbox.sh');
    assert.ok(install >= 0 && sandbox > install, `${file} must configure the installed browser`);
    assert.equal(steps[sandbox].if, "runner.os == 'Linux'");
  }
});

test('grader summaries and evidence archives are gated by credential checks', async () => {
  const workflow = parseYaml(await readFile(path.join(repoRoot, '.github/workflows/power-pages-evals.yml'), 'utf8'));
  const steps = workflow.jobs.evaluate.steps;
  const credentialCheck = steps.findIndex(step => step.id === 'credential-check');
  const report = steps.findIndex(step => step.name === 'explain failed checks');
  const evidence = steps.find(step => step.name === 'upload grading evidence');
  assert.ok(credentialCheck >= 0 && report > credentialCheck);
  assert.equal(steps[report].if, "${{ always() && steps.credential-check.outcome == 'success' }}");
  assert.equal(evidence.with['include-hidden-files'], true);
});

test('experiment selects every case and rejects skills without a suite', async () => {
  const all = await selectCases('all');
  const suites = await loadSuites();
  assert.deepEqual(all, suites.flatMap(suite =>
    suite.stimuli.map(stimulus => ({ skill: suite.name, name: stimulus.name }))));
  assert.equal(all.length, 35);
  assert.deepEqual(await selectCases('create-site'), all.filter(item => item.skill === 'create-site'));
  await assert.rejects(() => selectCases('deploy-site'), /No evaluation suite/);
  await assert.rejects(() => selectCases(''), /Select a Power Pages evaluation suite/);
});

test('experiment runs requested available model and effort combinations with distinct judges', async () => {
  const skills = await selectCases('all');
  const models = ['claude-opus-5.5', 'claude-opus-4.8', 'claude-sonnet-5.5', 'gpt-6.1-astra', 'gpt-6.1-sol'];
  const entry = (id, efforts) => ({
    id, policy: { state: 'enabled' }, capabilities: { supports: { reasoningEffort: true } },
    supportedReasoningEfforts: efforts,
  });
  const catalog = [
    entry('claude-opus-5.5', ['medium', 'max']),
    entry('claude-sonnet-5.5', ['medium', 'xhigh']),
    entry('gpt-6.1-sol', ['medium', 'max']),
  ];
  for (const effort of ['medium', 'max']) {
    const matrix = buildMatrix({
      skills, models, catalog, effort, judgeModel: '', judgeEffort: 'medium', fallbackJudge: 'claude-opus-5.5',
    });
    assert.deepEqual(matrix.unavailable, ['claude-opus-4.8', 'gpt-6.1-astra']);
    assert.equal(matrix.include.length, skills.length * catalog.length);
    for (const { id } of catalog) {
      assert.deepEqual(matrix.include.filter(item => item.model === id)
        .map(item => ({ skill: item.skill, name: item.case })), skills);
    }
    for (const item of matrix.include) {
      assert.notEqual(item.model, item.judgeModel);
      assert.equal(item.judgeModel, item.model === 'gpt-6.1-sol' ? 'claude-opus-5.5' : 'gpt-6.1-sol');
      assert.equal(item.reasoningEffort, effort === 'max' && item.model === 'claude-sonnet-5.5' ? 'xhigh' : effort);
      assert.equal(item.judgeReasoningEffort, 'medium');
    }
  }
  const maxJudge = buildMatrix({
    skills: skills.slice(0, 1), models: ['gpt-6.1-sol'], catalog,
    effort: 'max', judgeModel: 'claude-sonnet-5.5', judgeEffort: 'max', fallbackJudge: 'claude-opus-5.5',
  });
  assert.equal(maxJudge.include[0].judgeReasoningEffort, 'xhigh');
});

test('retry selection includes only requested cases and refuses missing jobs', async () => {
  const skills = (await selectCases('all')).slice(0, 2);
  const catalog = ['claude-opus-5.5', 'gpt-6.1-sol'].map(id => ({
    id, capabilities: { supports: { reasoningEffort: true } }, supportedReasoningEfforts: ['medium'],
  }));
  const { include } = buildMatrix({
    skills, models: catalog.map(entry => entry.id), catalog, effort: 'medium',
    judgeModel: '', judgeEffort: 'medium', fallbackJudge: 'claude-opus-5.5',
  });
  assert.deepEqual(include.slice(0, 2).map(item => item.model), ['claude-opus-5.5', 'gpt-6.1-sol']);
  const target = include[2];
  const name = `${target.skill}/${target.case} ${target.model} ${target.reasoningEffort}`;
  assert.deepEqual(selectRetryJobs(include, `retry:${JSON.stringify([name])}`), [target]);
  assert.throws(() => selectRetryJobs(include, 'retry:["missing"]'), /unavailable/);
  assert.throws(() => selectRetryJobs(include, `retry:${JSON.stringify([name, name])}`), /distinct/);
});

test('experiment workflow dispatches per-case jobs with guarded evidence', async () => {
  const workflow = parseYaml(await readFile(path.join(repoRoot, '.github/workflows/power-pages-evals.yml'), 'utf8'));
  const select = workflow.jobs.select;
  const evaluate = workflow.jobs.evaluate;
  assert.equal(select.steps.find(step => step.id === 'select').run, 'node evals/runtime/experiment-matrix.mjs');
  assert.match(select.if, /github\.actor == 'priyanshu92'/);
  assert.equal(evaluate.if, select.if);
  assert.equal(evaluate.strategy['max-parallel'], 6);
  assert.equal(evaluate.steps.find(step => step.name === 'measure paired offline trials').run, 'node evals/runtime/retry-case.mjs');
  assert.match(evaluate.steps.find(step => step.name === 'upload grading evidence').with.name, /^pp-eval-experiment-/);
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

test('agent turn budget scales with reasoning effort', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-agent-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [suite] = await loadSuites({ skill: 'setup-auth' });
  const timeouts = {};
  for (const reasoningEffort of ['medium', 'high', 'max']) {
    const executor = {
      name: 'test-offline', shutdown: async () => {},
      execute: async (stimulus, options) => {
        timeouts[reasoningEffort] = options.timeout;
        return {
          id: 'test', stimulus, workDir: options.workDir, output: '', events: [], endReason: 'completed',
          metrics: computeMetrics([]),
          metadata: { model: options.model, skillsLoaded: [], executor: 'test-offline', sessionID: 'test' },
        };
      },
    };
    await evaluate({
      skill: 'setup-auth', case: suite.stimuli[0].name, runs: 1, reasoningEffort,
      model: 'test-model', judgeModel: 'test-judge', out: path.join(root, reasoningEffort),
    }, {
      executor, judge: { shutdown: async () => {} },
      gradeTrajectory: async () => { throw new Error('test grading skipped'); },
    });
  }
  assert.deepEqual(timeouts, { medium: 600_000, high: 1_200_000, max: 3_600_000 });
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

test('an agent timeout keeps its partial trajectory and usage as private evidence', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-agent-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [suite] = await loadSuites({ skill: 'setup-auth' });
  const events = [{ type: 'tool_call', toolName: 'eval_render' }];
  const executor = {
    name: 'test-offline', shutdown: async () => {},
    execute: async () => {
      const error = new Error('Timeout after 1800000ms waiting for session.idle');
      error.partialTrajectory = {
        events, endReason: 'error',
        metrics: { wallTimeMs: 1_800_000, reportedTokenUsage: {
          inputTokens: 40, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null,
        } },
      };
      throw error;
    },
  };
  const out = path.join(root, 'run');
  const { summary } = await evaluate({
    skill: 'setup-auth', case: suite.stimuli[0].name, runs: 1,
    model: 'test-model', judgeModel: 'test-judge', out,
  }, {
    executor, judge: { shutdown: async () => {} },
    gradeTrajectory: async () => { throw new Error('grading must not run'); },
  });
  for (const result of summary.suites[0].results) {
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'execution-error');
    assert.equal(result.tokens, 42);
    assert.equal(result.durationMs, 1_800_000);
    const evidence = path.join(out, 'private', 'setup-auth', result.name, `${result.variant}-0`);
    const saved = JSON.parse(await readFile(path.join(evidence, 'partial-trajectory.json'), 'utf8'));
    assert.deepEqual(saved.events, events);
  }
});
