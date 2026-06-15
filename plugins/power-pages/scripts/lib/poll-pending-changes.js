#!/usr/bin/env node

// Polls the pending-changes count on a Git-bound env until it STABILISES, then
// reports the stable value. This is distinct from poll-git-operation.js (which
// polls until a target state is *reached*): here there is no known target — we
// wait for the server to finish ingesting components after ConnectToGit returns.
//
// Why this exists (see references/inner-loop-empirical-findings.md §17):
//   Right after ConnectToGit returns, pendingChangesCount is small (e.g. the
//   Solution + Publisher rows). The platform then asynchronously stages the rest
//   of the solution's components — the count climbs (2 → … → 344) over a few
//   minutes. A user who runs commit-to-git immediately gets a 2-row commit and
//   must commit again for the remainder. git-configure Phase 8 calls this helper
//   so the final summary reports the STABLE count, and warns the user to wait if
//   the count is still climbing.
//
// Stability rule: the count is considered stable once `--stable-reads` (default
// 3) consecutive probes return the SAME value. Because we sleep `--interval`
// (default 30s) between probes, three identical reads means the count held
// steady for ~60s — long enough to distinguish "done staging" from a momentary
// plateau. Bounded by `--max-ms` (default 5 min); on timeout we return the last
// observed count with `stable:false`.
//
// Output (JSON to stdout):
//   {
//     stable:      true | false,
//     finalCount:  <number>,
//     trend:       "stable" | "increasing" | "decreasing" | "fluctuating",
//     reads:       <number>,        // total probes performed
//     polledForMs: <number>,        // wall time spent polling
//     timedOut:    true | false,
//     samples:     [ { atMs, count }, ... ],
//   }
//   On error: { error: "<message>", statusCode?: <number> }
//
// Usage (CLI):
//   node poll-pending-changes.js --envUrl <url> [--token <tok>]
//        [--solutionUniqueName <name>] [--until-stable]
//        [--interval <ms>] [--stable-reads <n>] [--max-ms <ms>]
//
//   --until-stable is the default behaviour and is accepted for explicitness;
//   without any flags the helper still polls to stability.
//
// API (library):
//   const { pollPendingChanges } = require('./poll-pending-changes');
//   const r = await pollPendingChanges({ envUrl, token, solutionUniqueName });

'use strict';

const { listPendingChanges } = require('./list-pending-changes');

const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_STABLE_READS = 3;
const DEFAULT_MAX_MS = 300000; // 5 minutes

function realSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Classify the trend across the collected samples.
 * @param {Array<{count: number}>} samples
 * @returns {'stable'|'increasing'|'decreasing'|'fluctuating'}
 */
function classifyTrend(samples) {
  if (samples.length < 2) return 'stable';
  const counts = samples.map((s) => s.count);
  const first = counts[0];
  const last = counts[counts.length - 1];
  let anyUp = false;
  let anyDown = false;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > counts[i - 1]) anyUp = true;
    if (counts[i] < counts[i - 1]) anyDown = true;
  }
  if (!anyUp && !anyDown) return 'stable';
  if (anyUp && anyDown) return 'fluctuating';
  return last > first ? 'increasing' : 'decreasing';
}

/**
 * Poll pending-changes count until it holds steady for `stableReads`
 * consecutive probes, or until `maxMs` elapses.
 *
 * @param {object} options
 * @param {string}  options.envUrl
 * @param {string} [options.token]
 * @param {string} [options.solutionUniqueName]
 * @param {number} [options.intervalMs=30000]
 * @param {number} [options.stableReads=3]
 * @param {number} [options.maxMs=300000]
 * @param {() => Promise<{count?: number, error?: string, statusCode?: number}>} [options._probeImpl]
 *        DI: returns the current count (defaults to listPendingChanges --probe).
 * @param {(ms: number) => Promise<void>} [options._sleepImpl]  DI for sleep.
 * @param {() => number} [options._nowImpl]                     DI for clock.
 * @returns {Promise<object>}
 */
async function pollPendingChanges({
  envUrl, token, solutionUniqueName,
  intervalMs = DEFAULT_INTERVAL_MS,
  stableReads = DEFAULT_STABLE_READS,
  maxMs = DEFAULT_MAX_MS,
  _probeImpl, _sleepImpl, _nowImpl,
} = {}) {
  const now = typeof _nowImpl === 'function' ? _nowImpl : Date.now;
  const sleep = typeof _sleepImpl === 'function' ? _sleepImpl : realSleep;
  const probe = typeof _probeImpl === 'function'
    ? _probeImpl
    : async () => listPendingChanges({ envUrl, token, solutionUniqueName, probe: true });

  if (stableReads < 1) stableReads = 1;
  const start = now();
  const samples = [];

  for (;;) {
    const res = await probe();
    if (res && res.error) {
      return { error: res.error, statusCode: res.statusCode, reads: samples.length };
    }
    const count = res && typeof res.count === 'number' ? res.count : 0;
    samples.push({ atMs: now() - start, count });

    // Stable once the last `stableReads` counts are all identical.
    if (samples.length >= stableReads) {
      const tail = samples.slice(-stableReads).map((s) => s.count);
      const allEqual = tail.every((c) => c === tail[0]);
      if (allEqual) {
        return {
          stable: true,
          finalCount: count,
          trend: classifyTrend(samples),
          reads: samples.length,
          polledForMs: now() - start,
          timedOut: false,
          samples,
        };
      }
    }

    // Stop if another full interval would exceed the budget.
    if ((now() - start) + intervalMs > maxMs) {
      return {
        stable: false,
        finalCount: count,
        trend: classifyTrend(samples),
        reads: samples.length,
        polledForMs: now() - start,
        timedOut: true,
        samples,
      };
    }

    await sleep(intervalMs);
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    envUrl: null, token: null, solutionUniqueName: null,
    intervalMs: DEFAULT_INTERVAL_MS, stableReads: DEFAULT_STABLE_READS, maxMs: DEFAULT_MAX_MS,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--envUrl' && args[i + 1]) out.envUrl = args[++i];
    else if (args[i] === '--token' && args[i + 1]) out.token = args[++i];
    else if (args[i] === '--solutionUniqueName' && args[i + 1]) out.solutionUniqueName = args[++i];
    else if (args[i] === '--interval' && args[i + 1]) out.intervalMs = parseInt(args[++i], 10);
    else if (args[i] === '--stable-reads' && args[i + 1]) out.stableReads = parseInt(args[++i], 10);
    else if (args[i] === '--max-ms' && args[i + 1]) out.maxMs = parseInt(args[++i], 10);
    else if (args[i] === '--until-stable') { /* default behaviour; accepted for explicitness */ }
  }
  return out;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  pollPendingChanges(args)
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); })
    .catch((e) => {
      process.stderr.write('poll-pending-changes: ' + e.message + '\n');
      process.exit(1);
    });
}

module.exports = { pollPendingChanges, classifyTrend };
