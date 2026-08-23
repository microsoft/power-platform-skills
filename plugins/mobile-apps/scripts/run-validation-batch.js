#!/usr/bin/env node
'use strict';

/**
 * Runs changed-file mobile validators with bounded concurrency and reuses only
 * hash-identical prior PASS results. Writes .tmp/validation-receipt.json.
 *
 * Usage:
 *   node run-validation-batch.js --project-root <dir> --file <path> [...]
 *   node run-validation-batch.js --project-root <dir> --all-source
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { VALIDATORS, isTextFile } = require('./lib/mobile-validator-manifest');
const {
  hashFile,
  isWithinRoot,
  readJson,
  sha256,
  stableJson,
  walkFiles,
  writeJsonAtomic,
} = require('./lib/workflow-artifacts');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const REPAIR_ORDER = ['safety', 'connector', 'route', 'quality', 'contrast', 'typescript'];

function fail(message, code = 2) {
  console.error(`validation-batch: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const parsed = { files: [], allSource: false, concurrency: 4, approved: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') { parsed.projectRoot = argv[++index]; }
    else if (arg === '--file') { parsed.files.push(argv[++index]); }
    else if (arg === '--all-source') { parsed.allSource = true; }
    else if (arg === '--concurrency') { parsed.concurrency = Number(argv[++index]); }
    else if (arg === '--approved-js-dependency') { parsed.approved.push(argv[++index]); }
  }
  return parsed;
}

function category(script) {
  if (/write-safety|protected-paths|package-deps|icon-imports/.test(script)) return 'safety';
  if (/connector-first|dataverse-payload|heavy-lists/.test(script)) return 'connector';
  if (/navigation/.test(script)) return 'route';
  if (/screen-quality/.test(script)) return 'quality';
  if (/color-contrast/.test(script)) return 'contrast';
  return 'quality';
}

function collectFiles(projectRoot, args) {
  const files = new Set();
  if (args.allSource) {
    for (const relativeRoot of ['app', 'src']) {
      const root = path.join(projectRoot, relativeRoot);
      for (const filePath of walkFiles(root, {
        include: (candidate) => /\.(?:ts|tsx)$/i.test(candidate),
        excludeDirectory: (candidate) => candidate === path.join(projectRoot, 'src', 'generated'),
      })) files.add(filePath);
    }
  }
  for (const input of args.files) {
    const filePath = path.resolve(projectRoot, input);
    if (!isWithinRoot(filePath, projectRoot)) fail(`file escapes project root: ${input}`);
    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile() || fs.lstatSync(filePath).isSymbolicLink()) {
      fail(`validation target must be a regular non-symlink file: ${input}`);
    }
    files.add(fs.realpathSync(filePath));
  }
  if (!files.size) fail('no files selected');
  return [...files].sort();
}

function validatorPayload(filePath, content, projectRoot, approved) {
  return JSON.stringify({
    cwd: projectRoot,
    tool_name: 'Write',
    tool_input: {
      content,
      file_path: filePath,
      filePath,
      validation_mode: 'optimized-mobile-workflow',
      approved_js_dependencies: approved,
    },
  });
}

function runTask(task, projectRoot, approved) {
  return new Promise((resolve) => {
    const validatorPath = path.join(PLUGIN_ROOT, 'hooks', task.validator);
    const content = isTextFile(task.filePath) ? fs.readFileSync(task.filePath, 'utf8') : '';
    const child = spawn(process.execPath, [validatorPath], {
      cwd: projectRoot,
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, PLUGIN_ROOT },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ ...task, status: 'fail', exitCode: 2, stderr: error.message }));
    child.on('close', (code) => resolve({
      ...task,
      status: code === 0 ? 'pass' : 'fail',
      exitCode: code ?? 2,
      stdout: stdout.slice(-12000),
      stderr: stderr.slice(-12000),
    }));
    child.stdin.end(validatorPayload(task.filePath, content, projectRoot, approved));
  });
}

async function runPool(tasks, limit, projectRoot, approved) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      results.push(await runTask(task, projectRoot, approved));
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.projectRoot) fail('--project-root is required', 1);
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 8) {
    fail('--concurrency must be 1-8', 1);
  }
  const requestedRoot = path.resolve(args.projectRoot);
  if (!fs.existsSync(requestedRoot)) fail('project root does not exist', 1);
  const projectRoot = fs.realpathSync(requestedRoot);
  const files = collectFiles(projectRoot, args);
  const receiptPath = path.join(projectRoot, '.tmp', 'validation-receipt.json');
  const previous = fs.existsSync(receiptPath) ? readJson(receiptPath, receiptPath) : { results: [] };
  const previousPasses = new Map(
    (previous.results || []).filter((result) => result.status === 'pass').map((result) => [result.cacheKey, result]),
  );
  const approvedSha256 = sha256(stableJson(args.approved.sort()));
  const contextFiles = [
    'native-app-plan.md',
    'package.json',
    'tsconfig.json',
    'brand/design-decision.json',
    '.tmp/screen-contract.json',
    '.tmp/service-inventory.json',
    '.datamodel-manifest.json',
  ].map((relativePath) => {
    const filePath = path.join(projectRoot, relativePath);
    return {
      path: relativePath,
      sha256: fs.existsSync(filePath) ? hashFile(filePath) : null,
    };
  });
  const contextSha256 = sha256(stableJson(contextFiles));
  const tasks = [];
  const cached = [];
  for (const filePath of files) {
    const fileSha256 = hashFile(filePath);
    for (const validator of VALIDATORS) {
      if (!validator.appliesTo(filePath)) continue;
      const validatorPath = path.join(PLUGIN_ROOT, 'hooks', validator.script);
      const cacheKey = sha256(stableJson({
        file: path.relative(projectRoot, filePath),
        fileSha256,
        validator: validator.script,
        validatorSha256: hashFile(validatorPath),
        approvedSha256,
        contextSha256,
      }));
      const task = {
        filePath,
        relativePath: path.relative(projectRoot, filePath).split(path.sep).join('/'),
        fileSha256,
        validator: validator.script,
        category: category(validator.script),
        cacheKey,
      };
      if (previousPasses.has(cacheKey)) cached.push({ ...task, status: 'pass', exitCode: 0, cached: true });
      else tasks.push(task);
    }
  }
  const executed = await runPool(tasks, args.concurrency, projectRoot, args.approved);
  const results = [...cached, ...executed]
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.validator.localeCompare(right.validator));
  const failures = results.filter((result) => result.status !== 'pass');
  const receipt = {
    schemaVersion: 1,
    projectRootSha256: sha256(projectRoot),
    contextFiles,
    contextSha256,
    files: files.map((filePath) => ({ path: path.relative(projectRoot, filePath), sha256: hashFile(filePath) })),
    concurrency: args.concurrency,
    cachedCount: cached.length,
    executedCount: executed.length,
    repairOrder: REPAIR_ORDER,
    status: failures.length ? 'fail' : 'pass',
    results,
    completedAt: new Date().toISOString(),
  };
  receipt.receiptSha256 = sha256(stableJson(receipt));
  writeJsonAtomic(receiptPath, receipt);
  if (failures.length) {
    for (const repairCategory of REPAIR_ORDER) {
      for (const result of failures.filter((failure) => failure.category === repairCategory)) {
        process.stderr.write(`[${repairCategory}] ${result.relativePath} :: ${result.validator}\n${result.stderr || result.stdout || ''}\n`);
      }
    }
    process.exitCode = 2;
    return;
  }
  console.log(`validation-batch: PASS (${results.length} checks, ${cached.length} cached)`);
}

main().catch((error) => fail(error.stack || error.message));
