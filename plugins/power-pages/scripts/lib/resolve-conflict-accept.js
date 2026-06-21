#!/usr/bin/env node

// Resolves a single Git-integration conflict by ACCEPTING the incoming Git
// version (overwriting the environment's component with what's in Git).
//
// Pair of resolve-conflict-keep.js. See that helper's header for the variant-A
// vs variant-B discussion and the // TODO: HAR-verify notes.
//
// Output (JSON to stdout):
//   Success: { resolved: true, conflictId, outcome: "accept-incoming", via, calledAt }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node resolve-conflict-accept.js
//       --envUrl              <url>
//       --conflictId          <id>
//       [--solutionUniqueName <name>]
//       [--solutionId         <id>]      // with --componentId enables useraction path
//       [--componentId        <id>]      // Power Pages component id
//       [--token              <dvToken>]
//       [--action             <name>]    // default ResolveGitConflict; override for variant B

'use strict';

const { getAuthToken, makeRequest } = require('./validation-helpers');
const { resolveGitConflictUserAction } = require('./resolve-git-conflict-useraction');
const { tryResolveViaUserAction, resolveViaAction } = require('./resolve-conflict-common');

const RESOLUTION_ACCEPT_INCOMING = 1;
const DEFAULT_ACTION = 'ResolveGitConflict'; // TODO: HAR-verify

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null,
    conflictId: null, solutionUniqueName: null,
    componentId: null, solutionId: null,
    action: DEFAULT_ACTION,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--conflictId' && args[i + 1]) out.conflictId = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--componentId' && args[i + 1]) out.componentId = args[++i];
    else if (args[i] === '--solutionId' && args[i + 1]) out.solutionId = args[++i];
    else if (args[i] === '--action' && args[i + 1]) out.action = args[++i];
  }
  return out;
}

/**
 * Resolve one Git conflict by accepting the incoming Git version.
 * Uses the sourcecontrolcomponent useraction path when identifiers are available,
 * then falls back to the legacy ResolveGitConflict action for compatibility.
 * @param {object} options
 * @returns {Promise<object>}
 */
async function resolveConflictAccept({
  envUrl, token, conflictId, solutionUniqueName, componentId, solutionId, action = DEFAULT_ACTION,
  deps = {}, _resolveUserAction,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!conflictId) throw new Error('--conflictId is required');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  const resolveUserActionFn = _resolveUserAction || deps.resolveGitConflictUserAction || resolveGitConflictUserAction;
  const makeRequestFn = deps.makeRequest || makeRequest;
  const useraction = await tryResolveViaUserAction({
    envUrl,
    token: tok,
    conflictId,
    solutionId,
    solutionUniqueName,
    componentId,
    decision: 'accept-incoming',
    outcome: 'accept-incoming',
    action,
    resolveUserActionFn,
    makeRequestFn,
  });
  if (useraction) return useraction;

  return resolveViaAction({
    envUrl,
    token: tok,
    conflictId,
    solutionUniqueName,
    action,
    resolution: RESOLUTION_ACCEPT_INCOMING,
    outcome: 'accept-incoming',
    makeRequestFn,
  });
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
