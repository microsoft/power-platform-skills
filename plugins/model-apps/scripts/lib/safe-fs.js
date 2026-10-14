'use strict';
// One output-confinement primitive for every caller that writes into a directory the user named.
//
// Why: a link left at the output name — a symbolic link, a directory junction, or a hard
// link whose other name lives elsewhere — makes a write, an append, or a delete land on some other
// file. `writeFileSync` and `appendFileSync` follow links. Replacing the directory entry (write to
// a temp file in the same directory, then rename) does not.
//
// `writeFileSafe(…, { exclusive: true })` is the no-clobber form: it writes the file whole to a sibling nobody else knows and gives it the target's name with a hard link, which
// fails when the name is taken — so the file system decides whether the name is free, in one step, and a failure removes only the sibling it made. A sibling that cannot be removed is
// never left unmentioned: the error of a failed write names it, and a write that was published reports it through `onWarning` (see createExclusive).
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

// `reason` is how a caller tells a link (must halt) from a resolution or create failure
// (often best-effort). Messages stay human-readable; do not branch on their text.
function unsafe(message, reason) {
  const e = new Error(message);
  e.code = UNSAFE;
  e.reason = reason;
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
    unsafe('refusing to use an output directory: no path was given', 'uninspectable');
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
        unsafe(`refusing to use ${resolved} as an output directory: it could not be created (${(mkdirErr && mkdirErr.code) || mkdirErr})`, 'create-failed');
      }
      // Re-check after create. mkdir succeeds on a junction that is already there, and that
      // re-check is what refuses it — a created name is not trusted just because mkdir returned.
      return inspectOutputDir(resolved, { create, fs: fsImpl, created: true });
    }
    unsafe(`refusing to use ${resolved} as an output directory: it could not be inspected (${(e && e.code) || e})`, 'uninspectable');
  }
  if (st.isSymbolicLink()) {
    unsafe(`refusing to use ${resolved} as an output directory: its final component is a symbolic link or junction, and a write there would land outside the directory that was named`, 'link');
  }
  if (!st.isDirectory()) {
    unsafe(`refusing to use ${resolved} as an output directory: it is not a directory`, 'not-directory');
  }
  if (readlinkSaysLink(resolved, fsImpl)) {
    unsafe(`refusing to use ${resolved} as an output directory: its final component is a junction, and a write there would land outside the directory that was named`, 'link');
  }
  try {
    return realpathNative(fsImpl, resolved);
  } catch (e) {
    unsafe(`refusing to use ${resolved} as an output directory: it could not be resolved (${(e && e.code) || e})`, 'unresolvable');
  }
}

// Why a write or append must not touch this existing name. null when it is a regular file with
// one name. A hard link is a regular file, but writing it changes every other name too.
// Stable codes, not phrases: a caller that must halt only for a link cannot parse the sentence.
function plantedFileCode(filePath, st, fsImpl) {
  if (st.isSymbolicLink() || readlinkSaysLink(filePath, fsImpl)) return 'link';
  if (!st.isFile()) return 'not-file';
  if (st.nlink > 1) return 'hard-link';
  return null;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The temporary sibling of `filePath` that still holds the file's second name, when there is one: a hidden `.<name>.<pid>.<8 hex>.tmp` in the same folder (siblingTempName) that is the SAME file
// (same device and file id). That is what an exclusive write leaves when it published the file but could not remove the sibling afterwards (a scanner or a sync client held it), and what a crash
// between the link and the removal leaves — and the next write of the file is refused as a hard link, which on its own does not say where the other name is. Read with `bigint`, because a Windows
// file id is 64 bits and a number cannot hold it. A folder that cannot be listed or a file that cannot be read has no hint: the refusal stands without one.
function leftoverSibling(filePath, fsImpl) {
  try {
    const name = path.basename(filePath);
    const dir = path.dirname(filePath);
    const pattern = new RegExp(`^\\.${escapeRegExp(name)}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`);
    const target = fsImpl.lstatSync(filePath, { bigint: true });
    if (target.ino === 0n) return null; // a file system that does not give files an id cannot say which names are the same file
    for (const entry of fsImpl.readdirSync(dir)) {
      if (!pattern.test(entry)) continue;
      const candidate = path.join(dir, entry);
      const other = fsImpl.lstatSync(candidate, { bigint: true });
      if (other.ino === target.ino && other.dev === target.dev) return candidate;
    }
  } catch {
    // no hint
  }
  return null;
}

function plantedFilePhrase(code, st, filePath, fsImpl) {
  if (code === 'link') return 'a symbolic link or junction';
  if (code === 'hard-link') {
    const sibling = filePath && fsImpl ? leftoverSibling(filePath, fsImpl) : null;
    return `a hard link (${st.nlink} names share this file${sibling ? `; one of them is ${sibling}, the temporary name an earlier write could not remove — delete it` : ''})`;
  }
  return 'not a regular file';
}

function plantedFileReason(filePath, st, fsImpl) {
  const code = plantedFileCode(filePath, st, fsImpl);
  return code ? plantedFilePhrase(code, st, filePath, fsImpl) : null;
}

function existingTarget(filePath, fsImpl) {
  try {
    return fsImpl.lstatSync(filePath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    unsafe(`refusing to write ${filePath}: it could not be inspected (${(e && e.code) || e})`, 'uninspectable');
  }
  return null;
}

function assertWritableTarget(filePath, fsImpl) {
  const st = existingTarget(filePath, fsImpl);
  if (!st) return null;
  const code = plantedFileCode(filePath, st, fsImpl);
  if (code) {
    unsafe(`refusing to write ${filePath}: it is ${plantedFilePhrase(code, st, filePath, fsImpl)}, and writing it would change the file it points at`, code);
  }
  // A read-only file is a deliberate "do not modify". Replacing the directory entry needs write
  // access to the directory, not the file, so a rename would ignore the bit an in-place write honored.
  if (!(st.mode & 0o200)) {
    const e = new Error(`refusing to write ${filePath}: it is read-only`);
    e.code = 'IO_ERROR';
    e.reason = 'read-only';
    throw e;
  }
  return st;
}

// Inspect only. Missing is allowed — the caller is about to create the name. A link, a junction,
// a non-file, or a hard link is refused without opening or replacing it, so a later look that
// sees one name cannot turn this refusal into a write.
function assertPlainFileTarget(filePath, opts) {
  if (typeof filePath !== 'string' || !filePath.trim()) unsafe('refusing to write: no path was given', 'uninspectable');
  const fsImpl = (opts && opts.fs) || fs;
  const resolved = path.resolve(filePath);
  let st;
  try {
    st = fsImpl.lstatSync(resolved);
  } catch (e) {
    if (e && e.code === 'ENOENT') return resolved;
    unsafe(`refusing to write ${resolved}: it could not be inspected (${(e && e.code) || e})`, 'uninspectable');
  }
  const code = plantedFileCode(resolved, st, fsImpl);
  if (code) {
    unsafe(`refusing to write ${resolved}: it is ${plantedFilePhrase(code, st, resolved, fsImpl)}, and writing it would change the file it points at`, code);
  }
  return resolved;
}

function writeFileSafe(filePath, data, opts) {
  if (typeof filePath !== 'string' || !filePath.trim()) unsafe('refusing to write: no path was given', 'uninspectable');
  const fsImpl = (opts && opts.fs) || fs;
  const resolved = path.resolve(filePath);
  const realDir = assertSafeOutputDir(path.dirname(resolved), { fs: fsImpl });
  const target = path.join(realDir, path.basename(resolved));
  // `exclusive`: the file is CREATED here, and never replaces one. A name that is taken — by a file, a read-only file, a link, a directory: anything — is reported as taken, and
  // the decision is the file system's, made in the single step that gives the finished file its name (createExclusive: a hard link, which fails with EEXIST when the name is
  // taken and never follows a link planted there). The look beforehand only gives the refusal its precise name: it says nothing about the moment of the write, and a caller
  // whose work before the write takes minutes has no other way to promise "not over a file that appeared meanwhile".
  if (opts && opts.exclusive) {
    if (existingTarget(target, fsImpl)) throw existsError(target);
    return createExclusive(fsImpl, target, data, opts);
  }
  const st = assertWritableTarget(target, fsImpl);
  // The checks above describe the past: a link swapped in before a direct write would be followed.
  // An exclusive temp file plus rename replaces the directory entry, so that link is discarded
  // rather than followed. `wx` fails instead of reusing a name someone else created — that file
  // is not ours to delete.
  const tmp = siblingTempName(realDir, path.basename(resolved));
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
    throw writeFailure(filePath, err);
  }
  return target;
}

// The refusal of an exclusive write whose name is taken. `reason` is how a caller tells it from every other write failure (which it does not retry or report alike).
function existsError(target) {
  const e = new Error(`refusing to write ${target}: it already exists`);
  e.code = 'IO_ERROR';
  e.reason = 'exists';
  return e;
}

// `replacing` is false for a write that creates the name (nothing is being replaced, so "could not be replaced — another program may have it open" would be untrue).
function writeFailure(filePath, err, { replacing = true } = {}) {
  const locked = replacing && process.platform === 'win32' && RENAME_LOCK_CODES.has(err && err.code);
  const e = new Error(locked
    ? `failed to write ${filePath}: it could not be replaced (${err.code}) — another program may have it open. Close it and retry.`
    : `failed to write ${filePath}: ${(err && err.message) || err}`);
  e.code = 'IO_ERROR';
  return e;
}

// The name of a temporary sibling of `name` in `dir`: hidden, and unique to this process and call.
function siblingTempName(dir, name) {
  return path.join(dir, `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
}

// What a failed `link` says about the file system, as opposed to about this file: the codes of a file system that cannot make a second name for a file — FAT and exFAT (libuv reports
// Windows' ERROR_INVALID_FUNCTION as EISDIR), some network shares and FUSE mounts (ENOTSUP, EOPNOTSUPP, EPERM on Linux vfat, ENOSYS), a link count already at its limit (EMLINK) or a
// name that is on another device (EXDEV). Anything else — a full disk, a permission, a vanished folder — is an ordinary write failure.
const HARD_LINK_UNSUPPORTED_CODES = new Set(['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV', 'EMLINK', 'EISDIR', 'EINVAL']);

// An exclusive write: the file is written WHOLE to a sibling of the target that only this call knows, and is then given the target's name in one atomic step that refuses to replace
// anything — a hard link, `link(sibling, target)`, which fails with EEXIST when the name is taken (POSIX link(2); Windows CreateHardLinkW) — and the sibling's own name is removed.
//
// Why not create the target itself (`wx`) and write into it: the name then exists, half written, from the moment of the create, and a failed write has to remove it — by its NAME, which
// another writer may by then have renamed away and replaced with a file of its own (a maker's filled-in settings, say); the unlink would delete that file. Here the only name this call ever
// removes is the sibling's, which it created exclusively and nobody else knows, so a failure can never reach another writer's file; and a reader never sees a half-written target.
//
// A file system without hard links cannot do this: the call then FAILS — `reason: 'no-hard-links'` — rather than fall back to something that cannot keep the promise. A caller that does
// not need it (it replaces a file anyway) does not pass `exclusive`: that write renames a finished sibling over the target, which needs no link, and so works on such a file system.
//
// What becomes of the sibling's name, which is the one thing this call may leave behind:
//   - when the call FAILS (the name is taken, no hard links, the write itself failed) it is removed with the bounded retry a Windows lock needs; one that still cannot be removed is said in the error
//     (`leftover`, and the sentence in `leftoverNote` that is also at the end of its message) — a file this call could not clean up is not left unmentioned;
//   - when the file was PUBLISHED, it is complete under its name, which is the write that was asked for, so a sibling that cannot be removed is a WARNING — `opts.onWarning(sentence)` — and not a
//     failure: the file has two names until someone removes the sibling, and the next write of it is refused as a hard link that names the leftover (leftoverSibling). A caller that passes no
//     `onWarning` is not told.
function createExclusive(fsImpl, target, data, opts) {
  const dir = path.dirname(target);
  const name = path.basename(target);
  let tmp;
  let fd;
  for (let attempt = 0; fd === undefined; attempt += 1) {
    tmp = siblingTempName(dir, name);
    try {
      fd = fsImpl.openSync(tmp, 'wx');
    } catch (err) {
      // A sibling name that is already taken (not by us: ours is new) is another call's: try another name. Anything else is the write failing.
      if (!(err && err.code === 'EEXIST') || attempt >= 4) throw writeFailure(target, err, { replacing: false });
    }
  }
  // Drops the sibling's name: null when it is gone, else the code of what stopped it (a lock that outlasts the retry, a permission).
  const dropSibling = () => {
    try {
      unlinkWithRetry(fsImpl, tmp);
      return null;
    } catch (err) {
      return (err && err.code) || String(err);
    }
  };
  try {
    try {
      if (opts && opts.encoding) fsImpl.writeFileSync(fd, data, { encoding: opts.encoding });
      else fsImpl.writeFileSync(fd, data);
    } finally {
      fsImpl.closeSync(fd);
    }
    try {
      fsImpl.linkSync(tmp, target);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // A name that is taken by anything else is the refusal. But over NFS a link request that is sent again because its reply was lost answers EEXIST for a link the first request MADE
        // (link(2): "On NFS file systems, the return code may be wrong in the case the NFS server performs the link creation and dies before it can say so. Use stat(2) to find out if the link
        // got created."), and then the target IS this call's file, with the sibling its second name: published, whatever the answer said (publishedAlready says how that is told).
        // See: https://man7.org/linux/man-pages/man2/link.2.html
        if (!publishedAlready(fsImpl, tmp, target)) throw existsError(target);
      } else if (err && HARD_LINK_UNSUPPORTED_CODES.has(err.code)) {
        throw noHardLinksError(target, err);
      } else {
        throw err;
      }
    }
  } catch (err) {
    const failure = err && err.code === 'IO_ERROR' ? err : writeFailure(target, err, { replacing: false });
    const left = dropSibling();
    if (left) withLeftover(failure, tmp, left);
    throw failure;
  }
  // The target is complete under its name. Dropping the sibling's name leaves one name for it; a name that cannot be dropped (Windows holds a just-written file for a moment while a
  // scanner reads it, hence the retry) leaves the file two names, and that is said — but the write is done, so it is a warning, not a failure.
  const left = dropSibling();
  if (left && opts && typeof opts.onWarning === 'function') {
    opts.onWarning(`${target} was written in full, but its temporary name ${tmp} could not be removed (${left}): delete it — until then the file has two names, and writing it again is refused as a hard link`);
  }
  return target;
}

// Whether `target` is this call's own file: the file `sibling` names — the same device and file id — with the sibling as its second name, which is a link count of exactly two. open(2) gives that test
// for a lock made with link(2) over NFS: "use stat(2) on the unique file to check if its link count has increased to 2, in which case the lock is also successful"
// (https://man7.org/linux/man-pages/man2/open.2.html, O_EXCL). The id alone is not proof: Windows documents the 64-bit file id as not guaranteed unique on ReFS (a Dev Drive) — "The 64-bit identifier in
// this structure is not guaranteed to be unique on ReFS", https://learn.microsoft.com/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information — so a file another writer put at the target could
// share it, and only a sibling that really was linked has two names. A doubt is a refusal, never an overwrite. Read with `bigint`, because a Windows file id is 64 bits and a number cannot hold it; a file
// system that gives files no id (0) cannot say, and a name that cannot be read is not that file.
function publishedAlready(fsImpl, sibling, target) {
  try {
    const own = fsImpl.lstatSync(sibling, { bigint: true });
    const named = fsImpl.lstatSync(target, { bigint: true });
    return own.nlink === 2n && own.ino !== 0n && own.ino === named.ino && own.dev === named.dev;
  } catch {
    return false;
  }
}

// Says in `error` that the sibling's name could not be removed: where it is (`leftover`) and a sentence for a caller that makes a message of its own (`leftoverNote`), also added to the message.
function withLeftover(error, file, code) {
  error.leftover = file;
  error.leftoverNote = `Its temporary file ${file} could not be removed (${code}): delete it.`;
  error.message = `${error.message.replace(/\.?$/, '.')} ${error.leftoverNote}`;
}

function noHardLinksError(target, err) {
  const e = new Error(`failed to create ${target} without replacing a file: this file system cannot make a second name for a file (link failed with ${err.code}), which is how the no-replace guarantee is kept. Write to a folder on a file system that supports hard links (NTFS, ext4, APFS).`);
  e.code = 'IO_ERROR';
  e.reason = 'no-hard-links';
  return e;
}

// `unlink` with the bounded retry a Windows lock needs, as renameWithRetry has.
function unlinkWithRetry(fsImpl, file) {
  for (let i = 0; ; i += 1) {
    try {
      fsImpl.unlinkSync(file);
      return;
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      if (process.platform !== 'win32' || !RENAME_LOCK_CODES.has(err.code) || i >= RENAME_RETRY_MS.length) throw err;
      sleepSync(RENAME_RETRY_MS[i]);
    }
  }
}

function appendFileSafe(filePath, data, opts) {
  if (typeof filePath !== 'string' || !filePath.trim()) unsafe('refusing to append: no path was given', 'uninspectable');
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
  if (typeof filePath !== 'string' || !filePath.trim()) unsafe('refusing to remove: no path was given', 'uninspectable');
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
    unsafe(`refusing to remove ${target}: it could not be inspected (${(e && e.code) || e})`, 'uninspectable');
  }
  if (st.isSymbolicLink()) {
    unsafe(`refusing to remove ${target}: it is a symbolic link or junction, and removing it is not the same as removing a file this tool wrote`, 'link');
  }
  if (readlinkSaysLink(target, fsImpl)) {
    unsafe(`refusing to remove ${target}: it is a junction, and removing it would affect the directory it points at`, 'link');
  }
  if (!st.isFile()) {
    unsafe(`refusing to remove ${target}: it is not a regular file`, 'not-file');
  }
  // A hard link is unlinked by name: that drops this name and leaves the other names' bytes alone.
  // A write through it would not, which is why write and append refuse nlink > 1 and remove does not.
  fsImpl.unlinkSync(target);
  return true;
}

module.exports = {
  assertSafeOutputDir,
  assertPlainFileTarget,
  writeFileSafe,
  appendFileSafe,
  removeFileSafe,
};
