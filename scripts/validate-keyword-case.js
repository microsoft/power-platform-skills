#!/usr/bin/env node

/**
 * Validates that every `keywords` and `tags` entry across the marketplace files
 * is in kebab-case. Keywords/tags are the discovery surface for the marketplace,
 * so a consistent kebab-case format keeps search and grouping predictable and
 * avoids near-duplicate variants ("power apps" vs "power-apps").
 *
 * Scope of "marketplace files":
 *   - marketplace.json + the legacy .claude-plugin/marketplace.json mirror
 *     (top-level and per-plugin `keywords`/`tags`, if ever added there)
 *   - every plugin manifest under plugins/<plugin>/.plugin/plugin.json and its
 *     legacy plugins/<plugin>/.claude-plugin/plugin.json mirror, where the
 *     per-plugin `keywords`/`tags` actually live today.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Kebab-case: lowercase alphanumeric segments joined by single hyphens. Rejects
// spaces, uppercase, underscores, dots, and leading/trailing/double hyphens.
// e.g. matches "power-apps", "web-api", "spa"; rejects "power apps", "Power-Apps".
const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The metadata fields that carry marketplace discovery terms and must be kebab-case.
const TERM_FIELDS = ['keywords', 'tags'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function relative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function getPluginManifestPaths() {
  const pluginsDirectory = path.join(ROOT, 'plugins');
  if (!fs.existsSync(pluginsDirectory)) return [];

  const manifestPaths = [];
  for (const entry of fs.readdirSync(pluginsDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const manifestDir of ['.plugin', '.claude-plugin']) {
      const manifestPath = path.join(pluginsDirectory, entry.name, manifestDir, 'plugin.json');
      if (fs.existsSync(manifestPath)) manifestPaths.push(manifestPath);
    }
  }
  return manifestPaths.sort();
}

const errors = [];

// Validate a `keywords`/`tags` array found at `location` within `source`.
function checkTermArray(source, location, value) {
  if (value === undefined) return;

  if (!Array.isArray(value)) {
    errors.push(`${source}: ${location} must be an array`);
    return;
  }

  for (const [index, term] of value.entries()) {
    const where = `${location}[${index}]`;
    if (typeof term !== 'string') {
      errors.push(`${source}: ${where} must be a string`);
      continue;
    }
    if (!KEBAB_CASE_PATTERN.test(term)) {
      errors.push(`${source}: ${where} '${term}' is not kebab-case`);
    }
  }
}

// Check both top-level term fields and any per-plugin entry term fields.
function checkDocument(filePath) {
  const source = relative(filePath);
  const document = readJson(filePath);

  for (const field of TERM_FIELDS) {
    checkTermArray(source, field, document[field]);
  }

  // Marketplace files carry a `plugins[]` index; per-entry terms are optional but
  // still validated if present so future additions can't slip through.
  if (Array.isArray(document.plugins)) {
    for (const [index, plugin] of document.plugins.entries()) {
      if (plugin === null || typeof plugin !== 'object') continue;
      for (const field of TERM_FIELDS) {
        checkTermArray(source, `plugins[${index}].${field}`, plugin[field]);
      }
    }
  }
}

const documentPaths = [
  path.join(ROOT, 'marketplace.json'),
  path.join(ROOT, '.claude-plugin', 'marketplace.json'),
  ...getPluginManifestPaths(),
].filter((filePath) => fs.existsSync(filePath));

for (const filePath of documentPaths) {
  checkDocument(filePath);
}

if (errors.length > 0) {
  console.log('Found keywords/tags that are not in kebab-case:');
  for (const error of errors) {
    console.log(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Validated keywords/tags in ${documentPaths.length} marketplace file(s); all entries are kebab-case.`
);
