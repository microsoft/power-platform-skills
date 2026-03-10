#!/usr/bin/env node
/**
 * render-plan.js — Mechanically replaces __PLACEHOLDER__ tokens in an HTML
 * template with data from a JSON file, then writes the result.
 *
 * Usage:
 *   node render-plan.js --template <path> --output <path> --data <json-file>
 *
 * The JSON data file should be an object whose keys match template placeholders
 * (without the surrounding __). String values are inserted as-is; objects and
 * arrays are JSON.stringify'd first.
 *
 * Example data file:
 *   {
 *     "SITE_NAME": "IdeaSphere",
 *     "SUMMARY": "A 3-table data model for ...",
 *     "PREFIX": "cr123",
 *     "TABLES_DATA": [{ ... }],
 *     "RATIONALE_DATA": [{ ... }],
 *     "ER_DIAGRAM": "erDiagram\n    ..."
 *   }
 *
 * The script creates the output directory if it doesn't exist.
 * Outputs JSON on success: { "status": "ok", "output": "<absolute-path>" }
 * Exits with code 1 on error.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args.template || !args.output || !args.data) {
  console.error(
    'Usage: node render-plan.js --template <path> --output <path> --data <json-file>'
  );
  process.exit(1);
}

const templatePath = path.resolve(args.template);
const outputPath = path.resolve(args.output);
const dataPath = path.resolve(args.data);

// Validate inputs exist
if (!fs.existsSync(templatePath)) {
  console.error(`Template not found: ${templatePath}`);
  process.exit(1);
}
if (!fs.existsSync(dataPath)) {
  console.error(`Data file not found: ${dataPath}`);
  process.exit(1);
}

// Read template and data
const template = fs.readFileSync(templatePath, 'utf8');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Replace all __KEY__ placeholders with corresponding values from the data object
let result = template;
for (const [key, value] of Object.entries(data)) {
  const placeholder = `__${key}__`;
  const replacement = typeof value === 'string' ? value : JSON.stringify(value);
  // Replace all occurrences (some placeholders like __SITE_NAME__ appear multiple times)
  result = result.split(placeholder).join(replacement);
}

// Warn about any unreplaced placeholders (helps catch typos)
const remaining = result.match(/__[A-Z][A-Z0-9_]+__/g);
if (remaining) {
  const unique = [...new Set(remaining)];
  console.error(`Warning: unreplaced placeholders: ${unique.join(', ')}`);
}

// Ensure output directory exists
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(outputPath, result, 'utf8');
console.log(JSON.stringify({ status: 'ok', output: outputPath }));
