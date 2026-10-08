#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  abandonLocalizationVerificationAudit,
  beginLocalizationVerification,
  extendLocalizationVerification,
  finalizeLocalizationVerification,
  formatManualAvailabilityRestore,
  markLocalizationVerificationFailed,
} = require('./lib/localization-verification-transaction');

const USAGE =
  'Usage: manage-localization-verification.js ' +
  '(--begin --locales <tag[,tag]> [--profile <standard|extensive>] | ' +
  '--extend --profile extensive | --fail | ' +
  '--finalize [--manual-review-completed] [--rendered-review-completed]) ' +
  '--projectRoot <path>';

function parseArgs(argv) {
  const parsed = {};
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (['--begin', '--extend', '--fail', '--finalize'].includes(arg)) {
      if (parsed.operation) throw new Error('Choose exactly one operation.');
      parsed.operation = arg.slice(2);
      continue;
    }
    if (arg === '--manual-review-completed') {
      if (parsed.manualReviewCompleted) {
        throw new Error(
          'Argument "--manual-review-completed" may be specified only once.'
        );
      }
      parsed.manualReviewCompleted = true;
      continue;
    }
    if (arg === '--rendered-review-completed') {
      if (parsed.renderedReviewCompleted) {
        throw new Error(
          'Argument "--rendered-review-completed" may be specified only once.'
        );
      }
      parsed.renderedReviewCompleted = true;
      continue;
    }
    if (!['--projectRoot', '--locales', '--profile'].includes(arg)) {
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
    } else if (arg === '--locales') {
      parsed.locales = value
        .split(',')
        .map((locale) => locale.trim())
        .filter(Boolean);
    } else {
      parsed.profile = value;
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
  if (parsed.operation === 'extend' && parsed.profile !== 'extensive') {
    throw new Error('--extend requires --profile extensive.');
  }
  if (!['begin', 'extend'].includes(parsed.operation) && parsed.profile) {
    throw new Error('--profile is valid only with --begin or --extend.');
  }
  if (parsed.manualReviewCompleted && parsed.operation !== 'finalize') {
    throw new Error(
      '--manual-review-completed is valid only with --finalize.'
    );
  }
  if (parsed.renderedReviewCompleted && parsed.operation !== 'finalize') {
    throw new Error(
      '--rendered-review-completed is valid only with --finalize.'
    );
  }
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let transaction;
  if (args.operation === 'begin') {
    transaction = beginLocalizationVerification(
      args.projectRoot,
      args.locales,
      args.profile || 'extensive'
    );
  } else if (args.operation === 'extend') {
    transaction = extendLocalizationVerification(
      args.projectRoot,
      args.profile
    );
  } else if (args.operation === 'fail') {
    transaction = markLocalizationVerificationFailed(args.projectRoot);
    abandonLocalizationVerificationAudit(args.projectRoot, transaction.runId);
    // The transaction is now failed either way; a manual restore only adds one
    // step before --finalize, so report it without failing this command.
    const manualRestoreMessage = formatManualAvailabilityRestore(transaction);
    if (manualRestoreMessage) {
      process.stderr.write(`${manualRestoreMessage}\n`);
    }
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
    transaction = finalizeLocalizationVerification(args.projectRoot, {
      manualReviewCompleted: args.manualReviewCompleted,
      renderedReviewCompleted: args.renderedReviewCompleted,
    });
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
