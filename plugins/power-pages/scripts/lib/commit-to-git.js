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
//      (--commitMessage       "<message>"   |  --commitMessageFile <path>)
//       [--workItemId         <number>]      // Adds "AB#<n>" footer if provided
//       [--token              <dvToken>]
//       [--skipPoll]                         // return immediately after the POST
//       [--pollIntervalMs     <number>]      // default 3000
//       [--pollMaxAttempts    <number>]      // default 40 (≈2 min @ 3s)
//       [--pollBackoff        linear|exponential]  // default linear; exponential
//                                                  // schedules sleep = intervalMs * 2^(attempt-1)
//                                                  // capped at 30s (see poll-git-operation.js).
//       [--background]                       // POST returns immediately; a detached
//                                            // child polls and writes last-commit.json
//                                            // on completion. Requires --projectRoot
//                                            // (or relies on cwd) to place the
//                                            // pending-commit-ticket.json + last-commit.json.
//       [--ticketFile <path>]                // override ticket file location
//                                            // (default <projectRoot>/docs/inner-loop/
//                                            //  pending-commit-ticket.json)
//       [--projectRoot <path>]               // anchor for inner-loop artifacts
//
// PRECONDITION: pending Changes count must be > 0. The commit-to-git skill
// enforces this in Phase 2 by calling list-pending-changes.js first; this
// helper does NOT re-check (deterministic helpers stay scoped).
//
// TODO: HAR-verify — the 200 response shape (CommitToGitResponse) and the
// poll target (does the platform also expose a per-commit async operation
// to poll, or is post-commit list-pending-changes the only signal?).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getAuthToken, makeRequest, LONG_RUNNING_GIT_ACTION_TIMEOUT_MS } = require('./validation-helpers');
const { listPendingChanges } = require('./list-pending-changes');
const { pollGitOperation } = require('./poll-git-operation');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null,
    solutionUniqueName: null, commitMessage: null,
    skipPoll: false, pollIntervalMs: 3000, pollMaxAttempts: 40,
    pollBackoff: 'linear',
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--commitMessage' && args[i + 1]) out.commitMessage = args[++i];
    else if (args[i] === '--commitMessageFile' && args[i + 1]) out.commitMessageFile = args[++i];
    else if (args[i] === '--workItemId' && args[i + 1]) out.workItemId = args[++i];
    else if (args[i] === '--skipPoll') out.skipPoll = true;
    else if (args[i] === '--pollIntervalMs' && args[i + 1]) out.pollIntervalMs = parseInt(args[++i], 10);
    else if (args[i] === '--pollMaxAttempts' && args[i + 1]) out.pollMaxAttempts = parseInt(args[++i], 10);
    else if (args[i] === '--pollBackoff' && args[i + 1]) out.pollBackoff = args[++i];
    else if (args[i] === '--background') out.background = true;
    else if (args[i] === '--ticketFile' && args[i + 1]) out.ticketFile = args[++i];
    else if (args[i] === '--projectRoot' && args[i + 1]) out.projectRoot = args[++i];
    else if (args[i] === '--commitId' && args[i + 1]) out.commitId = args[++i];
    else if (args[i] === '--__bg-poll-child') out.__bgPollChild = true;
  }
  return out;
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function commitToGit({
  envUrl, token,
  solutionUniqueName, commitMessage, commitMessageFile, workItemId,
  skipPoll = false,
  pollIntervalMs = 3000,
  pollMaxAttempts = 40,
  pollBackoff = 'linear',
  background = false,
  ticketFile = null,
  projectRoot = null,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!solutionUniqueName) throw new Error('--solutionUniqueName is required');

  // C-6: resolve commit message from inline arg OR file path. Mutually exclusive.
  if (commitMessage && commitMessageFile) {
    throw new Error('--commitMessage and --commitMessageFile are mutually exclusive');
  }
  if (!commitMessage && commitMessageFile) {
    try {
      commitMessage = fs.readFileSync(path.resolve(commitMessageFile), 'utf8').replace(/\r\n/g, '\n').trim();
    } catch (e) {
      throw new Error(`--commitMessageFile could not be read: ${e.message}`);
    }
    if (!commitMessage) {
      throw new Error(`--commitMessageFile is empty after stripping whitespace: ${commitMessageFile}`);
    }
  }
  if (!commitMessage) throw new Error('--commitMessage (or --commitMessageFile) is required');

  // C-8: append work-item linking footer if provided. Validate strictly — the
  // Azure Boards link parser silently drops bogus IDs so we surface them here.
  if (workItemId != null && workItemId !== '') {
    const wid = String(workItemId).trim();
    if (!/^\d+$/.test(wid)) {
      throw new Error(`--workItemId must be a positive integer (got: ${workItemId})`);
    }
    const footer = `AB#${wid}`;
    if (!commitMessage.includes(footer)) {
      commitMessage = `${commitMessage}\n\n${footer}`;
    }
  }

  if (pollBackoff !== 'linear' && pollBackoff !== 'exponential') {
    throw new Error(`--pollBackoff must be 'linear' or 'exponential' (got: ${pollBackoff})`);
  }

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
    // CommitToGit blocks server-side until every component is written to ADO —
    // ~25 s for a small first-commit, 5–15 min for a 1000+ component solution
    // (references/inner-loop-empirical-findings.md §3 / §10). The helper's
    // default 15 s socket timeout would misread a slow-but-successful reply
    // as { error: 'Request timed out' } and Phase 6 of the commit-to-git skill
    // would bail before Phase 7's pending-count poll could detect success.
    socketTimeoutMs: LONG_RUNNING_GIT_ACTION_TIMEOUT_MS,
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

  // C-17: --background mode. Fork a detached poller, write a ticket file with
  // the spawned PID + commitId, and return immediately. The detached child
  // re-runs commit-to-git.js with --skipBackground polling and writes
  // last-commit.json once the pending-count clears.
  if (background) {
    const detachedResult = await runBackgroundPoll({
      result, ticketFile, projectRoot,
      envUrl, token: tok, solutionUniqueName,
      pollIntervalMs, pollMaxAttempts, pollBackoff,
    });
    return detachedResult;
  }

  // Poll until pending Changes drops to 0 (post-commit invariant).
  const poll = await pollGitOperation({
    intervalMs: pollIntervalMs,
    maxAttempts: pollMaxAttempts,
    backoff: pollBackoff,
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

// --- C-17: --background mode --------------------------------------------------
//
// Flow:
//   1) Parent: POST CommitToGit → got commitId. Write ticket file at
//      <projectRoot>/docs/inner-loop/pending-commit-ticket.json with
//      { commitId, pollPid: <to-be-filled>, startedAt, ticketFile }.
//   2) Parent: spawn detached child running the same script with a new
//      --__bg-poll-child flag (internal) + the operational params it needs
//      to poll and write last-commit.json. Hand back the ticket payload
//      including the spawned PID.
//   3) Child: listPendingChanges loop with the requested cadence. When count
//      drops to 0 (or maxAttempts exhausted), write last-commit.json with
//      { status: succeeded|poll-timeout, polled: {...} } and delete the
//      ticket file. Child exits.
//
// Note: we deliberately do NOT use the orchestrator's pollGitOperation here
// because the parent already imported it for the foreground path. The child
// process re-imports it via the same require chain when it runs the
// __bg-poll-child branch below.

const PROJECT_ROOT_DEFAULT = process.cwd;

function resolveTicketPath({ ticketFile, projectRoot }) {
  if (ticketFile) return path.resolve(ticketFile);
  if (projectRoot) {
    const { ensureInnerLoopDir, innerLoopPath } = require('./inner-loop-paths');
    ensureInnerLoopDir(projectRoot);
    return innerLoopPath(projectRoot, 'pendingCommitTicket');
  }
  // Fallback: cwd/docs/inner-loop/pending-commit-ticket.json
  const root = PROJECT_ROOT_DEFAULT();
  const { ensureInnerLoopDir, innerLoopPath } = require('./inner-loop-paths');
  ensureInnerLoopDir(root);
  return innerLoopPath(root, 'pendingCommitTicket');
}

async function runBackgroundPoll({
  result, ticketFile, projectRoot,
  envUrl, token, solutionUniqueName,
  pollIntervalMs, pollMaxAttempts, pollBackoff,
}) {
  const { spawn } = require('node:child_process');
  const ticketPath = resolveTicketPath({ ticketFile, projectRoot });
  const startedAt = new Date().toISOString();

  // First write a ticket *without* the pollPid so we have on-disk evidence
  // even if the spawn fails. We'll overwrite with pollPid after spawn().
  const ticket0 = {
    skill: 'commit-to-git',
    commitId: result.commitId,
    solutionUniqueName,
    envUrl,
    startedAt,
    pollPid: null,
    pollIntervalMs,
    pollMaxAttempts,
    pollBackoff,
    status: 'background-polling',
    note: 'Foreground call returned immediately. A detached child is polling pending-changes; last-commit.json appears here when the count clears.',
  };
  fs.writeFileSync(ticketPath, JSON.stringify(ticket0, null, 2));

  const child = spawn(
    process.execPath,
    [
      __filename,
      '--__bg-poll-child',
      '--envUrl', envUrl,
      '--token', token,
      '--solutionUniqueName', solutionUniqueName,
      '--commitId', String(result.commitId),
      '--pollIntervalMs', String(pollIntervalMs),
      '--pollMaxAttempts', String(pollMaxAttempts),
      '--pollBackoff', pollBackoff,
      '--ticketFile', ticketPath,
      ...(projectRoot ? ['--projectRoot', projectRoot] : []),
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );

  // We don't await the child; we just record its PID.
  child.unref();

  const ticket1 = { ...ticket0, pollPid: child.pid };
  fs.writeFileSync(ticketPath, JSON.stringify(ticket1, null, 2));

  return {
    ...result,
    background: true,
    pollPid: child.pid,
    ticketFile: ticketPath,
    polled: null,
    pollWarning: null,
  };
}

// Internal entrypoint used by the detached child spawned by runBackgroundPoll.
// Polls pending-changes until count reaches 0 (or maxAttempts exhausted),
// writes <projectRoot>/docs/inner-loop/last-commit.json with the outcome,
// and deletes the ticket file.
async function runBackgroundChild(args) {
  const ticketPath = args.ticketFile;
  if (!ticketPath || !fs.existsSync(ticketPath)) {
    process.stderr.write('commit-to-git --__bg-poll-child: ticket file missing\n');
    process.exit(2);
  }
  let ticket;
  try { ticket = JSON.parse(fs.readFileSync(ticketPath, 'utf8')); } catch (e) {
    process.stderr.write('commit-to-git --__bg-poll-child: ticket parse error: ' + e.message + '\n');
    process.exit(2);
  }

  const startedAtMs = Date.now();
  const poll = await pollGitOperation({
    intervalMs: parseInt(args.pollIntervalMs, 10) || 3000,
    maxAttempts: parseInt(args.pollMaxAttempts, 10) || 40,
    backoff: args.pollBackoff || 'linear',
    check: async () => {
      const pending = await listPendingChanges({
        envUrl: args.envUrl, token: args.token,
        solutionUniqueName: args.solutionUniqueName,
      });
      if (pending.error) return { done: false, value: { error: pending.error } };
      return { done: pending.count === 0, value: { changesCount: pending.count } };
    },
  });

  const outcome = {
    skill: 'commit-to-git',
    mode: 'background',
    committedAt: ticket.startedAt,
    backgroundCompletedAt: new Date().toISOString(),
    envUrl: args.envUrl,
    solutionUniqueName: args.solutionUniqueName,
    commitId: args.commitId,
    polled: poll,
    backgroundElapsedMs: Date.now() - startedAtMs,
    status: poll.reached ? 'succeeded' : 'poll-timeout',
  };

  if (args.projectRoot) {
    const { ensureInnerLoopDir, innerLoopPath } = require('./inner-loop-paths');
    ensureInnerLoopDir(args.projectRoot);
    const lcPath = innerLoopPath(args.projectRoot, 'lastCommit');
    fs.writeFileSync(lcPath, JSON.stringify(outcome, null, 2));
  }

  // Delete the ticket file — the run is done.
  try { fs.unlinkSync(ticketPath); } catch { /* best-effort */ }
}

if (require.main === module) {
  // Detached-child branch (internal, not user-facing).
  if (process.argv.includes('--__bg-poll-child')) {
    const childArgs = parseArgs(process.argv);
    runBackgroundChild(childArgs)
      .then(() => process.exit(0))
      .catch((e) => {
        process.stderr.write('commit-to-git --__bg-poll-child: ' + e.message + '\n');
        process.exit(1);
      });
  } else {
    const args = parseArgs(process.argv);
    commitToGit(args)
      .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
      .catch((e) => {
        process.stderr.write('commit-to-git: ' + e.message + '\n');
        process.exit(1);
      });
  }
}

module.exports = { commitToGit, runBackgroundChild };
