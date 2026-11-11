'use strict';
// One rename that survives a brief Windows file lock.
//
// The plugin's state files (the managed binding store, the changed-only snapshot, its markers and the other
// records written temp-then-rename) become durable with `rename(temp, target)`. On Windows a rename fails
// with EPERM, EACCES or EBUSY while another process holds the source or the target open: antivirus or the
// search indexer scanning the file that was just written, a backup or sync client, a second build reading
// the store. The hold ends in milliseconds to seconds, and a build that gives up at the first refusal fails
// a whole run (`managed-binding-write-failed`, "the changed-only snapshot ... could not be invalidated") for
// a condition that was about to clear. libuv does not retry; graceful-fs retries renames on win32 for the
// same reason.
//   https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-file-or-directory (sharing modes)
//   https://nodejs.org/api/errors.html#common-system-errors (EPERM, EACCES, EBUSY)
//
// The contract:
//   * Windows only, and only for a refusal that is one of those three codes. Any other platform, and any other
//     code (ENOENT, EXDEV, ENOSPC...), is exactly one attempt, as before.
//   * The wait is bounded twice (see the two numbers below). A hold that outlasts the bound is a real lock, and
//     the caller gets the ORIGINAL error from the LAST attempt, untouched (same code, syscall, path, message), so
//     every caller's own message and exit code stay what they were.
//   * A retry only ever repeats the same rename, so it stays atomic: a refused rename moved nothing.
// A caller must be able to say why repeating its rename is safe: its temp file is its own and unique to the
// attempt, and the target is a file the plugin owns, written under a lease or compare-and-set; see each call
// site. A path that an actor outside the plugin can replace while the wait goes on (a maker's file, a folder
// that is about to be deleted) must NOT use this: the wait would let a decision made before it go stale.

const RENAME_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// The wait is synchronous (Atomics.wait): nothing else in the process runs meanwhile, not the heartbeat of a
// teardown (a beat every 60 s; a teardown with no beat for 5 min is taken for dead), not an HTTP callback (the
// transport times out a read after 60 s and a write after 300 s). So the wait is capped twice:
//   * RENAME_RETRY_BUDGET_MS, 5 s: the most one rename waits. A chosen bound, not a measured hold: long enough for a
//     scanner or an indexer to let go of a file just written, short enough to stay well inside the limits above.
//   * PROCESS_WAIT_TOTAL_MS, 30 s: the most this process waits out locks in all, across every rename. Once the
//     time spent reaches it, every later refused rename is ONE attempt, exactly as it was before this module, so
//     a lock that really is held cannot add up to minutes of blocking over many writes (a teardown that records
//     several receipts, a build that writes a record per step). 30 s is half of the 60 s beat, a tenth of the
//     5 min staleness and well inside the transport's timeouts.
// No production path can raise either number; only a test can change them (setDefaultBudgetMs and
// setProcessWaitedMs, through tests/helpers/short-rename-wait.js, which restores them).
const RENAME_RETRY_BUDGET_MS = 5000;
const PROCESS_WAIT_TOTAL_MS = 30000;
const FIRST_PAUSE_MS = 25;
// Doubling from 25 ms would reach tens of seconds in a few steps; a cap keeps polling often enough to land
// soon after the hold ends.
const MAX_PAUSE_MS = 1000;

let defaultBudgetMs = RENAME_RETRY_BUDGET_MS;
// The time this process has spent waiting out locks (the pauses asked for), against PROCESS_WAIT_TOTAL_MS. A new
// process starts at zero.
let processWaitedMs = 0;

// Tests that make every rename fail for good on Windows use this to keep the wait to a moment. Returns the
// previous value so a test can restore it.
function setDefaultBudgetMs(ms) {
  const previous = defaultBudgetMs;
  defaultBudgetMs = ms;
  return previous;
}

// Sets (and returns the previous) time this process has already spent waiting: a test starts from 0 and puts the
// old value back, so no test leaves a spent budget to the next one.
function setProcessWaitedMs(ms) {
  const previous = processWaitedMs;
  processWaitedMs = ms;
  return previous;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A directory where the file is to go is refused for good, never for a moment: on Windows `rename(file, directory)`
// answers EPERM, and no scanner letting go changes that. Waiting for it (a receipt path that a folder holds,
// say) would only delay the same error. Any doubt (a stat that fails, an fs without `lstatSync`) is "not
// that case", so the lock is waited out.
function targetIsADirectory(fsImpl, from, to) {
  try {
    return fsImpl.lstatSync(to).isDirectory() && !fsImpl.lstatSync(from).isDirectory();
  } catch {
    return false;
  }
}

// `fsImpl` is the fs the caller already writes through (a test seam). `opts`: `budgetMs` (a lower wait for this
// call than the default), `pause(ms)` (how to wait), `platform` (default process.platform): the last two are
// seams for tests, never for callers.
function renameWithRetry(fsImpl, from, to, opts) {
  const o = opts || {};
  const budget = typeof o.budgetMs === 'number' ? Math.min(o.budgetMs, defaultBudgetMs) : defaultBudgetMs;
  const pause = o.pause || sleepSync;
  const platform = o.platform || process.platform;
  let waited = 0;
  let next = FIRST_PAUSE_MS;
  for (;;) {
    try {
      fsImpl.renameSync(from, to);
      return;
    } catch (err) {
      if (platform !== 'win32' || !err || !RENAME_LOCK_CODES.has(err.code) || waited >= budget || processWaitedMs >= PROCESS_WAIT_TOTAL_MS || targetIsADirectory(fsImpl, from, to)) throw err;
      const wait = Math.min(next, budget - waited, PROCESS_WAIT_TOTAL_MS - processWaitedMs);
      pause(wait);
      waited += wait;
      processWaitedMs += wait;
      next = Math.min(next * 2, MAX_PAUSE_MS);
    }
  }
}

module.exports = { renameWithRetry, setDefaultBudgetMs, setProcessWaitedMs, sleepSync, RENAME_LOCK_CODES, RENAME_RETRY_BUDGET_MS, PROCESS_WAIT_TOTAL_MS };
