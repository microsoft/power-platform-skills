#!/usr/bin/env node

// Discards all pending Changes in the Dataverse workspace for a Git-bound
// solution. After success, polls until the pending Changes count drops to 0.
//
// Use cases (from architecture doc §5 Skill 9):
//   - User made experimental edits and wants to throw them away
//   - User wants to switch branches and the source-branch workspace must be clean
//   - User wants to start a fresh sync from Git after a botched local change
//
// API reference: references/git-integration-api-patterns.md §8 (Workspace ops)
//
// TODO: HAR-verify — Microsoft Learn does not publish a documented OData
// action for "discard all pending Changes". The action name below is a
// reasonable guess based on the surface-area naming convention; HAR capture
// against the maker portal's "Revert workspace" button is needed to confirm.
//
// Two plausible shapes:
//   Variant A: POST .../RevertGitWorkspace      Body: { SolutionUniqueName }
//   Variant B: POST .../DiscardPendingChanges   Body: { SolutionUniqueName }
//
// This helper implements Variant A by default; --action lets the skill layer
// swap if HAR proves otherwise without code changes here.
//
// Output (JSON to stdout):
//   Success: {
//     reverted: true,
//     solutionUniqueName,
//     polled: { reached: bool, ... } | null,
//     calledAt: "<ISO>",
//   }
//   Failure: { error, statusCode?, errorCode? }
//
// Usage:
//   node revert-workspace.js
//       --envUrl              <url>
//       --solutionUniqueName  <name>
//       [--token              <dvToken>]
//       [--action             <name>]    // default RevertGitWorkspace
//       [--skipPoll]
//       [--pollIntervalMs     <number>]  // default 3000
//       [--pollMaxAttempts    <number>]  // default 30 (≈90s @ 3s)

'use strict';

const { getAuthToken, makeRequest } = require('./validation-helpers');
const { listPendingChanges } = require('./list-pending-changes');
const { pollGitOperation } = require('./poll-git-operation');

const DEFAULT_ACTION = 'RevertGitWorkspace'; // TODO: HAR-verify

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null,
    solutionUniqueName: null,
    action: DEFAULT_ACTION,
    skipPoll: false, pollIntervalMs: 3000, pollMaxAttempts: 30,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--action' && args[i + 1]) out.action = args[++i];
    else if (args[i] === '--skipPoll') out.skipPoll = true;
    else if (args[i] === '--pollIntervalMs' && args[i + 1]) out.pollIntervalMs = parseInt(args[++i], 10);
    else if (args[i] === '--pollMaxAttempts' && args[i + 1]) out.pollMaxAttempts = parseInt(args[++i], 10);
  }
  return out;
}

async function revertWorkspace({
  envUrl, token,
  solutionUniqueName,
  action = DEFAULT_ACTION,
  skipPoll = false,
  pollIntervalMs = 3000,
  pollMaxAttempts = 30,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!solutionUniqueName) throw new Error('--solutionUniqueName is required');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  const apiUrl = `${envUrl.replace(/\/+$/, '')}/api/data/v9.2/${action}`;
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
    reverted: true,
    solutionUniqueName,
    action,
    polled: null,
    calledAt: new Date().toISOString(),
  };

  if (skipPoll) return result;

  const poll = await pollGitOperation({
    intervalMs: pollIntervalMs,
    maxAttempts: pollMaxAttempts,
    check: async () => {
      const p = await listPendingChanges({ envUrl, token: tok, solutionUniqueName });
      if (p.error) return { done: false, value: { error: p.error } };
      return { done: p.count === 0, value: { changesCount: p.count } };
    },
  });
  result.polled = poll;
  if (!poll.reached) {
    result.pollWarning = 'RevertGitWorkspace returned 2xx but pending Changes did not drop to 0 within the timeout.';
  }
  return result;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  revertWorkspace(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('revert-workspace: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { revertWorkspace, DEFAULT_ACTION };
