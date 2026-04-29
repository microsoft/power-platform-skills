#!/usr/bin/env node
/**
 * render-createsite-plan.js — Renders the create-site implementation plan HTML.
 *
 * Usage (inline JSON):
 *   node render-createsite-plan.js --output <path> --data-inline '<json>'
 *
 * Usage (file-based):
 *   node render-createsite-plan.js --output <path> --data <json-file>
 *
 * Required keys in the data:
 *   SITE_NAME, PLAN_TITLE, FRAMEWORK, AESTHETIC, MOOD, SUMMARY,
 *   TYPOGRAPHY_DATA, PALETTE_DATA, MOTION_DATA, BACKGROUNDS_DATA,
 *   PAGES_DATA, COMPONENTS_DATA, ROUTES_DATA, REVIEW_DATA, DEPLOYMENT_DATA
 */

const path = require('path');
const fs = require('fs');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || (!args['data-inline'] && !args.data)) {
  console.error(
    'Usage: node render-createsite-plan.js --output <path> --data-inline \'<json>\'\n' +
    '       node render-createsite-plan.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

const templatePath = path.join(
  __dirname,
  '..',
  'skills',
  'create-site',
  'assets',
  'create-site-plan.html'
);

const requiredKeys = [
  'SITE_NAME',
  'PLAN_TITLE',
  'FRAMEWORK',
  'AESTHETIC',
  'MOOD',
  'SUMMARY',
  'TYPOGRAPHY_DATA',
  'PALETTE_DATA',
  'MOTION_DATA',
  'BACKGROUNDS_DATA',
  'PAGES_DATA',
  'COMPONENTS_DATA',
  'ROUTES_DATA',
  'REVIEW_DATA',
  'DEPLOYMENT_DATA',
];

function withDerivedTemplateData(dataObject) {
  return {
    ...dataObject,
    SUMMARY_DATA: { text: String(dataObject.SUMMARY ?? '') },
  };
}

if (args['data-inline']) {
  let dataObject;
  try {
    dataObject = JSON.parse(args['data-inline']);
  } catch {
    console.error('Error: --data-inline value is not valid JSON');
    process.exit(1);
  }
  renderTemplate({
    templatePath,
    outputPath: path.resolve(args.output),
    dataObject: withDerivedTemplateData(dataObject),
    requiredKeys,
    escapeStringValues: true,
  });
} else {
  const dataPath = path.resolve(args.data);
  if (!fs.existsSync(dataPath)) {
    console.error(`Data file not found: ${dataPath}`);
    process.exit(1);
  }

  let dataObject;
  try {
    dataObject = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  } catch {
    console.error('Error: --data file is not valid JSON');
    process.exit(1);
  }

  renderTemplate({
    templatePath,
    outputPath: path.resolve(args.output),
    dataObject: withDerivedTemplateData(dataObject),
    requiredKeys,
    escapeStringValues: true,
  });
}
