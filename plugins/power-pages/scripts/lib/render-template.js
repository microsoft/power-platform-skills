/**
 * render-template.js — Shared helper for rendering HTML plan templates.
 *
 * Reads an HTML template, replaces __PLACEHOLDER__ tokens with data values,
 * validates all required placeholders are provided, and writes the output.
 *
 * Used by the template-specific render scripts (render-data-model-plan.js, etc.).
 */

const fs = require('fs');
const path = require('path');

/**
 * @param {Object} options
 * @param {string} options.templatePath - Absolute path to the HTML template
 * @param {string} options.outputPath   - Absolute path for the rendered output
 * @param {string} options.dataPath     - Absolute path to the JSON data file
 * @param {string[]} options.requiredKeys - Keys that must be present in the data file
 */
function renderTemplate({ templatePath, outputPath, dataPath, requiredKeys }) {
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

  // Validate required keys
  const missing = requiredKeys.filter((k) => !(k in data));
  if (missing.length > 0) {
    console.error(`Missing required keys in data file: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Replace all __KEY__ placeholders with corresponding values from the data object
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    const placeholder = `__${key}__`;
    const replacement = typeof value === 'string' ? value : JSON.stringify(value);
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
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[++i];
    }
  }
  return args;
}

module.exports = { renderTemplate, parseArgs };
