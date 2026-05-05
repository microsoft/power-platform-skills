#!/usr/bin/env node
/**
 * render-review.js — Renders the master security-review report HTML from a
 * JSON data file produced by the review-security skill.
 *
 * Usage:
 *   node render-review.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   SITE_NAME, GOAL_LABEL, SCOPE_LABEL, GENERATED_AT, REVIEW_DATA
 *
 * REVIEW_DATA shape (see assets/security-review-report.html):
 *   {
 *     summary: "...",
 *     totals: { critical, warning, info, pass },
 *     topFindings: [...],
 *     sections: [ { id, label, description?, icon?, findings: [...], details?: {...} } ],
 *     nextSteps: [ "..." ],
 *     glossary: [ { term, aka?, definition } ]
 *   }
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('../../../scripts/lib/render-template');

const args = parseArgs(process.argv);
if (!args.output || !args.data) {
  console.error('Usage: node render-review.js --output <path> --data <json-file>');
  process.exit(1);
}

renderTemplate({
  templatePath: path.join(__dirname, '..', 'assets', 'security-review-report.html'),
  outputPath: path.resolve(args.output),
  dataPath: path.resolve(args.data),
  requiredKeys: ['SITE_NAME', 'GOAL_LABEL', 'SCOPE_LABEL', 'GENERATED_AT', 'REVIEW_DATA'],
});
