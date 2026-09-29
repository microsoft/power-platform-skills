#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const { runUpgrade } = require('./lib/pcf-upgrade.js');

const USAGE = `Usage:
  node scripts/pcf-upgrade.js [--project <dir>] [--hosts model,pages] [--apply] [--steps <id,...>] [--allow-dirty] [--no-install] [--npm-cli <path>]`;

const KNOWN = ['project', 'hosts', 'apply', 'steps', 'allow-dirty', 'no-install', 'npm-cli'];
const NEED_VALUE = ['project', 'hosts', 'steps', 'npm-cli'];

function usageError(message) {
  process.stderr.write(`${USAGE}\n${message}\n`);
  process.exit(1);
}

function splitList(value, fallback) {
  if (!value) return fallback;
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function main(argv = process.argv.slice(2)) {
  try {
    return runMain(argv);
  } catch (err) {
    if (err && err.exitCode !== undefined) throw err;
    return emitResult(false, err);
  }
}

function runMain(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: KNOWN,
    needValue: NEED_VALUE,
    hints: {
      hosts: 'comma-separated values: model,pages',
      'npm-cli': 'path to npm-cli.js',
    },
  });
  if (flagError) usageError(flagError);

  const flags = parsed.flags;
  for (const booleanFlag of ['apply', 'allow-dirty', 'no-install']) {
    if (flags[booleanFlag] !== undefined && flags[booleanFlag] !== true) usageError(`--${booleanFlag} does not take a value`);
  }
  const result = runUpgrade({
    project: flags.project ? path.resolve(String(flags.project)) : process.cwd(),
    hosts: splitList(flags.hosts, ['model']),
    apply: Boolean(flags.apply),
    steps: splitList(flags.steps, []),
    allowDirty: Boolean(flags['allow-dirty']),
    noInstall: Boolean(flags['no-install']),
    npmCli: flags['npm-cli'] ? String(flags['npm-cli']) : undefined,
  });
  return emitResult(result.ok, result);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    emitResult(false, err);
  }
}

module.exports = { main };
