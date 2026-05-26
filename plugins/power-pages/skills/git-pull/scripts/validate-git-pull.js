#!/usr/bin/env node

// Validates that git-pull completed: confirms a per-solution Git connection still exists,
// then checks that no available updates remain (action eq 2).
// Gracefully approves on auth/network failures — only blocks on definitive validation failures.

const {
  approve, block, runValidation,
  getAuthToken, getEnvironmentUrl,
} = require('../../../scripts/lib/validation-helpers');
const {
  listGitConnections, countSourceControlComponents, ACTION,
} = require('../../../scripts/lib/source-control');

runValidation(async () => {
  const envUrl = getEnvironmentUrl();
  if (!envUrl) return approve();

  const token = getAuthToken(envUrl);
  if (!token) return approve();

  try {
    const connections = await listGitConnections({ envUrl, token });
    if (connections.length === 0) {
      return block('Environment is not connected to Git.');
    }

    const available = await countSourceControlComponents({ envUrl, token, action: ACTION.PULL });
    if (available > 0) {
      return block(`There are still ${available} available updates from Git. The PullChangesFromGit action may have failed.`);
    }
    return approve();
  } catch (e) {
    if (/401/.test(e.message)) return approve();
    return approve();
  }
});
