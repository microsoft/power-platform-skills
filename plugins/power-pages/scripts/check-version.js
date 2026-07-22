#!/usr/bin/env node

/**
 * Plugin version check. Compares local plugin.json version against
 * origin/main and prints an update notice if remote is newer.
 * Exits silently if versions match or on any error.
 *
 * Usage:  node check-version.js
 * Functions are also exported for testing.
 */

const { execFileSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const MARKETPLACE_PATHS = [
  'marketplace.json',
  '.plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
];
const PLUGIN_MANIFEST_PATHS = [
  '.plugin/plugin.json',
  '.claude-plugin/plugin.json',
];

/**
 * Compare two semver strings (major.minor.patch).
 * Returns 1 if b > a (remote newer), -1 if a > b (local newer), 0 if equal.
 */
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] || 0) > (pa[i] || 0)) return 1;
    if ((pb[i] || 0) < (pa[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Format the update notification as plain text.
 * Includes marketplace update (first) and plugin update (second).
 */
function formatUpdateMessage(pluginName, localVersion, remoteVersion, marketplaceName) {
  const qualifiedName = marketplaceName ? `${pluginName}@${marketplaceName}` : pluginName;
  let msg = `\nPlugin update available: ${pluginName} ${localVersion} → ${remoteVersion}.\n`;
  if (marketplaceName) {
    msg += `Run:\n  claude plugin marketplace update ${marketplaceName}\n  claude plugin update ${qualifiedName}`;
  } else {
    msg += `Run: claude plugin update ${qualifiedName}`;
  }
  return msg;
}

/**
 * Read the marketplace name from the git root.
 * Returns null if not found.
 */
function readMarketplaceName(gitRoot) {
  const marketplace = readFirstJson(gitRoot, MARKETPLACE_PATHS);
  return marketplace?.name || null;
}

function firstExistingPath(root, relativePaths) {
  for (const relativePath of relativePaths) {
    const filePath = path.join(root, relativePath);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

function readFirstJson(root, relativePaths) {
  const filePath = firstExistingPath(root, relativePaths);
  if (!filePath) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonFromGit(ref, relativePaths) {
  for (const relativePath of relativePaths) {
    try {
      const content = execFileSync('git', ['show', `${ref}:${relativePath}`], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return JSON.parse(content);
    } catch {
      // Try the next manifest path.
    }
  }
  return null;
}

module.exports = { compareSemver, formatUpdateMessage, readMarketplaceName };

if (require.main === module) {
  try {
    const pluginRoot = path.resolve(__dirname, '..');
    const pluginJsonPath = firstExistingPath(pluginRoot, PLUGIN_MANIFEST_PATHS);
    if (!pluginJsonPath) process.exit(0);

    const localPlugin = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
    const localVersion = localPlugin.version;
    if (!localVersion) process.exit(0);

    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const remoteManifestPaths = PLUGIN_MANIFEST_PATHS.map((manifestPath) =>
      path.relative(gitRoot, path.join(pluginRoot, manifestPath)).replace(/\\/g, '/')
    );

    // Best-effort fetch
    try {
      execSync('git fetch origin main --quiet', {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Use cached origin/main
    }

    const remotePlugin = readJsonFromGit('origin/main', remoteManifestPaths);
    if (!remotePlugin) process.exit(0);
    const remoteVersion = remotePlugin.version;
    if (!remoteVersion) process.exit(0);

    if (compareSemver(localVersion, remoteVersion) > 0) {
      const pluginName = localPlugin.name || 'power-pages';
      const marketplaceName = readMarketplaceName(gitRoot);
      console.log(formatUpdateMessage(pluginName, localVersion, remoteVersion, marketplaceName));
    }
  } catch {
    // Silent on error — don't block skill execution
  }
}
