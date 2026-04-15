#!/usr/bin/env node

// Validates that setup-solution completed: checks for .solution-manifest.json in project root.
// Queries Dataverse OData to confirm the solution actually exists in the environment.
// Gracefully exits 0 when no manifest is found (not a setup-solution session).

const fs = require('fs');
const path = require('path');
const {
  approve, block, runValidation,
  findProjectRoot, getAuthToken, getEnvironmentUrl, makeRequest,
} = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  const projectRoot = findProjectRoot(cwd);

  // Not a setup-solution session — no project root found
  if (!projectRoot) return approve();

  const manifestPath = path.join(projectRoot, '.solution-manifest.json');

  // No manifest — this was not a setup-solution session
  if (!fs.existsSync(manifestPath)) return approve();

  // Manifest exists — validate its contents
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return block('.solution-manifest.json exists but could not be parsed as JSON. Re-run setup-solution.');
  }

  // Check required fields
  if (!manifest.solution?.uniqueName) {
    return block('.solution-manifest.json is missing solution.uniqueName. Re-run setup-solution.');
  }
  if (!manifest.solution?.solutionId) {
    return block('.solution-manifest.json is missing solution.solutionId. Re-run setup-solution.');
  }
  if (!manifest.publisher?.publisherId) {
    return block('.solution-manifest.json is missing publisher.publisherId. Re-run setup-solution.');
  }
  if (!manifest.components || manifest.components.length === 0) {
    return block('.solution-manifest.json has no components. The website record was not added to the solution.');
  }

  // Check that the website component (type 61) is present
  const hasWebsiteComponent = manifest.components.some((c) => c.componentType === 61);
  if (!hasWebsiteComponent) {
    return block('No website component (componentType 61) found in .solution-manifest.json. The Power Pages site was not added to the solution.');
  }

  // Try to verify against Dataverse (graceful on auth failure)
  const envUrl = manifest.environmentUrl || getEnvironmentUrl();
  if (!envUrl) return approve(); // Can't verify without env URL — don't block

  const token = getAuthToken(envUrl);
  if (!token) return approve(); // Token unavailable — don't block on auth issues

  try {
    const result = await makeRequest({
      url: `${envUrl}/api/data/v9.2/solutions?$filter=uniquename eq '${manifest.solution.uniqueName}'&$select=solutionid,uniquename,version`,
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
      const solutions = data.value || [];
      if (solutions.length === 0) {
        return block(`Solution '${manifest.solution.uniqueName}' was not found in the Dataverse environment. Setup may have failed.`);
      }
    }
  } catch {
    return approve(); // Network error — don't block
  }

  return approve();
});
