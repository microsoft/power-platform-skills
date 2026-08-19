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
    'Usage: node validate-mobile-files.js --project-root <path> (--file <path> [--file <path> ...] | --all-source) [--approved-js-dependency <name>@<exact-version> ...]',
    '',
    'Paths must be regular files. Relative paths resolve from --project-root.',
    '--all-source validates every .ts/.tsx file under app/ and non-generated src/.',
    'Approved JavaScript dependencies must use exact semver versions from the reviewed app plan.',
  ].join('\n');
}

function parseApprovedJsDependency(value) {
  if (typeof value !== 'string') return null;
  const separator = value.lastIndexOf('@');
  if (separator <= 0) return null;
  const name = value.slice(0, separator);
  const version = value.slice(separator + 1);
  if (!name || (name.startsWith('@') && !name.includes('/'))) return null;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return null;
  return { name, version };
}

function parseArgs(argv) {
  const parsed = {
    allSource: false,
    approvedJsDependencies: [],
    errors: [],
    projectRoot: null,
    targets: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') {
      parsed.projectRoot = argv[index + 1];
      index += 1;
    } else if (arg === '--file') {
      parsed.targets.push(argv[index + 1]);
      index += 1;
    } else if (arg === '--approved-js-dependency') {
      const approvedDependency = parseApprovedJsDependency(argv[index + 1]);
      if (approvedDependency) {
        parsed.approvedJsDependencies.push(approvedDependency);
      } else {
        parsed.errors.push(`Invalid --approved-js-dependency value: ${argv[index + 1] || '<missing>'}`);
      }
      index += 1;
    } else if (arg === '--all-source') {
      parsed.allSource = true;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      parsed.targets.push(arg);
    }

  }

  return parsed;
}

function collectSourceFiles(projectRoot) {
  const files = [];
  const roots = ['app', 'src'];

  function visit(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entryPath === path.join(projectRoot, 'src', 'generated')) continue;
        visit(entryPath);
      } else if (entry.isFile() && /\.(?:ts|tsx)$/i.test(entry.name)) {
        files.push(entryPath);
      }
    }
  }

  for (const root of roots) visit(path.join(projectRoot, root));
  return files.sort();
}

function isWithinRoot(filePath, projectRoot) {
  const relative = path.relative(projectRoot, filePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function runValidator(validatorName, filePath, content, projectRoot, approvedJsDependencies) {
  const validatorPath = path.join(PLUGIN_ROOT, 'hooks', validatorName);
  const payload = JSON.stringify({
    cwd: projectRoot,
    tool_name: 'Write',
    tool_input: {
      content,
      file_path: filePath,
      filePath,
      validation_mode: 'explicit-mobile-workflow',
      approved_js_dependencies: approvedJsDependencies,
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
  const {
    allSource,
    approvedJsDependencies,
    errors,
    help,
    projectRoot: projectRootArg,
    targets,
  } = parseArgs(argv);
  if (help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n\n${usage()}\n`);
    return 1;
  }
  if (!projectRootArg || (!allSource && targets.length === 0) || targets.some((target) => !target)) {
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

  if (allSource) {
    for (const sourceFile of collectSourceFiles(projectRoot)) files.add(sourceFile);
  }

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
      const result = runValidator(
        validator.script,
        filePath,
        content,
        projectRoot,
        approvedJsDependencies,
      );
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
  collectSourceFiles,
  isWithinRoot,
  main,
  parseArgs,
  parseApprovedJsDependency,
};