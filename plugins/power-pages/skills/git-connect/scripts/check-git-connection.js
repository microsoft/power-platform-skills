#!/usr/bin/env node

// Checks whether the current Power Pages environment is connected to a Git repository.
// Usage: node check-git-connection.js [--envUrl <url>] [--solutionName <name>]
//
// Output (JSON to stdout):
//   Connected:    { "connected": true, "solutionId": "<guid>", "solutionUniqueName": "<string>",
//                   "repositoryUrl": "...", "branchName": "...", "rootFolderPath": "...",
//                   "branchSyncedCommitId": "...", "connections": [ ...all per-solution rows... ] }
//   Disconnected: { "connected": false, "connections": [] }
//   Error:        { "error": "..." }
//
// solutionUniqueName is the value to pass to `pac pages git commit/disconnect --solutionName`.
// When --solutionName is supplied the result is narrowed to that solution; otherwise the
// first per-solution connection is reported as the top-level fields while `connections`
// always carries the full list.

const { getAuthToken, getEnvironmentUrl } = require('../../../scripts/lib/validation-helpers');
const { listGitConnections } = require('../../../scripts/lib/source-control');

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

  const primary = connections[0];
  console.log(JSON.stringify({
    connected: true,
    solutionId: primary.solutionId,
    solutionUniqueName: primary.solutionUniqueName,
    branchName: primary.branchName,
    upstreamBranchName: primary.upstreamBranchName,
    rootFolderPath: primary.rootFolderPath,
    branchSyncedCommitId: primary.branchSyncedCommitId,
    repositoryUrl: primary.repositoryUrl,
    organizationName: primary.organizationName,
    projectName: primary.projectName,
    repositoryName: primary.repositoryName,
    gitProvider: primary.gitProvider,
    lastSyncDate: primary.lastSolutionModifiedOn,
    connections,
  }));
}

main();
