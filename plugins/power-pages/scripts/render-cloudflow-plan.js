#!/usr/bin/env node
/**
 * render-cloudflow-plan.js — Renders the cloud flow plan HTML.
 *
 * Usage (inline JSON — no temp file written to project):
 *   node render-cloudflow-plan.js --output <path> --data-inline '<json>'
 *
 * Usage (file-based, kept for compatibility):
 *   node render-cloudflow-plan.js --output <path> --data <json-file>
 *
 * Required keys in the data:
 *   SITE_NAME, PLAN_TITLE, SUMMARY, WEB_ROLES_DATA, CLOUD_FLOWS_DATA, RATIONALE_DATA
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || (!args['data-inline'] && !args.data)) {
  console.error(
    'Usage: node render-cloudflow-plan.js --output <path> --data-inline \'<json>\'\n' +
    '       node render-cloudflow-plan.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

const templatePath = path.join(
  __dirname,
  '..',
  'skills',
  'add-cloud-flow',
  'assets',
  'cloud-flow-plan.html'
);

const requiredKeys = [
  'SITE_NAME',
  'PLAN_TITLE',
  'SUMMARY',
  'WEB_ROLES_DATA',
  'CLOUD_FLOWS_DATA',
  'RATIONALE_DATA',
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
