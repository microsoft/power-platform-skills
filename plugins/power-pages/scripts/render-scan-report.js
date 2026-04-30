#!/usr/bin/env node
/**
 * render-scan-report.js — Renders a scan report HTML file from a JSON data file.
 *
 * Used by skills that report findings in a uniform Overview/Findings/Details
 * layout (manage-code-scan, manage-site-scan, manage-http-headers, manage-waf).
 *
 * Usage:
 *   node render-scan-report.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   REPORT_TITLE, REPORT_DESC, SITE_NAME, SUMMARY, FINDINGS_DATA, DETAILS_DATA
 *
 * FINDINGS_DATA: array of { id, severity, title, tag?, location?, details?, reasoning?, fix? }
 * DETAILS_DATA:  { label, description?, kind: 'table'|'kv'|'html', ... }   (or empty object to hide)
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || !args.data) {
  console.error('Usage: node render-scan-report.js --output <path> --data <json-file>');
  process.exit(1);
}

renderTemplate({
  templatePath: path.join(__dirname, 'lib', 'templates', 'scan-report.html'),
  outputPath: path.resolve(args.output),
  dataPath: path.resolve(args.data),
  requiredKeys: ['REPORT_TITLE', 'REPORT_DESC', 'SITE_NAME', 'SUMMARY', 'FINDINGS_DATA', 'DETAILS_DATA'],
});
