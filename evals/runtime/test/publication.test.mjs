import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchResults } from '../fetch-results.mjs';

const repo = 'example/test-only';
function summary() {
  return {
    schemaVersion: 1, plugin: 'power-pages', commit: 'a'.repeat(40),
    generatedAt: '2026-01-01T00:00:00.000Z', model: 'test-model', judgeModel: 'test-judge',
    runUrl: `https://github.com/${repo}/actions/runs/42`,
    pluginHash: 'b'.repeat(64), runtimeHash: 'c'.repeat(64),
    suites: [{
      skill: 'setup-datamodel', skillHash: 'd'.repeat(64), suiteHash: 'e'.repeat(64), runs: 1,
      expectedCases: [{ name: 'test-only', kind: 'capability' }],
      results: ['baseline', 'skilled'].map(variant => ({
        name: 'test-only', kind: 'capability', variant, trial: 0, status: 'passed',
        score: 1, checks: [{ name: 'test-only-check', passed: true }],
        tokens: null, durationMs: 1, error: null,
      })),
    }],
  };
}
async function setup(t, { mutate = () => {}, trusted = true, extraFile = false, flat = true, models } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-publication-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = summary();
  mutate(data);
  const exec = async (_command, args) => {
    if (args[0] === 'api' && args[1].includes('/workflows/')) {
      return { stdout: JSON.stringify({ workflow_runs: [{
        id: 42, status: 'completed', event: 'workflow_dispatch', head_branch: 'main', head_sha: 'a'.repeat(40),
        repository: { full_name: repo }, head_repository: { full_name: trusted ? repo : 'untrusted/fork' },
      }] }) };
    }
    if (args[0] === 'api') {
      return { stdout: JSON.stringify({ artifacts: (models ?? [null]).map(model => ({
        name: `power-pages-evals-setup-datamodel${model ? `--${model}` : ''}`, expired: false, size_in_bytes: 1000,
      })) }) };
    }
    assert.deepEqual(args.slice(0, 3), ['run', 'download', '42']);
    const downloaded = args[args.indexOf('--dir') + 1];
    for (const model of models ?? [null]) {
      const artifactName = `power-pages-evals-setup-datamodel${model ? `--${model}` : ''}`;
      const directory = flat ? downloaded : path.join(downloaded, artifactName);
      await mkdir(directory, { recursive: true });
      const artifactData = structuredClone(data);
      if (model) artifactData.model = model;
      await writeFile(path.join(directory, 'summary.json'), JSON.stringify(artifactData));
      if (extraFile) await writeFile(path.join(directory, 'trajectory.json'), 'private evidence');
    }
    return { stdout: '' };
  };
  return { repo, out: path.join(root, 'published'), exec };
}

test('publication accepts sanitized per-skill summaries with matching trusted provenance', async t => {
  const options = await setup(t);
  assert.equal(await fetchResults(options), 1);
  assert.deepEqual(await readdir(options.out), ['42-setup-datamodel.summary.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(options.out, '42-setup-datamodel.summary.json'), 'utf8')), summary());
  const nested = await setup(t, { flat: false });
  assert.equal(await fetchResults(nested), 1);
});

test('one workflow publishes distinct model artifacts without overwriting summaries', async t => {
  const options = await setup(t, { models: ['claude-opus-5.5', 'gpt-6.1-sol'], flat: false });
  assert.equal(await fetchResults(options), 2);
  const files = await readdir(options.out);
  assert.equal(files.length, 2);
  const published = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(options.out, file), 'utf8'))));
  assert.deepEqual(published.map(value => value.model).sort(), ['claude-opus-5.5', 'gpt-6.1-sol']);
  const mismatch = await setup(t);
  const exec = mismatch.exec;
  mismatch.exec = async (command, args) => {
    const result = await exec(command, args);
    if (args[0] === 'api' && !args[1].includes('/workflows/')) {
      result.stdout = result.stdout.replace('power-pages-evals-setup-datamodel', 'power-pages-evals-setup-datamodel--wrong-model');
    }
    return result;
  };
  await assert.rejects(() => fetchResults(mismatch), /trusted workflow/);
});

test('publication accepts scalar usage and rejects private judge data', async t => {
  const withUsage = data => {
    data.schemaVersion = 2;
    for (const result of data.suites[0].results) {
      result.tokens = 120;
      result.agentUsage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: null };
      result.judgeUsage = { calls: 1, reportedCalls: 1, inputTokens: 12, outputTokens: 3 };
    }
  };
  const options = await setup(t, { mutate: withUsage });
  assert.equal(await fetchResults(options), 1);
  const output = JSON.parse(await readFile(path.join(options.out, '42-setup-datamodel.summary.json'), 'utf8'));
  assert.equal(output.suites[0].results[0].agentUsage.cacheReadTokens, 50);
  const unsafe = await setup(t, { mutate: data => {
    withUsage(data);
    data.suites[0].results[0].judgeUsage.reasoning = 'private';
  } });
  await assert.rejects(() => fetchResults(unsafe), /Invalid evaluation summary/);
});

test('publication rejects raw evidence and summaries attributed to another source', async t => {
  await assert.rejects(() => setup(t, { extraFile: true }).then(fetchResults), /Only summary.json/);
  await assert.rejects(() => setup(t, { mutate: data => { data.commit = 'f'.repeat(40); } }).then(fetchResults), /trusted workflow/);
  await assert.rejects(() => setup(t, { mutate: data => { data.trajectory = 'private evidence'; } }).then(fetchResults));
  const fork = await setup(t, { trusted: false });
  assert.equal(await fetchResults(fork), 0);
  assert.deepEqual(await readdir(fork.out), []);
});

test('only an unpublished workflow is treated as absent; auth failures remain errors', async t => {
  const options = await setup(t);
  options.exec = async (_command, args) => {
    if (args[1].endsWith('/runs')) throw Object.assign(new Error('not published'), { stderr: 'gh: Not Found (HTTP 404)' });
    return { stdout: JSON.stringify([{ workflows: [{ path: '.github/workflows/other.yml' }] }]) };
  };
  assert.equal(await fetchResults(options), 0);

  const inaccessible = await setup(t);
  inaccessible.exec = async (_command, args) => {
    if (args[1].endsWith('/runs')) throw Object.assign(new Error('not found'), { stderr: 'gh: Not Found (HTTP 404)' });
    throw Object.assign(new Error('forbidden'), { stderr: 'gh: Forbidden (HTTP 403)' });
  };
  await assert.rejects(() => fetchResults(inaccessible), /forbidden/);

  const existing = await setup(t);
  existing.exec = async (_command, args) => {
    if (args[1].endsWith('/runs')) throw Object.assign(new Error('not found'), { stderr: 'gh: Not Found (HTTP 404)' });
    return { stdout: JSON.stringify([{ workflows: [{ path: '.github/workflows/power-pages-evals.yml' }] }]) };
  };
  await assert.rejects(() => fetchResults(existing), /not found/);

  const denied = await setup(t);
  denied.exec = async () => { throw Object.assign(new Error('forbidden'), { stderr: 'gh: Forbidden (HTTP 403)' }); };
  await assert.rejects(() => fetchResults(denied), /forbidden/);
});
