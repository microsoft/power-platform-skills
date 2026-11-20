import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWithRetries } from '../retry-case.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pp-eval-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'action');
}

async function writeAttempt(dir, { error, grading } = {}) {
  const evidence = path.join(dir, 'private', 'setup-auth', 'example-case', 'baseline-0');
  await mkdir(evidence, { recursive: true });
  const result = {
    name: 'example-case', variant: 'baseline', trial: 0,
    status: error || grading ? 'error' : 'passed',
    error: error ? 'execution-error' : grading ? 'grading-error' : null,
  };
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify({
    suites: [{ skill: 'setup-auth', results: [result] }],
  }));
  if (error) await writeFile(path.join(evidence, 'error.txt'), error);
  if (grading) await writeFile(path.join(evidence, 'grading.json'), JSON.stringify(grading));
}

const catalog429 = 'Error: Request models.list failed with message: GenericFailure, {"kind":"http","status":429,"statusText":"Too Many Requests","headers":[{"name":"retry-after","value":"3"}]}';

test('a catalog rate limit retries after cooldown and retains the failed attempt', async t => {
  const outputDir = await setup(t);
  const waits = [];
  let calls = 0;
  const outcome = await runWithRetries({
    outputDir, sleep: async ms => waits.push(ms), random: () => 0,
    runAttempt: async dir => {
      calls++;
      await writeAttempt(dir, calls === 1 ? { error: catalog429 } : {});
      return { exitCode: calls === 1 ? 2 : 0, stderr: '' };
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [60_000]);
  assert.match(await readFile(path.join(outputDir, 'previous-attempts', '1', 'private',
    'setup-auth', 'example-case', 'baseline-0', 'error.txt'), 'utf8'), /"status":429/);
  const final = JSON.parse(await readFile(path.join(outputDir, 'summary.json'), 'utf8'));
  assert.equal(final.suites[0].results[0].status, 'passed');
});

test('judge-side rate limits retry but other errors remain failures', async t => {
  const outputDir = await setup(t);
  const waits = [];
  let calls = 0;
  const outcome = await runWithRetries({
    outputDir, sleep: async ms => waits.push(ms), random: () => 0,
    runAttempt: async dir => {
      calls++;
      await writeAttempt(dir, calls === 1 ? {
        grading: { status: 'error', details: [{ status: 'error', evidence: `LLM judge failed: ${catalog429}` }] },
      } : {});
      return { exitCode: calls === 1 ? 2 : 0, stderr: '' };
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [60_000]);

  const secondOutput = `${outputDir}-non-rate`;
  let nonRateCalls = 0;
  const failure = await runWithRetries({
    outputDir: secondOutput, sleep: async () => assert.fail('must not sleep for unrelated failures'),
    runAttempt: async dir => {
      nonRateCalls++;
      await writeAttempt(dir, { error: 'Error: Copilot model is unavailable' });
      return { exitCode: 2, stderr: '' };
    },
  });
  assert.equal(failure.exitCode, 2);
  assert.equal(nonRateCalls, 1);
});

test('persistent throttling stays failed after the bounded retry limit', async t => {
  const outputDir = await setup(t);
  let calls = 0;
  const outcome = await runWithRetries({
    outputDir, maxAttempts: 2, sleep: async () => {}, random: () => 0,
    runAttempt: async dir => {
      calls++;
      await writeAttempt(dir, { error: "Error: You've hit your rate limit. Please wait for your limit to reset in under a minute." });
      return { exitCode: 2, stderr: '' };
    },
  });
  assert.equal(outcome.exitCode, 2);
  assert.equal(calls, 2);
  assert.match(await readFile(path.join(outputDir, 'previous-attempts', '1', 'private',
    'setup-auth', 'example-case', 'baseline-0', 'error.txt'), 'utf8'), /rate limit/);
});
