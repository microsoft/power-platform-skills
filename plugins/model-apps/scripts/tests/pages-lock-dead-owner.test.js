'use strict';
// The pages lock (lib/sdk-build.js acquireAppPagesLease): a build killed while it writes pages leaves its lock in the workspace, and the next build
// used to stop on it and say to delete it if it was stale. It is released by itself when — and only when — the process that took it is provably gone;
// everything else is refused with the words it always had. The tests kill REAL processes: what a kill leaves is a fact about the operating system,
// not about a stand-in.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireAppPagesLease } = require('../lib/sdk-build.js');
const { ownerStamp, probeProcess } = require('../lib/process-owner.js');
const { sha256 } = require('../lib/hash.js');
const { startTarget, tempEnv, privateTempRoot, deadPid, removeWhenTestEnds } = require('./helpers/kill-target-client.js');
const { deletedWhileOpen, deletedNamesLinger } = require('./helpers/delete-pending.js');

const APP = 'contoso_app';
const workspace = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-lock-'));
  // Removed after the processes the test started have ended, and never by a hook that throws (helpers/kill-target-client.js).
  removeWhenTestEnds(t, dir);
  return dir;
};
const lockFile = (dir, app = APP) => path.join(dir, `pages-${app}.lock`);
// The pages lock is two files (lib/app-operation-lease.js): the hashed one, keyed without regard to case, is taken first, so it is the one that refuses a
// second build of this release; the legacy one above is the one every earlier release takes, and refuses a build of this release while one of those holds it.
const canonicalFile = (dir, app = APP) => path.join(dir, `app-pages.${sha256(app.toLowerCase())}.lock`);
// The refusal's words, as they have always been: a person and the skills read them, so they are pinned.
const REFUSAL = (lock, app = APP) => `another build is deploying pages for '${app}' — refusing a second concurrent pages deploy (would risk duplicate page creation). Retry after it finishes, or delete ${lock} if it is stale.`;
const refused = (lock, app = APP) => (e) => e && e.code === 'pages-locked' && e.phase === 'pages' && e.recoverable === true && e.message === REFUSAL(lock, app);

test('REAL KILL: the lock a killed build left is released by the next build, which says so — and the lock is then that build\'s own', async (t) => {
  const dir = workspace(t);
  const holder = startTarget(t, ['lock', dir, APP]);
  await holder.waitFor(/^held$/);
  const file = lockFile(dir);
  assert.ok(fs.existsSync(file), 'the build holds the lock');
  assert.ok(fs.existsSync(canonicalFile(dir)), 'both of its files');

  // While the build is running its lock holds, in the words it has always had — naming the file that refused, the hashed one a build of this release takes first.
  assert.throws(() => acquireAppPagesLease(dir, APP), refused(canonicalFile(dir)));

  await holder.kill();
  assert.ok(fs.existsSync(file), 'a killed process cannot release its lock: it is still there');
  const killedLock = fs.readFileSync(file, 'utf8');

  const warnings = [];
  const lease = acquireAppPagesLease(dir, APP, { warn: (message) => warnings.push(message) });
  assert.notStrictEqual(fs.readFileSync(file, 'utf8'), killedLock, 'the lock is no longer the killed build\'s');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'it names this process');
  assert.strictEqual(JSON.parse(fs.readFileSync(canonicalFile(dir), 'utf8')).pid, process.pid, 'and so does the hashed one');
  assert.strictEqual(warnings.length, 1, `one warning for the one build that held both files, never silent: ${JSON.stringify(warnings)}`);
  assert.ok(warnings[0].includes(`'${APP}'`) && warnings[0].includes(`pid ${holder.pid}`) && /no longer running/.test(warnings[0]), warnings[0]);
  // And it is a lock like any other: a third build is refused while this one holds it, and may take it once this one lets go.
  assert.throws(() => acquireAppPagesLease(dir, APP), refused(canonicalFile(dir)));
  lease.release();
  assert.ok(!fs.existsSync(file), 'released');
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'and nothing else is left in the workspace, a reclaim claim included');
  acquireAppPagesLease(dir, APP).release();
});

test('a lock whose owner cannot be proven gone stays: another machine, another kind of system, another pid namespace, no record, a damaged one — refused in the same words, the file untouched, nothing said', (t) => {
  const gone = deadPid();
  const stamp = (overrides) => JSON.stringify({ ...ownerStamp({ pid: gone }), ...overrides });
  const cases = [
    ['a record from another machine', stamp({ host: 'some-other-machine' })],
    ['a record from another kind of system', stamp({ platform: process.platform === 'win32' ? 'linux' : 'win32' })],
    ['a record from another pid namespace', stamp({ ns: 'pid:[1]' })],
    ['a lock from a release before the owner was recorded ({ pid, at } alone)', JSON.stringify({ pid: gone, at: Date.now() })],
    ['a record of a version this one does not know', stamp({ v: 2 })],
    ['a pid that is not a number', stamp({ pid: String(gone) })],
    ['a record with no host', JSON.stringify({ ...ownerStamp({ pid: gone }), host: undefined })],
    ['an empty file', ''],
    ['text that is not JSON', 'not json'],
    ['JSON that is not an object', '[1, 2, 3]'],
  ];
  for (const [what, content] of cases) {
    const dir = workspace(t);
    const file = lockFile(dir);
    fs.writeFileSync(file, content);
    const warnings = [];
    assert.throws(() => acquireAppPagesLease(dir, APP, { warn: (message) => warnings.push(message) }), refused(file), what);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content, `${what}: the lock is as it was`);
    assert.deepStrictEqual(warnings, [], `${what}: nothing was released, so nothing is said`);
    assert.deepStrictEqual(fs.readdirSync(dir), [path.basename(file)], `${what}: no claim or other file was left`);
  }
});

// What a Linux process that cannot read /proc sees (a container that hides it, hidepid, a sandbox): its own pid namespace cannot be named.
const unreadable = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
const NS = 'pid:[4026531836]';
const BOOT = '11111111-2222-3333-4444-555555555555';
const HOST = 'same-container-hostname';

test('on Linux a lock whose owner is not found is released only when its pid namespace AND this process\'s are both readable, valid and equal — otherwise it is refused in the same words, untouched', (t) => {
  // Two containers can share a host name and a volume and have two pid spaces: a pid that is not found in this one proves nothing of the other.
  const side = (ns, extra = {}) => ({ platform: 'linux', hostname: () => HOST, startOf: () => null, ...(ns ? { ns } : { readFile: unreadable, readlink: unreadable }), ...extra });
  const lockOf = (ns) => JSON.stringify({ ...ownerStamp({ ...side(ns), pid: 4242, now: () => 1 }), rnd: 'killed' });
  // Control: both sides name the same namespace — the lock of a build that is not found is released, and said so.
  const control = workspace(t);
  fs.writeFileSync(lockFile(control), lockOf(NS));
  const said = [];
  acquireAppPagesLease(control, APP, { owner: side(NS, { pid: 100, probe: () => 'gone' }), warn: (message) => said.push(message) }).release();
  assert.strictEqual(said.length, 1, 'released, and said so');
  for (const [what, recordedNs, readerNs] of [
    ['a record that names no namespace, read where one is named', undefined, NS],
    ['a record that names one, read where this process cannot name its own', NS, undefined],
    ['neither side names one (both blind): the lock of a process in another container looks just like a dead one\'s', undefined, undefined],
    ['another namespace', NS, 'pid:[4026532000]'],
  ]) {
    const dir = workspace(t);
    const file = lockFile(dir);
    const content = lockOf(recordedNs);
    fs.writeFileSync(file, content);
    const warnings = [];
    assert.throws(() => acquireAppPagesLease(dir, APP, { owner: side(readerNs, { pid: 100, probe: () => 'gone' }), warn: (message) => warnings.push(message) }), refused(file), what);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content, `${what}: the lock is as it was`);
    assert.deepStrictEqual(warnings, [], `${what}: nothing was released, so nothing is said`);
    assert.deepStrictEqual(fs.readdirSync(dir), [path.basename(file)], `${what}: no claim or other file was left`);
  }
});

test('a lock whose recorded start is empty, truncated or malformed is not taken — not from this very process, not from a pid that is gone — in the same words, untouched', (t) => {
  const here = { platform: 'linux', hostname: () => HOST, ns: NS, pid: process.pid, probe: () => 'alive', startOf: () => ({ token: `${BOOT}:900`, state: 'S' }) };
  for (const start of ['', 'truncated-token', BOOT, `${BOOT}:`, `${BOOT.slice(0, -1)}:900`, `${BOOT}:90x`]) {
    const dir = workspace(t);
    const file = lockFile(dir);
    const first = acquireAppPagesLease(dir, APP, { owner: here });
    const held = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(held.start, `${BOOT}:900`, 'control: the lock records the start it was taken with');
    // Only the start is damaged, in both files the build holds: each is still JSON, and says whose it is.
    const damaged = JSON.stringify({ ...held, start });
    const damagedHashed = JSON.stringify({ ...JSON.parse(fs.readFileSync(canonicalFile(dir), 'utf8')), start });
    fs.writeFileSync(file, damaged);
    fs.writeFileSync(canonicalFile(dir), damagedHashed);
    const what = JSON.stringify(start);
    // The same process (a build that is running): a second lease before the first is released.
    assert.throws(() => acquireAppPagesLease(dir, APP, { owner: here }), refused(canonicalFile(dir)), `${what}: this process's own lock`);
    // A process that is not found: an untrusted record is not a dead one's.
    const warnings = [];
    assert.throws(() => acquireAppPagesLease(dir, APP, { owner: { ...here, pid: 100, probe: () => 'gone' }, warn: (message) => warnings.push(message) }), refused(canonicalFile(dir)), `${what}: a pid that is not found`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), damaged, `${what}: the lock is as it was`);
    assert.strictEqual(fs.readFileSync(canonicalFile(dir), 'utf8'), damagedHashed, `${what}: the hashed one too`);
    assert.deepStrictEqual(warnings, []);
    first.release();
    assert.strictEqual(fs.readFileSync(file, 'utf8'), damaged, `${what}: the first build's late release leaves a lock that is not its token alone`);
    assert.strictEqual(fs.readFileSync(canonicalFile(dir), 'utf8'), damagedHashed, `${what}: the hashed one too`);
  }
});

test('a lock held by a process that is running is never taken — however old it says it is — and neither is one made by this process', async (t) => {
  const dir = workspace(t);
  const file = lockFile(dir);
  const holder = startTarget(t, ['lock', dir, APP]);
  await holder.waitFor(/^held$/);
  // Much later, by the clock the function is given: a lock is never old enough to be taken from a process that is still running.
  assert.throws(() => acquireAppPagesLease(dir, APP, { now: () => Date.now() + 10 * 24 * 3600 * 1000 }), refused(canonicalFile(dir)));
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pid, holder.pid, 'the holder\'s lock is untouched');
  assert.strictEqual(JSON.parse(fs.readFileSync(canonicalFile(dir), 'utf8')).pid, holder.pid, 'both of its files');
  await holder.kill();
  fs.rmSync(file);
  fs.rmSync(canonicalFile(dir));

  // This process's own lock: a second build in the same process is a second build, and is refused.
  const mine = acquireAppPagesLease(dir, APP);
  assert.throws(() => acquireAppPagesLease(dir, APP), refused(canonicalFile(dir)));
  mine.release();
});

test('the lock is taken exclusively, and released only by the build that holds it', (t) => {
  const dir = workspace(t);
  const file = lockFile(dir);
  const first = acquireAppPagesLease(dir, APP);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(record.pid, process.pid);
  assert.strictEqual(typeof record.at, 'number');
  assert.throws(() => acquireAppPagesLease(dir, APP), refused(canonicalFile(dir)));
  // Another build now holds the lock (the file says so): this one's late release leaves it alone.
  const others = JSON.stringify({ ...record, pid: record.pid + 1, rnd: 'someone-else' });
  fs.writeFileSync(file, others);
  first.release();
  assert.strictEqual(fs.readFileSync(file, 'utf8'), others);
  fs.rmSync(file);
  // Another app's lock is another file.
  const a = acquireAppPagesLease(dir, 'app_a');
  const b = acquireAppPagesLease(dir, 'app_b');
  a.release();
  b.release();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a lock whose owner is gone but that cannot be released — another build is releasing it at this moment, or died doing so — is refused in the same words, with the reason added', (t) => {
  const dir = workspace(t);
  const file = lockFile(dir);
  const gone = deadPid();
  const content = JSON.stringify({ ...ownerStamp({ pid: gone }), rnd: 'killed' });
  fs.writeFileSync(file, content);
  // The claim file is what a build holds while it takes the lock over; one that is there means another build is at it.
  const claim = `${file}.reclaim`;
  fs.writeFileSync(claim, JSON.stringify({ pid: process.pid, at: Date.now(), rnd: 'taking-over' }));
  const warnings = [];
  assert.throws(() => acquireAppPagesLease(dir, APP, { warn: (message) => warnings.push(message) }), (e) => {
    assert.strictEqual(e.code, 'pages-locked');
    assert.strictEqual(e.recoverable, true);
    assert.ok(e.message.startsWith(REFUSAL(file)), `the words it has always had come first: ${e.message}`);
    assert.strictEqual(e.message.slice(REFUSAL(file).length), ' The build that held it is no longer running, but its lock could not be released: lease being reclaimed by another writer.');
    return true;
  });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), content, 'the lock is as it was');
  assert.ok(fs.existsSync(claim), 'and the other build\'s claim is not touched');
  assert.deepStrictEqual(warnings, []);
});

test('a workspace that cannot be written is that error, as it always was — not a refusal that says another build is deploying pages', (t) => {
  const dir = workspace(t);
  // The workspace's own path is a file: nothing can be created in it. The folder is checked as every folder the plugin writes into is (lib/safe-fs.js),
  // so the error is that check's refusal of a path that is not a folder.
  const blocked = path.join(dir, 'not-a-folder');
  fs.writeFileSync(blocked, '');
  assert.throws(() => acquireAppPagesLease(blocked, APP), (e) => !(e && e.code === 'pages-locked') && e.code === 'UNSAFE_OUTPUT' && e.reason === 'not-directory', 'the file system\'s own problem');
});

// A name another build is deleting while a third process still has it open — a build reading the lock to judge its owner — lingers on Windows under
// Node 20 until that handle closes, and every look at it and every create of it fails with EPERM meanwhile (helpers/delete-pending.js). That is the
// moment a release or a take-over ends: another build holds the lock, or has just held it, and a build that finds the name so is refused as by a
// held lock — not stopped with a file-safety error or a raw EPERM. Under Node 22, and on Linux and macOS, the delete removes the name at once: the same
// steps leave no name, and each test says what a build then finds.
const refusedNotError = (lock) => (e) => {
  assert.strictEqual(e && e.code, 'pages-locked', String(e && e.stack));
  return refused(lock)(e);
};

test('a claim another build is deleting as its take-over ends, while a third still has it open, is a lock in use: refused in the same words, the lock untouched', (t) => {
  const dir = workspace(t);
  const lingers = deletedNamesLinger(dir);
  const mine = acquireAppPagesLease(dir, APP);
  const held = fs.readFileSync(canonicalFile(dir), 'utf8');
  const claim = deletedWhileOpen(`${canonicalFile(dir)}.reclaim`, JSON.stringify({ pid: process.pid, at: Date.now(), rnd: 'taking-over' }));
  try {
    assert.throws(() => acquireAppPagesLease(dir, APP), refusedNotError(canonicalFile(dir)), `names deleted while open linger here: ${lingers}`);
  } finally {
    claim.close();
  }
  assert.strictEqual(fs.readFileSync(canonicalFile(dir), 'utf8'), held, 'the lock is as it was');
  mine.release();
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'released, and the claim is gone with its last handle');
});

test('a lock another build is deleting as it lets go, while a third still has it open, is refused where its name lingers, and free where it does not — never a file-safety error', (t) => {
  const dir = workspace(t);
  const lingers = deletedNamesLinger(dir);
  const lock = deletedWhileOpen(canonicalFile(dir), JSON.stringify({ ...ownerStamp(), rnd: 'letting-go' }));
  try {
    if (lingers) assert.throws(() => acquireAppPagesLease(dir, APP), refusedNotError(canonicalFile(dir)));
    else acquireAppPagesLease(dir, APP).release();
  } finally {
    lock.close();
  }
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing is left once the last handle is closed');
  acquireAppPagesLease(dir, APP).release();
});

test('a lock that starts being deleted between a build\'s look and its create is refused where its name lingers, and taken where it does not — never the create\'s raw EPERM', (t) => {
  const dir = workspace(t);
  const lingers = deletedNamesLinger(dir);
  const real = fs.writeFileSync;
  let letGo = null;
  // Another build lets go of the lock just after this one found the name free, while a third still reads it: the create meets the lingering name.
  t.mock.method(fs, 'writeFileSync', function writeFileSync(file, data, opts) {
    if (!letGo && file === canonicalFile(dir) && opts && opts.flag === 'wx') {
      letGo = 'starting';
      letGo = deletedWhileOpen(file, JSON.stringify({ ...ownerStamp(), rnd: 'letting-go' }));
    }
    return real.call(this, file, data, opts);
  });
  try {
    if (lingers) assert.throws(() => acquireAppPagesLease(dir, APP), refusedNotError(canonicalFile(dir)));
    else acquireAppPagesLease(dir, APP).release();
  } finally {
    if (letGo && letGo.close) letGo.close();
  }
  assert.ok(letGo, 'control: the create met the name being deleted');
  t.mock.restoreAll();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a create that fails with EPERM while nothing is at the lock\'s name is that error, as it always was — a folder this user cannot write in is not another build', (t) => {
  const dir = workspace(t);
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function writeFileSync(file, data, opts) {
    if (file === canonicalFile(dir) && opts && opts.flag === 'wx') throw Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`), { code: 'EPERM' });
    return real.call(this, file, data, opts);
  });
  assert.throws(() => acquireAppPagesLease(dir, APP), (e) => e && e.code === 'EPERM', 'the create\'s own error');
  t.mock.restoreAll();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('on Windows a create that failed with EPERM while the name was being deleted, and finds it gone, is tried once more and takes the free lock; elsewhere it is that error', (t) => {
  const dir = workspace(t);
  const real = fs.writeFileSync;
  let failed = 0;
  // The deletion finished between the failed create and the look at the name: nothing lingers by the time the build looks.
  t.mock.method(fs, 'writeFileSync', function writeFileSync(file, data, opts) {
    if (file === canonicalFile(dir) && opts && opts.flag === 'wx' && failed === 0) {
      failed += 1;
      throw Object.assign(new Error(`EPERM: operation not permitted, open '${file}'`), { code: 'EPERM' });
    }
    return real.call(this, file, data, opts);
  });
  if (process.platform === 'win32') {
    const lease = acquireAppPagesLease(dir, APP);
    assert.strictEqual(JSON.parse(fs.readFileSync(canonicalFile(dir), 'utf8')).pid, process.pid, 'taken on the second try');
    lease.release();
  } else {
    assert.throws(() => acquireAppPagesLease(dir, APP), (e) => e && e.code === 'EPERM', 'as it always was');
  }
  assert.strictEqual(failed, 1);
  t.mock.restoreAll();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a link or a junction at the lock\'s name or at its claim\'s is still refused as the file system problem it is, and nothing is written through it', (t) => {
  for (const at of ['lock', 'claim']) {
    const dir = workspace(t);
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const name = at === 'lock' ? canonicalFile(dir) : `${canonicalFile(dir)}.reclaim`;
    // A junction on Windows, which needs no privilege; the type is ignored elsewhere, where it is a symbolic link to the folder.
    fs.symlinkSync(elsewhere, name, 'junction');
    assert.throws(() => acquireAppPagesLease(dir, APP), (e) => {
      assert.strictEqual(e && e.code, 'UNSAFE_OUTPUT', `${at}: ${String(e && e.stack)}`);
      assert.strictEqual(e.reason, 'link', at);
      return true;
    });
    assert.deepStrictEqual(fs.readdirSync(elsewhere), [], `${at}: nothing was written through it`);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['elsewhere', path.basename(name)].sort(), `${at}: nothing was taken or left`);
  }
});

// Several builds that start at once, and each finds the lock: not there at all, or left by a build that was killed. Exactly one of them takes it.
//
// The build is killed only once every racer has started and loaded the module, and the gate opens at once after it. Windows hands a pid that is
// free again to a new process after a while when the machine starts many processes (measured on a loaded machine: from about 8 s after the kill
// at ~90 process starts a second), and then the killed build's lock names a pid that RUNS: process-owner.js cannot tell it from the build, so
// every racer keeps the lock and is refused — the safe answer, pinned by the next test. Killed before the racers started, the build's
// pid stayed free for as long as four processes took to start, which on a loaded machine is seconds: one whole-suite run saw all four refused.
// Killed last, the pid is free only for the milliseconds the race takes, and no racer can be the process that gets it: each was running before.
for (const [what, holderFate] of [['no lock at all', 'none'], ['the lock of a killed build', 'killed']]) {
  test(`REAL PROCESSES racing for the lock — ${what}: exactly one takes it, the others are refused, and nothing is left but the lock`, async (t) => {
    const RACERS = 4;
    const ROUNDS = 3;
    const root = privateTempRoot(t);
    for (let round = 1; round <= ROUNDS; round += 1) {
      const dir = fs.mkdtempSync(path.join(root, 'ws-'));
      const app = `race_${round}`;
      let holder = null;
      if (holderFate === 'killed') {
        holder = startTarget(t, ['lock', dir, app], { env: tempEnv(root) });
        await holder.waitFor(/^held$/);
      }
      const gate = path.join(root, `gate-${round}`);
      const racers = Array.from({ length: RACERS }, () => startTarget(t, ['lock', dir, app, gate], { env: tempEnv(root) }));
      await Promise.all(racers.map((racer) => racer.waitFor(/^ready$/)));
      if (holder) {
        await holder.kill();
        assert.ok(fs.existsSync(lockFile(dir, app)));
      }
      fs.writeFileSync(gate, '');
      const answers = await Promise.all(racers.map((racer) => racer.waitFor(/^(held|refused .*)$/)));
      const winners = racers.filter((racer, i) => answers[i] === 'held');
      // Should the killed build's pid run again all the same, the failure says so: that refusal is the rule for a running pid, not a lost race.
      const pidAgain = holder && probeProcess(holder.pid) !== 'gone' ? ` — the killed build's pid ${holder.pid} is a running process's again` : '';
      assert.strictEqual(winners.length, 1, `round ${round}: one winner, got ${JSON.stringify(answers)}${pidAgain}`);
      assert.ok(answers.filter((a) => a !== 'held').every((a) => a === 'refused pages-locked'), `round ${round}: the others are refused: ${JSON.stringify(answers)}`);
      assert.strictEqual(JSON.parse(fs.readFileSync(lockFile(dir, app), 'utf8')).pid, winners[0].pid, `round ${round}: the lock names the winner`);
      assert.strictEqual(JSON.parse(fs.readFileSync(canonicalFile(dir, app), 'utf8')).pid, winners[0].pid, `round ${round}: both of its files`);
      assert.deepStrictEqual(fs.readdirSync(dir).sort(), [path.basename(canonicalFile(dir, app)), `pages-${app}.lock`].sort(), `round ${round}: no claim or other file is left`);
      await Promise.all(racers.map((racer) => racer.kill()));
    }
  });
}

// What every racer sees when a killed build's pid has been handed to another process: a lock whose pid runs. The build here is simply not killed.
// None of them takes it — not one, however many race — and the lock is as it was: a pid that runs is never proven gone (process-owner.js).
test('REAL PROCESSES racing for the lock of a build whose pid runs — what a killed build\'s lock is once its pid is another process\'s: every one is refused, and the lock is untouched', async (t) => {
  const root = privateTempRoot(t);
  const dir = fs.mkdtempSync(path.join(root, 'ws-'));
  const app = 'race_running';
  const holder = startTarget(t, ['lock', dir, app], { env: tempEnv(root) });
  await holder.waitFor(/^held$/);
  const held = [fs.readFileSync(lockFile(dir, app), 'utf8'), fs.readFileSync(canonicalFile(dir, app), 'utf8')];
  const gate = path.join(root, 'gate');
  const racers = Array.from({ length: 4 }, () => startTarget(t, ['lock', dir, app, gate], { env: tempEnv(root) }));
  await Promise.all(racers.map((racer) => racer.waitFor(/^ready$/)));
  fs.writeFileSync(gate, '');
  const answers = await Promise.all(racers.map((racer) => racer.waitFor(/^(held|refused .*)$/)));
  assert.deepStrictEqual(answers, Array(4).fill('refused pages-locked'), 'no winner: a pid that runs keeps its lock');
  assert.deepStrictEqual([fs.readFileSync(lockFile(dir, app), 'utf8'), fs.readFileSync(canonicalFile(dir, app), 'utf8')], held, 'both files are as the build left them');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [path.basename(canonicalFile(dir, app)), `pages-${app}.lock`].sort(), 'no claim or other file is left');
  await Promise.all([holder, ...racers].map((target) => target.kill()));
});
