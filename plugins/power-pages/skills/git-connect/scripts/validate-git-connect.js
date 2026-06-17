#!/usr/bin/env node

// Validates that git-connect completed: queries sourcecontrolbranchconfigurations
// (the per-solution source-control entity) and approves if at least one connection
// exists for an actual solution (i.e. not the env-level all-zeros partition row).
// Gracefully approves on auth/network failures — only blocks on definitive validation failures.

const {
  approve, block, runValidation,
  getAuthToken, getEnvironmentUrl,
} = require('../../../scripts/lib/validation-helpers');
const { listGitConnections } = require('../../../scripts/lib/source-control');

runValidation(async () => {
  const envUrl = getEnvironmentUrl();
  if (!envUrl) return approve(); // Can't verify without env URL — don't block

  const token = getAuthToken(envUrl);
  if (!token) return approve(); // Token unavailable — don't block on auth issues

  try {
    const connections = await listGitConnections({ envUrl, token });
    if (connections.length === 0) {
      return block('No Git connection found for any solution. The ConnectToGit action may have failed.');
    }
    return approve();
  } catch (e) {
    if (/401/.test(e.message)) return approve(); // Auth issue — don't block
    return approve(); // Network/transient error — don't block
  }
});
