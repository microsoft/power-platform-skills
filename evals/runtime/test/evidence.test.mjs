import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { failureReport, findCredentials } from '../evidence.mjs';

async function runDir(t) {
  const out = await mkdtemp(path.join(tmpdir(), 'pp-evidence-test-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const result = (name, variant, status) => ({ name, kind: 'capability', variant, trial: 0, status });
  await writeFile(path.join(out, 'summary.json'), JSON.stringify({
    model: 'agent-model', judgeModel: 'judge-model',
    suites: [{ skill: 'create-site', results: [
      result('plan', 'baseline', 'passed'),
      result('plan', 'skilled', 'failed'),
      result('build', 'skilled', 'error'),
    ] }],
  }));
  const failed = path.join(out, 'private/create-site/plan/skilled-0');
  await mkdir(failed, { recursive: true });
  await writeFile(path.join(failed, 'grading.json'), JSON.stringify({ details: [
    { name: 'plan-correctness', passed: true, score: 1, evidence: 'All artifact checks passed' },
    { name: 'plan-quality', passed: false, score: 0.75, evidence: 'Strong plan\nwith one gap.', details: [
      { name: 'prompt/Journey', passed: false, score: 0.75, evidence: 'Collection asks only for a postcode.' },
      { name: 'prompt/Design', passed: true, score: 1, evidence: 'Clear design rationale.' },
    ] },
  ] }));
  const errored = path.join(out, 'private/create-site/build/skilled-0');
  await mkdir(errored, { recursive: true });
  await writeFile(path.join(errored, 'error.txt'), 'Error: judge timed out\n    at stack');
  return out;
}

test('failure report explains failed criteria and errors only', async t => {
  const report = await failureReport(await runDir(t));
  assert.match(report, /agent-model judged by judge-model/);
  assert.match(report, /plan \(skilled, trial 0\): failed/);
  assert.match(report, /`plan-quality` \(score 0\.75\): Strong plan with one gap\./);
  assert.match(report, /prompt\/Journey \(score 0\.75\): Collection asks only for a postcode\./);
  assert.match(report, /build \(skilled, trial 0\): error\n\n- Error: Error: judge timed out\n/);
  assert.doesNotMatch(report, /baseline|plan-correctness|prompt\/Design/);
});

test('failure report tolerates a run that wrote no summary', async t => {
  const out = await mkdtemp(path.join(tmpdir(), 'pp-evidence-empty-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  assert.match(await failureReport(out), /run stopped before any trial/);
});

test('credential scan flags real token shapes and the run token, not placeholders', async t => {
  const out = await runDir(t);
  const workspace = path.join(out, 'private/create-site/plan/skilled-0/workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'api.ts'), 'headers: { Authorization: `Bearer ${token}` } // ghs_<token>');
  assert.deepEqual(await findCredentials(out, ['run-token-value']), []);
  await writeFile(path.join(workspace, 'leak.txt'), `token=ghs_${'A'.repeat(36)}`);
  await writeFile(path.join(out, 'echo.txt'), 'prefix run-token-value suffix');
  assert.deepEqual((await findCredentials(out, ['run-token-value'])).sort(),
    ['echo.txt', path.join('private/create-site/plan/skilled-0/workspace/leak.txt')].sort());
});
