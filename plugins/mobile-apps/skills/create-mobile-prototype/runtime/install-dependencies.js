#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fail(message) {
  console.error(`prototype-install: ${message}`);
  process.exit(1);
}

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}`);
}

function parseArgs(argv) {
  const managerIndex = argv.indexOf('--manager');
  const manager = managerIndex >= 0 ? argv[managerIndex + 1] : 'auto';
  const projectDir = argv.find((value, index) => (
    !value.startsWith('--') && (managerIndex < 0 || index !== managerIndex + 1)
  ));
  if (!projectDir || !['auto', 'npm', 'pnpm'].includes(manager)) {
    fail('usage: install-dependencies.js <project-dir> [--manager auto|npm|pnpm] [--dry-run]');
  }
  return { dryRun: argv.includes('--dry-run'), manager, projectDir: path.resolve(projectDir) };
}

function selectManager(requested) {
  if (requested === 'npm') return 'npm';
  if (requested === 'pnpm') {
    if (!commandExists('pnpm')) fail('pnpm was requested but is not available');
    return 'pnpm';
  }
  return commandExists('pnpm') ? 'pnpm' : 'npm';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const packagePath = path.join(args.projectDir, 'package.json');
  const npmLockPath = path.join(args.projectDir, 'package-lock.json');
  const pnpmLockPath = path.join(args.projectDir, 'pnpm-lock.yaml');
  if (!fs.existsSync(packagePath)) fail(`${packagePath} is missing`);
  if (!fs.existsSync(npmLockPath)) fail(`${npmLockPath} is required for reproducible installs`);

  const manager = selectManager(args.manager);
  const command = manager === 'pnpm' ? 'pnpm' : 'npm';
  const commandArgs = manager === 'pnpm'
    ? ['install', '--frozen-lockfile']
    : ['install'];
  if (manager === 'pnpm' && !fs.existsSync(pnpmLockPath)) {
    fail(`${pnpmLockPath} is required when pnpm is available`);
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ command, args: commandArgs, manager, projectDir: args.projectDir }));
    return;
  }

  const startedAt = Date.now();
  run(command, commandArgs, args.projectDir);
  console.log(`prototype-install: ${manager} completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

if (require.main === module) main();

module.exports = { commandExists, parseArgs, selectManager };