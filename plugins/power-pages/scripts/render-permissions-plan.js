#!/usr/bin/env node
/**
 * render-permissions-plan.js — Renders the permissions plan HTML from a JSON data file.
 *
 * Usage:
 *   node render-permissions-plan.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   SITE_NAME, SUMMARY, ROLES_DATA, PERMISSIONS_DATA, RATIONALE_DATA
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || !args.data) {
  console.error(
    'Usage: node render-permissions-plan.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

renderTemplate({
  templatePath: path.join(__dirname, '..', 'agents', 'assets', 'permissions-plan.html'),
  outputPath: path.resolve(args.output),
  dataPath: path.resolve(args.data),
  requiredKeys: ['SITE_NAME', 'SUMMARY', 'ROLES_DATA', 'PERMISSIONS_DATA', 'RATIONALE_DATA'],
});
