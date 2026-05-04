#!/usr/bin/env node

// Checks for uncommitted changes in the source-controlled Power Pages environment.
// Usage: node check-pending-changes.js [--envUrl <url>]
//
// Output (JSON to stdout):
//   { "connected": true, "solutionId": "<guid>", "solutionUniqueName": "<string>",
//     "branchName": "...", "repositoryUrl": "...", "pendingCount": N, "components": [...] }
//   { "connected": false }
//   { "error": "..." }
//
// solutionUniqueName is the value to pass to `pac pages git commit --solutionName`.
// On 401 we surface { "error": "..." } so callers don't misread auth failure as "not connected".

const { getAuthToken, makeRequest, getEnvironmentUrl } = require('../../../scripts/lib/validation-helpers');

function parseArgs() {
  const args = process.argv.slice(2);
  let envUrl = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) {
      envUrl = args[++i].replace(/\/+$/, '');
    }
  }
  return { envUrl };
}

async function main() {
  let { envUrl } = parseArgs();

  if (!envUrl) {
    envUrl = getEnvironmentUrl();
    if (!envUrl) {
      console.log(JSON.stringify({ error: 'No environment URL. Run pac auth create first.' }));
      process.exit(1);
    }
  }

  const token = getAuthToken(envUrl);
  if (!token) {
    console.log(JSON.stringify({ error: 'Failed to get Azure CLI token. Run az login first.' }));
    process.exit(1);
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // Check connection
  const configRes = await makeRequest({
    url: envUrl + '/api/data/v9.2/sourcecontrolconfigurations?$top=1',
    method: 'GET',
    headers,
    timeout: 30000,
  });

  if (configRes.error) {
    console.log(JSON.stringify({ error: configRes.error }));
    process.exit(1);
  }
  if (configRes.statusCode === 401) {
    console.log(JSON.stringify({ error: 'Authentication failed (401). Run az login again.' }));
    process.exit(1);
  }
  if (configRes.statusCode !== 200) {
    console.log(JSON.stringify({ error: `Unexpected status ${configRes.statusCode} from sourcecontrolconfigurations` }));
    process.exit(1);
  }

  let configData;
  try { configData = JSON.parse(configRes.body); } catch { console.log(JSON.stringify({ error: 'Failed to parse sourcecontrolconfigurations response' })); process.exit(1); }

  const configs = configData.value || [];
  if (configs.length === 0) {
    console.log(JSON.stringify({ connected: false }));
    return;
  }

  const config = configs[0];

  // Query pending commit components (action eq 1)
  const compRes = await makeRequest({
    url: envUrl + '/api/data/v9.2/sourcecontrolcomponents?$filter=action eq 1',
    method: 'GET',
    headers,
    timeout: 30000,
  });

  let components = [];
  if (compRes.statusCode === 200 && compRes.body) {
    try {
      const compData = JSON.parse(compRes.body);
      components = (compData.value || []).map(c => ({
        name: c.name || 'Unknown',
        type: c.componenttype || 'Unknown',
        action: 'Commit',
      }));
    } catch { /* ignore parse errors */ }
  }

  const solutionId = config._solutionid_value || null;
  let solutionUniqueName = null;
  if (solutionId) {
    const solRes = await makeRequest({
      url: envUrl + `/api/data/v9.2/solutions(${solutionId})?$select=uniquename`,
      method: 'GET',
      headers,
      timeout: 30000,
    });
    if (solRes.statusCode === 200 && solRes.body) {
      try { solutionUniqueName = JSON.parse(solRes.body).uniquename || null; } catch { /* leave null */ }
    }
  }

  console.log(JSON.stringify({
    connected: true,
    solutionId,
    solutionUniqueName,
    branchName: config.branchname || null,
    repositoryUrl: config.repositoryurl || null,
    pendingCount: components.length,
    components,
  }));
}

main();
