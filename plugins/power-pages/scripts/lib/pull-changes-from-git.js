#!/usr/bin/env node

// Executes the `PullChangesFromGit` OData action — applies the incoming
// Updates from the bound ADO branch into the Dataverse environment. After
// success, polls until the Updates count drops to 0.
//
// API reference: references/git-integration-api-patterns.md §7
//   POST {envUrl}/api/data/v9.2/PullChangesFromGit
//   Body — default:
//     { SolutionUniqueName }
//   Body — hard-delete (DANGER, gated):
//     { SolutionUniqueName, AdditionalParameters: { DeleteDeletedComponents: true } }
//   Response: 204 No Content
//
// PRECONDITIONS (caller must enforce — this helper does NOT re-check):
//   1. RefreshChangesFromGit ran first (so Updates tab is populated)
//   2. Conflicts count is 0 (otherwise the action errors out — resolve first)
//
// Output (JSON to stdout):
//   Success: {
//     pulled: true,
//     solutionUniqueName, deletedDeletedComponents: bool,
//     polled: { reached: bool, attempts, elapsedMs, finalValue: { updatesCount: 0 } } | null,
//     calledAt: "<ISO>",
//   }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node pull-changes-from-git.js
//       --envUrl              <url>
//       --solutionUniqueName  <name>
//       [--token              <dvToken>]
//       [--deleteDeletedComponents]    // hard-delete; requires consent gate at skill layer
//       [--skipPoll]                    // return immediately after POST
//       [--pollIntervalMs     <number>] // default 3000
//       [--pollMaxAttempts    <number>] // default 60 (≈3 min @ 3s)

'use strict';

const { getAuthToken, makeRequest } = require('./validation-helpers');
const { listIncomingUpdates } = require('./list-incoming-updates');
const { pollGitOperation } = require('./poll-git-operation');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null,
    solutionUniqueName: null,
    deleteDeletedComponents: false,
    skipPoll: false, pollIntervalMs: 3000, pollMaxAttempts: 60,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--deleteDeletedComponents') out.deleteDeletedComponents = true;
    else if (args[i] === '--skipPoll') out.skipPoll = true;
    else if (args[i] === '--pollIntervalMs' && args[i + 1]) out.pollIntervalMs = parseInt(args[++i], 10);
    else if (args[i] === '--pollMaxAttempts' && args[i + 1]) out.pollMaxAttempts = parseInt(args[++i], 10);
  }
  return out;
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function pullChangesFromGit({
  envUrl, token,
  solutionUniqueName,
  deleteDeletedComponents = false,
  skipPoll = false,
  pollIntervalMs = 3000,
  pollMaxAttempts = 60,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!solutionUniqueName) throw new Error('--solutionUniqueName is required');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  const apiUrl = `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/PullChangesFromGit`;
  const bodyObj = { SolutionUniqueName: solutionUniqueName };
  if (deleteDeletedComponents) {
    bodyObj.AdditionalParameters = { DeleteDeletedComponents: true };
  }

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

  const result = {
    pulled: true,
    solutionUniqueName,
    deletedDeletedComponents: deleteDeletedComponents,
    polled: null,
    calledAt: new Date().toISOString(),
  };

  if (skipPoll) return result;

  const poll = await pollGitOperation({
    intervalMs: pollIntervalMs,
    maxAttempts: pollMaxAttempts,
    check: async () => {
      const upd = await listIncomingUpdates({ envUrl, token: tok, solutionUniqueName });
      if (upd.error) return { done: false, value: { error: upd.error } };
      return { done: upd.count === 0, value: { updatesCount: upd.count } };
    },
  });
  result.polled = poll;
  if (!poll.reached) {
    result.pollWarning = 'PullChangesFromGit returned 2xx but Updates did not drop to 0 within the timeout. ' +
      'The pull may still be processing; re-check via plan-inner-loop.';
  }
  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  pullChangesFromGit(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('pull-changes-from-git: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { pullChangesFromGit };
