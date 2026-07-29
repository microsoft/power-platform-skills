#!/usr/bin/env node
'use strict';

const { emitTemplateOutcome } = require('./lib/create-site-template-telemetry');
const { formatJsonResult } = require('./lib/template-cli-args');

// Accepted argv shape:
//   --eventName template_used --templateId company-portal --templateKind spa --framework react --audience internal
//   --eventName template_import_success --templateId company-portal --templateKind spa --framework react --audience internal --seedApplied true
//   --eventName template_import_failure --templateId company-portal --templateKind spa --framework react --audience internal --outcome failure --errorClass ImportSolutionAsync --errorDescription failed
// Scratch branch sends:
//   --eventName create_site_from_scratch --framework react --audience internal
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
