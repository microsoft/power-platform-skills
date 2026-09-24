'use strict';
// Impure persistence for the apply-snapshot envelope (changed-only deliverable #3, part 2).
//
// The DECISION logic lives in apply-snapshot.js (pure); this module is the I/O boundary: an atomic
// snapshot write, a build-wide WORKSPACE lease, a generation-CAS write, and the invalidate / claim /
// tombstone / delete primitives the build and teardown flows call. Correctness rests on TWO mechanisms:
//   · Atomic write (temp→fsync→rename) so a crash never leaves a truncated, half-trusted snapshot.
//   · Generation CAS so a concurrent build that re-wrote the snapshot between our read and our write is
//     detected and the loser's write is REFUSED (never a lost update).
// The lease is an OPTIMIZATION that reduces contention around the read-modify-write; unlike the pages
// lease (sdk-build.js acquireAppPagesLease, which must NOT steal because duplicate CREATE isn't CAS-
// guarded), this lease MAY reclaim a stale holder. That is only as safe as the lease is exclusive in
// practice, because every write here — the CAS write included — compares and then writes as two steps
// under it: a holder paused past LEASE_STALE_MS between them can still overwrite. So reclaim is limited
// to a holder that is dead or past LEASE_STALE_MS (minutes, against writes of milliseconds), a token
// caught mid-write is aged by its file rather than presumed abandoned, and a lock released meanwhile is
// re-taken exclusively (acquireLease).

const fs = require('node:fs');
const path = require('node:path');
const {
  parseEnvelope, serializeEnvelope, makeEnvelope, markIneligible, tombstone, generationMatches, newGeneration, bumpGeneration,
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
  let gone = false;
  try { held = JSON.parse(fs.readFileSync(lp, 'utf8')); } catch (e) { held = null; gone = !!e && e.code === 'ENOENT'; }
  const heldToken = held && typeof held.at === 'number' ? held : null;
  let age = 0;
  if (heldToken) {
    age = now() - heldToken.at;
  } else if (!gone) {
    // No complete token. The 'wx' create makes the file BEFORE it writes the token, so an empty file is
    // usually a holder caught mid-write — and presuming it abandoned let two writers hold the lease at
    // once. Age it by the file itself; with no pid to test, only that age can make it stale. Any other
    // stat failure leaves it held (age 0): fail-closed.
    try { age = Date.now() - fs.statSync(lp).mtimeMs; } catch (e) { gone = !!e && e.code === 'ENOENT'; }
  }
  if (gone) {
    // Released between our create and our look. Free — but free for everyone, so it is taken the same
    // exclusive way as a fresh lock. Overwriting it let a writer that created it meanwhile hold it too.
    r = tryCreate();
    if (r.ok) return r;
    return { ok: false, reason: r.code === 'EEXIST' ? 'lease taken by another writer just now' : `lease create failed: ${r.error && r.error.message}` };
  }
  const stale = age > staleMs || (heldToken !== null && !isAlive(heldToken.pid));
  if (!stale) return { ok: false, reason: `lease held by pid ${held && held.pid} (age ${age}ms)`, heldBy: held };
  // Reclaim: overwrite the stale token, then read it back. Two writers reclaiming one stale lock both
  // overwrite it, and only the one whose token is still there holds the lease. Not airtight — the other
  // can read back before the second write lands — but that window is two writes to one small file, on a
  // lock already minutes stale.
  try {
    fs.writeFileSync(lp, token);
    if (fs.readFileSync(lp, 'utf8') !== token) return { ok: false, reason: 'lease reclaimed by another writer just now' };
    return { ok: true, path: lp, token, reclaimed: true };
  } catch (e) { return { ok: false, reason: `stale lease reclaim failed: ${e.message}` }; }
}

// Owner-checked release: remove the lock ONLY if it still holds OUR exact token (a build that reclaimed our
// stale lease must not have its lock deleted by our late release). Best-effort.
function releaseLease(handle) {
  if (!handle || !handle.path || !handle.token) return;
  try { if (fs.readFileSync(handle.path, 'utf8') === handle.token) fs.rmSync(handle.path, { force: true }); }
  catch { /* gone/unreadable — best-effort */ }
}

// CAS write. Refuse to overwrite when the on-disk generation no longer matches what the caller last read —
// a concurrent build won the race. expectedGeneration === null means "I expected NO prior snapshot" (first
// write); if one appeared meanwhile, refuse. Returns { ok, reason }.
//
// Takes the workspace lease ITSELF. The compare and the write are two steps, and the lease is what
// serializes a teardown tombstone against every other snapshot write: without it, a tombstone written
// between this read and this write was silently overwritten by a pre-teardown view (#587 item 1). No
// caller held the lease across this call, whatever this comment used to ask of them. A held lease means
// another writer is mid-update, so the write is refused (fail-closed: the next run full-builds).
function casWriteSnapshot(workspaceDir, envelope, expectedGeneration, deps = {}) {
  const lease = acquireLease(workspaceDir, deps);
  if (!lease.ok) return { ok: false, reason: `snapshot lease unavailable (${lease.reason})` };
  try {
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
  } finally {
    releaseLease(lease);
  }
}

// Unconditional persist under the lease (no CAS) — used to seed the very first snapshot or to write a
// freshly-minted envelope where no read-modify-write ordering matters. Prefer casWriteSnapshot on any
// update path.
function persistSnapshot(workspaceDir, envelope) {
  writeSnapshotAtomic(workspaceDir, envelope);
  return { ok: true };
}

// INVALIDATE-before-write: force eligible:false and persist, under the lease, ROTATING the generation so a
// concurrent reader that captured the pre-invalidate generation can no longer win the re-bless CAS (Sol #6
// fencing — invalidate/apply/re-bless without a long-held lease). Returns { ok, generation } where
// `generation` is the new post-invalidate token the caller must pass as the CAS `expected` on its re-bless.
// Fail-closed callers (the fast-path apply) MUST abort if this returns { ok:false }. A missing snapshot is
// already-safe (nothing can fast-path) ⇒ ok:true with generation:null.
//
// `options.expectedGeneration` FENCES the invalidate to the snapshot the caller's decision was based on
// (#587 item 1). Rotating the generation only protects a reader who is later compared against it, and
// without this the invalidate itself was never compared: a run that read an eligible snapshot, then lost
// the race to a teardown tombstone, invalidated the TOMBSTONED copy, got a fresh generation back, and
// re-blessed its stale view over the tombstone. With the key present the invalidate refuses unless the
// disk still holds that very generation — so a snapshot that was tombstoned, rewritten, or deleted since
// it was read stops the run before it mutates. Absent the key (a plain `--apply`, which decided nothing
// from a read), behavior is unchanged. The remaining keys are the lease test seams (see acquireLease).
function invalidateSnapshot(workspaceDir, options = {}) {
  const lease = acquireLease(workspaceDir, options);
  if (!lease.ok) return { ok: false, reason: lease.reason };
  try {
    const disk = readSnapshot(workspaceDir);
    const fenced = Object.prototype.hasOwnProperty.call(options, 'expectedGeneration');
    if (fenced && !disk) return { ok: false, reason: 'the snapshot this run read has since been deleted (a concurrent teardown?) — re-run' };
    if (fenced && (disk.generation || null) !== (options.expectedGeneration || null)) {
      return { ok: false, reason: 'the snapshot changed since this run read it (a concurrent teardown or build) — re-run' };
    }
    if (!disk) return { ok: true, reason: 'no snapshot to invalidate', generation: null };
    markIneligible(disk);
    const gen = newGeneration();
    bumpGeneration(disk, gen);
    writeSnapshotAtomic(workspaceDir, disk);
    return { ok: true, generation: gen };
  } catch (e) {
    return { ok: false, reason: `invalidate failed: ${e.message}` };
  } finally {
    releaseLease(lease);
  }
}

// TOMBSTONE-before-delete: mark a teardown-in-progress (eligible:false + teardown debt) and persist, BEFORE
// any live delete. A partial/crashed teardown then leaves the tombstone so a surviving artifact can never be
// rebaselined. Under the lease.
//
// It also ROTATES the generation, which is what makes it a fence rather than a label (#587 item 1): every
// in-flight changed-only run holds the generation it read, and its invalidate and re-bless both compare
// against it, so a tombstone that kept the old token let such a run erase it. The teardown caller refuses
// to delete anything when this returns { ok:false } (#587 item 2).
//
// NO snapshot is fenced as well, with a fresh tombstone. A first changed-only build has no snapshot until
// it finishes, and this used to answer "nothing to fence" there — so that build went on to write an
// eligible baseline for the app this teardown had just deleted. The fresh tombstone refuses such a build's
// claim (claimBaselineSnapshot) if it has not claimed yet; a placeholder it already claimed is tombstoned
// like any snapshot, which rotates the generation its baseline write expects. An unreadable file is
// replaced the same way: parseEnvelope answers null for it, and a build would overwrite it just the same.
//
// That needs the workspace folder, so a missing one is created and reported as `createdDir` (the first
// folder mkdir made), for the caller to remove after a clean teardown (removeCreatedDir). A folder that
// CANNOT be created is one no build can use either — it keeps its SDK state there, and a claim or a
// baseline write needs the same mkdir — so that one case still answers ok without writing.
const CANNOT_CREATE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST', 'ENOENT', 'EINVAL', 'ENAMETOOLONG']);

// The teardowns in flight, as a tombstone lists them (see releaseTombstone). An entry is dropped once its
// process is gone, or once it is older than any teardown runs: a pid can be reused, and an entry that
// never went would keep the workspace tombstoned for good.
const TEARDOWN_STALE_MS = 24 * 60 * 60 * 1000;
function liveTeardowns(disk, deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const isAlive = typeof deps.processAlive === 'function' ? deps.processAlive : processAlive;
  const list = disk && Array.isArray(disk.teardowns) ? disk.teardowns : [];
  return list.filter((t) => t && typeof t.id === 'string' && typeof t.at === 'number' && now() - t.at < TEARDOWN_STALE_MS && isAlive(t.pid));
}

function tombstoneSnapshot(workspaceDir, deps = {}) {
  const mkdir = typeof deps.mkdirSync === 'function' ? deps.mkdirSync : fs.mkdirSync;
  let createdDir;
  try {
    // Returns the first folder it created, or undefined when the whole path already existed.
    createdDir = mkdir(workspaceDir, { recursive: true }) || null;
  } catch (e) {
    // Any other code (EBUSY, EMFILE, ENOSPC, EIO, …) is transient: a build could still get the folder, so
    // the teardown fails closed rather than proceed unfenced.
    if (e && CANNOT_CREATE.has(e.code)) return { ok: true, reason: `no workspace can exist at ${workspaceDir} (${e.code}), so there is no snapshot to fence` };
    return { ok: false, reason: `tombstone failed: ${e && e.message}` };
  }
  let lease;
  try { lease = acquireLease(workspaceDir, deps); } catch (e) { return { ok: false, reason: `tombstone failed: ${e.message}` }; }
  if (!lease.ok) return { ok: false, reason: lease.reason };
  try {
    const disk = readSnapshot(workspaceDir) || makeEnvelope({});
    tombstone(disk);
    // Every teardown in flight is listed, so one that finishes first leaves the fence standing for the
    // others (releaseTombstone). The id names this one — the generation cannot, since any later write
    // rotates it.
    const teardownId = newGeneration();
    const now = typeof deps.now === 'function' ? deps.now : Date.now;
    disk.teardowns = [...liveTeardowns(disk, deps), { id: teardownId, pid: deps.pid != null ? deps.pid : process.pid, at: now() }];
    bumpGeneration(disk, newGeneration());
    writeSnapshotAtomic(workspaceDir, disk);
    return { ok: true, createdDir, generation: disk.generation, teardownId };
  } catch (e) {
    return { ok: false, reason: `tombstone failed: ${e.message}` };
  } finally {
    releaseLease(lease);
  }
}

// CLAIM the workspace for a FIRST changed-only baseline — the no-snapshot twin of the fenced invalidate.
//
// A run that read no snapshot had nothing to be fenced by: its baseline write expects "no snapshot"
// (casWriteSnapshot with expected null), and a concurrent teardown that found none either never changed
// that. The claim gives the run a generation of its own. Under the lease, and only while there is still no
// snapshot, it writes a placeholder whose generation the run passes as its baseline CAS `expected`: a
// teardown that lands after the claim tombstones the placeholder (rotating that generation), so the write
// is refused; one that landed since the run's read left a tombstone, so the claim is refused and the run
// stops before it builds anything.
//
// The placeholder is ineligible with no priorSpec — exactly "no baseline yet" — and carries NO debt on
// purpose: a later run that reads it (this one crashed) passes it as the `prior` of its own baseline, which
// inherits prior debt, and a debt here would keep that app ineligible for good. `identity` is the live
// identity the run resolved, so a later read reports "not eligible" rather than an identity mismatch.
// Returns { ok, generation } or { ok:false, reason }.
function claimBaselineSnapshot(workspaceDir, identity, deps = {}) {
  let lease;
  try { lease = acquireLease(workspaceDir, deps); } catch (e) { return { ok: false, reason: `claim failed: ${e.message}` }; }
  if (!lease.ok) return { ok: false, reason: `snapshot lease unavailable (${lease.reason})` };
  try {
    if (readSnapshot(workspaceDir)) return { ok: false, reason: 'a snapshot appeared since this run found none (a concurrent teardown or build) — re-run' };
    const env = makeEnvelope(identity || {});
    writeSnapshotAtomic(workspaceDir, env);
    return { ok: true, generation: env.generation };
  } catch (e) {
    return { ok: false, reason: `claim failed: ${e.message}` };
  } finally {
    releaseLease(lease);
  }
}

// Undo tombstoneSnapshot's folder creation after a clean teardown: remove the folders it created, deepest
// first, up to and including `createdDir`. rmdir — never a recursive rm — so a folder that is no longer
// empty (a build started meanwhile and wrote into it) is left alone, and so is every folder above it. A
// teardown from a folder that never had a workspace then leaves none behind. Best-effort.
function removeCreatedDir(workspaceDir, createdDir) {
  if (!createdDir) return;
  const top = path.resolve(createdDir);
  // Deepest first. The walk ends when it steps above `top` — or at once, for a caller passing an unrelated
  // pair — so nothing outside what mkdir created is ever touched.
  for (let dir = path.resolve(workspaceDir); ; dir = path.dirname(dir)) {
    const rel = path.relative(top, dir);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return;
    try { fs.rmdirSync(dir); } catch { return; }
  }
}

// Delete the snapshot file — ONLY after a teardown has verified live absence (the caller's responsibility).
// Best-effort; a missing file is success.
function deleteSnapshot(workspaceDir) {
  try { fs.rmSync(snapshotPath(workspaceDir), { force: true }); return { ok: true }; }
  catch (e) { return { ok: false, reason: `delete failed: ${e.message}` }; }
}

// End a teardown's hold on the snapshot. tombstoneSnapshot lists every teardown in flight, and every
// teardown that has FINISHED drops its entry here, under the lease — a finished teardown is no longer in
// flight, and an entry left behind read as one still running whenever its pid was alive (reused, slow to
// exit, or the very process a caller runs teardowns in), so a later clean teardown kept the fence for up to
// a day. Then:
//   · `deps.keep` (the teardown failed or threw) → the tombstone stays whatever else is running — a
//     surviving artifact must not be rebaselined — with its generation rotated. → { kept: true, left }
//   · other teardowns of this workspace are still running → the tombstone stays, with the generation
//     rotated, and goes on fencing their deletes. Deleting it when the first of two overlapping teardowns
//     finished — in either order — let a first changed-only build claim and bless a baseline for an app
//     the other was still deleting. → { left: true }
//   · this was the last → the snapshot is deleted, WHATEVER it now is: this tombstone, a baseline a build
//     wrote over it meanwhile (it carries the list forward, and the teardown debt), or anything else — a
//     snapshot is never left behind once the app is gone. → { deleted: true }
//   · there is no snapshot (or no workspace at all) → nothing to release, and the folder is not recreated
//     for it. → { gone: true }
// A lease another writer holds for a moment (a build persisting its snapshot) is retried briefly, for the
// same reason: giving up at once left the entry behind.
const RELEASE_ATTEMPTS = 5;
const RELEASE_WAIT_MS = 200;
// A synchronous pause: the store is synchronous throughout, and a teardown waiting 200 ms blocks nothing
// else in its own process.
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function releaseTombstone(workspaceDir, teardownId, deps = {}) {
  if (!fs.existsSync(snapshotPath(workspaceDir))) return { ok: true, deleted: false, gone: true };
  const attempts = deps.attempts != null ? deps.attempts : RELEASE_ATTEMPTS;
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : sleepSync;
  let lease;
  for (let attempt = 1; ; attempt += 1) {
    try { lease = acquireLease(workspaceDir, deps); } catch (e) { return { ok: false, deleted: false, reason: `release failed: ${e.message}` }; }
    if (lease.ok || attempt >= attempts) break;
    sleep(RELEASE_WAIT_MS);
  }
  if (!lease.ok) return { ok: false, deleted: false, reason: `snapshot lease unavailable (${lease.reason})` };
  try {
    if (!fs.existsSync(snapshotPath(workspaceDir))) return { ok: true, deleted: false, gone: true };
    // An unreadable file is replaced like tombstoneSnapshot replaces it; a clean last release deletes it.
    const disk = readSnapshot(workspaceDir) || makeEnvelope({});
    const others = liveTeardowns(disk, deps).filter((t) => t.id !== teardownId);
    if (others.length || deps.keep) {
      disk.teardowns = others;
      tombstone(disk);
      bumpGeneration(disk, newGeneration());
      writeSnapshotAtomic(workspaceDir, disk);
      if (deps.keep) return { ok: true, deleted: false, kept: true, left: others.length > 0 };
      return { ok: true, deleted: false, left: true, reason: `${others.length} other teardown(s) of this workspace are still running` };
    }
    fs.rmSync(snapshotPath(workspaceDir), { force: true });
    return { ok: true, deleted: true };
  } catch (e) {
    return { ok: false, deleted: false, reason: `release failed: ${e.message}` };
  } finally {
    releaseLease(lease);
  }
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
  claimBaselineSnapshot,
  removeCreatedDir,
  deleteSnapshot,
  releaseTombstone,
  TEARDOWN_STALE_MS,
  RELEASE_ATTEMPTS,
};
