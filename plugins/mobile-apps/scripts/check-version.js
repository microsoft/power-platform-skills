#!/usr/bin/env node
'use strict';

/**
 * Compare the installed plugin version with origin/main and return an update
 * notice when the marketplace contains a newer version.
 *
 * The command-line entry point is intentionally best-effort: update discovery
 * must never block the skill the user actually invoked.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

function runGit(gitRoot, args, timeout) {
  return execFileSync('git', ['-C', gitRoot, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function readJsonFromGit(gitRoot, ref, relativePaths) {
  for (const relativePath of relativePaths) {
    try {
      return JSON.parse(runGit(gitRoot, ['show', `${ref}:${relativePath}`], 5000));
    } catch {
      // Open Plugins and legacy installs use different manifest paths.
    }
  }
  return null;
}

function checkForUpdate({
  pluginRoot = path.resolve(__dirname, '..'),
  env = process.env,
} = {}) {
  // Git canonicalizes symlinked paths (for example macOS /var -> /private/var).
  // Resolve the filesystem path before reading the installed manifest.
  const resolvedPluginRoot = fs.realpathSync(pluginRoot);
  const pluginJsonPath = firstExistingPath(resolvedPluginRoot, PLUGIN_MANIFEST_PATHS);
  if (!pluginJsonPath) return null;

  const localPlugin = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  if (!localPlugin.version) return null;

  // Skills run from the user's app directory, so resolve Git from the installed
  // plugin instead of accidentally inspecting the user's unrelated repository.
  const gitRoot = runGit(resolvedPluginRoot, ['rev-parse', '--show-toplevel'], 5000).trim();
  // Ask Git for the repository-relative prefix instead of comparing absolute
  // paths whose drive-letter casing or separators can differ on Windows.
  const pluginPrefix = runGit(resolvedPluginRoot, ['rev-parse', '--show-prefix'], 5000)
    .trim()
    .replace(/\\/g, '/');
  const remoteManifestPaths = PLUGIN_MANIFEST_PATHS.map((manifestPath) =>
    path.posix.join(pluginPrefix, manifestPath)
  );

  try {
    runGit(gitRoot, ['fetch', 'origin', 'main', '--quiet'], 10000);
  } catch {
    // Offline use can still compare against a previously fetched origin/main.
  }

  const remotePlugin = readJsonFromGit(gitRoot, 'origin/main', remoteManifestPaths);
  if (!remotePlugin?.version) return null;
  if (compareSemver(localPlugin.version, remotePlugin.version) <= 0) return null;

  return formatUpdateMessage(
    localPlugin.name || 'mobile-app',
    localPlugin.version,
    remotePlugin.version,
    readMarketplaceName(gitRoot),
    detectHost(env)
  );
}

module.exports = {
  checkForUpdate,
  compareSemver,
  detectHost,
  formatUpdateMessage,
  readMarketplaceName,
};

if (require.main === module) {
  try {
    const message = checkForUpdate();
    if (message) console.log(message);
  } catch {
    // Version checks must never block skill execution.
  }
}
