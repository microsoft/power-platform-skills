#!/usr/bin/env node

// Checks for uncommitted changes in the source-controlled Power Pages environment.
// Usage: node check-pending-changes.js [--envUrl <url>]
//
// Output (JSON to stdout):
//   { "connected": true, "solutionName": "...", "branchName": "...", "pendingCount": N, "components": [...] }
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

  console.log(JSON.stringify({
    connected: true,
    solutionId: config._solutionid_value || null,
    branchName: config.branchname || null,
    repositoryUrl: config.repositoryurl || null,
    pendingCount: components.length,
    components,
  }));
}

main();
