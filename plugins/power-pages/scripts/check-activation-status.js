#!/usr/bin/env node

// Checks whether a Power Pages site is already activated (provisioned) in the environment.
//
// Authoritative source for the website record ID is `.powerpages-site/website.yml#id`,
// written by `pac pages upload-code-site` after a successful deploy. When that file is
// present we match the websites API strictly by GUID — never by site name — because in a
// migration scenario the source EDM site and the new SPA target site can share a
// `siteName` (the analyze step preserves the source name through scaffolding), so a
// name-based lookup hits the source's already-activated record and falsely reports the
// new SPA as activated.
//
// Used by deploy-site, activate-site, and migrate-traditional-site-to-spa-implement to avoid
// unnecessary activation prompts or redundant activation attempts.
//
// Usage:
//   node check-activation-status.js --projectRoot "<path>"
//
// Output (JSON to stdout):
//   { "activated": true,  "siteName": "...", "websiteRecordId": "...", "websiteUrl": "..." }
//   { "activated": false, "siteName": "...", "websiteRecordId": "..." }
//   { "error": "..." }   — when prerequisites are missing, the lookup is ambiguous, or
//                          the API call fails

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { findPath, getPacAuthInfo, getAuthToken, makeRequest, CLOUD_TO_API } = require('./lib/validation-helpers');

const GUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Read the website record id from `<projectRoot>/.powerpages-site/website.yml`.
// Returns null when the file or the top-level `id:` line is missing/malformed.
//
// The file is written by `pac pages upload-code-site` as a flat YAML map. Example:
//   id: 39a4d5c5-2db4-4117-a08c-62bdb8cc2af7
//   adx_name: Faq 1
//   adx_websiteurl: ...
//
// We scan line-by-line (no YAML dependency) for the first un-indented `id:` whose value
// is a GUID. Indented `id:` lines under nested blocks are skipped so we don't pick up
// IDs from embedded child records.
function readWebsiteIdFromYaml(projectRoot) {
  const ymlPath = path.join(projectRoot, '.powerpages-site', 'website.yml');
  if (!fs.existsSync(ymlPath)) return null;
  let content;
  try {
    content = fs.readFileSync(ymlPath, 'utf8');
  } catch {
    return null;
  }
  for (const raw of content.split(/\r?\n/)) {
    // Skip indented (nested) lines — only top-level keys are eligible.
    if (raw.startsWith(' ') || raw.startsWith('\t')) continue;
    const match = raw.match(/^id:\s*(.+?)\s*$/);
    if (!match) continue;
    // Strip optional surrounding quotes that some YAML emitters add for GUID values.
    const value = match[1].replace(/^['"]|['"]$/g, '');
    if (GUID_REGEX.test(value)) return value;
  }
  return null;
}

// Scan `pac pages list` output and collect every distinct website-record GUID that appears
// on a line whose text contains `siteName` (case-insensitive substring — `pac pages list`
// pads columns with whitespace so the row can be detected by substring even though the
// site name itself may contain spaces). Used only when `.powerpages-site/website.yml` is
// absent (pre-first-deploy lookup). The returned array's length lets callers detect an
// ambiguous match and refuse to guess.
//
// Example pac output (the columns are whitespace-padded, not tab-delimited):
//   Website Name      Website Record ID                     Website ID
//   ----------------  ------------------------------------  ----------
//   Faq 1             edb7a30a-6d48-f111-bec7-6045bd001091  ...
//   Faq 1             39a4d5c5-2db4-4117-a08c-62bdb8cc2af7  ...
function extractWebsiteIdsByName(pacOutput, siteName) {
  if (!pacOutput || !siteName) return [];
  const needle = siteName.toLowerCase();
  const ids = [];
  const seen = new Set();
  for (const line of pacOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip separator rows (e.g. "----  ----") and the header row.
    if (trimmed.includes('----')) continue;
    if (trimmed.toLowerCase().includes('website name')) continue;
    if (!line.toLowerCase().includes(needle)) continue;
    const guidMatch = line.match(GUID_REGEX);
    if (!guidMatch) continue;
    const lower = guidMatch[0].toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    ids.push(guidMatch[0]);
  }
  return ids;
}

// Match a website from the websites-API response set.
//
// When `websiteRecordId` is provided (read from `.powerpages-site/website.yml` or
// disambiguated from `pac pages list`), match strictly by GUID. Name fallback is
// forbidden here because a migration deployment can leave two records sharing a
// `siteName` in one environment, and the source's already-activated record is the
// wrong target.
//
// When no GUID is known (pre-deploy lookup with a unique-by-name site), allow a strict
// exact-name match. If multiple API records share that name, return
// `{ ambiguous: true, candidates }` so the caller can fail loudly instead of guessing.
function matchWebsite(websites, websiteRecordId, siteName) {
  if (!Array.isArray(websites)) return null;
  if (websiteRecordId) {
    const lower = websiteRecordId.toLowerCase();
    return (
      websites.find((w) => w && w.websiteRecordId && w.websiteRecordId.toLowerCase() === lower) ||
      null
    );
  }
  if (!siteName) return null;
  const lower = siteName.toLowerCase();
  const candidates = websites.filter((w) => w && w.name && w.name.toLowerCase() === lower);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return { ambiguous: true, candidates };
  return candidates[0];
}

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
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

  // --- Resolve websiteRecordId: authoritative YAML id first, pac list as fallback ---
  let websiteRecordId = readWebsiteIdFromYaml(projectRoot);
  if (!websiteRecordId) {
    // No `.powerpages-site/website.yml` (site not yet deployed). Fall back to matching
    // `pac pages list` rows by site name, but refuse to guess when more than one record
    // shares the name — that ambiguity is the exact failure mode that misidentified the
    // source EDM site as the new SPA target in migration runs.
    try {
      const pacOutput = execSync('pac pages list', { encoding: 'utf8', timeout: 15000 });
      const ids = extractWebsiteIdsByName(pacOutput, siteName);
      if (ids.length > 1) {
        output({
          error:
            `Ambiguous site name match: ${ids.length} website records named "${siteName}" exist in this environment. ` +
            `Specify the website record id explicitly (deploy the site first so .powerpages-site/website.yml is written, or rename the site).`,
        });
      }
      if (ids.length === 1) websiteRecordId = ids[0];
    } catch {
      // `pac pages list` failed — continue. The API call below will still attempt an
      // exact-name match and emit `{ ambiguous: ... }` if multiple records share the name.
    }
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
  const websites = await getWebsites(ppApiBaseUrl, token, pacInfo.environmentId);
  if (websites === null) {
    output({ error: 'Websites API call failed' });
  }

  const match = matchWebsite(websites, websiteRecordId, siteName);
  if (match && match.ambiguous) {
    output({
      error:
        `Ambiguous site name match: ${match.candidates.length} websites named "${siteName}" exist in this environment. ` +
        `Specify the website record id explicitly (deploy the site first so .powerpages-site/website.yml is written, or rename the site).`,
    });
  }

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

module.exports = {
  readWebsiteIdFromYaml,
  extractWebsiteIdsByName,
  matchWebsite,
};
