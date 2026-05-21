#!/usr/bin/env node

// Validates that setup-solution completed: checks for .solution-manifest.json in project root.
// Queries Dataverse OData to confirm the solution actually exists in the environment.
// Gracefully exits 0 when no manifest is found (not a setup-solution session).

const fs = require('fs');
const path = require('path');
const { approve, block, runValidation, findProjectRoot, getAuthToken, getEnvironmentUrl, makeRequest, readDeferralMarker } = require('../../../scripts/lib/validation-helpers');

runValidation(async (cwd) => {
  if (readDeferralMarker(findProjectRoot(cwd) || cwd)) return approve();  // ALM deferred — silent-approve.
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

  // Dispatch on schemaVersion. v1 (absent or === 1) uses the singular
  // `manifest.solution` block. v2 (`schemaVersion: 2`) uses a `solutions[]`
  // array — one entry per split solution from setup-solution Phase 6's
  // multi-solution write path. Both shapes are normalized into a
  // `solutionsToVerify[]` list of `{ uniqueName, solutionId, components }`
  // so the downstream component checks + Dataverse round-trip handle both
  // without branching code below.
  const isV2 = manifest.schemaVersion === 2 || Array.isArray(manifest.solutions);
  let solutionsToVerify;
  if (isV2) {
    if (!Array.isArray(manifest.solutions) || manifest.solutions.length === 0) {
      return block('.solution-manifest.json has schemaVersion 2 but `solutions[]` is missing or empty. Re-run setup-solution.');
    }
    if (!manifest.publisher?.publisherId) {
      return block('.solution-manifest.json is missing publisher.publisherId. Re-run setup-solution.');
    }
    for (const s of manifest.solutions) {
      if (!s || !s.uniqueName) {
        return block('.solution-manifest.json schemaVersion 2 entry is missing uniqueName. Re-run setup-solution.');
      }
      if (!s.solutionId) {
        return block(`.solution-manifest.json schemaVersion 2 entry '${s.uniqueName}' is missing solutionId. Re-run setup-solution.`);
      }
    }
    solutionsToVerify = manifest.solutions.map((s) => ({
      uniqueName: s.uniqueName,
      solutionId: s.solutionId,
      components: Array.isArray(s.components) ? s.components : [],
    }));
  } else {
    // v1 path (legacy single-solution manifest)
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
    solutionsToVerify = [{
      uniqueName: manifest.solution.uniqueName,
      solutionId: manifest.solution.solutionId,
      components: manifest.components,
    }];
  }

  // The Power Pages website (componentType 61) must be in at least ONE of
  // the solutions — for multi-solution splits, it typically lives in the
  // Core / Foundation solution. For single-solution it's in the only
  // solution. v2 entries may have empty components[] arrays for solutions
  // that don't claim the website record (e.g. an EnvVars-only solution);
  // we only require the website record to be present somewhere.
  const websiteComponentSomewhere = solutionsToVerify.some(
    (s) => s.components.some((c) => c.componentType === 61),
  );
  if (!websiteComponentSomewhere) {
    return block('No website component (componentType 61) found in any solution in .solution-manifest.json. The Power Pages site was not added to any solution.');
  }

  // Try to verify against Dataverse (graceful on auth failure). For v2, verify
  // each solution exists. For v1, just the one.
  const envUrl = manifest.environmentUrl || getEnvironmentUrl();
  if (!envUrl) return approve(); // Can't verify without env URL — don't block

  const token = getAuthToken(envUrl);
  if (!token) return approve(); // Token unavailable — don't block on auth issues

  for (const sol of solutionsToVerify) {
    try {
      const result = await makeRequest({
        url: `${envUrl}/api/data/v9.2/solutions?$filter=uniquename eq '${sol.uniqueName}'&$select=solutionid,uniquename,version`,
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
          return block(`Solution '${sol.uniqueName}' was not found in the Dataverse environment. Setup may have failed.`);
        }
      }
    } catch {
      return approve(); // Network error — don't block on transient issues
    }
  }

  return approve();
});
