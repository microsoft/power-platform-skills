#!/usr/bin/env node

// Generic polling helper for Git-integration async operations.
//
// Used by:
//   - commit-to-git.js  — polls until pending Changes count drops to 0
//   - sync-from-git     — composes with refresh-changes-from-git + pull-changes-from-git
//
// The Connect-to-Git OData actions are mostly fire-and-forget (204 No Content),
// but the side-effects (Changes/Updates/Conflicts populating or clearing) are
// eventually consistent — readers must poll. This helper handles the backoff,
// timeout, and "have we reached the target state yet?" gating.
//
// Output (JSON to stdout):
//   {
//     reached:       true | false,
//     attempts:      <number>,
//     elapsedMs:     <number>,
//     finalValue:    <whatever check returned last>,
//     timedOut:      true | false,
//   }
//
// API:
//   const { pollGitOperation } = require('./poll-git-operation');
//   const r = await pollGitOperation({
//     check: async () => { /* return { done: bool, value: anything } */ },
//     intervalMs: 2000,
//     maxAttempts: 30,
//     backoff: 'linear' | 'exponential',
//   });
//
// CLI usage is not provided — this helper is library-only because it takes a
// JS callback. Skills compose it from a Node script that imports the helper.

'use strict';

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_MAX_ATTEMPTS = 30;
const MAX_BACKOFF_MS = 30000; // cap exponential backoff at 30s

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `check` until it returns { done: true, ... } or maxAttempts is reached.
 *
 * @param {object} options
 * @param {() => Promise<{done: boolean, value?: any}>} options.check
 *   Returns `{ done: true }` to stop, `{ done: false }` to keep polling.
 *   May also return `{ done: false, value }` to surface the latest value
 *   in the final result even if we time out.
 * @param {number} [options.intervalMs=2000]   Base interval between polls
 * @param {number} [options.maxAttempts=30]    Maximum number of poll attempts
 * @param {'linear'|'exponential'} [options.backoff='linear']
 *   - linear:      sleep(intervalMs) every time
 *   - exponential: sleep(intervalMs * 2^(attempt-1)), capped at 30s
 * @param {(attempt: number, lastValue: any) => void} [options.onAttempt]
 *   Optional callback fired after each check; useful for progress logs.
 * @returns {Promise<{reached: boolean, attempts: number, elapsedMs: number,
 *                    finalValue: any, timedOut: boolean}>}
 */
async function pollGitOperation({
  check,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoff = 'linear',
  onAttempt = null,
} = {}) {
  if (typeof check !== 'function') {
    throw new Error('pollGitOperation: `check` callback is required');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('pollGitOperation: maxAttempts must be a positive integer');
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new Error('pollGitOperation: intervalMs must be a non-negative integer');
  }

  const startedAt = Date.now();
  let lastValue = undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result;
    try {
      result = await check();
    } catch (e) {
      // A throw from `check` aborts the poll — surface it.
      throw new Error(`pollGitOperation: check threw on attempt ${attempt}: ${e.message}`);
    }

    lastValue = result?.value;
    if (onAttempt) {
      try { onAttempt(attempt, lastValue); } catch { /* swallow logging errors */ }
    }

    if (result?.done === true) {
      return {
        reached: true,
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
        finalValue: lastValue,
        timedOut: false,
      };
    }

    if (attempt < maxAttempts) {
      const sleepMs = backoff === 'exponential'
        ? Math.min(intervalMs * Math.pow(2, attempt - 1), MAX_BACKOFF_MS)
        : intervalMs;
      await sleep(sleepMs);
    }
  }

  return {
    reached: false,
    attempts: maxAttempts,
    elapsedMs: Date.now() - startedAt,
    finalValue: lastValue,
    timedOut: true,
  };
}

module.exports = { pollGitOperation, DEFAULT_INTERVAL_MS, DEFAULT_MAX_ATTEMPTS, MAX_BACKOFF_MS };
