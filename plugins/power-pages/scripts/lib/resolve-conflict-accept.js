#!/usr/bin/env node

// Resolves a single Git-integration conflict by ACCEPTING the incoming Git
// version (overwriting the environment's component with what's in Git).
//
// Pair of resolve-conflict-keep.js. See that helper's header for the variant-A
// vs variant-B discussion and the // TODO: HAR-verify notes.
//
// Output (JSON to stdout):
//   Success: { resolved: true, conflictId, outcome: "accept-incoming", calledAt }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node resolve-conflict-accept.js
//       --envUrl              <url>
//       --conflictId          <id>
//       [--solutionUniqueName <name>]
//       [--token              <dvToken>]
//       [--action             <name>]    // default ResolveGitConflict; override for variant B

'use strict';

const { getAuthToken, makeRequest } = require('./validation-helpers');

const RESOLUTION_ACCEPT_INCOMING = 1;
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

async function resolveConflictAccept({
  envUrl, token, conflictId, solutionUniqueName, action = DEFAULT_ACTION,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!conflictId) throw new Error('--conflictId is required');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  const apiUrl = `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/${action}`;
  const bodyObj = { ConflictId: conflictId, Resolution: RESOLUTION_ACCEPT_INCOMING };
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
    outcome: 'accept-incoming',
    action,
    calledAt: new Date().toISOString(),
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  resolveConflictAccept(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('resolve-conflict-accept: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { resolveConflictAccept, RESOLUTION_ACCEPT_INCOMING, DEFAULT_ACTION };
