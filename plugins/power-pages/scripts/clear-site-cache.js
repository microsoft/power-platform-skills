#!/usr/bin/env node

// Clears the runtime cache of an activated Power Pages site by restarting it
// via the Power Platform admin API. Power Pages caches site settings, table
// permissions, and webpage records for 2–5 minutes; metadata-writing skills
// (/integrate-webapi, /create-webroles, /setup-auth, /audit-permissions,
// /add-server-logic) call this script as the last step of their work so the
// next request sees the new state.
//
// Authoritative source for the target website record id is
// `.powerpages-site/website.yml#id` — see the header doc on
// check-activation-status.js for the rationale. When the migrated SPA shares a
// siteName with the source EDM site (common — analyze preserves the source
// name), a name-based lookup would resolve to the source's already-activated
// record and restart the wrong site. The retrospective named this as defect #6.
//
// Usage:
//   node clear-site-cache.js --projectRoot "<path>" [--websiteRecordId "<guid>"]
//
// Output (JSON to stdout):
//   { "success": true,  "websiteUrl": "...", "websiteRecordId": "..." }
//   { "success": false, "error": "..." }

const fs = require('fs');
const { execSync } = require('child_process');
const {
  findPath,
  getPacAuthInfo,
  getAuthToken,
  makeRequest,
  CLOUD_TO_API,
} = require('./lib/validation-helpers');
const {
  readWebsiteIdFromYaml,
  extractWebsiteIdsByName,
  matchWebsite,
} = require('./check-activation-status');

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(obj.success ? 0 : 1);
}

// --- Parse args ---
const argv = process.argv.slice(2);
let projectRoot = process.cwd();
let cliWebsiteRecordId = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--projectRoot') projectRoot = argv[++i];
  else if (argv[i] === '--websiteRecordId') cliWebsiteRecordId = argv[++i];
}

// --- Read siteName from powerpages.config.json (used as the name-fallback signal) ---
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

// --- Resolve the authoritative websiteRecordId ---
// Precedence: explicit CLI flag → .powerpages-site/website.yml#id → pac pages list
// fallback (only when name is unique). Same pattern as check-activation-status.js.
let websiteRecordId = cliWebsiteRecordId || readWebsiteIdFromYaml(projectRoot);

if (!websiteRecordId) {
  // Fallback: scan `pac pages list`. Refuse to guess on ambiguous matches because
  // the source-vs-target name collision is the exact failure mode this resolution
  // chain exists to prevent.
  try {
    const pacOutput = execSync('pac pages list', { encoding: 'utf8', timeout: 15000 });
    const ids = extractWebsiteIdsByName(pacOutput, siteName);
    if (ids.length > 1) {
      output({
        success: false,
        error:
          `Ambiguous site name match: ${ids.length} website records named "${siteName}" exist. ` +
          `Pass --websiteRecordId explicitly, or deploy the site first so .powerpages-site/website.yml is written.`,
      });
    }
    if (ids.length === 1) websiteRecordId = ids[0];
  } catch {
    // pac pages list failed — leave websiteRecordId null. The websites API match
    // below will attempt a strict name match and emit the ambiguity error if
    // multiple records share the name.
  }
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
  output({
    success: false,
    error: 'Failed to get Azure CLI access token. Ensure you are logged in with: az login --allow-no-subscriptions',
  });
}

// --- Find the website and restart it to clear cache ---
(async () => {
  // List every website in the environment so the GUID/name match below can be
  // performed deterministically.
  const listResult = await makeRequest({
    url: `${ppApiBaseUrl}/powerpages/environments/${pacInfo.environmentId}/websites?api-version=2022-03-01-preview`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 15000,
  });

  if (listResult.error || listResult.statusCode !== 200) {
    output({
      success: false,
      error: `Failed to list websites: ${listResult.error || `HTTP ${listResult.statusCode}`}`,
    });
  }

  let websites;
  try {
    const parsed = JSON.parse(listResult.body);
    websites = Array.isArray(parsed.value) ? parsed.value : [];
  } catch {
    output({ success: false, error: 'Failed to parse websites API response' });
  }

  // When a GUID is in hand, match strictly by GUID — never fall back to name.
  // When no GUID is known, allow exact-name match but emit `ambiguous` when
  // multiple records share the name (shared lib enforces this).
  const match = matchWebsite(websites, websiteRecordId, siteName);
  if (match && match.ambiguous) {
    output({
      success: false,
      error:
        `Ambiguous site name match: ${match.candidates.length} websites named "${siteName}" exist. ` +
        `Pass --websiteRecordId explicitly, or deploy the site first so .powerpages-site/website.yml is written.`,
    });
  }

  if (!match || !match.id) {
    output({ success: false, error: `Website "${siteName}" not found in environment` });
  }

  // Restart the site to clear its runtime cache.
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
    output({
      success: true,
      websiteUrl: match.websiteUrl || null,
      websiteRecordId: match.websiteRecordId || websiteRecordId,
    });
  } else {
    output({
      success: false,
      error: `Restart returned HTTP ${restartResult.statusCode}: ${restartResult.body}`,
    });
  }
})();
