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
 * @param {boolean} [options.escapeStringValues=false] - Escape string values for HTML text contexts
 */
function renderTemplate({ templatePath, outputPath, dataPath, dataObject, requiredKeys, escapeStringValues = false }) {
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

  // Replace all __KEY__ placeholders with corresponding values from the data object.
  // For non-string values (arrays/objects serialized to JSON), escape `<` as `\u003c`
  // so a literal `</script>` inside string data cannot close a containing <script> tag.
  // Templates that place string placeholders in HTML text contexts can opt in to
  // string escaping with escapeStringValues.
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    const placeholder = `__${key}__`;
    const replacement = typeof value === 'string'
      ? (escapeStringValues ? escapeHtml(value) : value)
      : JSON.stringify(value).replace(/</g, '\\u003c');
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

  // Silently copy the shared Power Pages icon next to the rendered HTML so the
  // template's <img src="./power-pages-icon.png"> reference resolves when the
  // file is opened directly (or served from docs/). Copy is best-effort —
  // rendering still succeeds if the icon is missing.
  const iconSrc = path.join(__dirname, '..', '..', 'skills', 'create-site', 'assets', 'shared', 'power-pages-icon.png');
  const iconDest = path.join(outputDir, 'power-pages-icon.png');
  try {
    if (fs.existsSync(iconSrc)) {
      fs.copyFileSync(iconSrc, iconDest);
    }
  } catch {
    // non-fatal
  }

  console.log(JSON.stringify({ status: 'ok', output: outputPath }));
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
