#!/usr/bin/env node

// Switches the bound branch on the current Dataverse Git binding by chaining
// disconnect + reconnect. Used by the `git-configure` skill (switch-branch mode).
//
// Supports BOTH binding shapes:
//
//   • Environment binding (connectiontype=1) — one row per env. Disconnect
//     removes the env's `sourcecontrolconfigurations` + branch-config rows;
//     reconnect via `ConnectToGit` recreates them on the new branch.
//
//   • Solution binding (connectiontype=0) — one row per (solution, folder).
//     Other solutions on the env stay bound. Disconnect removes only the
//     branch-config row for the target solution; reconnect via
//     `connect-solution-to-git` (which detects whether ANY binding remains
//     and routes to the first-vs-subsequent body shape) recreates the
//     per-solution row on the new branch.
//
// The platform only allows one bound branch per (env or solution) at a time,
// so a branch switch is implemented as: disconnect → reconnect(newBranch).
// This helper handles the orchestration and rolls back to the original branch
// if the reconnect fails (best-effort).
//
// SOLUTION-PATH HARDENING:
//   • Auto-picks `solutionUniqueName` when exactly one solution is Git-bound on
//     the env; REQUIRES the caller to pass `--solutionUniqueName` when more
//     than one is bound (e.g. two distinct solutions both bound to the same
//     env).
//   • After `DisconnectFromGit({SolutionUniqueName})`, polls the SOLUTION-SCOPED
//     `detect-git-binding` until the row disappears (max ~90s). Reconnecting
//     too quickly returns 0x80040265 "A disconnect operation is already in
//     progress." from `ValidateEnvironmentReadyForSourceControlOperation`.
//   • Reconnect is wrapped in a small retry loop that retries on the same
//     0x80040265 error code (some races slip past the poll).
//
// PRECONDITION: Workspace must be clean (no Changes / no Updates / no Conflicts).
// The git-configure skill enforces this in its Phase 5 workspace-dirty gate
// (git-configure:5.workspace-dirty); this helper does NOT re-check.
//
// Output (JSON to stdout):
//   Success: {
//     switched: true,
//     bindingType: "environment" | "solution",
//     solutionUniqueName: "<name>" | null,    // populated for solution bindings
//     previousBranch: "<old>",
//     newBranch: "<new>",
//     organization, project, repository, gitFolder,
//     rootFolder: "<folder>" | null,           // populated for solution bindings
//     disconnectedAt: "<ISO>",
//     reconnectedAt: "<ISO>",
//   }
//   Failure (during disconnect): { error: "<msg>", phase: "disconnect" }
//   Failure (during reconnect):  { error: "<msg>", phase: "reconnect",
//                                  rolledBack: true | false,
//                                  rollbackError?: "<msg>",
//                                  previousBranch, attemptedBranch,
//                                  bindingType, solutionUniqueName? }
//   Ambiguous solution binding (multi-bound, no --solutionUniqueName):
//     { error: "<msg>", bindingType: "solution",
//       boundSolutions: ["<name1>", "<name2>", ...] }
//
// Usage:
//   node switch-branch.js
//       --envUrl              <url>
//       --newBranch           <branch>
//       [--solutionUniqueName <name>]   // required when env has multiple
//                                       // solution bindings; ignored for
//                                       // environment bindings
//       [--token              <dvToken>]
//
// Inherits org/project/repo/gitFolder/rootFolder from the existing binding —
// no need to pass them. If no binding exists, returns an error (caller should
// run /power-pages:git-configure to set up a binding instead).

'use strict';

const { getAuthToken } = require('./validation-helpers');
const { detectGitBinding } = require('./detect-git-binding');
const { disconnectFromGit } = require('./disconnect-from-git');
const { connectToGit } = require('./connect-to-git');
const { connectSolutionToGit } = require('./connect-solution-to-git');

// Error code returned by ValidateEnvironmentReadyForSourceControlOperation
// when ConnectToGit is invoked while a DisconnectFromGit async cleanup is
// still running on the same scope. The pre-reconnect poll usually clears
// this, but retries handle the residual race.
const DISCONNECT_IN_PROGRESS_CODE = '0x80040265';

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { envUrl: null, token: null, newBranch: null, solutionUniqueName: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--newBranch' && args[i + 1]) out.newBranch = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `detect-git-binding` until the target scope reports `bound:false`,
 * confirming the prior DisconnectFromGit has fully settled server-side.
 * Returns { cleared:true } on success, { cleared:false, lastProbe } on timeout.
 */
async function waitForDisconnectToClear({
  envUrl, token, solutionUniqueName,
  pollDelayMs, maxWaitMs, sleepFn = sleep,
}) {
  const started = Date.now();
  let lastProbe = null;
  while (Date.now() - started < maxWaitMs) {
    const probeArgs = { envUrl, token };
    if (solutionUniqueName) probeArgs.solutionUniqueName = solutionUniqueName;
    lastProbe = await detectGitBinding(probeArgs);
    if (lastProbe && lastProbe.bound === false) {
      return { cleared: true, lastProbe };
    }
    await sleepFn(pollDelayMs);
  }
  return { cleared: false, lastProbe };
}

/**
 * Call `connectFn` and retry up to `maxRetries` times if the response carries
 * the disconnect-in-progress error code. Each retry waits `retryDelayMs`.
 */
async function reconnectWithRetry({ connectFn, maxRetries, retryDelayMs, sleepFn = sleep }) {
  let attempt = 0;
  let lastResult = null;
  while (attempt <= maxRetries) {
    lastResult = await connectFn();
    if (!lastResult.error) return lastResult;
    if (lastResult.errorCode !== DISCONNECT_IN_PROGRESS_CODE) return lastResult;
    if (attempt === maxRetries) return lastResult;
    attempt += 1;
    await sleepFn(retryDelayMs);
  }
  return lastResult;
}

/**
 * @param {object} options
 * @param {string} options.envUrl
 * @param {string} options.newBranch
 * @param {string} [options.token]
 * @param {string} [options.solutionUniqueName]      Required when env has multiple solution bindings.
 * @param {number} [options._pollDelayMs=5000]       Test hook — delay between post-disconnect probes.
 * @param {number} [options._maxPollMs=90000]        Test hook — max wait for disconnect to clear.
 * @param {number} [options._retryDelayMs=5000]      Test hook — delay between reconnect retries on 0x80040265.
 * @param {number} [options._maxReconnectRetries=6]  Test hook — max reconnect retries on 0x80040265.
 * @param {function} [options._sleepFn]              Test hook — override sleep impl.
 * @returns {Promise<object>}
 */
async function switchBranch({
  envUrl, token, newBranch, solutionUniqueName = null,
  _pollDelayMs = 5000,
  _maxPollMs = 90000,
  _retryDelayMs = 5000,
  _maxReconnectRetries = 6,
  _sleepFn = sleep,
} = {}) {
  if (!envUrl) throw new Error('--envUrl is required');
  if (!newBranch) throw new Error('--newBranch is required');

  const tok = token || getAuthToken(envUrl);
  if (!tok) return { error: 'Could not acquire auth token.' };

  // Step 1 — read current binding so we can roll back if reconnect fails.
  const current = await detectGitBinding({ envUrl, token: tok });
  if (current.error) return { error: 'Pre-check failed: ' + current.error };
  if (!current.bound) {
    return {
      error: 'No existing Git binding found. Use /power-pages:git-configure to create one first.',
    };
  }

  const bindingType = current.bindingType;

  // Step 1b — for solution bindings, resolve WHICH solution to switch.
  let resolvedSolution = null;
  let solutionScoped = null;
  if (bindingType === 'solution') {
    const enumerated = Array.isArray(current.boundSolutions) ? current.boundSolutions : [];

    if (solutionUniqueName) {
      // Explicit caller selection — validate it's actually bound.
      // If detect couldn't enumerate (legacy single-row response with no
      // boundSolutions field), trust the caller.
      if (enumerated.length > 0) {
        const match = enumerated.some((s) => s.uniqueName === solutionUniqueName);
        if (!match) {
          return {
            error: `Solution "${solutionUniqueName}" is not Git-bound on this environment. ` +
              `Bound solutions: ${enumerated.map((s) => s.uniqueName).join(', ') || 'none'}.`,
            bindingType: 'solution',
            boundSolutions: enumerated.map((s) => s.uniqueName),
          };
        }
      } else if (current.solutionUniqueName && current.solutionUniqueName !== solutionUniqueName) {
        return {
          error: `Solution "${solutionUniqueName}" is not Git-bound on this environment. ` +
            `Bound solution: ${current.solutionUniqueName}.`,
          bindingType: 'solution',
          boundSolutions: [current.solutionUniqueName],
        };
      }
      resolvedSolution = solutionUniqueName;
    } else if (enumerated.length > 1) {
      // AMBIGUOUS — must be checked BEFORE falling back to current.solutionUniqueName,
      // which on the legacy path is just rows[0].solutionuniquename and silently
      // discards the rest. Requiring --solutionUniqueName avoids switching the
      // wrong solution.
      return {
        error: `Environment has ${enumerated.length} Git-bound solutions; pass --solutionUniqueName to specify which one to switch. ` +
          `Bound solutions: ${enumerated.map((s) => s.uniqueName).join(', ')}.`,
        bindingType: 'solution',
        boundSolutions: enumerated.map((s) => s.uniqueName),
      };
    } else if (enumerated.length === 1) {
      resolvedSolution = enumerated[0].uniqueName;
    } else if (current.solutionUniqueName) {
      // Legacy detection path returned a top-level name without boundSolutions[];
      // treat as single binding.
      resolvedSolution = current.solutionUniqueName;
    } else {
      return {
        error: 'Binding type is "solution" but the helper could not determine which solution is bound. ' +
          'Pass --solutionUniqueName explicitly.',
        bindingType: 'solution',
      };
    }

    // Re-probe scoped to the chosen solution so per-solution fields (branch,
    // gitFolder, rootFolder) reflect THAT solution — important on envs where
    // different solutions sit on different branches.
    solutionScoped = await detectGitBinding({
      envUrl, token: tok, solutionUniqueName: resolvedSolution,
    });
    if (solutionScoped.error) {
      return { error: 'Pre-check (solution-scoped) failed: ' + solutionScoped.error };
    }
    if (!solutionScoped.bound) {
      return {
        error: `Solution "${resolvedSolution}" is reported in env-level binding enumeration ` +
          'but solution-scoped detect-git-binding sees no row. Bind is inconsistent — ' +
          'run /power-pages:diagnose-git-integration.',
        bindingType: 'solution',
        solutionUniqueName: resolvedSolution,
      };
    }
  }

  // Use solution-scoped fields when applicable so the inherited values
  // describe the SPECIFIC solution being switched.
  const effective = solutionScoped || current;
  if (effective.branch === newBranch) {
    return {
      error: `Already bound to branch "${newBranch}". No switch needed.`,
      ...(bindingType === 'solution' ? { bindingType, solutionUniqueName: resolvedSolution } : {}),
    };
  }

  const previousBranch = effective.branch;
  const { organization, project, repository, gitFolder, rootFolder } = effective;

  // Step 2 — disconnect.
  const disArgs = { envUrl, token: tok };
  if (bindingType === 'solution') disArgs.solutionUniqueName = resolvedSolution;
  const dis = await disconnectFromGit(disArgs);
  if (dis.error) {
    return { error: dis.error, phase: 'disconnect' };
  }
  const disconnectedAt = dis.calledAt;

  // Step 2b — for solution bindings, wait for the disconnect to settle before
  // attempting reconnect. The env-binding shape is atomic enough that an
  // immediate ConnectToGit typically succeeds; for solution bindings the
  // platform's plugin orchestration is slower and returns 0x80040265 if we
  // reconnect too quickly.
  if (bindingType === 'solution') {
    const cleared = await waitForDisconnectToClear({
      envUrl, token: tok, solutionUniqueName: resolvedSolution,
      pollDelayMs: _pollDelayMs, maxWaitMs: _maxPollMs, sleepFn: _sleepFn,
    });
    // Even if we time out we still try the reconnect (with the retry loop) —
    // the disconnect may be effectively done and just the detection probe is
    // slow. The retry loop handles a genuine in-progress error.
    if (!cleared.cleared) {
      // Annotated on the eventual return only via the retry-loop error path.
    }
  }

  // Step 3 — reconnect with the new branch (retries on disconnect-in-progress).
  const buildReconnect = (branchName) => {
    if (bindingType === 'solution') {
      return () => connectSolutionToGit({
        envUrl, token: tok,
        solutionUniqueName: resolvedSolution,
        branch: branchName,
        gitFolder,
        organization, project, repository, rootFolder,
      });
    }
    return () => connectToGit({
      envUrl, token: tok,
      organization, project, repository,
      branch: branchName, gitFolder,
    });
  };

  const reconn = await reconnectWithRetry({
    connectFn: buildReconnect(newBranch),
    maxRetries: _maxReconnectRetries,
    retryDelayMs: _retryDelayMs,
    sleepFn: _sleepFn,
  });

  if (reconn.error) {
    // Roll back to the original branch — best-effort, with the same retry semantics.
    let rolledBack = false;
    let rollbackError = null;
    const rollback = await reconnectWithRetry({
      connectFn: buildReconnect(previousBranch),
      maxRetries: _maxReconnectRetries,
      retryDelayMs: _retryDelayMs,
      sleepFn: _sleepFn,
    });
    if (rollback.bound) {
      rolledBack = true;
    } else {
      rollbackError = rollback.error || 'Rollback reconnect returned non-success.';
    }
    return {
      error: reconn.error,
      phase: 'reconnect',
      rolledBack,
      rollbackError,
      previousBranch,
      attemptedBranch: newBranch,
      bindingType,
      ...(bindingType === 'solution' ? { solutionUniqueName: resolvedSolution } : {}),
    };
  }

  return {
    switched: true,
    bindingType,
    solutionUniqueName: bindingType === 'solution' ? resolvedSolution : null,
    previousBranch,
    newBranch,
    organization,
    project,
    repository,
    gitFolder,
    rootFolder: bindingType === 'solution' ? (rootFolder || null) : null,
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
