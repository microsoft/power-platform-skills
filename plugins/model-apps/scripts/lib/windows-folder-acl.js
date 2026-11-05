'use strict';
// Who can change a folder on Windows — read from its access list, because Node cannot say — and the making of a folder that only this user can.
//
// WHY. lib/temp-workspace.js keeps the plugin's throwaway workspaces in one folder of its own in the temp folder, and the first run to find that folder already there uses it and
// sweeps it. On POSIX the folder is trusted when `lstat` says it is a folder this user owns that nobody else can write to (uid and mode). Windows gives `fs.stat` no owner and no
// permissions (`uid` is 0, the mode is made from the read-only attribute), so the same check there would trust any folder anybody made: in a temp folder that is shared (a server, a build
// agent, `TEMP=C:\Temp`) another user could make the folder first, and put a workspace of the next run, and what the next sweep removes, in a place that is theirs. And what is made INSIDE
// the folder — each workspace, each owner record, which the sweep believes — takes the access list of the folder by inheritance, so a grant to someone else that only applies to what is
// inside the folder (an inherit-only entry) is as much a grant over every record as one on the folder itself.
//
// HOW A FOLDER IS JUDGED (windowsFolderIsPrivate). Its access list (its DACL) is saved with `icacls <folder> /save <file>` — Windows' own tool, so nothing is installed — which writes it as SDDL, in UTF-16:
//     parent
//     D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-21-1111111111-2222222222-3333333333-1001)
// Each entry is `(type;flags;rights;object guid;inherited object guid;trustee)`, and the trustee is a SID, or a two-letter alias for a well-known one (SY: the system, BA: the
// administrators) — in every language, which the names `icacls` prints are not. The user's own SID is what `whoami /user` prints (the machine's own Administrator and Guest accounts are
// the exception: SDDL writes them as the aliases LA and LG). The list is private when NO entry — an inherit-only one included — grants a right to add to the folder, remove from it,
// delete it, write its attributes or extended attributes, change who may, or take it over to anyone but the user, the system or the administrators;
// everything else — Everyone, Users, another user, CREATOR OWNER — is a writer that is not trusted. And the folder must BELONG to the user (or to the administrators, whom the list trusts anyway
// — a folder made by a process that runs elevated is theirs by default): whoever owns a folder can rewrite its list whatever it says now, so a list that names only the user does not
// make a folder the user's if somebody else owns it.
// https://learn.microsoft.com/windows/win32/secauthz/security-descriptor-string-format · https://learn.microsoft.com/windows/win32/secauthz/ace-strings ·
// https://learn.microsoft.com/windows/win32/secauthz/sid-strings · https://learn.microsoft.com/windows-server/administration/windows-commands/icacls ·
// https://learn.microsoft.com/windows/win32/secauthz/ace-inheritance-rules · https://learn.microsoft.com/windows/win32/fileio/file-security-and-access-rights
//
// THE OWNER is read only once the list has passed, and with PowerShell: `icacls /save` stores the access list and nothing else (the saved file holds the `D:` line, no owner), `icacls` has no
// way to PRINT an owner, and `dir /q` prints a name in the language of the machine. A PowerShell start costs half a second or more, which is why it is the last thing asked, why the answer is
// remembered by the caller for the life of the process, and why a folder this process makes itself is never asked about. The answer is a SID, not a name.
//
// HOW A FOLDER IS MADE PRIVATE (makeWindowsFolderPrivate). A folder that this process has just made takes whatever the temp folder it is in gives it, and Node's `mode` means nothing on Windows. Before
// anything is put in it, its list is REPLACED: `icacls <folder> /inheritance:r /grant:r *<user>:(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F` — inheritance removed, and full control for the
// user, the system and the administrators, inherited by what is made inside — and then READ BACK (the same save and the same parse) and checked: protected, and nothing in it but those three.
//
// ONE-SIDED, like everything that decides whether the plugin may remove something: what cannot be read, run or understood is NOT private. A caller that is told no uses the ordinary
// temp folder, as it did before it had a folder of its own, so a "no" costs a courtesy to the next run and never fails one. One "no" is marked `unreadable`: icacls ran and could not save
// the list — the folder is being removed by another process (Windows marks it for deletion and it goes when the last handle on it closes; until then it cannot be opened), which says
// nothing about who may change it. A caller that can wait for the folder to go asks again (lib/temp-workspace.js); one that cannot takes it as the "no" it is.
//
// WHAT THIS DOES NOT SEE. Rights to READ are not looked at: what is read is a workspace a run made there, and a folder others can only read is one they could read in the temp folder
// before this module. Nor does it say anything about the folder that holds the folder it judges: others who can rename or delete entries in a temp folder could replace the plugin's folder, as
// they could have replaced any workspace made loose in it. What it judges is the folder at the moment it is asked about, and lib/temp-workspace.js remembers which folder that was (its place and
// file id) and asks again if another is there when it is used.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnResultSync, withPathFirst, windowsCmd } = require('./process-runner.js');

// Access rights (https://learn.microsoft.com/windows/win32/fileio/file-security-and-access-rights): on a FOLDER, FILE_ADD_FILE (0x2) adds a file and FILE_ADD_SUBDIRECTORY (0x4) a folder,
// FILE_WRITE_EA (0x10) and FILE_WRITE_ATTRIBUTES (0x100) change what is recorded about the folder (and, inherited, about everything in it), FILE_DELETE_CHILD (0x40) removes what is
// inside, DELETE (0x10000) removes the folder, WRITE_DAC (0x40000) changes who may do what, WRITE_OWNER (0x80000) takes it over; the generic GENERIC_WRITE (0x40000000) and GENERIC_ALL
// (0x10000000) stand for sets that include them. (An inherit-only entry may still carry a GENERIC_ right: it is mapped when it is inherited.)
const WRITE_RIGHTS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;

// The rights an SDDL entry names by two letters, one after another (`FRFX`): https://learn.microsoft.com/windows/win32/secauthz/ace-strings
// The last nine are the codes for rights on directory-service objects. icacls writes a FILE entry's mask with them when the mask matches none of the file codes (`C:\ProgramData` is
// `(A;CI;DCLCRPCR;;;BU)`: Users may add a file and a folder and write attributes), so what they stand for here is the BIT — DC is 0x2, which on a folder is FILE_ADD_FILE — and not the name.
const RIGHT_CODES = {
  GR: 0x80000000, GW: 0x40000000, GX: 0x20000000, GA: 0x10000000,
  RC: 0x20000, SD: 0x10000, WD: 0x40000, WO: 0x80000,
  FA: 0x1f01ff, FR: 0x120089, FW: 0x120116, FX: 0x1200a0,
  CC: 0x1, DC: 0x2, LC: 0x4, SW: 0x8, RP: 0x10, WP: 0x20, DT: 0x40, LO: 0x80, CR: 0x100,
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

// One section of an SDDL string — `D:` (the access list) or `S:` (the audit list) — read from `start`, just after those two characters: its flags, then its entries, each in parentheses, and
// where it ends. `parseEntry` reads an entry; null for text that is not what a section is.
function readSection(sddl, start, parseEntry) {
  // The section's flags: P (protected), AI (auto-inherited), AR (auto-inherit required), or NO_ACCESS_CONTROL (no list at all).
  const flags = /^(?:NO_ACCESS_CONTROL|P|AI|AR)*/.exec(sddl.slice(start))[0];
  const entries = [];
  let i = start + flags.length;
  while (i < sddl.length && sddl[i] === '(') {
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
    const entry = parseEntry(sddl.slice(i + 1, j));
    if (entry === null) return null;
    entries.push(entry);
    i = j + 1;
  }
  return { flags, entries, end: i };
}

/**
 * The access list in SDDL — `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)` — as its entries, and whether it is protected (`P`: it takes nothing from the folder above it). Strict: text that has
 * anything but a list in it, an entry cut short or one that is not understood, a list with no access control at all (`D:NO_ACCESS_CONTROL`, which gives everyone everything) are all
 * null, and null means "cannot tell". A list that Windows' own folders carry after it — an audit list, `S:AINO_ACCESS_CONTROL`, `S:PAI(ML;OINPIO;NW;;;HI)` — is read for its shape and
 * ignored: it grants no access to anyone.
 * @returns {{ aces: Array<{ type: string, flags: string, mask: number, trustee: string }>, protected: boolean } | null}
 */
function parseDacl(text) {
  const sddl = String(text).trim();
  if (!sddl.startsWith('D:')) return null;
  const dacl = readSection(sddl, 2, parseAce);
  if (dacl === null || dacl.flags.includes('NO_ACCESS_CONTROL')) return null;
  if (dacl.end < sddl.length) {
    if (!sddl.startsWith('S:', dacl.end)) return null;
    const audit = readSection(sddl, dacl.end + 2, (entry) => entry);
    if (audit === null || audit.end < sddl.length) return null;
  }
  return { aces: dacl.entries, protected: dacl.flags.includes('P') };
}

// The principals a list may name for a folder that is the user's: the user (and, for the machine's own Administrator and Guest accounts, the alias SDDL writes for them), the system and the
// administrators.
function trustedTrustees(userSid) {
  const user = String(userSid).toUpperCase();
  const trusted = new Set([SYSTEM, ADMINISTRATORS, user]);
  for (const [alias, account] of OWN_ACCOUNT_ALIASES) if (account.test(user)) trusted.add(alias);
  return trusted;
}

/**
 * Who, besides the user, the system and the administrators, an access list lets add to a folder, remove from it, delete it, write its attributes, or change who may or
 * who owns it. EVERY entry that grants one of those counts — an inherit-only one too: it does not apply to the folder itself, but it is what each workspace and each owner record made in the
 * folder is given, and so it decides who can change the records the sweep believes. Entries that grant nothing (denials, audits) are not looked at.
 * @returns {string[]} the trustees, as SIDs where they have one, each once
 */
function foreignWriters(aces, userSid) {
  const trusted = trustedTrustees(userSid);
  const writers = [];
  for (const ace of aces) {
    if (NON_GRANTING.has(ace.type)) continue;
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

// The programs of Windows this module starts, and how. icacls and whoami live in System32, beside cmd.exe, and are looked up with that folder FIRST on PATH, as lib/process-runner.js looks
// up taskkill: a PATH without it (a service, a stripped-down shell) would find nothing, and an earlier folder that the user can write to could stand in for the program — and be believed about
// who may write to a folder. PowerShell is in a folder of its own below System32.
function tools(deps) {
  const env = deps.env || process.env;
  const system32 = path.win32.dirname(windowsCmd(env));
  return {
    run: deps.run || spawnResultSync,
    env,
    options: { encoding: 'utf8', timeout: 10000, windowsHide: true },
    lookup: { env: withPathFirst(env, system32, 'win32') },
    powershellLookup: { env: withPathFirst(env, path.win32.join(system32, 'WindowsPowerShell', 'v1.0'), 'win32') },
  };
}

// `whoami /user /fo csv /nh` → "contoso\maker","S-1-5-21-1111111111-2222222222-3333333333-1001" (the name is localized or not; the SID is a SID). A process does not change user, so the real
// program is asked once; a test that stands in for it gets its own answer every time.
let knownSid = null;
function userSidOf(tool, deps) {
  if (!deps.run && knownSid) return knownSid;
  const who = tool.run('whoami', ['/user', '/fo', 'csv', '/nh'], tool.options, tool.lookup);
  const found = who && !who.error && who.status === 0 ? /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(String(who.stdout)) : null;
  if (found && !deps.run) knownSid = found[1];
  return found ? found[1] : null;
}

// The folder's access list as `icacls` saves it, parsed: `{ dacl }`, or `{ verdict }` — the "no" to answer instead. The list is saved beside the folder, in the folder that holds it (the temp
// folder, for the plugin's): a few hundred bytes, read and removed at once.
function readDacl(folder, tool, deps) {
  const file = path.join(deps.saveIn || path.dirname(folder), `power-platform-skills-acl-${process.pid}-${crypto.randomBytes(6).toString('hex')}.txt`);
  try {
    // icacls started and could not save the list: the folder is being removed by another process (Windows marks it for deletion, and it goes when the last handle on it closes — until
    // then it cannot be opened), or is gone, or is somebody's. That is no answer about who may change it, so the answer says so (`unreadable`) and the caller — which can wait for the
    // folder to go and make it again — asks again. A program that could not be started at all is not that: it is no one's doing but the system's, and the answer stays no.
    const saved = tool.run('icacls', [folder, '/save', file], tool.options, tool.lookup);
    if (!saved || saved.error) return { verdict: { ok: false, reason: 'its access list could not be saved (icacls could not be run)' } };
    if (saved.status !== 0) return { verdict: { ok: false, unreadable: true, reason: 'its access list could not be saved (icacls /save)' } };
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      return { verdict: { ok: false, unreadable: true, reason: 'its access list could not be read back' } };
    }
    const line = savedDacl(buffer);
    const dacl = line === null ? null : parseDacl(line);
    return dacl ? { dacl } : { verdict: { ok: false, reason: 'its access list is not in a form that is understood' } };
  } finally {
    try { fs.rmSync(file, { force: true }); } catch { /* a few hundred bytes of an access list in the temp folder */ }
  }
}

// The folder's owner as the SID Windows has for it, or null. `GetAccessControl(path, Owner)` asks for the owner alone (a plain `Get-Acl` loads a module and costs a second more), and
// `.GetOwner([SecurityIdentifier])` is the SID itself, not a name that depends on the language of the machine. The folder goes in through the environment and the script is passed encoded, so that
// no character of a path is ever read as PowerShell syntax. Where PowerShell cannot do this — a locked-down language mode, a Windows without it — the answer is null: not private.
const OWNER_SCRIPT = '[IO.Directory]::GetAccessControl($env:POWER_PLATFORM_SKILLS_FOLDER,[Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value';
function ownerSidOf(folder, tool) {
  const encoded = Buffer.from(OWNER_SCRIPT, 'utf16le').toString('base64');
  const ran = tool.run('powershell', ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand', encoded],
    { ...tool.options, timeout: 30000, env: { ...tool.env, POWER_PLATFORM_SKILLS_FOLDER: folder } }, tool.powershellLookup);
  const printed = ran && !ran.error && ran.status === 0 ? String(ran.stdout).trim() : '';
  return /^S-1-\d+(?:-\d+)+$/i.test(printed) ? printed.toUpperCase() : null;
}

function judge(folder, deps) {
  const tool = tools(deps);
  const sid = userSidOf(tool, deps);
  if (!sid) return { ok: false, reason: 'the user\'s SID could not be read (whoami /user)' };
  const read = readDacl(folder, tool, deps);
  if (read.verdict) return read.verdict;
  const writers = foreignWriters(read.dacl.aces, sid);
  if (writers.length > 0) {
    // A list that is still all the folder took from the one above — not protected, and every entry marked `ID` (inherited) — is also the list a folder has between the `mkdir` of the run that
    // made it and that run's icacls (makeWindowsFolderPrivate), when the temp folder it is in lets others write (`TEMP` on a data drive: `D:(A;OICIID;0x1301bf;;;AU)...`). The answer says so
    // (`inherited`), so that a caller can tell that "no" from one about a list somebody set; it is a "no" all the same.
    const inherited = !read.dacl.protected && read.dacl.aces.every((ace) => (ace.flags.match(/../g) || []).includes('ID'));
    return { ok: false, reason: `${writers.join(', ')} can add to it, remove from it or take it over`, ...(inherited ? { inherited: true } : {}) };
  }
  // A list that names only the right principals does not make the folder theirs: its owner can rewrite the list whatever it says now. The owner is the user — or the administrators, whom the list
  // trusts anyway, and who own what a process that runs elevated makes.
  const owner = ownerSidOf(folder, tool);
  if (owner === null) return { ok: false, reason: 'its owner could not be read (PowerShell)' };
  if (owner !== sid.toUpperCase() && owner !== ADMINISTRATORS) return { ok: false, owner, reason: `its owner is ${owner}, who is neither this user nor the administrators` };
  return { ok: true, owner, reason: 'only this user, the system and the administrators can change it, and it is the user\'s or the administrators\'' };
}

// What is wrong with an access list that was just SET on a new folder, or null: it must be protected, hold no entry that came from above, and name only this user, the system and the
// administrators — each as a grant — with full control for the user.
function whatIsWrongWithProtectedList(dacl, userSid) {
  if (!dacl.protected) return 'it is not protected: it still takes entries from the folder above';
  const trusted = trustedTrustees(userSid);
  const user = new Set([String(userSid).toUpperCase(), ...OWN_ACCOUNT_ALIASES.filter(([, account]) => account.test(String(userSid).toUpperCase())).map(([alias]) => alias)]);
  for (const ace of dacl.aces) {
    if (ace.type !== 'A') return `it has an entry of type ${ace.type} for ${ace.trustee}`;
    if ((ace.flags.match(/../g) || []).includes('ID')) return `it has an entry for ${ace.trustee} that comes from the folder above`;
    if (!trusted.has(ace.trustee)) return `it has an entry for ${ace.trustee}`;
  }
  const FULL_CONTROL = 0x1f01ff;
  if (!dacl.aces.some((ace) => user.has(ace.trustee) && (ace.mask & FULL_CONTROL) === FULL_CONTROL)) return 'this user does not have full control';
  return null;
}

function protect(folder, deps) {
  const tool = tools(deps);
  const sid = userSidOf(tool, deps);
  if (!sid) return { ok: false, reason: 'the user\'s SID could not be read (whoami /user)' };
  // `*<SID>` is a SID rather than a name, so that nothing depends on the language of the machine; `(OI)(CI)F` is full control, inherited by the files and folders made inside.
  // `/inheritance:r` removes every entry the folder took from the one above and `/grant:r` replaces what was granted to those principals before: what is left is these three.
  // https://learn.microsoft.com/windows-server/administration/windows-commands/icacls
  const grants = [...new Set([sid.toUpperCase(), SYSTEM, ADMINISTRATORS])].map((who) => `*${who}:(OI)(CI)F`);
  const set = tool.run('icacls', [folder, '/inheritance:r', '/grant:r', ...grants], tool.options, tool.lookup);
  if (!set || set.error) return { ok: false, reason: 'its access list could not be set (icacls could not be run)' };
  // icacls ran and said no: as for the saving of a list (readDacl), a folder that is being removed — which it was never going to be able to open — may say it, and the caller asks again.
  if (set.status !== 0) return { ok: false, unreadable: true, reason: 'its access list could not be set (icacls /inheritance:r /grant:r)' };
  const read = readDacl(folder, tool, deps);
  if (read.verdict) return read.verdict;
  const wrong = whatIsWrongWithProtectedList(read.dacl, sid);
  return wrong === null
    ? { ok: true, reason: 'its access list was set and read back: protected, and only this user, the system and the administrators are on it' }
    : { ok: false, reason: `its access list is not what was set: ${wrong}` };
}

/**
 * Whether only this user, the system and the administrators can change `folder`, and it belongs to this user or the administrators. Never throws: whatever cannot be read, run or understood is
 * `{ ok: false }`. `unreadable: true` marks the one kind of "no" that may not stay one: the list could not be got at all (the folder is being removed, most likely), which says nothing about
 * the folder. `inherited: true` marks a "no" about a list that is still only what the folder took from the one above — what a folder has until the run that made it gives it a list of its own.
 * @param {string} folder
 * @param {object} [deps] test seams: run (the process runner's spawnResultSync), env, saveIn (the folder the saved list goes in: the folder's own parent)
 * @returns {{ ok: boolean, reason: string, unreadable?: boolean, inherited?: boolean, owner?: string }} `owner` is the SID of the folder's owner, when it was read
 */
function windowsFolderIsPrivate(folder, deps = {}) {
  try {
    return judge(folder, deps);
  } catch (error) {
    return { ok: false, reason: `its access list could not be read: ${(error && error.message) || error}` };
  }
}

/**
 * Gives a folder this process has just made an access list of its own — protected, and with only this user, the system and the administrators on it, each with full control that the
 * files and folders made inside inherit — and reads it back to be sure. Call it before anything is put in the folder. Never throws; `{ ok: false }` (with `unreadable: true` for a folder that
 * icacls could not open, which a caller that can wait for it to go may ask again) means the folder is not to be used. It does not look at the owner: the folder is the caller's, made a
 * moment ago, and whoever made it is its owner.
 * @param {string} folder
 * @param {object} [deps] test seams: as for windowsFolderIsPrivate
 * @returns {{ ok: boolean, reason: string, unreadable?: boolean }}
 */
function makeWindowsFolderPrivate(folder, deps = {}) {
  try {
    return protect(folder, deps);
  } catch (error) {
    return { ok: false, reason: `its access list could not be set: ${(error && error.message) || error}` };
  }
}

module.exports = { WRITE_RIGHTS, parseDacl, foreignWriters, windowsFolderIsPrivate, makeWindowsFolderPrivate };
