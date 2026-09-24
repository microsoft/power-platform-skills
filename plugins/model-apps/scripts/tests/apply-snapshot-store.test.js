'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/apply-snapshot-store.js');
const S = require('../lib/apply-snapshot.js');

// Each test gets its own throwaway workspace so the real filesystem I/O can't cross-contaminate.
function ws() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-snap-'));
  return d;
}
function rm(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }

const LIVE = { orgId: 'org-1', envUrl: 'https://e', appUniqueName: 'new_app', appId: 'app-1' };
function eligible(gen) {
  const e = S.makeEnvelope(LIVE, { generation: gen || 'g1' });
  S.markEligible(e);
  return e;
}

test('writeSnapshotAtomic + readSnapshot round-trip and leave NO temp file behind', () => {
  const d = ws();
  try {
    store.writeSnapshotAtomic(d, eligible('g1'));
    const back = store.readSnapshot(d);
    assert.strictEqual(back.eligible, true);
    assert.strictEqual(back.generation, 'g1');
    const leftover = fs.readdirSync(d).filter((f) => f.endsWith('.tmp'));
    assert.deepStrictEqual(leftover, [], 'atomic write must not leave a .tmp file');
  } finally { rm(d); }
});

test('readSnapshot: absent file -> null; garbage/foreign-schema -> null (fail-closed)', () => {
  const d = ws();
  try {
    assert.strictEqual(store.readSnapshot(d), null);
    fs.writeFileSync(store.snapshotPath(d), '{ broken json');
    assert.strictEqual(store.readSnapshot(d), null);
    fs.writeFileSync(store.snapshotPath(d), JSON.stringify({ schema: 2, debt: [] }));
    assert.strictEqual(store.readSnapshot(d), null, 'a schema-2 file is unusable');
  } finally { rm(d); }
});

test('acquireLease is exclusive: a live young holder blocks a second acquire; release frees it', () => {
  const d = ws();
  try {
    const deps = { now: () => 1000, processAlive: () => true, staleMs: store.LEASE_STALE_MS };
    const a = store.acquireLease(d, { ...deps, pid: 111 });
    assert.ok(a.ok);
    const b = store.acquireLease(d, { ...deps, pid: 222 });
    assert.strictEqual(b.ok, false, 'a live, young lease must block a second acquire');
    assert.match(b.reason, /held by pid 111/);
    store.releaseLease(a);
    const c = store.acquireLease(d, { ...deps, pid: 222 });
    assert.ok(c.ok, 'after release the lease is acquirable again');
  } finally { rm(d); }
});

// A live holder may be paused mid-write (a machine asleep): reclaiming its lease by age let it resume and
// commit a stale view over the generation fence. So a lease that names a live holder is never reclaimed,
// however old — and an old one says which file to delete, since a crashed holder's pid may have been reused.
test('acquireLease never reclaims a live holder\u2019s lease, however old, and says how to clear an old one', () => {
  const d = ws();
  try {
    const a = store.acquireLease(d, { now: () => 1000, pid: 111, processAlive: () => true, staleMs: 10000 });
    assert.ok(a.ok);
    const b = store.acquireLease(d, { now: () => 21000, pid: 222, processAlive: () => true, staleMs: 10000 });
    assert.strictEqual(b.ok, false, 'older than the stale window, but its holder is alive');
    assert.match(b.reason, /held by pid 111/);
    assert.ok(b.reason.includes(`delete ${store.leasePath(d)} and re-run`), b.reason);
    assert.strictEqual(fs.readFileSync(store.leasePath(d), 'utf8'), a.token, 'the lock is untouched');
    const young = store.acquireLease(d, { now: () => 5000, pid: 222, processAlive: () => true, staleMs: 10000 });
    assert.ok(!young.ok && !/delete /.test(young.reason), 'a young one is simply held');
    const dead = store.acquireLease(d, { now: () => 21000, pid: 222, processAlive: () => false, staleMs: 10000 });
    assert.ok(dead.ok && dead.reclaimed, 'once its holder is dead, it is reclaimed');
  } finally { rm(d); }
});

test('acquireLease reclaims a lease whose holder pid is DEAD, even if young', () => {
  const d = ws();
  try {
    store.acquireLease(d, { now: () => 1000, pid: 111, processAlive: () => true, staleMs: 60000 });
    const b = store.acquireLease(d, { now: () => 1500, pid: 222, processAlive: () => false, staleMs: 60000 });
    assert.ok(b.ok);
    assert.strictEqual(b.reclaimed, true, 'a dead holder is reclaimable regardless of age');
  } finally { rm(d); }
});

test('releaseLease is owner-checked: a late release does NOT delete a lock another build reclaimed', () => {
  const d = ws();
  try {
    const a = store.acquireLease(d, { now: () => 1000, pid: 111, processAlive: () => true, staleMs: 10000 });
    const b = store.acquireLease(d, { now: () => 21000, pid: 222, processAlive: () => false, staleMs: 10000 });
    assert.ok(b.ok && b.reclaimed);
    store.releaseLease(a); // a's token no longer on disk — must be a no-op
    assert.ok(fs.existsSync(store.leasePath(d)), "the reclaimer's lock must survive the original holder's release");
    assert.strictEqual(fs.readFileSync(store.leasePath(d), 'utf8'), b.token);
  } finally { rm(d); }
});

test('casWriteSnapshot: matching generation writes; mismatched is REFUSED', () => {
  const d = ws();
  try {
    store.writeSnapshotAtomic(d, eligible('g1'));
    const bad = store.casWriteSnapshot(d, eligible('g2'), 'gWRONG');
    assert.strictEqual(bad.ok, false);
    assert.match(bad.reason, /CAS/);
    assert.strictEqual(store.readSnapshot(d).generation, 'g1', 'a refused CAS must not have written');
    const good = store.casWriteSnapshot(d, eligible('g2'), 'g1');
    assert.ok(good.ok);
    assert.strictEqual(store.readSnapshot(d).generation, 'g2');
  } finally { rm(d); }
});

test('casWriteSnapshot: expected-none-but-one-exists, and expected-gen-but-vanished, are both refused', () => {
  const d = ws();
  try {
    // Expected no prior snapshot, but one exists -> refuse (concurrent create).
    store.writeSnapshotAtomic(d, eligible('g1'));
    const r1 = store.casWriteSnapshot(d, eligible('g2'), null);
    assert.strictEqual(r1.ok, false);
    assert.match(r1.reason, /concurrent create/);
    // Expected an existing snapshot, but it vanished -> refuse (concurrent delete/teardown).
    store.deleteSnapshot(d);
    const r2 = store.casWriteSnapshot(d, eligible('g2'), 'g1');
    assert.strictEqual(r2.ok, false);
    assert.match(r2.reason, /vanished/);
  } finally { rm(d); }
});

test('invalidateSnapshot flips eligible->false and persists; a missing snapshot is already-safe (ok)', () => {
  const d = ws();
  try {
    assert.strictEqual(store.invalidateSnapshot(d).ok, true, 'no snapshot = nothing to invalidate = ok');
    store.writeSnapshotAtomic(d, eligible('g1'));
    assert.strictEqual(store.readSnapshot(d).eligible, true);
    const r = store.invalidateSnapshot(d);
    assert.ok(r.ok);
    assert.strictEqual(store.readSnapshot(d).eligible, false, 'invalidate must persist eligible:false');
    // Lease is released afterward, so a follow-up acquire succeeds.
    const lease = store.acquireLease(d, { now: () => 1, pid: 1, processAlive: () => true });
    assert.ok(lease.ok, 'invalidate must release its lease');
  } finally { rm(d); }
});

test('tombstoneSnapshot persists eligible:false + teardown debt (before any delete)', () => {
  const d = ws();
  try {
    store.writeSnapshotAtomic(d, eligible('g1'));
    const r = store.tombstoneSnapshot(d);
    assert.ok(r.ok);
    const disk = store.readSnapshot(d);
    assert.strictEqual(disk.eligible, false);
    assert.ok(S.isTombstoned(disk), 'tombstone debt must be persisted');
  } finally { rm(d); }
});

// #587 item 1: a tombstone must FENCE, not merely mark. A changed-only run that read the snapshot before
// the tombstone holds its generation; a tombstone that keeps that generation lets the run's later writes
// still match it — and measured before this fix, the run re-blessed its stale copy over the tombstone.
test('tombstoneSnapshot rotates the generation, so every write by a pre-tombstone reader is refused', () => {
  const d = ws();
  try {
    store.writeSnapshotAtomic(d, eligible('g1'));
    assert.ok(store.tombstoneSnapshot(d).ok);
    const disk = store.readSnapshot(d);
    assert.ok(disk.generation && disk.generation !== 'g1', `the tombstone must rotate the generation; got ${disk.generation}`);
    assert.strictEqual(store.invalidateSnapshot(d, { expectedGeneration: 'g1' }).ok, false);
    assert.strictEqual(store.casWriteSnapshot(d, eligible('g2'), 'g1').ok, false);
    assert.ok(S.isTombstoned(store.readSnapshot(d)), 'and the tombstone is intact');
  } finally { rm(d); }
});

test('invalidateSnapshot with an expected generation refuses a snapshot that changed or vanished since it was read', () => {
  const d = ws();
  try {
    store.writeSnapshotAtomic(d, eligible('g1'));
    const stale = store.invalidateSnapshot(d, { expectedGeneration: 'gOTHER' });
    assert.strictEqual(stale.ok, false);
    assert.match(stale.reason, /changed since/);
    assert.strictEqual(store.readSnapshot(d).eligible, true, 'a refused invalidate writes nothing');
    const good = store.invalidateSnapshot(d, { expectedGeneration: 'g1' });
    assert.ok(good.ok && good.generation && good.generation !== 'g1', JSON.stringify(good));
    store.deleteSnapshot(d);
    const gone = store.invalidateSnapshot(d, { expectedGeneration: good.generation });
    assert.strictEqual(gone.ok, false, 'a snapshot deleted since it was read is not "nothing to invalidate"');
    assert.match(gone.reason, /deleted/);
    assert.strictEqual(store.invalidateSnapshot(d).ok, true, 'without a fence, a missing snapshot is still already-safe');
  } finally { rm(d); }
});

// Its read and its write are two steps, so a tombstone written between them was overwritten. The
// lease is what serializes a tombstone against everything else, so the CAS write must take it too.
test('casWriteSnapshot takes the lease itself, so it cannot interleave with a tombstone', () => {
  const d = ws();
  try {
    store.writeSnapshotAtomic(d, eligible('g1'));
    const held = store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => true, staleMs: store.LEASE_STALE_MS });
    assert.ok(held.ok);
    const r = store.casWriteSnapshot(d, eligible('g2'), 'g1');
    assert.strictEqual(r.ok, false, 'a CAS write must not proceed while another writer holds the lease');
    assert.strictEqual(store.readSnapshot(d).generation, 'g1');
    store.releaseLease(held);
    assert.strictEqual(store.casWriteSnapshot(d, eligible('g2'), 'g1').ok, true);
  } finally { rm(d); }
});

// A workspace with NO snapshot is fenced too. A first changed-only build has none until it finishes, and
// answering "nothing to fence" there let that build write an eligible baseline for the app this teardown had
// just deleted. The fresh tombstone refuses the build's claim; the folder it had to create is reported so a
// clean teardown can remove it again.
test('tombstoneSnapshot with no snapshot writes a fresh tombstone that refuses a later claim, and reports the folder it created', () => {
  const parent = ws();
  try {
    const d = path.join(parent, 'a', '.maker-workspace');
    const r = store.tombstoneSnapshot(d);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(path.resolve(r.createdDir), path.resolve(parent, 'a'), 'the first folder mkdir created');
    const disk = store.readSnapshot(d);
    assert.ok(S.isTombstoned(disk) && disk.eligible === false && disk.generation, JSON.stringify(disk));
    assert.deepStrictEqual(fs.readdirSync(d), [store.SNAPSHOT_FILE], 'the lease is released');
    const claim = store.claimBaselineSnapshot(d, LIVE);
    assert.strictEqual(claim.ok, false, 'a build that has not claimed yet must not start under a teardown');
    assert.match(claim.reason, /appeared since/);
    // After a clean teardown the caller deletes the snapshot and removes what the tombstone created.
    store.deleteSnapshot(d);
    store.removeCreatedDir(d, r.createdDir);
    assert.deepStrictEqual(fs.readdirSync(parent), [], 'a folder that never had a workspace is left without one');
  } finally { rm(parent); }
});

test('tombstoneSnapshot in an existing folder reports no createdDir, and fences an unreadable snapshot too', () => {
  const d = ws();
  try {
    fs.writeFileSync(store.snapshotPath(d), '{ not json');
    const r = store.tombstoneSnapshot(d);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.createdDir, null);
    assert.ok(S.isTombstoned(store.readSnapshot(d)), 'the unreadable file is replaced by a tombstone');
  } finally { rm(d); }
});

test('tombstoneSnapshot where no folder can exist has nothing to fence, and writes nothing', () => {
  const parent = ws();
  try {
    const file = path.join(parent, 'afile');
    fs.writeFileSync(file, 'x');
    for (const d of [file, path.join(file, '.maker-workspace')]) {
      const r = store.tombstoneSnapshot(d);
      assert.ok(r.ok, JSON.stringify(r));
      assert.match(r.reason, /no workspace can exist/);
    }
    assert.deepStrictEqual(fs.readdirSync(parent), ['afile']);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'x');
  } finally { rm(parent); }
});

// A TRANSIENT mkdir failure is not proof that no build can use the folder, so the fence fails closed.
test('tombstoneSnapshot fails closed when the folder cannot be created for a transient reason', () => {
  const busy = () => { const e = new Error('resource busy or locked'); e.code = 'EBUSY'; throw e; };
  const r = store.tombstoneSnapshot(path.join(os.tmpdir(), 'never-created-ws'), { mkdirSync: busy });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /tombstone failed: resource busy/);
});

test('removeCreatedDir leaves a folder that is no longer empty, everything above it, and an unrelated pair', () => {
  const parent = ws();
  try {
    const d = path.join(parent, 'a', 'b');
    const created = fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'build-owned.json'), '{}');
    store.removeCreatedDir(d, created);
    assert.ok(fs.existsSync(path.join(d, 'build-owned.json')), 'a concurrent build\'s file survives');
    fs.rmSync(path.join(d, 'build-owned.json'));
    store.removeCreatedDir(d, path.join(parent, 'unrelated'));
    store.removeCreatedDir(path.join(parent, 'a'), d);
    store.removeCreatedDir(d, null);
    assert.ok(fs.existsSync(d), 'nothing outside what was created is touched');
    store.removeCreatedDir(d, created);
    assert.deepStrictEqual(fs.readdirSync(parent), [], 'the created chain is removed deepest first');
  } finally { rm(parent); }
});

// The build-side half: a FIRST build claims a placeholder so it has a generation to be fenced by.
test('claimBaselineSnapshot writes an ineligible, debt-free placeholder whose generation the baseline CAS then needs', () => {
  const d = ws();
  try {
    const claim = store.claimBaselineSnapshot(d, LIVE);
    assert.ok(claim.ok && claim.generation, JSON.stringify(claim));
    const disk = store.readSnapshot(d);
    assert.strictEqual(disk.generation, claim.generation);
    assert.strictEqual(disk.eligible, false);
    assert.deepStrictEqual(disk.debt, [], 'no debt: a later baseline inherits its prior\'s debt');
    assert.strictEqual(disk.priorSpec, null);
    assert.deepStrictEqual([disk.orgId, disk.envUrl, disk.appUniqueName], [LIVE.orgId, LIVE.envUrl, LIVE.appUniqueName]);
    assert.strictEqual(store.claimBaselineSnapshot(d, LIVE).ok, false, 'a second claim is refused');
    assert.strictEqual(store.casWriteSnapshot(d, eligible('g2'), null).ok, false, 'an "expected none" write no longer matches');
    assert.ok(store.casWriteSnapshot(d, eligible('g2'), claim.generation).ok, 'the claimer\'s own baseline write succeeds');
  } finally { rm(d); }
});

test('a teardown after the claim tombstones the placeholder, so the claimer\'s baseline write is refused', () => {
  const d = ws();
  try {
    const claim = store.claimBaselineSnapshot(d, LIVE);
    assert.ok(claim.ok);
    assert.ok(store.tombstoneSnapshot(d).ok);
    assert.strictEqual(store.casWriteSnapshot(d, eligible('g2'), claim.generation).ok, false);
    assert.ok(S.isTombstoned(store.readSnapshot(d)), 'the tombstone survives');
  } finally { rm(d); }
});

test('claimBaselineSnapshot is refused while another writer holds the lease, and writes nothing', () => {
  const d = ws();
  try {
    const held = store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => true, staleMs: store.LEASE_STALE_MS });
    assert.ok(held.ok);
    const r = store.claimBaselineSnapshot(d, LIVE);
    store.releaseLease(held);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /lease/);
    assert.strictEqual(store.readSnapshot(d), null);
  } finally { rm(d); }
});

// A claim that cannot be written must say so — the flow aborts on { ok:false } — rather than throw out of
// the build. A folder squatting on the snapshot path makes the atomic rename fail.
test('claimBaselineSnapshot reports a failed write instead of throwing, and releases the lease', () => {
  const d = ws();
  try {
    fs.mkdirSync(store.snapshotPath(d));
    const r = store.claimBaselineSnapshot(d, LIVE);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /^claim failed: /);
    assert.strictEqual(fs.existsSync(store.leasePath(d)), false, 'the lease is released');
  } finally { rm(d); }
});

// A clean teardown releases its own entry; the tombstone goes only with the LAST entry of a teardown still
// alive — and then whatever the snapshot has become, so an eligible baseline is never left behind.
test('releaseTombstone keeps the fence for teardowns still running, and deletes whatever is there after the last', (t) => {
  const d = ws();
  try {
    const a = store.tombstoneSnapshot(d);
    const b = store.tombstoneSnapshot(d);
    assert.ok(a.teardownId && b.teardownId && a.teardownId !== b.teardownId);
    assert.deepStrictEqual(store.readSnapshot(d).teardowns.map((x) => x.id), [a.teardownId, b.teardownId]);
    const genBefore = store.readSnapshot(d).generation;
    const first = store.releaseTombstone(d, b.teardownId);
    assert.deepStrictEqual([first.ok, first.deleted, first.left], [true, false, true]);
    assert.match(first.reason, /1 other teardown\(s\) of this workspace are still running/);
    const kept = store.readSnapshot(d);
    assert.ok(S.isTombstoned(kept) && kept.eligible === false);
    assert.deepStrictEqual(kept.teardowns.map((x) => x.id), [a.teardownId]);
    assert.notStrictEqual(kept.generation, genBefore, 'the generation is rotated, fencing any build that read it');
    assert.strictEqual(store.claimBaselineSnapshot(d, LIVE).ok, false, 'no first build can claim meanwhile');
    // Whatever the snapshot has become — here an ELIGIBLE one that took the tombstone's place, still
    // listing a second teardown — a release re-fences it while any other teardown runs, and the last one
    // deletes it rather than leave it describing an app that is gone.
    const c = { id: 'td-c', pid: process.pid, at: Date.now() };
    const eligibleOverIt = eligible('g9');
    eligibleOverIt.teardowns = [...kept.teardowns, c];
    store.writeSnapshotAtomic(d, eligibleOverIt);
    assert.strictEqual(store.releaseTombstone(d, c.id).left, true);
    const refenced = store.readSnapshot(d);
    assert.ok(S.isTombstoned(refenced) && refenced.eligible === false, 'no eligible snapshot is left standing while a teardown runs');
    assert.deepStrictEqual(store.releaseTombstone(d, a.teardownId), { ok: true, deleted: true });
    assert.strictEqual(store.readSnapshot(d), null);
    assert.deepStrictEqual(store.releaseTombstone(d, a.teardownId), { ok: true, deleted: false, gone: true }, 'nothing left to release');
  } finally { rm(d); }
});

test('releaseTombstone drops entries whose teardown is gone, never recreates a removed folder, and reports a failed delete', (t) => {
  const d = ws();
  try {
    const dead = store.tombstoneSnapshot(d, { pid: 999991 });
    const mine = store.tombstoneSnapshot(d, { processAlive: () => true });
    assert.ok(store.readSnapshot(d).teardowns.some((x) => x.id === dead.teardownId), 'listed while its process counts as alive');
    // The other entry's process is dead, so this teardown is the last one alive.
    const rel = store.releaseTombstone(d, mine.teardownId, { processAlive: (pid) => pid !== 999991 });
    assert.deepStrictEqual(rel, { ok: true, deleted: true });
    // A day-old entry is dropped too, whatever its pid says (a pid can be reused).
    const old = store.tombstoneSnapshot(d, { now: () => Date.now() - store.TEARDOWN_STALE_MS - 1000 });
    const again = store.tombstoneSnapshot(d);
    assert.ok(!store.readSnapshot(d).teardowns.some((x) => x.id === old.teardownId), 'a day-old entry is pruned at the next tombstone');
    const realRm = fs.rmSync;
    const rmMock = t.mock.method(fs, 'rmSync', (p, o) => {
      if (String(p).endsWith(store.SNAPSHOT_FILE)) throw new Error('EBUSY: resource busy or locked');
      return realRm(p, o);
    });
    const failed = store.releaseTombstone(d, again.teardownId);
    rmMock.mock.restore();
    assert.deepStrictEqual([failed.ok, failed.deleted], [false, false]);
    assert.match(failed.reason, /^release failed: EBUSY/);
    const held = store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => true, staleMs: store.LEASE_STALE_MS });
    const blocked = store.releaseTombstone(d, again.teardownId, { sleep: () => {} });
    store.releaseLease(held);
    assert.deepStrictEqual([blocked.ok, blocked.deleted], [false, false]);
    assert.match(blocked.reason, /lease unavailable/);
  } finally { rm(d); }
  const parent = ws();
  try {
    const gone = path.join(parent, '.maker-workspace');
    assert.deepStrictEqual(store.releaseTombstone(gone, 'x'), { ok: true, deleted: false, gone: true });
    assert.strictEqual(fs.existsSync(gone), false, 'releasing into a removed workspace does not recreate it');
  } finally { rm(parent); }
});

// A teardown that failed or threw still drops its entry — it is no longer in flight — but never deletes:
// the tombstone stays, so a surviving artifact is never rebaselined.
test('releaseTombstone with keep drops the entry but keeps the tombstone, even as the last one', () => {
  const d = ws();
  try {
    const a = store.tombstoneSnapshot(d);
    const gen = store.readSnapshot(d).generation;
    assert.deepStrictEqual(store.releaseTombstone(d, a.teardownId, { keep: true }), { ok: true, deleted: false, kept: true, left: false });
    const kept = store.readSnapshot(d);
    assert.ok(S.isTombstoned(kept) && kept.eligible === false);
    assert.deepStrictEqual(kept.teardowns, []);
    assert.notStrictEqual(kept.generation, gen, 'the generation is rotated');
    const b = store.tombstoneSnapshot(d);
    const c = store.tombstoneSnapshot(d);
    assert.deepStrictEqual(store.releaseTombstone(d, b.teardownId, { keep: true }), { ok: true, deleted: false, kept: true, left: true });
    assert.deepStrictEqual(store.readSnapshot(d).teardowns.map((x) => x.id), [c.teardownId]);
    assert.deepStrictEqual(store.releaseTombstone(d, c.teardownId), { ok: true, deleted: true }, 'the last clean release still deletes it');
    // An unreadable snapshot becomes a fresh tombstone, never stays unreadable.
    fs.writeFileSync(store.snapshotPath(d), '{ not json');
    assert.strictEqual(store.releaseTombstone(d, 'td-x', { keep: true }).kept, true);
    assert.ok(S.isTombstoned(store.readSnapshot(d)));
  } finally { rm(d); }
});

// A lease held for a moment (a build persisting its snapshot) is waited out, a bounded number of times:
// giving up at once left a finished teardown's entry behind, reading as one still running.
test('releaseTombstone retries a briefly held lease, then gives up', () => {
  const d = ws();
  try {
    const hold = () => store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => true, staleMs: store.LEASE_STALE_MS });
    const a = store.tombstoneSnapshot(d);
    const held = hold();
    let waits = 0;
    const r = store.releaseTombstone(d, a.teardownId, { sleep: () => { waits += 1; if (waits === 2) store.releaseLease(held); } });
    assert.deepStrictEqual(r, { ok: true, deleted: true });
    assert.strictEqual(waits, 2, 'it waited while the lease was held, then went ahead');
    const b = store.tombstoneSnapshot(d);
    const held2 = hold();
    let tries = 0;
    const gaveUp = store.releaseTombstone(d, b.teardownId, { sleep: () => { tries += 1; } });
    store.releaseLease(held2);
    assert.deepStrictEqual([gaveUp.ok, gaveUp.deleted], [false, false]);
    assert.match(gaveUp.reason, /lease unavailable/);
    assert.strictEqual(tries, store.RELEASE_ATTEMPTS - 1, 'a bounded number of waits');
  } finally { rm(d); }
});

// Two writers finding the same stale lock both overwrote it, and each could read its own token back before
// the other's write landed — two holders. Only the writer that creates the claim file may reclaim, and only
// while the lock still holds exactly what it judged stale.
test('a stale lock is reclaimed by one writer only, and never once it has changed', (t) => {
  const d = ws();
  try {
    const lp = store.leasePath(d);
    const claim = `${lp}.reclaim`;
    const stale = JSON.stringify({ pid: 7, at: 0 });
    const reclaim = () => store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => false, staleMs: store.LEASE_STALE_MS });
    // Another writer is reclaiming right now: this one fails closed and leaves the lock alone.
    fs.writeFileSync(lp, stale);
    fs.writeFileSync(claim, 'another writer');
    const busy = reclaim();
    assert.deepStrictEqual([busy.ok, busy.reason], [false, 'lease being reclaimed by another writer']);
    assert.strictEqual(fs.readFileSync(lp, 'utf8'), stale);
    assert.ok(fs.existsSync(claim), 'a young claim is not removed');
    // A claim older than the staleness window was abandoned: it is removed, and the next attempt reclaims.
    const old = new Date(Date.now() - store.LEASE_STALE_MS - 60000);
    fs.utimesSync(claim, old, old);
    assert.strictEqual(reclaim().ok, false);
    assert.ok(!fs.existsSync(claim), 'the abandoned claim is removed');
    const won = reclaim();
    assert.deepStrictEqual([won.ok, won.reclaimed], [true, true]);
    assert.ok(!fs.existsSync(claim), 'and a reclaim leaves no claim behind');
    store.releaseLease(won);
    // The lock changed between the judgment and the claim — another writer reclaimed it meanwhile, say: it
    // is not overwritten.
    fs.writeFileSync(lp, stale);
    const realRead = fs.readFileSync;
    let reads = 0;
    const readMock = t.mock.method(fs, 'readFileSync', (p, ...rest) => {
      if (p === lp && ++reads === 2) return JSON.stringify({ pid: 9, at: Date.now() });
      return realRead(p, ...rest);
    });
    const changed = reclaim();
    readMock.mock.restore();
    assert.deepStrictEqual([changed.ok, changed.reason], [false, 'lease changed while it was being reclaimed']);
    assert.strictEqual(fs.readFileSync(lp, 'utf8'), stale, 'the lock is not overwritten');
    assert.ok(!fs.existsSync(claim));
  } finally { rm(d); }
});

// A running teardown refreshes its entry, and an entry counts only while it keeps being seen: a KILLED
// teardown never drops its entry, and under a reused (live) pid that entry kept every changed-only build
// refused — and every later clean teardown "left" — for a day.
test('beatTeardown keeps an entry counted, and an entry no longer seen stops counting even under a live pid', (t) => {
  const d = ws();
  try {
    const old = Date.now() - store.TEARDOWN_STALE_MS - 1000;
    const killed = store.tombstoneSnapshot(d, { now: () => old, pid: process.pid });
    assert.deepStrictEqual(store.teardownsInFlight(store.readSnapshot(d)), [], 'not seen for longer than the window: not running, though its pid is alive');
    const gen = store.readSnapshot(d).generation;
    assert.deepStrictEqual(store.beatTeardown(d, killed.teardownId), { ok: true });
    const beaten = store.readSnapshot(d);
    assert.deepStrictEqual(store.teardownsInFlight(beaten).map((x) => x.id), [killed.teardownId], 'a fresh beat counts again');
    assert.strictEqual(beaten.generation, gen, 'a beat rotates no fence');
    // Quiet, one-attempt skips: an unknown entry, a held lease, no snapshot.
    assert.deepStrictEqual(store.beatTeardown(d, 'td-unknown'), { ok: false, reason: 'no entry for this teardown' });
    const held = store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => true, staleMs: store.LEASE_STALE_MS });
    const blocked = store.beatTeardown(d, killed.teardownId);
    store.releaseLease(held);
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /^lease held by pid/);
    fs.rmSync(store.snapshotPath(d));
    assert.deepStrictEqual(store.beatTeardown(d, killed.teardownId), { ok: false, reason: 'no snapshot' });
  } finally { rm(d); }
});

// A lock released between our exclusive create and our look at it is free — but free for everyone, so it is
// re-taken exclusively. Overwriting it let a writer that created it meanwhile hold the lease as well.
test('acquireLease re-takes a lock that vanished meanwhile exclusively, never by overwriting it', (t) => {
  const d = ws();
  try {
    const lp = store.leasePath(d);
    const realRead = fs.readFileSync;
    for (const [what, onRead, want] of [
      ['released, nobody else took it', () => fs.rmSync(lp, { force: true }), (r) => r.ok && !r.reclaimed],
      ['released and re-taken by another writer', () => {}, (r) => r.ok === false && /taken by another writer just now/.test(r.reason)],
    ]) {
      fs.writeFileSync(lp, JSON.stringify({ pid: 7, at: Date.now() }));
      let once = true;
      const readMock = t.mock.method(fs, 'readFileSync', (p, ...rest) => {
        if (once && p === lp) { once = false; onRead(); throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }); }
        return realRead(p, ...rest);
      });
      const r = store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => true, staleMs: store.LEASE_STALE_MS });
      readMock.mock.restore();
      assert.ok(want(r), `${what}: ${JSON.stringify(r)}`);
      if (r.ok) store.releaseLease(r);
      fs.rmSync(lp, { force: true });
    }
    // A token that cannot be read whole, in a file that cannot be looked at either, is left held
    // (fail-closed): only a lock proven gone is re-taken.
    fs.writeFileSync(lp, '');
    const realStat = fs.statSync;
    const statMock = t.mock.method(fs, 'statSync', (p, ...rest) => {
      if (p === lp) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return realStat(p, ...rest);
    });
    const unknown = store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => true, staleMs: store.LEASE_STALE_MS });
    statMock.mock.restore();
    assert.strictEqual(unknown.ok, false);
    assert.match(unknown.reason, /^lease held/);
    fs.rmSync(lp, { force: true });
    // A stale lock reclaimed by overwrite is held only if OUR token is still there when read back.
    fs.writeFileSync(lp, JSON.stringify({ pid: 7, at: 0 }));
    const realWrite = fs.writeFileSync;
    const writeMock = t.mock.method(fs, 'writeFileSync', (p, data, o) => {
      realWrite(p, data, o);
      if (p === lp && !o) realWrite(p, JSON.stringify({ pid: 8, at: Date.now() })); // another reclaimer's write lands after ours
    });
    const lost = store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => false, staleMs: store.LEASE_STALE_MS });
    writeMock.mock.restore();
    assert.strictEqual(lost.ok, false);
    assert.match(lost.reason, /reclaimed by another writer just now/);
  } finally { rm(d); }
});

// The reclaim CLAIM follows the lock's own rule: a claimer that is alive keeps it however old it is — one
// paused mid-reclaim lost it to age, a second writer reclaimed, and both held the lease — and a dead
// claimer's is removed at once. A claim with no readable token is still aged by its file.
test('a reclaim claim is abandoned only when its claimer is dead', () => {
  const d = ws();
  try {
    const lp = store.leasePath(d);
    const claim = `${lp}.reclaim`;
    fs.writeFileSync(lp, JSON.stringify({ pid: 7, at: 0 }));
    fs.writeFileSync(claim, JSON.stringify({ pid: 4242, at: 0 }));
    const old = new Date(Date.now() - store.LEASE_STALE_MS - 60000);
    fs.utimesSync(claim, old, old);
    const attempt = (alive) => store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: (p) => alive.includes(p), staleMs: store.LEASE_STALE_MS });
    const busy = attempt([4242]);
    assert.strictEqual(busy.ok, false);
    assert.match(busy.reason, /^lease being reclaimed by another writer/);
    assert.ok(busy.reason.includes(`delete ${claim} and re-run`), `an old one says which file to delete: ${busy.reason}`);
    assert.ok(fs.existsSync(claim), 'a live claimer keeps its claim, however old');
    assert.strictEqual(attempt([]).ok, false);
    assert.ok(!fs.existsSync(claim), 'a dead claimer\u2019s claim is removed');
    const won = attempt([]);
    assert.deepStrictEqual([won.ok, won.reclaimed], [true, true]);
    store.releaseLease(won);
  } finally { rm(d); }
});

// A reclaim whose write landed but whose read-back failed used to leave the lock holding this process's
// token: nobody else reclaims it (the pid is alive), so the process then blocked itself. It is released.
test('a reclaim that fails after its write leaves no lock holding its own token', (t) => {
  const d = ws();
  try {
    const lp = store.leasePath(d);
    fs.writeFileSync(lp, JSON.stringify({ pid: 7, at: 0 }));
    const realRead = fs.readFileSync;
    let reads = 0;
    const readMock = t.mock.method(fs, 'readFileSync', (p, ...rest) => {
      if (p === lp && ++reads === 3) throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
      return realRead(p, ...rest);
    });
    const r = store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => false, staleMs: store.LEASE_STALE_MS });
    readMock.mock.restore();
    assert.deepStrictEqual([r.ok, /stale lease reclaim failed: resource busy/.test(r.reason)], [false, true]);
    assert.ok(!fs.existsSync(lp), 'the lock it wrote is released');
    assert.ok(store.acquireLease(d, { now: () => Date.now(), pid: process.pid, processAlive: () => true, staleMs: store.LEASE_STALE_MS }).ok, 'and the next acquire succeeds');
  } finally { rm(d); }
});

// The 'wx' create makes the lock BEFORE it writes the token, so a reader can find it empty. Presuming such
// a lock abandoned let two writers hold the lease at once; an unreadable token is aged by its FILE instead.
test('acquireLease treats an unreadable token as held until the lock file itself is stale', () => {
  const d = ws();
  try {
    const deps = { now: () => Date.now(), pid: 2, processAlive: () => false, staleMs: store.LEASE_STALE_MS };
    for (const body of ['', '{"pid":7}']) {
      fs.writeFileSync(store.leasePath(d), body);
      const young = store.acquireLease(d, deps);
      assert.strictEqual(young.ok, false, `a young lock holding ${JSON.stringify(body)} is not abandoned`);
    }
    const old = (Date.now() - store.LEASE_STALE_MS - 60000) / 1000;
    fs.utimesSync(store.leasePath(d), old, old);
    const stale = store.acquireLease(d, deps);
    assert.ok(stale.ok && stale.reclaimed, 'an unreadable lock that old is');
  } finally { rm(d); }
});

test('deleteSnapshot removes the file; deleting a missing file is success', () => {
  const d = ws();
  try {
    store.writeSnapshotAtomic(d, eligible('g1'));
    assert.ok(fs.existsSync(store.snapshotPath(d)));
    assert.ok(store.deleteSnapshot(d).ok);
    assert.ok(!fs.existsSync(store.snapshotPath(d)));
    assert.ok(store.deleteSnapshot(d).ok, 'deleting an absent snapshot is ok');
  } finally { rm(d); }
});

test('invalidate BUMPS the generation (fencing) and returns it; eligible stays false', () => {
  // Fencing (Sol #6): invalidate rotates the generation so a concurrent reader holding the pre-invalidate
  // token can no longer win the re-bless CAS. The returned generation is what the caller passes as the CAS
  // `expected` on its re-bless.
  const d = ws();
  try {
    store.writeSnapshotAtomic(d, eligible('g1'));
    const inv = store.invalidateSnapshot(d);
    assert.ok(inv.ok);
    assert.notStrictEqual(inv.generation, 'g1', 'invalidate rotates the generation');
    const disk = store.readSnapshot(d);
    assert.strictEqual(disk.generation, inv.generation, 'the returned generation matches what was persisted');
    assert.strictEqual(disk.eligible, false);
    // A CAS write expecting the OLD generation is now refused; expecting the returned generation succeeds.
    assert.strictEqual(store.casWriteSnapshot(d, eligible('g2'), 'g1').ok, false);
    assert.strictEqual(store.casWriteSnapshot(d, eligible('g2'), inv.generation).ok, true);
  } finally { rm(d); }
});
