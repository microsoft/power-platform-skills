#!/usr/bin/env node
// Print an ASCII wireframe of the App Spec's form(s) — tabs, sections, fields (with widget
// hints), the Notes/timeline block, and sub-grids — so the user can review a form visually
// during authoring before approving the plan. Read-only; takes the same spec the builder uses.
//
// Usage:
//   node preview-form.js --spec @<app-folder>/app-spec.json [--entity new_workorder]
const path = require('node:path');
const { renderForms } = require('./lib/form-preview.js');
const { parseArgs, readJsonArg } = require('./lib/dataverse-auth.js');

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const specArg = flags.spec || positional[0];
  if (!specArg) {
    process.stderr.write('Usage: node preview-form.js --spec @<app-folder>/app-spec.json [--entity <schemaName>]\n');
    process.exit(1);
  }
  const specPath = path.resolve(typeof specArg === 'string' && specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = readJsonArg('@' + specPath);
  process.stdout.write(renderForms(spec, flags.entity) + '\n');
}

if (require.main === module) {
  main();
}
module.exports = { main };
