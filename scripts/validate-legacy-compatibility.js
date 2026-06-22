#!/usr/bin/env node

/**
 * Validates that legacy .claude-plugin manifests mirror the Open Plugins
 * metadata. Existing marketplace subscriptions still resolve the legacy paths
 * during auto-update, so these files must stay in sync. Mirrors are committed
 * files (not links), so this guard must pass whenever marketplace/plugin
 * metadata changes.
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
      assert.equal(legacyPlugin.description, plugin.description);
      assert.equal(legacyPlugin.category, 'development');
      assert.deepEqual(legacyPlugin.tags || [], plugin.keywords || []);
    });

    check(`${plugin.name} marketplace version`, () => {
      const pluginManifest = readJson(openManifestPath);
      assert.equal(plugin.version, pluginManifest.version);
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
