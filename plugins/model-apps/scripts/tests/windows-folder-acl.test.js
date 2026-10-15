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
const { windowsFolderIsPrivate, parseDacl, foreignWriters, WRITE_RIGHTS } = require('../lib/windows-folder-acl.js');

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002';
const TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
const writersOf = (sddl, user = USER) => {
  const dacl = parseDacl(sddl);
  assert.ok(dacl, `${sddl} is understood`);
  return foreignWriters(dacl.aces, user);
};

test('parseDacl reads an access list the way SDDL writes it: the access control entries, their rights as a mask, their trustees as SIDs', () => {
  const dacl = parseDacl(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`);
  assert.deepStrictEqual(dacl.aces.map((ace) => [ace.type, ace.flags, ace.trustee]), [['A', 'OICI', 'S-1-5-18'], ['A', 'OICI', 'S-1-5-32-544'], ['A', 'OICI', USER]]);
  assert.strictEqual(dacl.aces[0].mask, 0x1f01ff, 'FA: file all access');
  const rights = (text) => parseDacl(`D:(A;;${text};;;BU)`).aces[0].mask;
  assert.strictEqual(rights('FR'), 0x120089);
  assert.strictEqual(rights('FRFX'), 0x120089 | 0x1200a0, 'two-letter codes follow one another');
  assert.strictEqual(rights('0x1301bf'), 0x1301bf);
  assert.strictEqual(rights('GA'), 0x10000000);
  assert.strictEqual(rights('WD'), 0x40000, 'as a right WD is write-DAC; as a trustee it is Everyone');
  assert.strictEqual(rights(''), 0);
  assert.strictEqual(parseDacl('D:(A;;FA;;;WD)').aces[0].trustee, 'S-1-1-0');
  assert.deepStrictEqual(parseDacl('D:').aces, [], 'an empty list: no one has access');
  assert.deepStrictEqual(parseDacl('D:P').aces, []);
  // A conditional entry carries an expression after its sixth field, with parentheses of its own.
  const conditional = parseDacl('D:(XA;;FA;;;WD;(@User.Title=="PM" && (@User.Dept=="X")))(A;;FA;;;SY)');
  assert.deepStrictEqual(conditional.aces.map((ace) => [ace.type, ace.trustee]), [['XA', 'S-1-1-0'], ['A', 'S-1-5-18']]);
  // A list that is cut off after its first entries is not read as if it ended there.
  for (const damaged of ['', 'garbage', 'D:(A;;FA;;;SY', 'D:(A;;FA;;;SY))', 'D:(A;;FA;;)', 'D:(A;;FA;;;)', 'D:(A;;ZZ;;;BU)', 'D:(A;;0xZZ;;;BU)', 'D:(;;FA;;;BU)', 'D:NO_ACCESS_CONTROL', 'D:(A;;FA;;;SY)junk', 'O:BAD:(A;;FA;;;SY)x']) {
    assert.strictEqual(parseDacl(damaged), null, JSON.stringify(damaged));
  }
});

test('foreignWriters: whoever else may add to the folder, remove from it, delete it, or take it over — and nobody for rights that only read, list or run', () => {
  assert.deepStrictEqual(writersOf(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`), [], 'the access list a user\'s own temp folder gives: the system, the administrators, this user');
  assert.deepStrictEqual(writersOf(`D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER.toLowerCase()})`), [], 'a SID is compared without regard to case');
  assert.deepStrictEqual(writersOf(`D:(A;OICI;FA;;;${TRUSTED_INSTALLER})`), [], 'the installer service of Windows itself');
  assert.deepStrictEqual(writersOf('D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;WD)'), ['S-1-1-0'], 'Everyone: modify');
  assert.deepStrictEqual(writersOf(`D:(A;OICI;FA;;;${OTHER})`), [OTHER], 'another user: full control');
  assert.deepStrictEqual(writersOf(`D:(A;OICI;FA;;;${USER})`, OTHER), [USER], 'whose folder it is depends on who asks');
  assert.deepStrictEqual(writersOf('D:(A;;FW;;;BU)'), ['S-1-5-32-545'], 'Users: write — which adds files and folders');
  assert.deepStrictEqual(writersOf('D:(A;;0x2;;;AU)'), ['S-1-5-11'], 'Authenticated Users: add a file');
  assert.deepStrictEqual(writersOf('D:(A;;0x4;;;AU)'), ['S-1-5-11'], 'add a subfolder');
  assert.deepStrictEqual(writersOf('D:(A;;0x40;;;AU)'), ['S-1-5-11'], 'delete what is in it');
  assert.deepStrictEqual(writersOf('D:(A;;SD;;;AU)'), ['S-1-5-11'], 'delete it');
  assert.deepStrictEqual(writersOf('D:(A;;WD;;;AU)'), ['S-1-5-11'], 'change who may do what');
  assert.deepStrictEqual(writersOf('D:(A;;WO;;;AU)'), ['S-1-5-11'], 'take it over');
  assert.deepStrictEqual(writersOf('D:(A;;GW;;;AU)'), ['S-1-5-11']);
  assert.deepStrictEqual(writersOf('D:(A;;GA;;;AU)'), ['S-1-5-11']);
  assert.deepStrictEqual(writersOf('D:(A;;GR;;;AU)(A;;GX;;;AU)(A;;FRFX;;;BU)(A;;RC;;;BU)(A;;0x1;;;WD)'), [], 'read, list, run, read the permissions');
  assert.deepStrictEqual(writersOf('D:(A;OICIIO;FA;;;CO)(A;OICIIO;FA;;;WD)'), [], 'entries that apply to what is inside, not to the folder itself');
  assert.deepStrictEqual(writersOf('D:(D;;FA;;;WD)(A;;FA;;;SY)'), [], 'a denial grants nothing');
  assert.deepStrictEqual(writersOf('D:(A;;FA;;;DA)'), ['DA'], 'a principal that is not recognised is not trusted, and is named as it was written');
  assert.deepStrictEqual(writersOf('D:(A;;FA;;;PS)'), ['S-1-5-10'], 'nor is the principal a program runs as for itself');
  assert.deepStrictEqual(writersOf('D:(XA;;FA;;;WD;(@User.Title=="PM"))'), ['S-1-1-0'], 'a conditional grant counts');
  assert.deepStrictEqual(writersOf(`D:(A;;FA;;;${OTHER})(A;;FW;;;${OTHER})(A;;FA;;;AU)`), [OTHER, 'S-1-5-11'], 'each once');
  assert.ok(WRITE_RIGHTS & 0x2 && WRITE_RIGHTS & 0x4 && WRITE_RIGHTS & 0x40 && WRITE_RIGHTS & 0x10000 && WRITE_RIGHTS & 0x40000 && WRITE_RIGHTS & 0x80000);
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

// The programs of Windows, as the module starts them, stood in for: `whoami` answers the user, `icacls /save <file>` writes the list as it does — in UTF-16, to a file.
function fakeWindows({ sddl, sid = USER, bom = false, whoami, icacls } = {}) {
  const calls = [];
  const run = (name, args, options, runDeps) => {
    calls.push({ name, args, options, runDeps });
    if (name === 'whoami') return whoami ? whoami() : { status: 0, stdout: `"DOMAIN\\user","${sid}"\r\n`, stderr: '' };
    if (name === 'icacls') {
      if (icacls) return icacls(args);
      const file = args[args.indexOf('/save') + 1];
      fs.writeFileSync(file, Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(`parent\r\n${sddl}\r\n\r\n`, 'utf16le')]));
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

test('windowsFolderIsPrivate: private when only this user, the system and the administrators can change the folder — and nothing is left behind', (t) => {
  const tmp = scratchTemp(t);
  for (const bom of [false, true]) {
    const { run, calls } = fakeWindows({ sddl: `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})`, bom });
    const verdict = windowsFolderIsPrivate('C:\\Temp\\power-platform-skills-model-apps', { run, saveIn: tmp, env: { Path: 'C:\\x', SystemRoot: 'C:\\Windows' } });
    assert.strictEqual(verdict.ok, true, `${bom ? 'with' : 'without'} a byte-order mark: ${verdict.reason}`);
    assert.deepStrictEqual(calls.map((c) => c.name), ['whoami', 'icacls']);
    assert.deepStrictEqual(calls[0].args, ['/user', '/fo', 'csv', '/nh']);
    assert.strictEqual(calls[1].args[0], 'C:\\Temp\\power-platform-skills-model-apps');
    assert.strictEqual(calls[1].args[1], '/save');
    assert.ok(path.dirname(calls[1].args[2]) === tmp, 'the list is saved to a file in the temp folder');
    assert.ok(calls.every((c) => c.options.timeout > 0 && c.options.windowsHide === true), 'bounded, and no console window');
    // Looked up with System32 first on PATH, as the process runner looks up taskkill: no earlier folder can stand in for the program.
    assert.ok(calls.every((c) => /^C:\\Windows\\System32;/i.test(c.runDeps.env.PATH)), calls[0].runDeps.env.PATH);
    assert.deepStrictEqual(fs.readdirSync(tmp), [], 'the saved list is removed');
  }
  // A user whose account is the machine's own Administrator (a CI runner's, renamed) reads back as LA in the list, and the folder is still theirs alone.
  const asAdministrator = fakeWindows({ sddl: 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)', sid: 'S-1-5-21-1111111111-2222222222-3333333333-500' });
  const named = windowsFolderIsPrivate('C:\\Temp\\p', { run: asAdministrator.run, saveIn: tmp });
  assert.strictEqual(named.ok, true, named.reason);
  const asUser = fakeWindows({ sddl: 'D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)', sid: USER });
  assert.strictEqual(windowsFolderIsPrivate('C:\\Temp\\p', { run: asUser.run, saveIn: tmp }).ok, false, 'the same list is not private to a user who is not that account');
});

test('windowsFolderIsPrivate: not private when anyone else can change the folder, and the reason names who', (t) => {
  const tmp = scratchTemp(t);
  const verdictFor = (sddl) => windowsFolderIsPrivate('C:\\Temp\\p', { run: fakeWindows({ sddl }).run, saveIn: tmp });
  const everyone = verdictFor(`D:(A;OICI;FA;;;SY)(A;OICI;0x1301bf;;;WD)(A;OICI;FA;;;${USER})`);
  assert.strictEqual(everyone.ok, false);
  assert.match(everyone.reason, /S-1-1-0/);
  assert.strictEqual(verdictFor(`D:(A;OICI;FA;;;${OTHER})`).ok, false, 'another user');
  assert.strictEqual(verdictFor('D:(A;;FW;;;BU)').ok, false, 'Users may add to it');
  assert.strictEqual(verdictFor(`D:(A;OICI;FRFX;;;BU)(A;OICI;FA;;;${USER})`).ok, true, 'Users may only read it');
  assert.deepStrictEqual(fs.readdirSync(tmp), []);
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
// kind: a program that cannot be started, a SID that cannot be read, a list that is not understood and a folder others can change are all final.
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
  assert.deepStrictEqual([verdictOf(fakeWindows({ sddl: ok })).ok, verdictOf(fakeWindows({ sddl: ok })).unreadable], [true, undefined]);
  assert.deepStrictEqual(fs.readdirSync(tmp), [], 'nothing is left behind');
});

test('REAL ICACLS (Windows): a folder only this user can change is private; granting Everyone modify makes it not; taking the grant away makes it private again; a folder that is not there is not', { skip: process.platform !== 'win32' && 'Windows access control lists' }, (t) => {
  const root = scratchTemp(t);
  const folder = path.join(root, 'power-platform-skills-model-apps');
  fs.mkdirSync(folder);
  const icacls = (...args) => { const r = spawnSync('icacls', args, { encoding: 'utf8', windowsHide: true }); assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`); };
  // The list is set — this user, and no one else — and not left to the machine's temp folder. (For a user who is the machine's own Administrator, renamed, SDDL writes the entry as LA.)
  const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).stdout)[1];
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
