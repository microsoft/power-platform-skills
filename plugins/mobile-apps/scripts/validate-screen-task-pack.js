#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { revisionForTask, screenTaskPacks, stableStringify } = require('./compile-screen-build-pack');
const { validateScreenBuildPack } = require('./validate-screen-build-pack');

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function validateScreenTaskPack(task, pack) {
  const issues = [];
  if (!task || task.schemaVersion !== 1 || task.kind !== 'mobile-screen-task') {
    return [{ rule: 'invalid-screen-task', message: 'Screen task requires schemaVersion 1 and kind mobile-screen-task.' }];
  }
  if (task.packRevision !== pack?.revision) issues.push({ rule: 'screen-task-pack-drift', message: 'Screen task does not reference the current screen build pack revision.' });
  if (!/^[a-f0-9]{64}$/.test(String(task.revision || '')) || task.revision !== revisionForTask(task)) {
    issues.push({ rule: 'screen-task-revision-drift', message: 'Screen task revision does not match its deterministic content.' });
  }
  const expected = screenTaskPacks(pack).find((candidate) => candidate.target.screenId === task.target?.screenId);
  if (!expected) {
    issues.push({ rule: 'unknown-screen-task', message: `Screen task target ${task.target?.screenId || '<missing>'} is not present in the screen build pack.` });
    return issues;
  }
  if (stableStringify(task) !== stableStringify(expected)) {
    issues.push({ rule: 'screen-task-content-drift', message: `Screen task ${task.target.screenId} does not match its immutable work order.` });
  }
  return issues;
}

function validateScreenTaskDirectory(projectRoot, pack, relativeDirectory = '.tmp/screen-tasks') {
  const issues = [];
  const directory = path.resolve(projectRoot, relativeDirectory);
  if (!fs.existsSync(directory)) return [{ rule: 'missing-screen-task-directory', message: `Screen task directory is missing: ${relativeDirectory}.` }];
  const expected = new Set((pack.screens || []).map((screen) => `${screen.id}.json`));
  const actual = new Set(fs.readdirSync(directory).filter((name) => name.endsWith('.json')));
  for (const name of expected) {
    if (!actual.has(name)) issues.push({ rule: 'missing-screen-task', message: `Screen task is missing: ${relativeDirectory}/${name}.` });
  }
  for (const name of actual) {
    if (!expected.has(name)) issues.push({ rule: 'stale-screen-task', message: `Screen task has no current build-pack target: ${relativeDirectory}/${name}.` });
  }
  for (const name of expected) {
    const filePath = path.join(directory, name);
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      issues.push({ rule: 'unsafe-screen-task', message: `Screen task must be a regular non-symlink file: ${relativeDirectory}/${name}.` });
      continue;
    }
    try {
      issues.push(...validateScreenTaskPack(readJson(filePath, `Screen task ${name}`), pack));
    } catch (error) {
      issues.push({ rule: 'invalid-screen-task-json', message: error.message });
    }
  }
  return issues;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') args.projectRoot = argv[++index];
    else if (argv[index] === '--pack') args.pack = argv[++index];
    else if (argv[index] === '--task') args.task = argv[++index];
    else if (argv[index] === '--json') args.json = true;
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args.projectRoot) {
    process.stderr.write('Usage: node validate-screen-task-pack.js --project-root <dir> [--pack <path>] [--task <path>] [--json]\n');
    return 2;
  }
  try {
    const root = path.resolve(args.projectRoot);
    const pack = readJson(path.resolve(root, args.pack || '.tmp/screen-build-pack.json'), 'Screen build pack');
    const packValidation = validateScreenBuildPack(root, pack);
    const issues = packValidation.issues.length
      ? packValidation.issues
      : args.task
        ? validateScreenTaskPack(readJson(path.resolve(root, args.task), 'Screen task'), pack)
        : validateScreenTaskDirectory(root, pack);
    if (args.json) process.stdout.write(`${JSON.stringify({ validator: 'validate-screen-task-pack', issues }, null, 2)}\n`);
    if (issues.length) {
      if (!args.json) issues.forEach((issue) => process.stderr.write(`- [${issue.rule}] ${issue.message}\n`));
      return 2;
    }
    if (!args.json) process.stdout.write('Screen task packs passed.\n');
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: screen task pack: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { validateScreenTaskDirectory, validateScreenTaskPack };