'use strict';
// A rename that Windows refuses for a moment (EPERM, EACCES or EBUSY while a scanner, an indexer or a second
// process holds the file) must not stop a build (lib/rename-retry.js). These tests hold the helper to its contract
// and the callers that atomically replace a workspace file to their own messages and codes on a lock that stays.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { renameWithRetry, setDefaultBudgetMs, RENAME_RETRY_BUDGET_MS } = require('../lib/rename-retry.js');
const { shortRenameWait } = require('./helpers/short-rename-wait.js');
const { writeFileSafe } = require('../lib/safe-fs.js');
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
// A short wait for the tests that keep a lock for good: the default is about a minute.
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

test('a lock that outlasts the budget is the original error, untouched, after pauses that add up to the budget — and the pauses are capped', () => {
  const original = refusal('EPERM');
  let attempts = 0;
  const pauses = [];
  const stand = { renameSync: () => { attempts += 1; throw original; } };
  assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', budgetMs: 100, pause: (ms) => pauses.push(ms) }), (e) => e === original && e.code === 'EPERM' && e.syscall === 'rename' && e.path === 'a');
  assert.deepEqual(pauses, [25, 50, 25], 'the last pause is cut to what is left');
  assert.equal(attempts, 4);

  setDefaultBudgetMs(RENAME_RETRY_BUDGET_MS);
  const full = [];
  assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', pause: (ms) => full.push(ms) }), (e) => e === original);
  assert.equal(full.reduce((a, b) => a + b, 0), RENAME_RETRY_BUDGET_MS, 'about a minute in all');
  assert.ok(Math.max(...full) <= 1000, 'no single pause is longer than a second');
  assert.deepEqual(full.slice(0, 7), [25, 50, 100, 200, 400, 800, 1000]);
  const lower = [];
  assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', budgetMs: 10000, pause: (ms) => lower.push(ms) }), (e) => e === original);
  assert.equal(lower.reduce((a, b) => a + b, 0), 10000, 'a caller may ask for less than the default');
  const over = [];
  assert.throws(() => renameWithRetry(stand, 'a', 'b', { platform: 'win32', budgetMs: 10 * RENAME_RETRY_BUDGET_MS, pause: (ms) => over.push(ms) }), (e) => e === original);
  assert.equal(over.reduce((a, b) => a + b, 0), RENAME_RETRY_BUDGET_MS, 'and never for more');
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

test('safe-fs writeFileSafe: a replace refused for a moment completes with the new content and no temp; a lock that stays keeps its message and leaves the old file', (t) => {
  asPlatform(t, 'win32');
  const dir = makeTempDir('rename-retry-safe-');
  const file = path.join(dir, 'page.tsx');
  fs.writeFileSync(file, 'old');
  // Six refusals is one more than the old five short retries absorbed (about 0.8 s of waiting): the write now outlasts it.
  for (const [code, times] of [['EPERM', 6], ['EBUSY', 2]]) {
    const transient = locked(times, code);
    writeFileSafe(file, `new ${code}`, { fs: transient.stand });
    assert.equal(transient.state.renames, times + 1, `${code}: refused ${times} times, then done`);
    assert.equal(fs.readFileSync(file, 'utf8'), `new ${code}`);
    assert.deepEqual(fs.readdirSync(dir), ['page.tsx'], `${code}: no temp is left`);
  }
  shortBudget(t);
  const stays = locked(Infinity, 'EPERM');
  assert.throws(() => writeFileSafe(file, 'never', { fs: stays.stand }), (e) => e.code === 'IO_ERROR' && e.message === `failed to write ${file}: it could not be replaced (EPERM) — another program may have it open. Close it and retry.`);
  assert.ok(stays.state.renames > 2, 'it waited and tried again');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new EBUSY', 'the file is as it was');
  assert.deepEqual(fs.readdirSync(dir), ['page.tsx']);
  const missing = locked(Infinity, 'ENOENT');
  assert.throws(() => writeFileSafe(file, 'never', { fs: missing.stand }), (e) => e.code === 'IO_ERROR');
  assert.equal(missing.state.renames, 1, 'a code that is not a lock: one attempt');
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

test('clearWorkspace moves the folder aside after a refusal for a moment; a hold that stays clears nothing, with its existing reason', (t) => {
  asPlatform(t, 'win32');
  const parent = makeTempDir('rename-retry-clear-');
  const target = path.join(parent, 'workspace');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
  let refused = 0;
  const forever = t.mock.method(fs, 'renameSync', (from, to, ...rest) => { if (from === target) throw refusal('EBUSY'); return real(from, to, ...rest); });
  shortBudget(t, 30);
  const held = store.clearWorkspace(target);
  forever.mock.restore();
  assert.deepEqual(held, { ok: false, reason: 'it could not be moved aside (EBUSY)' });
  assert.ok(fs.existsSync(path.join(target, 'keep.txt')), 'nothing was cleared');
  assert.ok(!fs.existsSync(path.join(target, store.LEASE_FILE)), 'and the lease is released');

  setDefaultBudgetMs(RENAME_RETRY_BUDGET_MS);
  const flaky = t.mock.method(fs, 'renameSync', (from, to, ...rest) => {
    if (from === target && (refused += 1) <= 2) throw refusal('EPERM');
    return real(from, to, ...rest);
  });
  assert.deepEqual(store.clearWorkspace(target), { ok: true });
  flaky.mock.restore();
  assert.equal(refused, 3);
  assert.ok(!fs.existsSync(target));
  assert.deepEqual(fs.readdirSync(parent), []);
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
