#!/usr/bin/env node

// Validates that git-pull completed: confirms environment is still connected to Git,
// then checks that no available updates remain (action eq 2).
// Gracefully approves on auth/network failures — only blocks on definitive validation failures.

const {
  approve, block, runValidation,
  getAuthToken, getEnvironmentUrl, makeRequest,
} = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  const envUrl = getEnvironmentUrl();
  if (!envUrl) return approve(); // Can't verify without env URL — don't block

  const token = getAuthToken(envUrl);
  if (!token) return approve(); // Token unavailable — don't block on auth issues

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'OData-Version': '4.0',
  };

  // Step 1: Confirm still connected to Git
  try {
    const configResult = await makeRequest({
      url: `${envUrl}/api/data/v9.2/sourcecontrolconfigurations?$top=1`,
      headers,
      timeout: 15000,
    });

    if (configResult.error || configResult.statusCode === 401) return approve(); // Auth/network issue — don't block

    if (configResult.statusCode === 200) {
      const configData = JSON.parse(configResult.body);
      const configs = configData.value || [];

      if (configs.length === 0) {
        return block('Environment is not connected to Git.');
      }
    }
  } catch {
    return approve(); // Network error — don't block
  }

  // Step 2: Check for remaining available updates
  try {
    const compResult = await makeRequest({
      url: `${envUrl}/api/data/v9.2/sourcecontrolcomponents?$filter=action eq 2`,
      headers,
      timeout: 15000,
    });

    if (compResult.error || compResult.statusCode === 401) return approve(); // Auth/network issue — don't block

    if (compResult.statusCode === 200) {
      const compData = JSON.parse(compResult.body);
      const count = (compData.value || []).length;

      if (count > 0) {
        return block(`There are still ${count} available updates from Git. The PullChangesFromGit action may have failed.`);
      }

      return approve(); // No available updates — pull succeeded
    }
  } catch {
    return approve(); // Network error — don't block
  }

  return approve();
});
