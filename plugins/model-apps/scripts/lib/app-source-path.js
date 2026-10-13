'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Check both separator styles on every host: `D:page.tsx` is drive-relative on Windows,
// and `page.tsx:extra` names an alternate stream rather than the declared source file.
// See https://learn.microsoft.com/windows/win32/fileio/naming-a-file#naming-conventions
function isAppSourcePath(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim() || /^[\\/]/.test(relPath) || /[:\0]/.test(relPath)) return false;
  const normalized = path.posix.normalize(relPath.replace(/\\/g, '/'));
  return normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

function within(root, file) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function sourceError(message, reason, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: 'APP_SOURCE_PATH', reason });
}

function resolveAppSource(appDir, relPath, deps = {}) {
  if (!isAppSourcePath(relPath)) {
    throw sourceError('must be an app-folder-confined relative path (no parent escape, rooted or drive path, or alternate stream)', 'invalid-path');
  }
  const root = path.resolve(appDir || '.');
  const absolute = path.resolve(root, relPath.replace(/[\\/]/g, path.sep));
  if (!within(root, absolute)) throw sourceError('resolves outside the workspace', 'outside');
  const realpath = deps.realpath || ((p) => fs.realpathSync.native(p));
  // The existing source-check seam can supply an in-memory isFile/realpath pair. Production
  // always inspects every component, since a link inside the folder is still a second identity.
  const lstat = deps.lstat || (deps.isFile ? null : (p) => fs.lstatSync(p));
  const readlink = deps.readlink || ((p) => fs.readlinkSync(p));
  try {
    const realRoot = realpath(root);
    let leaf;
    if (lstat) {
      let probe = root;
      for (const segment of path.relative(root, absolute).split(path.sep)) {
        probe = path.join(probe, segment);
        leaf = lstat(probe);
        if (leaf.isSymbolicLink()) throw sourceError('passes through a symbolic link or junction', 'link');
        // A Windows junction can have an ordinary-looking lstat result. readlink identifies the
        // link itself; realpath spelling changes also occur for valid 8.3 aliases and are not proof.
        let linked = false;
        try { readlink(probe); linked = true; } catch (e) { if (e.code !== 'EINVAL') throw e; }
        if (linked) throw sourceError('passes through a symbolic link or junction', 'link');
      }
    }
    const isFile = deps.isFile ? deps.isFile(absolute) === true : leaf.isFile();
    if (!isFile) throw sourceError('does not exist or is not a file', 'not-file');
    const realFile = realpath(absolute);
    if (!within(realRoot, realFile)) throw sourceError('resolves outside the workspace', 'outside');
    return realFile;
  } catch (e) {
    if (e.code === 'APP_SOURCE_PATH') throw e;
    const absent = e.code === 'ENOENT' || e.code === 'ENOTDIR';
    throw sourceError(absent ? 'does not exist or is not a file' : `cannot be checked (${e.code || e.message})`, absent ? 'not-file' : 'unreadable', e);
  }
}

module.exports = { isAppSourcePath, resolveAppSource };
