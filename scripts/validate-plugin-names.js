#!/usr/bin/env node

/**
 * Validates that plugin names follow the Open Plugins name constraints.
 */

const fs = require('fs');
const path = require('path');
const { isValidPluginName } = require('./install.js');

const ROOT = path.resolve(__dirname, '..');

function validateName(name, source) {
  if (typeof name !== 'string') {
    return `${source}: plugin name must be a string`;
  }

  if (isValidPluginName(name)) {
    return null;
  }
  return `${source}: '${name}' does not follow Open Plugins name constraints`;
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
    .map((entry) => path.join(pluginsDirectory, entry.name, '.plugin', 'plugin.json'))
    .filter((filePath) => fs.existsSync(filePath))
    .sort();
}

const errors = [];

const marketplacePath = path.join(ROOT, 'marketplace.json');
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
  console.log('Found plugin names that do not follow Open Plugins name constraints:');
  for (const error of errors) {
    console.log(`- ${error}`);
  }
  process.exit(1);
}

console.log('All plugin names follow Open Plugins name constraints.');
