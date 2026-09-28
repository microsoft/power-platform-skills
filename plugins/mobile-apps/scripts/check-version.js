#!/usr/bin/env node
'use strict';

/**
 * Compare the installed plugin version with the public marketplace manifest and
 * return an update notice when a newer version is available.
 *
 * The command-line entry point is intentionally best-effort: update discovery
 * must never block the skill the user actually invoked.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MARKETPLACE_NAME = 'power-platform-skills';
const REMOTE_PLUGIN_MANIFEST_URL =
  'https://raw.githubusercontent.com/microsoft/power-platform-skills/main/plugins/mobile-apps/.plugin/plugin.json';
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

function isTruthyEnv(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

function detectHost(env = process.env) {
  if (isTruthyEnv(env.COPILOT_CLI)) return 'copilot';
  if (isTruthyEnv(env.CLAUDECODE) || isTruthyEnv(env.CLAUDE_CODE_EXECPATH)) return 'claude';
  if (
    isTruthyEnv(env.VSCODE_PID) ||
    isTruthyEnv(env.VSCODE_CWD) ||
    String(env.TERM_PROGRAM || '').toLowerCase() === 'vscode'
  ) {
    return 'vscode';
  }
  return 'ui';
}

function formatUpdateMessage(
  pluginName,
  localVersion,
  remoteVersion,
  marketplaceName,
  host = detectHost()
) {
  let message = `\nPlugin update available: ${pluginName} ${localVersion} -> ${remoteVersion}.\n`;

  if (host === 'vscode') {
    return (
      message +
      `Update ${pluginName} in the Agent Plugins/Extensions view, reload VS Code, and rerun this skill.`
    );
  }

  if (host !== 'copilot' && host !== 'claude') {
    return (
      message +
      `Update ${pluginName} from your host's plugin or extensions UI, restart or reload the host, and rerun this skill.`
    );
  }

  const qualifiedName = marketplaceName ? `${pluginName}@${marketplaceName}` : pluginName;
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

async function fetchRemotePluginManifest({
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
} = {}) {
  if (typeof fetchImpl !== 'function') return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // The response is treated only as data. Use the fixed first-party endpoint
    // shared with /check-updates and consume only its semantic version field.
    const response = await fetchImpl(REMOTE_PLUGIN_MANIFEST_URL, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const manifest = await response.json();
    return manifest && typeof manifest.version === 'string' ? manifest : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkForUpdate({
  pluginRoot = path.resolve(__dirname, '..'),
  env = process.env,
  fetchRemotePlugin = fetchRemotePluginManifest,
  marketplaceName = DEFAULT_MARKETPLACE_NAME,
} = {}) {
  const resolvedPluginRoot = fs.realpathSync(pluginRoot);
  const pluginJsonPath = firstExistingPath(resolvedPluginRoot, PLUGIN_MANIFEST_PATHS);
  if (!pluginJsonPath) return null;

  const localPlugin = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
  if (!localPlugin.version) return null;

  // Marketplace installs contain only the plugin directory, so remote manifest
  // discovery must not depend on a parent Git checkout or an origin/main ref.
  const remotePlugin = await fetchRemotePlugin();
  if (!remotePlugin?.version) return null;
  if (compareSemver(localPlugin.version, remotePlugin.version) <= 0) return null;

  return formatUpdateMessage(
    localPlugin.name || 'mobile-app',
    localPlugin.version,
    remotePlugin.version,
    marketplaceName,
    detectHost(env)
  );
}

module.exports = {
  checkForUpdate,
  compareSemver,
  detectHost,
  fetchRemotePluginManifest,
  formatUpdateMessage,
};

if (require.main === module) {
  checkForUpdate()
    .then((message) => {
      if (message) console.log(message);
    })
    .catch(() => {
      // Version checks must never block skill execution.
    });
}
