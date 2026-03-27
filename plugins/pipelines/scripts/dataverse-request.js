#!/usr/bin/env node
// General-purpose Dataverse OData API request script with built-in auth and retry.
// Usage: node dataverse-request.js <envUrl> <method> <apiPath> [--body <json>] [--include-headers]
//
// Output (stdout): { "status": <code>, "data": <response> }
// Exit 0 on request completed, exit 1 on fatal error.

const { getAuthToken, makeRequest } = require('./lib/pipeline-helpers');

const API_VERSION = 'v9.2';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 3) {
    console.error(JSON.stringify({ error: 'Usage: node dataverse-request.js <envUrl> <method> <apiPath> [--body <json>] [--include-headers]' }));
    process.exit(1);
  }
  const envUrl = args[0].replace(/\/+$/, '');
  const method = args[1].toUpperCase();
  const apiPath = args[2];
  let body = null;
  let includeHeaders = false;

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--body' && i + 1 < args.length) {
      body = args[++i];
    } else if (args[i] === '--include-headers') {
      includeHeaders = true;
    }
  }
  return { envUrl, method, apiPath, body, includeHeaders };
}

function getResourceUrl(envUrl) {
  try {
    const u = new URL(envUrl);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return envUrl;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { envUrl, method, apiPath, body, includeHeaders } = parseArgs(process.argv);
  const resourceUrl = getResourceUrl(envUrl);
  const fullUrl = `${envUrl}/api/data/${API_VERSION}/${apiPath}`;

  let token = getAuthToken(resourceUrl);
  if (!token) {
    console.error(JSON.stringify({ error: `Failed to obtain auth token for ${resourceUrl}` }));
    process.exit(1);
  }

  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0'
    };

    const result = await makeRequest({
      url: fullUrl,
      method,
      headers,
      body,
      includeHeaders,
      timeout: 30000
    });

    if (result.error) {
      lastError = result.error;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      break;
    }

    const statusCode = result.statusCode;

    // 401 — refresh token and retry
    if (statusCode === 401 && attempt < MAX_RETRIES - 1) {
      token = getAuthToken(resourceUrl);
      if (!token) {
        console.error(JSON.stringify({ error: 'Token refresh failed' }));
        process.exit(1);
      }
      await sleep(1000);
      continue;
    }

    // 429, 500, 502, 503 — retry with backoff
    if ([429, 500, 502, 503].includes(statusCode) && attempt < MAX_RETRIES - 1) {
      const retryAfter = result.headers && result.headers['retry-after']
        ? parseInt(result.headers['retry-after'], 10) * 1000
        : RETRY_DELAY_MS * (attempt + 1);
      await sleep(retryAfter);
      continue;
    }

    // Parse response body
    let data = null;
    try {
      data = result.body ? JSON.parse(result.body) : null;
    } catch {
      data = result.body || null;
    }

    const output = { status: statusCode, data };
    if (includeHeaders && result.headers) {
      output.headers = result.headers;
    }

    console.log(JSON.stringify(output));
    process.exit(0);
  }

  console.error(JSON.stringify({ error: lastError || 'Max retries exceeded' }));
  process.exit(1);
}

main();
