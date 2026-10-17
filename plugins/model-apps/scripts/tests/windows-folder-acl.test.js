'use strict';
// lib/windows-folder-acl.js: who can change a folder on Windows. Node reports no owner and no permissions there, so the folder's access list is read with the program Windows
// has for it (icacls), as SDDL — which names its principals by SID, in every language — and the answer is one-sided: only a folder that nobody but this user, the system and the
// administrators can add to, remove from or take over is private; everything that cannot be read or understood is not.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { windowsFolderIsPrivate, makeWindowsFolderPrivate, parseDacl, foreignWriters, WRITE_RIGHTS } = require('../lib/windows-folder-acl.js');
const { systemTool } = require('./helpers/windows-system-tools.js');

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';
const writersOf = (sddl, user = USER) => {
  const dacl = parseDacl(sddl);
  assert.ok(dacl, `${sddl} is understood`);
  return foreignWriters(dacl.aces, user);
};

test('parseDacl reads an access list the way SDDL writes it: the access control entries, their rights as a mask, their trustees as SIDs — and whether it is protected', () => {
  const dacl = parseDacl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`);
  assert.deepStrictEqual(dacl.aces.map((ace) => [ace.type, ace.flags, ace.trustee]), [['A', 'OICI', 'S-1-5-18'], ['A', 'OICI', 'S-1-5-32-544'], ['A', 'OICI', USER]]);
  assert.strictEqual(dacl.protected, true, 'P: it takes nothing from the folder above');
  assert.strictEqual(parseDacl('D:AI(A;OICIID;FA;;;SY)').protected, false, 'inherited, not protected');
  assert.strictEqual(parseDacl('D:(A;;FA;;;SY)').protected, false);
  assert.strictEqual(dacl.aces[0].mask, 0x1f01ff, 'FA: file all access');
  const rights = (text) => parseDacl(`D:(A;;${text};;;BU)`).aces[0].mask;
  assert.strictEqual(rights('FR'), 0x120089);
  assert.strictEqual(rights('FRFX'), 0x120089 | 0x1200a0, 'two-letter codes follow one another');
  assert.strictEqual(rights('0x1301bf'), 0x1301bf);
  assert.strictEqual(rights('GA'), 0x10000000);
  assert.strictEqual(rights('WD'), 0x40000, 'as a right WD is write-DAC; as a trustee it is Everyone');
  assert.strictEqual(rights(''), 0);
  // icacls writes the mask of a FILE entry with the codes of directory-service rights when it matches no file code (C:\ProgramData, for Users): the bits are what count — DC is 0x2, which on a folder is FILE_ADD_FILE.
  assert.strictEqual(rights('DCLCRPCR'), 0x2 | 0x4 | 0x10 | 0x100);
  assert.strictEqual(rights('CCDCLCSWRPWPDTLOCR'), 0x1ff);
  assert.strictEqual(parseDacl('D:(A;;FA;;;WD)').aces[0].trustee, 'S-1-1-0');
  assert.deepStrictEqual(parseDacl('D:').aces, [], 'an empty list: no one has access');
  assert.deepStrictEqual(parseDacl('D:P').aces, []);
  // A conditional entry carries an expression after its sixth field, with parentheses of its own.
  const conditional = parseDacl('D:(XA;;FA;;;WD;(@User.Title=="PM" && (@User.Dept=="X")))(A;;FA;;;SY)');
  assert.deepStrictEqual(conditional.aces.map((ace) => [ace.type, ace.trustee]), [['XA', 'S-1-1-0'], ['A', 'S-1-5-18']]);
  // Windows' own folders carry an audit list after the access list (`icacls /save` writes both on one line). It grants no one anything: it is read for its shape and left out.
  for (const audit of ['S:AINO_ACCESS_CONTROL', 'S:PAI(ML;OINPIO;NW;;;HI)', 'S:', 'S:P(AU;SA;FA;;;WD)(ML;;NW;;;LW)']) {
    const withAudit = parseDacl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)${audit}`);
    assert.deepStrictEqual(withAudit.aces.map((ace) => ace.trustee), ['S-1-5-18', 'S-1-5-32-545'], audit);
  }
  // A list that is cut off after its first entries is not read as if it ended there.
  for (const damaged of ['', 'garbage', 'D:(A;;FA;;;SY', 'D:(A;;FA;;;SY))', 'D:(A;;FA;;)', 'D:(A;;FA;;;)', 'D:(A;;ZZ;;;BU)', 'D:(A;;0xZZ;;;BU)', 'D:(;;FA;;;BU)', 'D:NO_ACCESS_CONTROL', 'D:(A;;FA;;;SY)junk', 'O:BAD:(A;;FA;;;SY)x',
    'D:(A;;FA;;;SY)S:(ML;;NW;;;LW', 'D:(A;;FA;;;SY)S:junk', 'D:(A;;FA;;;SY)S:AI(ML;;NW;;;LW)junk', 'D:(A;;FA;;;SY)G:BA']) {
    assert.strictEqual(parseDacl(damaged), null, JSON.stringify(damaged));
  }
});

test('foreignWriters: whoever else may add to the folder, remove from it, delete it, write its attributes, or take it over — an inherit-only entry too — and nobody for rights that only read, list or run', () => {
  assert.deepStrictEqual(writersOf(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`), [], 'the access list a user\'s own temp folder gives: the system, the administrators, this user');
  assert.deepStrictEqual(writersOf(`D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER.toLowerCase()})`), [], 'a SID is compared without regard to case');
  assert.deepStrictEqual(writersOf(`D:(A;OICI;FA;;;${TRUSTED_INSTALLER})`), [TRUSTED_INSTALLER], 'the installer service of Windows is not this user, the system or the administrators: it owns the Windows folder, not a temp folder');
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;WD)'), ['S-1-1-0'], 'Everyone: modify');
  assert.deepStrictEqual(writersOf(`D:(A;OICI;FA;;;${OTHER})`), [OTHER], 'another user: full control');
  assert.deepStrictEqual(writersOf(`D:(A;OICI;FA;;;${USER})`, OTHER), [USER], 'whose folder it is depends on who asks');
  assert.deepStrictEqual(writersOf('D:(A;;FW;;;BU)'), ['S-1-5-32-545'], 'Users: write — which adds files and folders');
  assert.deepStrictEqual(writersOf('D:(A;;0x2;;;AU)'), ['S-1-5-11'], 'Authenticated Users: add a file');
  assert.deepStrictEqual(writersOf('D:(A;;0x4;;;AU)'), ['S-1-5-11'], 'add a subfolder');
  assert.deepStrictEqual(writersOf('D:(A;;0x10;;;AU)'), ['S-1-5-11'], 'write extended attributes');
  assert.deepStrictEqual(writersOf('D:(A;;0x40;;;AU)'), ['S-1-5-11'], 'delete what is in it');
  assert.deepStrictEqual(writersOf('D:(A;;0x100;;;AU)'), ['S-1-5-11'], 'write attributes');
  assert.deepStrictEqual(writersOf('D:(A;;SD;;;AU)'), ['S-1-5-11'], 'delete it');
  assert.deepStrictEqual(writersOf('D:(A;;WD;;;AU)'), ['S-1-5-11'], 'change who may do what');
  assert.deepStrictEqual(writersOf('D:(A;;WO;;;AU)'), ['S-1-5-11'], 'take it over');
  assert.deepStrictEqual(writersOf('D:(A;;GW;;;AU)'), ['S-1-5-11']);
  assert.deepStrictEqual(writersOf('D:(A;;GA;;;AU)'), ['S-1-5-11']);
  assert.deepStrictEqual(writersOf('D:(A;;DCLCRPCR;;;BU)'), ['S-1-5-32-545'], 'C:\\ProgramData: Users may add files and folders and write attributes');
  assert.deepStrictEqual(writersOf('D:(A;;GR;;;AU)(A;;GX;;;AU)(A;;FRFX;;;BU)(A;;RC;;;BU)(A;;0x1;;;WD)(A;;0x8;;;WD)(A;;0x20;;;WD)(A;;0x80;;;WD)(A;;0x1200a9;;;WD)'), [], 'read, list, run, read the permissions and the attributes');
  // Entries that apply to what is made INSIDE the folder only are not the folder's own rights — and are the rights of every workspace and every record made in it.
  assert.deepStrictEqual(writersOf('D:(A;OICIIO;FA;;;CO)(A;OICIIO;FA;;;WD)'), ['S-1-3-0', 'S-1-1-0'], 'inherit-only: CREATOR OWNER and Everyone');
  assert.deepStrictEqual(writersOf('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;' + USER + ')(A;OICIIO;0x1301bf;;;WD)'), ['S-1-1-0'], 'an otherwise private list with one inherit-only grant to Everyone: the one case that a look at the folder\'s own rights alone does not see');
  assert.deepStrictEqual(writersOf('D:(A;CIIO;0x100;;;WD)'), ['S-1-1-0'], 'inherit-only, subfolders only, write attributes');
  assert.deepStrictEqual(writersOf('D:(A;OIIO;GW;;;WD)'), ['S-1-1-0'], 'inherit-only, files only, generic write');
  assert.deepStrictEqual(writersOf('D:(A;OICIIOID;GA;;;BU)'), ['S-1-5-32-545'], 'inherit-only and inherited');
  assert.deepStrictEqual(writersOf('D:(A;OICIIO;GXGR;;;WD)(A;OICIIO;0x1200a9;;;BU)'), [], 'inherit-only, and only to read and run');
  assert.deepStrictEqual(writersOf('D:(D;OICIIO;FA;;;WD)(A;;FA;;;SY)'), [], 'a denial grants nothing, inherit-only or not');
  assert.deepStrictEqual(writersOf('D:(D;;FA;;;WD)(A;;FA;;;SY)'), [], 'a denial grants nothing');
  assert.deepStrictEqual(writersOf('D:(A;;FA;;;DA)'), ['DA'], 'a principal that is not recognised is not trusted, and is named as it was written');
  assert.deepStrictEqual(writersOf('D:(A;;FA;;;PS)'), ['S-1-5-10'], 'nor is the principal a program runs as for itself');
  assert.deepStrictEqual(writersOf('D:(XA;;FA;;;WD;(@User.Title=="PM"))'), ['S-1-1-0'], 'a conditional grant counts');
  assert.deepStrictEqual(writersOf(`D:(A;;FA;;;${OTHER})(A;;FW;;;${OTHER})(A;;FA;;;AU)`), [OTHER, 'S-1-5-11'], 'each once');
  assert.ok(WRITE_RIGHTS & 0x2 && WRITE_RIGHTS & 0x4 && WRITE_RIGHTS & 0x10 && WRITE_RIGHTS & 0x40 && WRITE_RIGHTS & 0x100 && WRITE_RIGHTS & 0x10000 && WRITE_RIGHTS & 0x40000 && WRITE_RIGHTS & 0x80000);
});

// The machine's own Administrator and Guest accounts (RID 500 and 501) are written as LA and LG, never as SIDs: the account of a virtual machine or a CI runner is often the built-in
// Administrator, renamed, so `whoami` answers its SID and the list that names the user reads back LA.
test('foreignWriters: LA and LG are the user\'s own only for the user whose account each is — never for another user, a domain\'s Administrator, or an Azure AD user', () => {
  const ADMIN = 'S-1-5-21-1111111111-2222222222-3333333333-500';
  const GUEST = 'S-1-5-21-1111111111-2222222222-3333333333-501';
  const AZURE_AD = 'S-1-12-1-1111111111-2222222222-3333333333-4444444444';
  assert.deepStrictEqual(writersOf('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)', ADMIN), [], 'the built-in Administrator, renamed: whoami says …-500, the list says LA');
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;LG)', GUEST), [], 'and the Guest account its own');
  assert.deepStrictEqual(writersOf(`D:(A;OICI;FA;;;${ADMIN})`, ADMIN), [], 'the SID in full counts as before');
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;LA)', USER), ['LA'], 'an ordinary user: LA is another account');
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;LG)', USER), ['LG']);
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;LG)', ADMIN), ['LG'], 'Guest is not the Administrator');
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;LA)', GUEST), ['LA'], 'nor the Administrator the Guest');
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;LA)', AZURE_AD), ['LA'], 'an Azure AD user is not a machine\'s account');
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;LA)', 'S-1-5-18'), ['LA'], 'nor is the system');
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;LA)', 'S-1-5-21-1-2-3-5000'), ['LA'], 'a RID that only ends in 500 is not 500');
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;LA)', 'S-1-5-21-1-2-500'), ['LA'], 'nor is a SID with fewer parts than a machine\'s');
});

// The programs of Windows, as the module starts them, stood in for: `whoami` answers the user, `icacls /save <file>` writes the list as it does — in UTF-16, to a file — and PowerShell says who owns
// the folder (as a SID). `icacls <folder> /inheritance:r /grant:r …` — the setting of a list — is recorded, and changes what the next `/save` writes when `afterSet` says what that is.
function fakeWindows({ sddl, sid = USER, bom = false, whoami, icacls, owner = sid, powershell, afterSet } = {}) {
  const calls = [];
  let list = sddl;
  const run = (name, args, options, runDeps) => {
    calls.push({ name, args, options, runDeps });
    if (name === 'whoami') return whoami ? whoami() : { status: 0, stdout: `"DOMAIN\\user","${sid}"\r\n`, stderr: '' };
    if (name === 'powershell') return powershell ? powershell(args, options) : { status: 0, stdout: `${owner}\r\n`, stderr: '' };
    if (name === 'icacls') {
      if (icacls) return icacls(args);
      if (args.includes('/inheritance:r')) {
        if (afterSet !== undefined) list = typeof afterSet === 'function' ? afterSet(args) : afterSet;
        return { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files\r\n', stderr: '' };
      }
      const file = args[args.indexOf('/save') + 1];
      fs.writeFileSync(file, Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(`parent\r\n${list}\r\n\r\n`, 'utf16le')]));
      return { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files\r\n', stderr: '' };
    }
    throw new Error(`unexpected program ${name}`);
  };
  return { run, calls };
}

function scratchTemp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acl-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('windowsFolderIsPrivate: private when only this user, the system and the administrators can change the folder and it is the user\'s — and nothing is left behind', (t) => {
  const tmp = scratchTemp(t);
  for (const bom of [false, true]) {
    const { run, calls } = fakeWindows({ sddl: `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`, bom });
    const verdict = windowsFolderIsPrivate('C:\\Temp\\power-platform-skills-model-apps', { run, saveIn: tmp, env: { Path: 'C:\\x', SystemRoot: 'C:\\Windows' } });
    assert.strictEqual(verdict.ok, true, `${bom ? 'with' : 'without'} a byte-order mark: ${verdict.reason}`);
    assert.strictEqual(verdict.owner, USER, 'and says whose it is');
    assert.deepStrictEqual(calls.map((c) => c.name), ['whoami', 'icacls', 'powershell'], 'the list first, the owner last: it is the program that takes the longest');
    assert.deepStrictEqual(calls[0].args, ['/user', '/fo', 'csv', '/nh']);
    assert.strictEqual(calls[1].args[0], 'C:\\Temp\\power-platform-skills-model-apps');
    assert.strictEqual(calls[1].args[1], '/save');
    assert.ok(path.dirname(calls[1].args[2]) === tmp, 'the list is saved to a file in the temp folder');
    assert.ok(calls.every((c) => c.options.timeout > 0 && c.options.windowsHide === true), 'bounded, and no console window');
    // Looked up with System32 first on PATH, as the process runner looks up taskkill: no earlier folder can stand in for the program. PowerShell is in a folder of its own below it.
    assert.ok(calls.slice(0, 2).every((c) => /^C:\\Windows\\System32;/i.test(c.runDeps.env.PATH)), calls[0].runDeps.env.PATH);
    assert.ok(/^C:\\Windows\\System32\\WindowsPowerShell\\v1\.0;/i.test(calls[2].runDeps.env.PATH), calls[2].runDeps.env.PATH);
    assert.deepStrictEqual(fs.readdirSync(tmp), [], 'the saved list is removed');
  }
  // A user whose account is the machine's own Administrator (a CI runner's, renamed) reads back as LA in the list, and the folder is still theirs alone.
  const asAdministrator = fakeWindows({ sddl: 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)', sid: 'S-1-5-21-1111111111-2222222222-3333333333-500' });
  const named = windowsFolderIsPrivate('C:\\Temp\\p', { run: asAdministrator.run, saveIn: tmp });
  assert.strictEqual(named.ok, true, named.reason);
  const asUser = fakeWindows({ sddl: 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)', sid: USER });
  assert.strictEqual(windowsFolderIsPrivate('C:\\Temp\\p', { run: asUser.run, saveIn: tmp }).ok, false, 'the same list is not private to a user who is not that account');
});

test('windowsFolderIsPrivate: not private when anyone else can change the folder — an inherit-only entry too — and the reason names who; the owner is not even asked', (t) => {
  const tmp = scratchTemp(t);
  const verdictFor = (sddl) => {
    const faked = fakeWindows({ sddl });
    const verdict = windowsFolderIsPrivate('C:\\Temp\\p', { run: faked.run, saveIn: tmp });
    assert.ok(!faked.calls.some((c) => c.name === 'powershell'), `${sddl}: PowerShell is not started for a folder that the list has already refused`);
    return verdict;
  };
  const everyone = verdictFor(`D:(A;OICI;FA;;;SY)(A;OICI;0x1301bf;;;WD)(A;OICI;FA;;;${USER})`);
  assert.strictEqual(everyone.ok, false);
  assert.match(everyone.reason, /S-1-1-0/);
  assert.strictEqual(verdictFor(`D:(A;OICI;FA;;;${OTHER})`).ok, false, 'another user');
  assert.strictEqual(verdictFor('D:(A;;FW;;;BU)').ok, false, 'Users may add to it');
  // The case a look at the folder's own rights alone does not see: nothing for anyone else on the folder itself, but a grant to Everyone that is inherited by everything made in it.
  const inheritOnly = verdictFor(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})(A;OICIIO;0x1301bf;;;WD)`);
  assert.strictEqual(inheritOnly.ok, false, 'an inherit-only grant to Everyone: every workspace and every owner record made in the folder would be Everyone\'s to change');
  assert.match(inheritOnly.reason, /S-1-1-0/);
  assert.strictEqual(verdictFor(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})(A;OICIIO;GA;;;CO)`).ok, false, 'CREATOR OWNER, inherit-only: not this user\'s, the system\'s or the administrators\'');
  assert.strictEqual(verdictFor(`D:(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})(A;CIIO;0x100;;;AU)`).ok, false, 'write attributes, inherit-only');
  assert.strictEqual(verdictFor(`D:(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})(A;OICI;0x10;;;AU)`).ok, false, 'write extended attributes');
  const readers = fakeWindows({ sddl: `D:(A;OICI;FRFX;;;BU)(A;OICIIO;GXGR;;;WD)(A;OICI;FA;;;${USER})` });
  assert.strictEqual(windowsFolderIsPrivate('C:\\Temp\\p', { run: readers.run, saveIn: tmp }).ok, true, 'Users and Everyone may only read it, and what is made in it');
  assert.deepStrictEqual(fs.readdirSync(tmp), []);
});

// Whoever owns a folder can rewrite its list, whatever it says now: a list that names only the right principals does not make the folder theirs.
test('windowsFolderIsPrivate: the folder must be the user\'s (or the administrators\', which the list trusts anyway) — a list that names only the user is not enough if somebody else owns the folder', (t) => {
  const tmp = scratchTemp(t);
  const list = `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`;
  const verdictOf = (faked) => windowsFolderIsPrivate('C:\\Temp\\p', { run: faked.run, saveIn: tmp });
  assert.strictEqual(verdictOf(fakeWindows({ sddl: list, owner: USER })).ok, true);
  assert.strictEqual(verdictOf(fakeWindows({ sddl: list, owner: USER.toLowerCase() })).ok, true, 'a SID is compared without regard to case');
  assert.strictEqual(verdictOf(fakeWindows({ sddl: list, owner: ADMINISTRATORS })).ok, true, 'a folder made by a process that runs elevated is the administrators\' by default');
  for (const [what, owner] of [['another user', OTHER], ['the system', SYSTEM], ['the installer service of Windows', TRUSTED_INSTALLER], ['Users', 'S-1-5-32-545'], ['Everyone', 'S-1-1-0']]) {
    const verdict = verdictOf(fakeWindows({ sddl: list, owner }));
    assert.strictEqual(verdict.ok, false, `owned by ${what}`);
    assert.strictEqual(verdict.owner, owner, `${what}: and the owner is named`);
    assert.match(verdict.reason, new RegExp(owner), what);
    assert.strictEqual(verdict.unreadable, undefined, `${what}: final`);
  }
  // The system's own folders, for the system: SYSTEM runs this, its SID is the user's, and a folder it owns is its own.
  const asSystem = fakeWindows({ sddl: 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)', sid: SYSTEM, owner: SYSTEM });
  assert.strictEqual(verdictOf(asSystem).ok, true);
  // What cannot be read is not private — and is final: PowerShell is not asked again.
  for (const [what, powershell] of [
    ['PowerShell cannot be started', () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn powershell ENOENT'), { code: 'ENOENT' }) })],
    ['PowerShell is stopped for taking too long', () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync powershell ETIMEDOUT'), { code: 'ETIMEDOUT' }) })],
    ['PowerShell fails (a language mode that does not allow the call)', () => ({ status: 1, stdout: '', stderr: 'Cannot invoke method' })],
    ['PowerShell prints nothing', () => ({ status: 0, stdout: '', stderr: '' })],
    ['PowerShell prints a name, not a SID', () => ({ status: 0, stdout: 'DOMAIN\\user\r\n', stderr: '' })],
    ['PowerShell prints a SID and something else', () => ({ status: 0, stdout: `${USER}\r\nand more\r\n`, stderr: '' })],
    ['PowerShell throws', () => { throw new Error('boom'); }],
  ]) {
    const faked = fakeWindows({ sddl: list, powershell });
    const verdict = verdictOf(faked);
    assert.deepStrictEqual([what, verdict.ok, verdict.unreadable], [what, false, undefined]);
    assert.match(verdict.reason, what === 'PowerShell throws' ? /boom/ : /owner could not be read/, what);
    assert.strictEqual(faked.calls.filter((c) => c.name === 'powershell').length, 1, `${what}: asked once`);
    assert.deepStrictEqual(fs.readdirSync(tmp), [], `${what}: nothing left behind`);
  }
});

test('windowsFolderIsPrivate: the owner is asked for as a SID, with the folder passed in the environment and the script encoded — no character of a path is ever read as PowerShell', (t) => {
  const tmp = scratchTemp(t);
  const faked = fakeWindows({ sddl: `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})` });
  const folder = 'C:\\Users\\o\'neil $(calc) `;\\Temp "x"\\power-platform-skills-model-apps';
  windowsFolderIsPrivate(folder, { run: faked.run, saveIn: tmp, env: { Path: 'C:\\x', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
  const call = faked.calls.find((c) => c.name === 'powershell');
  assert.deepStrictEqual(call.args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-NoLogo', '-EncodedCommand']);
  assert.strictEqual(call.args.length, 5, 'nothing else on the command line');
  const script = Buffer.from(call.args[4], 'base64').toString('utf16le');
  assert.ok(script.includes('GetAccessControl($env:POWER_PLATFORM_SKILLS_FOLDER') && script.includes('AccessControlSections]::Owner') && script.includes('SecurityIdentifier'), script);
  assert.ok(!script.includes(folder) && !script.includes('calc'), 'the folder is not in the script');
  assert.strictEqual(call.options.env.POWER_PLATFORM_SKILLS_FOLDER, folder, 'it is in the environment, exactly');
  assert.ok(call.options.timeout >= 10000 && call.options.windowsHide === true);
});

test('windowsFolderIsPrivate: whatever cannot be read, run or understood is not private — and the answer is never an exception', (t) => {
  const tmp = scratchTemp(t);
  const ok = `D:(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})`;
  const check = (what, faked, deps = {}) => {
    const verdict = windowsFolderIsPrivate('C:\\Temp\\p', { run: faked.run, saveIn: tmp, ...deps });
    assert.strictEqual(verdict.ok, false, `${what}: ${verdict.reason}`);
    assert.ok(typeof verdict.reason === 'string' && verdict.reason.length > 0, what);
    assert.deepStrictEqual(fs.readdirSync(tmp), [], `${what}: nothing left behind`);
  };
  check('whoami fails', fakeWindows({ sddl: ok, whoami: () => ({ status: 1, stdout: '', stderr: 'nope' }) }));
  check('whoami cannot be started', fakeWindows({ sddl: ok, whoami: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn whoami ENOENT'), { code: 'ENOENT' }) }) }));
  check('whoami does not print a SID (another whoami found first)', fakeWindows({ sddl: ok, whoami: () => ({ status: 0, stdout: 'user\r\n', stderr: '' }) }));
  check('whoami throws', fakeWindows({ sddl: ok, whoami: () => { throw new Error('boom'); } }));
  check('icacls fails (a folder it cannot read: access denied)', fakeWindows({ icacls: () => ({ status: 5, stdout: '', stderr: 'Access is denied.' }) }));
  check('icacls cannot be started', fakeWindows({ icacls: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn icacls ENOENT') }) }));
  check('icacls writes no file', fakeWindows({ icacls: () => ({ status: 0, stdout: '', stderr: '' }) }));
  check('icacls writes a file with no list in it', fakeWindows({ icacls: (args) => { fs.writeFileSync(args[2], Buffer.from('parent\r\n', 'utf16le')); return { status: 0, stdout: '', stderr: '' }; } }));
  check('icacls writes a list that is cut off', fakeWindows({ sddl: 'D:(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1' }));
  check('icacls writes a list nobody can read', fakeWindows({ icacls: (args) => { fs.writeFileSync(args[2], Buffer.from([0xff, 0xff, 0xff])); return { status: 0, stdout: '', stderr: '' }; } }));
  check('the folder the list is saved in cannot be written', fakeWindows({ sddl: ok }), { saveIn: path.join(tmp, 'missing') });
});

// A folder that another process is removing cannot be opened — Windows marks it for deletion, and it goes when the last handle on it closes — so icacls runs and says it could not save the
// list. That is no answer about who may change the folder, and the verdict says so (`unreadable`): the caller, which can wait for the folder to go, asks again. It is the only "no" of that
// kind: a program that cannot be started, a SID that cannot be read, a list that is not understood, a folder others can change and an owner that is not the user's are all final.
test('windowsFolderIsPrivate: a list that icacls ran and could not save, or that could not be read back, is `unreadable` — a "no" that may not stay one; every other "no" is final — and nothing is asked twice', (t) => {
  const tmp = scratchTemp(t);
  const ok = `D:(A;OICI;FA;;;SY)(A;OICI;FA;;;${USER})`;
  const verdictOf = (faked) => windowsFolderIsPrivate('C:\\Temp\\p', { run: faked.run, saveIn: tmp });
  const denied = fakeWindows({ icacls: () => ({ status: 5, stdout: 'Successfully processed 0 files; Failed processing 1 files', stderr: 'Access is denied.' }) });
  const unreadable = verdictOf(denied);
  assert.deepStrictEqual([unreadable.ok, unreadable.unreadable], [false, true], unreadable.reason);
  assert.deepStrictEqual(denied.calls.map((c) => c.name), ['whoami', 'icacls'], 'one try: the waiting is the caller\'s');
  const gone = verdictOf(fakeWindows({ icacls: () => ({ status: 2, stdout: '', stderr: 'The system cannot find the file specified.' }) }));
  assert.strictEqual(gone.unreadable, true, 'a folder that is gone');
  assert.strictEqual(verdictOf(fakeWindows({ icacls: () => ({ status: 0, stdout: '', stderr: '' }) })).unreadable, true, 'icacls says it saved the list, and there is no file');
  // Everything else is final.
  const final = (what, verdict) => assert.deepStrictEqual([what, verdict.ok, verdict.unreadable], [what, false, undefined]);
  final('icacls cannot be started', verdictOf(fakeWindows({ icacls: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn icacls ENOENT') }) })));
  final('whoami fails', verdictOf(fakeWindows({ sddl: ok, whoami: () => ({ status: 1, stdout: '', stderr: 'nope' }) })));
  final('a list that is cut off', verdictOf(fakeWindows({ sddl: 'D:(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1' })));
  final('a folder others can change', verdictOf(fakeWindows({ sddl: `D:(A;OICI;FA;;;SY)(A;OICI;0x1301bf;;;WD)(A;OICI;FA;;;${USER})` })));
  final('another user owns it', verdictOf(fakeWindows({ sddl: ok, owner: OTHER })));
  assert.deepStrictEqual([verdictOf(fakeWindows({ sddl: ok })).ok, verdictOf(fakeWindows({ sddl: ok })).unreadable], [true, undefined]);
  assert.deepStrictEqual(fs.readdirSync(tmp), [], 'nothing is left behind');
});

// ---------------------------------------------------------------------------------------------------------------------
// makeWindowsFolderPrivate: the list of a folder this process has just made is REPLACED, and read back
// ---------------------------------------------------------------------------------------------------------------------

const PROTECTED = (user = USER) => `D:PAI(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;

test('makeWindowsFolderPrivate: sets a list of the user, the system and the administrators — inheritance removed, full control inherited by what is made inside — reads it back, and answers ok only if that is what is there', (t) => {
  const tmp = scratchTemp(t);
  const faked = fakeWindows({ sddl: 'D:AI(A;OICIID;0x1301bf;;;WD)(A;OICIID;FA;;;SY)', afterSet: PROTECTED() });
  const verdict = makeWindowsFolderPrivate('C:\\Temp\\power-platform-skills-model-apps', { run: faked.run, saveIn: tmp, env: { Path: 'C:\\x', SystemRoot: 'C:\\Windows' } });
  assert.strictEqual(verdict.ok, true, verdict.reason);
  assert.deepStrictEqual(faked.calls.map((c) => [c.name, c.args.includes('/save') ? 'save' : c.args[1] || '']), [['whoami', '/fo'], ['icacls', '/inheritance:r'], ['icacls', 'save']], 'the user, the setting, the reading back — and nothing about the owner');
  assert.deepStrictEqual(faked.calls[1].args, ['C:\\Temp\\power-platform-skills-model-apps', '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
  assert.ok(faked.calls.every((c) => /^C:\\Windows\\System32;/i.test(c.runDeps.env.PATH)), 'looked up with System32 first');
  assert.ok(faked.calls.every((c) => c.options.timeout > 0 && c.options.windowsHide === true));
  assert.deepStrictEqual(fs.readdirSync(tmp), [], 'the saved list is removed');
  // For the machine's own Administrator the list reads back as LA; for the system the grants are not made twice.
  const admin = 'S-1-5-21-1111111111-2222222222-3333333333-500';
  assert.strictEqual(makeWindowsFolderPrivate('C:\\Temp\\p', { run: fakeWindows({ sddl: PROTECTED(admin), sid: admin, afterSet: 'D:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' }).run, saveIn: tmp }).ok, true);
  const asSystem = fakeWindows({ sddl: 'D:AI(A;OICIID;FA;;;WD)', sid: SYSTEM, afterSet: 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)' });
  assert.strictEqual(makeWindowsFolderPrivate('C:\\Temp\\p', { run: asSystem.run, saveIn: tmp }).ok, true);
  assert.deepStrictEqual(asSystem.calls[1].args.slice(3), ['*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], 'the system is not named twice');
});

test('makeWindowsFolderPrivate: what is read back must be what was set — protected, nothing inherited, no one but the three, each a grant, and full control for the user', (t) => {
  const tmp = scratchTemp(t);
  const outcome = (readBack) => makeWindowsFolderPrivate('C:\\Temp\\p', { run: fakeWindows({ sddl: 'D:AI(A;OICIID;0x1301bf;;;WD)', afterSet: readBack }).run, saveIn: tmp });
  const refused = (what, readBack, reason) => {
    const verdict = outcome(readBack);
    assert.strictEqual(verdict.ok, false, what);
    assert.match(verdict.reason, reason, what);
    assert.strictEqual(verdict.unreadable, undefined, `${what}: final`);
  };
  refused('a list that is not protected: it would take what is granted above', `D:AI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, /not protected/);
  refused('an entry that came from the folder above', `D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICIID;0x1301bf;;;WD)`, /S-1-1-0/);
  refused('an inherited entry of the user\'s own', `D:PAI(A;OICIID;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, /comes from the folder above/);
  refused('Everyone, even to read', `D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;WD)`, /S-1-1-0/);
  refused('another user', `D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${OTHER})`, new RegExp(OTHER));
  refused('the installer service of Windows', `D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${TRUSTED_INSTALLER})`, /S-1-5-80/);
  refused('a denial', `D:PAI(D;;FA;;;${OTHER})(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, /type D/);
  refused('no full control for the user', `D:PAI(A;OICI;0x1200a9;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`, /full control/);
  refused('no entry for the user at all', 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)', /full control/);
  assert.strictEqual(outcome(PROTECTED()).ok, true, 'the control: exactly what was set');
  assert.strictEqual(outcome(`D:PAI(A;OICI;FA;;;${USER})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)S:AINO_ACCESS_CONTROL`).ok, true, 'an audit list that comes with it grants nothing');
  assert.deepStrictEqual(fs.readdirSync(tmp), []);
});

test('makeWindowsFolderPrivate: whatever cannot be set, read back or understood is not ok — final, except that an icacls that ran and could not open the folder is `unreadable`: a folder Windows is removing', (t) => {
  const tmp = scratchTemp(t);
  const verdictOf = (faked) => makeWindowsFolderPrivate('C:\\Temp\\p', { run: faked.run, saveIn: tmp });
  const final = (what, verdict) => { assert.deepStrictEqual([what, verdict.ok, verdict.unreadable], [what, false, undefined]); assert.ok(verdict.reason.length > 0, what); };
  final('whoami fails', verdictOf(fakeWindows({ whoami: () => ({ status: 1, stdout: '', stderr: 'no' }) })));
  final('icacls cannot be started', verdictOf(fakeWindows({ icacls: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn icacls ENOENT') }) })));
  final('the list read back is not understood', verdictOf(fakeWindows({ sddl: 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;WD', afterSet: 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5' })));
  const stillSet = (status) => fakeWindows({ icacls: (args) => (args.includes('/inheritance:r') ? { status, stdout: '', stderr: 'Access is denied.' } : { status: 0, stdout: '', stderr: '' }) });
  for (const status of [5, 2]) {
    const verdict = verdictOf(stillSet(status));
    assert.deepStrictEqual([verdict.ok, verdict.unreadable], [false, true], `icacls ran and could not set the list (status ${status}): asked again by a caller that can wait`);
  }
  const noReadBack = verdictOf(fakeWindows({ icacls: (args) => (args.includes('/save') ? { status: 5, stdout: '', stderr: 'denied' } : { status: 0, stdout: '', stderr: '' }) }));
  assert.deepStrictEqual([noReadBack.ok, noReadBack.unreadable], [false, true], 'set, and the folder could not be opened to read it back');
  const thrown = makeWindowsFolderPrivate('C:\\Temp\\p', { run: () => { throw new Error('boom'); }, saveIn: tmp });
  assert.strictEqual(thrown.ok, false, 'never an exception');
  assert.deepStrictEqual(fs.readdirSync(tmp), []);
});

test('REAL ICACLS (Windows): a folder only this user can change is private; granting Everyone modify makes it not; taking the grant away makes it private again; a folder that is not there is not', { skip: process.platform !== 'win32' && 'Windows access control lists' }, (t) => {
  const root = scratchTemp(t);
  const folder = path.join(root, 'power-platform-skills-model-apps');
  fs.mkdirSync(folder);
  const icacls = (...args) => { const r = spawnSync(systemTool('icacls'), args, { encoding: 'utf8', windowsHide: true }); assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`); };
  // The list is set — this user, and no one else — and not left to the machine's temp folder. (For a user who is the machine's own Administrator, renamed, SDDL writes the entry as LA.)
  const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(spawnSync(systemTool('whoami'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout)[1];
  icacls(folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`);
  const baseline = windowsFolderIsPrivate(folder);
  assert.strictEqual(baseline.ok, true, baseline.reason);
  icacls(folder, '/grant', '*S-1-1-0:(OI)(CI)M');
  const open = windowsFolderIsPrivate(folder);
  assert.strictEqual(open.ok, false);
  assert.match(open.reason, /S-1-1-0/);
  icacls(folder, '/remove:g', '*S-1-1-0');
  assert.strictEqual(windowsFolderIsPrivate(folder).ok, true);
  // Another principal than this user's, the system's and the administrators': Authenticated Users (a SID that does not belong to any account cannot be granted).
  icacls(folder, '/grant', '*S-1-5-11:(OI)(CI)M');
  assert.strictEqual(windowsFolderIsPrivate(folder).ok, false, 'another principal can change it');
  icacls(folder, '/remove:g', '*S-1-5-11');
  assert.strictEqual(windowsFolderIsPrivate(path.join(root, 'not-there')).ok, false);
  assert.deepStrictEqual(fs.readdirSync(root).filter((name) => name.startsWith('power-platform-skills-acl')), [], 'no saved list is left beside the folder');
});

const onlyWindows = { skip: process.platform !== 'win32' && 'Windows access control lists' };
// From System32, as the module starts them (helpers/windows-system-tools.js): by name, a GNU whoami on PATH answers instead.
const runWindows = (program, args) => {
  const run = spawnSync(systemTool(program), args, { encoding: 'utf8', windowsHide: true });
  assert.ok(!run.error && run.status === 0, `${program} ${args.join(' ')} → ${run.error ? run.error.message : run.status}: ${run.stdout}${run.stderr}`);
  return run.stdout;
};
const currentSid = () => /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(runWindows('whoami', ['/user', '/fo', 'csv', '/nh']))[1];
// The list as `icacls /save` writes it (SDDL), read here without the module's reader.
const savedList = (target, saveIn) => {
  const file = path.join(saveIn, `acl-test-${Math.random().toString(36).slice(2)}.txt`);
  try {
    runWindows('icacls', [target, '/save', file]);
    return fs.readFileSync(file).toString('utf16le').split(/\r?\n/).find((line) => line.startsWith('D:'));
  } finally {
    fs.rmSync(file, { force: true });
  }
};

test('REAL ICACLS (Windows): a grant that applies only to what is made INSIDE the folder (inherit-only) makes it not private — for every right that writes, and not for the ones that only read', onlyWindows, (t) => {
  const root = scratchTemp(t);
  const folder = path.join(root, 'power-platform-skills-model-apps');
  fs.mkdirSync(folder);
  runWindows('icacls', [folder, '/inheritance:r', '/grant:r', `*${currentSid()}:(OI)(CI)F`]);
  assert.strictEqual(windowsFolderIsPrivate(folder).ok, true, 'the control: this user alone');
  for (const [what, grant, writes] of [
    ['modify', '(OI)(CI)(IO)M', true], ['full control', '(OI)(CI)(IO)F', true], ['write', '(OI)(CI)(IO)W', true], ['write attributes', '(OI)(CI)(IO)(WA)', true], ['write extended attributes', '(OI)(CI)(IO)(WEA)', true],
    ['add a file', '(OI)(CI)(IO)(WD)', true], ['add a subfolder', '(OI)(CI)(IO)(AD)', true], ['delete', '(OI)(CI)(IO)(DE)', true], ['change permissions', '(OI)(CI)(IO)(WDAC)', true], ['take ownership', '(OI)(CI)(IO)(WO)', true],
    ['delete what is in it', '(OI)(CI)(IO)(DC)', true], ['files only', '(OI)(IO)M', true], ['subfolders only', '(CI)(IO)M', true],
    ['read and run', '(OI)(CI)(IO)RX', false], ['read', '(OI)(CI)(IO)R', false],
  ]) {
    runWindows('icacls', [folder, '/grant', `*S-1-1-0:${grant}`]);
    assert.match(savedList(folder, root), /;;;WD\)/, `${what}: the grant is there`);
    const verdict = windowsFolderIsPrivate(folder);
    assert.strictEqual(verdict.ok, !writes, `${what}: ${verdict.reason}`);
    if (writes) assert.match(verdict.reason, /S-1-1-0/, what);
    runWindows('icacls', [folder, '/remove:g', '*S-1-1-0']);
  }
  assert.strictEqual(windowsFolderIsPrivate(folder).ok, true, 'and with each taken away it is private again');
});

test('REAL ICACLS + POWERSHELL (Windows): a folder this user made is theirs — the verdict says whose — and a folder that only the right principals can write to, but that somebody else owns, is not private', onlyWindows, (t) => {
  const root = scratchTemp(t);
  const folder = path.join(root, 'power-platform-skills-model-apps');
  fs.mkdirSync(folder);
  const sid = currentSid();
  runWindows('icacls', [folder, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
  const mine = windowsFolderIsPrivate(folder);
  assert.deepStrictEqual([mine.ok, mine.owner], [true, sid], mine.reason);
  // A folder of the machine's own that a list would pass — nobody who is not trusted can write to it — but that SYSTEM owns: the owner can rewrite the list. ProgramData\Microsoft is
  // `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)(A;OICI;0x1200a9;;;WD)` and owned by the system on every Windows (its list is read from where the program may save it).
  const theirs = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft');
  const verdict = windowsFolderIsPrivate(theirs, { saveIn: root });
  if (verdict.owner === undefined) {
    t.skip(`this machine's ${theirs} is not shaped as a stock Windows has it (${verdict.reason}): the owner is not reached`);
    return;
  }
  assert.strictEqual(verdict.ok, false, 'owned by someone else');
  assert.notStrictEqual(verdict.owner, sid);
  assert.match(verdict.reason, /owner/, verdict.reason);
  assert.strictEqual(fs.readdirSync(root).filter((name) => name.startsWith('power-platform-skills-acl') || name.startsWith('acl-test')).length, 0, 'no saved list is left');
});

test('REAL ICACLS (Windows): a folder made in a temp folder that EVERYONE can write to is given a list of its own, which is then read back as private — and its owner is this user', onlyWindows, (t) => {
  const root = scratchTemp(t);
  runWindows('icacls', [root, '/grant', '*S-1-1-0:(OI)(CI)M']);
  const handmade = path.join(root, 'handmade');
  fs.mkdirSync(handmade);
  assert.match(savedList(handmade, root), /;;;WD\)/, 'control: a folder made here the ordinary way has Everyone on it');
  assert.strictEqual(windowsFolderIsPrivate(handmade).ok, false, 'and is not private');
  const folder = path.join(root, 'power-platform-skills-model-apps');
  fs.mkdirSync(folder);
  const verdict = makeWindowsFolderPrivate(folder);
  assert.strictEqual(verdict.ok, true, verdict.reason);
  const list = savedList(folder, root);
  assert.match(list, /^D:P/, list);
  assert.doesNotMatch(list, /;;;WD\)/, list);
  assert.ok(list.includes(`;;;${currentSid()})`) && list.includes(';;;SY)') && list.includes(';;;BA)'), list);
  const inside = fs.mkdtempSync(path.join(folder, 'genpage-1-'));
  fs.writeFileSync(path.join(inside, '.owner.json'), '{}');
  assert.doesNotMatch(savedList(inside, root), /;;;WD\)/, 'what is made inside takes nothing from Everyone');
  assert.doesNotMatch(savedList(path.join(inside, '.owner.json'), root), /;;;WD\)/, 'nor does a record');
  const again = windowsFolderIsPrivate(folder);
  assert.deepStrictEqual([again.ok, again.owner], [true, currentSid()], again.reason);
  // A folder that is not there cannot be made private.
  assert.strictEqual(makeWindowsFolderPrivate(path.join(root, 'not-there')).ok, false);
  assert.deepStrictEqual(fs.readdirSync(root).filter((name) => name.startsWith('power-platform-skills-acl') || name.startsWith('acl-test')), [], 'no saved list is left');
});
