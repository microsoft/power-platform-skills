'use strict';
// A rename that Windows refuses for a moment (EPERM, EACCES or EBUSY while a scanner, an indexer or a second
// process holds the file) must not stop a build (lib/rename-retry.js). These tests hold the helper to its contract
// and the callers that atomically replace a workspace file to their own messages and codes on a lock that stays.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { renameWithRetry, RENAME_RETRY_BUDGET_MS, PROCESS_WAIT_TOTAL_MS } = require('../lib/rename-retry.js');
const { shortRenameWait, freshRenameWaitTotal } = require('./helpers/short-rename-wait.js');
const { writeFileSafe } = require('../lib/safe-fs.js');
const { openJournal } = require('../lib/build-journal.js');
const records = require('../lib/page-ownership-records.js');
const baseline = require('../lib/deployed-baseline.js');
const store = require('../lib/apply-snapshot-store.js');
const S = require('../lib/apply-snapshot.js');
const { openManagedBindings, CODES } = require('../lib/managed-bindings.js');

const refusal = (code) => Object.assign(new Error(`${code}: resource busy or locked, rename 'a' -> 'b'`), { code, syscall: 'rename', path: 'a', dest: 'b' });
const real = fs.renameSync;

// The tests run as the platform they name: a refusal is waited out on Windows only.
const asPlatform = (t, host) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  Object.defineProperty(process, 'platform', { ...platform, value: host });
};
// A short wait for the tests that keep a lock for good: the default is 5 s a rename and 30 s a process.
const shortBudget = (t, ms = 60) => shortRenameWait(t, ms);

// An fs whose rename of a file in `names` (every rename when empty) answers `code` for its first `times` calls
// (all of them when `times` is Infinity), and counts them.
function locked(times, code = 'EPERM', names = null) {
  const state = { renames: 0, refused: 0 };
  const stand = {
    ...fs,
    renameSync: (from, to) => {
      state.renames += 1;
      const mine = !names || names.some((n) => path.basename(String(from)).includes(n) || path.basename(String(to)).includes(n));
      if (mine && state.refused < times) { state.refused += 1; throw refusal(code); }
      return fs.renameSync(from, to);
    },
  };
  return { state, stand };
}

test('on Windows a rename refused with EPERM, EACCES or EBUSY is repeated after growing pauses until it goes through', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const calls = [];
    const pauses = [];
    let refused = 0;
    const stand = { renameSync: (from, to) => { calls.push([from, to]); if ((refused += 1) <= 3) throw refusal(code); } };
    renameWithRetry(stand, 'from', 'to', { platform: 'win32', pause: (ms) => pauses.push(ms) });
    assert.equal(calls.length, 4, `${code}: three refusals, then the rename`);
    assert.deepEqual(calls.map((c) => c.join('>')), Array(4).fill('from>to'), 'the same rename each time');
    assert.deepEqual(pauses, [25, 50, 100], `${code}: the pauses grow`);
  }
  const pauses = [];
  renameWithRetry({ renameSync: () => {} }, 'a', 'b', { platform: 'win32', pause: (ms) => pauses.push(ms) });
  assert.deepEqual(pauses, [], 'a rename that goes through the first time never waits');
});

test('a lock that outlasts the per-call budget is the original error, untouched, after pauses that add up to 5 s — and the pauses are capped', (t) => {
  freshRenameWaitTotal(t);
  const original = refusal('EPERM');
  let attempts = 0;
  const pauses = [];
  const stand = { renameSync: () => { attempts += 1; throw original; } };
  assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', budgetMs: 100, pause: (ms) => pauses.push(ms) }), (e) => e === original && e.code === 'EPERM' && e.syscall === 'rename' && e.path === 'a');
  assert.deepEqual(pauses, [25, 50, 25], 'the last pause is cut to what is left');
  assert.equal(attempts, 4);

  const full = [];
  assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', pause: (ms) => full.push(ms) }), (e) => e === original);
  assert.equal(RENAME_RETRY_BUDGET_MS, 5000);
  assert.equal(full.reduce((a, b) => a + b, 0), RENAME_RETRY_BUDGET_MS, 'five seconds in all for one rename');
  assert.ok(Math.max(...full) <= 1000, 'no single pause is longer than a second');
  assert.deepEqual(full.slice(0, 7), [25, 50, 100, 200, 400, 800, 1000]);
  const lower = [];
  assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', budgetMs: 1000, pause: (ms) => lower.push(ms) }), (e) => e === original);
  assert.equal(lower.reduce((a, b) => a + b, 0), 1000, 'a caller may ask for less than the default');
  const over = [];
  assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', budgetMs: 10 * RENAME_RETRY_BUDGET_MS, pause: (ms) => over.push(ms) }), (e) => e === original);
  assert.equal(over.reduce((a, b) => a + b, 0), RENAME_RETRY_BUDGET_MS, 'and never for more');
});

test('a process that has waited out 30 s of locks makes every later refused rename one attempt, as before the retry; a new process starts fresh', (t) => {
  freshRenameWaitTotal(t);
  const original = refusal('EBUSY');
  const stand = { renameSync: () => { throw original; } };
  let spent = 0;
  let calls = 0;
  // Six renames of 5 s each use up the 30 s total exactly: none waits for more than what is left.
  for (; spent < PROCESS_WAIT_TOTAL_MS; calls += 1) {
    const pauses = [];
    assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', pause: (ms) => pauses.push(ms) }), (e) => e === original);
    const waited = pauses.reduce((a, b) => a + b, 0);
    assert.ok(waited > 0 && waited <= RENAME_RETRY_BUDGET_MS);
    spent += waited;
    assert.ok(calls < 20, 'the total must end the waiting');
  }
  assert.equal(PROCESS_WAIT_TOTAL_MS, 30000);
  assert.equal(spent, 30000, 'never more than 30 s in all');
  assert.equal(calls, 6);

  let attempts = 0;
  const pauses = [];
  const counting = { renameSync: () => { attempts += 1; throw original; } };
  assert.throws(() => renameWithRetry(counting, 'a', 'b', { platform: 'win32', pause: (ms) => pauses.push(ms) }), (e) => e === original);
  assert.deepEqual([attempts, pauses], [1, []], 'the next refused rename is ONE attempt');
  // A rename that goes through is unaffected.
  renameWithRetry({ renameSync: () => {} }, 'a', 'b', { platform: 'win32', pause: () => assert.fail('no wait') });

  const script = [
    "const { renameWithRetry } = require(process.argv[1]);",
    "let attempts = 0; const pauses = [];",
    "try { renameWithRetry({ renameSync: () => { attempts += 1; throw Object.assign(new Error('x'), { code: 'EBUSY' }); } }, 'a', 'b', { platform: 'win32', pause: (ms) => pauses.push(ms) }); } catch {}",
    "console.log(JSON.stringify({ attempts, waited: pauses.reduce((a, b) => a + b, 0) }));",
  ].join('\n');
  const fresh = JSON.parse(execFileSync(process.execPath, ['-e', script, path.join(__dirname, '..', 'lib', 'rename-retry.js')], { encoding: 'utf8' }));
  assert.equal(fresh.waited, RENAME_RETRY_BUDGET_MS, 'a new process has its whole budget');
  assert.ok(fresh.attempts > 2);
});

test('the test seam puts the budget and the process total back when its test ends', async (t) => {
  freshRenameWaitTotal(t);
  const original = refusal('EPERM');
  const stand = { renameSync: () => { throw original; } };
  const wait = () => { const pauses = []; assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', pause: (ms) => pauses.push(ms) })); return pauses.reduce((a, b) => a + b, 0); };
  assert.equal(wait(), RENAME_RETRY_BUDGET_MS);
  await t.test('inside', (inner) => {
    shortRenameWait(inner, 60);
    assert.equal(wait(), 60, 'a short budget, from a fresh total');
  });
  assert.equal(wait(), RENAME_RETRY_BUDGET_MS, 'the full budget is back after it');
});

test('any other code, and any other platform, is one attempt exactly as before', () => {
  for (const code of ['ENOENT', 'EXDEV', 'ENOSPC', 'EEXIST', 'EIO']) {
    let attempts = 0;
    const pauses = [];
    const stand = { renameSync: () => { attempts += 1; throw refusal(code); } };
    assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', pause: (ms) => pauses.push(ms) }), { code });
    assert.deepEqual([attempts, pauses], [1, []], `${code} on Windows`);
  }
  for (const host of ['linux', 'darwin']) {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      let attempts = 0;
      const pauses = [];
      const stand = { renameSync: () => { attempts += 1; throw refusal(code); } };
      assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: host, pause: (ms) => pauses.push(ms) }), { code });
      assert.deepEqual([attempts, pauses], [1, []], `${code} on ${host}`);
    }
  }
  let attempts = 0;
  assert.throws(() => renameWithRetry({ renameSync: () => { attempts += 1; throw new Error('no code'); } }, 'a', 'b', { platform: 'win32', pause: () => {} }), /no code/);
  assert.equal(attempts, 1, 'an error without a code is not a lock');
});

// safe-fs keeps the short waits it had (25, 50, 100, 200, 400 ms): it writes a maker's files and the build's own diagnostic
// output, which a long synchronous wait would hold up, and a maker can change a file meanwhile. These pin that behaviour.
const BASE_SAFE_FS_WAIT_MS = 25 + 50 + 100 + 200 + 400;
const fakeWaits = (t) => {
  const waits = [];
  t.mock.method(Atomics, 'wait', (_a, _i, _v, ms) => { waits.push(ms); return 'timed-out'; });
  return waits;
};

test('safe-fs writeFileSafe: a replace refused for a moment completes with the new content and no temp; a lock that stays keeps its message after the same short waits', (t) => {
  asPlatform(t, 'win32');
  const waits = fakeWaits(t);
  const dir = makeTempDir('rename-retry-safe-');
  const file = path.join(dir, 'page.tsx');
  fs.writeFileSync(file, 'old');
  const transient = locked(2, 'EBUSY');
  writeFileSafe(file, 'new', { fs: transient.stand });
  assert.equal(transient.state.renames, 3, 'refused twice, then done');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['page.tsx'], 'no temp is left');
  assert.deepEqual(waits, [25, 50]);

  waits.length = 0;
  const stays = locked(Infinity, 'EPERM');
  assert.throws(() => writeFileSafe(file, 'never', { fs: stays.stand }), (e) => e.code === 'IO_ERROR' && e.message === `failed to write ${file}: it could not be replaced (EPERM) — another program may have it open. Close it and retry.`);
  assert.deepEqual(waits, [25, 50, 100, 200, 400], 'the same short schedule, no longer');
  assert.equal(stays.state.renames, 6);
  assert.equal(fs.readFileSync(file, 'utf8'), 'new', 'the file is as it was');
  assert.deepEqual(fs.readdirSync(dir), ['page.tsx']);
  const missing = locked(Infinity, 'ENOENT');
  assert.throws(() => writeFileSafe(file, 'never', { fs: missing.stand }), (e) => e.code === 'IO_ERROR');
  assert.equal(missing.state.renames, 1, 'a code that is not a lock: one attempt');
});

test('safe-fs writeFileSafe keeps a maker edit that lands while its replace is refused: the write fails as it always did', (t) => {
  asPlatform(t, 'win32');
  fakeWaits(t);
  const dir = makeTempDir('rename-retry-edit-');
  const file = path.join(dir, 'page.tsx');
  fs.writeFileSync(file, 'old');
  let calls = 0;
  const stand = {
    ...fs,
    renameSync: (from, to) => {
      // The maker saves the file from an editor after the sixth refusal, which is where the short schedule ends.
      if ((calls += 1) <= 6) { if (calls === 6) fs.writeFileSync(file, 'newer maker edit'); throw refusal('EPERM'); }
      return fs.renameSync(from, to);
    },
  };
  assert.throws(() => writeFileSafe(file, 'stale writer bytes', { fs: stand }), (e) => e.code === 'IO_ERROR');
  assert.equal(calls, 6, 'no seventh attempt');
  assert.equal(fs.readFileSync(file, 'utf8'), 'newer maker edit');
});

test('the build journal\'s diagnostic build-status.json waits no longer than before on a permanent refusal', (t) => {
  asPlatform(t, 'win32');
  const waits = fakeWaits(t);
  const dir = makeTempDir('rename-retry-journal-');
  t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
    if (path.basename(String(to)) === 'build-status.json') throw refusal('EPERM');
    return real(from, to, ...rest);
  });
  const j = openJournal(dir);
  for (let i = 0; i < 10; i += 1) j.record({ phase: 'data', label: `step ${i}`, status: 'ok' });
  j.close({ status: 'ok' });
  assert.ok(waits.length > 0, 'the writes did wait');
  assert.ok(Math.max(...waits) <= 400, 'the short schedule');
  assert.equal(waits.reduce((a, b) => a + b, 0) % BASE_SAFE_FS_WAIT_MS, 0, 'a whole short schedule per refused write, as before');
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 12 * BASE_SAFE_FS_WAIT_MS, 'about nine seconds for twelve writes, not twelve minutes');
});

test('a folder where the file is to go is not waited for: its refusal is for good, on Windows as anywhere', () => {
  const dir = makeTempDir('rename-retry-folder-');
  const from = path.join(dir, 'new.tmp');
  const to = path.join(dir, 'record.json');
  fs.writeFileSync(from, 'x');
  fs.mkdirSync(to);
  const original = refusal('EPERM');
  const pauses = [];
  const stand = { ...fs, renameSync: () => { throw original; } };
  assert.throws(() => renameWithRetry(stand, from, to, { platform: 'win32', pause: (ms) => pauses.push(ms) }), (e) => e === original);
  assert.deepEqual(pauses, [], 'no pause');
  // A folder moved to a name nobody has is a lock like any other.
  const moved = [];
  assert.throws(() => renameWithRetry(stand, to, path.join(dir, 'aside'), { platform: 'win32', budgetMs: 50, pause: (ms) => moved.push(ms) }), (e) => e === original);
  assert.deepEqual(moved, [25, 25]);
});

const LIVE = { orgId: 'org-1', envUrl: 'https://e', appUniqueName: 'new_app', appId: 'app-1' };
const eligible = (gen) => { const e = S.makeEnvelope(LIVE, { generation: gen }); S.markEligible(e); return e; };

test('the changed-only snapshot: a write refused for a moment lands whole; a lock that stays throws the original error and keeps the previous snapshot', (t) => {
  asPlatform(t, 'win32');
  const dir = makeTempDir('rename-retry-snap-');
  store.writeSnapshotAtomic(dir, eligible('g1'));
  let refused = 0;
  const flaky = t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
    if (String(from).endsWith('.tmp') && (refused += 1) <= 3) throw refusal(refused === 2 ? 'EBUSY' : 'EPERM');
    return real(from, to, ...rest);
  });
  store.writeSnapshotAtomic(dir, eligible('g2'));
  flaky.mock.restore();
  assert.equal(refused, 4);
  assert.equal(store.readSnapshot(dir).generation, 'g2');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);

  shortBudget(t);
  const original = refusal('EPERM');
  const forever = t.mock.method(fs, 'renameSync', () => { throw original; });
  assert.throws(() => store.writeSnapshotAtomic(dir, eligible('g3')), (e) => e === original);
  forever.mock.restore();
  assert.equal(store.readSnapshot(dir).generation, 'g2', 'the previous snapshot is untouched');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'and no temp is left');
});

test('a distrust marker is written after a refusal for a moment; one that cannot be written keeps its { ok: false, reason }', (t) => {
  asPlatform(t, 'win32');
  const dir = makeTempDir('rename-retry-mark-');
  let refused = 0;
  const flaky = t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
    if (String(from).endsWith('.json.tmp') && (refused += 1) <= 2) throw refusal('EPERM');
    return real(from, to, ...rest);
  });
  assert.deepEqual(store.markDistrusted(dir, { reason: 'moved' }), { ok: true });
  flaky.mock.restore();
  assert.equal(refused, 3);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 1);

  shortBudget(t);
  const forever = t.mock.method(fs, 'renameSync', () => { throw refusal('EPERM'); });
  const answer = store.markDistrusted(dir, { reason: 'moved' });
  forever.mock.restore();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /^EPERM: resource busy or locked/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('clearWorkspace makes ONE attempt to move the folder aside: a refusal, for a moment or not, clears nothing and keeps its reason', (t) => {
  asPlatform(t, 'win32');
  const waits = fakeWaits(t);
  const parent = makeTempDir('rename-retry-clear-');
  const target = path.join(parent, 'workspace');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    let renames = 0;
    const refuse = t.mock.method(fs, 'renameSync', (from, to, ...rest) => { if (from === target) { renames += 1; throw refusal(code); } return real(from, to, ...rest); });
    const held = store.clearWorkspace(target);
    refuse.mock.restore();
    assert.deepEqual(held, { ok: false, reason: `it could not be moved aside (${code})` });
    assert.equal(renames, 1, `${code}: one attempt`);
    assert.ok(fs.existsSync(path.join(target, 'keep.txt')), 'nothing was cleared');
    assert.ok(!fs.existsSync(path.join(target, store.LEASE_FILE)), 'and the lease is released');
  }
  assert.deepEqual(waits, [], 'it did not wait');
  assert.deepEqual(store.clearWorkspace(target), { ok: true });
  assert.deepEqual(fs.readdirSync(parent), []);
});

test('clearWorkspace never deletes a folder that took the place of the one it was asked to clear', (t) => {
  asPlatform(t, 'win32');
  const parent = makeTempDir('rename-retry-replaced-');
  const target = path.join(parent, 'workspace');
  const original = path.join(parent, 'original-moved-by-maker');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'original.txt'), 'original cache');
  // A sync client moves the folder and another takes its name while a refused rename is waited out. There is no wait:
  // the one attempt is refused and the answer is { ok: false }.
  t.mock.method(Atomics, 'wait', () => {
    real(target, original);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'foreign.txt'), 'new owner content');
    return 'timed-out';
  });
  let first = true;
  t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
    if (from === target && first) { first = false; throw refusal('EPERM'); }
    return real(from, to, ...rest);
  });
  const disposable = (d) => { const r = records.checkPageOwnershipClearable(d); if (!r.ok) throw new Error(r.reason); };
  const result = store.clearWorkspace(target, { beforeRename: () => disposable(target), beforeRemove: disposable });
  // The maker acts right after the refused call.
  if (!fs.existsSync(original)) {
    real(target, original);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'foreign.txt'), 'new owner content');
  }
  assert.deepEqual(result, { ok: false, reason: 'it could not be moved aside (EPERM)' });
  assert.ok(fs.existsSync(path.join(target, 'foreign.txt')), 'the replacement folder is intact');
  assert.ok(fs.existsSync(path.join(original, 'original.txt')));
});

test('a teardown that records several page receipts under a lock that stays waits 30 s at most and keeps its fence against a concurrent release', (t) => {
  asPlatform(t, 'win32');
  freshRenameWaitTotal(t);
  const d = makeTempDir('rename-retry-teardown-');
  let now = 1700000000000;
  t.mock.method(Date, 'now', () => now);
  const started = now;
  const mine = store.tombstoneSnapshot(d);
  const other = store.tombstoneSnapshot(d);
  assert.ok(mine.ok && other.ok);
  let beats = 0;
  const timer = setInterval(() => { beats += 1; store.beatTeardown(d, mine.teardownId); }, store.TEARDOWN_BEAT_MS);
  t.after(() => clearInterval(timer));
  let release;
  t.mock.method(Atomics, 'wait', (_a, _i, _v, ms) => {
    now += ms;
    if (!release && now - started > store.TEARDOWN_STALE_MS) {
      // Another process finishes its own teardown once this one has gone five minutes without a beat.
      assert.equal(store.beatTeardown(d, other.teardownId).ok, true);
      release = store.releaseTombstone(d, other.teardownId);
    }
    return 'timed-out';
  });
  const refused = new Map();
  t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
    if (path.basename(String(to)).startsWith('page-ownership.teardown.')) {
      const count = (refused.get(to) || 0) + 1;
      refused.set(to, count);
      if (count < 66) throw refusal('EPERM');
    }
    return real(from, to, ...rest);
  });
  const items = Array.from({ length: 6 }, (_v, i) => ({ key: `page${i}`, name: `Page ${i}`, id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}` }));
  assert.throws(() => records.recordPageTeardown(d, 'contoso_app', items, 'https://contoso.crm.dynamics.com'));
  assert.ok(now - started <= PROCESS_WAIT_TOTAL_MS, `the writes blocked for ${now - started} ms`);
  if (!release) release = store.releaseTombstone(d, other.teardownId);
  assert.equal(release.deleted, false, 'another teardown must not delete the fence of one that is still running');
  assert.equal(release.left, true);
  assert.ok(fs.existsSync(store.snapshotPath(d)), 'the snapshot is still there');
});

test('the managed binding store: a write refused for a moment is committed; a lock that stays is still managed-binding-write-failed and the file is as it was', (t) => {
  asPlatform(t, 'win32');
  const dir = makeTempDir('rename-retry-mb-');
  const open = ({ dir: where = dir } = {}) => openManagedBindings({ workspaceDir: where, environment: 'https://contoso.crm.dynamics.com', appUniqueName: 'contoso_app', solutionUniqueName: 'contoso_solution' });
  const attempt = (s) => s.prepareAttempt({
    family: 'form', key: 'account/main', baseGeneration: null, root: { kind: 'form', key: 'account/main', id: '11111111-1111-4111-8111-111111111111' },
    knownScopes: [{ type: 'table', table: 'account' }], declarationSha256: 'e'.repeat(64), publication: { scope: { type: 'table', table: 'account' }, state: 'owed' },
  });
  let refused = 0;
  const flaky = t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
    if (String(from).endsWith('.tmp') && (refused += 1) <= 2) throw refusal('EBUSY');
    return real(from, to, ...rest);
  });
  const first = open();
  assert.ok(attempt(first), 'the attempt is recorded');
  flaky.mock.restore();
  assert.equal(refused, 3);
  const before = fs.readFileSync(first.file, 'utf8');

  shortBudget(t);
  const forever = t.mock.method(fs, 'renameSync', (from, to, ...rest) => { if (String(from).endsWith('.tmp')) throw refusal('EPERM'); return real(from, to, ...rest); });
  let thrown = null;
  try { attempt(open({ dir: makeTempDir('rename-retry-mb-lock-') })); } catch (e) { thrown = e; }
  forever.mock.restore();
  assert.equal(thrown && thrown.code, CODES.writeFailed);
  assert.match(thrown.message, /could not be written \(EPERM\)/);
  assert.equal(fs.readFileSync(first.file, 'utf8'), before, 'the first store is as it was');
});

// The download writes the deployed baseline WITHOUT the build lease, so it renames once: a write that was refused and
// retried could land after a newer build's write and put the older baseline back.
test('the deployed baseline: an older unleased write that is refused once does not replace the newer baseline a build wrote meanwhile', (t) => {
  asPlatform(t, 'win32');
  const dir = makeTempDir('rename-retry-baseline-');
  const identity = { environment: 'https://contoso.crm.dynamics.com', appUniqueName: 'contoso_app' };
  const spec = (name) => ({
    solution: { uniqueName: 'contoso_solution', publisherPrefix: 'contoso' },
    app: { name, uniqueName: 'contoso_app' }, pages: [],
    appShell: { areas: [{ groups: [{ subAreas: [{ entity: 'account', title: name }] }] }] },
  });
  baseline.writeBaseline(dir, spec('Initial'), identity);
  const waits = fakeWaits(t);
  let refused = false;
  let calls = 0;
  let newer = false;
  t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
    if (to === baseline.baselinePath(dir)) {
      calls += 1;
      if (!refused) { refused = true; throw refusal('EPERM'); }
    }
    return real(from, to, ...rest);
  });
  const buildFinishes = () => { newer = true; baseline.writeBaseline(dir, spec('Newer completed build'), identity); };
  // The build (under its lease) finishes at whatever moment the download waits, or right after it returns.
  t.mock.method(Atomics, 'wait', (_a, _i, _v, ms) => { waits.push(ms); if (!newer) buildFinishes(); return 'timed-out'; });
  let caught = null;
  try { baseline.writeBaseline(dir, spec('Older download'), { ...identity, fromSpec: true }); } catch (e) { caught = e; }
  if (!newer) buildFinishes();
  assert.equal(caught && caught.code, 'EPERM', 'the refused write fails with its original error, as before');
  assert.equal(calls, 2, 'one attempt for the download, and the build\'s own write');
  assert.deepEqual(waits, [], 'it did not wait');
  assert.equal(baseline.readBaseline(dir, identity).app.name, 'Newer completed build');
});

test('the retried state files still retry: the snapshot, the managed binding store and the distrust marker are covered above, and a write that opts out is the only single attempt', (t) => {
  asPlatform(t, 'win32');
  const dir = makeTempDir('rename-retry-optout-');
  const file = path.join(dir, 'record.json');
  for (const [opts, renames] of [[undefined, 3], [{ retryLock: true }, 3], [{ retryLock: false }, 1]]) {
    let calls = 0;
    const flaky = t.mock.method(fs, 'renameSync', (from, to, ...rest) => { calls += 1; if (calls <= 2) throw refusal('EBUSY'); return real(from, to, ...rest); });
    const run = () => store.writeFileAtomic(file, 'text', opts);
    if (renames === 1) assert.throws(run, { code: 'EBUSY' }); else run();
    flaky.mock.restore();
    assert.equal(calls, renames);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp is left');
  }
});
