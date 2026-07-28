#!/usr/bin/env node

/**
 * Runs the mobile plugin's former write hooks explicitly for files changed by a
 * mobile skill or agent. Plugin-level hooks run in unrelated plugin sessions,
 * so mobile workflows call this dispatcher before reporting completion.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { VALIDATORS, isTextFile } = require('./lib/mobile-validator-manifest');

const PLUGIN_ROOT = path.resolve(__dirname, '..');

function usage() {
  return [
    'Usage: node validate-mobile-files.js --project-root <path> --file <path> [--file <path> ...]',
    '',
    'Paths must be regular files. Relative paths resolve from --project-root.',
  ].join('\n');
}

function parseArgs(argv) {
  const parsed = { projectRoot: null, targets: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') {
      parsed.projectRoot = argv[index + 1];
      index += 1;
    } else if (arg === '--file') {
      parsed.targets.push(argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      parsed.targets.push(arg);
    }
  }

  return parsed;
}

function isWithinRoot(filePath, projectRoot) {
  const relative = path.relative(projectRoot, filePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function runValidator(validatorName, filePath, content, projectRoot) {
  const validatorPath = path.join(PLUGIN_ROOT, 'hooks', validatorName);
  const payload = JSON.stringify({
    cwd: projectRoot,
    tool_name: 'Write',
    tool_input: {
      content,
      file_path: filePath,
      filePath,
      validation_mode: 'explicit-mobile-workflow',
    },
  });

  return spawnSync(process.execPath, [validatorPath], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
      PLUGIN_ROOT,
    },
    input: payload,
  });
}

function main(argv) {
  const { help, projectRoot: projectRootArg, targets } = parseArgs(argv);
  if (help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!projectRootArg || targets.length === 0 || targets.some((target) => !target)) {
    process.stderr.write(`${usage()}\n`);
    return 1;
  }

  const requestedProjectRoot = path.resolve(projectRootArg);
  if (!fs.existsSync(requestedProjectRoot) || !fs.statSync(requestedProjectRoot).isDirectory()) {
    process.stderr.write(`Project root not found: ${requestedProjectRoot}\n`);
    return 1;
  }
  const projectRoot = fs.realpathSync(requestedProjectRoot);

  const files = new Set();
  let blocked = false;

  for (const target of targets) {
    const requestedTargetPath = path.resolve(projectRoot, target);
    if (!isWithinRoot(requestedTargetPath, projectRoot)) {
      process.stderr.write(`BLOCKED: validation target is outside the mobile project root: ${requestedTargetPath}\n`);
      blocked = true;
      continue;
    }
    if (!fs.existsSync(requestedTargetPath)) {
      process.stderr.write(`Validation target not found: ${requestedTargetPath}\n`);
      blocked = true;
      continue;
    }
    const stat = fs.lstatSync(requestedTargetPath);
    if (stat.isSymbolicLink()) {
      process.stderr.write(`BLOCKED: validation target must not be a symbolic link: ${requestedTargetPath}\n`);
      blocked = true;
      continue;
    }
    if (!stat.isFile()) {
      process.stderr.write(`Validation target must be a regular file: ${requestedTargetPath}\n`);
      blocked = true;
      continue;
    }
    const targetPath = fs.realpathSync(requestedTargetPath);
    if (!isWithinRoot(targetPath, projectRoot)) {
      process.stderr.write(`BLOCKED: resolved validation target is outside the mobile project root: ${targetPath}\n`);
      blocked = true;
      continue;
    }
    files.add(targetPath);
  }

  let binaryFiles = 0;
  for (const filePath of files) {
    const textFile = isTextFile(filePath);
    const content = textFile ? fs.readFileSync(filePath, 'utf8') : '';
    if (!textFile) binaryFiles += 1;

    for (const validator of VALIDATORS) {
      if (!validator.appliesTo(filePath)) continue;
      const result = runValidator(validator.script, filePath, content, projectRoot);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.error) {
        process.stderr.write(`Validator ${validator.script} failed to start: ${result.error.message}\n`);
        blocked = true;
      } else if (result.status !== 0) {
        blocked = true;
      }
    }
  }

  if (blocked) return 2;
  const binarySummary = binaryFiles > 0 ? `; ${binaryFiles} binary file path(s) checked` : '';
  process.stdout.write(`Mobile validation passed for ${files.size} file(s)${binarySummary}.\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  isWithinRoot,
  main,
  parseArgs,
};