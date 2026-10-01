'use strict';

// Where and how a captured sign-in session (Playwright storage state) is stored.
//
// The storage state holds live session cookies for the user's site. It is written
// only to a fresh private temp directory (mkdtemp, file mode 0600), never to the
// project, so it cannot be committed by accident. Deletion is restricted to files
// that match this exact layout so a mistyped --remove path cannot delete anything
// else on the machine.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIR_PREFIX = 'pp-a11y-auth-';
const FILE_NAME = 'storage-state.json';

function createAuthStatePath({ tmpdir = os.tmpdir(), mkdtemp = fs.mkdtempSync } = {}) {
  const dir = mkdtemp(path.join(tmpdir, DIR_PREFIX));
  return path.join(dir, FILE_NAME);
}

// Creates the session file exclusively ('wx' = O_CREAT | O_EXCL) inside a fresh
// mkdtemp directory and returns the open descriptor. Exclusive creation fails instead
// of following a path or link that already exists, so a planted file can never
// receive the cookies (AGENTS.md "Secret temporary files"). Later refreshes write
// through this descriptor and never reopen the path.
function openAuthStateFile({ tmpdir = os.tmpdir(), mkdtemp = fs.mkdtempSync, open = fs.openSync } = {}) {
  const file = createAuthStatePath({ tmpdir, mkdtemp });
  const fd = open(file, 'wx', 0o600);
  return { file, fd };
}

function isManagedAuthStatePath(file, { tmpdir = os.tmpdir() } = {}) {
  if (typeof file !== 'string' || !file) return false;
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);
  // Compare against the real tmpdir: on macOS os.tmpdir() is a symlink
  // (/var -> /private/var), so a path produced by mkdtemp may differ textually.
  const roots = new Set([path.resolve(tmpdir)]);
  try { roots.add(fs.realpathSync(tmpdir)); } catch { /* tmpdir always exists in practice */ }
  return path.basename(resolved) === FILE_NAME
    && path.basename(dir).startsWith(DIR_PREFIX)
    && roots.has(path.dirname(dir));
}

// Rewrites the whole file through the descriptor from openAuthStateFile(): truncate,
// then write from offset 0, looping because writeSync may write fewer bytes than asked.
// Mode 0600 was set at exclusive creation; chmod is effectively a no-op on Windows,
// where the per-user temp directory ACL applies.
function writeAuthState(fd, state, { ftruncate = fs.ftruncateSync, write = fs.writeSync } = {}) {
  if (typeof fd !== 'number') throw new TypeError('writeAuthState needs the descriptor from openAuthStateFile()');
  const data = Buffer.from(JSON.stringify(state), 'utf8');
  ftruncate(fd, 0);
  let offset = 0;
  while (offset < data.length) {
    offset += write(fd, data, offset, data.length - offset, offset);
  }
}

// Counts only — the report and console must never contain cookie values.
function summarizeAuthState(state) {
  const cookies = (state && state.cookies) || [];
  const origins = (state && state.origins) || [];
  return {
    cookies: cookies.length,
    domains: [...new Set(cookies.map((c) => c.domain))].length,
    originsWithStorage: origins.length,
  };
}

function removeAuthState(file, opts = {}) {
  if (!isManagedAuthStatePath(file, opts)) {
    throw new Error(`Refusing to remove ${file}: not a storage state created by a11y-capture-auth.js`);
  }
  const resolved = path.resolve(file);
  fs.rmSync(path.dirname(resolved), { recursive: true, force: true });
}

module.exports = {
  DIR_PREFIX,
  FILE_NAME,
  createAuthStatePath,
  isManagedAuthStatePath,
  openAuthStateFile,
  removeAuthState,
  summarizeAuthState,
  writeAuthState,
};
