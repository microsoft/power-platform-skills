#!/usr/bin/env node

// Executes the `CommitToGit` OData action, then polls pending Changes until
// the post-commit invariant holds (count drops to 0) or times out.
//
// API reference: references/git-integration-api-patterns.md §5
//   POST {envUrl}/api/data/v9.2/CommitToGit
//   Body: { CommitMessage, SolutionUniqueName }
//   Returns: CommitToGitResponse { CommitId: string, Type: int }   (200 OK)
//
// CommitToGit is the ONLY action of the 5 that returns a non-204 response.
//
// Output (JSON to stdout):
//   Success: {
//     committed: true,
//     commitId: "<git sha>",
//     type: <int>,
//     solutionUniqueName, commitMessage,
//     polled: { reached: true, attempts: N, elapsedMs: M, finalValue: { changesCount: 0 } } | null,
//     calledAt: "<ISO>",
//   }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node commit-to-git.js
//       --envUrl              <url>
//       --solutionUniqueName  <name>
//       --commitMessage       "<message>"
//       [--token              <dvToken>]
//       [--skipPoll]                         // return immediately after the POST
//       [--pollIntervalMs     <number>]      // default 3000
//       [--pollMaxAttempts    <number>]      // default 40 (≈2 min @ 3s)
//
// PRECONDITION: pending Changes count must be > 0. The commit-to-git skill
// enforces this in Phase 2 by calling list-pending-changes.js first; this
// helper does NOT re-check (deterministic helpers stay scoped).
//
// TODO: HAR-verify — the 200 response shape (CommitToGitResponse) and the
// poll target (does the platform also expose a per-commit async operation
// to poll, or is post-commit list-pending-changes the only signal?).

'use strict';

const { getAuthToken, makeRequest } = require('./validation-helpers');
const { listPendingChanges } = require('./list-pending-changes');
const { pollGitOperation } = require('./poll-git-operation');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null,
    solutionUniqueName: null, commitMessage: null,
    skipPoll: false, pollIntervalMs: 3000, pollMaxAttempts: 40,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--commitMessage' && args[i + 1]) out.commitMessage = args[++i];
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
async function commitToGit({
  envUrl, token,
  solutionUniqueName, commitMessage,
  skipPoll = false,
  pollIntervalMs = 3000,
  pollMaxAttempts = 40,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!solutionUniqueName) throw new Error('--solutionUniqueName is required');
  if (!commitMessage) throw new Error('--commitMessage is required');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  const apiUrl = `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/CommitToGit`;
  const body = JSON.stringify({
    CommitMessage: commitMessage,
    SolutionUniqueName: solutionUniqueName,
  });

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
  if (res.statusCode !== 200) {
    let msg = `HTTP ${res.statusCode}`;
    let code = null;
    try {
      const parsed = JSON.parse(res.body);
      msg = parsed.error?.message || msg;
      code = parsed.error?.code || null;
    } catch {}
    return { error: msg, statusCode: res.statusCode, errorCode: code };
  }

  let parsed;
  try { parsed = JSON.parse(res.body); } catch (e) {
    return { error: 'CommitToGit returned 200 but body was not JSON: ' + e.message };
  }
  // TODO: HAR-verify field casing. Microsoft Learn references the response as
  // CommitToGitResponse with `CommitId` + `Type`; OData sometimes lower-cases.
  const commitId = parsed.CommitId || parsed.commitid || null;
  const type = typeof parsed.Type === 'number' ? parsed.Type : (parsed.type ?? null);

  const result = {
    committed: true,
    commitId,
    type,
    solutionUniqueName,
    commitMessage,
    polled: null,
    calledAt: new Date().toISOString(),
  };

  if (skipPoll) return result;

  // Poll until pending Changes drops to 0 (post-commit invariant).
  const poll = await pollGitOperation({
    intervalMs: pollIntervalMs,
    maxAttempts: pollMaxAttempts,
    check: async () => {
      const pending = await listPendingChanges({ envUrl, token: tok, solutionUniqueName });
      if (pending.error) {
        // Don't throw — let the poll continue; the next attempt might succeed.
        return { done: false, value: { error: pending.error } };
      }
      return { done: pending.count === 0, value: { changesCount: pending.count } };
    },
  });

  result.polled = poll;
  if (!poll.reached) {
    result.pollWarning = 'CommitToGit returned 200 but pending Changes did not drop to 0 within the timeout. ' +
      'The commit may still be processing — re-check via plan-inner-loop.';
  }
  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  commitToGit(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('commit-to-git: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { commitToGit };
