#!/usr/bin/env node

// Validates that git-connect completed: queries sourcecontrolconfigurations to confirm
// the environment has an active Git connection with a repository URL.
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

  try {
    const result = await makeRequest({
      url: `${envUrl}/api/data/v9.2/sourcecontrolconfigurations?$top=1`,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'OData-Version': '4.0',
      },
      timeout: 15000,
    });

    if (result.error || result.statusCode === 401) return approve(); // Auth/network issue — don't block

    if (result.statusCode === 200) {
      const data = JSON.parse(result.body);
      const configs = data.value || [];

      if (configs.length === 0) {
        return block('No Git connection found. The ConnectToGit action may have failed.');
      }

      // At least one config exists — check for a repository URL
      const hasRepo = configs.some((c) => c.repositoryurl);
      if (hasRepo) return approve();

      return block('No Git connection found. The ConnectToGit action may have failed.');
    }
  } catch {
    return approve(); // Network error — don't block
  }

  return approve();
});
