#!/usr/bin/env node

/**
 * Validates that legacy .claude-plugin manifests mirror the Open Plugins
 * metadata. Existing marketplace subscriptions still resolve the legacy paths
 * during auto-update, so these files must stay in sync. Mirrors are committed
 * files (not links), so this guard must pass whenever marketplace/plugin
 * metadata changes.
 *
 * It also forbids these mirrors from being committed as symlinks. A symlinked
 * manifest is exactly the cross-platform failure mode from issue #201: on
 * Windows clones without core.symlinks (Developer Mode off — the default), git
 * materializes the link as a tiny text file containing the link target (e.g.
 * "../marketplace.json"), and the consumer then runs JSON.parse on that text and
 * fails with `Unexpected token '.'`. Because Linux/CI checkouts DO resolve
 * symlinks, a content-only comparison would pass there and let the regression
 * back in — so the regular-file assertion is what actually guards the fix.
 * See: https://github.com/microsoft/power-platform-skills/issues/201
 *
 * The same symlink hazard applies to the per-directory CLAUDE.md mirrors of
 * AGENTS.md, so those are guarded here too (regular file + identical content).
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

// A committed symlink here is the issue #201 failure mode (see file header), so
// reject any mirror that is not a regular on-disk file. lstat (not stat) so the
// link itself is inspected rather than its target.
// The caller's check() label already names the path, so keep this message generic.
function assertRegularFile(targetPath) {
  const stat = fs.lstatSync(targetPath);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    'must be a committed regular file, not a symlink'
  );
}

function assertJsonMirror(legacyPath, sourcePath) {
  assertRegularFile(legacyPath);
  assert.deepEqual(readJson(legacyPath), readJson(sourcePath));
}

// CLAUDE.md is a byte-for-byte copy of the sibling AGENTS.md (same forbid-symlink
// rule). Compared as raw text, not JSON.
function assertTextMirror(mirrorPath, sourcePath) {
  assertRegularFile(mirrorPath);
  assert.equal(fs.readFileSync(mirrorPath, 'utf8'), fs.readFileSync(sourcePath, 'utf8'));
}

// Guard CLAUDE.md only where it exists (root + some plugins); a directory with no
// CLAUDE.md is intentional (e.g. code-apps, mcp-apps) and must not fail the check.
function checkClaudeMirror(directory) {
  const claudePath = path.join(directory, 'CLAUDE.md');
  const agentsPath = path.join(directory, 'AGENTS.md');
  if (!fs.existsSync(claudePath)) {
    return;
  }
  const label = normalizeRelative(path.relative(ROOT, claudePath)) || 'CLAUDE.md';
  check(label, () => {
    assert.ok(fs.existsSync(agentsPath), `missing sibling AGENTS.md for ${label}`);
    assertTextMirror(claudePath, agentsPath);
  });
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

checkClaudeMirror(ROOT);

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

    checkClaudeMirror(pluginDirectory);
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
