#!/usr/bin/env node
'use strict';

const { emitTemplateOutcome } = require('./lib/create-site-template-telemetry');
const { formatJsonResult } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --mode template --templateId company-portal --templateKind spa --framework react --audience internal
//   --importOutcome success --activationOutcome success --seedApplied true
// Scratch branch sends:
//   --mode scratch --framework react --audience internal
// Values are fixed catalog/outcome enums; do not pass site name, URL, subdomain,
// user-entered free text, or any other potentially identifying value.
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) args[arg.slice(2)] = argv[++i];
  }
  return args;
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  return emitTemplateOutcome(args);
}

if (require.main === module) {
  process.stdout.write(formatJsonResult(run()));
}

module.exports = { parseArgs, run };
