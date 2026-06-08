#!/usr/bin/env node

// Executes the `RefreshChangesFromGit` OData action. This is a no-side-effect
// query that asks Dataverse to fetch the latest state from the bound ADO
// branch and populate the Updates and Conflicts tabs.
//
// Must be called BEFORE list-incoming-updates.js or list-conflicts.js — and
// BEFORE pull-changes-from-git.js — otherwise those queries return stale or
// empty data.
//
// API reference: references/git-integration-api-patterns.md §6
//   POST {envUrl}/api/data/v9.2/RefreshChangesFromGit
//   Body: { SolutionUniqueName }
//   Response: 204 No Content
//
// Output (JSON to stdout):
//   Success: {
//     refreshed: true,
//     solutionUniqueName, calledAt: "<ISO>",
//     polled: { reached: bool, ... } | null,    // optional eventual-consistency poll
//   }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node refresh-changes-from-git.js
//       --envUrl              <url>
//       --solutionUniqueName  <name>
//       [--token              <dvToken>]
//       [--waitForPopulation  <seconds>]  // optional: poll until Updates|Conflicts > 0
//                                          // or this many seconds elapse.
//                                          // Useful when caller knows updates exist.

'use strict';

const { getAuthToken, makeRequest } = require('./validation-helpers');
const { listIncomingUpdates } = require('./list-incoming-updates');
const { listConflicts } = require('./list-conflicts');
const { pollGitOperation } = require('./poll-git-operation');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null,
    solutionUniqueName: null, waitForPopulation: 0,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--waitForPopulation' && args[i + 1]) out.waitForPopulation = parseInt(args[++i], 10) || 0;
  }
  return out;
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function refreshChangesFromGit({
  envUrl, token,
  solutionUniqueName,
  waitForPopulation = 0,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!solutionUniqueName) throw new Error('--solutionUniqueName is required');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  const apiUrl = `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/RefreshChangesFromGit`;
  const body = JSON.stringify({ SolutionUniqueName: solutionUniqueName });

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
    refreshed: true,
    solutionUniqueName,
    calledAt: new Date().toISOString(),
    polled: null,
  };

  if (waitForPopulation > 0) {
    // Poll up to `waitForPopulation` seconds for Updates or Conflicts to appear.
    // This is a best-effort eventual-consistency wait; caller is responsible for
    // proceeding with a 0/0 reading if the poll times out (no incoming changes
    // is a valid outcome).
    const intervalMs = 2000;
    const maxAttempts = Math.max(1, Math.ceil(waitForPopulation * 1000 / intervalMs));
    const poll = await pollGitOperation({
      intervalMs,
      maxAttempts,
      check: async () => {
        const [updates, conflicts] = await Promise.all([
          listIncomingUpdates({ envUrl, token: tok, solutionUniqueName }),
          listConflicts({ envUrl, token: tok, solutionUniqueName }),
        ]);
        const uCount = updates.error ? 0 : (updates.count || 0);
        const cCount = conflicts.error ? 0 : (conflicts.count || 0);
        return {
          done: uCount > 0 || cCount > 0,
          value: { updatesCount: uCount, conflictsCount: cCount },
        };
      },
    });
    result.polled = poll;
  }

  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  refreshChangesFromGit(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('refresh-changes-from-git: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { refreshChangesFromGit };
