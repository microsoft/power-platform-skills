#!/usr/bin/env node

/**
 * Validates that plugin names use kebab-case in all plugin metadata files.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateName(name, source) {
  if (KEBAB_CASE_PATTERN.test(name)) return null;
  return `${source}: '${name}' is not kebab-case`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getPluginManifestPaths() {
  const pluginsDirectory = path.join(ROOT, 'plugins');
  if (!fs.existsSync(pluginsDirectory)) return [];

  return fs
    .readdirSync(pluginsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginsDirectory, entry.name, '.claude-plugin', 'plugin.json'))
    .filter((filePath) => fs.existsSync(filePath))
    .sort();
}

const errors = [];

const marketplacePath = path.join(ROOT, '.claude-plugin', 'marketplace.json');
const marketplace = readJson(marketplacePath);
for (const [index, plugin] of (marketplace.plugins || []).entries()) {
  const error = validateName(
    plugin.name,
    `${path.relative(ROOT, marketplacePath)} plugins[${index}].name`
  );
  if (error) errors.push(error);
}

for (const pluginManifestPath of getPluginManifestPaths()) {
  const pluginManifest = readJson(pluginManifestPath);
  const error = validateName(
    pluginManifest.name,
    `${path.relative(ROOT, pluginManifestPath)} name`
  );
  if (error) errors.push(error);
}

if (errors.length > 0) {
  console.log('Found plugin names that are not kebab-case:');
  for (const error of errors) {
    console.log(`- ${error}`);
  }
  process.exit(1);
}

console.log('All plugin names are kebab-case.');
