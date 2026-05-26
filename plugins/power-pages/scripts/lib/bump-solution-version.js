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

const fs = require('fs');
const path = require('path');
const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;
const { verifySolutionExists } = require('./verify-solution-exists');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, uniqueName: null, solutionId: null, token: null, dryRun: false, projectRoot: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--uniqueName' && args[i + 1]) out.uniqueName = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--dryRun' || args[i] === '--dry-run') out.dryRun = true;
    else if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
  }
  return out;
}

// Update `.solution-manifest.json` in the project root with the just-bumped
// version so consumers reading the manifest (deploy-pipeline, export-solution,
// the rendered plan) see the current Dataverse state without a stale-data
// surprise. Best-effort — a missing or unparseable manifest is a no-op rather
// than a fatal error (some callers run without a manifest, e.g. when bumping
// a one-off solution outside a Power Pages project layout).
//
// Single-solution shape (schemaVersion: 1 or absent):
//   { "solution": { "uniqueName": "...", "solutionId": "...", "version": "..." } }
// Multi-solution shape (schemaVersion: 2):
//   { "solutions": [{ "uniqueName": "...", "solutionId": "...", "version": "..." }, ...] }
//
// We match by solutionId (preferred) or uniqueName (fallback) to find the
// matching entry. Atomic tmp + rename to avoid mid-write corruption.
function updateManifestVersion(projectRoot, { solutionId, uniqueName, nextVersion }) {
  if (!projectRoot) return { updated: false, reason: 'no-projectRoot' };
  try {
    const manifestPath = path.join(projectRoot, '.solution-manifest.json');
    if (!fs.existsSync(manifestPath)) return { updated: false, reason: 'no-manifest' };
    const raw = fs.readFileSync(manifestPath, 'utf8');
    let manifest;
    try { manifest = JSON.parse(raw); } catch { return { updated: false, reason: 'unparseable' }; }

    const matches = (entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (solutionId && entry.solutionId && String(entry.solutionId).toLowerCase() === String(solutionId).toLowerCase()) return true;
      if (uniqueName && entry.uniqueName && entry.uniqueName === uniqueName) return true;
      return false;
    };

    let updated = false;
    // Single-solution shape
    if (manifest.solution && matches(manifest.solution)) {
      manifest.solution.version = nextVersion;
      updated = true;
    }
    // Multi-solution shape
    if (Array.isArray(manifest.solutions)) {
      for (const sol of manifest.solutions) {
        if (matches(sol)) {
          sol.version = nextVersion;
          updated = true;
        }
      }
    }

    if (!updated) return { updated: false, reason: 'no-matching-entry' };

    const tmp = manifestPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, manifestPath);
    return { updated: true, manifestPath };
  } catch (e) {
    return { updated: false, reason: `write-failed: ${e.message}` };
  }
}

/**
 * Parses a Dataverse version string into a 4-segment integer tuple.
 * Pads missing trailing segments with `0` so `1.0` → `[1,0,0,0]`.
 * Rejects non-numeric or negative segments and > 4 segments.
 *
 * @param {string} version
 * @returns {number[]}
 */
function parseVersionToSegments(version) {
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error(`parseVersionToSegments: version is required (got ${JSON.stringify(version)})`);
  }
  const segments = version.split('.');
  if (segments.length > 4) {
    throw new Error(`parseVersionToSegments: version "${version}" has more than 4 segments`);
  }
  const padded = [...segments, '0', '0', '0', '0'].slice(0, 4);
  return padded.map((s, i) => {
    if (!/^\d+$/.test(s)) {
      throw new Error(`parseVersionToSegments: segment ${i} of "${version}" is not a non-negative integer ("${s}")`);
    }
    return Number(s);
  });
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
  const nums = parseVersionToSegments(version);
  nums[3] += 1;
  return nums.join('.');
}

/**
 * Integer-segment-wise comparison of two Dataverse version strings.
 * Returns -1 when `a < b`, 0 when equal, +1 when `a > b`.
 *
 * Critically, this does NOT compare lexically — `compareVersions('1.0.0.9', '1.0.0.10')`
 * correctly returns -1 (i.e., `1.0.0.9 < 1.0.0.10`), where JS string `'1.0.0.9' > '1.0.0.10'`
 * is `true`. Callers that use `>`/`<` on raw version strings (in agent prose, in SKILL.md
 * decision tables, etc.) will get the wrong branch as soon as any segment crosses 10 —
 * a real-world failure mode for any project on its 10th+ deploy of the day.
 *
 * Used by `import-solution` Phase 3.0 version-skew advisory and any other caller that
 * needs to compare zip-version vs installed-version, dev-version vs target-version, etc.
 * Same segment-parse rules as `bumpPatchSegment` (pad-with-zero, integer-only, max-4-segments).
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1 | 0 | 1}
 */
function compareVersions(a, b) {
  const aSeg = parseVersionToSegments(a);
  const bSeg = parseVersionToSegments(b);
  for (let i = 0; i < 4; i++) {
    if (aSeg[i] < bSeg[i]) return -1;
    if (aSeg[i] > bSeg[i]) return 1;
  }
  return 0;
}

async function bumpSolutionVersion({ envUrl, uniqueName, solutionId, token, dryRun = false, projectRoot = null }) {
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

  // Best-effort: update .solution-manifest.json so its `version` field tracks
  // the just-bumped Dataverse state. Without this, the manifest drifts behind
  // every bump — validated against a real Citizens portal deploy where the
  // manifest sat at 1.0.0.2 while Dataverse had reached 1.0.0.4.
  const manifestUpdate = updateManifestVersion(projectRoot, {
    solutionId: resolvedSolutionId,
    uniqueName: resolvedUniqueName,
    nextVersion: next,
  });

  return {
    solutionId: resolvedSolutionId,
    uniqueName: resolvedUniqueName,
    previous: currentVersion,
    next,
    bumped: true,
    manifestUpdated: manifestUpdate.updated,
    manifestUpdateReason: manifestUpdate.updated ? null : manifestUpdate.reason,
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

module.exports = { bumpSolutionVersion, bumpPatchSegment, parseVersionToSegments, compareVersions, updateManifestVersion };
