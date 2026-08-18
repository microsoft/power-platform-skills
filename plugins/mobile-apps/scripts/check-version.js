#!/usr/bin/env node

/**
 * Compares the installed mobile-app plugin version with the published main
 * manifest and prints update commands only when a newer release exists. This
 * check is fail-open so network access never blocks app work.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_MANIFEST_PATHS = ['.plugin/plugin.json', '.claude-plugin/plugin.json'];
const MARKETPLACE_NAME = 'power-platform-skills';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REMOTE_MANIFEST_URL =
  'https://raw.githubusercontent.com/microsoft/power-platform-skills/main/plugins/mobile-apps/.plugin/plugin.json';

function compareSemver(localVersion, remoteVersion) {
  const localParts = localVersion.split('.').map(Number);
  const remoteParts = remoteVersion.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((remoteParts[index] || 0) > (localParts[index] || 0)) return 1;
    if ((remoteParts[index] || 0) < (localParts[index] || 0)) return -1;
  }
  return 0;
}

function formatUpdateMessage(pluginName, localVersion, remoteVersion, marketplaceName) {
  const qualifiedName = marketplaceName ? `${pluginName}@${marketplaceName}` : pluginName;
  let message = `Plugin update available: ${pluginName} ${localVersion} -> ${remoteVersion}.\n`;
  if (marketplaceName) {
    message +=
      `GitHub Copilot CLI:\n` +
      `  copilot plugin marketplace update ${marketplaceName}\n` +
      `  copilot plugin update ${qualifiedName}\n` +
      `Claude Code:\n` +
      `  claude plugin marketplace update ${marketplaceName}\n` +
      `  claude plugin update ${qualifiedName}`;
  } else {
    message +=
      `GitHub Copilot CLI: copilot plugin update ${qualifiedName}\n` +
      `Claude Code: claude plugin update ${qualifiedName}`;
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

async function fetchRemotePlugin(fetchImpl = fetch) {
  const response = await fetchImpl(REMOTE_MANIFEST_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Remote manifest request failed with HTTP ${response.status}`);
  }
  return response.json();
}

function resolveCachePath(env = process.env, homeDirectory = os.homedir()) {
  const cacheRoot = env.XDG_CACHE_HOME || env.LOCALAPPDATA || path.join(homeDirectory, '.cache');
  return path.join(cacheRoot, 'power-platform-skills', 'mobile-app-version-check.json');
}

function readCache(cachePath) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
}

function isFresh(cache, now = Date.now()) {
  return Boolean(
    Number.isFinite(cache?.checkedAt) &&
      now - cache.checkedAt >= 0 &&
      now - cache.checkedAt < CACHE_TTL_MS
  );
}

function writeCache(cachePath, remoteVersion, now = Date.now()) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(
      cachePath,
      `${JSON.stringify({ checkedAt: now, remoteVersion: remoteVersion || null })}\n`,
      'utf8'
    );
  } catch {
    // Read-only homes must not turn an advisory check into a skill failure.
  }
}

async function getRemoteVersion({
  cachePath = resolveCachePath(),
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const cache = readCache(cachePath);
  if (isFresh(cache, now)) return cache.remoteVersion;

  try {
    const remotePlugin = await fetchRemotePlugin(fetchImpl);
    if (!remotePlugin?.version) return cache?.remoteVersion || null;
    writeCache(cachePath, remotePlugin.version, now);
    return remotePlugin.version;
  } catch {
    // Cache failed attempts too, otherwise every skill invocation would wait on an offline network.
    writeCache(cachePath, cache?.remoteVersion || null, now);
    return cache?.remoteVersion || null;
  }
}

if (require.main === module) {
  void (async () => {
    try {
      const pluginRoot = path.resolve(__dirname, '..');
      const pluginJsonPath = firstExistingPath(pluginRoot, PLUGIN_MANIFEST_PATHS);
      if (!pluginJsonPath) return;

      const localPlugin = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
      if (!localPlugin.version) return;

      const remoteVersion = await getRemoteVersion();
      if (!remoteVersion) return;

      if (compareSemver(localPlugin.version, remoteVersion) > 0) {
        console.log(
          formatUpdateMessage(
            localPlugin.name || 'mobile-app',
            localPlugin.version,
            remoteVersion,
            MARKETPLACE_NAME
          )
        );
      }
    } catch {
      // Plugin update discovery is advisory and must never block template checks.
    }
  })();
}

module.exports = {
  CACHE_TTL_MS,
  REMOTE_MANIFEST_URL,
  compareSemver,
  fetchRemotePlugin,
  formatUpdateMessage,
  getRemoteVersion,
  isFresh,
  resolveCachePath,
};