#!/usr/bin/env node

// Shared utilities for Power Pages validation hook scripts.
// Provides common boilerplate so each validator only contains its unique logic.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Exit 0 = success (allow). Exit 2 = blocking error (stderr is fed back to Claude).
const approve = () => { process.exit(0); };
const block = (reason) => {
  process.stderr.write(reason);
  process.exit(2);
};

/**
 * Wraps stdin JSON parsing and try/catch boilerplate.
 * Calls `callback(cwd)` with the parsed working directory.
 * Approves automatically if cwd is missing or on any uncaught error.
 */
function runValidation(callback) {
  let inputData = '';
  process.stdin.on('data', chunk => (inputData += chunk));
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(inputData);
      const cwd = input.cwd;
      if (!cwd) approve();
      callback(cwd);
    } catch {
      approve();
    }
  });
}

/**
 * Searches for a file or directory in `dir` and one level of subdirectories.
 * @param {string} dir - Starting directory
 * @param {string} target - Relative path to look for (e.g. 'powerpages.config.json')
 * @returns {string|null} Full path if found, null otherwise
 */
function findPath(dir, target) {
  const direct = path.join(dir, target);
  if (fs.existsSync(direct)) return direct;

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        const sub = path.join(dir, entry.name, target);
        if (fs.existsSync(sub)) return sub;
      }
    }
  } catch {}

  return null;
}

/**
 * Finds the project root directory (containing powerpages.config.json).
 * @returns {string|null} Project root path, or null
 */
function findProjectRoot(dir) {
  const configPath = findPath(dir, 'powerpages.config.json');
  return configPath ? path.dirname(configPath) : null;
}

/**
 * Finds a subdirectory inside .powerpages-site/.
 * @param {string} dir - Starting directory
 * @param {string} subdir - Subdirectory name (e.g. 'site-settings', 'web-roles')
 * @returns {string|null} Full path to the subdirectory, or null
 */
function findPowerPagesSiteDir(dir, subdir) {
  return findPath(dir, path.join('.powerpages-site', subdir));
}

/** UUID v4 validation regex */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Gets an Azure CLI access token for the given resource URL.
 * @returns {string|null} Access token, or null if unavailable
 */
function getAuthToken(resourceUrl) {
  try {
    return execSync(
      `az account get-access-token --resource "${resourceUrl}" --query accessToken -o tsv`,
      { encoding: 'utf8', timeout: 15000 }
    ).trim();
  } catch {
    return null;
  }
}

/**
 * Gets the environment URL from `pac env who`.
 * @returns {string|null} Environment URL, or null
 */
function getEnvironmentUrl() {
  try {
    const output = execSync('pac env who', { encoding: 'utf8', timeout: 15000 });
    const match = output.match(/Environment URL:\s*(https:\/\/[^\s]+)/i);
    return match ? match[1].replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/**
 * Gets PAC CLI auth info (environment ID and cloud).
 * @returns {{ environmentId: string, cloud: string }|null}
 */
function getPacAuthInfo() {
  try {
    const output = execSync('pac auth who', { encoding: 'utf8', timeout: 15000 });
    const envMatch = output.match(/Environment ID:\s*([0-9a-fA-F-]+)/i);
    const cloudMatch = output.match(/Cloud:\s*(\S+)/i);
    if (!envMatch) return null;
    return {
      environmentId: envMatch[1],
      cloud: cloudMatch ? cloudMatch[1] : 'Public',
    };
  } catch {
    return null;
  }
}

/** Cloud → Power Platform API base URL mapping */
const CLOUD_TO_API = {
  'Public': 'https://api.powerplatform.com',
  'UsGov': 'https://api.gov.powerplatform.microsoft.us',
  'UsGovHigh': 'https://api.high.powerplatform.microsoft.us',
  'UsGovDod': 'https://api.appsplatform.us',
  'China': 'https://api.powerplatform.partner.microsoftonline.cn',
};

module.exports = {
  approve,
  block,
  runValidation,
  findPath,
  findProjectRoot,
  findPowerPagesSiteDir,
  UUID_REGEX,
  getAuthToken,
  getEnvironmentUrl,
  getPacAuthInfo,
  CLOUD_TO_API,
};
