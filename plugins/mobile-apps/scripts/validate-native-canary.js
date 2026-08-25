#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { validateScreenSourceContract } = require('./lib/screen-source-contract');
const {
  validateActionState,
  validateCapabilityComposition,
  validateCrossScreenContinuity,
  validateSemanticColorUsage,
  validateSignatureComponents,
  validateStaticLayoutBudgets,
} = require('./lib/workflow-regression');
const { validateDesignRuntime } = require('./validate-design-runtime');
const { validateNavigationContinuity } = require('./validate-navigation-continuity');
const { validateScreenBuildPack } = require('./validate-screen-build-pack');
const { validateScreenComposition } = require('./validate-screen-composition');

const RECEIPT_PATH = '.tmp/native-canary-validation.json';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function safeScreenFile(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..') || !/^app\/.+\.tsx$/.test(relativePath)) throw new Error(`unsafe canary screen path: ${relativePath}`);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isFile()) throw new Error(`canary screen must be a regular file: ${relativePath}`);
  return target;
}

function validateCanarySource(source, screen, pack) {
  const issues = [];
  if (/TODO:\s*screen-builder fills JSX here/i.test(source)) issues.push({ rule: 'unfinished-canary-screen', message: `Screen ${screen.id} still contains the builder skeleton marker.` });
  if (!/(?:export\s+default\s+(?:function|class)|export\s*\{[^}]+\s+as\s+default\s*\})/s.test(source)) issues.push({ rule: 'missing-canary-default-export', message: `Screen ${screen.id} lacks a default export.` });
  if (!/\bScreenShell\b/.test(source)) issues.push({ rule: 'missing-canary-screen-shell', message: `Screen ${screen.id} does not use ScreenShell.` });
  const escapedMode = String(screen.headerMode || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escapedMode && !new RegExp(`headerMode\\s*=\\s*["']${escapedMode}["']`).test(source)) issues.push({ rule: 'canary-header-mode-drift', message: `Screen ${screen.id} does not preserve headerMode ${screen.headerMode}.` });
  for (const operation of screen.data?.operations || []) {
    if (!source.includes(operation.id)) issues.push({ rule: 'canary-operation-anchor-missing', message: `Screen ${screen.id} lacks operation anchor ${operation.id}.` });
    if (!new RegExp(`\\b${operation.hook}\\s*\\(`).test(source)) issues.push({ rule: 'canary-domain-hook-missing', message: `Screen ${screen.id} does not call ${operation.hook}.` });
  }
  issues.push(...validateScreenSourceContract(source, screen, { minimumControlSize: pack.design?.recipe?.spacing?.minimumControlSize || 44 }));
  return issues;
}

function runTypecheck(root, runner = spawnSync) {
  const result = runner('npm', ['--prefix', root, 'run', 'type-check'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
  });
  return {
    passed: result.status === 0,
    exitCode: result.status,
    output: `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-8000),
  };
}

function validateNativeCanary(projectRoot, pack, options = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const issues = [];
  const packValidation = validateScreenBuildPack(root, pack);
  issues.push(...packValidation.issues.map((entry) => ({ rule: entry.rule, message: entry.message })));
  const screenIds = pack.nativeCanary?.screenIds || [];
  const sources = {};
  for (const screenId of screenIds) {
    const screen = (pack.screens || []).find((candidate) => candidate.id === screenId);
    if (!screen) {
      issues.push({ rule: 'missing-canary-screen', message: `Canary screen ${screenId} is absent from the pack.` });
      continue;
    }
    try {
      const source = fs.readFileSync(safeScreenFile(root, screen.file), 'utf8');
      sources[screenId] = { file: screen.file, sha256: sha256(source), bytes: Buffer.byteLength(source) };
      issues.push(...validateCanarySource(source, screen, pack).map((entry) => ({ ...entry, screenId })));
    } catch (error) {
      issues.push({ rule: 'invalid-canary-screen-file', message: error.message, screenId });
    }
  }
  const validatorOptions = { projectRoot: root, screenIds };
  for (const validator of [
    validateActionState,
    validateCrossScreenContinuity,
    validateSignatureComponents,
    validateCapabilityComposition,
    validateSemanticColorUsage,
    validateStaticLayoutBudgets,
  ]) issues.push(...validator(pack, validatorOptions));
  issues.push(...validateNavigationContinuity(pack));
  issues.push(...validateScreenComposition(pack));
  if (pack.sourcePaths?.designManifest) issues.push(...validateDesignRuntime(root));
  const typecheck = options.skipTypecheck ? { passed: true, exitCode: 0, output: 'skipped by test harness' } : runTypecheck(root, options.runner);
  if (!typecheck.passed) issues.push({ rule: 'canary-typecheck-failed', message: typecheck.output || `TypeScript exited ${typecheck.exitCode}.` });
  return {
    schemaVersion: 1,
    kind: 'native-canary-validation',
    valid: issues.length === 0,
    packRevision: pack.revision,
    primaryScreenId: pack.nativeCanary?.primaryScreenId || null,
    keyFlowScreenIds: pack.nativeCanary?.keyFlowScreenIds || [],
    screenIds,
    outcome: pack.nativeCanary?.outcome || null,
    sources,
    typecheck,
    qualityStatus: 'statically-validated',
    nativeVisualEvidence: null,
    validatedAt: new Date().toISOString(),
    issues,
  };
}

function writeReceipt(projectRoot, report) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const target = path.join(root, RECEIPT_PATH);
  if (!report.valid) {
    fs.rmSync(target, { force: true });
    return null;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return target;
}

function main(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-native-canary.js --project-root <dir> [--pack .tmp/screen-build-pack.json] [--json]\n');
    return 2;
  }
  try {
    const root = fs.realpathSync(path.resolve(args.projectRoot));
    const pack = readJson(path.resolve(root, args.pack || '.tmp/screen-build-pack.json'), 'Screen build pack');
    const report = validateNativeCanary(root, pack);
    writeReceipt(root, report);
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else if (report.valid) process.stdout.write(`Native canary passed: ${report.screenIds.join(', ')}.\n`);
    else report.issues.forEach((entry) => process.stderr.write(`- [${entry.rule}] ${entry.message}\n`));
    return report.valid ? 0 : 2;
  } catch (error) {
    process.stderr.write(`validate-native-canary: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { RECEIPT_PATH, runTypecheck, safeScreenFile, sha256, validateCanarySource, validateNativeCanary, writeReceipt };
