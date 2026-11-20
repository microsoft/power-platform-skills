import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// The SDK reports catalog throttling as JSON embedded in an RPC error, e.g.
// `GenericFailure, {"kind":"http","status":429,"headers":[...]}`, while
// inference can report "You've hit your rate limit". Do not retry other errors.
function isRateLimit(text) {
  return /"status"\s*:\s*429\b|HTTP\s+429\b|429\s+Too Many Requests|You've hit your rate limit/i.test(text ?? '');
}

function gradingErrors(grade) {
  if (grade?.status !== 'error') return [];
  const nested = Array.isArray(grade.details) ? grade.details.flatMap(gradingErrors) : [];
  return nested.length ? nested : [String(grade.evidence ?? grade.metadata?.error ?? '')];
}

async function retryable(outputDir, stderr) {
  let summary;
  try { summary = JSON.parse(await readFile(path.join(outputDir, 'summary.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return isRateLimit(stderr);
    throw error;
  }
  const errors = (summary.suites ?? []).flatMap(suite =>
    (suite.results ?? []).filter(result => result.status === 'error').map(result => ({ suite, result })));
  if (!errors.length) return isRateLimit(stderr);
  for (const { suite, result } of errors) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(suite.skill) ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.name) ||
        !['baseline', 'skilled'].includes(result.variant) || !Number.isInteger(result.trial) || result.trial < 0) {
      throw new Error('Invalid trial identity in retry evidence');
    }
    const dir = path.join(outputDir, 'private', suite.skill, result.name, `${result.variant}-${result.trial}`);
    try {
      if (result.error === 'execution-error') {
        if (!isRateLimit(await readFile(path.join(dir, 'error.txt'), 'utf8'))) return false;
      } else if (result.error === 'grading-error') {
        const grade = JSON.parse(await readFile(path.join(dir, 'grading.json'), 'utf8'));
        const reasons = gradingErrors(grade);
        if (!reasons.length || !reasons.every(isRateLimit)) return false;
      } else {
        return false;
      }
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  return true;
}

export async function runWithRetries({ outputDir, runAttempt, maxAttempts = 4, sleep: wait = sleep, random = Math.random }) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer');
  const attemptsDir = `${outputDir}-attempts`;
  await mkdir(path.dirname(outputDir), { recursive: true });
  await mkdir(attemptsDir);
  let result;
  let attempt;
  for (attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptDir = path.join(attemptsDir, String(attempt));
    result = await runAttempt(attemptDir, attempt);
    await mkdir(attemptDir, { recursive: true });
    const rateLimited = result.exitCode !== 0 && await retryable(attemptDir, result.stderr);
    await writeFile(path.join(attemptDir, 'attempt.json'), `${JSON.stringify({ attempt, exitCode: result.exitCode, rateLimited })}\n`);
    if (!rateLimited || attempt === maxAttempts) break;
    // Copilot's inference error asks for up to a minute; jitter separates jobs
    // sharing one account so they do not all retry at the same instant.
    const waitMs = 60_000 + Math.floor(random() * 30_000);
    console.warn(`Copilot rate limit on attempt ${attempt}; retrying after ${Math.ceil(waitMs / 1000)} seconds.`);
    await wait(waitMs);
  }
  await rename(path.join(attemptsDir, String(attempt)), outputDir);
  if (attempt > 1) await rename(attemptsDir, path.join(outputDir, 'previous-attempts'));
  else await rmdir(attemptsDir);
  return { exitCode: result.exitCode, attempts: attempt };
}

function runAttempt(outputDir) {
  const fields = [
    ['SKILL', '--skill'], ['CASE', '--case'], ['RUNS', '--runs'],
    ['MODEL', '--model'], ['JUDGE_MODEL', '--judge-model'],
    ['REASONING_EFFORT', '--reasoning-effort'], ['JUDGE_REASONING_EFFORT', '--judge-reasoning-effort'],
  ];
  const args = [path.join(import.meta.dirname, 'run.mjs'), 'run'];
  for (const [name, flag] of fields) {
    if (!process.env[name]) throw new Error(`${name} is required`);
    args.push(flag, process.env[name]);
  }
  args.push('--out', outputDir);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk.toString()).slice(-1_000_000);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ exitCode: code ?? 1, stderr: `${stderr}\n${signal ?? ''}` }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runWithRetries({ outputDir: path.resolve('evals/reports/action'), runAttempt })
    .then(({ exitCode }) => { process.exitCode = exitCode; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
