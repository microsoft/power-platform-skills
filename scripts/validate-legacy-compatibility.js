#!/usr/bin/env node

/**
 * Validates that the legacy .claude-plugin manifests mirror their Open Plugins
 * counterparts. Existing marketplace subscriptions still resolve the legacy paths
 * during auto-update, so these committed mirror files must stay semantically in
 * sync whenever marketplace/plugin metadata changes.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '..');
const OPEN_MARKETPLACE_PATH = path.join(ROOT, 'marketplace.json');
const LEGACY_MARKETPLACE_PATH = path.join(ROOT, '.claude-plugin', 'marketplace.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeRelative(relativePath) {
  return relativePath.replace(/\\/g, '/').replace(/\/+$/, '');
}

function pluginDirectoryFromOpenEntry(openMarketplace, plugin) {
  const pluginRoot = openMarketplace.metadata?.pluginRoot || '.';
  return path.resolve(ROOT, pluginRoot, plugin.source);
}

function expectedLegacySource(pluginDirectory) {
  return `./${normalizeRelative(path.relative(ROOT, pluginDirectory))}`;
}

function assertJsonMirror(legacyPath, sourcePath) {
  assert.deepEqual(readJson(legacyPath), readJson(sourcePath));
}

function assertMinimalMarketplaceEntry(plugin) {
  // Open Plugins marketplace entries only require `name` and `source`. Optional
  // fields like description/version/license/keywords are override fields, so keep
  // the marketplace as an index and let each plugin's `.plugin/plugin.json` remain
  // the single source of truth for display and update metadata.
  // See: https://open-plugins.com/plugin-builders/marketplace
  assert.deepEqual(Object.keys(plugin).sort(), ['name', 'source']);
  assert.equal(typeof plugin.name, 'string', 'name must be a string');
  assert.notEqual(plugin.name.trim(), '', 'name must not be empty');
  assert.equal(typeof plugin.source, 'string', 'source must be a string');
  assert.match(plugin.source, /^\.\//, 'source must start with ./');
}

function assertMinimalMarketplace(marketplace) {
  // Keep marketplace-level metadata here because it describes the collection, not
  // any individual plugin. Per-plugin optional fields still stay out of `plugins`
  // entries to avoid overriding the corresponding `.plugin/plugin.json` metadata.
  assert.deepEqual(Object.keys(marketplace).sort(), ['metadata', 'name', 'owner', 'plugins']);
  assert.equal(typeof marketplace.name, 'string', 'name must be a string');
  assert.notEqual(marketplace.name.trim(), '', 'name must not be empty');
  assert.equal(typeof marketplace.owner?.name, 'string', 'owner.name must be a string');
  assert.notEqual(marketplace.owner.name.trim(), '', 'owner.name must not be empty');
  assert.equal(typeof marketplace.metadata?.description, 'string', 'metadata.description must be a string');
  assert.notEqual(marketplace.metadata.description.trim(), '', 'metadata.description must not be empty');
  assert.equal(typeof marketplace.metadata?.pluginRoot, 'string', 'metadata.pluginRoot must be a string');
  assert.match(marketplace.metadata.pluginRoot, /^\./, 'metadata.pluginRoot must be relative');
  assert.ok(Array.isArray(marketplace.plugins), 'plugins must be an array');
  assert.ok(marketplace.plugins.length > 0, 'plugins must contain at least one entry');
}

function assertPluginMetadata(pluginName, manifest) {
  // Marketplace plugin entries intentionally omit these optional override fields.
  // Keep them in each plugin manifest instead so `plugin.json` remains the single
  // source of truth for display/update metadata.
  assert.equal(manifest.name, pluginName);
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'version must be semantic');
  assert.equal(typeof manifest.description, 'string', 'description must be a string');
  assert.notEqual(manifest.description.trim(), '', 'description must not be empty');
  assert.equal(typeof manifest.author?.name, 'string', 'author.name must be a string');
  assert.notEqual(manifest.author.name.trim(), '', 'author.name must not be empty');
  assert.equal(typeof manifest.homepage, 'string', 'homepage must be a string');
  assert.notEqual(manifest.homepage.trim(), '', 'homepage must not be empty');
  assert.equal(typeof manifest.repository, 'string', 'repository must be a string');
  assert.notEqual(manifest.repository.trim(), '', 'repository must not be empty');
  assert.equal(typeof manifest.license, 'string', 'license must be a string');
  assert.notEqual(manifest.license.trim(), '', 'license must not be empty');
  assert.ok(Array.isArray(manifest.keywords), 'keywords must be an array');
  assert.ok(manifest.keywords.length > 0, 'keywords must contain at least one entry');
  for (const [index, keyword] of manifest.keywords.entries()) {
    assert.equal(typeof keyword, 'string', `keywords[${index}] must be a string`);
    assert.notEqual(keyword.trim(), '', `keywords[${index}] must not be empty`);
  }
}

const errors = [];

function check(label, fn) {
  try {
    fn();
  } catch (error) {
    errors.push(`${label}: ${error.message}`);
  }
}

check('legacy marketplace manifest', () => {
  assert.ok(fs.existsSync(LEGACY_MARKETPLACE_PATH), 'missing .claude-plugin/marketplace.json');
  assertJsonMirror(LEGACY_MARKETPLACE_PATH, OPEN_MARKETPLACE_PATH);
});

if (errors.length === 0) {
  const openMarketplace = readJson(OPEN_MARKETPLACE_PATH);
  const legacyMarketplace = readJson(LEGACY_MARKETPLACE_PATH);
  const legacyPlugins = new Map((legacyMarketplace.plugins || []).map((plugin) => [plugin.name, plugin]));
  const openPluginNames = new Set();

  check('marketplace name', () => {
    assert.equal(legacyMarketplace.name, openMarketplace.name);
  });

  check('marketplace shape', () => {
    assertMinimalMarketplace(openMarketplace);
    assertMinimalMarketplace(legacyMarketplace);
  });

  for (const plugin of openMarketplace.plugins || []) {
    openPluginNames.add(plugin.name);
    const pluginDirectory = pluginDirectoryFromOpenEntry(openMarketplace, plugin);
    const openManifestPath = path.join(pluginDirectory, '.plugin', 'plugin.json');
    const legacyManifestPath = path.join(pluginDirectory, '.claude-plugin', 'plugin.json');
    const relativeLegacyManifestPath = normalizeRelative(path.relative(ROOT, legacyManifestPath));

    check(`${plugin.name} legacy marketplace entry`, () => {
      const legacyPlugin = legacyPlugins.get(plugin.name);
      assert.ok(legacyPlugin, 'missing from .claude-plugin/marketplace.json');
      assert.equal(legacyPlugin.source, expectedLegacySource(pluginDirectory));
      assertMinimalMarketplaceEntry(plugin);
      assertMinimalMarketplaceEntry(legacyPlugin);
    });

    check(`${plugin.name} plugin manifest`, () => {
      const pluginManifest = readJson(openManifestPath);
      assertPluginMetadata(plugin.name, pluginManifest);
    });

    check(relativeLegacyManifestPath, () => {
      assert.ok(fs.existsSync(legacyManifestPath), 'missing legacy plugin manifest');
      assertJsonMirror(legacyManifestPath, openManifestPath);
    });
  }

  for (const legacyPluginName of legacyPlugins.keys()) {
    check(`${legacyPluginName} legacy marketplace entry`, () => {
      assert.ok(openPluginNames.has(legacyPluginName), 'not present in marketplace.json');
    });
  }
}

if (errors.length > 0) {
  console.log('Found legacy compatibility metadata issues:');
  for (const error of errors) {
    console.log(`- ${error}`);
  }
  process.exit(1);
}

console.log('Legacy .claude-plugin compatibility metadata is in sync.');
