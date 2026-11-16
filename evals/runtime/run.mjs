import {
  createCopilotLlmClient, gradeTrajectory, hasGraderError, runEval,
} from '@microsoft/vally';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeBrowser } from './browser-checks.mjs';
import { OfflineExecutor } from './offline-executor.mjs';
import { validateModelPair } from './models.mjs';
import { createRegistry, loadSuites, pluginRoot, repoRoot, trialGraders } from './suites.mjs';
import { pairedInputIdentity, snapshotPlugin } from './revisions.mjs';

const require = createRequire(import.meta.url);
const { hashFile, hashTree } = require('../../scripts/lib/eval-evidence.js');

export function parseArgs(args) {
  const [command = 'validate', ...rest] = args;
  if (!['validate', 'run', 'compare'].includes(command)) throw new Error('Usage: node run.mjs validate|run|compare [--skill NAME] [--case NAME] [--runs N] [--model ID] [--judge-model ID] [--reasoning-effort LEVEL] [--judge-reasoning-effort LEVEL] [--local-auth] [--out DIR] [--before REF --after REF]');
  const options = { command, runs: 1, reasoningEffort: 'medium', judgeReasoningEffort: 'medium' };
  const keys = new Map([
    ['--skill', 'skill'], ['--case', 'case'], ['--runs', 'runs'],
    ['--model', 'model'], ['--judge-model', 'judgeModel'], ['--out', 'out'],
    ['--reasoning-effort', 'reasoningEffort'], ['--judge-reasoning-effort', 'judgeReasoningEffort'],
    ['--before', 'before'], ['--after', 'after'],
  ]);
  const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '--local-auth') {
      if (options.localAuth) throw new Error('Duplicate option: --local-auth');
      options.localAuth = true;
      continue;
    }
    const key = keys.get(rest[index]);
    const value = rest[index + 1];
    if (!key || !value || value.startsWith('--')) throw new Error(`Invalid option: ${rest[index]}`);
    if (seen.has(key)) throw new Error(`Duplicate option: ${rest[index]}`);
    seen.add(key);
    options[key] = value;
    index++;
  }
  options.runs = Number(options.runs);
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 10) throw new Error('--runs must be between 1 and 10');
  if (options.case && !options.skill) throw new Error('--case requires --skill');
  if (command !== 'validate' && (!options.model || !options.judgeModel)) {
    throw new Error('Run requires explicit --model and --judge-model for reproducible evidence');
  }
  if ([options.model, options.judgeModel].some(model => model?.toLowerCase() === 'auto')) {
    throw new Error('Use explicit model IDs, not auto, to keep measurements attributable');
  }
  if (command === 'compare' && (!options.before || !options.after || !options.skill || !options.out)) {
    throw new Error('Compare requires --before, --after, --skill and --out');
  }
  if (command !== 'compare' && (options.before || options.after)) throw new Error('Revision options require compare');
  if (command !== 'validate') validateModelPair(options);
  return options;
}

export function outcomeRecord({ stimulus, variant, trial, trajectory, grade, error, judgeUsage }) {
  const details = grade?.details ?? [];
  const invalid = Boolean(error || !trajectory || !grade || !details.length || hasGraderError(grade));
  const checks = details.map(detail => ({
    name: detail.configuredName ?? detail.graderType ?? detail.name,
    passed: !hasGraderError(detail) && detail.passed === true,
  }));
  // Vally averages grader scores. Completion here is an ALL-required gate:
  // a pleasant report cannot compensate for a missing file or wrong ER edge.
  const passed = !invalid && trajectory.endReason === 'completed' && checks.every(check => check.passed);
  const agentUsage = trajectory?.metrics?.reportedTokenUsage ?? null;
  const input = agentUsage?.inputTokens;
  const output = agentUsage?.outputTokens;
  const tokens = Number.isSafeInteger(input) && Number.isSafeInteger(output) &&
    Number.isSafeInteger(input + output) ? input + output : null;
  return {
    name: stimulus.name, kind: stimulus.tags.kind, variant, trial,
    status: invalid ? 'error' : passed ? 'passed' : 'failed',
    score: invalid ? null : grade.score, checks,
    tokens, agentUsage,
    judgeUsage: judgeUsage ?? { calls: 0, reportedCalls: 0, inputTokens: 0, outputTokens: 0 },
    durationMs: trajectory?.metrics?.wallTimeMs ?? null,
    error: invalid ? error ? 'execution-error' : 'grading-error' : null,
  };
}

function trackJudge(judge) {
  const usage = { calls: 0, reportedCalls: 0, inputTokens: 0, outputTokens: 0 };
  return {
    client: {
      supportsWorkspaceDelivery: judge.supportsWorkspaceDelivery,
      async judge(options) {
        usage.calls++;
        const result = await judge.judge(options);
        // Vally's judge client substitutes zero for missing SDK fields, so its
        // returned counts are reported as minimums rather than complete usage.
        const input = result.tokenUsage?.inputTokens;
        const output = result.tokenUsage?.outputTokens;
        if (Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0 &&
            Number.isSafeInteger(usage.inputTokens + input) && Number.isSafeInteger(usage.outputTokens + output) &&
            Number.isSafeInteger(usage.inputTokens + input + usage.outputTokens + output)) {
          usage.reportedCalls++;
          usage.inputTokens += input;
          usage.outputTokens += output;
        }
        return result;
      },
    },
    snapshot: () => ({ ...usage }),
  };
}

function actionRunUrl(env) {
  if (env.GITHUB_SERVER_URL !== 'https://github.com' || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')) return null;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

export async function evaluate(options, dependencies = {}) {
  options = { reasoningEffort: 'medium', judgeReasoningEffort: 'medium', ...options };
  validateModelPair(options);
  if (options.localAuth && process.env.GITHUB_ACTIONS === 'true') throw new Error('--local-auth is not allowed in GitHub Actions');
  const sourcePluginRoot = options.sourcePluginRoot ?? pluginRoot;
  const suites = await loadSuites({ skill: options.skill, sourcePluginRoot });
  if (options.case && !suites[0].stimuli.some(stimulus => stimulus.name === options.case)) throw new Error('Unknown case');
  const token = options.localAuth ? undefined : process.env.GITHUB_TOKEN;
  if (!token && !options.localAuth && !dependencies.executor) {
    throw new Error('Use native GitHub Actions authentication, or --local-auth with an existing Copilot CLI sign-in. No PAT secret is needed.');
  }
  const out = path.resolve(options.out ?? path.join(repoRoot, 'evals/reports', new Date().toISOString().replaceAll(':', '-')));
  // A fresh run directory protects previous evidence and makes interrupted runs
  // explicit. Never merge partial results into an earlier successful report.
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out, { recursive: false });
  const scratch = await mkdtemp(path.join(tmpdir(), 'pp-eval-run-'));
  const executor = dependencies.executor ?? new OfflineExecutor({
    pluginRoot: sourcePluginRoot, token, useLoggedInUser: options.localAuth === true,
    judgeModel: options.judgeModel, judgeReasoningEffort: options.judgeReasoningEffort,
  });
  let judge;
  const savedJudgeEnv = Object.fromEntries(['COPILOT_HOME', 'COPILOT_CLI_PATH', 'GITHUB_COPILOT_API_TOKEN', 'GITHUB_TOKEN']
    .map(key => [key, process.env[key]]));
  const summary = {
    schemaVersion: 3, plugin: 'power-pages',
    commit: options.sourceCommit ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
    generatedAt: new Date().toISOString(), model: options.model, judgeModel: options.judgeModel,
    reasoningEffort: options.reasoningEffort, judgeReasoningEffort: options.judgeReasoningEffort,
    runUrl: options.sourcePluginRoot ? null : actionRunUrl(process.env), pluginHash: await hashTree(sourcePluginRoot),
    runtimeHash: await hashTree(path.join(repoRoot, 'evals/runtime')), suites: [],
  };
  const review = { schemaVersion: 1, scope: 'offline', cases: [] };
  const persist = async () => {
    await writeFile(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(path.join(out, 'review-index.json'), `${JSON.stringify(review, null, 2)}\n`);
  };
  try {
    // Persist the intended sample before starting inference. A failed judge
    // startup or interrupted matrix job must leave incomplete evidence, not let
    // publication silently reuse an older passing measurement.
    summary.suites = await Promise.all(suites.map(async suite => ({
      skill: suite.name, skillHash: await hashFile(suite.skill.path),
      suiteHash: await hashTree(suite.suiteDir), runs: options.runs,
      expectedCases: suite.stimuli.filter(stimulus => !options.case || stimulus.name === options.case)
        .map(stimulus => ({ name: stimulus.name, kind: stimulus.tags.kind })),
      results: [],
    })));
    await persist();
    // Vally's prompt grader accepts the native GITHUB_TOKEN. Pin its runtime
    // and isolate its settings too; an ambient personal config must not change
    // either arm's judge or override the workflow's credential.
    process.env.COPILOT_HOME = path.join(scratch, 'judge-home');
    await mkdir(process.env.COPILOT_HOME);
    process.env.COPILOT_CLI_PATH = path.join(path.dirname(require.resolve('@github/copilot/package.json')), 'npm-loader.js');
    if (!options.localAuth) delete process.env.GITHUB_COPILOT_API_TOKEN;
    judge = dependencies.judge ?? await (dependencies.createJudge ?? createCopilotLlmClient)();
    for (const [suiteIndex, suite] of suites.entries()) {
      const stimuli = suite.stimuli.filter(stimulus => !options.case || stimulus.name === options.case);
      const suiteResult = summary.suites[suiteIndex];
      for (const stimulus of stimuli) {
        for (let trial = 0; trial < options.runs; trial++) {
          const variants = trial % 2 ? ['skilled', 'baseline'] : ['baseline', 'skilled'];
          for (const variant of variants) {
            const id = `${suite.name}/${stimulus.name}/${variant}-${trial}`;
            const evidenceDir = path.join(out, 'private', id);
            await mkdir(evidenceDir, { recursive: true });
            let result;
            let record;
            // A timed-out judge can settle after the next trial starts. A
            // per-trial wrapper keeps its late usage from leaking into that trial.
            const trackedJudge = trackJudge(judge);
            try {
              result = await (dependencies.runEval ?? runEval)({
                stimulus, stimulusName: stimulus.name, prompt: stimulus.prompt,
                skills: variant === 'skilled' ? [suite.skill] : [],
                workDir: scratch, workspace: path.join(scratch, id),
                executor, model: options.model, reasoningEffort: options.reasoningEffort, timeout: 600_000,
                environment: stimulus.environment, baseDir: suite.suiteDir,
              });
              if (variant === 'baseline' && result.trajectory.events.some(event => event.type === 'skill_activation')) {
                throw new Error('Baseline contamination: a skill was activated in the control arm');
              }
              if (result.trajectory.metadata.model !== options.model) {
                throw new Error('Model identity changed during the evaluation');
              }
              const graders = trialGraders(stimulus, { suite, variant, evidenceDir });
              const grade = await (dependencies.gradeTrajectory ?? gradeTrajectory)(result.trajectory, graders, {
                registry: createRegistry(trackedJudge.client), stimulus, judgeModel: options.judgeModel,
                judgeReasoningEffort: options.judgeReasoningEffort,
                judgeTimeoutMs: 180_000, graderTimeoutMs: 300_000,
              });
              record = outcomeRecord({
                stimulus, variant, trial, trajectory: result.trajectory, grade, judgeUsage: trackedJudge.snapshot(),
              });
              // Raw evidence remains local/private. Public summaries contain only
              // fixed identifiers, booleans, counts and scalar measurements.
              await writeFile(path.join(evidenceDir, 'trajectory.json'), JSON.stringify(result.trajectory, null, 2));
              await writeFile(path.join(evidenceDir, 'grading.json'), JSON.stringify(grade, null, 2));
              const { cp } = await import('node:fs/promises');
              await cp(result.workDir, path.join(evidenceDir, 'workspace'), { recursive: true, dereference: false });
            } catch (error) {
              record = outcomeRecord({
                stimulus, variant, trial, trajectory: result?.trajectory, error, judgeUsage: trackedJudge.snapshot(),
              });
              await writeFile(path.join(evidenceDir, 'error.txt'), error.stack ?? String(error));
              console.error(`${id}: execution/grading error; see private evidence`);
            } finally {
              await result?.cleanup();
            }
            suiteResult.results.push(record);
            review.cases.push({
              skill: suite.name, name: stimulus.name, variant, trial,
              evidence: `private/${id}`, feedback: null,
              observedPluginReadBytes: Array.isArray(result?.trajectory?.metrics?.resourceReads)
                ? result.trajectory.metrics.resourceReads.filter(read => read.root === 'plugin')
                  .reduce((sum, read) => sum + read.bytes, 0) : null,
            });
            await persist();
            console.log(`${id}: ${record.status}`);
          }
        }
      }
    }
    await persist();
    return { summary, out };
  } finally {
    try { await executor.shutdown(); }
    finally {
      try { await judge?.shutdown(); }
      finally {
        try { await closeBrowser(); }
        finally {
          for (const [key, value] of Object.entries(savedJudgeEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
          await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  }
}

export async function compareRevisions(options, dependencies = {}) {
  options = { runs: 1, reasoningEffort: 'medium', judgeReasoningEffort: 'medium', ...options };
  validateModelPair(options);
  const out = path.resolve(options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out, { recursive: false });
  const scratch = await mkdtemp(path.join(tmpdir(), 'pp-eval-revisions-'));
  const settings = Object.fromEntries(['model', 'judgeModel', 'reasoningEffort', 'judgeReasoningEffort', 'runs', 'case']
    .map(key => [key, options[key] ?? (key.includes('Effort') ? 'medium' : null)]));
  const comparison = { schemaVersion: 1, mode: 'revision-pair', settings, arms: [], pairs: [], complete: false };
  const persist = () => writeFile(path.join(out, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
  try {
    // Resolve BOTH immutable sources before any inference. Suites, fixtures,
    // graders, and runtime always come from this checkout, never from either ref.
    for (const label of ['before', 'after']) {
      const root = path.join(scratch, label);
      const commit = await snapshotPlugin(repoRoot, options[label], root);
      const [suite] = await loadSuites({ skill: options.skill, sourcePluginRoot: root });
      if (options.case) suite.stimuli = suite.stimuli.filter(stimulus => stimulus.name === options.case);
      if (!suite.stimuli.length) throw new Error('Unknown case');
      const source = await readFile(suite.skill.path);
      comparison.arms.push({
        label, commit, pluginHash: await hashTree(root), skillHash: await hashFile(suite.skill.path),
        suiteHash: await hashTree(suite.suiteDir), runtimeHash: await hashTree(path.join(repoRoot, 'evals/runtime')),
        pairedInputHash: await pairedInputIdentity(suite, settings),
        mainFileBytes: source.length,
        mainFileLines: source.toString('utf8').split('\n').length - (source.at(-1) === 10 ? 1 : 0),
        expectedTrials: suite.stimuli.length * options.runs * 2,
      });
    }
    if (['pairedInputHash', 'suiteHash', 'runtimeHash'].some(key =>
      comparison.arms[0][key] !== comparison.arms[1][key])) {
      throw new Error('Revision pair input mismatch');
    }
    await persist();
    const summaries = [];
    for (const arm of comparison.arms) {
      const { summary } = await (dependencies.evaluate ?? evaluate)({
        ...options, sourcePluginRoot: path.join(scratch, arm.label), sourceCommit: arm.commit,
        out: path.join(out, arm.label),
      });
      if (summary.pluginHash !== arm.pluginHash || summary.runtimeHash !== arm.runtimeHash ||
          summary.suites[0].suiteHash !== arm.suiteHash || summary.suites[0].skillHash !== arm.skillHash ||
          await hashTree(path.join(scratch, arm.label)) !== arm.pluginHash ||
          await hashTree(path.join(repoRoot, 'evals/power-pages', options.skill)) !== arm.suiteHash ||
          await hashTree(path.join(repoRoot, 'evals/runtime')) !== arm.runtimeHash) {
        throw new Error('Source changed during revision comparison');
      }
      summaries.push(summary.suites[0]);
      if (summary.suites[0].results.length !== arm.expectedTrials ||
          new Set(summary.suites[0].results.map(result => `${result.name}/${result.variant}/${result.trial}`)).size !== arm.expectedTrials) {
        throw new Error('Incomplete or duplicate revision trials');
      }
    }
    comparison.pairs = summaries[0].results.map(before => {
      const after = summaries[1].results.find(result =>
        result.name === before.name && result.variant === before.variant && result.trial === before.trial);
      if (!after) throw new Error('Missing paired result');
      return {
        name: before.name, kind: before.kind, variant: before.variant, trial: before.trial,
        before: { status: before.status, tokens: before.tokens, durationMs: before.durationMs },
        after: { status: after.status, tokens: after.tokens, durationMs: after.durationMs },
        regression: before.status === 'passed' && after.status === 'failed',
        tokenDelta: before.tokens === null || after.tokens === null ? null : after.tokens - before.tokens,
        durationDeltaMs: before.durationMs === null || after.durationMs === null ? null : after.durationMs - before.durationMs,
      };
    });
    comparison.complete = comparison.pairs.length > 0 &&
      comparison.pairs.every(pair => ![pair.before.status, pair.after.status].includes('error'));
    comparison.behavior = Object.fromEntries(['before', 'after'].map(arm => {
      const outcomes = comparison.pairs.filter(pair => pair.kind === 'capability' && pair.variant === 'skilled');
      const measured = outcomes.filter(pair => pair[arm].status !== 'error');
      const passed = measured.filter(pair => pair[arm].status === 'passed').length;
      return [arm, {
        expected: outcomes.length, measured: measured.length, errors: outcomes.length - measured.length, passed,
        passRate: measured.length ? passed / measured.length : null,
      }];
    }));
    await persist();
    return { comparison, out };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'compare') {
    const { comparison, out } = await compareRevisions(options);
    console.log(`Saved local revision comparison to ${out}`);
    if (!comparison.complete) process.exitCode = 2;
    else if (comparison.pairs.some(pair => pair.variant === 'skilled' && pair.after.status === 'failed')) process.exitCode = 1;
    return;
  }
  if (options.command === 'validate') {
    const suites = await loadSuites({ skill: options.skill });
    console.log(`Validated ${suites.length} suites and ${suites.reduce((count, suite) => count + suite.stimuli.length, 0)} cases with Vally 0.21.0.`);
    return;
  }
  const { summary, out } = await evaluate(options);
  const records = summary.suites.flatMap(suite => suite.results);
  console.log(`Evidence: ${path.relative(repoRoot, out)}`);
  console.log(`Passed ${records.filter(record => record.status === 'passed').length}/${records.length} trials. Offline measurements are report-only.`);
  // Measured failures remain visible data; invalid measurements fail CI.
  if (records.some(record => record.status === 'error')) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
