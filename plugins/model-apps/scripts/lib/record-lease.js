'use strict';
// The writer lease of a workspace record: the lock that builds sharing a workspace take, one at a time, to change one record file.
//
// WHY. The build keeps small recovery records in its workspace — the web resources it wrote and could not confirm were published
// (lib/web-resource-records.js), the dashboards it created and has not yet seen join the app's solution (lib/dashboard-creation-records.js) —
// each ONE file that holds every entry of its kind, replaced whole on each change. Two builds sharing a workspace each read the file and later
// wrote their own copy of it: with both reading before either wrote, A noting `a` and then B noting `b` both answered "recorded", and only `b`
// was on disk; A clearing `a` afterwards deleted the file, `b` with it — the id the next build needed. Replacing the file atomically does not
// prevent that: every write is whole, and the later one still wins.
//
// THE LEASE. A change takes the record's own lock, reads the record from disk as it is NOW, applies its one change to that, writes it, and lets
// the lock go — so each change starts from every change made before it. The lock is the workspace's lease protocol
// (lib/apply-snapshot-store.js acquireLease: an exclusive create picks one holder, a claim file makes exactly one of several reclaimers win, a
// release removes only a lock that still holds its own token) on a file of the record's own, `<record file>.lock`, stamped and judged as the
// pages lock is (lib/sdk-build.js acquireAppPagesLease, lib/process-owner.js): it is taken over only from a build PROVEN gone — never by age,
// since a live build can be paused for as long as a laptop sleeps.
//
// THE WAIT. A change reads and writes one small file, so a lock is held for milliseconds, and one that another build holds is waited for — but
// for a BOUNDED time: LEASE_ATTEMPTS tries, LEASE_WAIT_MS apart, about a second in all. A lock still held after that (a build paused, or one
// that crashed on another machine, whose death this one cannot prove) is not waited for any longer: the change is not made, and the record's
// caller says so as it says a record it cannot write — one warning, and the build goes on. Reads take no lock: a record is replaced
// atomically, so a read sees one whole version of it.
const path = require('node:path');
const { acquireLease, releaseLease } = require('./apply-snapshot-store.js');
const { ownerStamp, ownerState } = require('./process-owner.js');

const LEASE_ATTEMPTS = 10;
const LEASE_WAIT_MS = 100;
// A synchronous pause, as the snapshot store's release waits for its lease (apply-snapshot-store.js releaseTombstone): a record is written
// synchronously from inside a build step, and that step waits for it whatever else the process could do meanwhile.
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Runs `change()` while holding the lease of the record file named `file` in the workspace folder `root` (one that exists and that
 * page-ownership-records.js workspaceRoot has checked). Answers { ok: true, value } with what `change` answered, or { ok: false, reason } when
 * the lease was not taken — `reason` names the lock, for a warning. What `change` throws is thrown, after the lease is released.
 * `deps`, for tests: `attempts`, `sleep(ms)`, and `owner` (the lib/process-owner.js seams).
 */
function withRecordLease(root, file, change, deps = {}) {
  const attempts = deps.attempts != null ? deps.attempts : LEASE_ATTEMPTS;
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : sleepSync;
  const owner = deps.owner || {};
  const lockFile = `${file}.lock`;
  let lease;
  for (let attempt = 1; ; attempt += 1) {
    lease = acquireLease(root, { file: lockFile, stamp: ownerStamp(owner), isStale: (held) => ownerState(held, owner).state === 'gone' });
    // Every refusal is tried again within the bound, not only "held": a lock another build has just let go can refuse a create for a moment too
    // (on Windows a file that is being deleted while a reader still has it open cannot be created again until that reader closes it — EPERM), and
    // a folder that cannot be written at all fails within the same bound.
    if (lease.ok || attempt >= attempts) break;
    sleep(LEASE_WAIT_MS);
  }
  if (!lease.ok) {
    const lock = path.join(root, lockFile);
    return {
      ok: false,
      reason: lease.error
        ? `its lock ${lock} could not be created (${(lease.error && lease.error.message) || lease.error})`
        : `its lock ${lock} is held by another build of this workspace (${lease.reason})`,
    };
  }
  try {
    return { ok: true, value: change() };
  } finally {
    releaseLease(lease);
  }
}

module.exports = { withRecordLease, LEASE_ATTEMPTS, LEASE_WAIT_MS };
