#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
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
    else if (argv[i] === '--cleanupMarker') args.cleanupMarker = argv[++i];
    else if (argv[i] === '--cleanupToken') args.cleanupToken = argv[++i];
  }
  return args;
}

function isGeneratedWorkDirectoryPath(workDirectory, tmpRoot = os.tmpdir()) {
  const resolved = path.resolve(workDirectory || '');
  return path.dirname(resolved) === path.resolve(tmpRoot) &&
    new RegExp(`^${WORK_DIRECTORY_PREFIX}[A-Za-z0-9_-]{6,}$`).test(path.basename(resolved));
}

function createWorkDirectoryOwnership(workDirectory, deps = {}) {
  const fsImpl = deps.fs || fs;
  const tmpRoot = deps.tmpRoot || os.tmpdir();
  const randomBytes = deps.randomBytes || crypto.randomBytes;
  if (!isGeneratedWorkDirectoryPath(workDirectory, tmpRoot)) {
    throw new Error('workDirectory is not a generated template solution directory');
  }
  const workStat = fsImpl.lstatSync(workDirectory);
  if (workStat.isSymbolicLink() || !workStat.isDirectory()) {
    throw new Error('workDirectory is not a regular directory');
  }
  const canonicalWorkDirectory = fsImpl.realpathSync(workDirectory);
  const canonicalTmpRoot = fsImpl.realpathSync(tmpRoot);
  if (path.dirname(canonicalWorkDirectory) !== canonicalTmpRoot) {
    throw new Error('workDirectory resolves outside the temporary directory');
  }

  const cleanupToken = randomBytes(16).toString('hex');
  const cleanupMarker = path.join(
    path.resolve(tmpRoot),
    `.${WORK_DIRECTORY_PREFIX}${path.basename(workDirectory)}-${process.pid}-${cleanupToken}.json`
  );
  fsImpl.writeFileSync(
    cleanupMarker,
    JSON.stringify({ workDirectory: canonicalWorkDirectory, cleanupToken }),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );
  return { cleanupMarker, cleanupToken };
}

function isOwnedWorkDirectory(workDirectory, deps = {}) {
  const fsImpl = deps.fs || fs;
  const tmpRoot = deps.tmpRoot || os.tmpdir();
  const { cleanupMarker, cleanupToken } = deps;
  try {
    if (!cleanupMarker || !cleanupToken || !isGeneratedWorkDirectoryPath(workDirectory, tmpRoot)) {
      return false;
    }
    const resolvedMarker = path.resolve(cleanupMarker);
    if (path.dirname(resolvedMarker) !== path.resolve(tmpRoot)) return false;
    const markerStat = fsImpl.lstatSync(resolvedMarker);
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) return false;
    const canonicalTmpRoot = fsImpl.realpathSync(tmpRoot);
    if (path.dirname(fsImpl.realpathSync(resolvedMarker)) !== canonicalTmpRoot) return false;
    const ownership = JSON.parse(fsImpl.readFileSync(resolvedMarker, 'utf8'));
    if (ownership.cleanupToken !== cleanupToken) return false;

    const resolvedWorkDirectory = path.resolve(workDirectory);
    const expectedCanonicalWorkDirectory = path.join(canonicalTmpRoot, path.basename(resolvedWorkDirectory));
    if (ownership.workDirectory !== expectedCanonicalWorkDirectory) return false;
    if (!fsImpl.existsSync(resolvedWorkDirectory)) return true;
    const workStat = fsImpl.lstatSync(resolvedWorkDirectory);
    return workStat.isDirectory() &&
      !workStat.isSymbolicLink() &&
      fsImpl.realpathSync(resolvedWorkDirectory) === ownership.workDirectory;
  } catch {
    return false;
  }
}

function cleanupPackedTemplateSolution(workDirectory, deps = {}) {
  const fsImpl = deps.fs || fs;
  try {
    if (!isOwnedWorkDirectory(workDirectory, deps)) {
      return { ok: false, error: 'workDirectory ownership could not be verified' };
    }
    let removed = false;
    if (fsImpl.existsSync(workDirectory)) {
      fsImpl.rmSync(workDirectory, { recursive: true, force: true });
      removed = true;
    }
    fsImpl.rmSync(deps.cleanupMarker, { force: true });
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: `Could not remove generated template solution directory: ${err.message}` };
  }
}

function failureWithCleanup(primaryFailure, workDirectory, ownership, deps = {}) {
  const cleanup = cleanupPackedTemplateSolution(workDirectory, { ...deps, ...ownership });
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
  let ownership;
  try {
    ownership = createWorkDirectoryOwnership(workDirectory, deps);
  } catch (err) {
    fsImpl.rmSync(workDirectory, { recursive: true, force: true });
    return { ok: false, step: 'work-directory', error: `Could not own generated template solution directory: ${err.message}` };
  }
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
      ownership,
      { fs: fsImpl, tmpRoot }
    );
  }

  let validZip = false;
  if (isOwnedWorkDirectory(workDirectory, { fs: fsImpl, tmpRoot, ...ownership }) && fsImpl.existsSync(zipPath)) {
    const zipStat = fsImpl.lstatSync(zipPath);
    validZip = !zipStat.isSymbolicLink() &&
      zipStat.isFile() &&
      zipStat.size > 0 &&
      validateZipContainsSolution(zipPath, { fs: fsImpl });
  }
  if (!validZip) {
    return failureWithCleanup(
      { ok: false, step: 'output', error: 'pac solution pack did not create a valid solution zip' },
      workDirectory,
      ownership,
      { fs: fsImpl, tmpRoot }
    );
  }

  return { ok: true, solutionPath, zipPath, workDirectory, ...ownership };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.cleanup
    ? cleanupPackedTemplateSolution(args.workDirectory, args)
    : packTemplateSolution(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  WORK_DIRECTORY_PREFIX,
  cleanupPackedTemplateSolution,
  createWorkDirectoryOwnership,
  failureWithCleanup,
  isGeneratedWorkDirectoryPath,
  isOwnedWorkDirectory,
  packTemplateSolution,
  parseArgs,
};
