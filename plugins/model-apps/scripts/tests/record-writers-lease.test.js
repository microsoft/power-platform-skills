'use strict';
// Two builds that share a workspace and an environment write the same recovery record: the web resources a build wrote and could not confirm
// were published (lib/web-resource-records.js), and the dashboards a build created and has not yet seen join the app's solution
// (lib/dashboard-creation-records.js). Each record is ONE file that holds every entry, replaced whole on each change. A run read it once and then
// wrote its own copy: with both runs reading before either wrote, A noting `a` and then B noting `b` answered true twice and left only `b` on disk,
// and A clearing `a` afterwards deleted the file — `b` with it, the id the next build needed to repair an unconfirmed publication, or to find a
// dashboard outside its solution. Replacing the file atomically does not prevent that: each write is whole, and the later one still wins. Each
// change is now made under the record's writer lease (lib/record-lease.js) to the record as it is on disk at that moment.
//
// Held here, for each record:
//   1. the interleavings: both runs read, A notes, B notes, A clears, B clears — every entry stays until its own run clears it, and the file goes
//      with the last one
//   2. a change touches only what its run knows: an entry of the same name that another run recorded since, under another id, is neither replaced
//      nor removed, and a reported id is added only to the entry its run noted; a file that has become unreadable since a run read it is treated as
//      an unreadable one always was (the dashboard record is not written over, the web-resource record is replaced by a note); a clear in a workspace
//      that has gone makes nothing
//   3. the lease: one that another live run holds is waited for a bounded time, and then the change is not made — said once, the file left as it
//      was, never a hang; one left by a run that is gone is taken over; reads never wait for it
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { acquireLease, releaseLease } = require('../lib/apply-snapshot-store.js');
const { ownerStamp, ownerState } = require('../lib/process-owner.js');
const webResources = require('../lib/web-resource-records.js');
const dashboards = require('../lib/dashboard-creation-records.js');

// Loaded where it is used, so that a test fails on its own assertion when the module is not there.
const recordLease = () => require('../lib/record-lease.js');

const ENV = 'https://contoso.crm.dynamics.com';
const APP = 'contoso_app';
const SOLUTION = 'ContosoSolution';
const ID_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const ID_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const ID_C = '33333333-cccc-4ccc-8ccc-333333333333';
// The bound lib/record-lease.js promises: a held lease is tried this many times, this many milliseconds apart, and then given up.
const LEASE_ATTEMPTS = 10;
const LEASE_WAIT_MS = 100;

// The two records, behind one shape: `open(dir, extra)` is a run's view of it, `ids(view, name)` what that view answers for a name, `onDisk(dir)` the
// names and ids the file holds now (read afresh, as the next build reads it: an id, or [id, reported id]), and `file(dir)` the record's path.
const RECORDS = [
  {
    kind: 'the web-resource record',
    names: ['contoso_/a.js', 'contoso_/b.js'],
    open: (dir, extra = {}) => webResources.openUnconfirmedWebResources({ workspaceDir: dir, environment: ENV, ...extra }),
    ids: (view, name) => { const id = view.idOf(name); return id ? [id] : undefined; },
    onDisk: (dir) => Object.fromEntries([...webResources.readUnconfirmedWebResources(dir, ENV).values()].map((e) => [e.name, e.id])),
    file: (dir) => webResources.unconfirmedRecordPath(dir, ENV),
  },
  {
    kind: 'the dashboard record',
    names: ['Ops Overview', 'Sales'],
    open: (dir, extra = {}) => dashboards.openDashboardCreations({ workspaceDir: dir, environment: ENV, appUniqueName: APP, solutionUniqueName: SOLUTION, ...extra }),
    ids: (view, name) => view.idsOf(name),
    onDisk: (dir) => Object.fromEntries([...dashboards.readDashboardCreations(dir, ENV, APP, SOLUTION).values()].map((e) => [e.name, e.reportedId ? [e.id, e.reportedId] : e.id])),
    file: (dir) => dashboards.dashboardCreationRecordPath(dir, ENV, APP, SOLUTION),
  },
];

// The lock a run takes to change a record, held here as another live build would hold it: by this process, stamped as a build stamps it.
function holdLease(dir, recordPath) {
  const lease = acquireLease(dir, { file: `${path.basename(recordPath)}.lock`, stamp: ownerStamp(), isStale: (held) => ownerState(held).state === 'gone' });
  assert.equal(lease.ok, true, JSON.stringify(lease));
  return lease;
}

// --- 1. the interleavings ------------------------------------------------------------------------------------------------------------------------------

for (const r of RECORDS) {
  const [a, b] = r.names;
  test(`${r.kind}: two builds that share the workspace both read it, then A notes '${a}' and B notes '${b}' — both are on disk; A clears its own — '${b}' stays; B clears its own — the file goes with the last entry`, () => {
    const dir = makeTempDir('record-lease-');
    const A = r.open(dir);
    const B = r.open(dir);
    assert.equal(r.ids(A, a), undefined, 'A read the record: nothing is in it');
    assert.equal(r.ids(B, b), undefined, 'and so did B, before either wrote');
    assert.equal(A.note(a, ID_A), true);
    assert.equal(B.note(b, ID_B), true);
    assert.deepEqual(r.onDisk(dir), { [a]: ID_A, [b]: ID_B }, 'both entries are on disk: B wrote its own beside A\'s');
    A.clear(a);
    assert.deepEqual(r.onDisk(dir), { [b]: ID_B }, 'A\'s clear took its own entry and no other');
    assert.deepEqual(r.ids(r.open(dir), b), [ID_B], 'the next build still finds B\'s');
    B.clear(b);
    assert.equal(fs.existsSync(r.file(dir)), false, 'the clear of the last entry removes the file');
    assert.deepEqual(fs.readdirSync(dir), [], 'and nothing is left behind: no lock either');
  });
}

test('the dashboard record: A notes, B notes, then A records the id its push reported — beside its own entry, and B\'s stays as B wrote it', () => {
  const r = RECORDS[1];
  const [a, b] = r.names;
  const dir = makeTempDir('record-lease-');
  const A = r.open(dir);
  const B = r.open(dir);
  assert.equal(r.ids(A, a), undefined);
  assert.equal(r.ids(B, b), undefined);
  assert.equal(A.note(a, ID_A), true);
  assert.equal(B.note(b, ID_B), true);
  assert.equal(A.observe(a, ID_C), true);
  assert.deepEqual(r.onDisk(dir), { [a]: [ID_A, ID_C], [b]: ID_B });
  assert.deepEqual(r.ids(A, a), [ID_A, ID_C], 'A\'s own view has it too');
});

// --- 2. a change touches only what its run knows ---------------------------------------------------------------------------------------------------------

for (const r of RECORDS) {
  const [a] = r.names;
  test(`${r.kind}: a clear removes only the entry its build knows — one of the same name that another build recorded since, under another id, stays`, () => {
    const dir = makeTempDir('record-lease-');
    const A = r.open(dir);
    assert.equal(A.note(a, ID_A), true);
    // Another build reads the record after A wrote — so it knows A's entry — and records a later write of the same name under another id.
    const B = r.open(dir);
    assert.deepEqual(r.ids(B, a), [ID_A]);
    assert.equal(B.note(a, ID_B), true, 'B knew the entry it replaces');
    A.clear(a);
    assert.deepEqual(r.onDisk(dir), { [a]: ID_B }, 'A\'s clear did not take B\'s entry');
  });

  test(`${r.kind}: a note does not replace an entry of the same name that another build recorded after this build read the record — it answers false, says so once, and the other build's entry stays`, () => {
    const dir = makeTempDir('record-lease-');
    const warnings = [];
    const A = r.open(dir, { warn: (w) => warnings.push(w) });
    assert.equal(r.ids(A, a), undefined, 'A read the record: nothing is in it');
    assert.equal(r.open(dir).note(a, ID_B), true, 'another build records the name since');
    assert.equal(A.note(a, ID_A), false, 'A does not write over it');
    assert.equal(A.note(a, ID_C), false, 'nor with another id');
    assert.deepEqual(r.onDisk(dir), { [a]: ID_B }, 'the other build\'s entry stays');
    assert.equal(warnings.length, 1, `said once: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], new RegExp(`already holds '${a.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}' as ${ID_B}, which another build recorded since this one read it`));
    assert.equal(A.note(a, ID_B), true, 'the id that is recorded already is no conflict');
  });
}

test('the dashboard record: A records the id its push reported only to the entry it noted — one another build has replaced since is left as it is, said once', () => {
  const r = RECORDS[1];
  const [a] = r.names;
  const dir = makeTempDir('record-lease-');
  const warnings = [];
  const A = r.open(dir, { warn: (w) => warnings.push(w) });
  assert.equal(A.note(a, ID_A), true);
  // Another build reads the record after A wrote — so it knows A's entry — and records a create of its own under the same name.
  const B = r.open(dir);
  assert.deepEqual(r.ids(B, a), [ID_A]);
  assert.equal(B.note(a, ID_B), true);
  assert.equal(A.observe(a, ID_C), false, 'A does not add to B\'s entry');
  assert.deepEqual(r.onDisk(dir), { [a]: ID_B }, 'B\'s entry stays as B wrote it');
  assert.equal(warnings.length, 1, `said once: ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], new RegExp(`no longer holds '${a}' as ${ID_A}`));
  assert.deepEqual(r.ids(A, a), [ID_A], 'and A\'s view does not claim the reported id is recorded');
});

test('the dashboard record: a file that has become unreadable since this build read it is not written over — the note answers false, said once, and the file stays as it is', () => {
  const r = RECORDS[1];
  const [a, b] = r.names;
  const dir = makeTempDir('record-lease-');
  assert.equal(r.open(dir).note(a, ID_A), true);
  const warnings = [];
  const A = r.open(dir, { warn: (w) => warnings.push(w) });
  assert.deepEqual(r.ids(A, a), [ID_A], 'A read it');
  // Then it is damaged — by hand, or by a build that writes an entry this one does not.
  const damaged = Buffer.from('{ not json');
  fs.writeFileSync(r.file(dir), damaged);
  assert.equal(A.note(b, ID_B), false);
  A.clear(a);
  assert.deepEqual(fs.readFileSync(r.file(dir)), damaged, 'not written over, not removed');
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /could not be read .*records none of its own/);
  assert.deepEqual(fs.readdirSync(dir), [path.basename(r.file(dir))], 'and no lock is left');
});

test('the web-resource record: a file that has become unreadable since this build read it is replaced by the note, as an unreadable one always was — said once', () => {
  const r = RECORDS[0];
  const [a, b] = r.names;
  const dir = makeTempDir('record-lease-');
  const warnings = [];
  const A = r.open(dir, { warn: (w) => warnings.push(w) });
  assert.equal(r.ids(A, a), undefined, 'A read it: nothing is in it');
  fs.writeFileSync(r.file(dir), '{ not json');
  assert.equal(A.note(b, ID_B), true);
  assert.deepEqual(r.onDisk(dir), { [b]: ID_B }, 'the note replaced it');
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /could not be read .*so this build reuses every web resource that exists as it is/);
});

for (const r of RECORDS) {
  test(`${r.kind}: a clear in a workspace that has gone since makes nothing — no folder, no lock`, () => {
    const dir = makeTempDir('record-lease-');
    const run = r.open(dir);
    assert.equal(run.note(r.names[0], ID_A), true);
    fs.rmSync(dir, { recursive: true, force: true });
    run.clear(r.names[0]);
    assert.equal(fs.existsSync(dir), false);
  });
}

// --- 3. the lease -------------------------------------------------------------------------------------------------------------------------------------

for (const r of RECORDS) {
  const [a, b] = r.names;
  test(`${r.kind}: a lease another live build holds is waited for a bounded time, and then the change is not made — said once, the file left as it was — while reads never wait for it`, () => {
    const dir = makeTempDir('record-lease-');
    assert.equal(r.open(dir).note(a, ID_A), true);
    const before = fs.readFileSync(r.file(dir));
    const held = holdLease(dir, r.file(dir));
    const slept = [];
    const warnings = [];
    try {
      const run = r.open(dir, { warn: (w) => warnings.push(w), lease: { sleep: (ms) => slept.push(ms) } });
      assert.deepEqual(r.ids(run, a), [ID_A], 'a read answers while the lease is held');
      assert.deepEqual(slept, [], 'without waiting for it');
      assert.equal(run.note(b, ID_B), false, 'the change is not made');
      assert.deepEqual(slept, Array(LEASE_ATTEMPTS - 1).fill(LEASE_WAIT_MS), 'after a bounded wait');
      run.clear(a);
      assert.deepEqual(fs.readFileSync(r.file(dir)), before, 'the file is left as it was');
      assert.deepEqual(r.ids(run, a), [ID_A], 'and the run\'s own view still holds its entry');
      assert.equal(warnings.length, 1, `said once: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0], /could not be written \(its lock .*\.lock is held by another build of this workspace \(lease held by pid \d+/);
      assert.ok(warnings[0].includes(`${r.file(dir)}.lock`), 'the warning names the lock');
    } finally {
      releaseLease(held);
    }
    const free = r.open(dir);
    assert.equal(free.note(b, ID_B), true, 'once it is free, a change goes through');
    assert.deepEqual(r.onDisk(dir), { [a]: ID_A, [b]: ID_B });
  });

  test(`${r.kind}: a lease left behind by a build that is gone is taken over — the change is made at once, and no lock is left`, () => {
    const dir = makeTempDir('record-lease-');
    const lock = `${r.file(dir)}.lock`;
    // The owner record of a build on this machine whose process is no longer running (the seams: pid 4242 runs nowhere here).
    const owner = { hostname: () => 'build-box', platform: 'win32', probe: (pid) => (pid === 4242 ? 'gone' : 'alive') };
    fs.writeFileSync(lock, JSON.stringify({ ...ownerStamp({ ...owner, pid: 4242 }), rnd: 'left-behind' }));
    const run = r.open(dir, { lease: { owner, sleep: () => { throw new Error('a lease of a build that is gone is not waited for'); } } });
    assert.equal(run.note(a, ID_A), true);
    assert.deepEqual(r.onDisk(dir), { [a]: ID_A });
    assert.equal(fs.existsSync(lock), false, 'no lock is left');
    assert.deepEqual(fs.readdirSync(dir), [path.basename(r.file(dir))], 'only the record is');
  });
}

test('a held lease never hangs a build: with the real pause, a change gives up after the bounded wait — about a second — and the record is as it was', () => {
  const r = RECORDS[0];
  const [a, b] = r.names;
  const dir = makeTempDir('record-lease-');
  assert.equal(r.open(dir).note(a, ID_A), true);
  const held = holdLease(dir, r.file(dir));
  let ms;
  try {
    const run = r.open(dir);
    const started = performance.now();
    assert.equal(run.note(b, ID_B), false);
    ms = performance.now() - started;
  } finally {
    releaseLease(held);
  }
  const bound = (LEASE_ATTEMPTS - 1) * LEASE_WAIT_MS;
  assert.ok(ms >= bound * 0.8, `it waited (${Math.round(ms)} ms, the bound is ${bound} ms)`);
  assert.ok(ms < bound + 5000, `and then gave up (${Math.round(ms)} ms)`);
  assert.deepEqual(r.onDisk(dir), { [a]: ID_A });
  assert.deepEqual({ attempts: recordLease().LEASE_ATTEMPTS, waitMs: recordLease().LEASE_WAIT_MS }, { attempts: LEASE_ATTEMPTS, waitMs: LEASE_WAIT_MS }, 'the module waits as long as it says');
});
