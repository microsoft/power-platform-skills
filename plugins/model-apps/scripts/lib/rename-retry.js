'use strict';
// One rename that survives a brief Windows file lock.
//
// Every workspace store (the managed binding store, the changed-only snapshot, its markers and the other
// records written temp-then-rename) becomes durable with `rename(temp, target)`. On Windows a rename fails
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
//   * The wait is bounded (RENAME_RETRY_BUDGET_MS in total, growing from a short first pause to a cap). A hold
//     that outlasts it is a real lock, and the caller gets the ORIGINAL error from the LAST attempt, untouched
//     (same code, syscall, path, message), so every caller's own message and exit code stay what they were.
//   * A retry only ever repeats the same rename, so it stays atomic: a refused rename moved nothing.
// A caller must be able to say why repeating its rename is safe (its temp file is its own and unique to the
// attempt; the target is either still the old content or already the new one); see each call site.

const RENAME_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// About a minute: long enough for a scanner or an indexer working through a large workspace on a loaded
// machine (a loaded Windows machine was seen refusing the same rename for several seconds), short enough that
// a lock that is really held (a program that has the file open without sharing) still ends the run with its
// own message rather than a hang.
const RENAME_RETRY_BUDGET_MS = 60000;
const FIRST_PAUSE_MS = 25;
// Doubling from 25 ms would reach tens of seconds in a few steps; a cap keeps polling often enough to land
// soon after the hold ends.
const MAX_PAUSE_MS = 1000;

let defaultBudgetMs = RENAME_RETRY_BUDGET_MS;

// Tests that make every rename fail for good on Windows use this to keep the wait to a moment. Returns the
// previous value so a test can restore it.
function setDefaultBudgetMs(ms) {
  const previous = defaultBudgetMs;
  defaultBudgetMs = ms;
  return previous;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A directory where the file is to go is refused for good, never for a moment: on Windows `rename(file, directory)`
// answers EPERM, and no scanner letting go changes that. Waiting a minute for it (a receipt path that a folder
// holds, say) would only delay the same error. Any doubt (a stat that fails, an fs without `lstatSync`) is "not
// that case", so the lock is waited out.
function targetIsADirectory(fsImpl, from, to) {
  try {
    return fsImpl.lstatSync(to).isDirectory() && !fsImpl.lstatSync(from).isDirectory();
  } catch {
    return false;
  }
}

// `fsImpl` is the fs the caller already writes through (a test seam). `opts`: `budgetMs` (a lower total wait
// for a caller that wants less than the default), `pause(ms)` (how to wait), `platform` (default
// process.platform): the last two are seams for tests, never for callers.
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
      if (platform !== 'win32' || !err || !RENAME_LOCK_CODES.has(err.code) || waited >= budget || targetIsADirectory(fsImpl, from, to)) throw err;
      const wait = Math.min(next, budget - waited);
      pause(wait);
      waited += wait;
      next = Math.min(next * 2, MAX_PAUSE_MS);
    }
  }
}

module.exports = { renameWithRetry, setDefaultBudgetMs, sleepSync, RENAME_LOCK_CODES, RENAME_RETRY_BUDGET_MS };
