#!/usr/bin/env node

// Checks for available updates from Git that can be pulled into the environment.
// Usage: node check-available-updates.js [--envUrl <url>]
//
// Output (JSON to stdout):
//   { "connected": true, "solutionId": "<guid>", "solutionUniqueName": "<string>",
//     "branchName": "...", "repositoryUrl": "...",
//     "availableCount": N, "conflictCount": M, "available": [...], "conflicts": [...] }
//   { "connected": false }
//   { "error": "..." }
//
// solutionUniqueName is the value to pass to `pac pages git pull --solutionName`.
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

  // Query available pull components (action eq 2)
  const availRes = await makeRequest({
    url: envUrl + '/api/data/v9.2/sourcecontrolcomponents?$filter=action eq 2',
    method: 'GET',
    headers,
    timeout: 30000,
  });

  let available = [];
  if (availRes.statusCode === 200 && availRes.body) {
    try {
      const data = JSON.parse(availRes.body);
      available = (data.value || []).map(c => ({
        name: c.name || 'Unknown',
        type: c.componenttype || 'Unknown',
        action: 'Pull',
      }));
    } catch { /* ignore */ }
  }

  // Query conflicts (action eq 3)
  const conflictRes = await makeRequest({
    url: envUrl + '/api/data/v9.2/sourcecontrolcomponents?$filter=action eq 3',
    method: 'GET',
    headers,
    timeout: 30000,
  });

  let conflicts = [];
  if (conflictRes.statusCode === 200 && conflictRes.body) {
    try {
      const data = JSON.parse(conflictRes.body);
      conflicts = (data.value || []).map(c => ({
        name: c.name || 'Unknown',
        type: c.componenttype || 'Unknown',
        action: 'Conflict',
      }));
    } catch { /* ignore */ }
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
    availableCount: available.length,
    conflictCount: conflicts.length,
    available,
    conflicts,
  }));
}

main();
