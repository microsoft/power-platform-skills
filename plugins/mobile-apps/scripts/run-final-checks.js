#!/usr/bin/env node
'use strict';

/**
 * Runs independent final read-only checks concurrently, then runs the batched
 * changed-file validator. Reports failures in canonical repair order and writes
 * both JSON and Markdown receipts.
 *
 * Usage:
 *   node run-final-checks.js --project-root <dir> [--file <path> ...|--all-source]
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  hashFile,
  sha256,
  stableJson,
  writeJsonAtomic,
  writeTextAtomic,
} = require('./lib/workflow-artifacts');

const REPAIR_ORDER = ['route', 'contract', 'quality', 'contrast', 'typescript', 'changed-file'];

function fail(message, code = 2) {
  console.error(`final-checks: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const parsed = { files: [], allSource: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') parsed.projectRoot = argv[++index];
    else if (arg === '--file') parsed.files.push(argv[++index]);
    else if (arg === '--all-source') parsed.allSource = true;
  }
  return parsed;
}

function run(name, category, command, args, cwd) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ name, category, status: 'fail', exitCode: 2, durationMs: Date.now() - startedAt, stderr: error.message }));
    child.on('close', (code) => resolve({
      name,
      category,
      status: code === 0 ? 'pass' : 'fail',
      exitCode: code ?? 2,
      durationMs: Date.now() - startedAt,
      stdout: stdout.slice(-20000),
      stderr: stderr.slice(-20000),
    }));
  });
}

function issueCount(result) {
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed.issues) ? parsed.issues.length : 0;
  } catch {
    return result.status === 'pass' ? 0 : null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectRoot) fail('--project-root is required', 1);
  const projectRoot = path.resolve(args.projectRoot);
  const pluginRoot = path.resolve(__dirname, '..');
  const node = process.execPath;
  const planPath = path.join(projectRoot, 'native-app-plan.md');
  if (!fs.existsSync(planPath)) fail('native-app-plan.md is missing', 1);

  const core = [
    run('check-routes.js', 'route', node, [path.join(pluginRoot, 'scripts', 'check-routes.js')], projectRoot),
    run('validate-screen-contracts.js', 'contract', node, [path.join(pluginRoot, 'scripts', 'validate-screen-contracts.js'), planPath], projectRoot),
    run('validate-screen-quality.js --report', 'quality', node, [path.join(pluginRoot, 'hooks', 'validate-screen-quality.js'), '--report', 'app'], projectRoot),
    run('validate-color-contrast.js --report', 'contrast', node, [path.join(pluginRoot, 'hooks', 'validate-color-contrast.js'), '--report', 'app'], projectRoot),
    run('npm run type-check', 'typescript', node, [path.join(pluginRoot, 'scripts', 'run-tsc-gate.js'), '--project-root', projectRoot, '--gate', 'final', '--clean'], projectRoot),
  ];
  const results = await Promise.all(core);
  for (const result of results) {
    result.issueCount = issueCount(result);
    if ((result.category === 'quality' || result.category === 'contrast') && result.issueCount > 0) {
      result.status = 'fail';
      result.exitCode = 2;
      result.stderr = `${result.issueCount} reported ${result.category} issue(s)`;
    }
  }

  const validationArgs = [path.join(pluginRoot, 'scripts', 'run-validation-batch.js'), '--project-root', projectRoot];
  if (args.allSource || args.files.length === 0) validationArgs.push('--all-source');
  for (const file of args.files) validationArgs.push('--file', file);
  const changedFileResult = await run(
    'validate-mobile-files.js (batched receipt)',
    'changed-file',
    node,
    validationArgs,
    projectRoot,
  );
  changedFileResult.issueCount = changedFileResult.status === 'pass' ? 0 : null;
  results.push(changedFileResult);

  const failures = results.filter((result) => result.status !== 'pass');
  const receipt = {
    schemaVersion: 1,
    approvedPlanSha256: hashFile(planPath),
    repairOrder: REPAIR_ORDER,
    execution: 'concurrent-read-only-core-then-batched-write-safety',
    status: failures.length ? 'fail' : 'pass',
    results,
    completedAt: new Date().toISOString(),
  };
  receipt.receiptSha256 = sha256(stableJson(receipt));
  const receiptPath = path.join(projectRoot, '.tmp', 'final-checks-receipt.json');
  writeJsonAtomic(receiptPath, receipt);

  const markdown = [
    `Overall: ${failures.length ? 'FAIL' : 'PASS'}`,
    `Plan SHA-256: ${receipt.approvedPlanSha256}`,
    '',
    ...results.map((result) => `- ${result.status.toUpperCase()} ${result.name} — issues: ${result.issueCount ?? 'unknown'} — ${result.durationMs}ms`),
    '',
    `Repair order: ${REPAIR_ORDER.join(' -> ')}`,
    '',
  ].join('\n');
  writeTextAtomic(path.join(projectRoot, '.tmp', 'final-validation.md'), markdown);

  if (failures.length) {
    for (const category of REPAIR_ORDER) {
      for (const result of failures.filter((failure) => failure.category === category)) {
        process.stderr.write(`[${category}] ${result.name}\n${result.stderr || result.stdout || ''}\n`);
      }
    }
    process.exitCode = 2;
    return;
  }
  console.log(`final-checks: PASS (${results.length} gates)`);
}

main().catch((error) => fail(error.stack || error.message));
