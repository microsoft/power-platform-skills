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
 * @param {string} options.templatePath  - Absolute path to the HTML template
 * @param {string} options.outputPath    - Absolute path for the rendered output
 * @param {string} [options.dataPath]    - Absolute path to a JSON data file. Ignored if dataObject is provided.
 * @param {Object} [options.dataObject]  - Data object passed directly. If provided, takes precedence over dataPath.
 * @param {string[]} options.requiredKeys - Keys that must be present in the data
 */
function renderTemplate({ templatePath, outputPath, dataPath, dataObject, requiredKeys }) {
  // Validate inputs exist
  if (!fs.existsSync(templatePath)) {
    console.error(`Template not found: ${templatePath}`);
    process.exit(1);
  }
  if (!dataObject && !dataPath) {
    console.error('Either dataPath or dataObject must be provided');
    process.exit(1);
  }
  if (dataPath && !fs.existsSync(dataPath)) {
    console.error(`Data file not found: ${dataPath}`);
    process.exit(1);
  }

  // Read template and data
  const template = fs.readFileSync(templatePath, 'utf8');
  const data = dataObject ?? JSON.parse(fs.readFileSync(dataPath, 'utf8'));

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

  // Never overwrite an existing file — the caller must choose a unique name
  if (fs.existsSync(outputPath)) {
    console.error(
      `Error: Output file already exists: ${outputPath}\n` +
      'Choose a different filename to avoid overwriting the previous plan.'
    );
    process.exit(1);
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
