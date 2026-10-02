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

const { assertSafeOutputDir, writeFileSafe, appendFileSafe, removeFileSafe } = require('../lib/safe-fs.js');

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
  assert.strictEqual(path.resolve(real).toLowerCase(), path.resolve(d).toLowerCase());
});

test('a missing directory is refused, and create:true makes it then re-checks', () => {
  const missing = tmp('missing');
  assert.throws(() => assertSafeOutputDir(missing), /could not be inspected|ENOENT/);
  const created = assertSafeOutputDir(missing, { create: true });
  assert.ok(fs.statSync(created).isDirectory());
  // Already there: create is a no-op, not a second refusal.
  assert.strictEqual(assertSafeOutputDir(missing, { create: true }).toLowerCase(), created.toLowerCase());
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
