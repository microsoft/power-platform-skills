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
const fs = require('fs');
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

function safeDocumentationUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function sanitizeBackendData(data) {
  const items = Array.isArray(data.ITEMS_DATA)
    ? data.ITEMS_DATA.map((item) => ({
      ...item,
      docs: Array.isArray(item.docs)
        ? item.docs
          .map((doc) => ({ ...doc, url: safeDocumentationUrl(doc.url) }))
          .filter((doc) => doc.url)
        : item.docs,
    }))
    : data.ITEMS_DATA;
  return { ...data, ITEMS_DATA: items };
}

let dataObject;
const dataPath = args.data ? path.resolve(args.data) : null;
if (!args['data-inline'] && !fs.existsSync(dataPath)) {
  console.error(`Data file not found: ${dataPath}`);
  process.exit(1);
}
try {
  dataObject = args['data-inline']
    ? JSON.parse(args['data-inline'])
    : JSON.parse(fs.readFileSync(dataPath, 'utf8'));
} catch {
  console.error(`Error: ${args['data-inline'] ? '--data-inline value' : '--data file'} is not valid JSON`);
  process.exit(1);
}

renderTemplate({
  templatePath,
  outputPath: path.resolve(args.output),
  dataObject: sanitizeBackendData(dataObject),
  requiredKeys,
  escapeNestedHtmlValues: true,
});
