#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_ROOT = path.resolve(
  __dirname,
  '..',
  'skills',
  'setup-push-service-account',
  'assets',
  'function',
);

function usage() {
  return 'Usage: node scaffold-push-service-account-function.js --project-root <path> --destination <relative-path>';
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--project-root') {
      result.projectRoot = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--destination') {
      result.destination = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--help' || argv[index] === '-h') {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
  }
  return result;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function validateDestinationComponents(output, root) {
  const relative = path.relative(root, output);
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

    // A lexical path below the project can still escape when any existing
    // component is a symlink (for example, project/azure -> ../outside).
    // Reject symlinks outright rather than following them during fs.cpSync.
    if (stat.isSymbolicLink()) {
      throw new Error('Destination must not contain symbolic links.');
    }
    const resolved = fs.realpathSync(current);
    if (!isWithinRoot(resolved, root)) {
      throw new Error('Destination must remain below the project root.');
    }
    if (current !== output && !stat.isDirectory()) {
      throw new Error('Destination parent components must be directories.');
    }
  }
}

function scaffold({ projectRoot, destination }) {
  const requestedRoot = path.resolve(projectRoot);
  if (!fs.existsSync(requestedRoot) || !fs.statSync(requestedRoot).isDirectory()) {
    throw new Error('Project root must be an existing directory.');
  }
  const root = fs.realpathSync(requestedRoot);
  if (!destination || path.isAbsolute(destination)) {
    throw new Error('Destination must be a relative path.');
  }
  const output = path.resolve(root, destination);
  if (!isWithinRoot(output, root) || output === root) {
    throw new Error('Destination must remain below the project root.');
  }
  validateDestinationComponents(output, root);
  if (fs.existsSync(output)) {
    throw new Error('Destination already exists; refusing to overwrite it.');
  }
  fs.cpSync(TEMPLATE_ROOT, output, {
    recursive: true,
    errorOnExist: true,
    force: false,
    // Development installs may leave ignored dependencies beside the bundled
    // template. Never copy that host-specific tree into a user's scaffold.
    filter: (source) => path.basename(source) !== 'node_modules',
  });
  return output;
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (!args.projectRoot || !args.destination) {
      process.stderr.write(`${usage()}\n`);
      return 1;
    }
    const output = scaffold(args);
    process.stdout.write(`Scaffolded push sender Function at ${output}\n`);
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
  isWithinRoot,
  main,
  parseArgs,
  scaffold,
  validateDestinationComponents,
};
