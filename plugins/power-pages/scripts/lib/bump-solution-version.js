#!/usr/bin/env node

// Bumps the patch segment (4th segment) of a Dataverse solution version and
// PATCHes it back. Used by:
//   - setup-solution Phase 4 sync mode (before AddSolutionComponent calls)
//   - export-solution Phase 4 (before ExportSolutionAsync) so every produced
//     zip carries a strictly-increasing version label
//
// Both callers must use this helper so the bump semantics stay consistent
// (e.g. how trailing segments are inferred when the source version has fewer
// than 4 segments, how `1.0.0.9 → 1.0.0.10` is computed).
//
// Usage:
//   node bump-solution-version.js --envUrl <url> --uniqueName <name> [--token <tok>]
//   node bump-solution-version.js --envUrl <url> --solutionId <guid> [--token <tok>]
//
// Output (JSON to stdout):
//   { "solutionId": "...", "uniqueName": "...", "previous": "1.0.0.2", "next": "1.0.0.3", "bumped": true }
//   bumped=false would only appear if the caller passed --dryRun.
//
// Exit 0 on success, exit 1 on failure (missing args, solution not found,
// PATCH rejected).

'use strict';

const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;
const { verifySolutionExists } = require('./verify-solution-exists');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, uniqueName: null, solutionId: null, token: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--uniqueName' && args[i + 1]) out.uniqueName = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--dryRun' || args[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

/**
 * Bumps the patch (4th) segment of a Dataverse version string.
 * Pads missing segments with `0` so 1.0 → 1.0.0.1 and 1 → 1.0.0.1.
 * Rejects non-numeric segments, negative numbers, and empty input.
 *
 * @param {string} version
 * @returns {string}
 */
function bumpPatchSegment(version) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(`bumpPatchSegment: version is required (got ${JSON.stringify(version)})`);
  }
  const segments = version.split('.');
  if (segments.length > 4) {
    throw new Error(`bumpPatchSegment: version "${version}" has more than 4 segments`);
  }
  const padded = [...segments, '0', '0', '0', '0'].slice(0, 4);
  const nums = padded.map((s, i) => {
    if (!/^\d+$/.test(s)) {
      throw new Error(`bumpPatchSegment: segment ${i} of "${version}" is not a non-negative integer ("${s}")`);
    }
    return Number(s);
  });
  nums[3] += 1;
  return nums.join('.');
}

async function bumpSolutionVersion({ envUrl, uniqueName, solutionId, token, dryRun = false }) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!uniqueName && !solutionId) {
    throw new Error('Either --uniqueName or --solutionId is required');
  }

  const resolvedToken = token || getAuthToken(envUrl);
  if (!resolvedToken) {
    throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');
  }

  let resolvedSolutionId = solutionId;
  let resolvedUniqueName = uniqueName;
  let currentVersion;

  if (resolvedUniqueName) {
    const existing = await verifySolutionExists({
      envUrl,
      uniqueName: resolvedUniqueName,
      token: resolvedToken,
    });
    if (!existing.found) {
      throw new Error(`Solution '${resolvedUniqueName}' not found in ${envUrl}`);
    }
    resolvedSolutionId = existing.solutionId;
    currentVersion = existing.version;
  } else {
    // Look up by solutionId
    const url = `${envUrl}/api/data/v9.2/solutions(${resolvedSolutionId})?$select=solutionid,uniquename,version`;
    const res = await helpers.makeRequest({
      url,
      headers: {
        Authorization: `Bearer ${resolvedToken}`,
        Accept: 'application/json',
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
      },
      timeout: 15000,
    });
    if (res.error) throw new Error(`API request failed: ${res.error}`);
    if (res.statusCode === 404) {
      throw new Error(`Solution ${resolvedSolutionId} not found in ${envUrl}`);
    }
    if (res.statusCode !== 200) {
      throw new Error(`Unexpected response (${res.statusCode}): ${res.body}`);
    }
    const data = JSON.parse(res.body);
    resolvedUniqueName = data.uniquename;
    currentVersion = data.version;
  }

  const next = bumpPatchSegment(currentVersion);

  if (dryRun) {
    return {
      solutionId: resolvedSolutionId,
      uniqueName: resolvedUniqueName,
      previous: currentVersion,
      next,
      bumped: false,
    };
  }

  const patchRes = await helpers.makeRequest({
    url: `${envUrl}/api/data/v9.2/solutions(${resolvedSolutionId})`,
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${resolvedToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      'If-Match': '*',
    },
    body: JSON.stringify({ version: next }),
    timeout: 15000,
  });

  if (patchRes.error) throw new Error(`Version PATCH failed: ${patchRes.error}`);
  if (patchRes.statusCode !== 204) {
    throw new Error(`Version PATCH returned ${patchRes.statusCode}: ${patchRes.body}`);
  }

  return {
    solutionId: resolvedSolutionId,
    uniqueName: resolvedUniqueName,
    previous: currentVersion,
    next,
    bumped: true,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  bumpSolutionVersion(args)
    .then((result) => {
      console.log(JSON.stringify(result));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { bumpSolutionVersion, bumpPatchSegment };
