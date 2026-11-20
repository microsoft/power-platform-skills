// Builds the branch-only experiment matrix: one Actions job per skill, case,
// model and agent effort, so no job waits on another case's inference.
// Models and efforts are resolved against the live catalog for the supplied
// token rather than assumed, and unavailable choices are reported, not swapped.
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { REASONING_EFFORTS, validateModelPair } from './models.mjs';
import { loadSuites } from './suites.mjs';

const require = createRequire(import.meta.url);

export async function selectCases(selected) {
  if (!selected) throw new Error('Select a Power Pages evaluation suite or all');
  const suites = await loadSuites(selected === 'all' ? {} : { skill: selected });
  return suites.flatMap(suite => suite.stimuli.map(stimulus => ({ skill: suite.name, name: stimulus.name })));
}

// "max" means the highest effort this model's catalog entry supports (some
// models stop at xhigh); any other value must be supported exactly.
export function resolveEffort(entry, requested) {
  if (!entry.capabilities?.supports?.reasoningEffort) return null;
  const supported = entry.supportedReasoningEfforts ?? [];
  if (requested !== 'max') return supported.includes(requested) ? requested : null;
  return [...REASONING_EFFORTS].reverse().find(effort => supported.includes(effort)) ?? null;
}

export function judgeFor(model, judgeModel, fallbackJudge) {
  if (judgeModel) return judgeModel;
  return model === 'gpt-6.1-sol' ? fallbackJudge : 'gpt-6.1-sol';
}

export function buildMatrix({ skills, models, catalog, effort, judgeModel, judgeEffort, fallbackJudge }) {
  const byId = new Map(catalog.filter(entry => entry.policy?.state !== 'disabled').map(entry => [entry.id, entry]));
  const unavailable = [];
  const pairs = [];
  for (const model of models) {
    const entry = byId.get(model);
    const resolved = entry && resolveEffort(entry, effort);
    if (!resolved) { unavailable.push(entry ? `${model} (no ${effort} effort)` : model); continue; }
    const selectedJudge = judgeFor(model, judgeModel, fallbackJudge);
    const judge = byId.get(selectedJudge);
    const resolvedJudgeEffort = judge && resolveEffort(judge, judgeEffort);
    if (!resolvedJudgeEffort) throw new Error(`Judge model is unavailable: ${selectedJudge}`);
    const pair = { model, judgeModel: selectedJudge, reasoningEffort: resolved, judgeReasoningEffort: resolvedJudgeEffort };
    validateModelPair(pair);
    pairs.push(pair);
  }
  // Interleave models so a limited parallel queue starts different models together.
  return { include: skills.flatMap(({ skill, name }) => pairs.map(pair => ({ skill, case: name, ...pair }))), unavailable };
}

export function selectRetryJobs(include, selected) {
  if (!selected.startsWith('retry:')) return include;
  const requested = JSON.parse(selected.slice('retry:'.length));
  if (!Array.isArray(requested) || !requested.length || requested.some(name => typeof name !== 'string') ||
      new Set(requested).size !== requested.length) throw new Error('Retry selection must contain distinct job names');
  const jobName = item => `${item.skill}/${item.case} ${item.model} ${item.reasoningEffort}`;
  const available = new Map(include.map(item => [jobName(item), item]));
  const missing = requested.filter(name => !available.has(name));
  if (missing.length) throw new Error(`Retry jobs are unavailable: ${missing.join(', ')}`);
  const requestedSet = new Set(requested);
  return include.filter(item => requestedSet.has(jobName(item)));
}

async function main() {
  const token = process.env.EVAL_TOKEN;
  if (!token) throw new Error('PP_EVAL_COPILOT_TOKEN secret is required for experiment runs');
  const selected = process.env.SELECTED_SKILL;
  const skills = await selectCases(selected?.startsWith('retry:') ? 'all' : selected);
  const models = process.env.MODELS.split(',').map(model => model.trim()).filter(Boolean);
  if (!models.length || new Set(models).size !== models.length) throw new Error('Provide distinct comma-separated models');
  const home = await mkdtemp(path.join(tmpdir(), 'pp-eval-catalog-'));
  const loader = path.join(path.dirname(require.resolve('@github/copilot/package.json')), 'npm-loader.js');
  const client = new CopilotClient({
    mode: 'empty', baseDirectory: home, gitHubToken: token, useLoggedInUser: false,
    connection: RuntimeConnection.forStdio({ path: process.execPath, args: [loader] }),
  });
  let catalog;
  try { await client.start(); catalog = await client.listModels(); }
  finally { await client.stop().catch(() => {}); await rm(home, { recursive: true, force: true }); }
  const matrix = buildMatrix({
    skills, models, catalog, effort: process.env.REASONING_EFFORT,
    judgeModel: process.env.JUDGE_MODEL.trim(), judgeEffort: process.env.JUDGE_REASONING_EFFORT,
    fallbackJudge: 'claude-opus-5.5',
  });
  const include = selectRetryJobs(matrix.include, selected);
  const { unavailable } = matrix;
  // Only IDs, policy and effort lists: the catalog carries no credentials.
  const lines = [
    '## Model catalog for the supplied token', '',
    ...catalog.map(entry => `- \`${entry.id}\` ${entry.policy?.state ?? 'unreported'}: ${(entry.supportedReasoningEfforts ?? []).join(', ') || 'no effort control'}`),
    '', `Unavailable requested models: ${unavailable.join(', ') || 'none'}`,
    `Jobs: ${include.length}`,
  ];
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  if (!include.length) throw new Error('No requested model is available for this token');
  if (include.length > 256) throw new Error(`Matrix has ${include.length} jobs; GitHub allows 256. Select fewer models or one skill.`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(include)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
