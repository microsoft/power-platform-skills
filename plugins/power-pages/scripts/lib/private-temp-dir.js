// Private, self-cleaning temporary directories for browser output (screenshots, page
// snapshots) that must stay out of the user's project.
//
// A directory from mkdtemp is private to the current user (0700 on POSIX) and cannot
// collide with, or be pre-created by, another user on a shared Linux /tmp.
//
// Callers cannot always delete what they create: MCP hosts may SIGKILL the process that
// owns the directory, and Windows does not deliver termination signals to Node. Each
// caller therefore sweeps its own prefix on start-up, removing this user's directories
// untouched for an hour. lstat (never stat) keeps a planted symlink from redirecting the
// delete, and the uid check leaves other users' directories on a shared /tmp alone.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STALE_TEMP_DIR_MS = 60 * 60 * 1000;

function createPrivateTempDir(prefix, { mkdtempSync = fs.mkdtempSync, tmpdir = os.tmpdir } = {}) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function removeDir(dir, { rmSync = fs.rmSync } = {}) {
  if (!dir) {
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temp directory is harmless and a later sweep reclaims it,
    // while a cleanup error must not mask the caller's real result.
  }
}

function sweepStaleTempDirs(prefix, {
  tmpdir = os.tmpdir,
  readdirSync = fs.readdirSync,
  lstatSync = fs.lstatSync,
  rmSync = fs.rmSync,
  now = Date.now,
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
  maxAgeMs = STALE_TEMP_DIR_MS,
} = {}) {
  let entries;
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const dir = path.join(tmpdir(), name);
    try {
      const stats = lstatSync(dir);
      const ownedByUs = uid === null || stats.uid === uid;
      if (stats.isDirectory() && ownedByUs && now() - stats.mtimeMs > maxAgeMs) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Another process may be sweeping the same directory; skip it.
    }
  }
}

// True only for a direct child of the OS temp directory whose name carries the prefix,
// so a caller-supplied path can never point a recursive delete anywhere else.
function isOwnTempDir(dir, prefix, { tmpdir = os.tmpdir } = {}) {
  if (typeof dir !== 'string' || !dir) {
    return false;
  }
  const resolved = path.resolve(dir);
  return path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith(prefix);
}

module.exports = {
  STALE_TEMP_DIR_MS,
  createPrivateTempDir,
  isOwnTempDir,
  removeDir,
  sweepStaleTempDirs,
};
