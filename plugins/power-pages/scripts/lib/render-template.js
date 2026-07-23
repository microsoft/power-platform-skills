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
 * @param {boolean} [options.escapeNestedHtmlValues=false] - Encode nested strings that templates later pass to innerHTML
 */
function renderTemplate({
  templatePath,
  outputPath,
  dataPath,
  dataObject,
  requiredKeys,
  escapeNestedHtmlValues = false,
}) {
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

  // A placeholder can appear in HTML text and inline JavaScript in the same
  // template. Replace script occurrences with JSON literals and HTML occurrences
  // with entity-encoded text rather than applying one encoding to both contexts.
  let result = template;
  for (const [key, value] of Object.entries(data)) {
    result = replacePlaceholderByContext(
      result,
      `__${key}__`,
      value,
      { escapeNestedHtmlValues },
    );
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
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeNestedHtml(value) {
  if (typeof value === 'string') {
    // Nested values are later interpolated into innerHTML by legacy report
    // templates. Escaping tag and attribute delimiters here makes those values
    // text without changing ordinary ampersands.
    return value
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  if (Array.isArray(value)) {
    return value.map(escapeNestedHtml);
  }
  if (value && typeof value === 'object') {
    const escaped = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      escaped[key] = escapeNestedHtml(nestedValue);
    }
    return escaped;
  }
  return value;
}

function serializeForInlineScript(value, { escapeNestedHtmlValues = false } = {}) {
  const serializable = (
    escapeNestedHtmlValues &&
    value !== null &&
    typeof value === 'object'
  )
    ? escapeNestedHtml(value)
    : value;
  const serialized = JSON.stringify(serializable);
  return (serialized === undefined ? 'null' : serialized)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function replacePlaceholderByContext(template, placeholder, value, options) {
  const scriptReplacement = serializeForInlineScript(value, options);
  const scriptPattern = /<script\b[^>]*>[\s\S]*?<\/script>/gi;

  const withScriptsReplaced = template.replace(scriptPattern, (scriptBlock) => {
    let replaced = scriptBlock;
    // Existing templates wrap some string placeholders in JavaScript quotes or
    // template literals. Replace the delimiters too so JSON supplies the only
    // string quoting and escaping.
    for (const quote of ['"', "'", '`']) {
      replaced = replaced.split(`${quote}${placeholder}${quote}`).join(scriptReplacement);
    }
    return replaced.split(placeholder).join(scriptReplacement);
  });

  const htmlValue = typeof value === 'string'
    ? value
    : JSON.stringify(value);
  return withScriptsReplaced
    .split(placeholder)
    .join(escapeHtml(htmlValue === undefined ? '' : htmlValue));
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

module.exports = {
  renderTemplate,
  parseArgs,
  escapeHtml,
  escapeNestedHtml,
  serializeForInlineScript,
};
