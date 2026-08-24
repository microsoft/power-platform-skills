#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_ROOT = path.resolve(__dirname, '..', 'assets', 'apple-fastlane');
const EXPECTED_FILES = Object.freeze([
  'Gemfile',
  'Gemfile.lock',
  path.join('fastlane', 'Fastfile'),
  path.join('fastlane', 'README.md'),
  path.join('fastlane', 'lib', 'apple_device_input.js'),
  path.join('fastlane', 'lib', 'apple_certificates.rb'),
  path.join('fastlane', 'lib', 'apple_identifier.rb'),
  path.join('fastlane', 'lib', 'apple_profile_directory.js'),
  path.join('fastlane', 'lib', 'apple_profiles.rb'),
  path.join('fastlane', 'lib', 'apple_preflight.rb'),
  path.join('fastlane', 'lib', 'apple_signing_keychain.swift'),
]);

function usage() {
  return [
    'Usage: node scaffold-apple-fastlane.js --project-root <path> [--replace <file> ...]',
    '',
    `Replaceable files: ${EXPECTED_FILES.join(', ')}`,
  ].join('\n');
}

function parseArgs(argv) {
  const result = { replace: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project-root') {
      result.projectRoot = argv[index + 1];
      index += 1;
    } else if (arg === '--replace') {
      result.replace.push(argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function normalizeExpectedFile(file) {
  if (!file || path.isAbsolute(file)) {
    throw new Error('Replacement paths must name an expected relative file.');
  }
  const normalized = path.normalize(file);
  if (!EXPECTED_FILES.includes(normalized)) {
    throw new Error(`Unexpected replacement path: ${file}`);
  }
  return normalized;
}

function assertSafeExistingComponents(root, destination) {
  const relative = path.relative(root, destination);
  let current = root;

  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }

    // Following even an in-project symlink makes the scaffold destination
    // depend on mutable filesystem state and can redirect a later overwrite.
    if (stat.isSymbolicLink()) {
      throw new Error(`Scaffold path must not contain symbolic links: ${relative}`);
    }
    if (!isWithinRoot(fs.realpathSync(current), root)) {
      throw new Error(`Scaffold path resolves outside the project root: ${relative}`);
    }
    if (current !== destination && !stat.isDirectory()) {
      throw new Error(`Scaffold parent must be a directory: ${relative}`);
    }
  }
}

function writeFileNoFollow(destination, content, replace) {
  const constants = fs.constants;
  const noFollow = constants.O_NOFOLLOW || 0;
  const flags = replace
    ? constants.O_WRONLY | constants.O_TRUNC | noFollow
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow;
  const descriptor = fs.openSync(destination, flags, 0o644);
  try {
    fs.writeFileSync(descriptor, content);
  } finally {
    fs.closeSync(descriptor);
  }
}

function scaffold({ projectRoot, replace = [] }) {
  if (!projectRoot) throw new Error('Project root is required.');
  const requestedRoot = path.resolve(projectRoot);
  if (!fs.existsSync(requestedRoot)) {
    throw new Error('Project root must be an existing directory.');
  }
  const requestedRootStat = fs.lstatSync(requestedRoot);
  if (requestedRootStat.isSymbolicLink() || !requestedRootStat.isDirectory()) {
    throw new Error('Project root must be a real directory, not a symbolic link.');
  }
  const root = fs.realpathSync(requestedRoot);
  const replaceSet = new Set(replace.map(normalizeExpectedFile));
  const plan = [];
  const conflicts = [];

  // Validate the complete plan before writing anything. A non-selected custom
  // file therefore cannot leave the project with a partially applied scaffold.
  for (const relative of EXPECTED_FILES) {
    const source = path.join(TEMPLATE_ROOT, relative);
    const destination = path.resolve(root, relative);
    if (!isWithinRoot(destination, root) || destination === root) {
      throw new Error(`Scaffold path escapes the project root: ${relative}`);
    }
    assertSafeExistingComponents(root, destination);

    const templateContent = fs.readFileSync(source);
    if (!fs.existsSync(destination)) {
      plan.push({ action: 'create', destination, relative, templateContent });
      continue;
    }
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Expected scaffold destination must be a regular file: ${relative}`);
    }
    if (fs.readFileSync(destination).equals(templateContent)) {
      plan.push({ action: 'reuse', destination, relative, templateContent });
    } else if (replaceSet.has(relative)) {
      plan.push({ action: 'replace', destination, relative, templateContent });
    } else {
      conflicts.push(relative);
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Customized scaffold files require explicit --replace selection: ${conflicts.join(', ')}`,
    );
  }

  for (const entry of plan) {
    if (entry.action === 'reuse') continue;
    fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
    assertSafeExistingComponents(root, entry.destination);
    writeFileNoFollow(entry.destination, entry.templateContent, entry.action === 'replace');
  }

  return {
    created: plan.filter((entry) => entry.action === 'create').map((entry) => entry.relative),
    replaced: plan.filter((entry) => entry.action === 'replace').map((entry) => entry.relative),
    reused: plan.filter((entry) => entry.action === 'reuse').map((entry) => entry.relative),
  };
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (!args.projectRoot || args.replace.some((file) => !file)) {
      process.stderr.write(`${usage()}\n`);
      return 1;
    }
    const result = scaffold(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Scaffold failed: ${error.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  EXPECTED_FILES,
  assertSafeExistingComponents,
  isWithinRoot,
  main,
  normalizeExpectedFile,
  parseArgs,
  scaffold,
};
