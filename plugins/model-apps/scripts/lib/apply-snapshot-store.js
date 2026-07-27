'use strict';
// Impure persistence for the apply-snapshot envelope (changed-only deliverable #3, part 2).
//
// The DECISION logic lives in apply-snapshot.js (pure); this module is the I/O boundary: an atomic
// snapshot write, a build-wide WORKSPACE lease, a generation-CAS write, and the invalidate / tombstone /
// delete primitives the build and teardown flows will call. Correctness rests on TWO mechanisms:
//   · Atomic write (temp→fsync→rename) so a crash never leaves a truncated, half-trusted snapshot.
//   · Generation CAS so a concurrent build that re-wrote the snapshot between our read and our write is
//     detected and the loser's write is REFUSED (never a lost update).
// The lease is an OPTIMIZATION that reduces contention around the read-modify-write; unlike the pages
// lease (sdk-build.js acquireAppPagesLease, which must NOT steal because duplicate CREATE isn't CAS-
// guarded), this lease MAY reclaim a stale holder because the generation CAS is the actual guard — a
// reclaimed-but-still-alive original holder simply loses the CAS on its own write.

const fs = require('node:fs');
const path = require('node:path');
const {
  parseEnvelope, serializeEnvelope, markIneligible, tombstone, generationMatches,
} = require('./apply-snapshot.js');

const SNAPSHOT_FILE = 'apply-snapshot.json';
const LEASE_FILE = 'apply-snapshot.lock';
// A lease whose token is older than this is presumed abandoned by a crashed build. 5 min comfortably
// exceeds any real snapshot read-modify-write (which is milliseconds) while still self-healing quickly.
const LEASE_STALE_MS = 5 * 60 * 1000;

function snapshotPath(workspaceDir) { return path.join(workspaceDir, SNAPSHOT_FILE); }
function leasePath(workspaceDir) { return path.join(workspaceDir, LEASE_FILE); }

// Read + parse the persisted snapshot. null when absent, unreadable, or a foreign/malformed schema
// (parseEnvelope is fail-closed) — the caller treats null as "no usable snapshot" ⇒ full build.
function readSnapshot(workspaceDir) {
  try { return parseEnvelope(fs.readFileSync(snapshotPath(workspaceDir), 'utf8')); }
  catch { return null; }
}

// Atomic write. The temp file MUST be in the same directory as the target — rename() is only atomic
// within a single filesystem, and a workspace-local temp guarantees that. fsync the fd before rename so
// the bytes are durable, not just in the page cache. A crash leaves EITHER the prior snapshot or the new
// one, never a partial write. The temp name carries pid+timestamp so two racing writers don't collide on
// the temp path itself (the rename still yields one final winner; the CAS decides which SHOULD win).
function writeSnapshotAtomic(workspaceDir, envelope) {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const target = snapshotPath(workspaceDir);
  const tmp = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, serializeEnvelope(envelope));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup of the orphaned temp */ }
    throw e;
  }
}

// Is `pid` a live process? Best-effort: process.kill(pid, 0) throws ESRCH when the pid is gone, EPERM when
// it exists but we lack permission (still alive). pid reuse can FALSELY report alive, but that only makes
// us KEEP a young lease held (→ caller falls back to full build, safe). Age is the primary staleness
// signal; aliveness only protects a YOUNG lease from premature takeover.
function processAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

// Acquire the workspace snapshot lease. Exclusive create ('wx') picks one winner atomically. If the lease
// is already held, reclaim it ONLY when stale (token older than staleMs OR the holder pid is dead); a live,
// young holder blocks (returns { ok:false }). Returns a handle whose token is written into the lock so
// release is OWNER-CHECKED (never remove a lock a different build now holds). `deps` seams now()/pid/alive
// for tests.
function acquireLease(workspaceDir, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const pid = deps.pid != null ? deps.pid : process.pid;
  const isAlive = typeof deps.processAlive === 'function' ? deps.processAlive : processAlive;
  const staleMs = deps.staleMs != null ? deps.staleMs : LEASE_STALE_MS;
  fs.mkdirSync(workspaceDir, { recursive: true });
  const lp = leasePath(workspaceDir);
  const token = JSON.stringify({ pid, at: now(), rnd: Math.random().toString(36).slice(2) });
  const tryCreate = () => {
    try { fs.writeFileSync(lp, token, { flag: 'wx' }); return { ok: true, path: lp, token }; }
    catch (e) { return { ok: false, code: e && e.code, error: e }; }
  };
  let r = tryCreate();
  if (r.ok) return r;
  if (r.code !== 'EEXIST') return { ok: false, reason: `lease create failed: ${r.error && r.error.message}` };
  // Held — decide staleness.
  let held;
  try { held = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch { held = null; }
  const age = held && typeof held.at === 'number' ? now() - held.at : Infinity;
  const stale = age > staleMs || !(held && isAlive(held.pid));
  if (!stale) return { ok: false, reason: `lease held by pid ${held && held.pid} (age ${age}ms)`, heldBy: held };
  // Reclaim: overwrite the stale token. The generation CAS — not this reclaim — is what actually prevents a
  // lost update if the reclaimed holder is still alive.
  try { fs.writeFileSync(lp, token); return { ok: true, path: lp, token, reclaimed: true }; }
  catch (e) { return { ok: false, reason: `stale lease reclaim failed: ${e.message}` }; }
}

// Owner-checked release: remove the lock ONLY if it still holds OUR exact token (a build that reclaimed our
// stale lease must not have its lock deleted by our late release). Best-effort.
function releaseLease(handle) {
  if (!handle || !handle.path || !handle.token) return;
  try { if (fs.readFileSync(handle.path, 'utf8') === handle.token) fs.rmSync(handle.path, { force: true }); }
  catch { /* gone/unreadable — best-effort */ }
}

// CAS write (call while holding the lease). Refuse to overwrite when the on-disk generation no longer
// matches what the caller last read — a concurrent build won the race. expectedGeneration === null means
// "I expected NO prior snapshot" (first write); if one appeared meanwhile, refuse. Returns { ok, reason }.
function casWriteSnapshot(workspaceDir, envelope, expectedGeneration) {
  const disk = readSnapshot(workspaceDir);
  if (expectedGeneration == null) {
    if (disk) return { ok: false, reason: 'expected no prior snapshot but one exists (concurrent create)' };
  } else if (!disk) {
    return { ok: false, reason: 'expected snapshot vanished (concurrent delete/teardown)' };
  } else if (!generationMatches(disk, expectedGeneration)) {
    return { ok: false, reason: 'generation CAS failed (concurrent snapshot write)' };
  }
  writeSnapshotAtomic(workspaceDir, envelope);
  return { ok: true };
}

// Unconditional persist under the lease (no CAS) — used to seed the very first snapshot or to write a
// freshly-minted envelope where no read-modify-write ordering matters. Prefer casWriteSnapshot on any
// update path.
function persistSnapshot(workspaceDir, envelope) {
  writeSnapshotAtomic(workspaceDir, envelope);
  return { ok: true };
}

// INVALIDATE-before-write: force eligible:false and persist, under the lease. Fail-closed callers (the
// fast-path apply) MUST abort if this returns { ok:false } — proceeding could bless a snapshot that a
// crash then leaves eligible. A missing snapshot is already-safe (nothing can fast-path) ⇒ ok:true.
function invalidateSnapshot(workspaceDir, deps = {}) {
  const lease = acquireLease(workspaceDir, deps);
  if (!lease.ok) return { ok: false, reason: lease.reason };
  try {
    const disk = readSnapshot(workspaceDir);
    if (!disk) return { ok: true, reason: 'no snapshot to invalidate' };
    markIneligible(disk);
    writeSnapshotAtomic(workspaceDir, disk);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `invalidate failed: ${e.message}` };
  } finally {
    releaseLease(lease);
  }
}

// TOMBSTONE-before-delete: mark a teardown-in-progress (eligible:false + teardown debt) and persist, BEFORE
// any live delete. A partial/crashed teardown then leaves the tombstone so a surviving artifact can never be
// rebaselined. No snapshot ⇒ nothing to tombstone (ok). Under the lease.
function tombstoneSnapshot(workspaceDir, deps = {}) {
  const lease = acquireLease(workspaceDir, deps);
  if (!lease.ok) return { ok: false, reason: lease.reason };
  try {
    const disk = readSnapshot(workspaceDir);
    if (!disk) return { ok: true, reason: 'no snapshot to tombstone' };
    tombstone(disk);
    writeSnapshotAtomic(workspaceDir, disk);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `tombstone failed: ${e.message}` };
  } finally {
    releaseLease(lease);
  }
}

// Delete the snapshot file — ONLY after a teardown has verified live absence (the caller's responsibility).
// Best-effort; a missing file is success.
function deleteSnapshot(workspaceDir) {
  try { fs.rmSync(snapshotPath(workspaceDir), { force: true }); return { ok: true }; }
  catch (e) { return { ok: false, reason: `delete failed: ${e.message}` }; }
}

module.exports = {
  SNAPSHOT_FILE,
  LEASE_FILE,
  LEASE_STALE_MS,
  snapshotPath,
  leasePath,
  readSnapshot,
  writeSnapshotAtomic,
  processAlive,
  acquireLease,
  releaseLease,
  casWriteSnapshot,
  persistSnapshot,
  invalidateSnapshot,
  tombstoneSnapshot,
  deleteSnapshot,
};
