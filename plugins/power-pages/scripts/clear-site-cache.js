#!/usr/bin/env node

// Clears the runtime cache of an activated Power Pages site by restarting it
// via the Power Platform admin API.
//
// Usage:
//   node clear-site-cache.js --projectRoot "<path>"
//
// Output (JSON to stdout):
//   { "success": true, "websiteUrl": "..." }
//   { "success": false, "error": "..." }

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { findPath, getPacAuthInfo, getAuthToken, makeRequest, CLOUD_TO_API } = require('./lib/validation-helpers');

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(obj.success ? 0 : 1);
}

// --- Parse --projectRoot argument ---
const args = process.argv.slice(2);
const rootIdx = args.indexOf('--projectRoot');
const projectRoot = rootIdx !== -1 ? args[rootIdx + 1] : process.cwd();

// --- Read siteName from powerpages.config.json ---
const configPath = findPath(projectRoot, 'powerpages.config.json');
if (!configPath) {
  output({ success: false, error: 'powerpages.config.json not found' });
}

let siteName;
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  siteName = config.siteName;
} catch {
  output({ success: false, error: 'Failed to parse powerpages.config.json' });
}
if (!siteName) {
  output({ success: false, error: 'siteName not found in powerpages.config.json' });
}

// --- Get PAC auth info ---
const pacInfo = getPacAuthInfo();
if (!pacInfo) {
  output({ success: false, error: 'PAC CLI not authenticated' });
}

const ppApiBaseUrl = CLOUD_TO_API[pacInfo.cloud] || CLOUD_TO_API['Public'];

// --- Get Power Platform API token ---
const token = getAuthToken(ppApiBaseUrl);
if (!token) {
  output({ success: false, error: 'Failed to get Azure CLI access token. Ensure you are logged in with: az login' });
}

// --- Find the website and restart it to clear cache ---
(async () => {
  // Get websites for this environment
  const listResult = await makeRequest({
    url: `${ppApiBaseUrl}/powerpages/environments/${pacInfo.environmentId}/websites?api-version=2022-03-01-preview`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 15000,
  });

  if (listResult.error || listResult.statusCode !== 200) {
    output({ success: false, error: `Failed to list websites: ${listResult.error || `HTTP ${listResult.statusCode}`}` });
  }

  let websites;
  try {
    const parsed = JSON.parse(listResult.body);
    websites = Array.isArray(parsed.value) ? parsed.value : [];
  } catch {
    output({ success: false, error: 'Failed to parse websites API response' });
  }

  // Match by websiteRecordId (from pac pages list) or by name
  let websiteRecordId = null;
  try {
    const pacOutput = execSync('pac pages list', { encoding: 'utf8', timeout: 15000 });
    const lines = pacOutput.split(/\r?\n/).filter((l) => l.trim());
    for (const line of lines) {
      if (line.includes('----') || line.toLowerCase().includes('website name')) continue;
      if (line.toLowerCase().includes(siteName.toLowerCase())) {
        const guidMatch = line.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (guidMatch) websiteRecordId = guidMatch[0];
        break;
      }
    }
  } catch {}

  const match = websites.find((w) => {
    if (websiteRecordId && w.websiteRecordId && w.websiteRecordId.toLowerCase() === websiteRecordId.toLowerCase()) return true;
    if (w.name && w.name.toLowerCase() === siteName.toLowerCase()) return true;
    return false;
  });

  if (!match || !match.id) {
    output({ success: false, error: `Website "${siteName}" not found in environment` });
  }

  // Restart the site to clear its runtime cache
  const restartResult = await makeRequest({
    url: `${ppApiBaseUrl}/powerpages/environments/${pacInfo.environmentId}/websites/${match.id}/restart?api-version=2022-03-01-preview`,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 30000,
  });

  if (restartResult.error) {
    output({ success: false, error: `Restart request failed: ${restartResult.error}` });
  }

  if (restartResult.statusCode >= 200 && restartResult.statusCode < 300) {
    output({ success: true, websiteUrl: match.websiteUrl || null });
  } else {
    output({ success: false, error: `Restart returned HTTP ${restartResult.statusCode}: ${restartResult.body}` });
  }
})();
