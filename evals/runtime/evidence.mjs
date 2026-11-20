import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// GitHub token shapes: https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/
// Model output often quotes placeholders such as `Bearer ${token}`, so only
// real token shapes and the run's own token value count as leaks.
const tokenPattern = /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/;
const maxReason = 800;

function oneLine(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > maxReason ? `${value.slice(0, maxReason)}...` : value;
}

function formatScore(score) {
  return typeof score === 'number' ? ` (score ${Number(score.toFixed(2))})` : '';
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function readText(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// A Vally grading.json nests results as
//   trajectory-grade -> grader (code | llm) -> check or rubric criterion
// and each level carries `passed`, `score` and an `evidence` string. For a
// prompt grader, `evidence` is the judge's explanation for that score.
function graderLines(grader) {
  const lines = [`- \`${grader.name}\`${formatScore(grader.score)}: ${oneLine(grader.evidence)}`];
  for (const detail of grader.details ?? []) {
    if (detail.passed === false) lines.push(`  - ${detail.name}${formatScore(detail.score)}: ${oneLine(detail.evidence)}`);
  }
  return lines;
}

// Explains every non-passing trial in a run directory written by run.mjs, so
// a reviewer can see why a check failed without rerunning the evaluation.
export async function failureReport(outDir) {
  const summary = await readJson(path.join(outDir, 'summary.json'));
  if (!summary) return '## Grader reasons\n\nNo summary was written; the run stopped before any trial.\n';
  const lines = [`## Grader reasons: ${summary.model} judged by ${summary.judgeModel}`, ''];
  let failures = 0;
  for (const suite of summary.suites ?? []) {
    for (const result of suite.results ?? []) {
      if (result.status === 'passed') continue;
      failures++;
      const evidenceDir = path.join(outDir, 'private', suite.skill, result.name, `${result.variant}-${result.trial}`);
      lines.push(`### ${suite.skill} / ${result.name} (${result.variant}, trial ${result.trial}): ${result.status}`, '');
      const grading = await readJson(path.join(evidenceDir, 'grading.json'));
      if (grading) {
        for (const grader of grading.details ?? []) {
          if (grader.passed === false) lines.push(...graderLines(grader));
        }
      } else {
        const error = await readText(path.join(evidenceDir, 'error.txt'));
        lines.push(`- Error: ${oneLine(error?.split('\n')[0] ?? 'no grading or error evidence was saved')}`);
      }
      lines.push('');
    }
  }
  if (!failures) lines.push('Every trial passed.', '');
  return `${lines.join('\n')}\n`;
}

async function listFiles(dir, root = dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(full, root));
    else if (entry.isFile()) files.push(path.relative(root, full));
  }
  return files;
}

// Returns the relative paths of files that contain a credential, never the
// matched value, so the caller can fail without echoing the secret to logs.
export async function findCredentials(dir, knownSecrets = []) {
  const secrets = knownSecrets.filter(value => typeof value === 'string' && value.length >= 8);
  const leaks = [];
  for (const file of await listFiles(dir)) {
    const text = (await readFile(path.join(dir, file))).toString('latin1');
    if (tokenPattern.test(text) || secrets.some(secret => text.includes(secret))) leaks.push(file);
  }
  return leaks;
}

async function main([command, dir]) {
  if (!['report', 'check'].includes(command) || !dir) throw new Error('Usage: node evidence.mjs report|check DIR');
  if (command === 'report') {
    process.stdout.write(await failureReport(path.resolve(dir)));
    return;
  }
  const leaks = await findCredentials(path.resolve(dir), [process.env.GITHUB_TOKEN]);
  if (leaks.length) {
    console.error(`Credential-like content found; evidence will not be uploaded:\n${leaks.join('\n')}`);
    process.exitCode = 1;
  } else {
    console.log('No credentials found in evaluation evidence.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
