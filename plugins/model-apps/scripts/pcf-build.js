#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { parseArgs, validateFlags } = require('./lib/dataverse-auth.js');
const { loadMatrix } = require('./lib/pcf-matrix.js');
const { findControlProject, buildControl, bundleFindings } = require('./lib/pcf-build.js');

const USAGE = `Usage:
  node scripts/pcf-build.js --project <dir> [--mode production|development] [--no-clean]`;

const KNOWN = ['project', 'mode', 'no-clean'];
const NEED_VALUE = ['project', 'mode'];

function usageError(message) {
  process.stderr.write(`${USAGE}\n${message}\n`);
  process.exit(1);
}

function emitCliResult(ok, payload) {
  if (ok) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(0);
  }
  if (payload instanceof Error) {
    process.stderr.write(`${payload.message}\n`);
  } else if (payload && typeof payload === 'object') {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (typeof payload.error === 'string') process.stderr.write(`${payload.error}\n`);
    else process.stderr.write('Operation failed; see stdout JSON\n');
  } else {
    process.stderr.write(`${String(payload)}\n`);
  }
  process.exit(1);
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const flagError = validateFlags(argv, {
    known: KNOWN,
    needValue: NEED_VALUE,
    hints: { mode: 'one of: production, development' },
  });
  if (flagError) usageError(flagError);

  const { flags } = parsed;
  if (!flags.project) usageError('--project is required');
  const mode = flags.mode ? String(flags.mode) : 'production';
  if (!['production', 'development'].includes(mode)) usageError("--mode must be 'production' or 'development'");

  const found = findControlProject(path.resolve(String(flags.project)));
  if (found.error) {
    emitCliResult(false, { ok: false, error: found.error });
    return;
  }

  const result = buildControl({ projectDir: found.projectDir, mode, clean: !flags['no-clean'] });
  const findings = bundleFindings(result, loadMatrix());
  const ok = Boolean(result.ok) && !findings.some((finding) => finding.severity === 'error');
  emitCliResult(ok, { ok, ...result, findings });
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    emitCliResult(false, err);
  }
}

module.exports = { main };
