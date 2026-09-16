#!/usr/bin/env node
// Print an ASCII preview of the WHOLE App Spec — data-model summary, sitemap tree, views/charts,
// per-form wireframes, page-intents, and the design contract — so the user can review the entire app
// design at once during authoring (design gate #2 / plan mode). Read-only; the same spec the builder
// uses. Migrates a legacy spec on load so pages render by key. See scripts/lib/app-preview.js.
//
// Usage:
//   node scripts/preview-app.js --spec @<app-folder>/app-spec.json
const path = require('node:path');
const { renderAppPreview } = require('./lib/app-preview.js');
const { parseArgs, validateFlags, readJsonArg } = require('./lib/dataverse-auth.js');
const { migrateAppSpec } = require('./lib/app-spec.js');

function main() {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const USAGE = 'Usage: node scripts/preview-app.js --spec @<app-folder>/app-spec.json';
  const flagError = validateFlags(argv, { known: ['spec'], needValue: ['spec'] });
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
  process.stdout.write(renderAppPreview(spec));
}

if (require.main === module) main();
module.exports = { main };
