#!/usr/bin/env node
/**
 * render-backend-plan.js — Renders the backend integration plan HTML.
 *
 * Usage (inline JSON):
 *   node render-backend-plan.js --output <path> --data-inline '<json>'
 *
 * Usage (file-based):
 *   node render-backend-plan.js --output <path> --data <json-file>
 *
 * Required keys in the data:
 *   SITE_NAME, PLAN_TITLE, SUMMARY, ITEMS_DATA, RATIONALE_DATA, DATA_FLOWS_DATA
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || (!args['data-inline'] && !args.data)) {
  console.error(
    'Usage: node render-backend-plan.js --output <path> --data-inline \'<json>\'\n' +
    '       node render-backend-plan.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

const templatePath = path.join(
  __dirname,
  '..',
  'skills',
  'integrate-backend',
  'assets',
  'backend-plan.html'
);

const requiredKeys = [
  'SITE_NAME',
  'PLAN_TITLE',
  'SUMMARY',
  'ITEMS_DATA',
  'RATIONALE_DATA',
  'DATA_FLOWS_DATA',
];

if (args['data-inline']) {
  let dataObject;
  try {
    dataObject = JSON.parse(args['data-inline']);
  } catch {
    console.error('Error: --data-inline value is not valid JSON');
    process.exit(1);
  }
  renderTemplate({ templatePath, outputPath: path.resolve(args.output), dataObject, requiredKeys });
} else {
  renderTemplate({ templatePath, outputPath: path.resolve(args.output), dataPath: path.resolve(args.data), requiredKeys });
}
