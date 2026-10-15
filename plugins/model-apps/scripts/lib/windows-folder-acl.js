'use strict';
// Who can change a folder on Windows — read from its access list, because Node cannot say.
//
// WHY. lib/temp-workspace.js keeps the plugin's throwaway workspaces in one folder of its own in the temp folder, and the first run to find that folder already there uses it and
// sweeps it. On POSIX the folder is trusted when `lstat` says it is a folder this user owns that nobody else can write to (uid and mode). Windows gives `fs.stat` no owner and no
// permissions (`uid` is 0, the mode is made from the read-only attribute), so the same check there would trust any folder anybody made: in a temp folder that is shared (a server, a build
// agent, `TEMP=C:\Temp`) another user could make the folder first, and put a workspace of the next run, and what the next sweep removes, in a place that is theirs.
//
// HOW. The folder's access list (its DACL) is saved with `icacls <folder> /save <file>` — Windows' own tool, so nothing is installed — which writes it as SDDL, in UTF-16:
//     parent
//     D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1001)
// Each entry is `(type;flags;rights;object guid;inherited object guid;trustee)`, and the trustee is a SID, or a two-letter alias for a well-known one (SY: the system, BA: the
// administrators) — in every language, which the names `icacls` prints are not. The user's own SID is what `whoami /user` prints (the machine's own Administrator and Guest accounts are
// the exception: SDDL writes them as the aliases LA and LG). The folder is private when every entry that GRANTS a
// right to add to the folder, remove from it, delete it, change who may, or take it over names the user, the system, the administrators or the installer service of Windows;
// everything else — Everyone, Users, another user — is a writer that is not trusted.
// https://learn.microsoft.com/windows/win32/secauthz/security-descriptor-string-format · https://learn.microsoft.com/windows/win32/secauthz/ace-strings ·
// https://learn.microsoft.com/windows/win32/secauthz/sid-strings · https://learn.microsoft.com/windows-server/administration/windows-commands/icacls
//
// ONE-SIDED, like everything that decides whether the plugin may remove something: what cannot be read, run or understood is NOT private. A caller that is told no uses the ordinary
// temp folder, as it did before it had a folder of its own, so a "no" costs a courtesy to the next run and never fails one. One "no" is marked `unreadable`: icacls ran and could not save
// the list — the folder is being removed by another process (Windows marks it for deletion and it goes when the last handle on it closes; until then it cannot be opened), which says
// nothing about who may change it. A caller that can wait for the folder to go asks again (lib/temp-workspace.js); one that cannot takes it as the "no" it is.
//
// WHAT THIS DOES NOT SEE. The owner of a folder can always change its list, and `icacls` prints no owner (a PowerShell start would, at a cost of seconds). A folder made by another user
// in a shared temp folder is given its creator's entry by inheritance (CREATOR OWNER), which names a writer that is not trusted — the case this exists for; one whose owner then
// removed their own entry is not seen. Rights to READ are not looked at either: what is read is a workspace a run made there, and a folder others can only read is one they could read
// in the temp folder before this module.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnResultSync, withPathFirst, windowsCmd } = require('./process-runner.js');

// Access rights (https://learn.microsoft.com/windows/win32/fileio/file-security-and-access-rights): on a FOLDER, FILE_ADD_FILE (0x2) adds a file and FILE_ADD_SUBDIRECTORY (0x4) a folder,
// FILE_DELETE_CHILD (0x40) removes what is inside, DELETE (0x10000) removes the folder, WRITE_DAC (0x40000) changes who may do what, WRITE_OWNER (0x80000) takes it over; the generic
// GENERIC_WRITE (0x40000000) and GENERIC_ALL (0x10000000) stand for sets that include them. FILE_WRITE_ATTRIBUTES and FILE_WRITE_EA change nothing that a workspace holds.
const WRITE_RIGHTS = 0x2 | 0x4 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;

// The rights an SDDL entry names by two letters, one after another (`FRFX`): https://learn.microsoft.com/windows/win32/secauthz/ace-strings
const RIGHT_CODES = {
  GR: 0x80000000, GW: 0x40000000, GX: 0x20000000, GA: 0x10000000,
  RC: 0x20000, SD: 0x10000, WD: 0x40000, WO: 0x80000,
  FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
};

// The aliases of the well-known SIDs that have one for every machine (https://learn.microsoft.com/windows/win32/secauthz/sid-strings). Only SY and BA are trusted; the rest are here so that a
// reason names a SID that means something. An alias that is not here (DA, the domain's administrators: relative to a domain) is kept as written.
const ALIASES = {
  AN: 'S-1-5-7', AU: 'S-1-5-11', BA: 'S-1-5-32-544', BG: 'S-1-5-32-546', BO: 'S-1-5-32-551', BU: 'S-1-5-32-545', CG: 'S-1-3-1', CO: 'S-1-3-0', IU: 'S-1-5-4', LS: 'S-1-5-19',
  NS: 'S-1-5-20', NU: 'S-1-5-2', OW: 'S-1-3-4', PO: 'S-1-5-32-550', PS: 'S-1-5-10', PU: 'S-1-5-32-547', RC: 'S-1-5-12', RD: 'S-1-5-32-555', RE: 'S-1-5-32-573', SO: 'S-1-5-32-549',
  SU: 'S-1-5-6', SY: 'S-1-5-18', WD: 'S-1-1-0', WR: 'S-1-5-33',
};
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
// The service account that installs and updates Windows itself (NT SERVICE\TrustedInstaller), which owns what is in the Windows folder.
const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';

// Entries that grant nothing: a denial, an audit or alarm, a label, an attribute, a scoped policy. Every other type is read as a grant — a type that is not known is not trusted.
const NON_GRANTING = new Set(['D', 'OD', 'XD', 'ZD', 'AU', 'AL', 'OU', 'OL', 'XU', 'ML', 'RA', 'SP']);

// A machine's own Administrator and Guest accounts (RID 500 and 501) are written in SDDL as `LA` and `LG`, never as the SID. The account a virtual machine or a CI runner is used
// through is often the built-in Administrator, renamed: `whoami` answers S-1-5-21-…-500, and a list that names the user reads back `LA`. An alias stands for the account it names and no
// other, so it is the user's own only for the user whose account that is (a domain's Administrator is written in full, and an Azure AD user's SID is not an S-1-5-21 one).
const OWN_ACCOUNT_ALIASES = [['LA', /^S-1-5-21-\d+-\d+-\d+-500$/], ['LG', /^S-1-5-21-\d+-\d+-\d+-501$/]];

function parseRights(text) {
  if (text === '') return 0;
  if (/^0x[0-9a-f]+$/i.test(text)) return Number.parseInt(text, 16);
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^(?:[A-Z]{2})+$/.test(text)) return null;
  let mask = 0;
  for (const code of text.match(/../g)) {
    if (!Object.prototype.hasOwnProperty.call(RIGHT_CODES, code)) return null;
    mask |= RIGHT_CODES[code];
  }
  return mask;
}

function parseTrustee(text) {
  if (/^S-1-\d+(?:-\d+)+$/i.test(text)) return text.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(ALIASES, text)) return ALIASES[text];
  return /^[A-Z]{2}$/.test(text) ? text : null;
}

// One entry's text, without its parentheses: `A;OICI;FA;;;SY`, or `XA;;FA;;;WD;(@User.Title=="PM")` for a conditional one, which goes on after its sixth field with an expression that has parentheses
// of its own — only the first six fields are read. → { type, flags, mask, trustee }, or null.
function parseAce(body) {
  const fields = body.split(';');
  if (fields.length < 6) return null;
  const [type, flags, rights, , , trusteeText] = fields;
  const mask = parseRights(rights);
  const trustee = parseTrustee(trusteeText);
  if (!/^[A-Z]{1,2}$/.test(type) || !/^(?:[A-Z]{2})*$/.test(flags) || mask === null || trustee === null) return null;
  return { type, flags, mask, trustee };
}

/**
 * The access list in SDDL — `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` — as its entries. Strict: text that has anything but a list in it, an entry cut short or one that is not understood,
 * a list with no access control at all (`D:NO_ACCESS_CONTROL`, which gives everyone everything) are all null, and null means "cannot tell".
 * @returns {{ aces: Array<{ type: string, flags: string, mask: number, trustee: string }> } | null}
 */
function parseDacl(text) {
  const sddl = String(text).trim();
  if (!sddl.startsWith('D:')) return null;
  // After `D:` come the list's flags — P (protected), AI (auto-inherited), AR (auto-inherit required) — and then its entries, each in parentheses.
  const flags = /^(?:NO_ACCESS_CONTROL|P|AI|AR)*/.exec(sddl.slice(2))[0];
  if (flags.includes('NO_ACCESS_CONTROL')) return null;
  const aces = [];
  let i = 2 + flags.length;
  while (i < sddl.length) {
    if (sddl[i] !== '(') return null;
    let depth = 0;
    let quoted = false;
    let j = i;
    for (; j < sddl.length; j += 1) {
      const c = sddl[j];
      if (c === '"') quoted = !quoted;
      else if (!quoted && c === '(') depth += 1;
      else if (!quoted && c === ')') { depth -= 1; if (depth === 0) break; }
    }
    if (depth !== 0) return null;
    const ace = parseAce(sddl.slice(i + 1, j));
    if (!ace) return null;
    aces.push(ace);
    i = j + 1;
  }
  return { aces };
}

/**
 * Who, besides the user, the system, the administrators and the installer service, an access list lets add to a folder, remove from it, delete it, or change who may or who owns it.
 * Entries that apply to what is INSIDE the folder only (inherit-only) and entries that grant nothing are not looked at.
 * @returns {string[]} the trustees, as SIDs where they have one, each once
 */
function foreignWriters(aces, userSid) {
  const user = String(userSid).toUpperCase();
  const trusted = new Set([SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER, user]);
  for (const [alias, account] of OWN_ACCOUNT_ALIASES) if (account.test(user)) trusted.add(alias);
  const writers = [];
  for (const ace of aces) {
    if (NON_GRANTING.has(ace.type)) continue;
    if ((ace.flags.match(/../g) || []).includes('IO')) continue;
    if ((ace.mask & WRITE_RIGHTS) === 0) continue;
    if (trusted.has(ace.trustee) || writers.includes(ace.trustee)) continue;
    writers.push(ace.trustee);
  }
  return writers;
}

// `icacls /save` writes UTF-16 (little endian, with no byte-order mark in the versions measured, with one in others); the list is the line that begins `D:`.
function savedDacl(buffer) {
  for (const text of [buffer.toString('utf16le'), buffer.toString('latin1')]) {
    const lines = text.replace(/^\uFEFF|^\u00ff\u00fe/, '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('D:'));
    if (lines.length === 1) return lines[0];
  }
  return null;
}

function judge(folder, deps) {
  const run = deps.run || spawnResultSync;
  const env = deps.env || process.env;
  const options = { encoding: 'utf8', timeout: 10000, windowsHide: true };
  // icacls and whoami live in System32, beside cmd.exe, and are looked up with that folder FIRST on PATH, as lib/process-runner.js looks up taskkill: a PATH without it (a service, a
  // stripped-down shell) would find nothing, and an earlier folder that the user can write to could stand in for the program — and be believed about who may write to a folder.
  const lookup = { env: withPathFirst(env, path.win32.dirname(windowsCmd(env)), 'win32') };
  // `whoami /user /fo csv /nh` → "contoso\maker","S-1-5-21-1111111111-2222222222-3333333333-1001" (the name is localized or not; the SID is a SID).
  const who = run('whoami', ['/user', '/fo', 'csv', '/nh'], options, lookup);
  const sid = who && !who.error && who.status === 0 ? /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(String(who.stdout)) : null;
  if (!sid) return { ok: false, reason: 'the user\'s SID could not be read (whoami /user)' };
  // The list is saved beside the folder, in the folder that holds it (the temp folder, for the plugin's): a few hundred bytes, read and removed at once.
  const file = path.join(deps.saveIn || path.dirname(folder), `power-platform-skills-acl-${process.pid}-${crypto.randomBytes(6).toString('hex')}.txt`);
  try {
    // icacls started and could not save the list: the folder is being removed by another process (Windows marks it for deletion, and it goes when the last handle on it closes — until
    // then it cannot be opened), or is gone, or is somebody's. That is no answer about who may change it, so the answer says so (`unreadable`) and the caller — which can wait for the
    // folder to go and make it again — asks again. A program that could not be started at all is not that: it is no one's doing but the system's, and the answer stays no.
    const saved = run('icacls', [folder, '/save', file], options, lookup);
    if (!saved || saved.error) return { ok: false, reason: 'its access list could not be saved (icacls could not be run)' };
    if (saved.status !== 0) return { ok: false, unreadable: true, reason: 'its access list could not be saved (icacls /save)' };
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      return { ok: false, unreadable: true, reason: 'its access list could not be read back' };
    }
    const line = savedDacl(buffer);
    const dacl = line === null ? null : parseDacl(line);
    if (!dacl) return { ok: false, reason: 'its access list is not in a form that is understood' };
    const writers = foreignWriters(dacl.aces, sid[1]);
    return writers.length === 0
      ? { ok: true, reason: 'only this user, the system and the administrators can change it' }
      : { ok: false, reason: `${writers.join(', ')} can add to it, remove from it or take it over` };
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* a few hundred bytes of an access list in the temp folder */ }
  }
}

/**
 * Whether only this user, the system and the administrators can change `folder`. Never throws: whatever cannot be read, run or understood is `{ ok: false }`.
 * `unreadable: true` marks the one kind of "no" that may not stay one: the list could not be got at all (the folder is being removed, most likely), which says nothing about the folder.
 * @param {string} folder
 * @param {object} [deps] test seams: run (the process runner's spawnResultSync), env, saveIn (the folder the saved list goes in: the folder's own parent)
 * @returns {{ ok: boolean, reason: string, unreadable?: boolean }}
 */
function windowsFolderIsPrivate(folder, deps = {}) {
  try {
    return judge(folder, deps);
  } catch (error) {
    return { ok: false, reason: `its access list could not be read: ${(error && error.message) || error}` };
  }
}

module.exports = { WRITE_RIGHTS, parseDacl, foreignWriters, windowsFolderIsPrivate };
