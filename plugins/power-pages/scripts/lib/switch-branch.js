#!/usr/bin/env node

// Switches the bound branch on the current Dataverse environment binding by
// chaining disconnect + reconnect. Used by the `branch-switch` skill.
//
// The platform only allows one bound branch per env at a time, so a branch
// switch is implemented as: disconnectFromGit → connectToGit(newBranch).
// This helper handles the orchestration and rolls back to the original branch
// if the reconnect fails (best-effort).
//
// PRECONDITION: Workspace must be clean (no Changes / no Updates / no Conflicts).
// The branch-switch skill enforces this in its Phase 1 hard-stop gate; this
// helper does NOT re-check (deterministic helpers stay scoped to a single
// API call, not policy enforcement).
//
// Output (JSON to stdout):
//   Success: {
//     switched: true,
//     previousBranch: "<old>",
//     newBranch: "<new>",
//     organization, project, repository, gitFolder,
//     disconnectedAt: "<ISO>",
//     reconnectedAt: "<ISO>",
//   }
//   Failure (during disconnect): { error: "<msg>", phase: "disconnect" }
//   Failure (during reconnect):  { error: "<msg>", phase: "reconnect",
//                                  rolledBack: true | false,
//                                  rollbackError?: "<msg>" }
//
// Usage:
//   node switch-branch.js
//       --envUrl    <url>
//       --newBranch <branch>
//       [--token    <dvToken>]
//
// Inherits org/project/repo/gitFolder from the existing binding — no need to
// pass them. If no binding exists, returns an error (caller should run
// setup-git-integration instead).

'use strict';

const { getAuthToken } = require('./validation-helpers');
const { detectGitBinding } = require('./detect-git-binding');
const { disconnectFromGit } = require('./disconnect-from-git');
const { connectToGit } = require('./connect-to-git');

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, newBranch: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--newBranch' && args[i + 1]) out.newBranch = args[++i];
  }
  return out;
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function switchBranch({ envUrl, token, newBranch } = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!newBranch) throw new Error('--newBranch is required');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  // Step 1 — read current binding so we can roll back if reconnect fails.
  const current = await detectGitBinding({ envUrl, token: tok });
  if (current.error) return { error: 'Pre-check failed: ' + current.error };
  if (!current.bound) {
    return {
      error: 'No existing Git binding found. Use setup-git-integration to create one first.',
    };
  }
  if (current.bindingType !== 'environment') {
    return {
      error: `switch-branch only supports environment bindings; found "${current.bindingType}". ` +
        'For solution bindings, disconnect and reconnect the specific solution manually.',
    };
  }
  if (current.branch === newBranch) {
    return {
      error: `Already bound to branch "${newBranch}". No switch needed.`,
    };
  }

  const previousBranch = current.branch;
  const { organization, project, repository, gitFolder } = current;

  // Step 2 — disconnect.
  const dis = await disconnectFromGit({ envUrl, token: tok });
  if (dis.error) {
    return { error: dis.error, phase: 'disconnect' };
  }
  const disconnectedAt = dis.calledAt;

  // Step 3 — reconnect with the new branch.
  const reconn = await connectToGit({
    envUrl, token: tok,
    organization, project, repository,
    branch: newBranch, gitFolder,
  });
  if (reconn.error) {
    // Roll back to the original branch — best-effort.
    let rolledBack = false;
    let rollbackError = null;
    const rollback = await connectToGit({
      envUrl, token: tok,
      organization, project, repository,
      branch: previousBranch, gitFolder,
    });
    if (rollback.bound) {
      rolledBack = true;
    } else {
      rollbackError = rollback.error || 'Rollback ConnectToGit returned non-success.';
    }
    return {
      error: reconn.error,
      phase: 'reconnect',
      rolledBack,
      rollbackError,
      previousBranch,
      attemptedBranch: newBranch,
    };
  }

  return {
    switched: true,
    previousBranch,
    newBranch,
    organization,
    project,
    repository,
    gitFolder,
    disconnectedAt,
    reconnectedAt: reconn.calledAt,
  };
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  switchBranch(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('switch-branch: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { switchBranch };
