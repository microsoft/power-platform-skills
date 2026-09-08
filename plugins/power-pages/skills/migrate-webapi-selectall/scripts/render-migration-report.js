#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { renderTemplate, parseArgs } = require('../../../scripts/lib/render-template');

const HELP = `
Renders the Web API wildcard migration report from a data file.

Usage:
  node render-migration-report.js --output <path> --data <json-file>

Options:
  --output   HTML report to write; must not already exist
  --data     JSON data file describing the migration
  --help     Show this help message

Required keys in the data file:
  REPORT_STATUS, SCOPE_NOTE, WILDCARD_DATA, EXPLICIT_DATA

WILDCARD_DATA and EXPLICIT_DATA are arrays of:
  { setting, status, usages: [{ location, detail }], fields, finding, fix }

Exit codes:
  0  Report written
  1  Missing flag, unreadable data file, missing key, or existing output

Example:
  node render-migration-report.js --output docs/webapi-selectall-migration/migration-report.html --data docs/webapi-selectall-migration/migration-report.json
`;

// UTC keeps the stamp unambiguous across reader regions.
// dateStyle and timeStyle cannot combine with timeZoneName.
function formatGeneratedAt(now) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
    timeZoneName: 'short',
  }).format(now);
}

function main() {
  if (process.argv.includes('--help')) {
    process.stdout.write(HELP);
    return;
  }

  const args = parseArgs(process.argv);
  if (!args.output || !args.data) {
    process.stderr.write('Usage: node render-migration-report.js --output <path> --data <json-file>\n');
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.resolve(args.data), 'utf8'));
  } catch (error) {
    process.stderr.write(`Could not read data file ${args.data}: ${error.message}\n`);
    process.exit(1);
  }

  renderTemplate({
    templatePath: path.join(__dirname, '..', 'assets', 'migration-report-template.html'),
    outputPath: path.resolve(args.output),
    // Renderer owns the stamp reflecting render time.
    dataObject: { ...data, GENERATED_AT: formatGeneratedAt(new Date()) },
    requiredKeys: ['REPORT_STATUS', 'SCOPE_NOTE', 'WILDCARD_DATA', 'EXPLICIT_DATA'],
  });
}

main();
