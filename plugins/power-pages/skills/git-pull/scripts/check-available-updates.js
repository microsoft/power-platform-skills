#!/usr/bin/env node

// Checks for available updates from Git that can be pulled into the environment.
// Usage: node check-available-updates.js [--envUrl <url>]
//
// Output (JSON to stdout):
//   { "connected": true, "solutionName": "...", "branchName": "...",
//     "availableCount": N, "conflictCount": M, "available": [...], "conflicts": [...] }
//   { "connected": false }
//   { "error": "..." }

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

  if (configRes.error || configRes.statusCode !== 200) {
    console.log(JSON.stringify({ connected: false }));
    return;
  }

  let configData;
  try { configData = JSON.parse(configRes.body); } catch { console.log(JSON.stringify({ connected: false })); return; }

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

  console.log(JSON.stringify({
    connected: true,
    solutionId: config._solutionid_value || null,
    branchName: config.branchname || null,
    repositoryUrl: config.repositoryurl || null,
    availableCount: available.length,
    conflictCount: conflicts.length,
    available,
    conflicts,
  }));
}

main();
