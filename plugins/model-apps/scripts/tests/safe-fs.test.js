'use strict';
// A planted link in an output folder redirects a write or an append to whatever it points at,
// outside the folder the caller named. These tests pin the one confinement primitive every
// caller shares: the final component must be a real directory or a regular file, and a write
// replaces the directory entry instead of following a link.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertSafeOutputDir, assertPlainFileTarget, writeFileSafe, appendFileSafe, removeFileSafe } = require('../lib/safe-fs.js');

const dirs = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'safefs-'));
  dirs.push(d);
  return name ? path.join(d, name) : d;
}

function tryLink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return null;
  } catch (e) {
    if (e && e.code === 'EPERM') return e;
    throw e;
  }
}

test('a real directory is accepted and its realpath is returned', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const real = assertSafeOutputDir(d);
  // Compare canonical forms: CI temp folders are reached through an alias (macOS /var -> /private/var,
  // a Windows 8.3 user folder such as RUNNER~1), and the helper returns the canonical spelling.
  assert.strictEqual(path.resolve(real).toLowerCase(), fs.realpathSync.native(d).toLowerCase());
});

test('a missing directory is refused, and create:true makes it then re-checks', () => {
  const missing = tmp('missing');
  assert.throws(() => assertSafeOutputDir(missing), /could not be inspected|ENOENT/);
  const created = assertSafeOutputDir(missing, { create: true });
  assert.ok(fs.statSync(created).isDirectory());
  // Already there: create is a no-op, not a second refusal.
  assert.strictEqual(assertSafeOutputDir(missing, { create: true }).toLowerCase(), created.toLowerCase());
});

test('a refusal names why, so a caller can tell a link from a resolution failure', () => {
  const file = tmp('file.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => assertSafeOutputDir(file), (e) => e.reason === 'not-directory');
  const missing = tmp('gone.txt');
  assert.equal(assertPlainFileTarget(missing), path.resolve(missing));
  const outside = tmp('outside.txt');
  fs.writeFileSync(outside, 'keep');
  const link = tmp('link.txt');
  try { fs.symlinkSync(outside, link, 'file'); } catch (e) {
    if (e && e.code === 'EPERM') return;
    throw e;
  }
  assert.throws(() => assertPlainFileTarget(link), (e) => e.reason === 'link' && e.code === 'UNSAFE_OUTPUT');
  const hard = tmp('hard.txt');
  fs.linkSync(outside, hard);
  assert.throws(() => assertPlainFileTarget(hard), (e) => e.reason === 'hard-link');
});

test('a file, an empty path, and a directory that cannot be resolved are refused', () => {
  const file = tmp('file.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => assertSafeOutputDir(file), /not a directory/);
  assert.throws(() => assertSafeOutputDir(''), /no path was given/);
  assert.throws(() => assertSafeOutputDir('   '), /no path was given/);
});

test('a junction as the final component is refused, including with create:true', () => {
  const base = tmp();
  const real = path.join(base, 'real');
  const j = path.join(base, 'junc');
  fs.mkdirSync(real);
  fs.symlinkSync(real, j, 'junction');
  assert.throws(() => assertSafeOutputDir(j), /symbolic link or junction/);
  assert.throws(() => assertSafeOutputDir(j, { create: true }), /symbolic link or junction/);
});

test('a junction an ancestor resolves through is the caller\'s choice and is allowed', () => {
  const base = tmp();
  const real = path.join(base, 'real');
  const child = path.join(real, 'out');
  fs.mkdirSync(child, { recursive: true });
  const j = path.join(base, 'junc');
  fs.symlinkSync(real, j, 'junction');
  const through = path.join(j, 'out');
  const accepted = assertSafeOutputDir(through);
  assert.ok(accepted.toLowerCase().endsWith(`${path.sep}out`.toLowerCase()) || accepted.toLowerCase().endsWith('/out'));
  writeFileSafe(path.join(through, 'page.tsx'), 'export const n = 1;\n');
  assert.strictEqual(fs.readFileSync(path.join(child, 'page.tsx'), 'utf8'), 'export const n = 1;\n');
});

test('a junction lstat does not flag is still refused when readlink returns a target', () => {
  // Measured on this host: a junction's lstat IS a symbolic link, so the isSymbolicLink
  // check fires first. Some Node versions report isSymbolicLink() false for a junction.
  // Hide that flag, and make realpath agree with the name that was asked for, so only
  // readlink — which returns a junction's target — can refuse it.
  const base = tmp();
  const real = path.join(base, 'real');
  const j = path.join(base, 'junc');
  fs.mkdirSync(real);
  fs.symlinkSync(real, j, 'junction');
  const realFs = fs;
  const hidden = {
    lstatSync: (p) => {
      const st = realFs.lstatSync(p);
      if (path.resolve(p) === path.resolve(j)) {
        return {
          isSymbolicLink: () => false,
          isDirectory: () => true,
          isFile: () => false,
          nlink: st.nlink,
          mode: st.mode,
        };
      }
      return st;
    },
    realpathSync: Object.assign((p) => path.resolve(p), { native: (p) => path.resolve(p) }),
    readlinkSync: (p) => {
      if (path.resolve(p) === path.resolve(j)) return real;
      const err = new Error('EINVAL');
      err.code = 'EINVAL';
      throw err;
    },
    mkdirSync: realFs.mkdirSync,
  };
  assert.throws(() => assertSafeOutputDir(j, { fs: hidden }), /junction/);
});

test('a case-only difference is accepted on every platform once readlink says it is not a link', (t) => {
  // realpath may return the stored casing (`out`) for the name the caller typed (`OUT`).
  // That is not a junction. readlink throws EINVAL for a plain directory; the casing
  // difference must not be treated as one on any platform.
  const base = tmp();
  const real = path.join(base, 'out');
  fs.mkdirSync(real);
  const typed = path.join(base, 'OUT');
  const storedCasing = (p) => (path.resolve(p) === path.resolve(typed) ? real : p);
  const fake = {
    lstatSync: (p) => fs.lstatSync(storedCasing(p)),
    realpathSync: Object.assign((p) => fs.realpathSync(storedCasing(p)), {
      native: (p) => fs.realpathSync.native(storedCasing(p)),
    }),
    readlinkSync: () => {
      const err = new Error('EINVAL');
      err.code = 'EINVAL';
      throw err;
    },
    mkdirSync: fs.mkdirSync,
  };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  for (const host of ['win32', 'darwin', 'linux']) {
    Object.defineProperty(process, 'platform', { ...platform, value: host });
    assert.doesNotThrow(() => assertSafeOutputDir(typed, { fs: fake }), host);
  }
});

test('a directory symlink is refused when the host allows creating one', (t) => {
  const base = tmp();
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  const link = path.join(base, 'link');
  const denied = tryLink(real, link, 'dir');
  if (denied) return t.skip('directory symlinks need an extra privilege on this host (EPERM); junction coverage still runs');
  assert.throws(() => assertSafeOutputDir(link), /symbolic link or junction/);
});

test('writeFileSafe writes a new file and replaces a regular file without following a link', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const file = path.join(d, 'page.tsx');
  assert.strictEqual(writeFileSafe(file, 'one\n'), path.join(fs.realpathSync.native(d), 'page.tsx'));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one\n');
  writeFileSafe(file, 'two\n', { encoding: 'utf8' });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'two\n');
});

test('writeFileSafe and appendFileSafe refuse a symlink, a junction, a hard link, and a directory', (t) => {
  const base = tmp();
  const outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  const dir = path.join(base, 'out');
  fs.mkdirSync(dir);

  const hard = path.join(dir, 'hard.txt');
  fs.writeFileSync(hard, 'shared');
  const hardName = path.join(dir, 'hard-name.txt');
  fs.linkSync(hard, hardName);
  assert.throws(() => writeFileSafe(hardName, 'changed'), /hard link/);
  assert.throws(() => appendFileSafe(hardName, 'x'), /hard link/);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'secret');
  assert.strictEqual(fs.readFileSync(hard, 'utf8'), 'shared');

  const asDir = path.join(dir, 'not-a-file');
  fs.mkdirSync(asDir);
  assert.throws(() => writeFileSafe(asDir, 'x'), /not a regular file/);
  assert.throws(() => appendFileSafe(asDir, 'x'), /not a regular file/);

  const jTarget = path.join(base, 'jtarget');
  fs.mkdirSync(jTarget);
  const j = path.join(dir, 'junc');
  fs.symlinkSync(jTarget, j, 'junction');
  assert.throws(() => writeFileSafe(j, 'x'), /symbolic link or junction|not a regular file/);
  assert.throws(() => appendFileSafe(j, 'x'), /symbolic link or junction|not a regular file/);
  assert.deepStrictEqual(fs.readdirSync(jTarget), []);

  const link = path.join(dir, 'linked.txt');
  const denied = tryLink(outside, link, 'file');
  if (denied) {
    t.diagnostic('file symlinks need an extra privilege on this host (EPERM); skipped that sub-case');
    return;
  }
  assert.throws(() => writeFileSafe(link, 'pwned'), /symbolic link or junction/);
  assert.throws(() => appendFileSafe(link, 'pwned'), /symbolic link or junction/);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'secret', 'a refused write must not change the link target');
});

test('a failed replace removes the temp file and leaves the existing target', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const file = path.join(d, 'page.tsx');
  fs.writeFileSync(file, 'keep');
  const orig = fs.renameSync;
  fs.renameSync = () => {
    const e = new Error('no space');
    e.code = 'ENOSPC';
    throw e;
  };
  try {
    assert.throws(() => writeFileSafe(file, 'new'), /failed to write/);
  } finally {
    fs.renameSync = orig;
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'keep');
  assert.deepStrictEqual(fs.readdirSync(d).filter((n) => n.endsWith('.tmp')), []);
});

// `exclusive` is the no-clobber form: the caller promised "never over a file that is there", possibly minutes before it writes.
test('writeFileSafe with exclusive creates a file that is not there, and reports anything that is — a file, a read-only file, a directory — as taken, leaving it as it was', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const file = path.join(d, 'settings.json');
  assert.strictEqual(writeFileSafe(file, 'one\n', { exclusive: true, encoding: 'utf8' }), path.join(fs.realpathSync.native(d), 'settings.json'));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one\n');
  const taken = (e) => e.code === 'IO_ERROR' && e.reason === 'exists' && /already exists/.test(e.message);
  assert.throws(() => writeFileSafe(file, 'two\n', { exclusive: true }), taken);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one\n');
  fs.chmodSync(file, 0o444);
  try {
    assert.throws(() => writeFileSafe(file, 'three\n', { exclusive: true }), taken, 'a read-only file is a file that is there');
  } finally {
    fs.chmodSync(file, 0o644);
  }
  const asDir = path.join(d, 'a-directory');
  fs.mkdirSync(asDir);
  assert.throws(() => writeFileSafe(asDir, 'x', { exclusive: true }), taken);
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ['a-directory', 'settings.json'], 'no temp file is left');
  writeFileSafe(file, 'replaced\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'replaced\n', 'without exclusive the same call still replaces');
});

test('writeFileSafe with exclusive lets the file system decide: a name that appears after the look is never overwritten, and a link planted there is never followed', (t) => {
  const base = tmp();
  const d = path.join(base, 'out');
  fs.mkdirSync(d);
  const target = path.join(fs.realpathSync.native(d), 'settings.json');
  const outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, 'secret');
  // Another process takes the name just after this call looked and found it free: the step that gives the finished file its name is where it is handed over.
  const racing = (create) => ({ ...fs, linkSync: (from, to) => { if (to === target) create(); return fs.linkSync(from, to); } });
  const taken = (e) => e.code === 'IO_ERROR' && e.reason === 'exists';
  assert.throws(() => writeFileSafe(target, 'mine', { exclusive: true, fs: racing(() => fs.writeFileSync(target, 'theirs')) }), taken);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'theirs', 'the file that appeared is not replaced');
  assert.deepStrictEqual(fs.readdirSync(d), ['settings.json'], 'and the sibling this call made is gone');
  fs.rmSync(target);
  const probe = path.join(base, 'probe-link');
  if (tryLink(outside, probe, 'file')) {
    t.diagnostic('file symlinks need an extra privilege on this host (EPERM); skipped the planted-link sub-case');
    return;
  }
  assert.throws(() => writeFileSafe(target, 'mine', { exclusive: true, fs: racing(() => fs.symlinkSync(outside, target, 'file')) }), taken);
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'secret', 'a link planted at the name is not written through');
});

test('an exclusive write that fails part way removes what it created, and one that cannot create the name says so — it is not "already exists"', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const file = path.join(d, 'settings.json');
  const failure = (code, message) => () => { throw Object.assign(new Error(message), { code }); };
  assert.throws(
    () => writeFileSafe(file, 'x', { exclusive: true, fs: { ...fs, writeFileSync: failure('ENOSPC', 'no space left on device') } }),
    (e) => e.code === 'IO_ERROR' && e.reason === undefined && /failed to write .*no space left on device/.test(e.message)
  );
  assert.deepStrictEqual(fs.readdirSync(d), [], 'neither the target nor the sibling is left: half a file is not left under any name');
  assert.throws(
    () => writeFileSafe(file, 'x', { exclusive: true, fs: { ...fs, openSync: failure('EACCES', 'permission denied') } }),
    (e) => e.code === 'IO_ERROR' && e.reason === undefined && /failed to write .*permission denied/.test(e.message)
  );
});

// A failed exclusive write used to unlink the TARGET by its name, which another writer may by then have renamed away and replaced with a file of its own — a maker's filled-in settings —
// deleting that. The write is now made to a sibling only this call knows, and a failure removes that sibling alone: no name it ever removes can be anyone else's.
test('a failed exclusive write never removes a file at the target name that another writer put there — the write goes to a sibling, and only the sibling is removed', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const target = path.join(fs.realpathSync.native(d), 'settings.json');
  const original = path.join(d, 'original.json');
  const replacement = '{"EnvironmentVariables":[{"SchemaName":"new_Secret","Value":"filled by another writer"}]}';
  const siblings = [];
  const interleaved = {
    ...fs,
    openSync: (p, flags, ...rest) => { if (flags === 'wx') siblings.push(p); return fs.openSync(p, flags, ...rest); },
    // The write fails part way, after another writer has put its file at the target name (and moved an earlier one aside): the interleaving the cleanup used to lose it in.
    writeFileSync: (fd) => {
      fs.writeFileSync(fd, '{"incomplete":');
      if (fs.existsSync(target)) fs.renameSync(target, original);
      fs.writeFileSync(target, replacement);
      throw Object.assign(new Error('synthetic device write failure after a concurrent replace'), { code: 'EIO' });
    },
  };
  assert.throws(() => writeFileSafe(target, '{}', { exclusive: true, fs: interleaved }), (e) => e.code === 'IO_ERROR' && e.reason === undefined && /synthetic device write failure/.test(e.message));
  assert.strictEqual(fs.readFileSync(target, 'utf8'), replacement, 'the other writer\'s file is still there, untouched');
  assert.strictEqual(siblings.length, 1, 'one sibling was made');
  assert.notStrictEqual(siblings[0], target, 'and it is not the target');
  assert.strictEqual(fs.existsSync(siblings[0]), false, 'the sibling — the one name this call owns — was removed');
  assert.deepStrictEqual(fs.readdirSync(d), ['settings.json'], 'nothing else is left');
});

test('an exclusive write is published whole, under its name, by one atomic step: the target does not exist until the finished file is linked to it, and the sibling\'s name is then removed', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const target = path.join(fs.realpathSync.native(d), 'settings.json');
  const seen = [];
  let sibling;
  const watching = {
    ...fs,
    openSync: (p, flags, ...rest) => { if (flags === 'wx') sibling = p; return fs.openSync(p, flags, ...rest); },
    writeFileSync: (fd, data, ...rest) => {
      fs.writeFileSync(fd, data, ...rest);
      seen.push(['after the write', fs.existsSync(target)]);
    },
    linkSync: (from, to) => {
      seen.push(['at the link', fs.existsSync(target), fs.readFileSync(from, 'utf8'), from === sibling, to === target]);
      return fs.linkSync(from, to);
    },
  };
  assert.strictEqual(writeFileSafe(target, 'the whole content\n', { exclusive: true, encoding: 'utf8', fs: watching }), target);
  assert.deepStrictEqual(seen, [['after the write', false], ['at the link', false, 'the whole content\n', true, true]], 'no name held a partial file, and the link was given the finished one');
  assert.strictEqual(path.dirname(sibling), path.dirname(target), 'the sibling is in the target\'s folder, which is what lets the link be made');
  assert.match(path.basename(sibling), /^\.settings\.json\.\d+\.[0-9a-f]{8}\.tmp$/, 'a hidden name made of the target\'s, the process and a random part');
  assert.deepStrictEqual(fs.readdirSync(d), ['settings.json'], 'the sibling\'s name is gone');
  assert.strictEqual(fs.statSync(target).nlink, 1, 'and the file has one name, so a later write of it is not refused as a hard link');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'the whole content\n');
});

test('a file system that cannot make a hard link fails an exclusive write with its own reason, leaves nothing behind, and an ordinary link failure stays an ordinary write failure', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const target = path.join(d, 'settings.json');
  const linkFails = (code) => ({ ...fs, linkSync: () => { throw Object.assign(new Error(`link: ${code}`), { code }); } });
  for (const code of ['EPERM', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EINVAL']) {
    assert.throws(
      () => writeFileSafe(target, 'x', { exclusive: true, fs: linkFails(code) }),
      (e) => e.code === 'IO_ERROR' && e.reason === 'no-hard-links' && e.message.includes(`link failed with ${code}`) && /file system that supports hard links/.test(e.message),
      code
    );
    assert.deepStrictEqual(fs.readdirSync(d), [], `${code}: neither the target nor the sibling is left`);
  }
  for (const code of ['ENOSPC', 'EACCES', 'EIO', 'ENOENT']) {
    assert.throws(() => writeFileSafe(target, 'x', { exclusive: true, fs: linkFails(code) }), (e) => e.code === 'IO_ERROR' && e.reason === undefined && /failed to write/.test(e.message), code);
    assert.deepStrictEqual(fs.readdirSync(d), [], code);
  }
});

test('an exclusive write whose sibling\'s name cannot be removed after the file is published is a SUCCESS with a warning that names the leftover — the file is complete under its name — and one whose first sibling name is taken tries another', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const target = path.join(fs.realpathSync.native(d), 'settings.json');
  let sibling;
  const stuck = {
    ...fs,
    openSync: (p, flags, ...rest) => { if (flags === 'wx') sibling = p; return fs.openSync(p, flags, ...rest); },
    // EIO is not a lock code, so no platform retries it.
    unlinkSync: (p) => { if (p === sibling) throw Object.assign(new Error('unlink failed'), { code: 'EIO' }); return fs.unlinkSync(p); },
  };
  const warnings = [];
  assert.strictEqual(writeFileSafe(target, 'complete\n', { exclusive: true, fs: stuck, onWarning: (warning) => warnings.push(warning) }), target, 'the write is done: it returns, it does not throw');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'complete\n', 'the file itself is complete');
  assert.strictEqual(warnings.length, 1);
  assert.ok(warnings[0].includes(sibling) && warnings[0].includes(target) && /was written in full/.test(warnings[0]) && /could not be removed \(EIO\)/.test(warnings[0]), warnings[0]);
  assert.match(warnings[0], /delete it/);
  assert.match(warnings[0], /two names[\s\S]*refused as a hard link/);
  assert.deepStrictEqual(fs.readdirSync(d).sort(), [path.basename(sibling), 'settings.json'].sort(), 'the leftover is the sibling, and only it');
  // A caller that passes no onWarning is not told, and the write is a success all the same.
  fs.rmSync(sibling, { force: true });
  fs.rmSync(target);
  assert.strictEqual(writeFileSafe(target, 'again\n', { exclusive: true, fs: stuck }), target);
  fs.rmSync(sibling, { force: true });
  fs.rmSync(target);

  let refused = 0;
  const taken = { ...fs, openSync: (p, flags, ...rest) => { if (flags === 'wx' && refused === 0) { refused += 1; throw Object.assign(new Error('exists'), { code: 'EEXIST' }); } return fs.openSync(p, flags, ...rest); } };
  assert.strictEqual(writeFileSafe(target, 'second try\n', { exclusive: true, fs: taken }), target);
  assert.strictEqual(refused, 1);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'second try\n');
  // A name that stays taken is not retried for ever.
  const always = { ...fs, openSync: (p, flags) => { if (flags === 'wx') throw Object.assign(new Error('exists'), { code: 'EEXIST' }); return fs.openSync(p, flags); } };
  fs.rmSync(target);
  assert.throws(() => writeFileSafe(target, 'x', { exclusive: true, fs: always }), (e) => e.code === 'IO_ERROR' && e.reason === undefined && /failed to write/.test(e.message));
});

// What a Windows scanner or sync client does to a file it has just seen written: it holds it open without delete sharing, and `unlink` answers EBUSY for as long as it does (measured on NTFS). The retry is for
// a hold that clears in the time a scanner takes, and it is Windows' alone (a POSIX file system lets a file be unlinked while it is open), so the tests are run as that platform.
const asPlatform = (t, host) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  Object.defineProperty(process, 'platform', { ...platform, value: host });
};
// An fs whose unlink of the sibling answers `code` for its first `times` calls (all of them when `times` is Infinity), and counts the calls.
function held(times, code = 'EBUSY') {
  const state = { sibling: undefined, unlinks: 0 };
  const stand = {
    ...fs,
    openSync: (p, flags, ...rest) => { if (flags === 'wx') state.sibling = p; return fs.openSync(p, flags, ...rest); },
    unlinkSync: (p) => {
      if (p !== state.sibling) return fs.unlinkSync(p);
      state.unlinks += 1;
      if (state.unlinks <= times) throw Object.assign(new Error(`${code}: resource busy or locked, unlink`), { code });
      return fs.unlinkSync(p);
    },
  };
  return { state, stand };
}

test('a sibling held for a moment after the publish is removed by the bounded retry — no warning, one name — and one held longer than the retry window is a warning after every attempt', (t) => {
  asPlatform(t, 'win32');
  const d = tmp('out');
  fs.mkdirSync(d);
  const target = path.join(fs.realpathSync.native(d), 'settings.json');
  // The hold clears inside the window (two refusals, then it lets go): the third attempt removes it. A plain unlink — one attempt — would have left the sibling and warned.
  const clears = held(2);
  const warnings = [];
  assert.strictEqual(writeFileSafe(target, 'content\n', { exclusive: true, fs: clears.stand, onWarning: (w) => warnings.push(w) }), target);
  assert.strictEqual(clears.state.unlinks, 3, 'it was tried again, twice');
  assert.deepStrictEqual(warnings, [], 'and said nothing, because nothing is left');
  assert.deepStrictEqual(fs.readdirSync(d), ['settings.json']);
  assert.strictEqual(fs.statSync(target).nlink, 1);
  fs.rmSync(target);
  // A hold that outlasts the window: the first attempt and each of the five retries, then the warning.
  const stays = held(Infinity);
  const left = [];
  assert.strictEqual(writeFileSafe(target, 'content\n', { exclusive: true, fs: stays.stand, onWarning: (w) => left.push(w) }), target);
  assert.strictEqual(stays.state.unlinks, 6, 'one attempt and the five retries of the bound');
  assert.strictEqual(left.length, 1);
  assert.ok(left[0].includes(stays.state.sibling) && /could not be removed \(EBUSY\)/.test(left[0]), left[0]);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'content\n');
  // A code that is not a lock is not retried: nothing a moment later would change it.
  fs.rmSync(stays.state.sibling, { force: true });
  fs.rmSync(target);
  const denied = held(Infinity, 'EIO');
  writeFileSafe(target, 'content\n', { exclusive: true, fs: denied.stand, onWarning: () => {} });
  assert.strictEqual(denied.state.unlinks, 1, 'a code that is not a lock is tried once');
  // A name that is already gone — a scanner quarantined the file, someone removed it — is not a leftover: there is nothing to delete, so nothing is said.
  fs.rmSync(denied.state.sibling, { force: true });
  fs.rmSync(target);
  const vanished = held(Infinity, 'ENOENT');
  const none = [];
  writeFileSafe(target, 'content\n', { exclusive: true, fs: vanished.stand, onWarning: (w) => none.push(w) });
  assert.strictEqual(vanished.state.unlinks, 1);
  assert.deepStrictEqual(none, [], 'a name that is already gone is not reported as left');
  fs.rmSync(vanished.state.sibling, { force: true });
});

test('the wait for a held sibling is Windows\' alone: elsewhere a lock code is not waited out — a POSIX file system lets a file be unlinked while it is open, so EBUSY there is not a scanner holding it', (t) => {
  asPlatform(t, 'linux');
  const d = tmp('out');
  fs.mkdirSync(d);
  const target = path.join(fs.realpathSync.native(d), 'settings.json');
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    const refused = held(Infinity, code);
    const left = [];
    assert.strictEqual(writeFileSafe(target, 'content\n', { exclusive: true, fs: refused.stand, onWarning: (w) => left.push(w) }), target);
    assert.strictEqual(refused.state.unlinks, 1, `${code}: tried once, not waited for`);
    assert.strictEqual(left.length, 1, code);
    assert.ok(left[0].includes(`could not be removed (${code})`), left[0]);
    fs.rmSync(refused.state.sibling, { force: true });
    fs.rmSync(target);
  }
});

test('a sibling that cannot be removed after a FAILED write is retried like the one after a publish, and said in the error when it stays — never left silently — and not mentioned when the retry removes it', (t) => {
  asPlatform(t, 'win32');
  const d = tmp('out');
  fs.mkdirSync(d);
  const target = path.join(fs.realpathSync.native(d), 'settings.json');
  // The name appears at the moment of the link, and the sibling is held: the refusal says the name exists, and where the temporary file is left.
  const racing = (stand) => ({ ...stand, linkSync: (from, to) => { fs.writeFileSync(target, 'theirs'); return fs.linkSync(from, to); } });
  const stays = held(Infinity);
  assert.throws(() => writeFileSafe(target, 'mine', { exclusive: true, fs: racing(stays.stand) }), (e) => {
    assert.strictEqual(e.code, 'IO_ERROR');
    assert.strictEqual(e.reason, 'exists');
    assert.strictEqual(e.leftover, stays.state.sibling);
    assert.strictEqual(e.leftoverNote, `Its temporary file ${stays.state.sibling} could not be removed (EBUSY): delete it.`);
    assert.strictEqual(e.message, `refusing to write ${target}: it already exists. ${e.leftoverNote}`);
    return true;
  });
  assert.strictEqual(stays.state.unlinks, 6, 'the retry is the bound the publish has');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'theirs', 'the other writer\'s file is untouched');
  fs.rmSync(stays.state.sibling, { force: true });
  fs.rmSync(target);
  // A hold that clears inside the window: the sibling goes, and the error is the plain one.
  const clears = held(2);
  assert.throws(() => writeFileSafe(target, 'mine', { exclusive: true, fs: racing(clears.stand) }), (e) => {
    assert.strictEqual(e.reason, 'exists');
    assert.strictEqual(e.leftover, undefined);
    assert.strictEqual(e.message, `refusing to write ${target}: it already exists`);
    return true;
  });
  assert.strictEqual(clears.state.unlinks, 3);
  assert.deepStrictEqual(fs.readdirSync(d), ['settings.json']);
  fs.rmSync(target);
  // Every failure that removes the sibling says so when it cannot: a file system without hard links, and a write that failed on the device.
  const noLinks = held(Infinity, 'EIO');
  const linkFails = { ...noLinks.stand, linkSync: () => { throw Object.assign(new Error('link: EISDIR'), { code: 'EISDIR' }); } };
  assert.throws(() => writeFileSafe(target, 'x', { exclusive: true, fs: linkFails }), (e) => e.reason === 'no-hard-links' && e.leftover === noLinks.state.sibling && e.message.endsWith(e.leftoverNote) && /\(EIO\)/.test(e.leftoverNote));
  fs.rmSync(noLinks.state.sibling, { force: true });
  const noSpace = held(Infinity, 'EIO');
  const writeFails = { ...noSpace.stand, writeFileSync: () => { throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); } };
  assert.throws(() => writeFileSafe(target, 'x', { exclusive: true, fs: writeFails }), (e) => e.code === 'IO_ERROR' && e.reason === undefined && /failed to write .*no space left on device\. Its temporary file .* could not be removed \(EIO\): delete it\.$/.test(e.message) && e.leftover === noSpace.state.sibling);
});

test('a link that answered EEXIST after it was made — NFS, when the reply of a retransmitted request is lost — is a published file; one that answered it because the name is another file\'s is not', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const target = path.join(fs.realpathSync.native(d), 'settings.json');
  // The link is made, and the answer says the name exists: the target is the sibling's own file — the same device and file id — so the file is published, whatever the answer said.
  const lostReply = { ...fs, linkSync: (from, to) => { fs.linkSync(from, to); throw Object.assign(new Error('EEXIST: file already exists, link'), { code: 'EEXIST' }); } };
  assert.strictEqual(writeFileSafe(target, 'whole\n', { exclusive: true, fs: lostReply }), target);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'whole\n');
  assert.deepStrictEqual(fs.readdirSync(d), ['settings.json'], 'the sibling was removed, as after any publish');
  assert.strictEqual(fs.statSync(target).nlink, 1);
  fs.rmSync(target);
  // The name is another file's, and the sibling has a second name somewhere else: two names, but not the target — it is taken.
  const elsewhere = path.join(d, 'elsewhere');
  const notOurs = { ...fs, linkSync: (from) => { fs.linkSync(from, elsewhere); fs.writeFileSync(target, 'theirs'); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); } };
  assert.throws(() => writeFileSafe(target, 'mine', { exclusive: true, fs: notOurs }), (e) => e.code === 'IO_ERROR' && e.reason === 'exists');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'theirs');
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ['elsewhere', 'settings.json']);
  fs.rmSync(elsewhere);
  fs.rmSync(target);
  // The name is another file's and the sibling has only its own name: taken, as always.
  const plain = { ...fs, linkSync: () => { fs.writeFileSync(target, 'theirs'); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); } };
  assert.throws(() => writeFileSafe(target, 'mine', { exclusive: true, fs: plain }), (e) => e.reason === 'exists');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'theirs');
  // A file system that gives files no id (a file id of 0) cannot say, so it is not taken for a publish.
  fs.rmSync(target);
  const noIds = { ...fs, linkSync: (from, to) => { fs.linkSync(from, to); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); }, lstatSync: (p, options) => (options && options.bigint ? Object.assign(fs.lstatSync(p, options), { ino: 0n }) : fs.lstatSync(p, options)) };
  assert.throws(() => writeFileSafe(target, 'mine', { exclusive: true, fs: noIds }), (e) => e.reason === 'exists');
  // File ids are unique within a device only: the same id on another device is another file.
  fs.rmSync(target, { force: true });
  const otherDevice = {
    ...fs,
    linkSync: (from, to) => { fs.linkSync(from, to); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
    lstatSync: (p, options) => { const st = fs.lstatSync(p, options); return options && options.bigint && p === target ? Object.assign(st, { dev: st.dev + 1n }) : st; },
  };
  assert.throws(() => writeFileSafe(target, 'mine', { exclusive: true, fs: otherDevice }), (e) => e.reason === 'exists');
  // A file id is not proof either: Windows documents the 64-bit id as not guaranteed unique on ReFS (a Dev Drive), so another writer's file at the target can share the sibling's id. What a publish makes
  // is exactly two names for one file, so the sibling's link count is two — a sibling with one name was never linked, and the target is another file.
  fs.rmSync(target, { force: true });
  let temporary;
  const theirOtherName = path.join(d, 'their-other-name');
  const sharesTheId = {
    ...fs,
    openSync: (p, flags, ...rest) => { if (flags === 'wx') temporary = p; return fs.openSync(p, flags, ...rest); },
    // The other writer's file has two names of its own, so that only the SIBLING's link count — not the target's — tells the files apart.
    linkSync: () => { fs.writeFileSync(target, 'theirs'); fs.linkSync(target, theirOtherName); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); },
    lstatSync: (p, options) => {
      const st = fs.lstatSync(p, options);
      if (!(options && options.bigint) || p !== target) return st;
      const own = fs.lstatSync(temporary, options);
      return Object.assign(st, { ino: own.ino, dev: own.dev }); // the sibling's device and id, on another writer's file
    },
  };
  assert.throws(() => writeFileSafe(target, 'mine', { exclusive: true, fs: sharesTheId }), (e) => e.code === 'IO_ERROR' && e.reason === 'exists');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'theirs', 'the other writer\'s file is untouched');
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ['settings.json', 'their-other-name'], 'and the sibling is removed');
  fs.rmSync(theirOtherName);
  // The same file with a third name is not the two names a publish makes: the refusal stands, which is the safe way to be wrong.
  fs.rmSync(target);
  const thirdName = path.join(d, 'third-name');
  const threeNames = { ...fs, linkSync: (from, to) => { fs.linkSync(from, to); fs.linkSync(from, thirdName); throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); } };
  assert.throws(() => writeFileSafe(target, 'mine', { exclusive: true, fs: threeNames }), (e) => e.reason === 'exists');
  fs.rmSync(thirdName);
  fs.rmSync(target);
  // AGENTS.md says what the check requires: the same file, and exactly its two names.
  const agents = fs.readFileSync(path.join(__dirname, '..', '..', 'AGENTS.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(agents, /is read as published when the target is the sibling's own file — the same device and file id — and the sibling has exactly its two names \(a link count of two: a file id alone is not proof, since ReFS, a Windows Dev Drive, does not guarantee its 64-bit ids unique\)/);
});

test('a later write of a file that has a second name says where it is when it is a temporary name an earlier write left in the same folder — and says nothing of one that is not', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const target = path.join(fs.realpathSync.native(d), 'settings.json');
  let sibling;
  const stuck = { ...fs, openSync: (p, flags, ...rest) => { if (flags === 'wx') sibling = p; return fs.openSync(p, flags, ...rest); }, unlinkSync: (p) => { if (p === sibling) throw Object.assign(new Error('x'), { code: 'EIO' }); return fs.unlinkSync(p); } };
  writeFileSafe(target, 'complete\n', { exclusive: true, fs: stuck, onWarning: () => {} });
  assert.strictEqual(fs.statSync(target).nlink, 2);
  const refused = (e) => e.code === 'UNSAFE_OUTPUT' && e.reason === 'hard-link' && e.message.includes('2 names share this file');
  // Every way the file is written again is refused as a hard link, and now names the other name.
  for (const [what, attempt] of [
    ['a write that may replace', () => writeFileSafe(target, 'x')],
    ['an append', () => appendFileSafe(target, 'x')],
    ['the early check', () => assertPlainFileTarget(target)],
  ]) {
    assert.throws(attempt, (e) => {
      assert.ok(refused(e), what);
      assert.ok(e.message.includes(`one of them is ${sibling}, the temporary name an earlier write could not remove — delete it`), `${what}: ${e.message}`);
      return true;
    }, what);
  }
  // Delete the leftover, and the file is writable again.
  fs.rmSync(sibling);
  assert.strictEqual(fs.statSync(target).nlink, 1);
  writeFileSafe(target, 'replaced\n');
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'replaced\n');
  // A second name that is not a temporary name of this write: the refusal is as it was, with no hint.
  const other = path.join(d, 'copy.json');
  fs.linkSync(target, other);
  assert.throws(() => writeFileSafe(target, 'x'), (e) => refused(e) && !/temporary name/.test(e.message) && !/delete it/.test(e.message), 'a link of the maker\'s own');
  // ...also when a file with a temporary name that is NOT this file sits beside it (another file, another id).
  const decoy = path.join(d, '.settings.json.1234.abcdef12.tmp');
  fs.writeFileSync(decoy, 'another file');
  assert.throws(() => writeFileSafe(target, 'x'), (e) => refused(e) && !/temporary name/.test(e.message), 'a decoy with the name of a sibling and another file\'s id');
  // A file system that gives every file the id 0 cannot say which names are one file, so the decoy is not taken for the second name…
  const noIds = { ...fs, lstatSync: (p, options) => (options && options.bigint ? Object.assign(fs.lstatSync(p, options), { ino: 0n }) : fs.lstatSync(p, options)) };
  assert.throws(() => writeFileSafe(target, 'x', { fs: noIds }), (e) => refused(e) && !/temporary name/.test(e.message), 'no file ids');
  // …and a file id is unique within a device only: a decoy that has this file\'s id on another device is another file.
  const targetId = fs.lstatSync(target, { bigint: true }).ino;
  const otherDevice = {
    ...fs,
    lstatSync: (p, options) => {
      const st = fs.lstatSync(p, options);
      return options && options.bigint && path.basename(p) === path.basename(decoy) ? Object.assign(st, { ino: targetId, dev: st.dev + 1n }) : st;
    },
  };
  assert.throws(() => writeFileSafe(target, 'x', { fs: otherDevice }), (e) => refused(e) && !/temporary name/.test(e.message), 'the same file id on another device');
  // A folder that cannot be listed gives no hint, and the refusal stands.
  const blind = { ...fs, readdirSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
  assert.throws(() => writeFileSafe(target, 'x', { fs: blind }), (e) => refused(e) && !/temporary name/.test(e.message));
});

test('appendFileSafe appends to a regular file and creates a missing one', () => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const file = path.join(d, 'log.txt');
  appendFileSafe(file, 'a');
  appendFileSafe(file, 'b');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'ab');
});

test('removeFileSafe unlinks a regular file, ignores a missing one, and refuses a directory or a link', (t) => {
  const d = tmp('out');
  fs.mkdirSync(d);
  const file = path.join(d, 'page.tsx');
  fs.writeFileSync(file, 'x');
  removeFileSafe(file);
  assert.strictEqual(fs.existsSync(file), false);
  assert.doesNotThrow(() => removeFileSafe(file));

  const sub = path.join(d, 'sub');
  fs.mkdirSync(sub);
  assert.throws(() => removeFileSafe(sub), /not a regular file/);
  assert.ok(fs.existsSync(sub));

  const outside = path.join(d, 'outside.txt');
  fs.writeFileSync(outside, 'keep');
  const link = path.join(d, 'link.txt');
  const denied = tryLink(outside, link, 'file');
  if (denied) {
    t.diagnostic('file symlinks need an extra privilege on this host (EPERM); skipped that sub-case');
  } else {
    assert.throws(() => removeFileSafe(link), /symbolic link or junction/);
    assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
    fs.unlinkSync(link);
  }

  const jTarget = path.join(d, 'jtarget');
  fs.mkdirSync(jTarget);
  const j = path.join(d, 'junc');
  fs.symlinkSync(jTarget, j, 'junction');
  assert.throws(() => removeFileSafe(j), /symbolic link or junction|not a regular file/);
  assert.ok(fs.existsSync(jTarget));
});

test('a write whose parent is missing, or is itself a junction, is refused', () => {
  const base = tmp();
  assert.throws(() => writeFileSafe(path.join(base, 'nope', 'page.tsx'), 'x'), /could not be inspected|ENOENT/);
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  const j = path.join(base, 'junc');
  fs.symlinkSync(real, j, 'junction');
  assert.throws(() => writeFileSafe(path.join(j, 'page.tsx'), 'x'), /symbolic link or junction/);
  assert.deepStrictEqual(fs.readdirSync(real), []);
});

test('removeFileSafe refuses a junctioned parent and leaves the outside file', () => {
  const base = tmp();
  const real = path.join(base, 'real');
  fs.mkdirSync(real);
  const outside = path.join(real, 'page.tsx');
  fs.writeFileSync(outside, 'keep');
  const j = path.join(base, 'junc');
  fs.symlinkSync(real, j, 'junction');
  assert.throws(
    () => removeFileSafe(path.join(j, 'page.tsx')),
    (err) => err && err.code === 'UNSAFE_OUTPUT',
  );
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'keep');
});

test('removeFileSafe under a missing directory removes nothing and does not throw', () => {
  const base = tmp();
  assert.strictEqual(removeFileSafe(path.join(base, 'gone', '.page.tsx.genpage-base.json')), false);
});

test('an 8.3 short name for a real directory is accepted', (t) => {
  if (process.platform !== 'win32') return t.skip('8.3 short names are a Windows path alias');
  const { execSync } = require('node:child_process');
  const candidates = [process.env.ProgramFiles, process.env.SystemRoot, tmp()].filter(Boolean);
  let shortName = '';
  let longName = '';
  for (const dir of candidates) {
    let probed = '';
    try {
      // execFile splits the quotes and cmd no longer sees one command. The probe the
      // short-name check needs is the cmd one-liner, which a shell preserves.
      probed = execSync(`cmd /d /c for %I in ("${dir}") do @echo %~sI`, { encoding: 'utf8' }).trim();
    } catch {
      continue;
    }
    if (probed && probed.toLowerCase() !== path.resolve(dir).toLowerCase() && /~/.test(probed)) {
      shortName = probed;
      longName = dir;
      break;
    }
  }
  if (!shortName) return t.skip('this host has no 8.3 short name to probe');
  const accepted = assertSafeOutputDir(shortName);
  assert.strictEqual(fs.realpathSync.native(accepted).toLowerCase(), fs.realpathSync.native(longName).toLowerCase());
});

test('a UNC share root is accepted even when readlink would return a target', (t) => {
  // path.parse('\\\\server\\share').root is '\\\\server\\share\\' only on Windows. POSIX
  // path.parse does not treat that spelling as a root, so the fake readlink would refuse it.
  if (process.platform !== 'win32') return t.skip('UNC share roots are a Windows path');
  // A textual parent+basename compare builds the wrong expected path for that root and used to call it a junction.
  const share = '\\\\server\\share';
  const native = '\\\\server\\share\\';
  const fake = {
    lstatSync: () => ({
      isSymbolicLink: () => false,
      isDirectory: () => true,
      isFile: () => false,
      nlink: 1,
      mode: 0o40755,
    }),
    realpathSync: Object.assign(() => native, { native: () => native }),
    readlinkSync: () => '\\\\elsewhere\\target',
  };
  assert.strictEqual(assertSafeOutputDir(share, { fs: fake }), native);
});
