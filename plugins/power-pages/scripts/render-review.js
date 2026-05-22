#!/usr/bin/env node
/**
 * render-review.js — Renders a security-review HTML report (consolidated or single-section)
 * from a JSON data file produced by build-review-data.js.
 *
 * Used by the security-review skill (multi-section) and by scan-site for its
 * standalone report (single-section). Same template, same UX.
 *
 * Usage:
 *   node render-review.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   REPORT_NAME, SITE_NAME, GOAL_LABEL, SCOPE_LABEL, GENERATED_AT, REVIEW_DATA
 *
 * REVIEW_DATA shape (see lib/templates/security-review-report.html):
 *   {
 *     summary: "...",
 *     totals: { critical, warning, info, pass },
 *     sections: [ { id, label, description?, icon?, findings: [...], details?: {...} } ],
 *     nextSteps: [ "..." ]
 *   }
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);
if (!args.output || !args.data) {
  console.error('Usage: node render-review.js --output <path> --data <json-file>');
  process.exit(1);
}

renderTemplate({
  templatePath: path.join(__dirname, 'lib', 'templates', 'security-review-report.html'),
  outputPath: path.resolve(args.output),
  dataPath: path.resolve(args.data),
  requiredKeys: ['REPORT_NAME', 'SITE_NAME', 'GOAL_LABEL', 'SCOPE_LABEL', 'GENERATED_AT', 'REVIEW_DATA'],
});
