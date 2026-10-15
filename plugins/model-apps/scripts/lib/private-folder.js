'use strict';
// A folder, and a file in it, that only the current user can use.
//
// Why: the copy of the settings file that `pac solution import` is given (solution-settings.js importThroughPac) holds the values the maker filled in — a secret among them — and it is made in the temporary
// folder, which is the least private place there is: what the folder grants other accounts is INHERITED by everything made inside it, and a shared temporary folder (C:\Windows\Temp, a CI machine's, a
// remote desktop host's) grants a good deal. The file's own mode does not help on Windows, where Node reads 0o600 as "not read-only" and nothing else.
//
//   POSIX    the folder is set to 0700 and the file is created exclusively as 0600 (and set to it, which a umask cannot undo), and each is read back: its mode, its owner, and that it is not a link or a second
//            name of another file.
//   Windows  the folder's access list is REPLACED by one entry — full control for the current user, by SID — with `icacls`, and read back; the file made in it inherits that entry alone, and is read back too.
//            The folder's list is set before any file exists and the file's before any byte is written, so no value is ever in a place others can read. Everything is `whoami.exe` and `icacls.exe` from
//            the Windows folder's System32, started through the process runner (an .exe, no shell, never looked up on PATH or in the current folder).
//
// FAIL CLOSED: anything that cannot be set, or does not read back as it was set — a file system with no access lists (FAT), an `icacls` that cannot be started, an unexpected list — is an error with a `reason`,
// and nothing is written. The caller does not run pac then. The error's `reason` is the plugin's own words (a tool, a step, a number) and never a path or a value, so it can be shown as it is.
//
// Windows, step by step, and why it is three steps:
//   whoami /user /fo csv /nh              the current user's SID — never the account NAME, which is localised and not always unique
//   icacls <dir> /reset                   the folder's list becomes the one its parent hands down, every entry marked inherited. Measured on a Windows 11 machine joined to Azure AD: a folder made in
//                                         the user's temporary folder held SYSTEM, Administrators and the user as entries of its OWN (not marked inherited), which `/inheritance:r` alone leaves in place.
//   icacls <dir> /inheritance:r           removes every inherited entry and stops the folder inheriting: the list is empty and protected
//   icacls <dir> /grant:r *<SID>:(OI)(CI)F  full control for the current user, which a file made in the folder inherits (`*` makes icacls read the SID as a SID)
// See: https://learn.microsoft.com/windows-server/administration/windows-commands/icacls and https://learn.microsoft.com/windows-server/administration/windows-commands/whoami
const fs = require('node:fs');
const path = require('node:path');
const { spawnResultSync, envValue } = require('./process-runner.js');

// How long `whoami` or `icacls` may take. Both answer in milliseconds; this is the bound of a machine that is not answering, not an expected wait.
const TOOL_TIMEOUT_MS = 20 * 1000;

// What SDDL calls a service account's SID: `icacls /save` writes `SY` for S-1-5-18 where it writes the SID of an ordinary user in full. A run as a service (a CI agent as LocalSystem) is the current user then.
// See: https://learn.microsoft.com/windows/win32/secauthz/sid-strings
const SDDL_SERVICE_ALIASES = Object.freeze({ 'S-1-5-18': 'SY', 'S-1-5-19': 'LS', 'S-1-5-20': 'NS' });
// `FA` is "file all access", full control; the same right is also spelled as its number.
const FULL_CONTROL = /^(?:FA|0x1f01ff)$/i;

/** An error whose `reason` is the plugin's own words — a tool, a step, a number — so that it can be shown as it is. */
function privateError(reason) {
  const error = new Error(`could not make a private folder: ${reason}`);
  error.code = 'PRIVATE_FOLDER';
  error.reason = reason;
  return error;
}

/**
 * The SID in the output of `whoami /user /fo csv /nh` — one CSV line, the account's name and its SID, whatever the account (a domain's, a local one, an Azure AD one):
 *   "contoso\maker","S-1-12-1-1111111111-2222222222-3333333333-4444444444"
 *   "DESKTOP-ABC123\maker","S-1-5-21-1111111111-2222222222-3333333333-1001"
 * A quote inside the name is doubled (CSV). Anything but exactly that one line is not read — two lines, a header, a third column, text around it — so that nothing but a SID is ever given to icacls. Else null.
 */
function parseUserSid(output) {
  if (typeof output !== 'string') return null;
  const match = /^"(?:[^"]|"")*","(S-1-\d+(?:-\d+)+)"$/.exec(output.trim());
  return match ? match[1] : null;
}

/**
 * Why an access list is not the current user's alone — or null when it is. `text` is what `icacls <path> /save <file>` wrote: the object's name, then its DACL in SDDL (a SID is spelled in full, a well-known
 * account by a two-letter alias):
 *   solution-settings-AbC123
 *   D:PAI(A;OICI;FA;;;S-1-12-1-1111111111-2222222222-3333333333-4444444444)
 * `D:` flags `(` entries `)`: here P (protected: it takes nothing from its parent) and AI (auto-inherited, a marker the system keeps), then ONE entry — type A (allow), flags OICI (a file made in the folder and
 * a folder in it inherit it), rights FA (full control), the account. A file made in that folder has `D:AI(A;ID;FA;;;<SID>)`: the same entry, marked ID (inherited), with no flags to hand it down. Both are accepted
 * and nothing else is: another entry (SYSTEM, Administrators, the Users group), another account, less than full control, a deny entry, a folder that is not protected, a list that is missing — which grants
 * everyone access — or one in a shape this does not read (an entry with a condition in it).
 * See: https://learn.microsoft.com/windows/win32/secauthz/security-descriptor-string-format and https://learn.microsoft.com/windows/win32/secauthz/ace-strings
 * @param {{ folder: boolean }} what - a folder (its list must be protected, and its entry must be inherited by what is made in it) or a file made in one
 */
function ownerOnlyProblem(text, sid, { folder }) {
  // The name on the first line can itself begin with `D:` (a path), so a line is the list only when flags and entries follow.
  const line = String(text == null ? '' : text).split(/\r?\n/).map((l) => l.trim()).find((l) => /^D:[A-Z]*(?:\(|$)/.test(l));
  if (!line) return 'is missing';
  const list = /^D:([A-Z]*)((?:\([^()]*\))*)$/.exec(line);
  if (!list) return 'is in a form this check does not read';
  const [, controls, entries] = list;
  if (folder && !controls.includes('P')) return 'inherits access from its parent';
  const aces = [...entries.matchAll(/\(([^()]*)\)/g)].map((entry) => entry[1].split(';'));
  if (aces.length !== 1) return `has ${aces.length} entries, not one`;
  const [type, flags, rights, , , trustee = ''] = aces[0];
  if (type !== 'A') return 'has an entry that is not an allow entry';
  if (!FULL_CONTROL.test(rights)) return 'has an entry that is not full control';
  if (trustee.toUpperCase() !== sid.toUpperCase() && trustee.toUpperCase() !== SDDL_SERVICE_ALIASES[sid.toUpperCase()]) return "has an entry that is not the current user's";
  // The flags are two-letter codes: OI and CI hand an entry to the files and folders made inside, ID marks one that was handed down.
  const marks = flags.match(/../g) || [];
  const fine = folder ? marks.length === 2 && marks.includes('OI') && marks.includes('CI') : marks.every((mark) => mark === 'ID');
  if (!fine) return 'has an entry with inheritance flags it should not have';
  return null;
}

// ---- Windows -----------------------------------------------------------------------------------------------------------------------------------------

// Where the tools are looked up: the Windows folder's System32, and nowhere else. The Windows folder is what the environment names (SystemRoot, else windir); a PATH is never consulted, since a folder on it
// that a user can write is a place a program of that name can be put, and the current directory is never searched (process-runner.js resolves absolute PATH entries only). PATHEXT names the one extension that
// is wanted: an .exe, which is started directly, and not a batch file, which would need a shell.
function toolLookup(env) {
  const root = envValue(env, 'SystemRoot', 'win32') || envValue(env, 'windir', 'win32') || 'C:\\Windows';
  return { platform: 'win32', env: { PATH: path.win32.join(root, 'System32'), PATHEXT: '.EXE', SystemRoot: root } };
}

function windowsTools(deps) {
  const run = deps.run || spawnResultSync;
  const lookup = toolLookup(deps.env || process.env);
  return (name, args) => run(name, args, { encoding: 'utf8', timeout: TOOL_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, lookup);
}

// What a tool that did not do its work says: which tool and step, and the code or the status — never what the tool printed, which can name a path or an account.
function toolFailure(tool, step, result) {
  const what = step ? `${tool} ${step}` : tool;
  if (!result || result.error) return privateError(`${what} could not be started: ${(result && result.error && (result.error.code || result.error.name)) || 'Error'}`);
  return privateError(`${what} exited ${result.status}`);
}

function currentUserSid(tools) {
  const who = tools('whoami', ['/user', '/fo', 'csv', '/nh']);
  if (!who || who.error || who.status !== 0) throw toolFailure('whoami', '', who);
  const sid = parseUserSid(who.stdout);
  if (!sid) throw privateError("whoami did not give the current user's SID");
  return sid;
}

// `icacls /save` writes UTF-16 text — little endian, with no byte order mark as measured, though one is tolerated — which is decoded as such; text from anything else is read as UTF-8.
function decodeSaved(raw) {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString('utf16le');
  if (raw.length >= 2 && raw[1] === 0x00) return raw.toString('utf16le');
  return raw.toString('utf8');
}

let saves = 0;
// The access list of `target`, read back through `icacls /save` into a file in `scratch` (the private folder itself: a file made there inherits its list, and it is removed at once) and checked.
function verifyWindows(tools, sid, target, scratch, kind) {
  saves += 1;
  const saved = path.join(scratch, `access-list-${process.pid}-${saves}.tmp`);
  const done = tools('icacls', [target, '/save', saved]);
  if (!done || done.error || done.status !== 0) throw toolFailure('icacls', '/save', done);
  let text;
  try {
    text = decodeSaved(fs.readFileSync(saved));
  } catch (error) {
    throw privateError(`the ${kind}'s access list could not be read back: ${error.code || error.name}`);
  } finally {
    try {
      fs.rmSync(saved, { force: true });
    } catch {
      // It holds an access list and nothing else, and goes with the folder.
    }
  }
  const problem = ownerOnlyProblem(text, sid, { folder: kind === 'folder' });
  if (problem) throw privateError(`the ${kind}'s access list ${problem}`);
}

function lockDownWindows(dir, deps) {
  const tools = windowsTools(deps);
  const sid = currentUserSid(tools);
  for (const step of [['/reset'], ['/inheritance:r'], ['/grant:r', `*${sid}:(OI)(CI)F`]]) {
    const done = tools('icacls', [dir, ...step]);
    if (!done || done.error || done.status !== 0) throw toolFailure('icacls', step[0], done);
  }
  verifyWindows(tools, sid, dir, dir, 'folder');
  return { verifyFile: (file) => verifyWindows(tools, sid, file, dir, 'file') };
}

// ---- POSIX ---------------------------------------------------------------------------------------------------------------------------------------------

function posixUser(deps) {
  const getuid = Object.prototype.hasOwnProperty.call(deps, 'getuid') ? deps.getuid : process.getuid;
  return typeof getuid === 'function' ? getuid() : undefined;
}

function lockDownPosix(dir, deps) {
  const fsx = deps.fs || fs;
  const uid = posixUser(deps);
  // Looked at BEFORE anything is changed: chmod follows a link, and would change the permissions of what the link points at.
  const before = fsx.lstatSync(dir);
  if (before.isSymbolicLink() || !before.isDirectory()) throw privateError('the folder is not a plain folder');
  fsx.chmodSync(dir, 0o700);
  const after = fsx.lstatSync(dir);
  if (after.isSymbolicLink() || !after.isDirectory()) throw privateError('the folder is not a plain folder');
  if ((after.mode & 0o777) !== 0o700) throw privateError("the folder's permissions are not 0700 after they were set");
  if (uid !== undefined && after.uid !== uid) throw privateError("the folder is not the current user's");
  return {
    verifyFile: (file, fd) => {
      // `mode` of openSync is subject to the umask, which can only take bits away: setting the mode on the descriptor makes the file exactly 0600 whatever it was.
      fsx.fchmodSync(fd, 0o600);
      const made = fsx.fstatSync(fd);
      if (!made.isFile()) throw privateError('the file is not a plain file');
      if ((made.mode & 0o777) !== 0o600) throw privateError("the file's permissions are not 0600 after they were set");
      if (uid !== undefined && made.uid !== uid) throw privateError("the file is not the current user's");
      if (made.nlink !== 1) throw privateError('the file has another name');
    },
  };
}

// ---- the two entry points ---------------------------------------------------------------------------------------------------------------------------

/**
 * Makes `dir` — a folder the caller has just made — the current user's alone, and checks that it is. Returns what is needed to check a file made in it. Throws an error with `code` 'PRIVATE_FOLDER' and a
 * `reason` when it cannot be done.
 * @param {string} dir
 * @param {object} [deps] - test seams: `platform`, `run` (the process runner's spawnResultSync), `env`, `fs`, `getuid`
 */
function lockDownFolder(dir, deps = {}) {
  return (deps.platform || process.platform) === 'win32' ? lockDownWindows(dir, deps) : lockDownPosix(dir, deps);
}

/**
 * Writes `bytes` to `<dir>/<name>`, a file nobody but the current user can read: the folder is locked down and read back first, the file is created EXCLUSIVELY (`wx`: a name that is already there — a file, a
 * link — is never written through) and EMPTY, its permissions or access list are read back, and only then are the bytes written. So no value is ever in a place others can read, and a failure at any step leaves
 * no byte behind. Returns the file's path. The caller removes the folder, however this ends.
 * @param {string} dir - a folder the caller has just made
 * @param {string} name - a plain file name
 * @param {Buffer|string} bytes
 * @param {object} [deps] - test seams: see lockDownFolder
 */
function createPrivateFile(dir, name, bytes, deps = {}) {
  if (typeof name !== 'string' || !/^[^\\/\u0000]+$/.test(name) || name === '.' || name === '..') throw privateError('the file name is not a plain file name');
  const fsx = deps.fs || fs;
  const folder = lockDownFolder(dir, deps);
  const file = path.join(dir, name);
  const fd = fsx.openSync(file, 'wx', 0o600);
  try {
    folder.verifyFile(file, fd);
    fsx.writeFileSync(fd, bytes);
  } finally {
    fsx.closeSync(fd);
  }
  return file;
}

module.exports = { createPrivateFile, lockDownFolder, parseUserSid, ownerOnlyProblem };
