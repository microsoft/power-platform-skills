#!/usr/bin/env node
// Print an ASCII wireframe of the App Spec's form(s) — tabs, sections, fields (with widget
// hints), the Notes/timeline block, and sub-grids — so the user can review a form visually
// during authoring before approving the plan. Read-only; takes the same spec the builder uses.
//
// Usage:
//   node scripts/preview-form.js --spec @<app-folder>/app-spec.json [--entity new_workorder]
const path = require('node:path');
const { renderForms } = require('./lib/form-preview.js');
const { parseArgs, validateFlags, readJsonArg } = require('./lib/dataverse-auth.js');
const { migrateAppSpec, validateAppSpec } = require('./lib/app-spec.js');

function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const USAGE = 'Usage: node scripts/preview-form.js --spec @<app-folder>/app-spec.json [--entity <schemaName>]';
  const flagError = validateFlags(argv, { known: ['spec', 'entity'], needValue: ['spec', 'entity'] });
  if (flagError) {
    process.stderr.write(`✗ ${flagError}\n${USAGE}\n`);
    process.exit(1);
  }
  const specArg = flags.spec || positional[0];
  if (!specArg) {
    process.stderr.write(USAGE + '\n');
    process.exit(1);
  }
  const specPath = path.resolve(specArg.startsWith('@') ? specArg.slice(1) : specArg);
  const spec = migrateAppSpec(readJsonArg('@' + specPath));
  const validation = validateAppSpec(spec, { profile: 'structural' });
  if (!validation.ok) {
    // Validate before rendering because the wireframe renderer intentionally assumes the App Spec
    // contract (for example forms[].entity); a clear validation error is better than a TypeError.
    process.stderr.write(`Invalid App Spec:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    process.exit(1);
  }
  const entity = flags.entity;
  process.stdout.write(renderForms(spec, entity) + '\n');
}

if (require.main === module) {
  main();
}
module.exports = { main };
