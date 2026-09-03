#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  abandonLocalizationVerificationAudit,
  beginLocalizationVerification,
  finalizeLocalizationVerification,
  markLocalizationVerificationFailed,
} = require('./lib/localization-verification-transaction');

const USAGE =
  'Usage: manage-localization-verification.js ' +
  '(--begin --locales <tag[,tag]> | --fail | --finalize) ' +
  '--projectRoot <path>';

function parseArgs(argv) {
  const parsed = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--begin', '--fail', '--finalize'].includes(arg)) {
      if (parsed.operation) throw new Error('Choose exactly one operation.');
      parsed.operation = arg.slice(2);
      continue;
    }
    if (!['--projectRoot', '--locales'].includes(arg)) {
      throw new Error(`Unknown or misplaced argument "${arg}".\n${USAGE}`);
    }
    if (seen.has(arg)) {
      throw new Error(`Argument "${arg}" may be specified only once.\n${USAGE}`);
    }
    seen.add(arg);
    const value = argv[index + 1];
    if (typeof value !== 'string' || !value.trim() ||
        value.startsWith('--')) {
      throw new Error(`Argument "${arg}" requires a value.\n${USAGE}`);
    }
    if (arg === '--projectRoot') {
      parsed.projectRoot = path.resolve(value);
    } else {
      parsed.locales = value
        .split(',')
        .map((locale) => locale.trim())
        .filter(Boolean);
    }
    index += 1;
  }
  if (!parsed.operation || !parsed.projectRoot) {
    throw new Error(USAGE);
  }
  if (parsed.operation === 'begin' && (!parsed.locales || !parsed.locales.length)) {
    throw new Error('--begin requires --locales.');
  }
  if (parsed.operation !== 'begin' && parsed.locales) {
    throw new Error('--locales is valid only with --begin.');
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let transaction;
  if (args.operation === 'begin') {
    transaction = beginLocalizationVerification(args.projectRoot, args.locales);
  } else if (args.operation === 'fail') {
    transaction = markLocalizationVerificationFailed(args.projectRoot);
    abandonLocalizationVerificationAudit(args.projectRoot, transaction.runId);
  } else {
    const {
      validateLocalization,
    } = require('../skills/add-localization/scripts/validate-localization');
    const errors = validateLocalization(args.projectRoot, {
      allowTransactionFinalization: true,
    });
    if (errors.length > 0) {
      throw new Error(
        `Localization must be fully valid before finalization:\n- ` +
        errors.join('\n- ')
      );
    }
    transaction = finalizeLocalizationVerification(args.projectRoot);
  }
  process.stdout.write(`${JSON.stringify(transaction, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
};
