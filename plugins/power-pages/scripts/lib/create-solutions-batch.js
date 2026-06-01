#!/usr/bin/env node

// Parallel bulk creation of Dataverse solutions sharing one publisher.
//
// Used by setup-solution Phase 4 Step 2 in MULTI_SOLUTION_MODE when the split
// plan (docs/alm/alm-split-plan.json) recommends N solutions. Each call is
// independent (distinct uniqueName, shared publisherId, no inter-solution
// dependency), so the batch fans out via Promise.allSettled — typical 5-6
// solution splits complete in ~2s vs ~10s for a serial agent loop.
//
// Usage: node create-solutions-batch.js
//          --envUrl <url>
//          --publisherId <guid>
//          --solutionsFile <path>
//          [--token <token>]
//
// solutionsFile format (JSON array — `isFutureBuffer: true` entries are skipped):
//   [
//     { "uniqueName": "MySite_Core", "friendlyName": "MySite — Core",
//       "version": "1.0.0.0", "description": "..." },
//     { "uniqueName": "MySite_WebAssets", "friendlyName": "MySite — Web Assets",
//       "version": "1.0.0.0", "description": "..." },
//     { "uniqueName": "MySite_Future", "isFutureBuffer": true,        // skipped
//       "friendlyName": "...", "version": "1.0.0.0", "description": "..." }
//   ]
//
// Output (JSON to stdout):
//   {
//     "total": N,                  // entries in the input file
//     "success": N,                // created or already-existed
//     "skipped": N,                // isFutureBuffer: true
//     "failed": N,                 // 409 with no existing record, or thrown error
//     "results": [
//       { "uniqueName": "...", "solutionId": "...", "created": true|false },
//       { "uniqueName": "...", "skipped": true, "reason": "futureBuffer" },
//       { "uniqueName": "...", "error": "..." }
//     ]
//   }
//
// Progress goes to stderr so stdout stays clean for JSON capture.
// Exit 0 always (caller inspects failed/results); exit 1 on fatal setup errors.

'use strict';

const fs = require('fs');
const helpers = require('./validation-helpers');
const { getAuthToken } = helpers;
const { createSolution } = require('./create-solution');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, publisherId: null, solutionsFile: null, token: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--publisherId' && args[i + 1]) out.publisherId = args[++i];
    else if (args[i] === '--solutionsFile' && args[i + 1]) out.solutionsFile = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
  }
  return out;
}

// Best-effort detection of a 401 surfaced by createSolution. The helper
// surfaces 401 via either "Authentication failed" (its dedicated branch) or
// "Unexpected response (401)" (the generic fall-through, used when the 401
// path isn't taken). Match both so the retry path fires regardless of which
// shape Dataverse / the helper chose.
function isAuthFailure(err) {
  const msg = err && err.message ? String(err.message) : '';
  return /Authentication failed/i.test(msg) || /Unexpected response \(401\)/.test(msg);
}

async function createSolutionsBatch({
  envUrl, publisherId, solutionsFile, token, specs,
  // Test seam: a function that returns a fresh token; defaults to
  // getAuthToken(envUrl). Lets tests verify the 401-retry path without
  // shelling out to Azure CLI.
  refreshToken,
}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!publisherId) throw new Error('--publisherId is required');

  // Specs can be passed inline (preferred for tests / programmatic use) or
  // loaded from a JSON file (preferred for CLI invocation from a skill).
  let entries = specs;
  if (!entries) {
    if (!solutionsFile) throw new Error('--solutionsFile is required when specs not provided inline');
    entries = JSON.parse(fs.readFileSync(solutionsFile, 'utf8'));
  }
  if (!Array.isArray(entries)) throw new Error('solutions input must be a JSON array');

  // Initial token. Solutions fan out in parallel and complete in ~2s — no
  // need to re-acquire mid-batch in the happy path. When the cached token
  // was near expiry on entry and we get a 401, the retry path below
  // refreshes once and replays the failed entry.
  const refresh = refreshToken || (() => getAuthToken(envUrl));
  let resolvedToken = token || refresh();
  if (!resolvedToken) throw new Error('Failed to acquire Azure CLI token. Run `az login` first.');

  const results = new Array(entries.length);
  let success = 0;
  let skipped = 0;
  let failed = 0;
  let tokenRefreshed = false;
  // Refresh-token coordination across racing 401s: at most ONE refresh per
  // batch invocation (refreshing twice would mean the second token is also
  // immediately expired — environment problem, not retry-fixable). Subsequent
  // 401s after one refresh are treated as terminal failures.
  let refreshPromise = null;

  async function attemptCreate(spec, idx) {
    if (process.env.DEBUG) {
      process.stderr.write(`create-solutions-batch: starting ${spec.uniqueName}\n`);
    }
    try {
      const res = await createSolution({
        envUrl,
        token: resolvedToken,
        uniqueName: spec.uniqueName,
        friendlyName: spec.friendlyName,
        version: spec.version,
        publisherId,
        description: spec.description || '',
      });
      results[idx] = { uniqueName: res.uniqueName, solutionId: res.solutionId, created: res.created };
      success += 1;
      return;
    } catch (err) {
      if (isAuthFailure(err) && !tokenRefreshed) {
        // Coordinated single-refresh: first racer to hit 401 starts the
        // refresh; all other racers await the same promise so we never
        // double-refresh.
        if (!refreshPromise) {
          refreshPromise = Promise.resolve().then(() => {
            const fresh = refresh();
            if (!fresh) throw new Error('Token refresh failed after 401. Run `az login` again.');
            resolvedToken = fresh;
            tokenRefreshed = true;
            return fresh;
          });
        }
        try {
          await refreshPromise;
        } catch (refreshErr) {
          results[idx] = { uniqueName: spec.uniqueName, error: refreshErr.message };
          failed += 1;
          return;
        }
        // Retry once with the fresh token.
        try {
          const res = await createSolution({
            envUrl,
            token: resolvedToken,
            uniqueName: spec.uniqueName,
            friendlyName: spec.friendlyName,
            version: spec.version,
            publisherId,
            description: spec.description || '',
          });
          results[idx] = { uniqueName: res.uniqueName, solutionId: res.solutionId, created: res.created };
          success += 1;
          return;
        } catch (retryErr) {
          results[idx] = {
            uniqueName: spec.uniqueName,
            error: `Retry after token refresh failed: ${retryErr.message || String(retryErr)}`,
          };
          failed += 1;
          return;
        }
      }
      results[idx] = { uniqueName: spec.uniqueName, error: err && err.message ? err.message : String(err) };
      failed += 1;
    }
  }

  // Build the per-entry promise list. Future-buffer entries resolve
  // immediately with a `skipped` result and never hit Dataverse.
  const tasks = entries.map((spec, idx) => {
    if (spec && spec.isFutureBuffer === true) {
      results[idx] = { uniqueName: spec.uniqueName, skipped: true, reason: 'futureBuffer' };
      skipped += 1;
      return Promise.resolve();
    }
    if (!spec || !spec.uniqueName || !spec.friendlyName || !spec.version) {
      results[idx] = {
        uniqueName: spec && spec.uniqueName,
        error: 'spec missing required fields (uniqueName, friendlyName, version)',
      };
      failed += 1;
      return Promise.resolve();
    }
    return attemptCreate(spec, idx);
  });

  await Promise.all(tasks);

  return { total: entries.length, success, skipped, failed, results, tokenRefreshed };
}

// CLI entry point
if (require.main === module) {
  const args = parseArgs(process.argv);
  createSolutionsBatch(args)
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { createSolutionsBatch };
