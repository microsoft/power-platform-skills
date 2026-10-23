'use strict';
// The pages lock as two files (lib/app-operation-lease.js acquireAppPagesLease, still exported from lib/sdk-build.js): a hashed one keyed without
// regard to case, then the one every earlier release takes, spelled as the app is spelled.
//
// What this holds:
//   - two spellings of one app (`Contoso_App`, `contoso_app`) share one page-publish record, and now one pages lock too — on a case-sensitive file
//     system, where they used to take two (run over a folder that behaves as a case-sensitive one on every machine, and over the real folder where
//     the file system is case-sensitive itself);
//   - a build of an earlier release, which takes only the legacy file, and a build of this one keep each other out of the pages phase, in both orders,
//     when they spell the app the same way — and the refusal is the sentence it has always been;
//   - when the second file refuses, the first is let go again: nothing this build took is left, and nothing of another build's is touched;
//   - each file is taken over only from a build proven gone, and said once per build;
//   - a release leaves another build's token alone, and says so when it cannot confirm it removed its own.
// The lock's own tests (owner records, real kills, racing processes) are in pages-lock-dead-owner.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { acquireAppPagesLease } = require('../lib/sdk-build.js');
const { sha256 } = require('../lib/hash.js');
const { publishedRecordPath } = require('../lib/page-publish-records.js');
const { ownerStamp } = require('../lib/process-owner.js');
const { isTransientHalt } = require('../build-model-app.js');
const { caseSensitiveFolder, foldsCase } = require('./helpers/case-sensitive-fs.js');
const { acquireLegacyPagesLease } = require('./helpers/legacy-pages-lease.js');
const { deadPid } = require('./helpers/kill-target-client.js');

const ENV = 'https://contoso.crm.dynamics.com';
// The hashed name, worked out here rather than read from the module, so that what a build of this release creates is pinned by the test.
const canonicalName = (app) => `app-pages.${sha256(String(app).toLowerCase())}.lock`;
const legacyName = (app) => `pages-${String(app).replace(/[^A-Za-z0-9_-]/g, '_')}.lock`;
// The refusal's words, as they have always been: a person and the skills read them.
const REFUSAL = (lock, app) => `another build is deploying pages for '${app}' — refusing a second concurrent pages deploy (would risk duplicate page creation). Retry after it finishes, or delete ${lock} if it is stale.`;
const refusedAt = (lock, app) => (e) => {
  assert.strictEqual(e && e.code, 'pages-locked', String(e && e.stack));
  assert.strictEqual(e.message, REFUSAL(lock, app));
  return true;
};
const names = (dir) => fs.readdirSync(dir).sort();

// The two ways a folder can tell `Contoso_App` from `contoso_app`: modelled on every machine, and the real thing where the file system is case-sensitive.
function caseSensitiveFolders() {
  const folders = [['a folder that behaves as a case-sensitive one', (dir) => caseSensitiveFolder(dir)]];
  const probe = makeTempDir('pages-case-probe-');
  if (!foldsCase(probe)) folders.push(['this machine\'s own case-sensitive folder', () => ({ restore() {} })]);
  return folders;
}

test('two spellings of one app share one pages lease on a case-sensitive file system, as they share one page-publish record — in either order', () => {
  for (const [what, open] of caseSensitiveFolders()) {
    const dir = makeTempDir('pages-case-');
    const folder = open(dir);
    try {
      // The record the pages phase writes is the same file for both spellings: the reason they must not deploy pages at the same time.
      assert.strictEqual(publishedRecordPath(dir, 'Contoso_App', ENV), publishedRecordPath(dir, 'contoso_app', ENV), `${what}: one publish record`);
      for (const [first, second] of [['Contoso_App', 'contoso_app'], ['contoso_app', 'Contoso_App']]) {
        const held = acquireAppPagesLease(dir, first);
        // Control: the folder tells the two legacy names apart, so the legacy file alone would not keep the second spelling out.
        assert.ok(names(dir).includes(legacyName(first)) && !names(dir).includes(legacyName(second)), `${what}: ${first} took its own spelling of the legacy lock, which is not ${second}'s`);
        assert.throws(() => acquireAppPagesLease(dir, second), refusedAt(path.join(dir, canonicalName(second)), second), `${what}: ${second} is refused while ${first} holds the lease`);
        assert.deepStrictEqual(names(dir), [canonicalName(first), legacyName(first)].sort(), `${what}: ${first} holds the hashed lock and its own legacy one; the refused build took nothing and left nothing`);
        held.release();
        assert.deepStrictEqual(names(dir), [], `${what}: released`);
      }
    } finally {
      folder.restore();
    }
  }
});

test('a build of an earlier release, which takes only the legacy file, and a build of this one keep each other out of the pages phase when they spell the app the same way — in both orders', () => {
  for (const app of ['contoso_app', 'Contoso_App']) {
    const dir = makeTempDir('pages-legacy-');
    const legacy = path.join(dir, legacyName(app));
    // The earlier release first: this one is refused by the legacy file, in the words that build's own refusal would use, and lets go of the hashed one.
    const old = acquireLegacyPagesLease(dir, app);
    assert.throws(() => acquireAppPagesLease(dir, app), refusedAt(legacy, app), `${app}: the new build is refused while the old one holds the legacy file`);
    assert.deepStrictEqual(names(dir), [legacyName(app)], `${app}: the new build left nothing of its own behind`);
    old.release();
    // This release first: the earlier one is refused by the same file.
    const held = acquireAppPagesLease(dir, app);
    assert.throws(() => acquireLegacyPagesLease(dir, app), refusedAt(legacy, app), `${app}: the old build is refused while the new one holds the legacy file`);
    held.release();
    assert.deepStrictEqual(names(dir), []);
  }
});

test('the refusal of a live build that holds the lock is the pages refusal it has always been: phase pages, recoverable, never run again, the same sentence', () => {
  const dir = makeTempDir('pages-live-');
  const app = 'contoso_app';
  const old = acquireLegacyPagesLease(dir, app);
  try {
    assert.throws(() => acquireAppPagesLease(dir, app), (e) => {
      assert.strictEqual(e.name, 'BuildHalt');
      assert.strictEqual(e.code, 'pages-locked');
      assert.strictEqual(e.phase, 'pages');
      assert.strictEqual(e.recoverable, true);
      assert.strictEqual(e.retry, 'never');
      assert.strictEqual(e.transient, false);
      assert.strictEqual(isTransientHalt(e), false);
      assert.strictEqual(e.message, REFUSAL(path.join(dir, legacyName(app)), app));
      return true;
    });
  } finally {
    old.release();
  }
});

test('mixed-case and lower-case app names each take their pages lease on this machine\'s own file system — the two files never name one file', () => {
  for (const app of ['Contoso_App', 'contoso_app', 'Contoso App (Preview)']) {
    const dir = makeTempDir('pages-alias-');
    const held = acquireAppPagesLease(dir, app);
    held.release();
    assert.deepStrictEqual(names(dir), [], `${app}: taken and released, nothing left`);
  }
});

test('when the legacy file refuses, the hashed one this build took is let go again, and another build\'s lock is not touched — a stale hashed lock taken over on the way is said, and gone', () => {
  const app = 'contoso_app';
  const foreign = JSON.stringify({ ...ownerStamp(), host: 'some-other-machine', rnd: 'theirs' });
  // A hashed lock nobody holds any more, and a legacy one another machine holds.
  const dir = makeTempDir('pages-partial-');
  const dead = deadPid();
  fs.writeFileSync(path.join(dir, canonicalName(app)), JSON.stringify({ ...ownerStamp({ pid: dead }), rnd: 'killed' }));
  fs.writeFileSync(path.join(dir, legacyName(app)), foreign);
  const warnings = [];
  assert.throws(() => acquireAppPagesLease(dir, app, { warn: (m) => warnings.push(m) }), refusedAt(path.join(dir, legacyName(app)), app));
  assert.deepStrictEqual(names(dir), [legacyName(app)], 'the hashed lock it took over was let go again: nothing of this build is left');
  assert.strictEqual(fs.readFileSync(path.join(dir, legacyName(app)), 'utf8'), foreign, 'the other machine\'s lock is byte for byte what it was');
  assert.strictEqual(warnings.length, 1, `the take-over happened, and is said once: ${JSON.stringify(warnings)}`);
  assert.ok(warnings[0].startsWith(`released the pages lock for '${app}': the build that held it (pid ${dead} on `) && warnings[0].endsWith(') is no longer running'), warnings[0]);

  // A fresh hashed lock and the same foreign legacy one: nothing to say, and nothing left.
  const quiet = makeTempDir('pages-partial-');
  fs.writeFileSync(path.join(quiet, legacyName(app)), foreign);
  const said = [];
  assert.throws(() => acquireAppPagesLease(quiet, app, { warn: (m) => said.push(m) }), refusedAt(path.join(quiet, legacyName(app)), app));
  assert.deepStrictEqual(names(quiet), [legacyName(app)]);
  assert.deepStrictEqual(said, []);
});

test('a folder at a lock\'s name is refused as the file system problem it is — not as another build deploying pages — and nothing this build took is left', () => {
  const app = 'contoso_app';
  // At the legacy name: the hashed lock was taken first, and is let go again.
  const atLegacy = makeTempDir('pages-planted-');
  fs.mkdirSync(path.join(atLegacy, legacyName(app)));
  assert.throws(() => acquireAppPagesLease(atLegacy, app), (e) => {
    assert.notStrictEqual(e.code, 'pages-locked', 'not a refusal that says another build is deploying pages');
    assert.strictEqual(e.code, 'UNSAFE_OUTPUT');
    assert.strictEqual(e.reason, 'not-file');
    return true;
  });
  assert.deepStrictEqual(names(atLegacy), [legacyName(app)], 'only the folder is left: the hashed lock was let go');
  assert.ok(fs.statSync(path.join(atLegacy, legacyName(app))).isDirectory(), 'and the folder is untouched');
  // At the hashed name: refused before anything is taken.
  const atCanonical = makeTempDir('pages-planted-');
  fs.mkdirSync(path.join(atCanonical, canonicalName(app)));
  assert.throws(() => acquireAppPagesLease(atCanonical, app), (e) => e.code === 'UNSAFE_OUTPUT' && e.reason === 'not-file');
  assert.deepStrictEqual(names(atCanonical), [canonicalName(app)], 'the legacy lock was never taken');
});

test('the hashed lock is taken over only from a build proven gone: a live one, a record of another machine, platform or version, an old { pid, at } lock, a damaged or empty file — refused in the same words, untouched, nothing said', () => {
  const app = 'contoso_app';
  const gone = deadPid();
  const stamp = (overrides) => JSON.stringify({ ...ownerStamp({ pid: gone }), ...overrides, rnd: 'held' });
  const cases = [
    ['this process, which is running', JSON.stringify({ ...ownerStamp(), rnd: 'held' })],
    ['this process, by a record ten minutes old', JSON.stringify({ ...ownerStamp({ now: () => Date.now() - 10 * 60 * 1000 }), rnd: 'held' })],
    ['a record from another machine', stamp({ host: 'some-other-machine' })],
    ['a record from another kind of system', stamp({ platform: process.platform === 'win32' ? 'linux' : 'win32' })],
    ['a record from another pid namespace', stamp({ ns: 'pid:[1]' })],
    ['a lock of a release that recorded only { pid, at }', JSON.stringify({ pid: gone, at: Date.now() - 10 * 60 * 1000 })],
    ['a record of a version this one does not know', stamp({ v: 2 })],
    ['an empty file', ''],
    ['text that is not JSON', 'not json'],
  ];
  for (const [what, content] of cases) {
    const dir = makeTempDir('pages-owner-');
    const file = path.join(dir, canonicalName(app));
    fs.writeFileSync(file, content);
    const warnings = [];
    assert.throws(() => acquireAppPagesLease(dir, app, { warn: (m) => warnings.push(m) }), refusedAt(file, app), what);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), content, `${what}: the lock is as it was`);
    assert.deepStrictEqual(warnings, [], `${what}: nothing was released, so nothing is said`);
    assert.deepStrictEqual(names(dir), [canonicalName(app)], `${what}: the legacy lock was never taken, and no claim was left`);
  }
  // Control: the same lock of a process that is gone is taken over, said once, and the build holds both files.
  const dir = makeTempDir('pages-owner-');
  fs.writeFileSync(path.join(dir, canonicalName(app)), stamp({}));
  fs.writeFileSync(path.join(dir, legacyName(app)), stamp({}));
  const warnings = [];
  const held = acquireAppPagesLease(dir, app, { warn: (m) => warnings.push(m) });
  assert.strictEqual(warnings.length, 1, `one build held both files, so its take-over is said once: ${JSON.stringify(warnings)}`);
  for (const name of [canonicalName(app), legacyName(app)]) assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).pid, process.pid, `${name} is this build's now`);
  held.release();
  assert.deepStrictEqual(names(dir), []);
});

test('a release leaves a lock another build holds now as it is, without a word — and says so, without failing, when it cannot confirm it removed its own', () => {
  const app = 'contoso_app';
  const dir = makeTempDir('pages-release-');
  const warnings = [];
  const held = acquireAppPagesLease(dir, app, { warn: (m) => warnings.push(m) });
  // Another build took the hashed lock over meanwhile (this one was judged gone): its token stays.
  const theirs = JSON.stringify({ ...ownerStamp(), pid: process.pid + 1, rnd: 'theirs' });
  fs.writeFileSync(path.join(dir, canonicalName(app)), theirs);
  held.release();
  assert.deepStrictEqual(names(dir), [canonicalName(app)], 'this build\'s legacy lock is gone; the other build\'s hashed one stays');
  assert.strictEqual(fs.readFileSync(path.join(dir, canonicalName(app)), 'utf8'), theirs);
  assert.deepStrictEqual(warnings, [], 'a lock that is another build\'s is not this build\'s to report');
  fs.rmSync(path.join(dir, canonicalName(app)));

  // A removal the file system does not carry out (a scanner holds the file, say): the lock is still there, and the release says which file.
  const stuck = makeTempDir('pages-release-');
  const said = [];
  const mine = acquireAppPagesLease(stuck, app, { warn: (m) => said.push(m) });
  const legacy = path.join(stuck, legacyName(app));
  const rmSync = fs.rmSync;
  fs.rmSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(legacy)) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${legacy}'`), { code: 'EPERM' });
    return rmSync.call(fs, target, ...rest);
  };
  try {
    assert.doesNotThrow(() => mine.release(), 'a release never fails what the lock guarded');
  } finally {
    fs.rmSync = rmSync;
  }
  assert.deepStrictEqual(said, [`could not confirm removal of the pages lock for '${app}': ${legacy}. This run has finished; keep the workspace and its recovery records. If a later run still stops here, confirm no build is running before removing only this lock.`]);
  assert.deepStrictEqual(names(stuck), [legacyName(app)], 'the hashed lock was removed; the one that could not be is reported, and left');
  fs.rmSync(legacy);
});
