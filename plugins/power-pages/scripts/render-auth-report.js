#!/usr/bin/env node
/**
 * render-auth-report.js — Renders the setup-auth post-execution report HTML
 * from a JSON data file.
 *
 * Usage:
 *   node render-auth-report.js --output <path> --data <json-file>
 *
 * Required keys in the JSON data file:
 *   META_DATA             — { siteName, reportDate, framework, nextStepsHtml }
 *   PROVIDERS_DATA        — array of provider objects (may be empty)
 *   LOCAL_AUTH_DATA       — object or null
 *   OPTIONAL_FEATURES_DATA — object (may be empty)
 *   SITE_SETTINGS_DATA    — array of { name, value } (may be empty)
 *   TABLE_PERMISSIONS_DATA — array of permission objects (may be empty)
 *   FILES_DATA            — array of { path, action, notes } (may be empty)
 */

const path = require('path');
const { renderTemplate, parseArgs } = require('./lib/render-template');

const args = parseArgs(process.argv);

if (!args.output || !args.data) {
  console.error(
    'Usage: node render-auth-report.js --output <path> --data <json-file>'
  );
  process.exit(1);
}

renderTemplate({
  templatePath: path.join(__dirname, '..', 'skills', 'setup-auth', 'assets', 'auth-report.html'),
  outputPath: path.resolve(args.output),
  dataPath: path.resolve(args.data),
  requiredKeys: [
    'META_DATA',
    'PROVIDERS_DATA',
    'LOCAL_AUTH_DATA',
    'OPTIONAL_FEATURES_DATA',
    'SITE_SETTINGS_DATA',
    'TABLE_PERMISSIONS_DATA',
    'FILES_DATA',
  ],
});
