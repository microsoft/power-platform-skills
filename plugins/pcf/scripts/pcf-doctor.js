#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnResultSync } = require('./lib/process-runner.js');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const { loadMatrix } = require('./lib/pcf-matrix.js');
const { runNpm } = require('./lib/node-tool.js');
const { runPac } = require('./lib/pac-exec.js');
const {
  checkToolchain,
  checkProject,
  collectProject,
  collectToolchain,
  hasErrors,
} = require('./lib/pcf-doctor.js');

const USAGE = `Usage:
  node scripts/pcf-doctor.js [--project <dir>] [--hosts model,pages] [--needs build,push] [--npm-cli <path>]`;

const KNOWN = ['project', 'hosts', 'needs', 'npm-cli'];
const NEED_VALUE = ['project', 'hosts', 'needs', 'npm-cli'];
const KNOWN_HOSTS = ['model', 'pages'];
const KNOWN_NEEDS = ['build', 'push'];

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
      needs: 'comma-separated values: build,push',
      'npm-cli': 'path to npm-cli.js',
    },
  });
  if (flagError) usageError(flagError);

  const flags = parsed.flags;
  const matrix = loadMatrix();
  const hosts = splitList(flags.hosts, ['model']);
  const needs = splitList(flags.needs, ['build']);
  validateSelection('hosts', hosts, KNOWN_HOSTS, flags.hosts !== undefined);
  validateSelection('needs', needs, KNOWN_NEEDS, flags.needs !== undefined);
  const probes = collectToolchain({ npmCli: flags['npm-cli'] ? String(flags['npm-cli']) : undefined }, { runNpm, runPac, spawnResultSync });
  const toolchain = checkToolchain(probes, matrix, { needs });
  const project = [];

  if (flags.project) {
    const projectDir = path.resolve(String(flags.project));
    const state = collectProject(projectDir);
    project.push(...checkProject(state, matrix, { hosts, needs }));
  }

  function validateSelection(name, values, allowed, explicit) {
    if (explicit && values.length === 0) usageError(`--${name} must include at least one value (${allowed.join(',')})`);
    const unknown = values.find((value) => !allowed.includes(value));
    if (unknown) usageError(`--${name} contains unknown value '${unknown}' (expected ${allowed.join(',')})`);
  }

  const payload = {
    ok: !hasErrors(toolchain) && !hasErrors(project),
    toolchain,
    project,
  };
  return emitResult(payload.ok, payload);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    emitResult(false, err);
  }
}

module.exports = { main };
