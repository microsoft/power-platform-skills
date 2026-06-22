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
const { readWebsiteYml } = require('./lib/detect-project-context');

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

// Resolve site identity (siteName + websiteRecordId) from the project root.
//
// Resolution order:
//   1. powerpages.config.json (code/SPA sites) — siteName + (optional) websiteRecordId.
//   2. .powerpages-site/website.yml (declarative sites — standard or
//      enhanced data model — which have no powerpages.config.json) — `name` -> siteName,
//      `id` -> websiteRecordId.
//   3. `pac pages list` — ONLY when the GUID is still unknown (e.g. a code site whose
//      config omitted websiteRecordId). Declarative sites already have it from
//      website.yml, so they skip this exec entirely (`usedPacList` reports whether it ran).
//
// Returns `{ siteName, websiteRecordId, source, usedPacList }` on success, or
// `{ error }` when no site identity can be resolved. Dependencies are injectable so
// the resolution (incl. the skip-exec optimization) is unit-testable without PAC CLI.
function resolveSiteIdentity(projectRoot, deps = {}) {
  const _findPath = deps.findPath || findPath;
  const _readWebsiteYml = deps.readWebsiteYml || readWebsiteYml;
  const _execSync = deps.execSync || execSync;
  const _readFileSync = deps.readFileSync || fs.readFileSync;

  let siteName = null;
  let websiteRecordId = null;
  let source = null;

  const configPath = _findPath(projectRoot, 'powerpages.config.json');
  if (configPath) {
    try {
      const config = JSON.parse(_readFileSync(configPath, 'utf8'));
      siteName = config.siteName;
      websiteRecordId = config.websiteRecordId || null;
      source = 'config';
    } catch {
      return { error: 'Failed to parse powerpages.config.json' };
    }
  } else {
    const websiteYmlPath = _findPath(projectRoot, path.join('.powerpages-site', 'website.yml'));
    const site = websiteYmlPath ? _readWebsiteYml(websiteYmlPath) : null;
    if (site) {
      siteName = site.name;
      websiteRecordId = site.id || null;
      source = 'website.yml';
    }
  }

  if (!siteName) {
    return { error: 'Site name not found — looked in powerpages.config.json and .powerpages-site/website.yml' };
  }

  // Only hit `pac pages list` when the GUID isn't already known. Declarative sites (and code
  // sites whose config included websiteRecordId) skip this entirely.
  let usedPacList = false;
  if (!websiteRecordId) {
    usedPacList = true;
    try {
      const pacOutput = _execSync('pac pages list', { encoding: 'utf8', timeout: 15000 });
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
  }

  return { siteName, websiteRecordId, source, usedPacList };
}

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

async function main() {
  // --- Parse --projectRoot argument ---
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--projectRoot');
  const projectRoot = rootIdx !== -1 ? args[rootIdx + 1] : process.cwd();

  // --- Resolve site identity (config -> website.yml -> pac pages list) ---
  const identity = resolveSiteIdentity(projectRoot);
  if (identity.error) {
    output({ error: identity.error });
  }
  const { siteName } = identity;
  let { websiteRecordId } = identity;

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
}

if (require.main === module) {
  main();
}

module.exports = { resolveSiteIdentity, getWebsites };
