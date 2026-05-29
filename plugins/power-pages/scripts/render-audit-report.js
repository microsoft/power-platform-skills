#!/usr/bin/env node
/**
 * render-audit-report.js — Renders the permissions audit report HTML from a JSON data file.
 *
 * Usage:
 *   node render-audit-report.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   SITE_NAME, AUDIT_DESC, SUMMARY, FINDINGS_DATA, INVENTORY_DATA
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || !args.data) {
  console.error(
    'Usage: node render-audit-report.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

renderTemplate({
  templatePath: path.join(__dirname, '..', 'skills', 'audit-permissions', 'assets', 'audit-report.html'),
  outputPath: path.resolve(args.output),
  dataPath: path.resolve(args.data),
  requiredKeys: ['SITE_NAME', 'AUDIT_DESC', 'SUMMARY', 'FINDINGS_DATA', 'INVENTORY_DATA'],
});
