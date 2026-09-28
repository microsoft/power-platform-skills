#!/usr/bin/env node

/**
 * Plugin version check. Compares the local plugin manifest version against
 * origin/main and prints an update notice if the remote version is newer.
 * Exits silently if versions match or on any error.
 *
 * Usage: node check-version.js
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

function compareSemver(localVersion, remoteVersion) {
  const localParts = localVersion.split('.').map(Number);
  const remoteParts = remoteVersion.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if ((remoteParts[index] || 0) > (localParts[index] || 0)) return 1;
    if ((remoteParts[index] || 0) < (localParts[index] || 0)) return -1;
  }
  return 0;
}

function detectHost(env = process.env) {
  return env.COPILOT_CLI === '1' ? 'copilot' : 'claude';
}

function formatUpdateMessage(
  pluginName,
  localVersion,
  remoteVersion,
  marketplaceName,
  host = detectHost()
) {
  const qualifiedName = marketplaceName ? `${pluginName}@${marketplaceName}` : pluginName;
  let message = `\nPlugin update available: ${pluginName} ${localVersion} -> ${remoteVersion}.\n`;
  if (marketplaceName) {
    message += `Run:\n  ${host} plugin marketplace update ${marketplaceName}\n  ${host} plugin update ${qualifiedName}`;
  } else {
    message += `Run: ${host} plugin update ${qualifiedName}`;
  }
  return message;
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

function readMarketplaceName(gitRoot) {
  const marketplace = readFirstJson(gitRoot, MARKETPLACE_PATHS);
  return marketplace?.name || null;
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
      // Open Plugins and legacy installs use different manifest paths.
    }
  }
  return null;
}

module.exports = { compareSemver, detectHost, formatUpdateMessage, readMarketplaceName };

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

    try {
      execSync('git fetch origin main --quiet', {
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // A cached origin/main is sufficient when the network is unavailable.
    }

    const remotePlugin = readJsonFromGit('origin/main', remoteManifestPaths);
    if (!remotePlugin?.version) process.exit(0);

    if (compareSemver(localVersion, remotePlugin.version) > 0) {
      const pluginName = localPlugin.name || 'model-apps';
      const marketplaceName = readMarketplaceName(gitRoot);
      console.log(
        formatUpdateMessage(pluginName, localVersion, remotePlugin.version, marketplaceName)
      );
    }
  } catch {
    // Version checks must never block skill execution.
  }
}
