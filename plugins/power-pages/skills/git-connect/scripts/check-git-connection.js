#!/usr/bin/env node

// Checks whether the current Power Pages environment is connected to a Git repository.
// Usage: node check-git-connection.js [--envUrl <url>]
//
// Output (JSON to stdout):
//   Connected:    { "connected": true, "solutionName": "...", "repositoryUrl": "...", "branchName": "...", "lastSyncDate": "..." }
//   Disconnected: { "connected": false }
//   Error:        { "error": "..." }

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

  const url = envUrl + '/api/data/v9.2/sourcecontrolconfigurations?$top=10';
  const res = await makeRequest({
    url,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  if (res.error) {
    console.log(JSON.stringify({ error: res.error }));
    process.exit(1);
  }

  if (res.statusCode === 401) {
    console.log(JSON.stringify({ error: 'Authentication failed (401). Run az login again.' }));
    process.exit(1);
  }

  if (res.statusCode !== 200) {
    console.log(JSON.stringify({ error: `Unexpected status ${res.statusCode}` }));
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    console.log(JSON.stringify({ error: 'Failed to parse response' }));
    process.exit(1);
  }

  const configs = data.value || [];
  if (configs.length === 0) {
    console.log(JSON.stringify({ connected: false }));
    return;
  }

  const config = configs[0];
  console.log(JSON.stringify({
    connected: true,
    solutionId: config._solutionid_value || null,
    repositoryUrl: config.repositoryurl || null,
    branchName: config.branchname || null,
    status: config.status || null,
    lastSyncDate: config.modifiedon || null,
  }));
}

main();
