#!/usr/bin/env node

// Checks for available updates from Git that can be pulled into the environment.
// Usage: node check-available-updates.js [--envUrl <url>] [--solutionName <name>]
//
// Output (JSON to stdout):
//   { "connected": true, "solutionId": "...", "solutionUniqueName": "...",
//     "branchName": "...", "repositoryUrl": "...", "rootFolderPath": "...",
//     "availableCount": N, "conflictCount": M, "available": [...], "conflicts": [...],
//     "connections": [...] }
//   { "connected": false, "connections": [] }
//   { "error": "..." }
//
// solutionUniqueName is the value to pass to `pac pages git pull --solutionName`.
// On 401 we surface { "error": "..." } so callers don't misread auth failure as "not connected".

const { getAuthToken, getEnvironmentUrl } = require('../../../scripts/lib/validation-helpers');
const { listGitConnections, listSourceControlComponents, ACTION } = require('../../../scripts/lib/source-control');

function parseArgs() {
  const args = process.argv.slice(2);
  let envUrl = null;
  let solutionName = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) {
      envUrl = args[++i].replace(/\/+$/, '');
    } else if (args[i] === '--solutionName' && args[i + 1]) {
      solutionName = args[++i];
    }
  }
  return { envUrl, solutionName };
}

async function main() {
  let { envUrl, solutionName } = parseArgs();

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

  let connections;
  try {
    connections = await listGitConnections({ envUrl, token, solutionUniqueName: solutionName });
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }

  if (connections.length === 0) {
    console.log(JSON.stringify({ connected: false, connections: [] }));
    return;
  }

  let available = [];
  let conflicts = [];
  try {
    available = await listSourceControlComponents({ envUrl, token, action: ACTION.PULL });
    conflicts = await listSourceControlComponents({ envUrl, token, action: ACTION.CONFLICT });
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(1);
  }

  const primary = connections[0];
  console.log(JSON.stringify({
    connected: true,
    solutionId: primary.solutionId,
    solutionUniqueName: primary.solutionUniqueName,
    branchName: primary.branchName,
    repositoryUrl: primary.repositoryUrl,
    rootFolderPath: primary.rootFolderPath,
    availableCount: available.length,
    conflictCount: conflicts.length,
    available,
    conflicts,
    connections,
  }));
}

main();
