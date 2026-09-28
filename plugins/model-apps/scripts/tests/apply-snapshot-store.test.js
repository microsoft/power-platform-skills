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

test('acquireLease reclaims a STALE lease (token older than staleMs)', () => {
  const d = ws();
  try {
    const a = store.acquireLease(d, { now: () => 1000, pid: 111, processAlive: () => true, staleMs: 10000 });
    assert.ok(a.ok);
    // 20s later — older than the 10s stale window — a different build reclaims it.
    const b = store.acquireLease(d, { now: () => 21000, pid: 222, processAlive: () => true, staleMs: 10000 });
    assert.ok(b.ok);
    assert.strictEqual(b.reclaimed, true);
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
    const b = store.acquireLease(d, { now: () => 21000, pid: 222, processAlive: () => true, staleMs: 10000 });
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
