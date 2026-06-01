#!/usr/bin/env node

// Checks whether a Power Pages site is already activated (provisioned) in the environment.
// Used by deploy-site and activate-site skills to avoid unnecessary activation prompts
// or redundant activation attempts.
//
// Usage:
//   node check-activation-status.js --projectRoot "<path>"
//
// Output (JSON to stdout):
//   { "activated": true,  "siteName": "...", "websiteRecordId": "...", "websiteUrl": "..." }
//   { "activated": false, "siteName": "...", "websiteRecordId": "..." }
//   { "error": "..." }   — when prerequisites are missing (PAC CLI, Azure CLI, config, etc.)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { findPath, getPacAuthInfo, getAuthToken, makeRequest, CLOUD_TO_API } = require('./lib/validation-helpers');

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// --- Parse --projectRoot argument ---
const args = process.argv.slice(2);
const rootIdx = args.indexOf('--projectRoot');
const projectRoot = rootIdx !== -1 ? args[rootIdx + 1] : process.cwd();

// --- Read siteName from powerpages.config.json ---
const configPath = findPath(projectRoot, 'powerpages.config.json');
if (!configPath) {
  output({ error: 'powerpages.config.json not found' });
}

let siteName;
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  siteName = config.siteName;
} catch {
  output({ error: 'Failed to parse powerpages.config.json' });
}
if (!siteName) {
  output({ error: 'siteName not found in powerpages.config.json' });
}

// --- Get websiteRecordId from pac pages list ---
let websiteRecordId = null;
try {
  const pacOutput = execSync('pac pages list', { encoding: 'utf8', timeout: 15000 });
  // pac pages list outputs a table with columns. Find the row matching siteName.
  // Column headers vary but Website Record ID is always a GUID column.
  const lines = pacOutput.split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines) {
    // Skip header/separator lines
    if (line.includes('----') || line.toLowerCase().includes('website name')) continue;
    // Check if this line contains our site name (case-insensitive)
    if (line.toLowerCase().includes(siteName.toLowerCase())) {
      // Extract GUID from the line
      const guidMatch = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (guidMatch) {
        websiteRecordId = guidMatch[0];
      }
      break;
    }
  }
} catch {
  // pac pages list failed — continue without websiteRecordId
}

// --- Get PAC auth info ---
const pacInfo = getPacAuthInfo();
if (!pacInfo) {
  output({ error: 'PAC CLI not authenticated' });
}

const ppApiBaseUrl = CLOUD_TO_API[pacInfo.cloud] || CLOUD_TO_API['Public'];

// --- Get Azure CLI token ---
const token = getAuthToken(ppApiBaseUrl);
if (!token) {
  output({ error: 'Azure CLI token not available' });
}

// --- Query websites API ---
(async () => {
  const websites = await getWebsites(ppApiBaseUrl, token, pacInfo.environmentId);
  if (websites === null) {
    output({ error: 'Websites API call failed' });
  }

  // --- Match by websiteRecordId or siteName ---
  const match = websites.find((w) => {
    if (websiteRecordId && w.websiteRecordId && w.websiteRecordId.toLowerCase() === websiteRecordId.toLowerCase()) {
      return true;
    }
    if (siteName && w.name && w.name.toLowerCase() === siteName.toLowerCase()) {
      return true;
    }
    return false;
  });

  if (match) {
    output({
      activated: true,
      siteName: match.name || siteName,
      websiteRecordId: match.websiteRecordId || websiteRecordId,
      websiteUrl: match.websiteUrl || null,
    });
  } else {
    output({
      activated: false,
      siteName,
      websiteRecordId,
    });
  }
})();

async function getWebsites(ppApiBaseUrl, token, environmentId) {
  try {
    const result = await makeRequest({
      url: `${ppApiBaseUrl}/powerpages/environments/${environmentId}/websites?api-version=2022-03-01-preview`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 15000,
    });
    if (result.error || result.statusCode !== 200) return null;
    const parsed = JSON.parse(result.body);
    const value = parsed.value;
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  } catch {
    return null;
  }
}
