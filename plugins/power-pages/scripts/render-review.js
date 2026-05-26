#!/usr/bin/env node
/**
 * render-review.js — Renders a security-review HTML report (consolidated or single-section)
 * from a JSON data file produced by build-review-data.js.
 *
 * Used by security-review (multi-section) and by scan-site for its standalone
 * report (single-section). Same template, same UX.
 *
 * Usage:
 *   node render-review.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   REPORT_NAME, SITE_NAME, GOAL_LABEL, SCOPE_LABEL, GENERATED_AT, REVIEW_DATA
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const TEMPLATE_PATH = path.join(__dirname, 'lib', 'templates', 'security-review-report.html');
const REQUIRED_KEYS = [
  'REPORT_NAME',
  'SITE_NAME',
  'GOAL_LABEL',
  'SCOPE_LABEL',
  'GENERATED_AT',
  'REVIEW_DATA',
];

function main() {
  const args = parseArgs(process.argv);
  if (!args.output || !args.data) {
    process.stderr.write('Usage: node render-review.js --output <path> --data <json-file>\n');
    process.exit(1);
  }

  renderTemplate({
    templatePath: TEMPLATE_PATH,
    outputPath: path.resolve(args.output),
    dataPath: path.resolve(args.data),
    requiredKeys: REQUIRED_KEYS,
  });
}

if (require.main === module) {
  main();
}
