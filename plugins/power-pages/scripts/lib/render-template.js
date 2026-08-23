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
const crypto = require('crypto');

const PLACEHOLDER_RE = /__(?:(HTML|ATTR|JSON|RAW)_)?([A-Z][A-Z0-9_]*)__/g;

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

  // Context is part of the placeholder because one source value can appear in both
  // HTML and JavaScript. Bare string placeholders default to HTML text encoding;
  // structured values default to JSON. RAW is reserved for code-owned markup.
  const templateData = {
    ...data,
    CSP_NONCE: crypto.randomBytes(16).toString('base64'),
  };
  const result = template.replace(PLACEHOLDER_RE, (placeholder, explicitContext, key) => {
    if (!(key in templateData)) {
      return placeholder;
    }

    const context = explicitContext || (typeof templateData[key] === 'string' ? 'HTML' : 'JSON');
    return renderValue(templateData[key], context);
  });

  // Warn about any unreplaced placeholders (helps catch typos)
  const remaining = result.match(PLACEHOLDER_RE);
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
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

function serializeJson(value) {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError('Template values in JSON contexts must be JSON-serializable');
  }

  // HTML parses script end tags before JavaScript or application/json content.
  // Neutralizing these characters keeps strings such as "</script>" inside JSON.
  return json
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderValue(value, context) {
  switch (context) {
    case 'HTML':
      return escapeHtml(value);
    case 'ATTR':
      return escapeHtmlAttribute(value);
    case 'JSON':
      return serializeJson(value);
    case 'RAW':
      return String(value);
    default:
      throw new TypeError(`Unsupported template placeholder context: ${context}`);
  }
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
  escapeHtmlAttribute,
  serializeJson,
};
