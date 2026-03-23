#!/usr/bin/env node

// Clears the runtime cache of an activated Power Pages site.
// Calls DELETE on websiteUrl/_services/cache/config with a Dataverse auth token.
//
// Usage:
//   node clear-site-cache.js --websiteUrl "https://mysite.powerappsportals.com" --envUrl "https://org.crm.dynamics.com"
//
// Output (JSON to stdout):
//   { "success": true, "websiteUrl": "..." }
//   { "success": false, "error": "..." }

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(obj.success ? 0 : 1);
}

// --- Parse arguments ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const websiteUrl = getArg('--websiteUrl');
const envUrl = getArg('--envUrl');

if (!websiteUrl) {
  output({ success: false, error: 'Missing --websiteUrl argument' });
}
if (!envUrl) {
  output({ success: false, error: 'Missing --envUrl argument' });
}

// --- Get Dataverse token scoped to the environment URL ---
const token = getAuthToken(envUrl);
if (!token) {
  output({ success: false, error: 'Failed to get Dataverse access token via Azure CLI. Ensure you are logged in with: az login' });
}

// --- Clear site cache ---
(async () => {
  const requestUrl = `${websiteUrl.replace(/\/+$/, '')}/_services/cache/config`;

  const result = await makeRequest({
    url: requestUrl,
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: '*/*',
      'Content-Type': 'text/plain',
    },
    timeout: 30000,
  });

  if (result.error) {
    output({ success: false, error: `Cache clear request failed: ${result.error}` });
  }

  if (result.statusCode >= 200 && result.statusCode < 300) {
    output({ success: true, websiteUrl });
  } else {
    output({ success: false, error: `Cache clear returned HTTP ${result.statusCode}: ${result.body}` });
  }
})();
