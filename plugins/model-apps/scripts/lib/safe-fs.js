'use strict';
// One output-confinement primitive for every caller that writes into a directory the user named.
//
// Why: a link left at the output name — a symbolic link, a directory junction, or a hard
// link whose other name lives elsewhere — makes a write, an append, or a delete land on some other
// file. `writeFileSync` and `appendFileSync` follow links. Replacing the directory entry (write to
// a temp file in the same directory, then rename) does not.
//
// Only the FINAL component is inspected. A symlinked ancestor is the caller's own choice: macOS
// temp directories live under a symlinked `/var`, and a junctioned project root is a normal setup.
// That is the same rule as `checkWorkspaceClearable` in workspace-paths.js. That helper is not
// called here — it also requires an SDK workspace manifest and exists to gate a recursive delete,
// so reusing it would refuse every ordinary output directory.
//
// Windows: `lstat` reports a junction as a symbolic link on some Node versions and not on others.
// When it does not, `readlink` still returns the junction target, and throws EINVAL for a plain
// directory. A textual realpath compare is not that signal: an 8.3 short name realpaths to the
// long name, and a UNC share root has no parent component to join, so both looked like junctions.
// A volume or share root is not a link. `realpath.native` is still what callers get back, so a
// later join uses the stored name rather than the spelling the caller typed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const UNSAFE = 'UNSAFE_OUTPUT';

// Windows can refuse a rename while another process briefly holds the destination (Defender, the
// search indexer, OneDrive) and reports EPERM/EACCES/EBUSY. A short bounded retry absorbs that;
// a lock that outlasts it is reported as a lock. Same bound as generate-page-manifest.js.
const RENAME_RETRY_MS = [25, 50, 100, 200, 400];
const RENAME_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function unsafe(message) {
  const e = new Error(message);
  e.code = UNSAFE;
  throw e;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(fsImpl, from, to) {
  for (let i = 0; ; i += 1) {
    try {
      fsImpl.renameSync(from, to);
      return;
    } catch (err) {
      if (process.platform !== 'win32' || !RENAME_LOCK_CODES.has(err.code) || i >= RENAME_RETRY_MS.length) throw err;
      sleepSync(RENAME_RETRY_MS[i]);
    }
  }
}

function realpathNative(fsImpl, p) {
  const realpath = fsImpl.realpathSync.native || fsImpl.realpathSync;
  return realpath(p);
}

// `path.parse` keeps the trailing separator on a root (`C:\`, `\\server\share\`). Compare the
// normalized forms, and the same forms with that separator removed, so `\\server\share` and
// `\\server\share\` are both the share root and not a link of themselves.
function isFsOrShareRoot(p) {
  const normalized = path.normalize(p);
  const root = path.normalize(path.parse(normalized).root);
  if (root && root === normalized) return true;
  const strip = (s) => s.replace(/[\\/]+$/, '');
  return Boolean(root) && strip(root) === strip(normalized);
}

// True when `readlink` returns a target. A junction lstat did not flag still has one; a plain
// directory throws EINVAL. A filesystem or share root is not a link even if readlink would
// return something — it has no parent component that could be one.
function readlinkSaysLink(p, fsImpl) {
  if (isFsOrShareRoot(p)) return false;
  if (typeof fsImpl.readlinkSync !== 'function') return false;
  try {
    fsImpl.readlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

function assertSafeOutputDir(dir, { create = false, fs: fsImpl = fs } = {}) {
  if (typeof dir !== 'string' || !dir.trim()) {
    unsafe('refusing to use an output directory: no path was given');
  }
  const resolved = path.resolve(dir);
  return inspectOutputDir(resolved, { create, fs: fsImpl, created: false });
}

function inspectOutputDir(resolved, { create, fs: fsImpl, created }) {
  let st;
  try {
    st = fsImpl.lstatSync(resolved);
  } catch (e) {
    if (e && e.code === 'ENOENT' && create && !created) {
      try {
        fsImpl.mkdirSync(resolved, { recursive: true });
      } catch (mkdirErr) {
        unsafe(`refusing to use ${resolved} as an output directory: it could not be created (${(mkdirErr && mkdirErr.code) || mkdirErr})`);
      }
      // Re-check after create. mkdir succeeds on a junction that is already there, and that
      // re-check is what refuses it — a created name is not trusted just because mkdir returned.
      return inspectOutputDir(resolved, { create, fs: fsImpl, created: true });
    }
    unsafe(`refusing to use ${resolved} as an output directory: it could not be inspected (${(e && e.code) || e})`);
  }
  if (st.isSymbolicLink()) {
    unsafe(`refusing to use ${resolved} as an output directory: its final component is a symbolic link or junction, and a write there would land outside the directory that was named`);
  }
  if (!st.isDirectory()) {
    unsafe(`refusing to use ${resolved} as an output directory: it is not a directory`);
  }
  if (readlinkSaysLink(resolved, fsImpl)) {
    unsafe(`refusing to use ${resolved} as an output directory: its final component is a junction, and a write there would land outside the directory that was named`);
  }
  try {
    return realpathNative(fsImpl, resolved);
  } catch (e) {
    unsafe(`refusing to use ${resolved} as an output directory: it could not be resolved (${(e && e.code) || e})`);
  }
}

// Why a write or append must not touch this existing name. null when it is a regular file with
// one name. A hard link is a regular file, but writing it changes every other name too.
function plantedFileReason(filePath, st, fsImpl) {
  if (st.isSymbolicLink()) return 'a symbolic link or junction';
  if (readlinkSaysLink(filePath, fsImpl)) return 'a junction';
  if (!st.isFile()) return 'not a regular file';
  if (st.nlink > 1) return `a hard link (${st.nlink} names share this file)`;
  return null;
}

function existingTarget(filePath, fsImpl) {
  try {
    return fsImpl.lstatSync(filePath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    unsafe(`refusing to write ${filePath}: it could not be inspected (${(e && e.code) || e})`);
  }
  return null;
}

function assertWritableTarget(filePath, fsImpl) {
  const st = existingTarget(filePath, fsImpl);
  if (!st) return null;
  const reason = plantedFileReason(filePath, st, fsImpl);
  if (reason) {
    unsafe(`refusing to write ${filePath}: it is ${reason}, and writing it would change the file it points at`);
  }
  // A read-only file is a deliberate "do not modify". Replacing the directory entry needs write
  // access to the directory, not the file, so a rename would ignore the bit an in-place write honored.
  if (!(st.mode & 0o200)) {
    const e = new Error(`refusing to write ${filePath}: it is read-only`);
    e.code = 'IO_ERROR';
    throw e;
  }
  return st;
}

function writeFileSafe(filePath, data, opts) {
  if (typeof filePath !== 'string' || !filePath.trim()) unsafe('refusing to write: no path was given');
  const fsImpl = (opts && opts.fs) || fs;
  const resolved = path.resolve(filePath);
  const realDir = assertSafeOutputDir(path.dirname(resolved), { fs: fsImpl });
  const target = path.join(realDir, path.basename(resolved));
  const st = assertWritableTarget(target, fsImpl);
  // The checks above describe the past: a link swapped in before a direct write would be followed.
  // An exclusive temp file plus rename replaces the directory entry, so that link is discarded
  // rather than followed. `wx` fails instead of reusing a name someone else created — that file
  // is not ours to delete.
  const tmp = path.join(realDir, `.${path.basename(resolved)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let createdTmp = false;
  try {
    const fd = fsImpl.openSync(tmp, 'wx');
    createdTmp = true;
    try {
      if (opts && opts.encoding) fsImpl.writeFileSync(fd, data, { encoding: opts.encoding });
      else fsImpl.writeFileSync(fd, data);
    } finally {
      fsImpl.closeSync(fd);
    }
    if (st) fsImpl.chmodSync(tmp, st.mode & 0o777);
    renameWithRetry(fsImpl, tmp, target);
  } catch (err) {
    if (createdTmp) {
      try { fsImpl.unlinkSync(tmp); } catch { /* already renamed, or removed by someone else */ }
    }
    if (err && (err.code === UNSAFE || err.code === 'IO_ERROR')) throw err;
    const locked = process.platform === 'win32' && RENAME_LOCK_CODES.has(err && err.code);
    const e = new Error(locked
      ? `failed to write ${filePath}: it could not be replaced (${err.code}) — another program may have it open. Close it and retry.`
      : `failed to write ${filePath}: ${(err && err.message) || err}`);
    e.code = 'IO_ERROR';
    throw e;
  }
  return target;
}

function appendFileSafe(filePath, data, opts) {
  if (typeof filePath !== 'string' || !filePath.trim()) unsafe('refusing to append: no path was given');
  const fsImpl = (opts && opts.fs) || fs;
  const resolved = path.resolve(filePath);
  const realDir = assertSafeOutputDir(path.dirname(resolved), { fs: fsImpl });
  const target = path.join(realDir, path.basename(resolved));
  assertWritableTarget(target, fsImpl);
  // Open 'a' only after the checks. 'a' follows a link, so this does not close a race with a
  // process that can already write the directory; it does refuse a link that was there beforehand.
  // A missing file is created by the append itself.
  if (opts && opts.encoding) fsImpl.appendFileSync(target, data, { encoding: opts.encoding });
  else fsImpl.appendFileSync(target, data);
  return target;
}

function removeFileSafe(filePath, opts) {
  if (typeof filePath !== 'string' || !filePath.trim()) unsafe('refusing to remove: no path was given');
  const fsImpl = (opts && opts.fs) || fs;
  const resolved = path.resolve(filePath);
  // A parent that does not exist holds no file to remove: the same answer as a missing file.
  try {
    fsImpl.lstatSync(path.dirname(resolved));
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
  }
  // Same parent rule as write and append. A junctioned parent would otherwise let unlink follow
  // into a directory writes already refuse, and delete a file this tool did not name.
  const realDir = assertSafeOutputDir(path.dirname(resolved), { fs: fsImpl });
  const target = path.join(realDir, path.basename(resolved));
  let st;
  try {
    st = fsImpl.lstatSync(target);
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    unsafe(`refusing to remove ${target}: it could not be inspected (${(e && e.code) || e})`);
  }
  if (st.isSymbolicLink()) {
    unsafe(`refusing to remove ${target}: it is a symbolic link or junction, and removing it is not the same as removing a file this tool wrote`);
  }
  if (readlinkSaysLink(target, fsImpl)) {
    unsafe(`refusing to remove ${target}: it is a junction, and removing it would affect the directory it points at`);
  }
  if (!st.isFile()) {
    unsafe(`refusing to remove ${target}: it is not a regular file`);
  }
  // A hard link is unlinked by name: that drops this name and leaves the other names' bytes alone.
  // A write through it would not, which is why write and append refuse nlink > 1 and remove does not.
  fsImpl.unlinkSync(target);
  return true;
}

module.exports = {
  assertSafeOutputDir,
  writeFileSafe,
  appendFileSafe,
  removeFileSafe,
};
