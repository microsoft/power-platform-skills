#!/usr/bin/env node
'use strict';

/**
 * Safety guard for legacy callers.
 *
 * Dataverse exposes FormulaDefinition in metadata, but Microsoft does not
 * support defining calculated, rollup, or formula expressions through code.
 * Legacy calculated columns require internal workflow XAML that has no public
 * authoring contract. Formula columns use a different serialized definition,
 * but that definition must also be created through the Power Apps editor.
 *
 * This helper therefore fails before authentication or mutation. Callers must
 * use a supported runtime read path, or require the formula column to be
 * created in Power Apps and then validate/reuse it as an existing dependency.
 */

const DOCUMENTATION_URL =
  'https://learn.microsoft.com/power-apps/developer/data-platform/specialized-columns';

function parseArgs(argv) {
  const args = { environmentUrl: argv[2] || null };
  for (let index = 3; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) continue;
    const value = argv[index + 1];
    args[flag.slice(2)] = value && !value.startsWith('--') ? value : true;
    if (args[flag.slice(2)] !== true) index += 1;
  }
  return args;
}

function blockedResult(args) {
  return {
    status: 'BLOCKED',
    code: 'UNSUPPORTED_FORMULA_DEFINITION_API',
    table: args.table || null,
    column: args.column || null,
    error:
      'Dataverse does not support defining calculated, rollup, or formula expressions through code. '
      + 'Create the computed column in the Power Apps editor, then rerun reconciliation to validate '
      + 'and reuse it, or use a supported formatted-lookup/chained-fetch runtime read path.',
    documentation: DOCUMENTATION_URL,
  };
}

function main() {
  const result = blockedResult(parseArgs(process.argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 2;
}

if (require.main === module) main();

module.exports = {
  DOCUMENTATION_URL,
  blockedResult,
  parseArgs,
};
