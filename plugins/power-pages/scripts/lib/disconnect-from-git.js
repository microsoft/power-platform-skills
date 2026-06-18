#!/usr/bin/env node

// Disconnects the current Dataverse environment (or a specific solution) from
// its bound ADO repository via the `DisconnectFromGit` OData action.
//
// API reference: references/git-integration-api-patterns.md §4
//   POST {envUrl}/api/data/v9.2/DisconnectFromGit
//   Body: {} for env disconnect, { SolutionUniqueName } for solution disconnect
//   Response: 204 No Content
//
// Output (JSON to stdout):
//   Success: {
//     disconnected: true,
//     scope: "environment" | "solution",
//     solutionUniqueName: "<name>" | null,
//     calledAt: "<ISO>",
//     verifiedUnbound: true | false,    // populated when --verify is set
//   }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node disconnect-from-git.js
//       --envUrl <url>
//       [--solutionUniqueName <name>]   // omit to disconnect entire env
//       [--token <dvToken>]
//       [--verify]                       // run detect-git-binding.js after
//
// SAFETY: Disconnecting an env unbinds ALL solutions in that env. Disconnecting
// a single solution leaves other bindings intact. Callers (skills) MUST gate
// this on a `consent`-category Approval Gate before invoking.

'use strict';

const { getAuthToken, makeRequest, LONG_RUNNING_GIT_ACTION_TIMEOUT_MS } = require('./validation-helpers');
const { detectGitBinding } = require('./detect-git-binding');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, solutionUniqueName: null, verify: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--verify') out.verify = true;
  }
  return out;
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function disconnectFromGit({ envUrl, token, solutionUniqueName = null, verify = false } = {}) {
  if (!envUrl) throw new Error('--envUrl is required');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  const base = envUrl.replace(/\/+$/, '');
  const apiUrl = `${base}/api/data/v9.2/DisconnectFromGit`;
  const scope = solutionUniqueName ? 'solution' : 'environment';
  const body = JSON.stringify(solutionUniqueName ? { SolutionUniqueName: solutionUniqueName } : {});

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
    body,
    // DisconnectFromGit usually returns in seconds, but on an env with many
    // staged components it can take 30 s+ to tear down server-side. Use the
    // long-running override defensively so a slow tenant does not surface a
    // misleading "Request timed out" right when the user is trying to unbind.
    socketTimeoutMs: LONG_RUNNING_GIT_ACTION_TIMEOUT_MS,
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

  const result = {
    disconnected: true,
    scope,
    solutionUniqueName: solutionUniqueName || null,
    calledAt: new Date().toISOString(),
    verifiedUnbound: null,
  };

  if (verify) {
    const binding = await detectGitBinding({
      envUrl,
      token: tok,
      solutionUniqueName: solutionUniqueName || undefined,
    });
    if (!binding.bound) {
      result.verifiedUnbound = true;
      result.verifiedAt = new Date().toISOString();
    } else {
      result.verifiedUnbound = false;
      result.verifyWarning = 'DisconnectFromGit returned 2xx but detect-git-binding still sees a binding. ' +
        'For solution disconnect this may mean OTHER solutions remain bound; check via plan-inner-loop.';
    }
  }

  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  disconnectFromGit(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('disconnect-from-git: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { disconnectFromGit };
