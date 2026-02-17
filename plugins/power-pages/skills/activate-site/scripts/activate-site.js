#!/usr/bin/env node

// Activates (provisions) a Power Pages site via the Power Platform websites API.
// Handles the POST request, polls the Operation-Location header for status, and
// refreshes the Azure CLI token during long polling cycles.
//
// Usage:
//   node activate-site.js --siteName "My Site" --subdomain "my-site" --organizationId "<guid>" --environmentId "<guid>" --cloud "Public" [--websiteRecordId "<guid>"]
//
// Output (JSON to stdout):
//   { "status": "Succeeded", "siteUrl": "https://...", "siteName": "...", "subdomain": "..." }
//   { "status": "Failed", "statusCode": 400, "errorCode": "SubdomainConflict", "error": "..." }
//   { "status": "Running", "message": "Provisioning still in progress after 5 minutes" }
//   { "error": "..." }   — when prerequisites are missing or unexpected errors occur

const { getAuthToken, makeRequest, CLOUD_TO_API, CLOUD_TO_SITE_DOMAIN } = require('../../../scripts/lib/validation-helpers');

// --- Helpers ---

function output(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const args = {};
  const keys = ['--siteName', '--subdomain', '--organizationId', '--environmentId', '--cloud', '--websiteRecordId'];
  for (const key of keys) {
    const idx = argv.indexOf(key);
    if (idx !== -1 && idx + 1 < argv.length) {
      args[key.replace('--', '')] = argv[idx + 1];
    }
  }
  return args;
}

// --- Parse arguments ---

const args = parseArgs(process.argv.slice(2));

if (!args.siteName) output({ error: 'Missing required argument: --siteName' });
if (!args.subdomain) output({ error: 'Missing required argument: --subdomain' });
if (!args.organizationId) output({ error: 'Missing required argument: --organizationId' });
if (!args.environmentId) output({ error: 'Missing required argument: --environmentId' });

const cloud = args.cloud || 'Public';
const ppApiBaseUrl = CLOUD_TO_API[cloud] || CLOUD_TO_API['Public'];
const siteDomain = CLOUD_TO_SITE_DOMAIN[cloud] || CLOUD_TO_SITE_DOMAIN['Public'];
const siteUrl = `https://${args.subdomain}.${siteDomain}`;

// --- Acquire token ---

let token = getAuthToken(ppApiBaseUrl);
if (!token) {
  output({ error: 'Azure CLI token not available. Run "az login" first.' });
}

// --- Build request body ---

const body = {
  name: args.siteName,
  subdomain: args.subdomain,
  templateName: 'DefaultPortalTemplate',
  dataverseOrganizationId: args.organizationId,
  selectedBaseLanguage: 1033,
};
if (args.websiteRecordId) {
  body.websiteRecordId = args.websiteRecordId;
}

// --- POST to websites API and poll for completion ---

const apiUrl = `${ppApiBaseUrl}/powerpages/environments/${args.environmentId}/websites?api-version=2022-03-01-preview`;

(async () => {
  const postResult = await makeRequest({
    method: 'POST',
    url: apiUrl,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    includeHeaders: true,
    timeout: 30000,
  });

  if (postResult.error) {
    output({ error: `POST request failed: ${postResult.error}` });
  }

  const statusCode = postResult.statusCode;

  // --- Handle non-202 responses ---

  if (statusCode !== 202) {
    let errorCode = null;
    let errorMessage = postResult.body || 'Unknown error';

    try {
      const parsed = JSON.parse(postResult.body);
      errorCode = parsed.error?.code || parsed.code || null;
      errorMessage = parsed.error?.message || parsed.message || errorMessage;
    } catch {
      // Body is not JSON, use raw
    }

    output({
      status: 'Failed',
      statusCode,
      errorCode,
      error: errorMessage,
    });
  }

  // --- 202 Accepted: extract Operation-Location and poll ---

  const operationLocation = postResult.headers?.['operation-location'] || null;

  if (!operationLocation) {
    output({ error: 'POST returned 202 but no Operation-Location header was found' });
  }

  // Ensure the poll URL includes api-version (some endpoints omit it from Operation-Location)
  let pollUrl = operationLocation;
  if (pollUrl && !pollUrl.includes('api-version')) {
    pollUrl += (pollUrl.includes('?') ? '&' : '?') + 'api-version=2022-03-01-preview';
  }

  const maxAttempts = 30; // 30 × 10s = 5 minutes
  const pollIntervalMs = 10000;
  const tokenRefreshEvery = 6; // refresh every ~60s

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(pollIntervalMs);

    // Refresh token periodically
    if (attempt % tokenRefreshEvery === 0) {
      const refreshed = getAuthToken(ppApiBaseUrl);
      if (refreshed) token = refreshed;
    }

    let pollStatus;
    try {
      const pollResult = await makeRequest({
        url: pollUrl,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        timeout: 15000,
      });
      if (pollResult.error || !pollResult.body) continue;
      pollStatus = JSON.parse(pollResult.body);
    } catch {
      // Single poll failure — continue to next attempt
      continue;
    }

    const status = pollStatus.operationStatus || pollStatus.status || pollStatus.Status;

    if (status === 'OperationComplete') {
      output({
        status: 'Succeeded',
        siteUrl: pollStatus.websiteUrl || siteUrl,
        siteName: args.siteName,
        subdomain: args.subdomain,
      });
    }

    if (status === 'OperationFailed') {
      const errMsg = pollStatus.error?.message || pollStatus.Error?.message || JSON.stringify(pollStatus);
      output({
        status: 'Failed',
        statusCode: 200,
        error: `Provisioning failed: ${errMsg}`,
      });
    }

    // "OperationInProgress" / "OperationNotStarted" — continue polling
  }

  // Timed out
  output({
    status: 'Running',
    message: 'Provisioning still in progress after 5 minutes. Check the Power Platform admin center for status.',
    siteUrl,
    siteName: args.siteName,
    subdomain: args.subdomain,
  });
})();
