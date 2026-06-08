#!/usr/bin/env node

// Resolves a single Git-integration conflict by KEEPING the environment's
// version (rejecting the incoming Git change for that component).
//
// This is a per-conflict OData action. The matching resolve-conflict-accept.js
// helper does the opposite (take Git's version, overwrite env's).
//
// API reference: references/git-integration-api-patterns.md §8 (Conflict resolution)
//
// TODO: HAR-verify — the exact action name. Microsoft Learn documents the
// Connect-to-Git surface area at a feature level but does NOT publish a full
// OData action signature for the per-conflict resolve calls. The action name
// below is a best-guess based on the public API naming convention; the body
// shape (target conflict identifier + outcome flag) is also conjectural until
// a tenant HAR confirms it.
//
// Two plausible shapes seen in similar Power Platform APIs:
//   Variant A (single action with outcome enum):
//     POST {envUrl}/api/data/v9.2/ResolveGitConflict
//     Body: { ConflictId: "<id>", Resolution: 0 /* keep env */ }
//   Variant B (paired actions):
//     POST {envUrl}/api/data/v9.2/KeepEnvironmentVersion
//     Body: { ConflictId: "<id>" }
//
// This helper implements Variant A by default and exposes --action to swap
// in Variant B without changing skill-layer code.
//
// Output (JSON to stdout):
//   Success: { resolved: true, conflictId, outcome: "keep-environment", calledAt }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node resolve-conflict-keep.js
//       --envUrl              <url>
//       --conflictId          <id>
//       [--solutionUniqueName <name>]    // forwarded if API requires it
//       [--token              <dvToken>]
//       [--action             <name>]    // default ResolveGitConflict; override for variant B

'use strict';

const { getAuthToken, makeRequest } = require('./validation-helpers');

const RESOLUTION_KEEP_ENV = 0;
const DEFAULT_ACTION = 'ResolveGitConflict'; // TODO: HAR-verify

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null,
    conflictId: null, solutionUniqueName: null,
    action: DEFAULT_ACTION,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--conflictId' && args[i + 1]) out.conflictId = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--action' && args[i + 1]) out.action = args[++i];
  }
  return out;
}

async function resolveConflictKeep({
  envUrl, token, conflictId, solutionUniqueName, action = DEFAULT_ACTION,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!conflictId) throw new Error('--conflictId is required');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  const apiUrl = `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/${action}`;
  const bodyObj = { ConflictId: conflictId, Resolution: RESOLUTION_KEEP_ENV };
  if (solutionUniqueName) bodyObj.SolutionUniqueName = solutionUniqueName;

  const res = await makeRequest({
    url: apiUrl,
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok}`,
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(bodyObj),
  });

  if (res.error) return { error: res.error };
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try {
      const parsed = JSON.parse(res.body);
      msg = parsed.error?.message || msg;
      code = parsed.error?.code || null;
    } catch {}
    return { error: msg, statusCode: res.statusCode, errorCode: code };
  }

  return {
    resolved: true,
    conflictId,
    outcome: 'keep-environment',
    action,
    calledAt: new Date().toISOString(),
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  resolveConflictKeep(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('resolve-conflict-keep: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { resolveConflictKeep, RESOLUTION_KEEP_ENV, DEFAULT_ACTION };
