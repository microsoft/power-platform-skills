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
    'Usage: node validate-mobile-files.js --project-root <path> (--all-source | --file <path> [--file <path> ...]) [--approved-js-dependency <name>@<exact-version> ...] [--upgrade-only | --local-development] [--before-package-json <path>]',
    '',
    'Paths must be regular files. Relative paths resolve from --project-root.',
    '--all-source validates every .ts/.tsx file under app/ and src/, plus root .ts/.tsx files.',
    'Approved JavaScript dependencies must use exact semver versions from the reviewed app plan.',
    '--upgrade-only skips app-lock/native-inventory admission; the upgrade must pass Expo, Expo Doctor and TypeScript checks.',
    '--local-development retains file/package policies without blocking installation/startup on native compatibility.',
    '--before-package-json supplies a project-local pre-install manifest to scope local JS approval checks to additions/changes.',
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
    upgradeOnly: false,
    localDevelopment: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') {
      parsed.projectRoot = argv[index + 1];
      index += 1;
    } else if (arg === '--file') {
      parsed.targets.push(argv[index + 1]);
      index += 1;
    } else if (arg === '--all-source') {
      parsed.allSource = true;
    } else if (arg === '--upgrade-only') {
      parsed.upgradeOnly = true;
    } else if (arg === '--local-development') {
      parsed.localDevelopment = true;
    } else if (arg === '--before-package-json') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) parsed.errors.push('Missing --before-package-json path.');
      else { parsed.beforePackageJson = value; index += 1; }
    } else if (arg === '--diagnostic-artifacts') {
      parsed.errors.push('BLOCKED: --diagnostic-artifacts is retired. Use published host/template packages.');
      parsed.blocked = true;
      if (argv[index + 1] && !argv[index + 1].startsWith('--')) index++;
    } else if (arg === '--approved-js-dependency') {
      const approvedDependency = parseApprovedJsDependency(argv[index + 1]);
      if (approvedDependency) {
        parsed.approvedJsDependencies.push(approvedDependency);
      } else {
        parsed.errors.push(`Invalid --approved-js-dependency value: ${argv[index + 1] || '<missing>'}`);
      }
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      parsed.targets.push(arg);
    }
  }

  if (parsed.upgradeOnly && parsed.localDevelopment) {
    parsed.errors.push('Choose --upgrade-only or --local-development, not both.');
  }
  if (parsed.beforePackageJson && !parsed.localDevelopment) {
    parsed.errors.push('--before-package-json requires --local-development.');
  }
  return parsed;
}

function isWithinRoot(filePath, projectRoot) {
  const relative = path.relative(projectRoot, filePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function collectSourceTargets(projectRoot) {
  const targets = [];

  function visit(relativeDirectory) {
    const absoluteDirectory = path.join(projectRoot, relativeDirectory);
    if (!fs.existsSync(absoluteDirectory)) return;
    for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (relativePath === path.join('src', 'generated')) continue;
        visit(relativePath);
      } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
        targets.push(relativePath);
      }
    }
  }

  visit('app');
  visit('src');
  for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      targets.push(entry.name);
    }
  }
  return targets.sort();
}

function runValidator(validatorName, filePath, content, projectRoot, approvedJsDependencies, upgradeOnly, localDevelopment, beforePackageJson) {
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
      before_package_json: beforePackageJson,
      ...(upgradeOnly ? { validation_scope: 'upgrade-only' } : {}),
      ...(localDevelopment ? { validation_scope: 'local-development' } : {}),
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
    beforePackageJson: beforePackageJsonArg,
    blocked: invalidSelection,
    errors,
    help,
    projectRoot: projectRootArg,
    targets,
    upgradeOnly,
    localDevelopment,
  } = parseArgs(argv);
  if (help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n\n${usage()}\n`);
    return invalidSelection ? 2 : 1;
  }
  if (
    !projectRootArg
    || (allSource ? targets.length > 0 : targets.length === 0)
    || targets.some((target) => !target)
  ) {
    process.stderr.write(`${usage()}\n`);
    return 1;
  }

  const requestedProjectRoot = path.resolve(projectRootArg);
  if (!fs.existsSync(requestedProjectRoot) || !fs.statSync(requestedProjectRoot).isDirectory()) {
    process.stderr.write(`Project root not found: ${requestedProjectRoot}\n`);
    return 1;
  }
  const projectRoot = fs.realpathSync(requestedProjectRoot);
  const validationTargets = allSource ? collectSourceTargets(projectRoot) : [...targets];
  if (beforePackageJsonArg) validationTargets.push(beforePackageJsonArg);
  const beforePath = beforePackageJsonArg ? path.resolve(projectRoot, beforePackageJsonArg) : null;
  if (beforePath === path.join(projectRoot, 'package.json')) {
    process.stderr.write('BLOCKED: --before-package-json must name a separate pre-install snapshot, not the current package.json.\n');
    return 2;
  }

  const files = new Set();
  let blocked = false;
  let beforePackageJson;

  for (const target of validationTargets) {
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
    if (requestedTargetPath === beforePath) beforePackageJson = fs.readFileSync(targetPath, 'utf8');
    else files.add(targetPath);
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
        upgradeOnly,
        localDevelopment,
        beforePackageJson,
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
  collectSourceTargets,
  isWithinRoot,
  main,
  parseArgs,
  parseApprovedJsDependency,
};