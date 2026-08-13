#!/usr/bin/env node
/**
 * Detect the active publisher prefix for a Dataverse environment.
 *
 * Usage:
 *   node scripts/detect-publisher-prefix.js <envUrl> [solutionName]
 *
 * solutionName defaults to "Default" (the built-in Default solution).
 *
 * Output (stdout, JSON):
 *   { "prefix": "cr8142a", "source": "detected" }
 *   { "prefix": null, "reason": "<short reason>" }
 *
 * Exit code: 0 always (caller inspects the JSON). Failures emit `prefix: null`.
 */

const { getAuthToken } = require('./lib/validation-helpers');

async function main() {
  const envUrl = process.argv[2];
  const solutionName = process.argv[3] || 'Default';

  if (!envUrl) {
    console.log(JSON.stringify({ prefix: null, reason: 'envUrl arg missing' }));
    process.exit(0);
  }

  const token = await getAuthToken(envUrl);
  if (!token) {
    console.log(JSON.stringify({
      prefix: null,
      reason: 'no token (run `az login --tenant <env-tenant>`)',
    }));
    process.exit(0);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
  };

  // Fetch the publisher prefix directly from the target solution.
  const solutionQuery = `${envUrl}/api/data/v9.2/solutions?$select=uniquename&$expand=publisherid($select=customizationprefix)&$filter=uniquename eq '${solutionName}'`;

  const solutionRes = await fetch(solutionQuery, { method: 'GET', headers });
  const solutionData = await solutionRes.json();

  if (!solutionData.value || solutionData.value.length === 0) {
    console.log(JSON.stringify({
      prefix: null,
      reason: `Solution '${solutionName}' not found in this environment.`,
    }));
    process.exit(0);
  }

  // Extract the prefix (e.g., "cr5a2" or "new")
  const prefix = solutionData.value[0].publisherid.customizationprefix;

  if (!prefix) {
    console.log(JSON.stringify({
      prefix: null,
      reason: `Solution '${solutionName}' found but publisher prefix is empty.`,
    }));
    process.exit(0);
  }

  console.log(JSON.stringify({ prefix, source: 'detected' }));
  process.exit(0);
}

main().catch((err) => {
  console.log(JSON.stringify({ prefix: null, reason: `unexpected error: ${err.message}` }));
  process.exit(0);
});
