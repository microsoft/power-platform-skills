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
//   icacls <path> /save <file>            the list read back, as SDDL. Its one entry must be the user's: the SID in full, or an alias of the SAME SID. SY, LS and NS are the same SID everywhere; LA and LG, the
//                                         machine's own Administrator and Guest, are accepted only when the machine itself writes the user's SID that way — it is asked then, with a file that holds
//                                         nothing (`spellingOf`) — so another domain's Administrator, which has the same RID, is not taken for it.
// See: https://learn.microsoft.com/windows-server/administration/windows-commands/icacls and https://learn.microsoft.com/windows-server/administration/windows-commands/whoami
const fs = require('node:fs');
const path = require('node:path');
const { spawnResultSync, envValue } = require('./process-runner.js');

// How long `whoami` or `icacls` may take. Both answer in milliseconds; this is the bound of a machine that is not answering, not an expected wait.
const TOOL_TIMEOUT_MS = 20 * 1000;

// What SDDL calls an account: `icacls /save` writes the SID of an ordinary user in full, and a well-known account by a two-letter alias. An alias is compared as the SID it stands for, never by its looks:
//   SY, LS, NS  the three service accounts (a CI agent running as LocalSystem is the current user then): S-1-5-18, S-1-5-19 and S-1-5-20, the same SID on every machine.
//   LA, LG      "Local administrator" and "Local guest": the RIDs 500 and 501 under the SID of the machine's OWN account domain (S-1-5-21-a-b-c-500). The machine says what that domain is, and the RID proves
//               nothing — every domain, and every other machine, has an Administrator with the RID 500 and a Guest with the RID 501, and `icacls` writes those in full. So LA is the current user only
//               when the machine itself writes the user's SID as LA, which it is asked (`spellingOf`: the SID is granted to a file that holds nothing, and the list of that file is read back).
// The second kind matters: the administrator account a virtual machine or a CI runner is made with IS the built-in Administrator, renamed, so `whoami /user` answers its SID and the access list reads back `LA`.
// See: https://learn.microsoft.com/windows/win32/secauthz/sid-strings and https://learn.microsoft.com/windows/win32/secauthz/well-known-sids
const SDDL_SERVICE_ALIASES = Object.freeze({ SY: 'S-1-5-18', LS: 'S-1-5-19', NS: 'S-1-5-20' });
const SDDL_MACHINE_ALIASES = Object.freeze({ LA: 500, LG: 501 });
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

// Whether `trustee`, as an entry of an access list writes it, is the account `sid`. `machineSpelling(sid)` answers how the machine writes that SID — or null when it cannot be asked, which is a "no".
function namesUser(trustee, sid, machineSpelling) {
  const name = trustee.toUpperCase();
  const user = sid.toUpperCase();
  if (name === user) return true;
  if (hasOwn(SDDL_SERVICE_ALIASES, name)) return SDDL_SERVICE_ALIASES[name] === user;
  if (!hasOwn(SDDL_MACHINE_ALIASES, name)) return false;
  // Only a RID of that kind can be what LA or LG stands for, and then only the machine can say whether this one is: nothing is asked of it for an account that cannot be.
  const account = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/.exec(user);
  if (!account || Number(account[1]) !== SDDL_MACHINE_ALIASES[name]) return false;
  const written = typeof machineSpelling === 'function' ? machineSpelling(sid) : null;
  return typeof written === 'string' && written.toUpperCase() === name;
}
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
 * The DACL in what `icacls <path> /save <file>` wrote — the flags and the entries, each entry split into its fields — or `{ problem }` when there is none, or it is in a shape this does not read.
 * The name on the first line can itself begin with `D:` (a path), so a line is the list only when flags and entries follow.
 */
function readDacl(text) {
  const line = String(text == null ? '' : text).split(/\r?\n/).map((l) => l.trim()).find((l) => /^D:[A-Z]*(?:\(|$)/.test(l));
  if (!line) return { problem: 'is missing' };
  const list = /^D:([A-Z]*)((?:\([^()]*\))*)$/.exec(line);
  if (!list) return { problem: 'is in a form this check does not read' };
  const [, controls, entries] = list;
  return { controls, aces: [...entries.matchAll(/\(([^()]*)\)/g)].map((entry) => entry[1].split(';')) };
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
 * The account is the user's SID in full, or an alias of the SID itself (SY, LS, NS) — or LA and LG, which only the machine can say the SID of: they are the user's only when `machineSpelling(sid)`, which
 * answers how this machine writes the user's SID, gives that alias. Where it cannot be asked an alias of that kind is not accepted.
 * See: https://learn.microsoft.com/windows/win32/secauthz/security-descriptor-string-format and https://learn.microsoft.com/windows/win32/secauthz/ace-strings
 * @param {{ folder: boolean, machineSpelling?: (sid: string) => (string|null) }} what - a folder (its list must be protected, and its entry must be inherited by what is made in it) or a file made in one
 */
function ownerOnlyProblem(text, sid, { folder, machineSpelling }) {
  const dacl = readDacl(text);
  if (dacl.problem) return dacl.problem;
  if (folder && !dacl.controls.includes('P')) return 'inherits access from its parent';
  if (dacl.aces.length !== 1) return `has ${dacl.aces.length} entries, not one`;
  const [type, flags, rights, , , trustee = ''] = dacl.aces[0];
  if (type !== 'A') return 'has an entry that is not an allow entry';
  if (!FULL_CONTROL.test(rights)) return 'has an entry that is not full control';
  if (!namesUser(trustee, sid, machineSpelling)) return "has an entry that is not the current user's";
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
// The access list of `target`, read back through `icacls /save` into a file in `scratch` (the private folder itself: a file made there inherits its list, and it is removed at once). Answers its SDDL text.
function savedAccessList(tools, target, scratch, what) {
  saves += 1;
  const saved = path.join(scratch, `access-list-${process.pid}-${saves}.tmp`);
  const done = tools('icacls', [target, '/save', saved]);
  if (!done || done.error || done.status !== 0) throw toolFailure('icacls', '/save', done);
  try {
    return decodeSaved(fs.readFileSync(saved));
  } catch (error) {
    throw privateError(`the ${what}'s access list could not be read back: ${error.code || error.name}`);
  } finally {
    try {
      fs.rmSync(saved, { force: true });
    } catch {
      // It holds an access list and nothing else, and goes with the folder.
    }
  }
}

// The probe's list names the account that was asked about. When that is not the current user — only a caller that asks about another account can have it so; the check itself asks about the user's own — the user has
// no right to delete the file, though its owner can always rewrite the list: `/reset` gives the file back the list its folder hands down, which is the user's, and then it is removed.
function removeProbe(tools, probe) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.rmSync(probe, { force: true });
      return;
    } catch {
      if (attempt === 0) {
        try {
          tools('icacls', [probe, '/reset']);
        } catch {
          // The second attempt says whether it worked.
        }
      }
    }
  }
  // It holds nothing, and goes with the folder.
}

// How this machine writes the account `sid` in an access list, or null when what it writes cannot be compared. The machine is asked the way the list that is being checked was made: the SID is granted —
// `/grant:r *<SID>`, on a list that was reset and stripped so that it holds that one entry — to a file in `scratch` that holds nothing, and the list of that file is read back. What `icacls /save` writes for
// the one entry is the machine's own spelling of the SID, from the same conversion that wrote the list being checked: `LA` for the SID of this machine's own Administrator, and the SID in full for another
// domain's, whose Administrator has the same RID. `icacls` refuses a SID that no account of this machine or its domain maps to (exit 1332, "no mapping between account names and security IDs was done", measured),
// which is the tool's failure like any other: nothing is then known, and the copy is not made. The file goes however this ends; `scratch` is the private folder, so what it briefly holds is seen by nobody else.
function accountSpelling(tools, sid, scratch) {
  if (typeof sid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(sid)) throw privateError('the account to ask the machine about is not a SID');
  saves += 1;
  const probe = path.join(scratch, `access-list-probe-${process.pid}-${saves}.tmp`);
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' });
  } catch (error) {
    throw privateError(`the probe file could not be made: ${error.code || error.name}`);
  }
  try {
    for (const step of [['/reset'], ['/inheritance:r'], ['/grant:r', `*${sid}:F`]]) {
      const done = tools('icacls', [probe, ...step]);
      if (!done || done.error || done.status !== 0) throw toolFailure('icacls', `${step[0]} on the probe`, done);
    }
    const dacl = readDacl(savedAccessList(tools, probe, scratch, 'probe'));
    if (dacl.problem || dacl.aces.length !== 1) return null;
    const [type, , rights, , , trustee = ''] = dacl.aces[0];
    return type === 'A' && FULL_CONTROL.test(rights) && trustee ? trustee : null;
  } finally {
    removeProbe(tools, probe);
  }
}

// The access list of `target`, read back and checked: the current user's alone, or the reason it is not.
function verifyWindows(tools, sid, target, scratch, kind, machineSpelling) {
  const text = savedAccessList(tools, target, scratch, kind);
  const problem = ownerOnlyProblem(text, sid, { folder: kind === 'folder', machineSpelling });
  if (problem) throw privateError(`the ${kind}'s access list ${problem}`);
}

function lockDownWindows(dir, deps) {
  const tools = windowsTools(deps);
  const sid = currentUserSid(tools);
  for (const step of [['/reset'], ['/inheritance:r'], ['/grant:r', `*${sid}:(OI)(CI)F`]]) {
    const done = tools('icacls', [dir, ...step]);
    if (!done || done.error || done.status !== 0) throw toolFailure('icacls', step[0], done);
  }
  // The machine is asked how it writes the user's SID only when a list names the user by LA or LG — and once, whichever of the folder's list and the file's it was.
  let spelled;
  const machineSpelling = () => {
    if (spelled === undefined) spelled = accountSpelling(tools, sid, dir);
    return spelled;
  };
  verifyWindows(tools, sid, dir, dir, 'folder', machineSpelling);
  return { verifyFile: (file) => verifyWindows(tools, sid, file, dir, 'file', machineSpelling) };
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

/**
 * How this machine writes the account `sid` in an access list — `LA` for the SID of its own Administrator, the SID in full for another domain's — which is what the check of a list that names the user by an alias
 * asks (ownerOnlyProblem's `machineSpelling`). Windows only: the machine is asked through `icacls`, with a file that holds nothing, made in `scratch` — a folder of the caller's — and removed. Null when what it writes
 * cannot be compared; throws an error with `code` 'PRIVATE_FOLDER' and a `reason` when the machine cannot be asked.
 * @param {string} sid
 * @param {string} scratch
 * @param {object} [deps] - test seams: `run` (the process runner's spawnResultSync), `env`
 * @returns {string|null}
 */
function spellingOf(sid, scratch, deps = {}) {
  return accountSpelling(windowsTools(deps), sid, scratch);
}

module.exports = { createPrivateFile, lockDownFolder, parseUserSid, ownerOnlyProblem, spellingOf };
