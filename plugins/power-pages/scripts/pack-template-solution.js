#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { commandError, runPac } = require('./lib/pac-command');
const {
  validateUnpackedSolutionDirectory,
  validateZipContainsSolution,
} = require('./lib/template-catalog');

const WORK_DIRECTORY_PREFIX = 'powerpages-template-solution-';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--solutionPath') args.solutionPath = argv[++i];
    else if (argv[i] === '--cleanup') args.cleanup = true;
    else if (argv[i] === '--workDirectory') args.workDirectory = argv[++i];
  }
  return args;
}

function isOwnedWorkDirectory(workDirectory, tmpRoot = os.tmpdir()) {
  const resolved = path.resolve(workDirectory || '');
  return path.dirname(resolved) === path.resolve(tmpRoot) &&
    new RegExp(`^${WORK_DIRECTORY_PREFIX}[A-Za-z0-9_-]{6,}$`).test(path.basename(resolved));
}

function cleanupPackedTemplateSolution(workDirectory, deps = {}) {
  const fsImpl = deps.fs || fs;
  const tmpRoot = deps.tmpRoot || os.tmpdir();
  try {
    if (!isOwnedWorkDirectory(workDirectory, tmpRoot)) {
      return { ok: false, error: 'workDirectory is not a generated template solution directory' };
    }
    if (!fsImpl.existsSync(workDirectory)) return { ok: true, removed: false };
    const stat = fsImpl.lstatSync(workDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, error: 'workDirectory is not a removable template solution directory' };
    }
    fsImpl.rmSync(workDirectory, { recursive: true, force: true });
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, error: `Could not remove generated template solution directory: ${err.message}` };
  }
}

function failureWithCleanup(primaryFailure, workDirectory, deps = {}) {
  const cleanup = cleanupPackedTemplateSolution(workDirectory, deps);
  if (cleanup.ok) return primaryFailure;
  return {
    ...primaryFailure,
    workDirectory,
    cleanupError: cleanup.error,
  };
}

function packTemplateSolution(options = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  if (!options.solutionPath) {
    return { ok: false, step: 'validation', error: 'solutionPath is required' };
  }
  const solutionPath = path.resolve(options.solutionPath);
  let validationError;
  try {
    validationError = validateUnpackedSolutionDirectory(solutionPath, { fs: fsImpl });
  } catch (err) {
    validationError = err.message;
  }
  if (validationError) {
    return { ok: false, step: 'validation', error: validationError };
  }

  const tmpRoot = deps.tmpRoot || os.tmpdir();
  const workDirectory = fsImpl.mkdtempSync(path.join(tmpRoot, WORK_DIRECTORY_PREFIX));
  const zipPath = path.join(workDirectory, 'supporting-solution.zip');
  const pac = deps.runPac || ((args) => runPac(args, deps));
  const packResult = pac([
    'solution', 'pack',
    '--zipfile', zipPath,
    '--folder', solutionPath,
    '--packagetype', 'Unmanaged',
  ]);
  if (packResult.status !== 0) {
    return failureWithCleanup(
      { ok: false, step: 'pack', error: commandError('pac solution pack', packResult) },
      workDirectory,
      { fs: fsImpl, tmpRoot }
    );
  }

  const validZip = fsImpl.existsSync(zipPath) &&
    fsImpl.statSync(zipPath).isFile() &&
    fsImpl.statSync(zipPath).size > 0 &&
    validateZipContainsSolution(zipPath, { fs: fsImpl });
  if (!validZip) {
    return failureWithCleanup(
      { ok: false, step: 'output', error: 'pac solution pack did not create a valid solution zip' },
      workDirectory,
      { fs: fsImpl, tmpRoot }
    );
  }

  return { ok: true, solutionPath, zipPath, workDirectory };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.cleanup
    ? cleanupPackedTemplateSolution(args.workDirectory)
    : packTemplateSolution(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  WORK_DIRECTORY_PREFIX,
  cleanupPackedTemplateSolution,
  failureWithCleanup,
  isOwnedWorkDirectory,
  packTemplateSolution,
  parseArgs,
};
