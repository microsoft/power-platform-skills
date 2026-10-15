#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs, validateFlags, emitResult } = require('./lib/dataverse-auth.js');
const { loadMatrix } = require('./lib/pcf-matrix.js');
const { findControlProject, buildControl, bundleFindings } = require('./lib/pcf-build.js');
const { booleanFlagError } = require('./lib/pcf-cli-flags.js');

const USAGE = `Usage:
  node scripts/pcf-build.js --project <dir> [--mode production|development] [--no-clean]`;

const KNOWN = ['project', 'mode', 'no-clean'];
const NEED_VALUE = ['project', 'mode'];

function usageError(message) {
  process.stderr.write(`${USAGE}\n${message}\n`);
  process.exit(1);
}

function emitPcfResult(ok, payload) {
  if (process === global.process) {
    emitResult(ok, payload);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  if (!ok) process.stderr.write(`${payload.error || 'PCF build failed; see stdout JSON'}\n`);
  process.exit(ok ? 0 : 1);
}

function main(argv = process.argv.slice(2)) {
  try {
    return runMain(argv);
  } catch (err) {
    if (err && err.exitCode !== undefined) throw err;
    return emitPcfResult(false, { ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function runMain(argv) {
  const parsed = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: KNOWN,
    needValue: NEED_VALUE,
    hints: { mode: 'one of: production, development' },
  });
  if (flagError) usageError(flagError);

  const { flags } = parsed;
  const booleanError = booleanFlagError(flags, ['no-clean']);
  if (booleanError) usageError(booleanError);
  if (!flags.project) usageError('--project is required');
  const mode = flags.mode ? String(flags.mode) : 'production';
  if (!['production', 'development'].includes(mode)) usageError("--mode must be 'production' or 'development'");

  const found = findControlProject(path.resolve(String(flags.project)));
  if (found.error) {
    emitPcfResult(false, { ok: false, error: found.error });
    return;
  }

  const result = buildControl({ projectDir: found.projectDir, mode, clean: !flags['no-clean'] });
  const findings = bundleFindings(result, loadMatrix());
  const ok = Boolean(result.ok) && !findings.some((finding) => finding.severity === 'error');
  emitPcfResult(ok, { ...result, findings, ok });
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main };
