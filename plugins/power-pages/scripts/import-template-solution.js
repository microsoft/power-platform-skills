#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { commandError, runPac } = require('./lib/pac-command');
const { validateZipContainsSolution } = require('./lib/template-catalog');
const { validateDataverseEnvironmentUrl } = require('./lib/validation-helpers');

const MAX_ASYNC_WAIT_MINUTES = 40;
const PROCESS_TIMEOUT_MS = 45 * 60 * 1000;

function parseArgs(argv) {
  const args = { publishChanges: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--zipPath') args.zipPath = argv[++i];
    else if (argv[i] === '--envUrl') args.envUrl = argv[++i];
    else if (argv[i] === '--publishChanges') {
      const value = argv[++i];
      if (value === 'true') args.publishChanges = true;
      else if (value === 'false') args.publishChanges = false;
      else args.publishChanges = null;
    } else {
      args.unknown = argv[i];
    }
  }
  return args;
}

function validateZip(zipPath, fsImpl = fs) {
  const resolved = path.resolve(zipPath || '');
  if (!zipPath || !fsImpl.existsSync(resolved)) return null;
  const stat = fsImpl.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return null;
  return validateZipContainsSolution(resolved, { fs: fsImpl }) ? resolved : null;
}

function importTemplateSolution(options = {}, deps = {}) {
  try {
    if (typeof options.publishChanges !== 'boolean') {
      throw new Error('publishChanges must be true or false');
    }
    const zipPath = validateZip(options.zipPath, deps.fs || fs);
    if (!zipPath) throw new Error('zipPath must be a valid solution zip');
    const envUrl = validateDataverseEnvironmentUrl(options.envUrl);
    // `--publish-changes` is intentionally manifest-controlled: most template
    // solutions import without it, while solutions that ship forms or views
    // can request publication as part of the same PAC operation.
    // See: https://learn.microsoft.com/power-platform/developer/cli/reference/solution#pac-solution-import
    const args = [
      'solution', 'import',
      '--environment', envUrl,
      '--path', zipPath,
      '--force-overwrite',
      '--activate-plugins',
      '--async',
      '--max-async-wait-time', String(MAX_ASYNC_WAIT_MINUTES),
    ];
    if (options.publishChanges) args.push('--publish-changes');
    const pac = deps.runPac || ((pacArgs) => runPac(pacArgs, {
      ...deps,
      timeoutMs: PROCESS_TIMEOUT_MS,
    }));
    const result = pac(args);
    if (result.status !== 0) {
      return {
        ok: false,
        phase: 'import',
        publishChanges: options.publishChanges,
        error: commandError('pac solution import', result),
      };
    }
    return {
      ok: true,
      imported: true,
      publishChanges: options.publishChanges,
    };
  } catch (error) {
    return {
      ok: false,
      phase: 'validation',
      publishChanges: options.publishChanges === true,
      error: error.message,
    };
  }
}

function run(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.unknown || !args.zipPath || !args.envUrl || args.publishChanges === null) {
    return {
      ok: false,
      phase: 'validation',
      error: 'Usage: import-template-solution.js --zipPath <solution.zip> --envUrl <environment-url> [--publishChanges <true|false>]',
    };
  }
  return importTemplateSolution(args, deps);
}

if (require.main === module) {
  const result = run();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

module.exports = {
  MAX_ASYNC_WAIT_MINUTES,
  PROCESS_TIMEOUT_MS,
  importTemplateSolution,
  parseArgs,
  run,
  validateZip,
};
