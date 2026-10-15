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
const { createPrivateFile, lockDownFolder, parseUserSid, ownerOnlyProblem } = require('../lib/private-folder.js');

const SID = 'S-1-12-1-1111111111-2222222222-3333333333-4444444444';
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
});

// --- Windows: the sequence --------------------------------------------------------------------------------------------------------------------------

// A stand-in for the process runner's spawnResultSync that answers as `whoami` and `icacls` do. `calls` is what it was asked; `onSave(target)` says what the access list of a path is when it is saved.
function windowsRunner({ dir, sid = SID, whoami, steps, saveError, folderAcl = FOLDER_ACL(sid), fileAcl = FILE_ACL(sid), observe = () => {} } = {}) {
  const calls = [];
  let saves = 0;
  const run = (name, args, options, lookup) => {
    calls.push({ name, args, options, lookup });
    if (name === 'whoami') return whoami ? whoami(args) : { status: 0, stdout: `"CONTOSO\\maker","${sid}"\r\n`, stderr: '' };
    assert.strictEqual(name, 'icacls');
    const [target, ...rest] = args;
    if (rest[0] === '/save') {
      saves += 1;
      observe({ target, saves });
      if (saveError) return saveError(saves);
      const text = target === dir ? folderAcl : fileAcl;
      fs.writeFileSync(rest[1], Buffer.from(`${path.basename(target)}\r\n${text}\r\n`, 'utf16le'));
      return { status: 0, stdout: `processed file: ${target}\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`, stderr: '' };
    }
    if (steps) return steps(rest, calls.length);
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
