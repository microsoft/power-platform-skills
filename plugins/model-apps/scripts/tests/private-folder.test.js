'use strict';
// A folder, and a file in it, that only the current user can use (lib/private-folder.js): the settings copy the pac import fallback is given holds values the maker has not shared, and a temporary folder is
// the least private place there is — what it grants is inherited by everything made inside it. The Windows route runs `whoami` and `icacls` through the process runner, so it is tested here with a stand-in for
// the runner that answers as those two programs do (their real output, as measured: the SDDL `icacls /save` writes, the CSV line `whoami /user` prints), on every platform; the POSIX route with a stand-in for
// the file system, for the cases a real one will not give on demand; and the real thing, where the platform has it, in solution-settings-snapshot.test.js (Windows access lists) and below (permission bits).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPrivateFile, lockDownFolder, parseUserSid, ownerOnlyProblem, spellingOf } = require('../lib/private-folder.js');
const { spawnSync } = require('node:child_process');

const SID = 'S-1-12-1-1111111111-2222222222-3333333333-4444444444';
// The domain SID of the machine the tests pretend to run on, and of a domain (or another machine) that is not it: an account of a machine or a domain is that SID and a relative id (RID), and the same RID —
// 500 for the Administrator, 501 for the Guest — is in every one of them.
const MACHINE = 'S-1-5-21-1111111111-2222222222-3333333333';
const FOREIGN = 'S-1-5-21-8888888888-7777777777-6666666666';
const BYTES = Buffer.from('{"EnvironmentVariables":[{"SchemaName":"new_Secret","Value":"synthetic-private-value"}]}');
const WINDOWS = process.platform === 'win32';

const dirs = [];
function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-folder-test-'));
  dirs.push(dir);
  return dir;
}
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

// --- reading what the tools print --------------------------------------------------------------------------------------------------------------------

test('the SID is the last field of the one CSV line `whoami /user /fo csv /nh` prints — a domain account, a local one, an Azure AD one, a name with quotes in it', () => {
  assert.strictEqual(parseUserSid(`"contoso\\maker","${SID}"\r\n`), SID);
  assert.strictEqual(parseUserSid('"DESKTOP-ABC123\\maker","S-1-5-21-1111111111-2222222222-3333333333-1001"'), 'S-1-5-21-1111111111-2222222222-3333333333-1001');
  assert.strictEqual(parseUserSid('"NT AUTHORITY\\SYSTEM","S-1-5-18"\n'), 'S-1-5-18');
  assert.strictEqual(parseUserSid('"CONTOSO\\the ""quoted"" one","S-1-5-21-1-2-3-500"'), 'S-1-5-21-1-2-3-500', 'a quote in the name is doubled, as CSV writes it');
});

test('anything else is no SID — empty output, a header, two lines, a third column, a SID that is not one, text around it', () => {
  for (const output of ['', '\r\n', '"UserName","SID"', `"a\\b","${SID}"\n"c\\d","${SID}"`, `"a\\b","${SID}","extra"`, '"a\\b","S-1-"', '"a\\b","S-2-5-21-1"', '"a\\b","not-a-sid"', `x "a\\b","${SID}"`, `"a\\b","${SID}" y`, undefined, null]) {
    assert.strictEqual(parseUserSid(output), null, JSON.stringify(output));
  }
});

// What `icacls <path> /save <file>` writes (UTF-16, no byte order mark): the object's name, then its security descriptor, as measured on a folder and on a file made inside it.
const FOLDER_ACL = (sid = SID) => `D:PAI(A;OICI;FA;;;${sid})`;
const FILE_ACL = (sid = SID) => `D:AI(A;ID;FA;;;${sid})`;

test('an access list is the user\'s alone when it is protected, has exactly one entry, and that entry allows full control to the SID — the shapes icacls writes for a folder and for a file', () => {
  assert.strictEqual(ownerOnlyProblem(FOLDER_ACL(), SID, { folder: true }), null);
  assert.strictEqual(ownerOnlyProblem(FILE_ACL(), SID, { folder: false }), null);
  assert.strictEqual(ownerOnlyProblem(`some-name\r\n${FOLDER_ACL()}\r\n`, SID, { folder: true }), null, 'as the whole text of a /save file, name and all');
  assert.strictEqual(ownerOnlyProblem(`D:P(A;OICI;FA;;;${SID.toLowerCase()})`, SID, { folder: true }), null, 'the SID in any case');
  assert.strictEqual(ownerOnlyProblem('D:PAI(A;CIOI;FA;;;SY)', 'S-1-5-18', { folder: true }), null, 'a service account\'s SID is written as its alias');
  assert.strictEqual(ownerOnlyProblem('D:AI(A;ID;FA;;;LS)', 'S-1-5-19', { folder: false }), null);
  assert.strictEqual(ownerOnlyProblem('D:PAI(A;OICI;0x1f01ff;;;NS)', 'S-1-5-20', { folder: true }), null, 'full control spelled as its number');
  assert.strictEqual(ownerOnlyProblem(`D:AI(A;;FA;;;${SID})`, SID, { folder: false }), null, 'a file\'s entry that is not marked inherited is just as much the user\'s');
  // A domain's Administrator is written in full, which the SID itself covers. (The machine's own Administrator and Guest are written as aliases, LA and LG: see the tests of the aliases below.)
  assert.strictEqual(ownerOnlyProblem('D:PAI(A;OICI;FA;;;S-1-5-21-1111111111-2222222222-3333333333-500)', 'S-1-5-21-1111111111-2222222222-3333333333-500', { folder: true }), null);
});

test('every other access list is a problem, and says which: more entries, another account, less than full control, a deny entry, an unprotected folder, a missing list, a shape it does not read', () => {
  const problem = (text, options = { folder: true }) => ownerOnlyProblem(text, SID, options);
  assert.match(problem(`D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${SID})`), /3 entries/);
  assert.match(problem(`D:PAI(A;OICI;FA;;;${SID})(A;OICI;0x1200a9;;;BU)`), /2 entries/);
  assert.match(problem('D:PAI'), /0 entries/);
  assert.match(problem('D:PAI(A;OICI;FA;;;BU)'), /not the current user's/);
  assert.match(problem('D:PAI(A;OICI;FA;;;S-1-5-21-9-9-9-9)'), /not the current user's/);
  assert.match(problem(`D:PAI(A;OICI;0x1200a9;;;${SID})`), /not full control/);
  assert.match(problem(`D:PAI(D;OICI;FA;;;${SID})`), /not an allow entry/);
  assert.match(problem(`D:AI(A;OICI;FA;;;${SID})`), /inherits access from its parent/, 'a folder whose list is not protected takes what its parent grants');
  assert.match(problem(`D:PAI(A;;FA;;;${SID})`), /flags/, 'a folder entry that its files would not inherit');
  assert.match(problem(`D:PAI(A;OICIID;FA;;;${SID})`), /flags/, 'a folder\'s entry that is itself inherited');
  assert.match(problem(`D:AI(A;OICI;FA;;;${SID})`, { folder: false }), /flags/, 'a file with an entry that inherits further');
  assert.match(problem(`D:PAI(A;OICI;FA;;;${SID})(XA;;FA;;;WD;(@User.x==1))`), /does not read/, 'an entry with a condition in it is not read, and so not accepted');
  assert.match(problem('some-name only'), /missing/);
  assert.match(problem(''), /missing/);
  assert.match(problem(undefined), /missing/);
  assert.match(problem(`O:${SID}`), /missing/, 'a descriptor with no DACL grants everyone access');
  // An alias is accepted only for the account it stands for: LA is the machine's Administrator, LG its Guest, SY the system. A machine that says it writes the user as that alias changes nothing for an account
  // the alias cannot stand for.
  const aliasFor = (alias, sid) => ownerOnlyProblem(`D:PAI(A;OICI;FA;;;${alias})`, sid, { folder: true, machineSpelling: () => alias });
  assert.match(aliasFor('LA', `${MACHINE}-1001`), /not the current user's/, 'an ordinary local user is not the Administrator');
  assert.match(aliasFor('LA', SID), /not the current user's/, 'nor is an Azure AD user');
  assert.match(aliasFor('LA', `${MACHINE}-501`), /not the current user's/, 'the Guest account is not the Administrator');
  assert.match(aliasFor('LG', `${MACHINE}-500`), /not the current user's/, 'and the Administrator is not the Guest');
  assert.match(aliasFor('SY', `${MACHINE}-500`), /not the current user's/, 'nor the system');
  assert.match(aliasFor('LA', 'S-1-5-18'), /not the current user's/, 'the system is not the Administrator');
});

// --- the aliases of a machine's own accounts ---------------------------------------------------------------------------------------------------------

// `icacls /save` writes the machine's own Administrator and Guest as LA and LG: the administrator account of a virtual machine or a CI runner IS the built-in one, renamed, so the list the check reads back for its
// user names it by an alias. Which SID an alias stands for is the MACHINE's to say — LA is the RID-500 account of the machine's own domain, and a domain's Administrator, or another machine's, has the same RID
// and is written in full — so the check does not work it out from the SID: it asks the machine how it writes the user's SID (`machineSpelling`), and accepts the alias only when it is the same.
const spells = (spelling) => () => spelling;

test('the machine\'s own Administrator and Guest, read back as LA and LG, are the current user when the machine itself writes the user\'s SID as that alias', () => {
  assert.strictEqual(ownerOnlyProblem('D:PAI(A;OICI;FA;;;LA)', `${MACHINE}-500`, { folder: true, machineSpelling: spells('LA') }), null, 'the Administrator, read back as LA');
  assert.strictEqual(ownerOnlyProblem('D:AI(A;ID;FA;;;LA)', `${MACHINE}-500`, { folder: false, machineSpelling: spells('LA') }), null, 'a file\'s list too');
  assert.strictEqual(ownerOnlyProblem('D:PAI(A;OICI;FA;;;LG)', `${MACHINE}-501`, { folder: true, machineSpelling: spells('LG') }), null, 'and the Guest account, as LG');
  assert.strictEqual(ownerOnlyProblem('D:PAI(A;OICI;FA;;;la)', `${MACHINE}-500`, { folder: true, machineSpelling: spells('LA') }), null, 'in any case');
});

test('an alias is NOT the current user because the RID matches: another domain\'s Administrator and Guest have the same RIDs, the machine writes them in full, and the alias then names an account that is not the user', () => {
  for (const [alias, rid] of [['LA', 500], ['LG', 501]]) {
    const foreign = `${FOREIGN}-${rid}`;
    const descriptor = `D:PAI(A;OICI;FA;;;${alias})`;
    assert.match(ownerOnlyProblem(descriptor, foreign, { folder: true, machineSpelling: spells(foreign) }), /not the current user's/, `${alias} is not ${foreign}: the machine writes that in full`);
    assert.match(ownerOnlyProblem(`D:AI(A;ID;FA;;;${alias})`, foreign, { folder: false, machineSpelling: spells(foreign) }), /not the current user's/, 'a file\'s list too');
    assert.match(ownerOnlyProblem(descriptor, foreign, { folder: true }), /not the current user's/, 'and where the machine cannot be asked the alias is not taken on trust: it fails closed');
  }
  // ...and the alias of the OTHER account, or of none this machine has an alias for, is not accepted either: the alias is compared with how the machine writes THIS user.
  assert.match(ownerOnlyProblem('D:PAI(A;OICI;FA;;;LG)', `${MACHINE}-501`, { folder: true, machineSpelling: spells('LA') }), /not the current user's/);
  assert.match(ownerOnlyProblem('D:PAI(A;OICI;FA;;;LA)', `${MACHINE}-500`, { folder: true, machineSpelling: spells(null) }), /not the current user's/);
});

test('the machine is asked only when it is needed: a SID in full, a service account\'s alias, an alias that cannot be the user, and a list that is wrong anyway never ask', () => {
  let asked = 0;
  const machineSpelling = () => { asked += 1; return 'LA'; };
  const problem = (text, sid, folder = true) => ownerOnlyProblem(text, sid, { folder, machineSpelling });
  assert.strictEqual(problem(FOLDER_ACL(), SID), null);
  assert.strictEqual(problem(`D:PAI(A;OICI;FA;;;${MACHINE}-500)`, `${MACHINE}-500`), null, 'in full');
  assert.strictEqual(problem('D:PAI(A;OICI;FA;;;SY)', 'S-1-5-18'), null, 'a service account has the same alias on every machine');
  assert.match(problem('D:PAI(A;OICI;FA;;;LA)', `${MACHINE}-1001`), /not the current user's/, 'RID 1001 is not 500');
  assert.match(problem('D:PAI(A;OICI;FA;;;LA)', SID), /not the current user's/, 'an Azure AD account is not a RID of a machine at all');
  assert.match(problem('D:PAI(A;OICI;FA;;;LG)', `${MACHINE}-500`), /not the current user's/, 'LG is the RID 501');
  assert.match(problem('D:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;BU)', `${MACHINE}-500`), /2 entries/, 'a second entry is a problem whatever the first is');
  assert.match(problem('D:AI(A;OICI;FA;;;LA)', `${MACHINE}-500`), /inherits/, 'an unprotected folder is a problem whatever its entry is');
  assert.strictEqual(asked, 0, 'the machine was never asked');
  assert.strictEqual(problem('D:PAI(A;OICI;FA;;;LA)', `${MACHINE}-500`), null);
  assert.strictEqual(asked, 1, 'but for a list that names the RID-500 account as LA it is');
});

// --- Windows: the sequence --------------------------------------------------------------------------------------------------------------------------

// A stand-in for the process runner's spawnResultSync that answers as `whoami` and `icacls` do. `calls` is what it was asked; `onSave(target)` says what the access list of a path is when it is saved.
// `spellings` is how the pretended machine writes accounts in an access list, SID by SID (`{ [SID]: 'LA' }`; a SID that is not in it is written in full). The check asks the machine by granting the user's SID to a
// file that holds nothing — `access-list-probe-*.tmp`, in the private folder — and saving its list, and the stand-in answers that from `spellings`.
function windowsRunner({ dir, sid = SID, whoami, steps, saveError, folderAcl = FOLDER_ACL(sid), fileAcl = FILE_ACL(sid), observe = () => {}, spellings = {}, probeAcl } = {}) {
  const calls = [];
  let saves = 0;
  const granted = new Map();
  const run = (name, args, options, lookup) => {
    calls.push({ name, args, options, lookup });
    if (name === 'whoami') return whoami ? whoami(args) : { status: 0, stdout: `"CONTOSO\\maker","${sid}"\r\n`, stderr: '' };
    assert.strictEqual(name, 'icacls');
    const [target, ...rest] = args;
    const probe = path.basename(target).startsWith('access-list-probe-');
    if (rest[0] === '/grant:r') granted.set(target, /^\*([^:]+):/.exec(rest[1])[1]);
    if (rest[0] === '/save') {
      saves += 1;
      observe({ target, saves, probe });
      if (saveError) {
        const failure = saveError(saves);
        if (failure) return failure;
      }
      const account = probe ? granted.get(target) : undefined;
      const text = probe ? probeAcl || `D:PAI(A;;FA;;;${spellings[account] || account})` : target === dir ? folderAcl : fileAcl;
      fs.writeFileSync(rest[1], Buffer.from(`${path.basename(target)}\r\n${text}\r\n`, 'utf16le'));
      return { status: 0, stdout: `processed file: ${target}\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`, stderr: '' };
    }
    if (steps) return steps(rest, calls.length, target);
    return { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files', stderr: '' };
  };
  return { run, calls };
}
const WIN_ENV = { SystemRoot: 'C:\\Windows', PATH: 'C:\\evil;C:\\Windows\\System32;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

test('Windows: the folder is reset to its inherited list, stripped of what it inherited, and granted to the current user alone — in that order — and its list is read back before a file exists', () => {
  const dir = folder();
  const seen = [];
  const { run, calls } = windowsRunner({ dir, observe: ({ target }) => seen.push([target === dir ? 'folder' : 'file', fs.readdirSync(dir)]) });
  lockDownFolder(dir, { platform: 'win32', run, env: WIN_ENV });
  const shape = (call) => [call.name, ...(call.name === 'whoami' ? call.args : call.args[1] === '/save' ? ['/save'] : call.args.slice(1))];
  assert.deepStrictEqual(calls.map(shape), [
    ['whoami', '/user', '/fo', 'csv', '/nh'],
    ['icacls', '/reset'],
    ['icacls', '/inheritance:r'],
    ['icacls', '/grant:r', `*${SID}:(OI)(CI)F`],
    ['icacls', '/save'],
  ]);
  assert.ok(calls.slice(1).every((c) => c.args[0] === dir), 'every icacls step is about the folder');
  assert.deepStrictEqual(seen, [['folder', []]], 'when the list is read back the folder is still empty');
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'and the file it was read into is removed');
});

test('Windows: the tools are looked up in the Windows folder\'s System32 and nowhere else — never the PATH, never the current folder — and run without a shell or a window', () => {
  const dir = folder();
  const { run, calls } = windowsRunner({ dir });
  lockDownFolder(dir, { platform: 'win32', run, env: WIN_ENV });
  for (const call of calls) {
    assert.deepStrictEqual(call.lookup, { platform: 'win32', env: { PATH: 'C:\\Windows\\System32', PATHEXT: '.EXE', SystemRoot: 'C:\\Windows' } }, `${call.name}: looked up in System32 alone, an .exe`);
    assert.strictEqual(call.options.windowsHide, true);
    assert.ok(call.options.timeout > 0 && call.options.timeout <= 60000, 'bounded');
    assert.strictEqual(call.options.encoding, 'utf8');
    assert.ok(!('shell' in call.options) || call.options.shell === false);
  }
  // The Windows folder is the one the environment names — SystemRoot, else windir, else C:\Windows — and that folder's own spelling is kept.
  const other = windowsRunner({ dir });
  lockDownFolder(dir, { platform: 'win32', run: other.run, env: { windir: 'D:\\Win', PATH: 'C:\\evil' } });
  assert.strictEqual(other.calls[0].lookup.env.PATH, 'D:\\Win\\System32');
  const bare = windowsRunner({ dir });
  lockDownFolder(dir, { platform: 'win32', run: bare.run, env: {} });
  assert.strictEqual(bare.calls[0].lookup.env.PATH, 'C:\\Windows\\System32');
});

test('Windows: a file is created exclusively, EMPTY, and its access list is read back before the first byte is written — the bytes are written last', () => {
  const dir = folder();
  const states = [];
  const { run } = windowsRunner({ dir, observe: ({ target, saves }) => states.push({ saves, target: target === dir ? 'folder' : 'file', files: fs.readdirSync(dir).filter((name) => !name.endsWith('.tmp')), size: target === dir ? null : fs.statSync(target).size }) });
  const file = createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV });
  assert.strictEqual(file, path.join(dir, 'settings.json'));
  assert.deepStrictEqual(states, [
    { saves: 1, target: 'folder', files: [], size: null },
    { saves: 2, target: 'file', files: ['settings.json'], size: 0 },
  ]);
  assert.ok(fs.readFileSync(file).equals(BYTES), 'then the bytes');
  assert.deepStrictEqual(fs.readdirSync(dir), ['settings.json'], 'nothing else is left in the folder');
});

test('Windows: a name that is already there is never written through — `wx` refuses it — and nothing is written', () => {
  const dir = folder();
  fs.writeFileSync(path.join(dir, 'settings.json'), 'somebody else\'s');
  const { run } = windowsRunner({ dir });
  assert.throws(() => createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV }), (error) => error.code === 'EEXIST');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), 'somebody else\'s');
});

test('the file name is a name, not a path: nothing that leaves the folder is made', () => {
  const dir = folder();
  const { run } = windowsRunner({ dir });
  for (const name of ['', '..', '.', 'a/b.json', 'a\\b.json', path.join(dir, 'x.json'), 'x\u0000.json']) {
    assert.throws(() => createPrivateFile(dir, name, BYTES, { platform: 'win32', run, env: WIN_ENV }), (error) => error.code === 'PRIVATE_FOLDER' && /a plain file name/.test(error.reason), JSON.stringify(name));
  }
});

// What fails closed: nothing is written, the reason is the plugin's own words — a tool, a number — and never a path, a value or the tool's own text.
const refused = (fn) => (error) => error.code === 'PRIVATE_FOLDER' && typeof error.reason === 'string' && !/[()]/.test(error.reason) && fn(error);
test('Windows: when the current user cannot be identified, nothing is done to the folder and nothing is written', () => {
  const failures = [
    ['whoami cannot be started', () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn whoami ENOENT'), { code: 'ENOENT' }) }), /whoami could not be started: ENOENT/],
    ['whoami exits 1', () => ({ status: 1, stdout: '', stderr: 'ERROR: boom' }), /whoami exited 1/],
    ['whoami prints something else', () => ({ status: 0, stdout: 'maker\r\n', stderr: '' }), /current user's SID/],
    ['whoami prints two accounts', () => ({ status: 0, stdout: `"a\\b","${SID}"\r\n"c\\d","${SID}"\r\n`, stderr: '' }), /current user's SID/],
  ];
  for (const [what, whoami, reason] of failures) {
    const dir = folder();
    const { run, calls } = windowsRunner({ dir, whoami });
    assert.throws(() => createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV }), refused((error) => reason.test(error.reason)), what);
    assert.deepStrictEqual(calls.map((c) => c.name), ['whoami'], `${what}: icacls was not run`);
    assert.deepStrictEqual(fs.readdirSync(dir), [], `${what}: no file`);
  }
});

test('Windows: when a step that sets the access list fails — icacls cannot be started, or exits with a status — it stops there, no file is made, and the failure says which step and what status', () => {
  const steps = ['/reset', '/inheritance:r', '/grant:r'];
  steps.forEach((step, index) => {
    for (const [what, answer, reason] of [
      ['exits 5', () => ({ status: 5, stdout: 'Access is denied.', stderr: '' }), new RegExp(`icacls ${step} exited 5`)],
      ['cannot be started', () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn icacls ENOENT'), { code: 'ENOENT' }) }), new RegExp(`icacls ${step} could not be started: ENOENT`)],
    ]) {
      const dir = folder();
      const { run, calls } = windowsRunner({ dir, steps: (rest) => (rest[0] === step ? answer() : { status: 0, stdout: '', stderr: '' }) });
      assert.throws(() => createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV }), refused((error) => reason.test(error.reason)), `${step} ${what}`);
      assert.strictEqual(calls.filter((c) => c.name === 'icacls').length, index + 1, `${step} ${what}: the steps after it are not run`);
      assert.deepStrictEqual(fs.readdirSync(dir), [], `${step} ${what}: no file was made`);
    }
  });
});

test('Windows: a folder whose list cannot be read back, or is not the user\'s alone when it is, is refused — fail closed, no file, no bytes', () => {
  const cases = [
    ['/save fails', { saveError: () => ({ status: 3, stdout: '', stderr: '' }) }, /icacls \/save exited 3/],
    ['/save cannot be started', { saveError: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'EACCES' }) }) }, /icacls \/save could not be started: EACCES/],
    ['the system\'s own accounts are still on the list', { folderAcl: `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${SID})` }, /folder's access list has 3 entries/],
    ['the Users group is on it', { folderAcl: `D:PAI(A;OICI;FA;;;${SID})(A;OICI;0x1200a9;;;BU)` }, /folder's access list has 2 entries/],
    ['it still inherits', { folderAcl: `D:AI(A;OICI;FA;;;${SID})` }, /folder's access list inherits access from its parent/],
    ['it is the wrong user\'s', { folderAcl: 'D:PAI(A;OICI;FA;;;BU)' }, /folder's access list.*not the current user's/],
    ['it is empty', { folderAcl: 'D:PAI' }, /folder's access list has 0 entries/],
    ['there is none', { folderAcl: 'O:BAG:BA' }, /folder's access list is missing/],
  ];
  for (const [what, options, reason] of cases) {
    const dir = folder();
    const { run } = windowsRunner({ dir, ...options });
    assert.throws(() => createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV }), refused((error) => reason.test(error.reason)), what);
    assert.deepStrictEqual(fs.readdirSync(dir), [], `${what}: no file was made, so no byte was written`);
  }
});

test('Windows: a file whose list is not the user\'s alone is refused BEFORE its bytes are written — the file stays empty — so a folder that does not hand down its list cannot leak a value', () => {
  for (const [what, fileAcl, reason] of [
    ['it has the Users group on it', `D:AI(A;ID;FA;;;${SID})(A;ID;0x1200a9;;;BU)`, /file's access list has 2 entries/],
    ['it is somebody else\'s', 'D:AI(A;ID;FA;;;BU)', /file's access list.*not the current user's/],
    ['it carries a flag it should not', `D:AI(A;OICI;FA;;;${SID})`, /file's access list.*flags/],
  ]) {
    const dir = folder();
    const { run } = windowsRunner({ dir, fileAcl });
    assert.throws(() => createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV }), refused((error) => reason.test(error.reason)), what);
    assert.strictEqual(fs.statSync(path.join(dir, 'settings.json')).size, 0, `${what}: the file exists and holds nothing`);
  }
});

// --- Windows: the machine is asked how it writes the user, when a list names the user by LA or LG -------------------------------------------------------

const shapeOf = (call) => [call.name, ...(call.name === 'whoami' ? call.args : call.args[1] === '/save' ? ['/save'] : call.args.slice(1))];
const isProbe = (target) => path.basename(target).startsWith('access-list-probe-');
const probeCalls = (calls) => calls.filter((call) => call.name === 'icacls' && isProbe(call.args[0])).map(shapeOf);
const FINE = { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files', stderr: '' };

test('Windows: a user whose list reads back as LA — the machine\'s own Administrator, renamed — is asked about ONCE: the machine is given the SID on a file that holds nothing, the answer serves the folder and the file, and the probe is gone', () => {
  const dir = folder();
  const sid = `${MACHINE}-500`;
  const seen = [];
  const { run, calls } = windowsRunner({
    dir,
    sid,
    folderAcl: 'D:PAI(A;OICI;FA;;;LA)',
    fileAcl: 'D:AI(A;ID;FA;;;LA)',
    spellings: { [sid]: 'LA' },
    observe: ({ target, probe }) => seen.push([probe ? 'probe' : target === dir ? 'folder' : 'file', fs.readdirSync(dir).filter((name) => !/^access-list-\d/.test(name)).map((name) => (name.startsWith('access-list-probe-') ? 'probe' : name))]),
  });
  const file = createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV });
  assert.deepStrictEqual(calls.map(shapeOf), [
    ['whoami', '/user', '/fo', 'csv', '/nh'],
    ['icacls', '/reset'], ['icacls', '/inheritance:r'], ['icacls', '/grant:r', `*${sid}:(OI)(CI)F`], ['icacls', '/save'], // the folder
    ['icacls', '/reset'], ['icacls', '/inheritance:r'], ['icacls', '/grant:r', `*${sid}:F`], ['icacls', '/save'], // the probe: the same steps, the SID alone, no inheritance to hand on
    ['icacls', '/save'], // the file: the answer of the machine is remembered, it is not asked again
  ]);
  assert.strictEqual(probeCalls(calls).length, 4, 'one probe, four steps');
  assert.ok(calls.filter((call) => call.name === 'icacls' && isProbe(call.args[0])).every((call) => path.dirname(call.args[0]) === dir), 'the probe is in the private folder');
  assert.deepStrictEqual(seen, [['folder', []], ['probe', ['probe']], ['file', ['settings.json']]], 'the probe exists only while the machine is asked; the file is made after');
  assert.ok(fs.readFileSync(file).equals(BYTES));
  assert.deepStrictEqual(fs.readdirSync(dir), ['settings.json'], 'nothing else is left in the folder');
});

test('Windows: the Guest account, read back as LG, is the user when the machine writes the user\'s SID as LG', () => {
  const dir = folder();
  const sid = `${MACHINE}-501`;
  const { run } = windowsRunner({ dir, sid, folderAcl: 'D:PAI(A;OICI;FA;;;LG)', fileAcl: 'D:AI(A;ID;FA;;;LG)', spellings: { [sid]: 'LG' } });
  createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV });
  assert.deepStrictEqual(fs.readdirSync(dir), ['settings.json']);
});

for (const [alias, rid] of [['LA', 500], ['LG', 501]]) {
  test(`Windows: a list that reads back as ${alias} is NOT the user's when the machine writes the user's SID in full — another domain's ${alias === 'LA' ? 'Administrator' : 'Guest'} has the same RID ${rid} — and no byte is written`, () => {
    const dir = folder();
    const sid = `${FOREIGN}-${rid}`;
    const { run, calls } = windowsRunner({ dir, sid, folderAcl: `D:PAI(A;OICI;FA;;;${alias})` });
    assert.throws(() => createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV }), refused((error) => /^the folder's access list has an entry that is not the current user's$/.test(error.reason)));
    assert.strictEqual(probeCalls(calls).length, 4, 'the machine was asked');
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'no file was made, and the probe is gone');
  });
}

test('Windows: the machine is asked nothing for a user in full, a service account, or an account the alias cannot stand for — and not for a list that is wrong anyway', () => {
  for (const [what, sid, folderAcl, fileAcl] of [
    ['an ordinary user', SID, FOLDER_ACL(SID), FILE_ACL(SID)],
    ['a domain account written in full', `${MACHINE}-500`, FOLDER_ACL(`${MACHINE}-500`), FILE_ACL(`${MACHINE}-500`)],
    ['LocalSystem, which is SY on every machine', 'S-1-5-18', 'D:PAI(A;OICI;FA;;;SY)', 'D:AI(A;ID;FA;;;SY)'],
  ]) {
    const dir = folder();
    const { run, calls } = windowsRunner({ dir, sid, folderAcl, fileAcl });
    createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV });
    assert.deepStrictEqual(probeCalls(calls), [], what);
  }
  for (const [what, sid, folderAcl] of [
    ['LA for an account that is not RID 500', `${MACHINE}-1001`, 'D:PAI(A;OICI;FA;;;LA)'],
    ['LA for an Azure AD account', SID, 'D:PAI(A;OICI;FA;;;LA)'],
    ['LG for the Administrator', `${MACHINE}-500`, 'D:PAI(A;OICI;FA;;;LG)'],
    ['LA beside another entry', `${MACHINE}-500`, 'D:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;BU)'],
    ['LA in a folder that inherits', `${MACHINE}-500`, 'D:AI(A;OICI;FA;;;LA)'],
  ]) {
    const dir = folder();
    const { run, calls } = windowsRunner({ dir, sid, folderAcl });
    assert.throws(() => createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV }), refused(() => true), what);
    assert.deepStrictEqual(probeCalls(calls), [], what);
  }
});

test('Windows: when the machine cannot be asked about the account — icacls refuses the SID, cannot be started, or the probe cannot be read back — the copy is not made, the reason is the tool and the step, and the probe is gone', () => {
  const sid = `${MACHINE}-500`;
  const cases = [
    ['icacls refuses the SID', { steps: (rest, n, target) => (isProbe(target) && rest[0] === '/grant:r' ? { status: 1332, stdout: 'No mapping between account names and security IDs was done.', stderr: '' } : FINE) }, /^icacls \/grant:r on the probe exited 1332$/],
    ['icacls cannot reset the probe', { steps: (rest, n, target) => (isProbe(target) && rest[0] === '/reset' ? { status: 5, stdout: 'Access is denied.', stderr: '' } : FINE) }, /^icacls \/reset on the probe exited 5$/],
    ['icacls cannot be started for the probe', { steps: (rest, n, target) => (isProbe(target) && rest[0] === '/inheritance:r' ? { status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'EACCES' }) } : FINE) }, /^icacls \/inheritance:r on the probe could not be started: EACCES$/],
    ['the probe\'s list cannot be saved', { saveError: (saves) => (saves === 2 ? { status: 3, stdout: '', stderr: '' } : undefined) }, /^icacls \/save exited 3$/],
  ];
  for (const [what, options, reason] of cases) {
    const dir = folder();
    const { run } = windowsRunner({ dir, sid, folderAcl: 'D:PAI(A;OICI;FA;;;LA)', spellings: { [sid]: 'LA' }, ...options });
    assert.throws(() => createPrivateFile(dir, 'settings.json', BYTES, { platform: 'win32', run, env: WIN_ENV }), refused((error) => reason.test(error.reason)), what);
    assert.deepStrictEqual(fs.readdirSync(dir), [], `${what}: no file was made, and no probe is left`);
  }
});

test('spellingOf: how the machine writes an account — the one entry its list holds — and null when what it wrote is not one allow entry of full control', () => {
  const sid = `${MACHINE}-500`;
  const ask = (options) => {
    const dir = folder();
    const answer = spellingOf(sid, dir, { run: windowsRunner({ dir, ...options }).run, env: WIN_ENV });
    assert.deepStrictEqual(fs.readdirSync(dir), [], 'the probe is removed each time');
    return answer;
  };
  assert.strictEqual(ask({ spellings: { [sid]: 'LA' } }), 'LA');
  assert.strictEqual(ask({}), sid, 'an account of another domain is written in full');
  // A probe whose list is not that of one entry has said nothing that can be compared.
  for (const [what, probeAcl] of [
    ['two entries', 'D:PAI(A;;FA;;;LA)(A;;FA;;;SY)'],
    ['a deny entry', 'D:PAI(D;;FA;;;LA)'],
    ['less than full control', 'D:PAI(A;;0x1200a9;;;LA)'],
    ['no list', 'O:BAG:BA'],
    ['an entry with a condition', 'D:PAI(A;;FA;;;LA)(XA;;FA;;;WD;(@User.x==1))'],
  ]) assert.strictEqual(ask({ probeAcl }), null, what);
});

test('spellingOf asks only about a SID: nothing else is ever given to icacls', () => {
  const dir = folder();
  const { run, calls } = windowsRunner({ dir });
  for (const bad of ['', 'Administrator', 'S-1-', '*S-1-5-18', 'S-1-5-18:F', 'S-1-5-18 /grant', undefined, null, 5]) {
    assert.throws(() => spellingOf(bad, dir, { run, env: WIN_ENV }), refused((error) => /not a SID/.test(error.reason)), JSON.stringify(bad));
  }
  assert.deepStrictEqual(calls, [], 'no tool was started');
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'and no file was made');
});

// --- Windows, the real tools: how THIS machine writes its own accounts -----------------------------------------------------------------------------------

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
// The SIDs of the accounts SDDL calls LA, LG and SY, and of the user running this process, as the operating system itself resolves them: .NET's reader of SDDL turns the ALIAS into its SID — not `icacls`, which the
// code under test uses, and not the RID, which is the assumption under test. (A SID is not printed anywhere: the values stay in this process.)
let nativeAccounts;
function accountsOfThisMachine() {
  if (!nativeAccounts) {
    const sddl = (alias) => `(New-Object System.Security.AccessControl.RawSecurityDescriptor 'D:(A;;FA;;;${alias})').DiscretionaryAcl[0].SecurityIdentifier.Value`;
    const script = ['$ErrorActionPreference = "Stop"', '$r = @{}', ...['LA', 'LG', 'SY'].map((alias) => `$r.${alias} = ${sddl(alias)}`), '$r.me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value', 'ConvertTo-Json -Compress -InputObject $r'].join('; ');
    const run = spawnSync(path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(run.status, 0, run.stderr);
    nativeAccounts = JSON.parse(run.stdout);
  }
  return nativeAccounts;
}
// The access list the real `icacls` writes for a FILE that is granted to `sid` alone — made apart from the code under test, with the tool itself.
let lists = 0;
function listWrittenFor(sid, scratch) {
  lists += 1;
  const file = path.join(scratch, `list-for-account-${lists}.tmp`);
  const saved = `${file}.acl`;
  fs.writeFileSync(file, '', { flag: 'wx' });
  try {
    for (const step of [['/reset'], ['/inheritance:r'], ['/grant:r', `*${sid}:F`]]) {
      const done = spawnSync(path.join(SYSTEM32, 'icacls.exe'), [file, ...step], { encoding: 'utf8' });
      assert.strictEqual(done.status, 0, `${step[0]}: ${done.stdout}${done.stderr}`);
    }
    const done = spawnSync(path.join(SYSTEM32, 'icacls.exe'), [file, '/save', saved], { encoding: 'utf8' });
    assert.strictEqual(done.status, 0, done.stdout + done.stderr);
    return fs.readFileSync(saved).toString('utf16le');
  } finally {
    // The file's list names only `sid`, which is not the user running this process: it is handed back to what the folder gives (`/reset`, the user's entry) so that the user may delete it. The owner of a file can always do that.
    spawnSync(path.join(SYSTEM32, 'icacls.exe'), [file, '/reset'], { encoding: 'utf8' });
    fs.rmSync(file, { force: true });
    fs.rmSync(saved, { force: true });
  }
}
const NOT_WINDOWS = !WINDOWS && 'access lists and the SDDL aliases are native to Windows';

test('Windows, the real tools: spellingOf finds out how this machine writes its own Administrator and Guest (LA, LG), the system (SY) and the current user — and no probe is left', { skip: NOT_WINDOWS }, () => {
  const accounts = accountsOfThisMachine();
  const dir = folder();
  assert.match(accounts.LA, /^S-1-5-21-\d+-\d+-\d+-500$/, 'fixture: the machine\'s own Administrator is the RID 500 of its own domain');
  assert.match(accounts.LG, /^S-1-5-21-\d+-\d+-\d+-501$/);
  assert.strictEqual(spellingOf(accounts.LA, dir), 'LA');
  assert.strictEqual(spellingOf(accounts.LG, dir), 'LG');
  assert.strictEqual(spellingOf(accounts.SY, dir), 'SY');
  // The user running the tests: in full, or — a CI runner's administrator account IS the machine's own, renamed — as the alias the machine gives that account.
  const me = ['LA', 'LG', 'SY'].find((alias) => accounts[alias] === accounts.me);
  assert.strictEqual(spellingOf(accounts.me, dir), me || accounts.me);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'the probe is removed each time');
});

test('Windows, the real tools: the list icacls really writes for the machine\'s own Administrator or Guest is that account\'s — the alias is read by the SID it stands for, and no other domain\'s Administrator or Guest, with the same RID, is taken for it', { skip: NOT_WINDOWS }, () => {
  const accounts = accountsOfThisMachine();
  const dir = folder();
  const machineSpelling = (sid) => spellingOf(sid, dir);
  for (const [alias, other, rid] of [['LA', 'LG', 500], ['LG', 'LA', 501]]) {
    const text = listWrittenFor(accounts[alias], dir);
    assert.match(text, new RegExp(`\\(A;;FA;;;${alias}\\)`), `fixture: this machine's icacls writes its own ${alias} as the alias`);
    assert.strictEqual(ownerOnlyProblem(text, accounts[alias], { folder: false, machineSpelling }), null, `${alias}: the list is the account's`);
    assert.match(ownerOnlyProblem(text, accounts[other], { folder: false, machineSpelling }), /not the current user's/, `${alias}: it is not the other of the two`);
    if (accounts.me !== accounts[alias]) assert.match(ownerOnlyProblem(text, accounts.me, { folder: false, machineSpelling }), /not the current user's/, `${alias}: nor the user running the tests`);
    // Another domain's account with the same RID: the SID the check would take for the alias if it went by the RID. The machine has no account for it, and icacls refuses it — or, where one does grant it, writes
    // it in full — so that it is not accepted either way.
    const foreign = `${FOREIGN}-${rid}`;
    let verdict;
    try {
      verdict = ownerOnlyProblem(text, foreign, { folder: false, machineSpelling });
    } catch (error) {
      assert.strictEqual(error.code, 'PRIVATE_FOLDER', 'a machine that cannot be asked fails closed with the plugin\'s own error');
      verdict = 'the machine could not be asked';
    }
    assert.ok(verdict, `${alias}: ${foreign} is not the account the list names`);
  }
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'nothing is left');
});

// --- POSIX: the permission bits -------------------------------------------------------------------------------------------------------------------------

// A stand-in for `fs` that behaves as `modes` say: what `chmod` leaves a path at, and what a new file is created with — for the cases a real file system will not give on demand (a mount that ignores chmod,
// a folder that is somebody else's, a link in the folder's place).
function fakeFs({ dirMode = 0o700, chmodKeeps = false, fileMode = 0o600, fchmodKeeps = false, uid = 1000, fileUid = uid, isLink = false, nlink = 1, openError } = {}) {
  const log = [];
  const state = { dirMode, fileMode, written: null };
  const dirStat = () => ({ isSymbolicLink: () => isLink, isDirectory: () => !isLink, mode: 0o040000 | state.dirMode, uid });
  return {
    log,
    state,
    lstatSync: (target) => { log.push(['lstat', target]); return dirStat(); },
    chmodSync: (target, mode) => { log.push(['chmod', target, mode.toString(8)]); if (!chmodKeeps) state.dirMode = mode; },
    openSync: (target, flags, mode) => {
      log.push(['open', target, flags, mode.toString(8)]);
      if (openError) throw openError;
      return 77;
    },
    fchmodSync: (fd, mode) => { log.push(['fchmod', fd, mode.toString(8)]); if (!fchmodKeeps) state.fileMode = mode; },
    fstatSync: (fd) => { log.push(['fstat', fd]); return { isFile: () => true, mode: 0o100000 | state.fileMode, uid: fileUid, nlink }; },
    writeFileSync: (fd, bytes) => { log.push(['write', fd]); state.written = Buffer.from(bytes); },
    closeSync: (fd) => { log.push(['close', fd]); },
  };
}
const POSIX = (fsx, extra = {}) => ({ platform: 'linux', fs: fsx, getuid: () => 1000, ...extra });
const POSIX_DIR = path.join(path.sep, 'tmp', 'solution-settings-AbC123');

test('POSIX: the folder is set to 0700 and the file is created exclusively as 0600 and set to 0600, each read back — the folder before the file exists, the file before its bytes', () => {
  const fsx = fakeFs();
  const file = createPrivateFile(POSIX_DIR, 'settings.json', BYTES, POSIX(fsx));
  assert.strictEqual(file, path.join(POSIX_DIR, 'settings.json'));
  assert.deepStrictEqual(fsx.log, [
    ['lstat', POSIX_DIR],
    ['chmod', POSIX_DIR, '700'],
    ['lstat', POSIX_DIR],
    ['open', file, 'wx', '600'],
    ['fchmod', 77, '600'],
    ['fstat', 77],
    ['write', 77],
    ['close', 77],
  ]);
  assert.ok(fsx.state.written.equals(BYTES));
});

test('POSIX: whatever the folder and the file turn out to be after they were set — wrong bits, somebody else\'s, a link, a second name — is refused with nothing written, and the descriptor is closed', () => {
  const cases = [
    ['a mount that ignores chmod: the folder is 0755', { dirMode: 0o755, chmodKeeps: true }, /folder's permissions are not 0700/, false],
    ['the folder belongs to another user', { uid: 0 }, /folder is not the current user's/, false],
    ['the folder is a link', { isLink: true }, /not a plain folder/, false],
    ['the file keeps the bits it was made with', { fileMode: 0o644, fchmodKeeps: true }, /file's permissions are not 0600/, true],
    ['the file belongs to another user', { fileUid: 0 }, /file is not the current user's/, true],
    ['the file has another name', { nlink: 2 }, /file has another name/, true],
  ];
  for (const [what, options, reason, opened] of cases) {
    const fsx = fakeFs(options);
    assert.throws(() => createPrivateFile(POSIX_DIR, 'settings.json', BYTES, POSIX(fsx)), refused((error) => reason.test(error.reason)), what);
    assert.strictEqual(fsx.state.written, null, `${what}: nothing was written`);
    assert.strictEqual(fsx.log.some((entry) => entry[0] === 'open'), opened, `${what}: the file is made only after the folder passed`);
    assert.strictEqual(fsx.log.some((entry) => entry[0] === 'close'), opened, `${what}: the descriptor that was opened is closed`);
  }
});

test('POSIX: a link in the folder\'s place is looked at BEFORE anything is changed — chmod follows a link, and would change the permissions of what it points at', () => {
  const fsx = fakeFs({ isLink: true });
  assert.throws(() => lockDownFolder(POSIX_DIR, POSIX(fsx)), refused(() => true));
  assert.deepStrictEqual(fsx.log, [['lstat', POSIX_DIR]]);
});

test('POSIX: a name that is already there is not written through — a failure of the system, with its code — and where the system has no user ids the owner is not compared', () => {
  const exists = Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
  const fsx = fakeFs({ openError: exists });
  assert.throws(() => createPrivateFile(POSIX_DIR, 'settings.json', BYTES, POSIX(fsx)), (error) => error === exists);
  assert.strictEqual(fsx.state.written, null);
  const noIds = fakeFs({ uid: 0, fileUid: 0 });
  createPrivateFile(POSIX_DIR, 'settings.json', BYTES, { platform: 'linux', fs: noIds, getuid: undefined });
  assert.ok(noIds.state.written.equals(BYTES));
});

test('POSIX: with the real file system — a folder made 0777, a file made under a hostile umask — the folder is 0700 and the file 0600, owned by the current user, and holds exactly the bytes', { skip: WINDOWS && 'Windows has no permission bits to read' }, (t) => {
  const old = process.umask(0o277);
  t.after(() => process.umask(old));
  const dir = folder();
  fs.chmodSync(dir, 0o777);
  const file = createPrivateFile(dir, 'settings.json', BYTES);
  const [f, d] = [fs.lstatSync(file), fs.lstatSync(dir)];
  assert.deepStrictEqual([f.mode & 0o777, d.mode & 0o777], [0o600, 0o700]);
  assert.deepStrictEqual([f.uid, d.uid], [process.getuid(), process.getuid()]);
  assert.ok(fs.readFileSync(file).equals(BYTES));
  assert.throws(() => createPrivateFile(dir, 'settings.json', BYTES), (error) => error.code === 'EEXIST', 'and a second file by that name is refused');
});
