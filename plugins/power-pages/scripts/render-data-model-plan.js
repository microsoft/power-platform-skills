#!/usr/bin/env node
/**
 * render-data-model-plan.js — Renders the data model plan HTML from a JSON data file.
 *
 * Usage:
 *   node render-data-model-plan.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   SITE_NAME, SUMMARY, PREFIX, TABLES_DATA, RATIONALE_DATA, ER_DIAGRAM
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || !args.data) {
  console.error(
    'Usage: node render-data-model-plan.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

renderTemplate({
  templatePath: path.join(__dirname, '..', 'agents', 'assets', 'data-model-plan.html'),
  outputPath: path.resolve(args.output),
  dataPath: path.resolve(args.data),
  requiredKeys: ['SITE_NAME', 'SUMMARY', 'PREFIX', 'TABLES_DATA', 'RATIONALE_DATA', 'ER_DIAGRAM'],
});
