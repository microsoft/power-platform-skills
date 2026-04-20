#!/usr/bin/env node
/**
 * render-serverlogic-plan.js — Renders the server logic plan HTML from a JSON data file.
 *
 * Usage:
 *   node render-serverlogic-plan.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   SITE_NAME, PLAN_TITLE, SUMMARY, WEB_ROLES_DATA, SERVER_LOGICS_DATA, RATIONALE_DATA
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || !args.data) {
  console.error(
    'Usage: node render-serverlogic-plan.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

const dataPath = path.resolve(args.data);
const data = JSON.parse(require('fs').readFileSync(dataPath, 'utf8'));

// Default SECRETS_DATA to null when not provided (no secrets needed)
if (!('SECRETS_DATA' in data)) {
  data.SECRETS_DATA = null;
}

renderTemplate({
  templatePath: path.join(
    __dirname,
    '..',
    'skills',
    'add-server-logic',
    'assets',
    'serverlogic-plan.html'
  ),
  outputPath: path.resolve(args.output),
  dataObject: data,
  requiredKeys: [
    'SITE_NAME',
    'PLAN_TITLE',
    'SUMMARY',
    'WEB_ROLES_DATA',
    'SERVER_LOGICS_DATA',
    'RATIONALE_DATA',
  ],
});
