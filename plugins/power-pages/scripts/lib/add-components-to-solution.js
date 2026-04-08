#!/usr/bin/env node

// Bulk-adds solution components via AddSolutionComponent OData action.
// Refreshes the Azure CLI token every TOKEN_REFRESH_INTERVAL calls.
// Treats "already in solution" responses as success (idempotent).
//
// Usage: node add-components-to-solution.js
//          --envUrl <url>
//          --componentsFile <path>
//          --solutionUniqueName <name>
//          [--batchSize 20]
//          [--token <token>]
//
// Components JSON file format (array):
//   [
//     {
//       "componentId": "guid",
//       "componentType": 10373,
//       "addRequired": false,       // optional, default false
//       "description": "Web Page: Home"  // optional, for progress display
//     }
//   ]
//
// Output (JSON to stdout):
//   { "total": N, "success": N, "skipped": N, "failed": N, "failures": [{ "componentId", "error" }] }
//
// Progress is written to stderr so stdout stays clean for JSON capture.
// Exit 0 always (caller inspects failures array); exit 1 on fatal setup errors.

'use strict';

const fs = require('fs');
const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;

const TOKEN_REFRESH_INTERVAL = 20;
const ALREADY_IN_SOLUTION_CODE = -2147160463; // Dataverse error: component already in solution

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { envUrl: null, componentsFile: null, solutionUniqueName: null, batchSize: 20, token: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) result.envUrl = args[++i];
    else if (args[i] === '--componentsFile' && args[i + 1]) result.componentsFile = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) result.solutionUniqueName = args[++i];
    else if (args[i] === '--batchSize' && args[i + 1]) result.batchSize = parseInt(args[++i], 10);
    else if (args[i] === '--token' && args[i + 1]) result.token = args[++i];
  }

  return result;
}

function isAlreadyInSolution(responseBody) {
  // Dataverse returns a specific error code when the component is already in the solution
  try {
    const data = JSON.parse(responseBody);
    const code = data?.error?.code;
    // Both string and numeric representations
    return code === String(ALREADY_IN_SOLUTION_CODE) ||
      code === ALREADY_IN_SOLUTION_CODE ||
      (data?.error?.message || '').toLowerCase().includes('already in the solution');
  } catch {
    return false;
  }
}

async function addComponentsToSolution({ envUrl, componentsFile, solutionUniqueName, batchSize, token }) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!componentsFile) throw new Error('--componentsFile is required');
  if (!solutionUniqueName) throw new Error('--solutionUniqueName is required');

  const components = JSON.parse(fs.readFileSync(componentsFile, 'utf8'));
  if (!Array.isArray(components) || components.length === 0) {
    return { total: 0, success: 0, skipped: 0, failed: 0, failures: [] };
  }

  let currentToken = token || getAuthToken(envUrl);
  if (!currentToken) throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');

  const total = components.length;
  let success = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  process.stderr.write(`Adding ${total} components to solution "${solutionUniqueName}"...\n`);

  for (let i = 0; i < components.length; i++) {
    // Refresh token every TOKEN_REFRESH_INTERVAL calls
    if (i > 0 && i % TOKEN_REFRESH_INTERVAL === 0) {
      const refreshed = getAuthToken(envUrl);
      if (refreshed) currentToken = refreshed;
      process.stderr.write(`  Token refreshed at component ${i + 1}/${total}\n`);
    }

    const { componentId, componentType, addRequired, description } = components[i];

    const body = JSON.stringify({
      ComponentId: componentId,
      ComponentType: componentType,
      SolutionUniqueName: solutionUniqueName,
      AddRequiredComponents: addRequired === true,
      DoNotIncludeSubcomponents: false,
      IncludedComponentSettingsValues: null,
    });

    const res = await helpers.makeRequest({
      url: `${envUrl}/api/data/v9.2/AddSolutionComponent`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${currentToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
      },
      body,
      timeout: 30000,
    });

    const label = description || componentId;

    if (res.error) {
      failed++;
      failures.push({ componentId, error: res.error });
      process.stderr.write(`  ✗ FAILED  ${label}: ${res.error}\n`);
      continue;
    }

    if (res.statusCode === 200 || res.statusCode === 204) {
      success++;
      if ((i + 1) % 10 === 0 || i === total - 1) {
        process.stderr.write(`  Added ${i + 1}/${total} components...\n`);
      }
      continue;
    }

    // 4xx with "already in solution" is idempotent success
    if (isAlreadyInSolution(res.body)) {
      skipped++;
      continue;
    }

    // Retry once on 401 with token refresh
    if (res.statusCode === 401) {
      currentToken = getAuthToken(envUrl) || currentToken;
      const retry = await makeRequest({
        url: `${envUrl}/api/data/v9.2/AddSolutionComponent`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${currentToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
        },
        body,
        timeout: 30000,
      });
      if (retry.statusCode === 200 || retry.statusCode === 204) {
        success++;
        continue;
      }
      if (isAlreadyInSolution(retry.body)) {
        skipped++;
        continue;
      }
      failed++;
      failures.push({ componentId, error: `401 after token refresh: ${retry.body}` });
      process.stderr.write(`  ✗ FAILED  ${label}: 401 after token refresh\n`);
      continue;
    }

    failed++;
    failures.push({ componentId, error: `HTTP ${res.statusCode}: ${res.body}` });
    process.stderr.write(`  ✗ FAILED  ${label}: HTTP ${res.statusCode}\n`);
  }

  process.stderr.write(`Done. ${success} added, ${skipped} already present, ${failed} failed.\n`);
  return { total, success, skipped, failed, failures };
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);

  addComponentsToSolution(args)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { addComponentsToSolution };
