#!/usr/bin/env node
/**
 * render-edm-migration-plan.js — Renders the EDM-to-SPA migration plan HTML from a JSON data file.
 *
 * Usage:
 *   node render-edm-migration-plan.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   SITE_NAME, PLAN_TITLE, SUMMARY, SITE_STATS, ROUTES_DATA, DATAVERSE_DATA,
 *   SECURITY_DATA, GAPS_DATA, RATIONALE_DATA, DESIGN_DATA
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || !args.data) {
  console.error(
    'Usage: node render-edm-migration-plan.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

const dataPath = path.resolve(args.data);
const data = JSON.parse(require('fs').readFileSync(dataPath, 'utf8'));

renderTemplate({
  templatePath: path.join(
    __dirname,
    '..',
    'skills',
    'migrate-edm-to-spa',
    'assets',
    'edm-migration-plan.html'
  ),
  outputPath: path.resolve(args.output),
  dataObject: data,
  requiredKeys: [
    'SITE_NAME',
    'PLAN_TITLE',
    'SUMMARY',
    'SITE_STATS',
    'ROUTES_DATA',
    'DATAVERSE_DATA',
    'SECURITY_DATA',
    'GAPS_DATA',
    'RATIONALE_DATA',
    'DESIGN_DATA',
  ],
  escapeStringValues: true,
});
