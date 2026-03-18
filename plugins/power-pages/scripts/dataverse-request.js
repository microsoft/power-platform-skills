#!/usr/bin/env node

// General-purpose Dataverse OData API request script with built-in auth and retry.
// Usage: node dataverse-request.js <envUrl> <method> <apiPath> [--body <json>]
//
// Arguments:
//   envUrl   - Dataverse environment URL (e.g., https://org123.crm.dynamics.com)
//   method   - HTTP method: GET, POST, PATCH, DELETE
//   apiPath  - API path after /api/data/v9.2/ (e.g., "EntityDefinitions?$filter=...")
//
// Options:
//   --body <json>      Request body as JSON string
//   --include-headers  Include response headers in output (for OData-EntityId etc.)
//
// Output (JSON to stdout):
//   Success: { "status": 200, "data": { ... } }
//   With headers: { "status": 200, "data": { ... }, "headers": { ... } }
//   Error: { "status": 401, "error": "..." }
//
// Exit codes:
//   0 - Request completed (check status field for HTTP result)
//   1 - Fatal error (no token, invalid args, network failure after retries)

const { getAuthToken, makeRequest } = require('./lib/validation-helpers');

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    process.stderr.write(
      'Usage: node dataverse-request.js <envUrl> <method> <apiPath> [--body <json>] [--include-headers]\n'
    );
    process.exit(1);
  }

  const envUrl = args[0].replace(/\/+$/, '');
  const method = args[1].toUpperCase();
  const apiPath = args[2];
  let body = null;
  let includeHeaders = false;

  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--body' && args[i + 1]) {
      body = args[++i];
    } else if (args[i] === '--include-headers') {
      includeHeaders = true;
    }
  }

  return { envUrl, method, apiPath, body, includeHeaders };
}

async function doRequest(envUrl, method, apiPath, body, token, includeHeaders) {
  const url = `${envUrl}/api/data/v9.2/${apiPath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await makeRequest({
    url,
    method,
    headers,
    body,
    includeHeaders,
    timeout: 30000,
  });

  return res;
}

async function main() {
  const { envUrl, method, apiPath, body, includeHeaders } = parseArgs();

  let token = getAuthToken(envUrl);
  if (!token) {
    process.stderr.write('Failed to get Azure CLI token. Run `az login` first.\n');
    process.exit(1);
  }

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await doRequest(envUrl, method, apiPath, body, token, includeHeaders);

    if (res.error) {
      if (attempt < maxRetries) continue;
      process.stderr.write(`Request failed: ${res.error}\n`);
      process.exit(1);
    }

    // Retry on 401 with token refresh
    if (res.statusCode === 401 && attempt < maxRetries) {
      token = getAuthToken(envUrl);
      if (!token) {
        process.stderr.write('Token refresh failed. Run `az login` again.\n');
        process.exit(1);
      }
      continue;
    }

    // Retry on transient server errors
    if ([429, 500, 502, 503].includes(res.statusCode) && attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    // Parse response body
    let data = null;
    if (res.body) {
      try {
        data = JSON.parse(res.body);
      } catch {
        data = res.body;
      }
    }

    const output = { status: res.statusCode, data };
    if (includeHeaders && res.headers) {
      output.headers = res.headers;
    }
    console.log(JSON.stringify(output));
    return;
  }
}

main();
