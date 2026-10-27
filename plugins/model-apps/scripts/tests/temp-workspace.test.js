'use strict';
// lib/temp-workspace.js: the one maker of the plugin's throwaway workspace folders, and the sweep of the ones a killed run left. The sweep removes a
// folder — and the page source in it — so the tests spend their words on what it must NOT remove, and on what it does when it is racing live runs.
// Real processes decide what a kill leaves, and race the sweep; the rest is driven through the module's seams, in folders of the test's own.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PARENT_NAME, OWNER_FILE, REMOVING_SUFFIX, CURSOR_FILE, HOLD_PREFIX, LENT_KEEP_MS, LIMITS, workspaceParent, makeTempWorkspace, sweepDeadWorkspaces, sweepWarning, pruneWorkspaceParents,
} = require('../lib/temp-workspace.js');
const { ownerStamp, isOwnerStamp } = require('../lib/process-owner.js');
const { privateTempRoot, tempEnv, startTarget, deadPid, pause, waitUntil } = require('./helpers/kill-target-client.js');
const { systemTool, sddlNamesOf } = require('./helpers/windows-system-tools.js');

const POSIX = process.platform !== 'win32';
const onlyPosix = { skip: !POSIX && 'POSIX modes, owners and links' };

// A temp folder of the test's own, and the `os` that names it, so that nothing the plugin makes is outside it. On Windows an existing plugin's folder is judged by its access list (lib/windows-folder-acl.js), which
// in a folder made in the machine's own temp folder is whatever that machine gives it, and a folder the plugin makes is given a list of its own: the tests of what the maker and the sweep do with a folder of their
// own are not about that machine, so the reader and the maker of that list are stood in for (`folderPrivacy` and `folderProtect`, seams that POSIX ignores) — `realReader` takes the stand-ins away, for the
// few tests that are about the Windows tools.
function tempRoot(t, { realReader = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-ws-'));
  // The retries are for the tests that make hundreds of folders: on Windows a scanner can hold one for a moment when they are all removed at once.
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { root, deps: { os: { tmpdir: () => root }, ...(realReader ? {} : { folderPrivacy: () => ({ ok: true, reason: 'stood in for' }), folderProtect: () => ({ ok: true, reason: 'stood in for' }) }) } };
}
const entriesOf = (dir) => fs.readdirSync(dir).sort();

// A workspace folder as a run leaves it, named as the maker names them — `<prefix><pid>-<random>` — with some page source in it, and (unless `record` is
// null) the owner record `record` says: the text, or an object. `pid` is what the name says (the record's own, by default).
function plant(deps, record, { pid = record && typeof record === 'object' ? record.pid : process.pid, prefix = 'genpage-' } = {}) {
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(parent, `${prefix}${pid}-`));
  fs.mkdirSync(path.join(dir, 'apps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'page.json'), 'the page source');
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{"environment":"https://contoso.crm.dynamics.com"}');
  if (record !== null) fs.writeFileSync(path.join(dir, OWNER_FILE), typeof record === 'string' ? record : JSON.stringify(record));
  return dir;
}
// The record of a run that is gone: a real pid that ended, on this machine.
const goneRecord = () => ownerStamp({ pid: deadPid() });

test('a workspace is made in the plugin\'s own folder of the temp folder, named after the process that made it, with the record of whose it is — private, empty but for the record, and a new one each time', (t) => {
  const { root, deps } = tempRoot(t);
  const dir = makeTempWorkspace('genpage-', deps);
  const parent = workspaceParent(deps);
  assert.ok(path.basename(parent) === PARENT_NAME || path.basename(parent) === `${PARENT_NAME}-${process.getuid()}`, parent);
  assert.strictEqual(path.dirname(parent), root, 'the plugin\'s folder is directly in the temp folder');
  assert.strictEqual(path.dirname(dir), parent, 'and the workspace is directly in it');
  assert.match(path.basename(dir), new RegExp(`^genpage-${process.pid}-[A-Za-z0-9]{6}$`), 'named by its prefix and its pid, so a leftover says whose it was — and a sweep can tell a run that is going without opening the folder');
  assert.deepStrictEqual(entriesOf(dir), [OWNER_FILE], 'the SDK is given a folder with nothing in it but the record');
  const record = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'));
  assert.ok(isOwnerStamp(record));
  assert.deepStrictEqual([record.pid, record.host, record.platform], [process.pid, os.hostname(), process.platform]);
  if (POSIX) {
    assert.strictEqual(fs.statSync(parent).mode & 0o777, 0o700, 'only this user can look in the plugin\'s folder');
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(dir, OWNER_FILE)).mode & 0o777, 0o600);
  }
  const other = makeTempWorkspace('genpage-', deps);
  assert.notStrictEqual(other, dir);
  assert.deepStrictEqual(entriesOf(parent), [path.basename(dir), path.basename(other)].sort());
  // A prefix with numbers of its own is still read right: the pid is the number before mkdtemp's six characters.
  assert.match(path.basename(makeTempWorkspace('model-app-2-', deps)), new RegExp(`^model-app-2-${process.pid}-[A-Za-z0-9]{6}$`));
});

test('where the temp folder is shared between users (POSIX), the user\'s id is in the name of the plugin\'s folder; where it is not (Windows), it is not', (t) => {
  const { deps } = tempRoot(t);
  const name = path.basename(workspaceParent(deps));
  assert.strictEqual(name, process.platform === 'win32' ? PARENT_NAME : `${PARENT_NAME}-${process.getuid()}`);
  assert.strictEqual(path.basename(workspaceParent({ ...deps, uid: 1234 })), `${PARENT_NAME}-1234`);
  assert.strictEqual(path.basename(workspaceParent({ ...deps, uid: null })), PARENT_NAME);
});

test('if the plugin\'s folder cannot be used the workspace is made in the temp folder as before — unrecorded, and never swept', (t) => {
  // A file where the folder should be.
  const a = tempRoot(t);
  fs.writeFileSync(workspaceParent(a.deps), 'in the way');
  const plain = makeTempWorkspace('genpage-', a.deps);
  assert.strictEqual(path.dirname(plain), a.root);
  assert.match(path.basename(plain), /^genpage-[A-Za-z0-9]{6}$/, 'named exactly as fs.mkdtempSync names it');
  assert.deepStrictEqual(fs.readdirSync(plain), [], 'no record: nothing is ever swept from outside the plugin\'s folder');
  assert.strictEqual(fs.readFileSync(workspaceParent(a.deps), 'utf8'), 'in the way', 'and what was in the way is as it was');
  // The temp folder itself that cannot be written is the error it always was, from the same call.
  const b = tempRoot(t);
  assert.throws(() => makeTempWorkspace('genpage-', { os: { tmpdir: () => path.join(b.root, 'missing', 'temp') } }), (e) => e && e.code === 'ENOENT');
});

test('POSIX: a plugin\'s folder that is a link, that others can write to, or that another user owns is not used', onlyPosix, (t) => {
  const link = tempRoot(t);
  const elsewhere = fs.mkdtempSync(path.join(link.root, 'elsewhere-'));
  fs.symlinkSync(elsewhere, workspaceParent(link.deps));
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', link.deps)), link.root, 'a link: made in the temp folder');
  assert.deepStrictEqual(fs.readdirSync(elsewhere), [], 'and nothing was made where the link points');

  const open = tempRoot(t);
  fs.mkdirSync(workspaceParent(open.deps), { mode: 0o777 });
  fs.chmodSync(workspaceParent(open.deps), 0o777);
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', open.deps)), open.root, 'writable by others: anyone could rename an entry in it');

  const theirs = tempRoot(t);
  fs.mkdirSync(workspaceParent({ ...theirs.deps, uid: process.getuid() + 1 }), { mode: 0o700 });
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', { ...theirs.deps, uid: process.getuid() + 1 })), theirs.root, 'owned by another user (the folder is not ours)');
});

test('a prefix that is not a plain name never puts the workspace in the plugin\'s folder', (t) => {
  const { root, deps } = tempRoot(t);
  const asked = [];
  for (const prefix of ['', '../escape-', 'a/b-', 'a\\b-', 'with space-']) {
    const dir = makeTempWorkspace(prefix, { ...deps, mkdtempSync: (start) => { asked.push(start); return fs.mkdtempSync(path.join(root, 'made-')); } });
    assert.strictEqual(path.dirname(dir), root);
  }
  assert.deepStrictEqual(asked, ['', '../escape-', 'a/b-', 'a\\b-', 'with space-'].map((prefix) => path.join(root, prefix)), 'exactly the call it always made');
  assert.ok(!fs.existsSync(workspaceParent(deps)), 'and the plugin\'s folder was not even made');
});

test('the folder is made by the maker the caller gives (a test seam of the page backend and the download), asked for a name inside the plugin\'s folder', (t) => {
  const { deps } = tempRoot(t);
  const asked = [];
  const dir = makeTempWorkspace('genpage-', { ...deps, mkdtempSync: (start) => { asked.push(start); return fs.mkdtempSync(start); } });
  assert.deepStrictEqual(asked, [path.join(workspaceParent(deps), `genpage-${process.pid}-`)]);
  assert.strictEqual(path.dirname(dir), workspaceParent(deps));
  assert.ok(isOwnerStamp(JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'))), 'and it is recorded all the same');
});

test('a plugin\'s folder removed under a run — another process ended just now with nothing left in it — is made again; a refusal of the plugin\'s folder is not the run\'s failure, only the temp folder\'s own', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  let calls = 0;
  const dir = makeTempWorkspace('genpage-', {
    ...deps,
    mkdtempSync: (start) => {
      calls += 1;
      if (calls === 1) { fs.rmSync(parent, { recursive: true, force: true }); return fs.mkdtempSync(start); }
      return fs.mkdtempSync(start);
    },
  });
  assert.strictEqual(calls, 2, 'tried again after the folder was gone');
  assert.strictEqual(path.dirname(dir), parent);
  assert.ok(fs.existsSync(path.join(dir, OWNER_FILE)));

  // Every place refuses (the disk is full, no permission anywhere): the temp folder's own error, as the old call gave it — after the plugin's folder, which is optional, was tried.
  const refused = tempRoot(t);
  const asked = [];
  assert.throws(() => makeTempWorkspace('genpage-', { ...refused.deps, mkdtempSync: (start) => { asked.push(start); throw Object.assign(new Error(`EROFS: read-only file system, mkdir '${start}'`), { code: 'EROFS' }); } }), (e) => e.code === 'EROFS' && e.message.includes(path.join(refused.root, 'genpage-')) && !e.message.includes(PARENT_NAME));
  assert.deepStrictEqual(asked, [path.join(workspaceParent(refused.deps), `genpage-${process.pid}-`), path.join(refused.root, 'genpage-')], 'the plugin\'s folder first, then the call it always made: the error is that one\'s');
  // A folder that is gone every time is not made forever: six attempts in it, and then the temp folder.
  const vanishing = tempRoot(t);
  let tries = 0;
  const fallback = makeTempWorkspace('genpage-', { ...vanishing.deps, mkdtempSync: (start) => { tries += 1; if (tries <= 6) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return fs.mkdtempSync(start); } });
  assert.strictEqual(tries, 7);
  assert.strictEqual(path.dirname(fallback), vanishing.root, 'then it is made in the temp folder, as before');

  // Removed between the make of the plugin's folder and the look at it: the same, and the workspace is still the plugin's.
  const between = tempRoot(t);
  let looked = 0;
  const racing = { ...fs, lstatSync: (target, ...rest) => {
    if (target === workspaceParent(between.deps) && (looked += 1) === 1) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    return fs.lstatSync(target, ...rest);
  } };
  const kept = makeTempWorkspace('genpage-', { ...between.deps, fs: racing });
  assert.strictEqual(path.dirname(kept), workspaceParent(between.deps));
  assert.ok(looked >= 2, 'looked again');
});

test('a record that cannot be written does not fail the run: the workspace works, and is never swept', (t) => {
  const { deps } = tempRoot(t);
  const noWrites = { ...fs, writeFileSync: () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); } };
  const dir = makeTempWorkspace('genpage-', { ...deps, fs: noWrites });
  assert.ok(fs.statSync(dir).isDirectory());
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'no record');
  assert.deepStrictEqual(sweepDeadWorkspaces({ ...deps, owner: { probe: () => 'gone' } }).removed, [], 'so nothing can be proven of it, whatever is said of its pid');
});

test('the first workspace a process makes sweeps the plugin\'s folder, and says so; the next ones do not look again', (t) => {
  const { deps } = tempRoot(t);
  const first = plant(deps, goneRecord());
  const messages = [];
  const made = makeTempWorkspace('genpage-', { ...deps, warn: (message) => messages.push(message) });
  assert.ok(!fs.existsSync(first), 'the workspace of the run that is gone is removed, with what is in it');
  assert.strictEqual(messages.length, 1, JSON.stringify(messages));
  assert.ok(messages[0].includes(path.basename(first)) && messages[0].includes('page source') && messages[0].includes(workspaceParent(deps)), messages[0]);
  // A second one that appears later is for the next run to find.
  const later = plant(deps, goneRecord());
  makeTempWorkspace('genpage-', { ...deps, warn: (message) => messages.push(message) });
  assert.ok(fs.existsSync(later), 'one sweep per process');
  assert.strictEqual(messages.length, 1, 'and nothing more was said');
  assert.ok(fs.existsSync(made));
});

test('with nothing to sweep nothing is said, and the default words go to stderr as a warning', (t) => {
  const { deps } = tempRoot(t);
  const messages = [];
  makeTempWorkspace('genpage-', { ...deps, warn: (message) => messages.push(message) });
  assert.deepStrictEqual(messages, []);
  const written = [];
  const stderrWrite = process.stderr.write;
  const other = tempRoot(t);
  const dead = plant(other.deps, goneRecord());
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    makeTempWorkspace('genpage-', other.deps);
  } finally {
    process.stderr.write = stderrWrite;
  }
  assert.strictEqual(written.length, 1);
  assert.ok(written[0].startsWith('⚠ removed 1 temporary workspace') && written[0].endsWith('\n') && written[0].includes(path.basename(dead)), written[0]);
});

test('sweepDeadWorkspaces removes a workspace whose owner is gone — what is inside it too — and reports what it removed', (t) => {
  const { deps } = tempRoot(t);
  const record = goneRecord();
  const dir = plant(deps, record);
  const kept = plant(deps, ownerStamp());
  const result = sweepDeadWorkspaces(deps);
  assert.ok(!fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(kept, 'apps', 'page.json')), 'the workspace of a run that is going is as it was');
  assert.deepStrictEqual(result.removed.map((r) => [r.name, r.stamp.pid]), [[path.basename(dir), record.pid]]);
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(result.kept, 1);
  assert.ok(fs.existsSync(workspaceParent(deps)), 'the plugin\'s folder itself is never removed by a sweep: another run may be making a workspace in it');
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed, [], 'and a second sweep has nothing to do');
});

test('what cannot be PROVEN gone is left alone, whole: a run that is going, another machine, another system, another pid namespace, no record, a damaged or foreign one', (t) => {
  const { deps } = tempRoot(t);
  const gone = goneRecord();
  const marker = (overrides) => ({ ...gone, ...overrides });
  // Each folder is named with the pid that ended, so the sweep does look into it: it is the RECORD that must keep it.
  const cases = {
    'another machine': [marker({ host: 'some-other-machine' })],
    'another kind of system': [marker({ platform: process.platform === 'win32' ? 'linux' : 'win32' })],
    'another pid namespace': [marker({ ns: 'pid:[1]' })],
    'a record of a later version': [marker({ v: 2 })],
    'the record of a release before there were any ({ pid, at })': [{ pid: gone.pid, at: Date.now() }],
    'a pid that is not an integer': [marker({ pid: `${gone.pid}` })],
    'a record that says another pid than the name': [marker({ pid: gone.pid + 1 })],
    'a record of a run that is going, in a folder named for a pid that ended': [ownerStamp()],
    'a record that is not JSON': ['not json {'],
    'an empty record': [''],
    'a record far too large to be one': [JSON.stringify({ ...gone, padding: 'x'.repeat(5000) })],
    'JSON that is not an object': ['[1, 2]'],
    'no record at all': [null],
  };
  const dirs = Object.entries(cases).map(([what, [record]]) => [what, plant(deps, record, { pid: gone.pid })]);
  // A record that is a folder.
  const asFolder = plant(deps, null, { pid: gone.pid });
  fs.mkdirSync(path.join(asFolder, OWNER_FILE));
  dirs.push(['a record that is a folder', asFolder]);
  const result = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual(result.removed, []);
  assert.deepStrictEqual(result.failed, []);
  for (const [what, dir] of dirs) {
    assert.strictEqual(fs.readFileSync(path.join(dir, 'apps', 'page.json'), 'utf8'), 'the page source', `${what}: untouched`);
    assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), what);
  }
});

test('a folder whose name does not name a pid — one another release or a person made — is left alone, and not even opened', (t) => {
  const { deps } = tempRoot(t);
  const gone = goneRecord();
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const opened = [];
  const watching = { ...fs, lstatSync: (p, ...r) => { opened.push(p); return fs.lstatSync(p, ...r); }, readFileSync: (p, ...r) => { opened.push(p); return fs.readFileSync(p, ...r); } };
  for (const name of ['genpage-AbC123', 'genpage-12-AbC123x', 'genpage--AbC123', 'plain', '12345678901-AbC123']) {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, OWNER_FILE), JSON.stringify(gone));
    fs.writeFileSync(path.join(dir, 'page.tsx'), 'source');
  }
  const result = sweepDeadWorkspaces({ ...deps, fs: watching });
  assert.deepStrictEqual(result.removed, []);
  assert.deepStrictEqual(entriesOf(parent), ['12345678901-AbC123', 'genpage--AbC123', 'genpage-12-AbC123x', 'genpage-AbC123', 'plain']);
  assert.deepStrictEqual(opened.filter((p) => p.startsWith(parent) && p !== parent), [], 'nothing in any of them was opened');
});

test('a run that is going is never opened by a sweep: nothing in its folder is read, listed or resolved — a Windows run that removes its folder just then would have it fail', (t) => {
  const { deps } = tempRoot(t);
  // As on Windows and macOS, where there is no start time to compare and the pid says it all (on Linux a pid that runs IS looked into, below): the sweep is told
  // it is on such a system, and the record it reads says so too.
  const system = process.platform === 'linux' ? 'win32' : process.platform;
  const live = makeTempWorkspace('genpage-', deps);
  const dead = plant(deps, ownerStamp({ pid: deadPid(), platform: system }));
  const touched = [];
  const note = (p) => { touched.push(String(p)); };
  const watching = {
    ...fs,
    lstatSync: (p, ...r) => { note(p); return fs.lstatSync(p, ...r); },
    statSync: (p, ...r) => { note(p); return fs.statSync(p, ...r); },
    existsSync: (p) => { note(p); return fs.existsSync(p); },
    readFileSync: (p, ...r) => { note(p); return fs.readFileSync(p, ...r); },
    readdirSync: (p, ...r) => { note(p); return fs.readdirSync(p, ...r); },
    openSync: (p, ...r) => { note(p); return fs.openSync(p, ...r); },
    realpathSync: Object.assign((p, ...r) => { note(p); return fs.realpathSync(p, ...r); }, { native: (p, ...r) => { note(p); return fs.realpathSync.native(p, ...r); } }),
  };
  const result = sweepDeadWorkspaces({ ...deps, fs: watching, owner: { platform: system } });
  assert.deepStrictEqual(result.removed.map((r) => r.name), [path.basename(dead)]);
  assert.ok(fs.existsSync(path.join(live, OWNER_FILE)));
  const inLive = touched.filter((p) => path.resolve(p) === path.resolve(live) || path.resolve(p).startsWith(path.resolve(live) + path.sep));
  assert.deepStrictEqual(inLive, [], 'the live run\'s folder was not touched');
});

test('(Linux) a run whose pid still runs is looked into — its record can show the pid was handed out again — and is removed only if the start differs', (t) => {
  const { deps } = tempRoot(t);
  const NS = 'pid:[4026531836]';
  const BOOT = '11111111-2222-3333-4444-555555555555';
  const host = os.hostname();
  const record = { v: 1, pid: 4242, at: 1, host, platform: 'linux', ns: NS, start: `${BOOT}:900` };
  const owner = (startNow) => ({ platform: 'linux', hostname: () => host, ns: NS, pid: 100, probe: () => 'alive', startOf: () => ({ token: `${BOOT}:${startNow}`, state: 'S' }) });
  const same = plant(deps, record);
  assert.deepStrictEqual(sweepDeadWorkspaces({ ...deps, owner: owner(900) }).removed, [], 'the same start: the same process, still running');
  assert.ok(fs.existsSync(same));
  const result = sweepDeadWorkspaces({ ...deps, owner: owner(901) });
  assert.deepStrictEqual(result.removed.map((r) => r.name), [path.basename(same)], 'another start: the pid was handed out again, and the run that made the folder is gone');
  assert.ok(!fs.existsSync(same));
});

test('POSIX: a link in the plugin\'s folder — to a folder that holds a record of a dead run — is not followed, and a file is not a workspace', onlyPosix, (t) => {
  const { root, deps } = tempRoot(t);
  const gone = goneRecord();
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'important.txt'), 'not the plugin\'s');
  fs.writeFileSync(path.join(outside, OWNER_FILE), JSON.stringify(gone));
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(parent, `genpage-${gone.pid}-AbC123`));
  fs.writeFileSync(path.join(parent, `genpage-${gone.pid}-XyZ789`), JSON.stringify(gone));
  const result = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual(result.removed, []);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'important.txt'), 'utf8'), 'not the plugin\'s');
  assert.strictEqual(entriesOf(parent).length, 2);
});

test('a folder entry that is really a link — one a platform reports as a plain folder — is not followed, and what it points at is untouched', (t) => {
  const { root, deps } = tempRoot(t);
  const gone = goneRecord();
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'important.txt'), 'not the plugin\'s');
  fs.writeFileSync(path.join(outside, OWNER_FILE), JSON.stringify(gone));
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const name = `genpage-${gone.pid}-AbC123`;
  // A junction on Windows (no privilege needed), a symbolic link elsewhere.
  fs.symlinkSync(outside, path.join(parent, name), 'junction');
  // The listing says it is a folder, as an older Node on Windows says of a junction: only where it really is can tell.
  const liar = { ...fs, readdirSync: (dir, options) => {
    const listing = fs.readdirSync(dir, options);
    return options && options.withFileTypes ? listing.map((entry) => (entry.name === name ? { name: entry.name, isDirectory: () => true, isFile: () => false } : entry)) : listing;
  } };
  const result = sweepDeadWorkspaces({ ...deps, fs: liar });
  assert.deepStrictEqual(result.removed, []);
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'important.txt'), 'utf8'), 'not the plugin\'s');
  assert.ok(fs.existsSync(path.join(outside, OWNER_FILE)), 'what the link points at is whole');
});

test('POSIX: a record that is a link is no record: it could point at a file that names any pid', onlyPosix, (t) => {
  const { root, deps } = tempRoot(t);
  const gone = goneRecord();
  const forged = path.join(root, 'forged.json');
  fs.writeFileSync(forged, JSON.stringify(gone));
  const dir = plant(deps, null, { pid: gone.pid });
  fs.symlinkSync(forged, path.join(dir, OWNER_FILE));
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed, []);
  assert.ok(fs.existsSync(path.join(dir, 'apps', 'page.json')));
});

test('a plugin\'s folder that is missing, a file, or (POSIX) not ours is swept as nothing, without an error', (t) => {
  const missing = tempRoot(t);
  assert.deepStrictEqual(sweepDeadWorkspaces(missing.deps).removed, []);
  const file = tempRoot(t);
  fs.writeFileSync(workspaceParent(file.deps), 'a file');
  assert.deepStrictEqual(sweepDeadWorkspaces(file.deps).removed, []);
  if (POSIX) {
    const theirs = tempRoot(t);
    const uid = process.getuid() + 1;
    const dir = plant({ ...theirs.deps, uid }, goneRecord());
    assert.deepStrictEqual(sweepDeadWorkspaces({ ...theirs.deps, uid }).removed, [], 'owned by another user: nothing in it is believed');
    assert.ok(fs.existsSync(dir));
  }
});

test('a removal that fails half way leaves the workspace still recorded — so the next sweep finds it again — and says what failed', (t) => {
  const { deps } = tempRoot(t);
  const dir = plant(deps, goneRecord());
  const name = path.basename(dir);
  let held = true;
  const busy = { ...fs, rmSync: (target, options) => {
    if (held && path.basename(target) === 'manifest.json') throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return fs.rmSync(target, options);
  } };
  const first = sweepDeadWorkspaces({ ...deps, fs: busy });
  assert.deepStrictEqual(first.removed, []);
  assert.deepStrictEqual(first.failed.map((f) => [f.name, f.error]), [[name, 'EBUSY']]);
  assert.ok(fs.existsSync(path.join(dir, OWNER_FILE)), 'the record is removed last: what is left is still known to be a dead run\'s');
  const warning = sweepWarning(first);
  assert.ok(warning.endsWith(`could not remove 1 such workspace (${name} (EBUSY)) — delete it by hand`) && !/removed 1/.test(warning), warning);
  held = false;
  assert.deepStrictEqual(sweepDeadWorkspaces({ ...deps, fs: busy }).removed.map((r) => r.name), [name]);
  assert.ok(!fs.existsSync(dir));
});

test('a workspace that another run\'s sweep takes first — two runs starting after a kill — is neither this sweep\'s removal nor its failure, and nothing is said of it', (t) => {
  const { deps } = tempRoot(t);
  const dir = plant(deps, goneRecord());
  // The other sweep removes the folder after this one has judged it and looked again, and before it removes anything.
  const raced = { ...fs, readdirSync: (target, ...rest) => {
    if (target === dir) fs.rmSync(dir, { recursive: true, force: true });
    return fs.readdirSync(target, ...rest);
  } };
  const result = sweepDeadWorkspaces({ ...deps, fs: raced });
  assert.deepStrictEqual(result.removed, []);
  assert.deepStrictEqual(result.failed, []);
  assert.strictEqual(sweepWarning(result), '');
  assert.ok(!fs.existsSync(dir));
});

test('sweepWarning: says how many, whose they were, and what is left to delete by hand — and shows no name it cannot trust', () => {
  const stamp = { pid: 4242 };
  assert.strictEqual(sweepWarning({ parent: '/tmp/p', removed: [], failed: [] }), '');
  const one = sweepWarning({ parent: '/tmp/p', removed: [{ name: 'genpage-4242-AbC123', stamp }], failed: [] });
  assert.strictEqual(one, 'removed 1 temporary workspace left in /tmp/p by a run that is no longer running — it held page source and the environment\'s address: genpage-4242-AbC123 (pid 4242)');
  const many = sweepWarning({ parent: '/tmp/p', removed: Array.from({ length: 7 }, (_, i) => ({ name: `genpage-${i}`, stamp })), failed: [{ name: 'model-app-x', stamp, error: 'EPERM' }] });
  assert.ok(many.startsWith('removed 7 temporary workspaces left in /tmp/p by runs that are no longer running — they held page source'), many);
  assert.ok(many.includes('genpage-4 (pid 4242), and 2 more'), many);
  assert.ok(many.endsWith('; could not remove 1 such workspace (model-app-x (EPERM)) — delete it by hand'), many);
  assert.ok(sweepWarning({ parent: '/p', removed: [{ name: 'evil\u001b[31m\nname', stamp }], failed: [] }).includes('?'), 'a name with control characters is not shown');
});

test('sweepWarning: a pac fallback\'s work folder of solution-settings is said to have held settings, not page source — and a mix of both is said as a mix', () => {
  const stamp = { pid: 4242 };
  const settings = sweepWarning({ parent: '/tmp/p', removed: [{ name: 'solution-settings-4242-AbC123', stamp }], failed: [] });
  assert.strictEqual(settings, 'removed 1 temporary workspace left in /tmp/p by a run that is no longer running — it held a settings template, an exported package or a copy of a settings file, which can hold its values: solution-settings-4242-AbC123 (pid 4242)');
  const mixed = sweepWarning({ parent: '/tmp/p', removed: [{ name: 'genpage-4242-AbC123', stamp }, { name: 'solution-settings-4242-XyZ789', stamp }], failed: [] });
  assert.ok(mixed.includes("— they held page source, the environment's address, or a settings file's values: "), mixed);
});

// A plugin's folder that exists only as a listing: `count` workspaces, each named for a pid and holding the record of a run of `system` — all served from memory, so
// that what a sweep does with hundreds of entries is shown without making one. (The pids are far above any a system hands out: none can be this process's.)
function listedWorkspaces(deps, count, system) {
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const realParent = fs.realpathSync.native(parent);
  const names = Array.from({ length: count }, (_, i) => `genpage-${2000000000 + i}-AbC123`);
  const known = new Set(names);
  const folderOf = (p) => {
    const name = p.startsWith(parent + path.sep) ? p.slice(parent.length + 1).split(path.sep)[0] : undefined;
    return known.has(name) ? name : undefined;
  };
  const isRecord = (p) => !!folderOf(p) && path.basename(p) === OWNER_FILE;
  const removed = [];
  const served = {
    ...fs,
    readdirSync: (dir, options) => {
      if (dir === parent) return names.map((name) => ({ name, isDirectory: () => true, isFile: () => false }));
      return folderOf(dir) ? [OWNER_FILE] : fs.readdirSync(dir, options);
    },
    realpathSync: Object.assign((p) => fs.realpathSync(p), { native: (p) => (folderOf(p) ? path.join(realParent, folderOf(p)) : fs.realpathSync.native(p)) }),
    lstatSync: (p, ...rest) => (isRecord(p) ? { isFile: () => true, size: 100 } : fs.lstatSync(p, ...rest)),
    readFileSync: (p, ...rest) => (isRecord(p) ? JSON.stringify(ownerStamp({ pid: Number(/-(\d+)-/.exec(folderOf(p))[1]), platform: system, now: () => 1 })) : fs.readFileSync(p, ...rest)),
    // A folder is removed by taking its record out of it and then removing the folder (lib/temp-workspace.js removeWorkspace): the folder counts as removed when it is.
    renameSync: (from, to) => (isRecord(from) ? undefined : fs.renameSync(from, to)),
    rmdirSync: (p, ...rest) => { if (folderOf(p)) { removed.push(p); return undefined; } return fs.rmdirSync(p, ...rest); },
    rmSync: (p, ...rest) => (folderOf(p) ? undefined : fs.rmSync(p, ...rest)),
  };
  return { served, removed };
}

test('a sweep removes no more than it is made to, and looks at no more: what is left is for the next runs', (t) => {
  const { deps } = tempRoot(t);
  const record = goneRecord();
  const dirs = Array.from({ length: 7 }, () => plant(deps, record));
  const left = (list) => list.filter((dir) => fs.existsSync(dir));
  // Removed, or tried and failed (a scanner on Windows can hold a new folder for a moment): the limit is on the work a sweep does.
  const first = sweepDeadWorkspaces({ ...deps, limits: { maxExamined: 100, maxRemoved: 3 } });
  assert.strictEqual(first.removed.length + first.failed.length, 3);
  assert.ok(left(dirs).length >= 4, 'the rest are where they were');
  // Of a listing, only its first entries are looked at.
  const other = tempRoot(t);
  const more = Array.from({ length: 6 }, () => plant(other.deps, record));
  const second = sweepDeadWorkspaces({ ...other.deps, limits: { maxExamined: 2, maxRemoved: 100 } });
  assert.strictEqual(second.removed.length + second.failed.length, 2);
  assert.ok(left(more).length >= 4);
  // The next runs take the rest.
  for (let sweeps = 0; sweeps < 5 && left(dirs).length > 0; sweeps += 1) sweepDeadWorkspaces({ ...deps, limits: { maxExamined: 100, maxRemoved: 3 } });
  assert.deepStrictEqual(left(dirs), []);
});

test('by default a sweep removes at most LIMITS.MAX_REMOVED workspaces, and looks at at most LIMITS.MAX_EXAMINED entries, of a folder that has collected hundreds', (t) => {
  assert.ok(Number.isInteger(LIMITS.MAX_REMOVED) && LIMITS.MAX_REMOVED > 0 && LIMITS.MAX_EXAMINED >= LIMITS.MAX_REMOVED);
  const total = LIMITS.MAX_EXAMINED + 50;
  // Runs that are gone: the first MAX_REMOVED are removed, and the rest of what was looked at is kept for the next run.
  const gone = tempRoot(t);
  const listedGone = listedWorkspaces(gone.deps, total, 'win32');
  const swept = sweepDeadWorkspaces({ ...gone.deps, fs: listedGone.served, owner: { platform: 'win32', probe: () => 'gone' } });
  assert.strictEqual(swept.removed.length, LIMITS.MAX_REMOVED);
  assert.strictEqual(listedGone.removed.length, LIMITS.MAX_REMOVED, 'and no more was taken');
  assert.strictEqual(swept.kept, LIMITS.MAX_EXAMINED - LIMITS.MAX_REMOVED);
  // Runs that go: nothing is taken, and the pids that are asked about are those of the first MAX_EXAMINED entries.
  const going = tempRoot(t);
  const listedGoing = listedWorkspaces(going.deps, total, 'win32');
  const asked = [];
  const kept = sweepDeadWorkspaces({ ...going.deps, fs: listedGoing.served, owner: { platform: 'win32', probe: (pid) => { asked.push(pid); return 'alive'; } } });
  assert.deepStrictEqual(kept.removed, []);
  assert.deepStrictEqual(asked, Array.from({ length: LIMITS.MAX_EXAMINED }, (_, i) => 2000000000 + i));
  assert.deepStrictEqual(listedGoing.removed, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Racing live runs. A sweep that took a workspace from a run that was going would be the worst thing this module could do.
// ---------------------------------------------------------------------------------------------------------------------

test('a workspace made after the sweep listed the folder is not in its list, and is not touched', (t) => {
  const { deps } = tempRoot(t);
  const dead = plant(deps, goneRecord());
  const parent = workspaceParent(deps);
  let late;
  const racing = { ...fs, readdirSync: (dir, options) => {
    const listing = fs.readdirSync(dir, options);
    // After the listing: a run that is going makes its workspace.
    if (dir === parent && !late) late = plant(deps, ownerStamp());
    return listing;
  } };
  const result = sweepDeadWorkspaces({ ...deps, fs: racing });
  assert.ok(late && fs.existsSync(path.join(late, 'apps', 'page.json')), 'the late workspace is whole');
  assert.deepStrictEqual(result.removed.map((r) => r.name), [path.basename(dead)]);
  assert.ok(!fs.existsSync(dead));
});

test('a workspace whose record changes between the judgement and the removal — a run that is going has it now — is not removed', (t) => {
  const { deps } = tempRoot(t);
  const gone = goneRecord();
  const dir = plant(deps, gone);
  const marker = path.join(dir, OWNER_FILE);
  let reads = 0;
  const racing = { ...fs, readFileSync: (file, encoding) => {
    if (file === marker) {
      reads += 1;
      // Between the first read (the judgement) and the second (just before the removal): a run that is going has this folder now.
      // Its record is a new one: `at` is set past the old record's, since two stamps made in the same millisecond are the same text,
      // and the sweep rightly removes a folder whose record did not change (a fast runner made that happen once).
      if (reads === 2) fs.writeFileSync(marker, JSON.stringify({ ...ownerStamp(), pid: gone.pid, at: gone.at + 1 }));
    }
    return fs.readFileSync(file, encoding);
  } };
  const result = sweepDeadWorkspaces({ ...deps, fs: racing, owner: { probe: (pid) => (pid === gone.pid ? 'gone' : 'alive') } });
  assert.strictEqual(reads, 2, 'the record was read again before the removal');
  assert.deepStrictEqual(result.removed, []);
  assert.ok(fs.existsSync(path.join(dir, 'apps', 'page.json')), 'the workspace is whole');
});

test('no script of the plugin makes a workspace folder by hand: every one goes through makeTempWorkspace — but the three developer tools', () => {
  const { SCRIPTS_DIR, productionScripts, withoutComments } = require('./helpers/production-scripts.js');
  // The scripts' code, comments left out, read once: each of the two scans below is over all of it.
  const code = productionScripts().map((file) => ({ name: path.relative(SCRIPTS_DIR, file).split(path.sep).join('/'), text: withoutComments(fs.readFileSync(file, 'utf8')) }));
  const scriptsMatching = (pattern) => code.filter(({ text }) => text.search(pattern) !== -1).map(({ name }) => name).sort();
  // smoke-eval.js builds a whole app folder (its spec and its own `.maker-workspace`) for a live smoke run against a scratch environment, and
  // regenerate-verified-icons.js runs `npm install` in a scratch folder: a maintainer runs each by hand, and neither is a step of a skill. run-tests.js makes the folder the
  // test suite runs in (its TEMP), which is not a workspace: a sweep a test makes must not take it for one, and the runner removes it itself when the suite ends.
  // The write-safety hook reads the temp folder's path to judge where a write goes; it makes no folder.
  assert.deepStrictEqual(scriptsMatching(/\btmpdir\s*\(/), ['../hooks/validate-write-safety.js', 'lib/temp-workspace.js', 'regenerate-verified-icons.js', 'run-tests.js', 'smoke-eval.js']);
  const makers = scriptsMatching(/\bmakeTempWorkspace\(/);
  for (const script of ['ai-preflight.js', 'build-model-app.js', 'download-model-app.js', 'provision-entities.js', 'provision-solution.js', 'solution-settings.js', 'teardown-model-app.js', 'verify-model-app.js',
    'lib/genpage-sdk.js', 'lib/sdk-first.js', 'lib/throwaway-sdk.js']) {
    assert.ok(makers.includes(script), `${script} makes its workspace through the maker`);
  }
});

test('REAL KILL: the workspace a killed run left is removed by a sweep — with the page source in it — and the workspace of a run that is going is not', async (t) => {
  const root = privateTempRoot(t);
  const deps = { os: { tmpdir: () => root } };
  const killed = startTarget(t, ['workspace', 'genpage-'], { env: tempEnv(root) });
  const left = (await killed.waitFor(/^workspace /)).slice('workspace '.length);
  const running = startTarget(t, ['workspace', 'genpage-'], { env: tempEnv(root) });
  const alive = (await running.waitFor(/^workspace /)).slice('workspace '.length);
  assert.notStrictEqual(left, alive);
  assert.strictEqual(path.dirname(left), workspaceParent(deps), 'the child made its workspace where the sweep looks');
  assert.match(path.basename(left), new RegExp(`^genpage-${killed.pid}-`), 'and named it after itself');
  assert.ok(isOwnerStamp(JSON.parse(fs.readFileSync(path.join(left, OWNER_FILE), 'utf8'))));
  await killed.kill();
  assert.ok(fs.existsSync(path.join(left, 'page.tsx')), 'a killed process leaves its workspace');

  const result = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual(result.removed.map((r) => [r.name, r.stamp.pid]), [[path.basename(left), killed.pid]]);
  assert.ok(!fs.existsSync(left), 'the page source is gone');
  assert.ok(fs.existsSync(path.join(alive, 'page.tsx')), 'the workspace of the run that is going is whole');
  await running.kill();
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed.map((r) => r.name), [path.basename(alive)], 'and once that run is killed too, the next sweep removes it');
});

test('REAL PROCESSES: runs that make and remove workspaces while others sweep — no sweep ever takes a workspace from a run that is going, or makes its own removal fail', async (t) => {
  const root = privateTempRoot(t);
  const deps = { os: { tmpdir: () => root } };
  const gate = path.join(root, 'go');
  const RUNS = 4;
  const ITERATIONS = 40;
  // One workspace of a run that is gone, for the sweeps to take among the live ones.
  const dead = startTarget(t, ['workspace', 'genpage-'], { env: tempEnv(root) });
  const deadFolder = (await dead.waitFor(/^workspace /)).slice('workspace '.length);
  await dead.kill();
  const runs = Array.from({ length: RUNS }, () => startTarget(t, ['workspace-loop', 'genpage-', String(ITERATIONS), '10', gate], { env: tempEnv(root) }));
  await Promise.all(runs.map((run) => run.waitFor(/^ready$/)));
  fs.writeFileSync(gate, '');
  // The test sweeps too, as fast as it can, while they work.
  let sweeping = true;
  const sweeper = (async () => { while (sweeping) { sweepDeadWorkspaces(deps); await pause(1); } })();
  let answers;
  try {
    answers = await Promise.all(runs.map((run) => run.waitFor(/^loop-done \d+ \d+$/)));
  } finally {
    // A run that ends before it says it is done fails the test — and the sweeping has to stop either way: a loop that is left going keeps the process from ever ending (a failure
    // that is a hang, and a CI job that runs out its whole time instead of saying which run failed).
    sweeping = false;
    await sweeper;
  }
  // `lost`: a workspace that a run found gone, or — in the plugin's folder — unrecorded. `plain`: a workspace that was made in the temp folder because the plugin's folder could not be
  // used at that moment (on Windows another run, ending, was removing it): a courtesy that was not available, which is no one's loss, but not a thing a run may do for the most part.
  const [lost, plain] = [0, 1].map((at) => answers.reduce((sum, line) => sum + Number(line.split(' ')[at + 1]), 0));
  assert.strictEqual(lost, 0, `no run ever found its own workspace gone, or unrecorded in the plugin's folder: ${answers.join(', ')}`);
  assert.ok(plain * 10 <= RUNS * ITERATIONS, `most of the workspaces were made in the plugin's folder: ${plain} of ${RUNS * ITERATIONS} were not`);
  sweepDeadWorkspaces(deps);
  assert.ok(!fs.existsSync(deadFolder), 'the dead run\'s workspace was removed, by one of the sweeps (the last made after the runs had ended)');
  for (const run of runs) assert.strictEqual((await run.exited).code, 0, `a run ended cleanly — none had its own removal fail: ${run.stderr()}`);
});

test('when a process ends it removes the plugin\'s folder if nothing is left in it', async (t) => {
  const root = privateTempRoot(t);
  const clean = startTarget(t, ['workspace-exit', 'genpage-'], { env: tempEnv(root) });
  await clean.waitFor(/^done$/);
  await clean.exited;
  assert.deepStrictEqual(fs.readdirSync(root), [], 'a normal run leaves the temp folder as it found it');
});

// A cleanup of a caller's own — the one solution-settings.js registers with lib/exit-cleanup.js, which removes the workspace it LENT — runs after the maker's listener for the end of the process, so it asks for the same removal of
// the plugin's folder once the workspace is gone. The removal is the same one: a plain `rmdir`, which takes a folder only when it is empty.
test('pruneWorkspaceParents takes the plugin\'s folder when nothing is left in it, and only then — a workspace in it, lent or not, keeps it, whole', (t) => {
  const { deps } = tempRoot(t);
  const lent = makeTempWorkspace('solution-settings-', { ...deps, lent: true });
  const own = makeTempWorkspace('genpage-', deps);
  const parent = workspaceParent(deps);
  pruneWorkspaceParents();
  assert.deepStrictEqual(entriesOf(parent), [path.basename(lent), path.basename(own)].sort(), 'the folder holds two workspaces: it is not taken, and neither of them is');
  assert.ok(fs.existsSync(path.join(lent, OWNER_FILE)) && fs.existsSync(path.join(own, OWNER_FILE)), 'whole, and still recorded');
  fs.rmSync(own, { recursive: true, force: true });
  pruneWorkspaceParents();
  assert.deepStrictEqual(entriesOf(parent), [path.basename(lent)], 'one workspace left in it: the folder stays');
  fs.rmSync(lent, { recursive: true, force: true });
  pruneWorkspaceParents();
  assert.ok(!fs.existsSync(parent), 'nothing left in it: it is taken');
  assert.doesNotThrow(() => pruneWorkspaceParents(), 'and asking again, with the folder gone, is no failure');
});

// ── A run that is cut short ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// What ends a run in a way JavaScript can see — process.exit, and an error nothing catches — runs the `exit` event, and a run that ends so has usually not reached the `finally` that removes its workspace. The workspace and
// the plugin's folder it is in were left for the next run: its sweep takes the workspace, and the folder stays until some run ends with nothing in it. So the end of a run takes, besides the folder when it is empty, the
// workspaces the run itself made and did not lend (a run that lends one is not the one to say when the program it lent it to is done). A signal is not one of these ends: the default action of SIGINT and SIGTERM ends
// the process with no JavaScript run, and a listener, which would, replaces that default action — for every script that makes a workspace.
const ABORTS = [['process.exit(7)', 'exit', 7], ['an error nothing catches', 'throw', 1]];

for (const [what, how, status] of ABORTS) {
  test(`a run that ends by ${what} with its workspace still there takes the workspace and the plugin's folder with it, and ends with the status it would have had`, async (t) => {
    const root = privateTempRoot(t);
    const run = startTarget(t, ['workspace-abort', 'genpage-', how], { env: tempEnv(root) });
    const made = (await run.waitFor(/^workspace /)).slice('workspace '.length);
    assert.strictEqual(path.dirname(made), workspaceParent({ os: { tmpdir: () => root } }), 'the run made its workspace in the plugin\'s folder');
    const ended = await run.exited;
    assert.deepStrictEqual([ended.code, ended.signal], [status, null], 'the status is the one the run would have ended with');
    assert.deepStrictEqual(fs.readdirSync(root), [], 'the temp folder is as the run found it: the workspace is gone, and so is the plugin\'s folder');
  });

  test(`a run that removed its workspace before it ended by ${what} leaves nothing either, and ends with the same status`, async (t) => {
    const root = privateTempRoot(t);
    const run = startTarget(t, ['workspace-abort', 'genpage-', how, 'removed'], { env: tempEnv(root) });
    await run.waitFor(/^workspace /);
    const ended = await run.exited;
    assert.deepStrictEqual([ended.code, ended.signal], [status, null]);
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });
}

test('a run that ends by process.exit or an error nothing catches takes only what is its own: while another run\'s workspace is in the plugin\'s folder, that workspace is whole and the folder stays', async (t) => {
  const root = privateTempRoot(t);
  const deps = { os: { tmpdir: () => root } };
  const other = startTarget(t, ['workspace', 'genpage-'], { env: tempEnv(root) });
  const theirs = (await other.waitFor(/^workspace /)).slice('workspace '.length);
  // Both ways out, and a run that ends by itself, at the same time.
  const runs = [...ABORTS.map(([what, how, status]) => ({ what, args: ['workspace-abort', 'genpage-', how], status })), { what: 'the end of its event loop', args: ['workspace-keep', 'genpage-'], status: 0 }]
    .map((run) => ({ ...run, target: startTarget(t, run.args, { env: tempEnv(root) }) }));
  const made = await Promise.all(runs.map(async (run) => (await run.target.waitFor(/^workspace /)).slice('workspace '.length)));
  const ended = await Promise.all(runs.map((run) => run.target.exited));
  runs.forEach((run, i) => {
    assert.strictEqual(ended[i].code, run.status, `${run.what}: the status`);
    assert.ok(!fs.existsSync(made[i]), `${run.what}: its own workspace is gone`);
  });
  assert.ok(fs.existsSync(path.join(theirs, 'page.tsx')) && isOwnerStamp(JSON.parse(fs.readFileSync(path.join(theirs, OWNER_FILE), 'utf8'))), 'the workspace of the run that is going is whole, and still recorded');
  assert.deepStrictEqual(fs.readdirSync(workspaceParent(deps)), [path.basename(theirs)], 'it is all the plugin\'s folder holds');
  // Once that run is gone too, a sweep takes its workspace — and not the folder, which the end of a run takes when it is empty.
  await other.kill();
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed.map((r) => r.name), [path.basename(theirs)]);
  assert.ok(fs.existsSync(workspaceParent(deps)));
});

test('REAL PROCESSES: runs that are cut short while others make and remove workspaces take only what is their own — none finds its workspace gone or unrecorded, and every run ends with its status', async (t) => {
  const root = privateTempRoot(t);
  const deps = { os: { tmpdir: () => root } };
  const gate = path.join(root, 'go');
  const RUNS = 2;
  const ITERATIONS = 40;
  const loops = Array.from({ length: RUNS }, () => startTarget(t, ['workspace-loop', 'genpage-', String(ITERATIONS), '10', gate], { env: tempEnv(root) }));
  await Promise.all(loops.map((run) => run.waitFor(/^ready$/)));
  fs.writeFileSync(gate, '');
  // While they work, runs that are cut short come and go in the same folder: each makes a workspace and ends without removing it, so that its end removes it — beside the workspaces of the runs that are going, and
  // in the moments between theirs, when the folder is empty.
  const ends = [];
  for (let i = 0; i < 4; i += 1) {
    const [, how, status] = ABORTS[i % ABORTS.length];
    const run = startTarget(t, ['workspace-abort', 'genpage-', how], { env: tempEnv(root) });
    await run.waitFor(/^workspace /);
    ends.push({ expected: status, actual: (await run.exited).code });
  }
  const answers = await Promise.all(loops.map((run) => run.waitFor(/^loop-done \d+ \d+$/)));
  const lost = answers.reduce((sum, line) => sum + Number(line.split(' ')[1]), 0);
  assert.strictEqual(lost, 0, `no run found its own workspace gone, or unrecorded in the plugin's folder: ${answers.join(', ')}`);
  assert.deepStrictEqual(ends.map((e) => e.actual), ends.map((e) => e.expected), 'the runs that were cut short ended with the status they would have had');
  for (const run of loops) assert.strictEqual((await run.exited).code, 0, `a run that makes and removes workspaces ended cleanly: ${run.stderr()}`);
  assert.deepStrictEqual(fs.existsSync(workspaceParent(deps)) ? fs.readdirSync(workspaceParent(deps)) : [], [], 'and no workspace is left in the plugin\'s folder');
});

test('a workspace lent to another program is not taken when the run that lent it ends — the program may still be writing in it — and the plugin\'s folder stays with it', async (t) => {
  const root = privateTempRoot(t);
  const run = startTarget(t, ['workspace-abort', 'solution-settings-', 'exit', 'lent'], { env: tempEnv(root) });
  const lent = (await run.waitFor(/^workspace /)).slice('workspace '.length);
  assert.strictEqual((await run.exited).code, 7);
  assert.ok(fs.existsSync(path.join(lent, 'page.tsx')), 'the lent workspace is whole');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(lent, OWNER_FILE), 'utf8')).lent, true, 'and still recorded as lent');
  assert.deepStrictEqual(fs.readdirSync(root), [path.basename(workspaceParent({ os: { tmpdir: () => root } }))]);
});

test('a run that ends without removing its workspace — its event loop empties, nothing calls process.exit — takes the workspace and the plugin\'s folder with it', async (t) => {
  const root = privateTempRoot(t);
  const careless = startTarget(t, ['workspace-keep', 'genpage-'], { env: tempEnv(root) });
  await careless.waitFor(/^workspace /);
  const ended = await careless.exited;
  assert.deepStrictEqual([ended.code, ended.signal], [0, null]);
  assert.deepStrictEqual(fs.readdirSync(root), []);
});

test('a plugin\'s folder that a run made, and then could make no workspace in, is removed when the run ends — the workspace goes in the temp folder as before', async (t) => {
  const root = privateTempRoot(t);
  const run = startTarget(t, ['workspace-refused', 'genpage-'], { env: tempEnv(root) });
  const plain = (await run.waitFor(/^workspace /)).slice('workspace '.length);
  assert.strictEqual(path.dirname(plain), root, 'the workspace is in the temp folder itself');
  await run.waitFor(/^done$/);
  assert.strictEqual((await run.exited).code, 0);
  assert.deepStrictEqual(fs.readdirSync(root), [], 'and the plugin\'s folder, made for the workspace that was refused, is not left behind');
});

test('the maker listens for no signal, so a signal ends a run as it always did', async (t) => {
  const root = privateTempRoot(t);
  const run = startTarget(t, ['workspace-listeners', 'genpage-'], { env: tempEnv(root) });
  const heard = JSON.parse((await run.waitFor(/^listeners /)).slice('listeners '.length));
  assert.deepStrictEqual(heard, { SIGINT: 0, SIGTERM: 0, SIGHUP: 0, SIGBREAK: 0 }, 'a listener replaces the default action of the signal, and has to put it back by hand');
  await run.exited;
});

test('POSIX: SIGTERM ends a run that holds a workspace BY the signal, as it ends a process with no listener — no JavaScript runs, so the workspace is left for the next run\'s sweep', onlyPosix, async (t) => {
  const root = privateTempRoot(t);
  const deps = { os: { tmpdir: () => root } };
  const run = startTarget(t, ['workspace', 'genpage-'], { env: tempEnv(root) });
  const left = (await run.waitFor(/^workspace /)).slice('workspace '.length);
  const ended = await run.signal('SIGTERM');
  assert.deepStrictEqual([ended.code, ended.signal], [null, 'SIGTERM'], 'ended by the signal, and not by an exit status');
  assert.ok(fs.existsSync(path.join(left, 'page.tsx')), 'the workspace is left where it is');
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed.map((r) => r.name), [path.basename(left)]);
});

// ---------------------------------------------------------------------------------------------------------------------
// A pid that is "not found" proves nothing where the pid spaces are not shown to be one, and a record's fields are believed only when they are well formed
// ---------------------------------------------------------------------------------------------------------------------

// A Linux process that cannot read /proc (a container that hides it, hidepid, a sandbox) can name neither its pid namespace nor a start time.
const unreadable = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
const LINUX_HOST = 'same-container-hostname';
const LINUX_NS = 'pid:[4026531836]';
const LINUX_BOOT = '11111111-2222-3333-4444-555555555555';
const linuxSide = (ns, extra = {}) => ({ platform: 'linux', hostname: () => LINUX_HOST, startOf: () => null, ...(ns ? { ns } : { readFile: unreadable, readlink: unreadable }), ...extra });

test('(Linux) a workspace is removed only when the record\'s pid namespace AND this process\'s are both readable, valid and equal — a pid that is not found proves nothing where the pid spaces are not shown to be one', (t) => {
  // Two containers can share a host name and a volume and have two pid spaces; the sweep of one must not take the workspace of a run that is going in the other.
  const made = (ns) => ownerStamp({ ...linuxSide(ns), pid: deadPid(), now: () => 1 });
  const sweep = (deps, ns) => sweepDeadWorkspaces({ ...deps, owner: linuxSide(ns, { pid: 100, probe: () => 'gone' }) });
  const control = tempRoot(t);
  const controlDir = plant(control.deps, made(LINUX_NS));
  assert.deepStrictEqual(sweep(control.deps, LINUX_NS).removed.map((r) => r.name), [path.basename(controlDir)], 'control: both sides name one namespace, and the pid is not found in it');
  for (const [what, recorded, reader] of [
    ['a record that names no namespace, swept where one can be named', undefined, LINUX_NS],
    ['a record that names one, swept where this process cannot name its own', LINUX_NS, undefined],
    ['neither side names one: the same host name, the same volume, two blind sides', undefined, undefined],
    ['another namespace', LINUX_NS, 'pid:[4026532000]'],
  ]) {
    const { deps } = tempRoot(t);
    const dir = plant(deps, made(recorded));
    const result = sweep(deps, reader);
    assert.deepStrictEqual([result.removed, result.failed], [[], []], what);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'apps', 'page.json'), 'utf8'), 'the page source', `${what}: the source is untouched`);
    assert.ok(fs.existsSync(path.join(dir, OWNER_FILE)), `${what}: and still recorded`);
  }
});

test('(Linux) a workspace whose recorded start is empty, truncated or malformed is kept — the folder of a run that is going (this process\'s own pid) and the folder of a pid that is not found alike', (t) => {
  for (const start of ['', 'truncated-token', LINUX_BOOT, `${LINUX_BOOT}:`, `${LINUX_BOOT}:90x`]) {
    const what = JSON.stringify(start);
    // A run that is going. On Linux a folder named for a pid that runs is looked into, since its record's start can show the pid was handed out again: here the record's start
    // is damaged, which shows nothing — and used to be read as "another process", and the folder of the run that is going removed.
    const going = tempRoot(t);
    const goingStart = { token: `${LINUX_BOOT}:900`, state: 'S' };
    const goingDir = plant(going.deps, { ...ownerStamp({ ...linuxSide(LINUX_NS), pid: 4242, now: () => 1, startOf: () => goingStart }), start });
    const live = sweepDeadWorkspaces({ ...going.deps, owner: linuxSide(LINUX_NS, { pid: 4242, probe: () => 'alive', startOf: () => goingStart }) });
    assert.deepStrictEqual([live.removed, live.failed], [[], []], `${what}: this process's own pid`);
    assert.ok(fs.existsSync(path.join(goingDir, 'apps', 'page.json')), `${what}: the workspace of the run that is going is whole`);
    // A pid that is not found: an untrusted record is not a dead run's.
    const dead = tempRoot(t);
    const deadDir = plant(dead.deps, { ...ownerStamp({ ...linuxSide(LINUX_NS), pid: deadPid(), now: () => 1 }), start });
    const gone = sweepDeadWorkspaces({ ...dead.deps, owner: linuxSide(LINUX_NS, { pid: 100, probe: () => 'gone' }) });
    assert.deepStrictEqual([gone.removed, gone.failed], [[], []], `${what}: a pid that is not found`);
    assert.ok(fs.existsSync(path.join(deadDir, OWNER_FILE)), `${what}: still recorded`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The plugin's folder is a courtesy to the next run: used when it can be, never a reason for this run to fail
// ---------------------------------------------------------------------------------------------------------------------

const rootCanWrite = POSIX && process.getuid() === 0;
const WINDOWS = process.platform === 'win32';
const onlyWindows = { skip: !WINDOWS && 'Windows access control lists' };
// icacls and whoami are the programs of Windows itself, started from System32 as the module that reads access lists starts them (helpers/windows-system-tools.js).
const runWindows = (program, args) => {
  const run = spawnSync(systemTool(program), args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (run.error || run.status !== 0) throw new Error(`${program} ${args.join(' ')} → ${run.error ? run.error.message : run.status}: ${run.stdout}${run.stderr}`);
  return run.stdout;
};
const currentSid = () => /S-1-\d+(?:-\d+)+/.exec(runWindows('whoami', ['/user', '/fo', 'csv', '/nh']))[0];

test('a plugin\'s folder that exists, is the user\'s and will not take a new folder is skipped for the temp folder, as before — whatever refuses, and only there — and the error is the temp folder\'s, when it fails too', (t) => {
  for (const code of ['EROFS', 'ENOSPC', 'EIO', 'EMFILE', undefined]) {
    const { root, deps } = tempRoot(t);
    const parent = workspaceParent(deps);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const asked = [];
    const dir = makeTempWorkspace('genpage-', {
      ...deps,
      mkdtempSync: (start) => {
        asked.push(start);
        if (path.dirname(start) === parent) throw Object.assign(new Error(`${code}: refused in the plugin's folder`), { code });
        return fs.mkdtempSync(start);
      },
    });
    assert.strictEqual(path.dirname(dir), root, `${code}: made in the temp folder`);
    assert.match(path.basename(dir), /^genpage-[A-Za-z0-9]{6}$/, `${code}: named exactly as fs.mkdtempSync names it`);
    assert.deepStrictEqual(asked, [path.join(parent, `genpage-${process.pid}-`), path.join(root, 'genpage-')], `${code}: the plugin's folder first, then the call it always made`);
    assert.deepStrictEqual(fs.readdirSync(dir), [], `${code}: unrecorded, so never swept`);
    assert.deepStrictEqual(fs.readdirSync(parent), [], `${code}: nothing was made in the folder that refused`);
  }
});

// Windows removes a folder in two steps — it is marked, and it goes when the last handle on it closes — and in between it refuses a new entry with EPERM (measured, with four runs
// ending and starting at once, each ending run removing the plugin's folder when it was the last to leave it). That is not a refusal of the folder: it is asked again after a short wait.
// `uid: null` is the system with no owners to compare — Windows — whatever this one is.
test('(Windows) a plugin\'s folder that is being removed refuses a new entry for a moment: the run asks again after a short wait and uses it — and one that keeps refusing is not used, and not asked again', (t) => {
  const refusal = (code) => Object.assign(new Error(`${code}: operation not permitted, mkdir`), { code });
  // mkdir of the plugin's folder, refused twice, then made.
  const a = tempRoot(t);
  const slept = [];
  let mkdirs = 0;
  const flakyMkdir = { ...fs, mkdirSync: (target, ...rest) => { if (target === workspaceParent({ ...a.deps, uid: null }) && (mkdirs += 1) <= 2) throw refusal('EPERM'); return fs.mkdirSync(target, ...rest); } };
  const made = makeTempWorkspace('genpage-', { ...a.deps, uid: null, fs: flakyMkdir, folderPrivacy: () => ({ ok: true }), pause: (ms) => slept.push(ms) });
  assert.strictEqual(path.dirname(made), workspaceParent({ ...a.deps, uid: null }), 'the folder was made, and is used');
  assert.ok(isOwnerStamp(JSON.parse(fs.readFileSync(path.join(made, OWNER_FILE), 'utf8'))), 'and the workspace is recorded');
  assert.deepStrictEqual([mkdirs, slept], [3, [25, 50]], 'asked three times, with short waits between');

  // mkdtemp in it, refused twice, then made.
  const b = tempRoot(t);
  const parentB = workspaceParent({ ...b.deps, uid: null });
  fs.mkdirSync(parentB);
  const sleptB = [];
  let refusals = 0;
  const viaB = makeTempWorkspace('genpage-', { ...b.deps, uid: null, folderPrivacy: () => ({ ok: true }), pause: (ms) => sleptB.push(ms), mkdtempSync: (start) => { if (path.dirname(start) === parentB && (refusals += 1) <= 2) throw refusal('EBUSY'); return fs.mkdtempSync(start); } });
  assert.strictEqual(path.dirname(viaB), parentB);
  assert.deepStrictEqual([refusals, sleptB], [3, [25, 50]]);

  // A folder that refuses every time: the waits, the plain temp folder — and the next workspace of this process does not ask it again.
  const c = tempRoot(t);
  const parentC = workspaceParent({ ...c.deps, uid: null });
  fs.mkdirSync(parentC);
  const sleptC = [];
  const askedC = [];
  const refusing = { ...c.deps, uid: null, folderPrivacy: () => ({ ok: true }), pause: (ms) => sleptC.push(ms), mkdtempSync: (start) => { askedC.push(path.dirname(start)); if (path.dirname(start) === parentC) throw refusal('EACCES'); return fs.mkdtempSync(start); } };
  const first = makeTempWorkspace('genpage-', refusing);
  assert.strictEqual(path.dirname(first), c.root);
  assert.deepStrictEqual(askedC, [parentC, parentC, parentC, parentC, parentC, parentC, c.root], 'six tries in the folder, then the temp folder');
  assert.deepStrictEqual(sleptC, [25, 50, 100, 200, 400]);
  askedC.length = 0;
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', refusing)), c.root);
  assert.deepStrictEqual(askedC, [c.root], 'the folder that refused is not asked again by this process');
});

// A folder that is being removed cannot be opened, so its access list cannot be got either — icacls runs and says so (lib/windows-folder-acl.js `unreadable`). That says nothing about who may change
// the folder: it is not remembered as a verdict, and the run asks again after a wait, finding the folder gone (and making it) or readable.
test('(Windows) an access list that cannot be got for a moment is no verdict: it is not remembered, and the run asks again after a short wait — and a folder that is replaced while it is being judged is judged again', (t) => {
  const unreadable = { ok: false, unreadable: true, reason: 'its access list could not be saved (icacls /save)' };
  // Unreadable twice, then private.
  const a = tempRoot(t);
  const parentA = workspaceParent({ ...a.deps, uid: null });
  fs.mkdirSync(parentA);
  const slept = [];
  let askedA = 0;
  const made = makeTempWorkspace('genpage-', { ...a.deps, uid: null, folderPrivacy: () => ((askedA += 1) <= 2 ? unreadable : { ok: true, reason: 'private' }), pause: (ms) => slept.push(ms) });
  assert.strictEqual(path.dirname(made), parentA, 'the folder is used once it can be read');
  assert.ok(recordOfFolder(made), 'and the workspace is recorded');
  assert.deepStrictEqual([askedA, slept], [3, [25, 50]], 'asked three times: what could not be got was not taken for an answer');

  // Unreadable every time: the waits, then the plain temp folder, unrecorded — and the folder is not asked about again by this process.
  const b = tempRoot(t);
  const parentB = workspaceParent({ ...b.deps, uid: null });
  fs.mkdirSync(parentB);
  const sleptB = [];
  let askedB = 0;
  const stuck = { ...b.deps, uid: null, folderPrivacy: () => { askedB += 1; return unreadable; }, pause: (ms) => sleptB.push(ms) };
  const fallback = makeTempWorkspace('genpage-', stuck);
  assert.strictEqual(path.dirname(fallback), b.root);
  assert.strictEqual(recordOfFolder(fallback), null, 'unrecorded, so never swept');
  assert.deepStrictEqual([askedB, sleptB], [6, [25, 50, 100, 200, 400]]);
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', stuck)), b.root);
  assert.strictEqual(askedB, 6, 'not asked again');

  // A verdict about a folder that was replaced while it was being judged — removed and made again by another run, which is a folder with another file id — is not the verdict of the folder now there.
  const c = tempRoot(t);
  const parentC = workspaceParent({ ...c.deps, uid: null });
  fs.mkdirSync(parentC);
  let identity = 1;
  const identified = { ...fs, lstatSync: (target, ...rest) => {
    const st = fs.lstatSync(target, ...rest);
    return target === parentC ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: identity }) : st;
  } };
  const verdicts = [];
  const replaced = { ...c.deps, uid: null, fs: identified, pause: () => {}, folderPrivacy: () => {
    verdicts.push(identity);
    if (verdicts.length === 1) identity = 2;
    return { ok: verdicts.length > 1, reason: 'judged' };
  } };
  const viaC = makeTempWorkspace('genpage-', replaced);
  assert.strictEqual(path.dirname(viaC), parentC, 'the folder that is there now is used, on the verdict about it');
  assert.deepStrictEqual(verdicts, [1, 2], 'a "no" about the folder that was there is not taken for a "no" about this one');
});

// Where the system has owners (POSIX), a folder that answers EPERM or EACCES is saying what it says: it does not go away in a moment. On Windows, which has none, the folder is shown
// to the maker as one this user owns, so that the same rule is held there.
test('a refusal that is not Windows\'s is the answer it sounds like: EPERM or EACCES from a plugin\'s folder where the system has owners is not asked again', (t) => {
  const uid = POSIX ? process.getuid() : 4242;
  for (const code of ['EACCES', 'EPERM']) {
    const { root, deps } = tempRoot(t);
    const parent = workspaceParent({ ...deps, uid });
    fs.mkdirSync(parent, { mode: 0o700 });
    const ownedByUs = { isDirectory: () => true, uid, mode: 0o40700 };
    const fsx = POSIX ? fs : { ...fs, lstatSync: (target, ...rest) => (target === parent ? ownedByUs : fs.lstatSync(target, ...rest)) };
    const asked = [];
    const slept = [];
    const dir = makeTempWorkspace('genpage-', { ...deps, uid, fs: fsx, pause: (ms) => slept.push(ms), mkdtempSync: (start) => { asked.push(path.dirname(start)); if (path.dirname(start) === parent) throw Object.assign(new Error(`${code}: refused`), { code }); return fs.mkdtempSync(start); } });
    assert.strictEqual(path.dirname(dir), root, code);
    assert.deepStrictEqual([asked, slept], [[parent, root], []], `${code}: asked once, no waiting`);
  }
});

test('POSIX: a plugin\'s folder this user owns but cannot add to (mode 0500) is not a reason to fail: the workspace is made in the temp folder', { skip: (!POSIX && 'POSIX modes') || (rootCanWrite && 'root can add to any folder') }, (t) => {
  const { root, deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.chmodSync(parent, 0o500);
  // The mode is given back in the test itself, not in a later `t.after`: hooks run in the order they were added, so
  // tempRoot's removal of the whole temp folder ran first and the chmod then found no folder (ENOENT).
  try {
    const dir = makeTempWorkspace('genpage-', deps);
    assert.strictEqual(path.dirname(dir), root);
    assert.deepStrictEqual(fs.readdirSync(parent), []);
  } finally {
    fs.chmodSync(parent, 0o700);
  }
});

test('Windows: a plugin\'s folder that exists and denies this user the right to add a folder (as a read-only one does) is skipped — the workspace is made in the temp folder', onlyWindows, (t) => {
  const { root, deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent);
  const sid = currentSid();
  runWindows('icacls', [parent, '/deny', `*${sid}:(AD)`]);
  try {
    // Control: the deny must hold for this account. It does not for every one — on a CI runner, whose account is the machine's built-in
    // Administrator and whose processes run elevated, a folder was made in it all the same — and then there is nothing to show here.
    let denied = false;
    try { fs.rmdirSync(fs.mkdtempSync(path.join(parent, 'probe-'))); } catch (e) { denied = ['EPERM', 'EACCES'].includes(e && e.code); if (!denied) throw e; }
    if (!denied) { t.skip('this account can add a folder to one whose list denies it that right'); return; }
    const dir = makeTempWorkspace('genpage-', deps);
    assert.strictEqual(path.dirname(dir), root);
    assert.deepStrictEqual(fs.readdirSync(parent), []);
  } finally {
    runWindows('icacls', [parent, '/remove:d', `*${sid}`]);
  }
});

test('Windows: an existing plugin\'s folder that others can write to is neither used nor swept — its access list is read — and one that only this user, the system and the administrators can change is', onlyWindows, (t) => {
  const open = tempRoot(t, { realReader: true });
  const openParent = workspaceParent(open.deps);
  fs.mkdirSync(openParent);
  runWindows('icacls', [openParent, '/grant', '*S-1-1-0:(OI)(CI)M']); // Everyone: modify
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', open.deps)), open.root, 'Everyone can modify it: the workspace is made in the temp folder');
  assert.deepStrictEqual(fs.readdirSync(openParent), [], 'and nothing was made in it');
  const planted = plant(open.deps, goneRecord());
  assert.deepStrictEqual(sweepDeadWorkspaces(open.deps).removed, [], 'a workspace of a dead run in a folder anyone can write to is not believed');
  assert.ok(fs.existsSync(planted));

  // The control: a folder whose access list is this user's alone — the list is set, not left to the machine's temp folder. (On a runner whose user is the machine's own Administrator, renamed,
  // SDDL writes that user as LA: this is the run that shows the alias is read.)
  const clean = tempRoot(t, { realReader: true });
  const cleanParent = workspaceParent(clean.deps);
  fs.mkdirSync(cleanParent);
  runWindows('icacls', [cleanParent, '/inheritance:r', '/grant:r', `*${currentSid()}:(OI)(CI)F`]);
  const { windowsFolderIsPrivate } = require('../lib/windows-folder-acl.js');
  const verdict = windowsFolderIsPrivate(cleanParent);
  assert.strictEqual(verdict.ok, true, verdict.reason);
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', clean.deps)), cleanParent, 'an existing folder only this user can change is used');
});

test('where the system has no owners to compare (Windows) an EXISTING plugin\'s folder is used and swept only if its access list says it is private to this user — asked once per folder and process — and a folder the process makes itself is not asked about', (t) => {
  const asked = [];
  const privacy = (ok) => (folder) => { asked.push(folder); return { ok, reason: ok ? 'private' : 'Everyone can write to it' }; };
  // An existing folder that is not private.
  const shared = tempRoot(t);
  const sharedDeps = { ...shared.deps, uid: null, folderPrivacy: privacy(false) };
  fs.mkdirSync(workspaceParent(sharedDeps));
  const planted = plant(sharedDeps, goneRecord());
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', sharedDeps)), shared.root, 'not used');
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', sharedDeps)), shared.root, 'not used the next time either');
  assert.deepStrictEqual(sweepDeadWorkspaces(sharedDeps).removed, [], 'nor swept');
  assert.ok(fs.existsSync(planted), 'what is in it is not believed');
  assert.deepStrictEqual(asked, [workspaceParent(sharedDeps)], 'the access list was read once, for all three');
  // An existing folder that is.
  const own = tempRoot(t);
  const ownDeps = { ...own.deps, uid: null, folderPrivacy: privacy(true) };
  fs.mkdirSync(workspaceParent(ownDeps));
  const dead = plant(ownDeps, goneRecord());
  const made = makeTempWorkspace('genpage-', ownDeps);
  assert.strictEqual(path.dirname(made), workspaceParent(ownDeps), 'used');
  assert.ok(!fs.existsSync(dead), 'and swept');
  // A folder this process makes itself is as exposed as the temp folder it is made in — which is where the workspace was before there was a folder of the plugin's own.
  const fresh = tempRoot(t);
  asked.length = 0;
  const freshDeps = { ...fresh.deps, uid: null, folderPrivacy: privacy(false) };
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', freshDeps)), workspaceParent(freshDeps));
  assert.deepStrictEqual(asked, [], 'not asked');
  // A folder that is a link is not one, whoever it belongs to, and is not asked about either.
  const link = tempRoot(t);
  const linkDeps = { ...link.deps, uid: null, folderPrivacy: privacy(true) };
  const elsewhere = fs.mkdtempSync(path.join(link.root, 'elsewhere-'));
  fs.symlinkSync(elsewhere, workspaceParent(linkDeps), 'junction');
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', linkDeps)), link.root);
  assert.deepStrictEqual(asked, []);
});

test('a folder that is removed while its access list is being read — removed whole, as a tool that empties the temp folder does: the end of another run cannot take it, see below — is made again, not taken for an unsafe one', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent({ ...deps, uid: null });
  fs.mkdirSync(parent);
  let asked = 0;
  // What the reader makes of a folder that goes away under it: it cannot save a list of what is not there, and says no.
  const own = { ...deps, uid: null, folderPrivacy: () => { asked += 1; fs.rmSync(parent, { recursive: true, force: true }); return { ok: false, reason: 'its access list could not be saved' }; } };
  const dir = makeTempWorkspace('genpage-', own);
  assert.strictEqual(path.dirname(dir), parent, 'made again in the plugin\'s folder, as the run that asked is owed — not in the temp folder, unrecorded');
  assert.ok(recordOfFolder(dir), 'and recorded');
  assert.strictEqual(asked, 1, 'the folder it was made in is the run\'s own, which is not asked about');
});

// Windows asks whether a folder is private with three programs — about a second — and the end of every run that leaves nothing in the plugin's folder removes it (`rmdir`: THE END OF A RUN). With runs starting and
// ending side by side the folder was taken away, and made again, while it was being judged: the answer was about a folder that had gone, the run asked again about the new one, and after MAKE_ATTEMPTS answers made its
// workspace in the plain temp folder, unrecorded (measured on one machine: about one run in twenty with three at a time, one in three with twelve). A run now HOLDS the folder while it judges it.
// A hold is named for the machine and the run that made it: `.hold-<8 hex digits for the machine>-<pid>-<6 hex digits>`.
const holdName = new RegExp(`^${HOLD_PREFIX.replace(/\./g, '\\.')}[0-9a-f]{8}-${process.pid}-[0-9a-f]{6}$`);
// The hold a run leaves when it is killed while it holds the plugin's folder: made by the maker itself, on Windows terms (`deps` has `uid: null`), for the run `owner` says — its pid and
// machine (process-owner.js seams) — on a file system that never lets a hold be removed. The workspace the run made is removed again, so the hold is what is left. Answers its path.
function leftHold(deps, owner) {
  const parent = workspaceParent(deps);
  const before = new Set(fs.existsSync(parent) ? fs.readdirSync(parent) : []);
  const sticky = { ...fs, unlinkSync: (file, ...rest) => {
    if (path.basename(String(file)).startsWith(HOLD_PREFIX)) throw Object.assign(new Error(`EIO: i/o error, unlink '${file}'`), { code: 'EIO' });
    return fs.unlinkSync(file, ...rest);
  } };
  fs.rmSync(makeTempWorkspace('genpage-', { ...deps, fs: sticky, owner }), { recursive: true, force: true });
  const made = fs.readdirSync(parent).filter((name) => name.startsWith(HOLD_PREFIX) && !before.has(name));
  assert.strictEqual(made.length, 1, `one hold left: ${JSON.stringify(made)}`);
  return path.join(parent, made[0]);
}
// `rmdir` of a folder with something in it: ENOTEMPTY, or EEXIST where the system says so.
const notEmpty = (code) => (code === 'EEXIST' ? 'ENOTEMPTY' : code);

test('(Windows) a run that ends while another is judging the plugin\'s folder cannot take the folder from under it — the judging run holds it — so the answer is about the folder its workspace is made in', (t) => {
  const { deps } = tempRoot(t);
  const own = { ...deps, uid: null };
  const parent = workspaceParent(own);
  fs.mkdirSync(parent);
  const ends = [];
  // At every judgement another run ends with nothing of its own left in the folder — its end takes the folder with `rmdir`, as pruneWorkspaceParents does, which takes a folder only when it is empty — and a third
  // run starts and makes the folder again.
  const judging = { ...own, folderPrivacy: (folder) => {
    try {
      fs.rmdirSync(folder);
      fs.mkdirSync(folder);
      ends.push('taken, and made again');
    } catch (e) {
      ends.push(notEmpty(e.code));
    }
    return { ok: true, reason: 'private' };
  } };
  const dir = makeTempWorkspace('genpage-', judging);
  assert.strictEqual(path.dirname(dir), parent, `made in the plugin's folder — not in the temp folder because every answer was about a folder that had gone: ${ends.join(', ')}`);
  assert.ok(recordOfFolder(dir), 'and recorded, so a sweep finds it if the run is killed');
  assert.deepStrictEqual(ends, ['ENOTEMPTY'], 'the end of the other run could not take the folder, and the folder was judged once');
  assert.deepStrictEqual(fs.readdirSync(parent), [path.basename(dir)], 'the hold is gone once the workspace is in the folder: the workspace is all it holds');
});

test('(Windows) the hold is an empty file of the run\'s own, in the folder while it is judged and gone when makeTempWorkspace returns — whether the workspace is made there or refused — and a hold that cannot be made leaves the run as it was', (t) => {
  const listed = (folder) => fs.readdirSync(folder).map((name) => [name, fs.lstatSync(path.join(folder, name)).size]);
  // While the folder is judged, and while the workspace is made in it.
  const a = tempRoot(t);
  const own = { ...a.deps, uid: null };
  const parent = workspaceParent(own);
  fs.mkdirSync(parent);
  const seen = [];
  const dir = makeTempWorkspace('genpage-', { ...own,
    folderPrivacy: (folder) => { seen.push(['judged', listed(folder)]); return { ok: true }; },
    mkdtempSync: (start) => { seen.push(['made', listed(path.dirname(start))]); return fs.mkdtempSync(start); } });
  assert.strictEqual(path.dirname(dir), parent);
  assert.strictEqual(seen.length, 2, JSON.stringify(seen));
  const [[whenJudged, judged], [whenMade, atMake]] = seen;
  assert.deepStrictEqual([whenJudged, whenMade], ['judged', 'made']);
  assert.strictEqual(judged.length, 1, `one file in the folder while it is judged: ${JSON.stringify(judged)}`);
  const [[hold, size]] = judged;
  assert.match(hold, holdName, 'named for the run');
  assert.strictEqual(size, 0, 'and empty: it holds nothing');
  assert.deepStrictEqual(atMake, [[hold, 0]], 'still there when the workspace is made: the folder judged is the folder it is made in');
  assert.deepStrictEqual(fs.readdirSync(parent), [path.basename(dir)], 'and gone once the workspace is in the folder');

  // Refused: the folder is not private, or will not take a workspace (a full disk there) — the hold goes all the same, and the workspace is made in the temp folder, as before.
  const fullDisk = (root) => (start) => {
    if (path.dirname(start) !== root) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return fs.mkdtempSync(start);
  };
  for (const [what, extra] of [
    ['not private', () => ({ folderPrivacy: () => ({ ok: false, reason: 'Everyone can write to it' }) })],
    ['a full disk', (root) => ({ folderPrivacy: () => ({ ok: true }), mkdtempSync: fullDisk(root) })],
  ]) {
    const b = tempRoot(t);
    const refusedDeps = { ...b.deps, uid: null, ...extra(b.root) };
    fs.mkdirSync(workspaceParent(refusedDeps));
    assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', refusedDeps)), b.root, `${what}: made in the temp folder`);
    assert.deepStrictEqual(fs.readdirSync(workspaceParent(refusedDeps)), [], `${what}: no hold is left in the plugin's folder`);
  }

  // A hold that cannot be made — a full disk, a folder that takes no new file — is no reason to change anything: the workspace is made in the plugin's folder, recorded, as it was before holds.
  const c = tempRoot(t);
  const noHold = { ...fs, openSync: (file, ...rest) => { if (path.basename(String(file)).startsWith(HOLD_PREFIX)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return fs.openSync(file, ...rest); } };
  fs.mkdirSync(workspaceParent({ ...c.deps, uid: null }));
  const unheld = makeTempWorkspace('genpage-', { ...c.deps, uid: null, fs: noHold });
  assert.strictEqual(path.dirname(unheld), workspaceParent({ ...c.deps, uid: null }));
  assert.ok(recordOfFolder(unheld));
});

// The last steps of making a workspace are to record it (its owner record), to register it for the end of the process, and to let go of the hold. Letting go can wait on a scanner that holds
// the new file (releaseHold, the WAITS_MS pauses), and a run that is killed in that wait must leave a workspace a sweep can prove dead — not an empty folder with no record, which no sweep
// ever takes, and which keeps the plugin's folder for good. So the hold goes last.
test('REAL KILL: a run killed while the removal of its hold waits on a scanner has already recorded its workspace — the next sweep takes the workspace and the hold, and the folder can go', async (t) => {
  const root = privateTempRoot(t);
  const deps = { os: { tmpdir: () => root }, uid: null, folderPrivacy: () => ({ ok: true, reason: 'stood in for' }), folderProtect: () => ({ ok: true, reason: 'stood in for' }) };
  const run = startTarget(t, ['workspace-hold-release', 'genpage-'], { env: tempEnv(root) });
  const folder = (await run.waitFor(/^releasing /)).slice('releasing '.length);
  await run.kill();
  assert.strictEqual(path.dirname(folder), workspaceParent(deps), 'the workspace was made in the plugin\'s folder');
  assert.ok(recordOfFolder(folder), `it was recorded before the hold was let go, so a sweep can prove its run gone: ${JSON.stringify(fs.readdirSync(folder))}`);
  assert.ok(fs.readdirSync(workspaceParent(deps)).some((name) => name.startsWith(HOLD_PREFIX)), 'and the killed run left its hold');
  const swept = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual(swept.removed.map((r) => [r.name, r.stamp.pid]), [[path.basename(folder), run.pid]], 'the next sweep takes the workspace');
  assert.deepStrictEqual(fs.readdirSync(workspaceParent(deps)), [], 'and the hold: nothing is left to keep the plugin\'s folder');
});

test('POSIX: nothing is held — the folder is judged by one lstat, before anything could change — and the folder holds only the workspace', onlyPosix, (t) => {
  const { deps } = tempRoot(t);
  const atMake = [];
  const dir = makeTempWorkspace('genpage-', { ...deps, mkdtempSync: (start) => { atMake.push(...fs.readdirSync(path.dirname(start))); return fs.mkdtempSync(start); } });
  assert.strictEqual(path.dirname(dir), workspaceParent(deps));
  assert.deepStrictEqual(atMake, [], 'no hold in the folder when the workspace is made');
});

test('(Windows) a hold that a run was killed while holding is removed by the next sweep once its pid is gone, so the folder can go when it is empty — and the hold of a run that is going, or a file of that name with something in it, is left', (t) => {
  const { deps } = tempRoot(t);
  const own = { ...deps, uid: null };
  const parent = workspaceParent(own);
  const dead = deadPid();
  // All that is left in the folder is the hold of a run that was killed: the end of a run cannot take the folder until a sweep has removed it.
  const deadHold = leftHold(own, { pid: dead });
  assert.deepStrictEqual(fs.readdirSync(parent), [path.basename(deadHold)]);
  assert.throws(() => fs.rmdirSync(parent), (e) => notEmpty(e.code) === 'ENOTEMPTY', 'the hold keeps the folder');
  assert.deepStrictEqual([sweepDeadWorkspaces(own).removed, fs.existsSync(deadHold)], [[], false], 'the sweep removes it, and says nothing: a hold held nothing');
  fs.rmdirSync(parent);
  // The hold of a run that is going, and a file named like a hold that has something in it, are left.
  const liveHold = leftHold(own, {});
  const notAHold = leftHold(own, { pid: dead });
  fs.writeFileSync(notAHold, 'something');
  const swept = sweepDeadWorkspaces(own);
  assert.ok(fs.existsSync(liveHold), 'the hold of a run that is going is left');
  assert.ok(fs.existsSync(notAHold), 'a file of that name with something in it was not made by a run, and is left');
  assert.deepStrictEqual([swept.removed, swept.failed], [[], []]);
  assert.deepStrictEqual(entriesOf(parent), [path.basename(liveHold), path.basename(notAHold)].sort());
});

// A temp folder can be shared between machines — a network share, a profile that roams — and a pid says nothing on a machine that did not make it: one that no process has here may be a run
// that is going there. So a hold names its machine, as an owner record names its host (process-owner.js), and a sweep takes only a hold of its own machine. A hold of another machine stays,
// and so does every hold, when a sweep cannot tell which machine it runs on (no host name).
test('(Windows) a hold names its machine: a sweep on another machine that shares the temp folder leaves it, whatever the pid in it is there — so the end of a run there cannot take the folder from under this run\'s judgement', (t) => {
  const { deps } = tempRoot(t);
  const own = { ...deps, uid: null };
  const parent = workspaceParent(own);
  fs.mkdirSync(parent);
  // On the other machine, no process has this run's pid.
  const otherMachine = { ...own, owner: { hostname: () => 'another-machine', probe: () => 'gone' } };
  const seen = [];
  const dir = makeTempWorkspace('genpage-', { ...own, owner: { hostname: () => 'this-machine' }, folderPrivacy: (folder) => {
    // While this run judges the folder, a run on the other machine sweeps it, and ends with nothing of its own left in it.
    sweepDeadWorkspaces(otherMachine);
    const left = fs.readdirSync(folder);
    let ended;
    try {
      fs.rmdirSync(folder);
      fs.mkdirSync(folder);
      ended = 'taken, and made again';
    } catch (e) {
      ended = notEmpty(e.code);
    }
    seen.push({ left, ended });
    return { ok: true, reason: 'private' };
  } });
  assert.strictEqual(seen.length, 1, `the folder was judged once: ${JSON.stringify(seen)}`);
  assert.strictEqual(seen[0].left.length, 1, `this run's hold is still in the folder after the other machine's sweep: ${JSON.stringify(seen)}`);
  assert.ok(seen[0].left[0].startsWith(HOLD_PREFIX));
  assert.strictEqual(seen[0].ended, 'ENOTEMPTY', 'so the end of the run there could not take the folder');
  assert.strictEqual(path.dirname(dir), parent, 'and the workspace is in the plugin\'s folder');
  fs.rmSync(dir, { recursive: true, force: true });

  // A hold of this machine, of a run that is gone: a sweep that cannot read the name of its own machine leaves it; a sweep of this machine takes it.
  const thisMachine = { hostname: () => 'this-machine', probe: () => 'gone' };
  const gone = leftHold(own, { hostname: () => 'this-machine', pid: deadPid() });
  sweepDeadWorkspaces({ ...own, owner: { ...thisMachine, hostname: () => { throw new Error('no host name'); } } });
  assert.ok(fs.existsSync(gone), 'a sweep that cannot tell its own machine leaves every hold');
  sweepDeadWorkspaces({ ...own, owner: thisMachine });
  assert.ok(!fs.existsSync(gone), 'the sweep of its own machine takes it');
});

// Holds are made only where the system has no owners to compare (Windows), and only taken there: where it has (POSIX), a file of that shape in the plugin's folder is an entry like any
// other, and a sweep leaves it as it always did, however dead the pid in its name is. Shown on every system: the folder is shown to the sweep as one this user owns, with the mode a
// POSIX plugin folder has.
test('POSIX: a sweep where the system has owners leaves an empty file shaped like the hold of a dead run, as it always did — holds are made, and taken, only on Windows', (t) => {
  const { deps } = tempRoot(t);
  const uid = POSIX ? process.getuid() : 4242;
  const parent = workspaceParent({ ...deps, uid });
  fs.mkdirSync(parent, { mode: 0o700 });
  const ownedByUs = { isDirectory: () => true, isSymbolicLink: () => false, uid, mode: 0o40700 };
  const posix = { ...deps, uid, fs: { ...fs, lstatSync: (target, ...rest) => (target === parent ? ownedByUs : fs.lstatSync(target, ...rest)) }, owner: { probe: () => 'gone' } };
  // Named as the maker names the hold of a run of this machine that is gone — the maker made it, on Windows terms, in a temp folder of its own.
  const windowsTerms = tempRoot(t);
  const shaped = path.join(parent, path.basename(leftHold({ ...windowsTerms.deps, uid: null }, { pid: deadPid() })));
  fs.writeFileSync(shaped, '');
  const swept = sweepDeadWorkspaces(posix);
  assert.ok(fs.existsSync(shaped), 'left where it is');
  assert.deepStrictEqual([swept.removed, swept.failed], [[], []]);
});

test('the answer about a folder is the answer about THAT folder: one that is removed and made again — by someone else — is asked about again', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent({ ...deps, uid: null });
  fs.mkdirSync(parent);
  let identity = 1;
  let private_ = true;
  const asked = [];
  // The same path with another file id: what a folder that was removed and made again looks like.
  const identified = { ...fs, lstatSync: (target, ...rest) => {
    const st = fs.lstatSync(target, ...rest);
    return target === parent ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: identity }) : st;
  } };
  const own = { ...deps, uid: null, fs: identified, folderPrivacy: (folder) => { asked.push(folder); return { ok: private_, reason: 'asked' }; } };
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', own)), parent, 'a folder that is private is used');
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', own)), parent, 'and is not asked about again');
  assert.strictEqual(asked.length, 1);
  identity = 2;
  private_ = false;
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', own)), deps.os.tmpdir(), 'another folder under the same name has to answer for itself');
  assert.strictEqual(asked.length, 2);
});

// A folder another run has just made has the access list of the temp folder it is in until that run's icacls gives it one of its own (makeWindowsFolderPrivate). Where the temp folder lets others write —
// `TEMP` on a data drive gives Authenticated Users "modify" — a run that judges the folder in between is told "no" about a folder that is private a moment later, with the same identity.
const inheritedNo = { ok: false, inherited: true, reason: 'S-1-5-11 can add to it, remove from it or take it over' };

test('(Windows) a run that judges the plugin\'s folder while the run that made it is still giving it its own access list is not refused the folder for good: that "no" is asked again, and every workspace of the run is made in the folder', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent({ ...deps, uid: null });
  // Run A makes the folder just before this run does (this run's mkdir answers EEXIST), and gives it its own list a moment later: during this run's first pause, or — if this run does not pause — before its next workspace.
  let madeByA = false;
  let protectedByA = false;
  const racing = { ...fs, mkdirSync: (target, ...rest) => {
    if (target === parent && !madeByA) { madeByA = true; fs.mkdirSync(parent); }
    return fs.mkdirSync(target, ...rest);
  } };
  const asked = [];
  const slept = [];
  // The clock reads a moment after the folder was made (the file system's own creation time: a POSIX one may have none to give).
  const runB = { ...deps, uid: null, fs: racing, owner: { now: () => (fs.existsSync(parent) ? fs.lstatSync(parent).birthtimeMs + 100 : Date.now()) },
    folderPrivacy: () => { asked.push(protectedByA ? 'its own list' : 'inherited'); return protectedByA ? { ok: true, reason: 'private' } : inheritedNo; },
    folderProtect: () => assert.fail('run B did not make the folder, and does not set its list'),
    pause: (ms) => { slept.push(ms); protectedByA = true; } };
  const made = [];
  for (let i = 0; i < 6; i += 1) {
    made.push(makeTempWorkspace('genpage-', runB));
    protectedByA = true;
  }
  assert.deepStrictEqual(made.map((dir) => path.dirname(dir)), Array(6).fill(parent), 'every workspace of run B is made in the plugin\'s folder — none in the plain temp folder, unrecorded');
  assert.ok(made.every((dir) => recordOfFolder(dir)), 'and recorded');
  assert.deepStrictEqual([asked, slept], [['inherited', 'its own list'], [25]], 'the "no" about the inherited list was asked again after a pause; the "yes" is remembered');
});

test('(Windows) a "no" about a list that is still only inherited is asked again only while the folder is young: one its maker never made private is not used — every try is bounded — and once it is older than its maker could take, the "no" is final and remembered', (t) => {
  const { root, deps } = tempRoot(t);
  const parent = workspaceParent({ ...deps, uid: null });
  fs.mkdirSync(parent); // made, and never given a list of its own: its maker was killed before its icacls ran
  let now = fs.lstatSync(parent).birthtimeMs + 100; // a moment after it was made, by the file system's own clock
  let asked = 0;
  const slept = [];
  const stuck = { ...deps, uid: null, owner: { now: () => now }, folderPrivacy: () => { asked += 1; return inheritedNo; }, pause: (ms) => slept.push(ms) };
  const first = makeTempWorkspace('genpage-', stuck);
  assert.strictEqual(path.dirname(first), root, 'not used: the plain temp folder');
  assert.deepStrictEqual(fs.readdirSync(first), [], 'unrecorded, as before');
  assert.deepStrictEqual([asked, slept], [6, [25, 50, 100, 200, 400]], 'asked MAKE_ATTEMPTS times, with the waits of a refusal of the moment');
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', stuck)), root);
  assert.strictEqual(asked, 12, 'not refused for the life of the process: the next workspace asks again while the folder is young');
  // Older than any maker's icacls could take (PROTECT_WINDOW_MS): the "no" is what it says.
  now += 60000;
  slept.length = 0;
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', stuck)), root);
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', stuck)), root);
  assert.deepStrictEqual([asked, slept], [13, []], 'asked once, at once, and remembered: the forty-workspace run starts no more programs');
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'and nothing was made in it');
});

// ---------------------------------------------------------------------------------------------------------------------
// A folder this process makes on Windows takes the access list of the temp folder it is in, and `mode` means nothing there — so it is given a list of its own before anything is put in it
// ---------------------------------------------------------------------------------------------------------------------

test('(Windows) a folder this process makes is given an access list of its own — on the empty folder, before a workspace is made in it — and one that is already there is judged, never rewritten', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent({ ...deps, uid: null });
  const log = [];
  const own = {
    ...deps,
    uid: null,
    folderPrivacy: () => { log.push(['privacy']); return { ok: true }; },
    folderProtect: (folder) => { log.push(['protect', folder, fs.readdirSync(folder)]); return { ok: true, reason: 'set, and read back' }; },
    mkdtempSync: (start) => { log.push(['mkdtemp', path.dirname(start)]); return fs.mkdtempSync(start); },
  };
  const made = makeTempWorkspace('genpage-', own);
  assert.strictEqual(path.dirname(made), parent);
  assert.deepStrictEqual(log, [['protect', parent, []], ['mkdtemp', parent]], 'set on the empty folder, and only then a workspace in it; the reader is not asked about what was just set');
  makeTempWorkspace('genpage-', own);
  assert.deepStrictEqual(log.map(([what]) => what), ['protect', 'mkdtemp', 'mkdtemp'], 'the next workspace of this process neither sets it again nor asks');

  const existing = tempRoot(t);
  fs.mkdirSync(workspaceParent({ ...existing.deps, uid: null }));
  const seen = [];
  const viaExisting = makeTempWorkspace('genpage-', { ...existing.deps, uid: null, folderPrivacy: () => { seen.push('privacy'); return { ok: true }; }, folderProtect: () => { seen.push('protect'); return { ok: true }; } });
  assert.strictEqual(path.dirname(viaExisting), workspaceParent({ ...existing.deps, uid: null }));
  assert.deepStrictEqual(seen, ['privacy'], 'a folder that was there is read: someone else\'s list is not this process\'s to set');
});

test('POSIX: no access list is set on a folder this process makes — the mode is — and the Windows maker is never asked', onlyPosix, (t) => {
  const { deps } = tempRoot(t);
  const asked = [];
  const dir = makeTempWorkspace('genpage-', { ...deps, folderProtect: () => { asked.push('protect'); return { ok: false }; }, folderPrivacy: () => { asked.push('privacy'); return { ok: false }; } });
  assert.strictEqual(path.dirname(dir), workspaceParent(deps));
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(fs.statSync(workspaceParent(deps)).mode & 0o777, 0o700);
});

test('where the system has owners (a user id is given) no access list is set on a folder this process makes, and no program is started to read one — whatever the folder is then judged to be', (t) => {
  const { deps } = tempRoot(t);
  const asked = [];
  makeTempWorkspace('genpage-', { ...deps, uid: 12345, folderProtect: () => { asked.push('protect'); return { ok: false }; }, folderPrivacy: () => { asked.push('privacy'); return { ok: false }; } });
  assert.deepStrictEqual(asked, [], 'the mode is what protects a folder there: neither the Windows maker nor the Windows reader is asked, for a folder this process made');
});

test('(Windows) a folder that cannot be made private is not used and not left: it is removed, the workspace is made in the temp folder as before — unrecorded, never swept — and this process does not try again', (t) => {
  const { root, deps } = tempRoot(t);
  const parent = workspaceParent({ ...deps, uid: null });
  const asked = [];
  const refused = { ...deps, uid: null, folderProtect: (folder) => { asked.push(folder); return { ok: false, reason: 'its access list is not what was set: it has an entry for S-1-1-0' }; } };
  const first = makeTempWorkspace('genpage-', refused);
  assert.strictEqual(path.dirname(first), root, 'made in the temp folder');
  assert.deepStrictEqual(fs.readdirSync(first), [], 'unrecorded: never swept');
  assert.ok(!fs.existsSync(parent), 'the folder that could not be made private is not left behind');
  assert.deepStrictEqual(asked, [parent]);
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', refused)), root);
  assert.deepStrictEqual(asked, [parent], 'a folder that was refused is not made, and set, again by this process: it costs programs, and the answer will not change');
});

// A run, as another process has it: what a process remembers (its verdicts, the folders it refuses) is its own.
function anotherRun() {
  const file = require.resolve('../lib/temp-workspace.js');
  const mine = require.cache[file];
  delete require.cache[file];
  try {
    return require('../lib/temp-workspace.js');
  } finally {
    require.cache[file] = mine;
  }
}

// THE FOLDER A FAILED MAKER LEAVES. Run A makes the plugin's folder and its icacls fails; run B, which found the folder a moment after A made it, is judging it — its hold is in it — so A's `rmdir`
// is refused. A single `rmdir` left the folder for good: empty, with the temp folder's list, and every later run was told "no" about it once it was older than a maker could take. The maker waits
// for the holds to go, and removes the folder it made; whatever it did not make, or anything but holds in it, it leaves.
const holdOfB = `${HOLD_PREFIX}0a1b2c3d-4242-abcdef`;
function failingMaker(deps, parent, { onProtect = () => fs.writeFileSync(path.join(parent, holdOfB), ''), onPause = () => {} } = {}) {
  let now = 1000000;
  const paused = [];
  const run = { ...deps, uid: null, owner: { now: () => now },
    folderProtect: () => { onProtect(); return { ok: false, reason: 'its access list could not be set (icacls could not be run)' }; },
    pause: (ms) => { paused.push(ms); now += ms; onPause(paused.length); } };
  return { run, paused };
}

test('(Windows) a folder its maker could not make private, while another run held it, is removed by the maker once that run lets go — and a later run makes, protects and uses a folder of its own instead of working outside it for good', (t) => {
  const { root, deps } = tempRoot(t);
  const parent = workspaceParent({ ...deps, uid: null });
  // B judges the folder (holding it), is told "not yet", lets go and pauses: here, during A's third look.
  const a = failingMaker(deps, parent, { onPause: (n) => { if (n === 3) fs.unlinkSync(path.join(parent, holdOfB)); } });
  assert.strictEqual(path.dirname(anotherRun().makeTempWorkspace('genpage-', a.run)), root, 'run A, whose folder could not be made private, works in the plain temp folder, as before');
  assert.ok(!fs.existsSync(parent), 'and the folder it made is not left behind: removed once B let go');
  assert.deepStrictEqual(a.paused, [20, 20, 20], 'it looked again every REMOVE_PAUSE_MS until it could');
  const asked = [];
  const later = { ...deps, uid: null, owner: { now: () => (fs.existsSync(parent) ? fs.lstatSync(parent).birthtimeMs + 60000 : Date.now()) },
    folderPrivacy: () => { asked.push('privacy'); return inheritedNo; },
    folderProtect: (folder) => { asked.push('protect'); assert.deepStrictEqual(fs.readdirSync(folder), []); return { ok: true, reason: 'set, and read back' }; } };
  const runC = anotherRun();
  const made = [runC.makeTempWorkspace('genpage-', later), runC.makeTempWorkspace('genpage-', later)];
  assert.deepStrictEqual(made.map((dir) => path.dirname(dir)), [parent, parent], 'a later run works in the plugin\'s folder — not in the plain temp folder, unrecorded');
  assert.ok(made.every((dir) => recordOfFolder(dir)), 'and recorded');
  assert.deepStrictEqual(asked, ['protect'], 'it made the folder, and gave it its own list');
  // Windows refuses an rmdir with EPERM, not ENOTEMPTY, while a hold in the folder is being deleted: that is a moment, too.
  const { root: root2, deps: deps2 } = tempRoot(t);
  const parent2 = workspaceParent({ ...deps2, uid: null });
  let refused = 0;
  const b = failingMaker(deps2, parent2, { onProtect: () => {} });
  b.run.fs = { ...fs, rmdirSync: (target, ...rest) => {
    if (target === parent2 && refused < 2) { refused += 1; throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${target}'`), { code: 'EPERM' }); }
    return fs.rmdirSync(target, ...rest);
  } };
  assert.strictEqual(path.dirname(anotherRun().makeTempWorkspace('genpage-', b.run)), root2);
  assert.deepStrictEqual([fs.existsSync(parent2), b.paused], [false, [20, 20]], 'EPERM while a hold goes: looked again, and removed');
});

test('(Windows) a maker waiting to remove the folder it could not make private removes only that folder: one put in its place is left untouched, and so is a folder with anything but holds in it', (t) => {
  // Renamed away during the wait, and an empty folder of someone else's put at the path: removing it would remove what this run did not make.
  {
    const { root, deps } = tempRoot(t);
    const parent = workspaceParent({ ...deps, uid: null });
    const away = path.join(root, 'moved-away');
    let replacement = null;
    const a = failingMaker(deps, parent, { onPause: (n) => { if (n === 2) { fs.renameSync(parent, away); fs.mkdirSync(parent); replacement = fs.lstatSync(parent); } } });
    assert.strictEqual(path.dirname(anotherRun().makeTempWorkspace('genpage-', a.run)), root);
    assert.deepStrictEqual(a.paused, [20, 20], 'it stopped at the first look after the swap');
    const now = fs.lstatSync(parent);
    assert.deepStrictEqual([now.isDirectory(), now.ino, now.birthtimeMs, fs.readdirSync(parent)], [true, replacement.ino, replacement.birthtimeMs, []], 'the replacement is there, untouched');
    assert.deepStrictEqual(fs.readdirSync(away), [holdOfB], 'and the folder it made is where it was moved, as it was');
  }
  // Anything that is not a hold: it is in use, or not this run's to empty — not waited for, not touched.
  for (const [what, put] of [
    ['a workspace', (parent) => fs.mkdirSync(path.join(parent, `genpage-${deadPid()}-AbC123`))],
    ['a file', (parent) => fs.writeFileSync(path.join(parent, 'notes.txt'), 'theirs')],
    ['a folder named as a hold', (parent) => fs.mkdirSync(path.join(parent, `${HOLD_PREFIX}0a1b2c3d-4243-abcdef`))],
    ['a hold, and a workspace', (parent) => { fs.writeFileSync(path.join(parent, holdOfB), ''); fs.mkdirSync(path.join(parent, `genpage-${deadPid()}-AbC123`)); }],
  ]) {
    const { root, deps } = tempRoot(t);
    const parent = workspaceParent({ ...deps, uid: null });
    const a = failingMaker(deps, parent, { onProtect: () => put(parent) });
    assert.strictEqual(path.dirname(anotherRun().makeTempWorkspace('genpage-', a.run)), root, what);
    const left = entriesOf(parent);
    assert.deepStrictEqual([what, a.paused], [what, []], `${what}: not waited for`);
    assert.ok(left.length > 0 && left.every((name) => fs.existsSync(path.join(parent, name))), `${what}: left as it was`);
  }
});

test('(Windows) a maker waits for a hold that never goes for REMOVE_PATIENCE_MS at most: then the folder is left, as before, and the run works in the plain temp folder and does not try again', (t) => {
  const { root, deps } = tempRoot(t);
  const parent = workspaceParent({ ...deps, uid: null });
  const a = failingMaker(deps, parent);
  const runA = anotherRun();
  assert.strictEqual(path.dirname(runA.makeTempWorkspace('genpage-', a.run)), root);
  assert.deepStrictEqual([a.paused.length, a.paused.reduce((s, ms) => s + ms, 0)], [500, 10000], 'ten seconds of looks, twenty milliseconds apart');
  assert.deepStrictEqual(fs.readdirSync(parent), [holdOfB], 'the folder is left, with the other run\'s hold in it, untouched');
  assert.strictEqual(path.dirname(runA.makeTempWorkspace('genpage-', a.run)), root);
  assert.strictEqual(a.paused.length, 500, 'refused for the rest of the process (NOT_PRIVATE), as before: it does not wait again');
});

test('(Windows) a run told "not yet" about a folder that another run is making private does not hold it while it pauses — so the maker, if its protection failed, can remove it meanwhile', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent({ ...deps, uid: null });
  fs.mkdirSync(parent);
  const whileJudged = [];
  const whilePaused = [];
  const judge = { ...deps, uid: null, owner: { now: () => fs.lstatSync(parent).birthtimeMs + 100 },
    folderPrivacy: () => { whileJudged.push(entriesOf(parent).length); return inheritedNo; },
    pause: () => whilePaused.push(entriesOf(parent)) };
  makeTempWorkspace('genpage-', judge);
  assert.deepStrictEqual([whileJudged, whilePaused], [[1, 1, 1, 1, 1, 1], [[], [], [], [], []]], 'held while it is judged, and let go before every pause');
});

test('(Windows) an access list that cannot be set for a moment — icacls cannot open a folder that Windows is removing — is asked again after a short wait, and the folder made again; one that keeps failing ends as a refusal', (t) => {
  const unreadable = { ok: false, unreadable: true, reason: 'its access list could not be set (icacls /inheritance:r /grant:r)' };
  const a = tempRoot(t);
  const parentA = workspaceParent({ ...a.deps, uid: null });
  const slept = [];
  let tries = 0;
  let mkdirs = 0;
  const counting = { ...fs, mkdirSync: (target, ...rest) => { if (target === parentA) mkdirs += 1; return fs.mkdirSync(target, ...rest); } };
  const made = makeTempWorkspace('genpage-', { ...a.deps, uid: null, fs: counting, pause: (ms) => slept.push(ms), folderProtect: () => { tries += 1; return tries <= 2 ? unreadable : { ok: true, reason: 'set' }; } });
  assert.strictEqual(path.dirname(made), parentA, 'once it could be set, the folder is used');
  assert.deepStrictEqual([tries, mkdirs, slept], [3, 3, [25, 50]], 'each try was on a folder that was made for it: the one before was removed');
  assert.ok(recordOfFolder(made));

  const b = tempRoot(t);
  const sleptB = [];
  let triesB = 0;
  const stuck = { ...b.deps, uid: null, pause: (ms) => sleptB.push(ms), folderProtect: () => { triesB += 1; return unreadable; } };
  const fallback = makeTempWorkspace('genpage-', stuck);
  assert.strictEqual(path.dirname(fallback), b.root);
  assert.deepStrictEqual([triesB, sleptB], [6, [25, 50, 100, 200, 400]]);
  assert.ok(!fs.existsSync(workspaceParent({ ...b.deps, uid: null })), 'and nothing is left of the folder');
  assert.strictEqual(path.dirname(makeTempWorkspace('genpage-', stuck)), b.root);
  assert.strictEqual(triesB, 6, 'not asked again by this process');
});

test('(Windows) a folder that is replaced between its making and the setting of its list is not the folder that was made: what was said about it counts for nothing, and the folder that is there now is judged like any that was already there', (t) => {
  for (const [what, private_] of [['private', true], ['not private', false]]) {
    const { root, deps } = tempRoot(t);
    const parent = workspaceParent({ ...deps, uid: null });
    let identity = 1;
    const identified = { ...fs, lstatSync: (target, ...rest) => {
      const st = fs.lstatSync(target, ...rest);
      return target === parent ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: identity }) : st;
    } };
    const asked = [];
    const made = makeTempWorkspace('genpage-', {
      ...deps,
      uid: null,
      fs: identified,
      folderProtect: () => { asked.push('protect'); identity = 2; return { ok: true, reason: 'set' }; },
      folderPrivacy: () => { asked.push('privacy'); return { ok: private_, reason: 'judged' }; },
    });
    assert.deepStrictEqual(asked, ['protect', 'privacy'], `${what}: the answer about the folder that was made is dropped, and the folder that is there is read`);
    assert.strictEqual(path.dirname(made), private_ ? parent : root, `${what}: used only if the reader says it is private`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The same, with the programs of Windows itself
// ---------------------------------------------------------------------------------------------------------------------

// The access list of a file or folder as `icacls /save` writes it — SDDL, which names Everyone `WD` whatever the language of the machine — without the module's reader.
const savedList = (target) => {
  const file = path.join(os.tmpdir(), `temp-ws-acl-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    runWindows('icacls', [target, '/save', file]);
    return fs.readFileSync(file).toString('utf16le').split(/\r?\n/).find((line) => line.startsWith('D:'));
  } finally {
    fs.rmSync(file, { force: true });
  }
};

test('Windows: a folder this process makes in a temp folder that EVERYONE can write to is given a list of its own — the workspace and its record take nothing from Everyone — and that list is judged private by the reader', onlyWindows, (t) => {
  const { root, deps } = tempRoot(t, { realReader: true });
  runWindows('icacls', [root, '/grant', '*S-1-1-0:(OI)(CI)M']); // Everyone: modify, inherited by whatever is made in this temp folder
  const handmade = fs.mkdtempSync(path.join(root, 'handmade-'));
  assert.match(savedList(handmade), /;;;WD\)/, 'control: a folder made here the ordinary way takes Everyone\'s grant');

  const dir = makeTempWorkspace('genpage-', deps);
  const parent = workspaceParent(deps);
  assert.strictEqual(path.dirname(dir), parent, 'the plugin\'s folder is used: it was made private, and read back');
  const sid = currentSid();
  const list = savedList(parent);
  assert.match(list, /^D:P/, `protected: it takes nothing from the folder above: ${list}`);
  assert.doesNotMatch(list, /;;;WD\)/, `no entry for Everyone: ${list}`);
  assert.ok(sddlNamesOf(sid).some((name) => list.includes(`;;;${name})`)) && list.includes(';;;SY)') && list.includes(';;;BA)'), `this user, the system and the administrators: ${list}`);
  assert.doesNotMatch(savedList(dir), /;;;WD\)/, 'the workspace made inside it inherits nothing for Everyone');
  assert.doesNotMatch(savedList(path.join(dir, OWNER_FILE)), /;;;WD\)/, 'nor does its record, which a sweep believes');
  const { windowsFolderIsPrivate } = require('../lib/windows-folder-acl.js');
  const verdict = windowsFolderIsPrivate(parent);
  assert.strictEqual(verdict.ok, true, verdict.reason);
  assert.strictEqual(sweepDeadWorkspaces(deps).removed.length, 0, 'and a sweep of it (by this process, which made it) works');
});

test('Windows: an existing plugin\'s folder that grants Everyone modify ONLY to what is made inside it (an inherit-only entry) is not used, and what is in it is not believed — its records would be Everyone\'s', onlyWindows, (t) => {
  const { root, deps } = tempRoot(t, { realReader: true });
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent);
  runWindows('icacls', [parent, '/inheritance:r', '/grant:r', `*${currentSid()}:(OI)(CI)F`]);
  runWindows('icacls', [parent, '/grant', '*S-1-1-0:(OI)(CI)(IO)M']); // applies to what is inside, not to the folder itself
  assert.match(savedList(parent), /\(A;OICIIO;[^)]*;;;WD\)/, 'control: the grant is there, and inherit-only');
  const dir = makeTempWorkspace('genpage-', deps);
  assert.strictEqual(path.dirname(dir), root, 'not used: the workspace is made in the temp folder');
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'and nothing was made in it');
  const planted = plant(deps, goneRecord());
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed, [], 'a workspace of a dead run in it is not believed');
  assert.ok(fs.existsSync(planted));
  // The control: without that one entry the same folder is used.
  runWindows('icacls', [parent, '/remove:g', '*S-1-1-0']);
  const { windowsFolderIsPrivate } = require('../lib/windows-folder-acl.js');
  assert.strictEqual(windowsFolderIsPrivate(parent).ok, true);
});

// ---------------------------------------------------------------------------------------------------------------------
// A workspace lent to a program of another make. The program is not the run: pac, given a path inside the workspace, outlives a run that is killed on POSIX, and the workspace is its
// until it ends. The run says so when it MAKES the folder (`{ lent: true }`), the record is written once, and a sweep takes a lent folder only when its maker is gone AND it is old.
// ---------------------------------------------------------------------------------------------------------------------

const recordOfFolder = (dir) => {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'));
    return isOwnerStamp(stamp) ? stamp : null;
  } catch {
    return null;
  }
};
// Sets the times a folder and its record have, last write first: writing to a folder changes its own time, so the folder is dated after what is in it.
const dated = (dir, when) => {
  const date = new Date(when);
  fs.utimesSync(path.join(dir, OWNER_FILE), date, date);
  fs.utimesSync(dir, date, date);
};

test('a workspace made LENT says so once, in the one record it is made with — the record is written whole to a file of its own and renamed into place, and is never written again', (t) => {
  const { deps } = tempRoot(t);
  const log = [];
  const watched = {
    ...fs,
    writeFileSync: (file, data, options) => { log.push(['write', path.basename(file), options && options.flag]); return fs.writeFileSync(file, data, options); },
    renameSync: (from, to) => { log.push(['rename', path.basename(from), path.basename(to)]); return fs.renameSync(from, to); },
    rmSync: (target, ...rest) => { log.push(['remove', path.basename(target)]); return fs.rmSync(target, ...rest); },
  };
  const lent = makeTempWorkspace('solution-settings-', { ...deps, fs: watched, lent: true });
  const record = recordOfFolder(lent);
  assert.strictEqual(record.lent, true, 'it says so');
  assert.deepStrictEqual([record.pid, record.host, record.platform], [process.pid, os.hostname(), process.platform], 'and is the maker\'s record, as for any workspace');
  assert.strictEqual(path.dirname(lent), workspaceParent(deps));
  assert.deepStrictEqual(log.map(([what, ...rest]) => [what, ...rest.map((name) => name.replace(/\.\d+\.[a-z0-9]+\.tmp$/, '.<pid>.<random>.tmp'))]), [
    ['write', `${OWNER_FILE}.<pid>.<random>.tmp`, 'wx'],
    ['rename', `${OWNER_FILE}.<pid>.<random>.tmp`, OWNER_FILE],
  ], 'one write — to a file that did not exist, whose name is not the record\'s — and one rename over to the record: a sweep or a kill sees no record or all of it');
  assert.deepStrictEqual(fs.readdirSync(lent), [OWNER_FILE], 'no temporary copy is left');
  const plain = makeTempWorkspace('genpage-', deps);
  assert.strictEqual(recordOfFolder(plain).lent, undefined, 'a workspace nothing is lent from has no such word');
  for (const asked of [false, undefined, 'yes', 1, {}]) {
    assert.strictEqual(recordOfFolder(makeTempWorkspace('genpage-', { ...deps, lent: asked })).lent, undefined, `${JSON.stringify(asked)} is not a request to lend`);
  }
});

test('a record that cannot be written whole leaves the folder unrecorded — never half a record, never a failure of the run — lent or not', (t) => {
  const { deps } = tempRoot(t);
  const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  const failing = (what) => ({ ...fs, [what]: (...args) => { if (path.basename(args[0]).startsWith(OWNER_FILE)) throw full; return fs[what](...args); } });
  for (const what of ['writeFileSync', 'renameSync']) {
    for (const lent of [true, undefined]) {
      const dir = makeTempWorkspace('genpage-', { ...deps, fs: failing(what), lent, pause: () => {} });
      assert.strictEqual(path.dirname(dir), workspaceParent(deps), `${what}: the workspace works, in the plugin's folder`);
      assert.deepStrictEqual(fs.readdirSync(dir), [], `${what}: unrecorded — never swept — and no half of a record or temporary copy of it is left`);
    }
  }
});

test('on Windows a record that a scanner holds for a moment is renamed into place after a short wait — and one that is held for longer is no record, and no failure', (t) => {
  const { deps } = tempRoot(t);
  const busy = (code) => Object.assign(new Error(`${code}: the file is in use`), { code });
  let refusals = 0;
  const slept = [];
  const flaky = { ...fs, renameSync: (from, to) => { if (path.basename(to) === OWNER_FILE && (refusals += 1) <= 2) throw busy('EBUSY'); return fs.renameSync(from, to); } };
  const dir = makeTempWorkspace('genpage-', { ...deps, uid: null, fs: flaky, pause: (ms) => slept.push(ms) });
  assert.ok(recordOfFolder(dir), 'recorded after the waits');
  assert.deepStrictEqual([refusals, slept], [3, [25, 50]]);
  const never = { ...fs, renameSync: (from, to) => { if (path.basename(to) === OWNER_FILE) throw busy('EPERM'); return fs.renameSync(from, to); } };
  const sleptNever = [];
  const unrecorded = makeTempWorkspace('genpage-', { ...deps, uid: null, fs: never, pause: (ms) => sleptNever.push(ms) });
  assert.deepStrictEqual(sleptNever, [25, 50, 100, 200, 400]);
  assert.deepStrictEqual(fs.readdirSync(unrecorded), [], 'unrecorded, with no temporary copy');
  // Elsewhere EPERM is the answer it sounds like.
  const posix = [];
  const refusedPosix = makeTempWorkspace('genpage-', { ...deps, uid: 4242, fs: { ...never, lstatSync: (target, ...rest) => (path.basename(target).startsWith(PARENT_NAME) ? { isDirectory: () => true, uid: 4242, mode: 0o40700 } : fs.lstatSync(target, ...rest)) }, pause: (ms) => posix.push(ms) });
  assert.ok(refusedPosix);
  assert.deepStrictEqual(posix, [], 'no waiting where the system has owners');
});

test('the sweep takes a LENT workspace only when its maker is gone AND it is old — a week, in the time of the folder and of its record alike — and a workspace that nothing lent is taken as soon as its maker is gone', (t) => {
  const T = Date.parse('2026-10-15T12:00:00Z');
  const aged = (record, { folder = 0, marker = 0 } = {}) => {
    const { deps } = tempRoot(t);
    const dir = plant(deps, record);
    const date = (ago) => new Date(T - ago);
    fs.utimesSync(path.join(dir, OWNER_FILE), date(marker), date(marker));
    fs.utimesSync(dir, date(folder), date(folder));
    return { deps: { ...deps, owner: { now: () => T } }, dir };
  };
  const swept = ({ deps }) => sweepDeadWorkspaces(deps);
  const lentGone = () => ({ ...goneRecord(), lent: true });
  assert.strictEqual(LENT_KEEP_MS, 7 * 24 * 60 * 60 * 1000, 'a week');
  const old = LENT_KEEP_MS + 1000;

  const young = aged(lentGone());
  assert.deepStrictEqual(swept(young).removed, [], 'lent, its maker gone, just made: kept — the program it was lent to may be writing in it');
  assert.ok(fs.existsSync(young.dir));
  const dayOld = aged(lentGone(), { folder: 24 * 3600 * 1000, marker: 24 * 3600 * 1000 });
  assert.deepStrictEqual(swept(dayOld).removed, [], 'a day old: kept');
  const almost = aged(lentGone(), { folder: LENT_KEEP_MS - 1000, marker: LENT_KEEP_MS - 1000 });
  assert.deepStrictEqual(swept(almost).removed, [], 'a second short of a week: kept');
  const week = aged(lentGone(), { folder: old, marker: old });
  assert.deepStrictEqual(swept(week).removed.map((r) => r.name), [path.basename(week.dir)], 'a week and a second, folder and record: taken');
  assert.ok(!fs.existsSync(week.dir));
  const writtenInto = aged(lentGone(), { folder: 3600 * 1000, marker: old });
  assert.deepStrictEqual(swept(writtenInto).removed, [], 'the record is old but something was put into the folder (or taken out) an hour ago: kept');
  const recordNew = aged(lentGone(), { folder: old, marker: 3600 * 1000 });
  assert.deepStrictEqual(swept(recordNew).removed, [], 'the folder is old but its record was written an hour ago: kept');
  // A time that cannot be compared keeps the folder.
  const future = aged(lentGone(), { folder: -old, marker: -old });
  assert.deepStrictEqual(swept(future).removed, [], 'a folder dated in the future (a clock that was set back): kept');
  const backwards = aged(lentGone(), { folder: old, marker: old });
  assert.deepStrictEqual(sweepDeadWorkspaces({ ...backwards.deps, owner: { now: () => T - 2 * old } }).removed, [], 'a clock set back now: kept');
  const unknownClock = aged(lentGone(), { folder: old, marker: old });
  assert.deepStrictEqual(sweepDeadWorkspaces({ ...unknownClock.deps, owner: { now: () => NaN } }).removed, [], 'a clock that is not a time: kept');

  // Old is not enough: the maker must be gone as well.
  const alive = aged({ ...ownerStamp(), lent: true }, { folder: old, marker: old });
  assert.deepStrictEqual(swept(alive).removed, [], 'lent, a week old, its maker is this process: kept');
  const foreign = aged({ ...ownerStamp({ hostname: () => 'another-machine' }), pid: deadPid(), lent: true }, { folder: old, marker: old });
  assert.deepStrictEqual(swept(foreign).removed, [], 'lent, a week old, made on another machine: kept');
  // A `lent` that is not the word that was written is not a record at all.
  for (const lent of [false, 'true', 1, null, { at: 1, pending: 0, pids: [] }]) {
    const odd = aged({ ...goneRecord(), lent }, { folder: old, marker: old });
    assert.deepStrictEqual(swept(odd).removed, [], `lent: ${JSON.stringify(lent)} is no record: kept even when old`);
    assert.ok(fs.existsSync(path.join(odd.dir, OWNER_FILE)));
  }
  // The control: nothing lent — taken the moment its maker is gone, whatever its age.
  const plain = aged(goneRecord());
  assert.deepStrictEqual(swept(plain).removed.map((r) => r.name), [path.basename(plain.dir)], 'a workspace that was not lent is taken as soon as its maker is gone');
});

test('a lent workspace whose record is unreadable for a moment — and then readable — is kept both times, and the age it must reach is that of the record it had all along', (t) => {
  const T = Date.parse('2026-10-15T12:00:00Z');
  const { deps } = tempRoot(t);
  const dir = plant(deps, { ...goneRecord(), lent: true });
  dated(dir, T - 1000);
  let unreadable = true;
  const reading = { ...fs, readFileSync: (file, ...rest) => {
    if (unreadable && path.basename(file) === OWNER_FILE) throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
    return fs.readFileSync(file, ...rest);
  } };
  const sweep = (extra = {}) => sweepDeadWorkspaces({ ...deps, fs: reading, owner: { now: () => T, ...extra } });
  assert.deepStrictEqual([sweep().removed, fs.existsSync(dir)], [[], true], 'unreadable: nothing is shown to be dead');
  unreadable = false;
  assert.deepStrictEqual([sweep().removed, fs.existsSync(dir)], [[], true], 'readable: it says lent, and it is young');
  unreadable = true;
  assert.deepStrictEqual(sweep({ now: () => T + 2 * LENT_KEEP_MS }).removed, [], 'even a week on, an unreadable record is no proof');
  unreadable = false;
  assert.deepStrictEqual(sweep({ now: () => T + 2 * LENT_KEEP_MS }).removed.map((r) => r.name), [path.basename(dir)], 'readable and old: taken');
});

test('a workspace that is lent keeps the record it was made with, for as long as it lives: nothing in the plugin writes a record again', () => {
  const { SCRIPTS_DIR, productionScripts, withoutComments } = require('./helpers/production-scripts.js');
  const code = productionScripts().map((file) => ({ name: path.relative(SCRIPTS_DIR, file).split(path.sep).join('/'), text: withoutComments(fs.readFileSync(file, 'utf8')) }));
  const mentioning = (pattern) => code.filter(({ text }) => pattern.test(text)).map(({ name }) => name).sort();
  // Nothing changes a record after the folder is made — no step that lends a folder later, no hook that tells the plugin when a program has started — so none of the names such a thing would have is in the plugin.
  assert.deepStrictEqual(mentioning(/\b(?:lendWorkspace|changeRecord|rewriteRecord|stillRunning|onSpawn)\b/), []);
  // The one script that names the record's file is the one that makes it, sweeps it and removes it.
  assert.deepStrictEqual(mentioning(/\.owner\.json|\bOWNER_FILE\b/), ['lib/temp-workspace.js']);
  // And of what it does with it, only the maker writes it: `mark`, once. Nothing PUTS a record back by writing it into a folder again — a write can be cut off (a full disk, a kill), and a record that is cut
  // off, beside the whole one that a removal moved out of the folder, leaves neither that removal nor the next sweep able to finish it. The one `writeFileSync` in the module writes a file WHOLE — to a name
  // of its own that nothing else reads, then renamed into place — and is called twice: for the record, by the maker, and for the sweep's cursor.
  const source = fs.readFileSync(path.join(SCRIPTS_DIR, 'lib', 'temp-workspace.js'), 'utf8');
  const lines = (pattern) => source.split('\n').filter((line) => pattern.test(line) && !/^\s*\/\//.test(line));
  const writers = lines(/writeFileSync\(/);
  assert.strictEqual(writers.length, 1, writers.join('\n'));
  assert.ok(/temp, text, \{ flag: 'wx'/.test(writers[0]), 'a whole-file write: to a temp file that did not exist, then renamed');
  const callers = lines(/\bwriteWhole\(/).filter((line) => !/^\s*function /.test(line));
  assert.strictEqual(callers.length, 2, callers.join('\n'));
  assert.ok(callers.some((line) => /OWNER_FILE/.test(line)) && callers.some((line) => /CURSOR_FILE/.test(line)), 'the maker\'s record, and the sweep\'s cursor');
});

// A record that was moved out of its folder by a removal that was killed — `<folder>.removing` — is finished by the next sweep, when everything agrees.

// The state a sweep that was killed between moving the record aside and removing the empty folder leaves: the folder, empty, and the record of the dead run beside it.
function interrupted(deps, { record = goneRecord(), contents = [], name = null, pid = record && typeof record === 'object' ? record.pid : process.pid, prefix = 'genpage-' } = {}) {
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const dir = name === null ? fs.mkdtempSync(path.join(parent, `${prefix}${pid}-`)) : path.join(parent, name);
  if (name !== null) fs.mkdirSync(dir);
  for (const file of contents) fs.writeFileSync(path.join(dir, file), 'something');
  const sidecar = `${dir}${REMOVING_SUFFIX}`;
  fs.writeFileSync(sidecar, typeof record === 'string' ? record : JSON.stringify(record));
  return { dir, sidecar, record };
}

test('a removal that was killed after the record was moved out of the folder is finished by the next sweep: the empty folder goes, then the record beside it — and the sweep that does says so', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const left = interrupted(deps);
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), [path.basename(left.dir), path.basename(left.sidecar)].sort());
  const first = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual([first.removed.map((r) => [r.name, r.stamp.pid]), first.failed], [[[path.basename(left.dir), left.record.pid]], []]);
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'the folder is gone, and so is the record');
  assert.match(sweepWarning(first), /removed 1 temporary workspace/);
  const second = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual([second.removed, second.failed], [[], []], 'and there is nothing left for the next');
});

test('a record whose folder is already gone — the removal was killed after the folder went — is removed, quietly: nothing was left to remove', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const left = interrupted(deps);
  fs.rmdirSync(left.dir);
  const result = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual([result.removed, result.failed], [[], []]);
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'the record beside the folder that is gone is removed');
  assert.strictEqual(sweepWarning(result), '', 'and nothing is said');
});

test('a removal that was killed is finished whichever of the two the sweep meets first — and for a lent workspace too, whatever its age: what its age keeps is its content, and none is left', (t) => {
  for (const name of ['first-the-folder', 'first-the-record']) {
    const { deps } = tempRoot(t);
    const left = interrupted(deps, { record: { ...goneRecord(), lent: true }, prefix: `${name}-` });
    // The listing is in the order the file system gives; a sweep that meets the record first, or the empty folder first, ends the same way.
    const order = name === 'first-the-folder' ? [left.dir, left.sidecar] : [left.sidecar, left.dir];
    const listed = { ...fs, readdirSync: (target, options) => { const entries = fs.readdirSync(target, options); return target === workspaceParent(deps) && options && options.withFileTypes ? entries.sort((a, b) => order.indexOf(path.join(target, a.name)) - order.indexOf(path.join(target, b.name))) : entries; } };
    const result = sweepDeadWorkspaces({ ...deps, fs: listed });
    assert.deepStrictEqual(result.removed.map((r) => r.name), [path.basename(left.dir)], name);
    assert.deepStrictEqual(fs.readdirSync(workspaceParent(deps)), [], name);
  }
});

test('a removal that was killed is NOT finished when anything about it does not agree: it is left exactly as it is', (t) => {
  const gone = goneRecord();
  const cases = [
    ['a folder with something in it', (deps) => interrupted(deps, { record: gone, contents: ['page.tsx'] })],
    ['a record that is not JSON', (deps) => interrupted(deps, { record: 'not json {', pid: deadPid() })],
    ['an empty record', (deps) => interrupted(deps, { record: '', pid: deadPid() })],
    ['a record that is far too large', (deps) => interrupted(deps, { record: JSON.stringify({ ...gone, pad: 'x'.repeat(6000) }) })],
    ['JSON that is not a record', (deps) => interrupted(deps, { record: '{"pid":1}', pid: deadPid() })],
    ['a record of a later version', (deps) => interrupted(deps, { record: { ...gone, v: 2 } })],
    ['a record that names another pid than the folder\'s name', (deps) => interrupted(deps, { record: gone, pid: gone.pid + 1000000 })],
    ['the record of a run that is going (this process)', (deps) => interrupted(deps, { record: ownerStamp() })],
    ['the record of another machine', (deps) => interrupted(deps, { record: { ...gone, host: 'another-machine' } })],
    ['the record of another kind of system', (deps) => interrupted(deps, { record: { ...gone, platform: gone.platform === 'win32' ? 'linux' : 'win32' } })],
    ['a record whose `lent` is not the word that is written', (deps) => interrupted(deps, { record: { ...gone, lent: 'yes' } })],
    ['a name that is not a workspace\'s (no pid)', (deps) => interrupted(deps, { name: 'not-a-workspace', record: gone })],
    ['a name with a pid and no random part', (deps) => interrupted(deps, { name: `genpage-${gone.pid}`, record: gone })],
  ];
  for (const [what, make] of cases) {
    const { deps } = tempRoot(t);
    const left = make(deps);
    const before = fs.readdirSync(workspaceParent(deps)).sort();
    const sidecarText = fs.readFileSync(left.sidecar, 'utf8');
    const result = sweepDeadWorkspaces(deps);
    assert.deepStrictEqual([result.removed, result.failed], [[], []], what);
    assert.deepStrictEqual(fs.readdirSync(workspaceParent(deps)).sort(), before, `${what}: nothing was removed`);
    assert.strictEqual(fs.readFileSync(left.sidecar, 'utf8'), sidecarText, `${what}: the record is as it was`);
    assert.ok(fs.existsSync(left.dir), `${what}: and the folder is where it was`);
  }
});

test('a record of a run that is going is never opened by a sweep that looks for the removals a kill left — nothing in its name is read (on Linux, its record alone, for the start time) — and nothing of it is moved or removed', (t) => {
  const { deps } = tempRoot(t);
  const left = interrupted(deps, { record: ownerStamp(), pid: process.pid });
  // Every call the sweep can make on a path, recorded as it is made — a final state that looks untouched does not show
  // that nothing was moved away and back, or removed and made again, along the way.
  const opened = [];
  const changed = [];
  const reading = (name) => (target, ...rest) => { opened.push(String(target)); return fs[name](target, ...rest); };
  const changing = (name) => (...args) => { changed.push([name, ...args.filter((a) => typeof a === 'string' || Buffer.isBuffer(a)).map(String)]); return fs[name](...args); };
  const spying = { ...fs };
  for (const name of ['readFileSync', 'lstatSync', 'statSync', 'openSync', 'readdirSync', 'opendirSync']) spying[name] = reading(name);
  for (const name of ['renameSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'writeFileSync', 'mkdirSync', 'copyFileSync', 'truncateSync', 'utimesSync', 'chmodSync']) spying[name] = changing(name);
  const sidecarText = fs.readFileSync(left.sidecar, 'utf8');
  const result = sweepDeadWorkspaces({ ...deps, fs: spying });
  assert.deepStrictEqual([result.removed, result.failed], [[], []]);
  const ours = (file) => file.includes(path.basename(left.dir));
  const looked = opened.filter(ours);
  if (process.platform === 'linux') {
    // On Linux a pid that runs is looked into too: the record's start time can show the pid was handed out again
    // (lib/process-owner.js). That needs the record and nothing else — and on Linux a file another process has open
    // can be removed, so reading it costs that run nothing. Windows and macOS never open it (the branch below).
    const records = new Set([path.join(left.dir, '.owner.json'), left.sidecar]);
    assert.deepStrictEqual(looked.filter((file) => !records.has(file)), [], 'nothing but the record was looked at — the folder was not listed or opened');
  } else {
    assert.deepStrictEqual(looked, [], 'neither the record nor the folder was looked at');
  }
  assert.deepStrictEqual(changed.filter(([, ...paths]) => paths.some(ours)), [], 'nothing of it was moved, written, removed or made again');
  assert.strictEqual(fs.readFileSync(left.sidecar, 'utf8'), sidecarText, 'the record is as it was');
  assert.ok(fs.existsSync(left.dir), 'and the folder is where it was');
});

test('POSIX: a record beside a folder that is really a link, or that is a file, or a record that is itself a link or a folder, is left alone — nothing is followed', onlyPosix, (t) => {
  const { root, deps } = tempRoot(t);
  const elsewhere = fs.mkdtempSync(path.join(root, 'elsewhere-'));
  const gone = goneRecord();
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { mode: 0o700 });
  const named = (n) => `genpage-${gone.pid}-${n}`;
  fs.symlinkSync(elsewhere, path.join(parent, named('LinkFo')));
  fs.writeFileSync(path.join(parent, `${named('LinkFo')}${REMOVING_SUFFIX}`), JSON.stringify(gone));
  fs.writeFileSync(path.join(parent, named('AFile0')), 'a file where a folder should be');
  fs.writeFileSync(path.join(parent, `${named('AFile0')}${REMOVING_SUFFIX}`), JSON.stringify(gone));
  fs.mkdirSync(path.join(parent, named('LinkRe')));
  fs.writeFileSync(path.join(elsewhere, 'record.json'), JSON.stringify(gone));
  fs.symlinkSync(path.join(elsewhere, 'record.json'), path.join(parent, `${named('LinkRe')}${REMOVING_SUFFIX}`));
  fs.mkdirSync(path.join(parent, named('DirRec')));
  fs.mkdirSync(path.join(parent, `${named('DirRec')}${REMOVING_SUFFIX}`));
  const before = fs.readdirSync(parent).sort();
  const result = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual([result.removed, result.failed], [[], []]);
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), before, 'nothing was removed, and nothing that a link points at either');
  assert.deepStrictEqual(fs.readdirSync(elsewhere), ['record.json']);
});

test('a record beside a folder that is really a link — one a platform reports as a plain folder — is not finished: the link is not removed, and what it points at is untouched', (t) => {
  const { root, deps } = tempRoot(t);
  const gone = goneRecord();
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const name = `genpage-${gone.pid}-AbC123`;
  const link = path.join(parent, name);
  // A junction on Windows (no privilege needed), a symbolic link elsewhere. What it points at is EMPTY: it is a folder that would go if the link were followed.
  fs.symlinkSync(outside, link, 'junction');
  fs.writeFileSync(`${link}${REMOVING_SUFFIX}`, JSON.stringify(gone));
  // `lstat` says it is a plain folder, as an older Node on Windows says of a junction: only where it really is can tell.
  const liar = { ...fs, lstatSync: (target, ...rest) => {
    const st = fs.lstatSync(target, ...rest);
    return target === link ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isDirectory: () => true, isSymbolicLink: () => false }) : st;
  } };
  const result = sweepDeadWorkspaces({ ...deps, fs: liar });
  assert.deepStrictEqual([result.removed, result.failed], [[], []]);
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), [name, `${name}${REMOVING_SUFFIX}`].sort(), 'the link and the record beside it are as they were');
  assert.ok(fs.existsSync(outside), 'and what the link points at is whole');
});

test('a folder that will not go — Windows holds a handle on it — leaves the record beside it, reports the failure, and is finished by a later sweep', (t) => {
  const { deps } = tempRoot(t);
  const left = interrupted(deps);
  let held = true;
  const busy = { ...fs, rmdirSync: (target, ...rest) => { if (held && target === left.dir) throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir'), { code: 'EBUSY' }); return fs.rmdirSync(target, ...rest); } };
  const first = sweepDeadWorkspaces({ ...deps, fs: busy });
  assert.deepStrictEqual([first.removed, first.failed.map((f) => [f.name, f.error])], [[], [[path.basename(left.dir), 'EBUSY']]]);
  assert.ok(fs.existsSync(left.sidecar), 'the record is still there');
  assert.match(sweepWarning(first), /could not remove 1 such workspace/);
  held = false;
  assert.deepStrictEqual(sweepDeadWorkspaces({ ...deps, fs: busy }).removed.map((r) => r.name), [path.basename(left.dir)]);
  assert.deepStrictEqual(fs.readdirSync(workspaceParent(deps)), []);
});

test('the removals a sweep finishes count against its caps like the others, so that a folder that has collected many is worked off over several runs', (t) => {
  const { deps } = tempRoot(t);
  for (let i = 0; i < 3; i += 1) interrupted(deps);
  const first = sweepDeadWorkspaces({ ...deps, limits: { maxRemoved: 2 } });
  assert.strictEqual(first.removed.length, 2, 'two at most');
  assert.strictEqual(sweepDeadWorkspaces(deps).removed.length, 1, 'and the next takes the third');
  assert.deepStrictEqual(fs.readdirSync(workspaceParent(deps)), []);
  // A sweep looks at no more entries than it is made to: with two, what is past them is left for the next.
  for (let i = 0; i < 3; i += 1) interrupted(deps);
  const narrow = sweepDeadWorkspaces({ ...deps, limits: { maxExamined: 2 } });
  assert.ok(narrow.removed.length <= 2, `two entries looked at: ${narrow.removed.length} removed`);
  assert.ok(fs.readdirSync(workspaceParent(deps)).length >= 2, 'what was past its look is still there');
});

test('the record is moved beside the folder under a name that is the folder\'s own, so that what a kill leaves is found — and a failed removal leaves nothing beside the folder', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const dir = plant(deps, goneRecord());
  const moved = [];
  let stuck = true;
  const watched = {
    ...fs,
    renameSync: (from, to) => { if (path.basename(from) === OWNER_FILE) moved.push(path.relative(parent, to)); return fs.renameSync(from, to); },
    rmdirSync: (target, ...rest) => { if (stuck && target === dir) throw Object.assign(new Error('EPERM: operation not permitted, rmdir'), { code: 'EPERM' }); return fs.rmdirSync(target, ...rest); },
  };
  assert.strictEqual(sweepDeadWorkspaces({ ...deps, fs: watched }).failed.length, 1);
  assert.deepStrictEqual(fs.readdirSync(parent), [path.basename(dir)], 'the folder will not go, and the record is back in it: nothing is left beside it');
  assert.ok(recordOfFolder(dir));
  stuck = false;
  assert.strictEqual(sweepDeadWorkspaces({ ...deps, fs: watched }).removed.length, 1);
  assert.deepStrictEqual(moved, [`${path.basename(dir)}${REMOVING_SUFFIX}`, `${path.basename(dir)}${REMOVING_SUFFIX}`], `moved out to <folder>${REMOVING_SUFFIX}, each time`);
});

// ---------------------------------------------------------------------------------------------------------------------
// A file another process holds open. Windows keeps a file that is deleted while it is open in its folder, listed, until the holder lets go (Node 22 asks for POSIX delete semantics
// and does not; Node 20 does): the folder cannot be removed meanwhile, and a removal that had already taken the record with the rest left a folder nothing could ever prove dead.
// ---------------------------------------------------------------------------------------------------------------------

test('REAL HANDLES: a file another process holds open — a page, one nested, or the record itself — never leaves a workspace that no later sweep can find: what is left is recorded, and the next sweep removes it once the holder lets go', async (t) => {
  for (const held of ['manifest.json', path.join('apps', 'page.json'), OWNER_FILE]) {
    const { deps } = tempRoot(t);
    const parent = workspaceParent(deps);
    const dir = plant(deps, goneRecord());
    const holder = startTarget(t, ['hold', path.join(dir, held)]);
    try {
      await holder.waitFor(/^ready$/);
      const first = sweepDeadWorkspaces(deps);
      if (fs.existsSync(dir)) {
        // The platform kept the file that was deleted while it was open (Windows, Node 20): the folder could not go, and must be known as a dead run's still.
        assert.deepStrictEqual([first.removed.length, first.failed.map((f) => f.name)], [0, [path.basename(dir)]], `${held}: reported as a failure to remove`);
        assert.ok(recordOfFolder(dir), `${held}: and the folder that is left is still recorded`);
      } else {
        assert.deepStrictEqual(first.removed.map((r) => r.name), [path.basename(dir)], `${held}: where a file that is open can be deleted the folder goes at once`);
      }
    } finally {
      // Before anything else, and whatever the sweep did: a holder that is still running keeps the folder from being removed by the test's own cleanup, and its pipe keeps the test process alive.
      await holder.kill();
    }
    // The platform completes a deletion that was pending when the last handle goes — a moment after.
    await waitUntil(() => { if (fs.existsSync(dir)) sweepDeadWorkspaces(deps); return fs.existsSync(dir) ? null : true; }, `${held}: the next sweep to remove the folder`, 30000);
    await waitUntil(() => (fs.readdirSync(parent).length === 0 ? true : null), `${held}: nothing to be left in the plugin's folder`, 30000);
  }
});

test('a removal that fails at its LAST step — the folder itself will not go — leaves the record where it was, whatever the platform did to the rest: the next sweep finds the folder again', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const dir = plant(deps, goneRecord());
  let stuck = true;
  const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rmdir'), { code: 'EPERM' });
  // How Windows with Node 20 treats a folder in which another process still holds a file: everything in it can be deleted — a recursive removal does — and the folder cannot.
  const held = {
    ...fs,
    rmSync: (target, options) => {
      if (stuck && target === dir) {
        for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        throw eperm();
      }
      return fs.rmSync(target, options);
    },
    rmdirSync: (target, ...rest) => { if (stuck && target === dir) throw eperm(); return fs.rmdirSync(target, ...rest); },
  };
  const first = sweepDeadWorkspaces({ ...deps, fs: held });
  assert.deepStrictEqual([first.removed, first.failed.map((f) => [f.name, f.error])], [[], [[path.basename(dir), 'EPERM']]]);
  assert.ok(recordOfFolder(dir), 'the record is where it was: the folder is known as a dead run\'s still');
  assert.deepStrictEqual(fs.readdirSync(parent), [path.basename(dir)], 'and nothing else is in the plugin\'s folder: no stray copy of the record');
  assert.match(sweepWarning(first), /could not remove 1 such workspace/);
  stuck = false;
  assert.deepStrictEqual(sweepDeadWorkspaces({ ...deps, fs: held }).removed.map((r) => r.name), [path.basename(dir)]);
  assert.deepStrictEqual(fs.readdirSync(parent), []);
});

test('a record that cannot be taken out of its folder — a program holds it open and will not let it go — keeps the folder recorded: reported, and tried again by the next sweep', (t) => {
  const { deps } = tempRoot(t);
  const dir = plant(deps, goneRecord());
  let busy = true;
  const locked = { ...fs, renameSync: (from, to) => {
    if (busy && path.basename(from) === OWNER_FILE) throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' });
    return fs.renameSync(from, to);
  } };
  const first = sweepDeadWorkspaces({ ...deps, fs: locked });
  assert.deepStrictEqual([first.removed, first.failed.map((f) => [f.name, f.error])], [[], [[path.basename(dir), 'EBUSY']]]);
  assert.ok(recordOfFolder(dir), 'still recorded');
  assert.deepStrictEqual(fs.readdirSync(dir), [OWNER_FILE], 'what was inside is gone, and the record is the last thing left');
  busy = false;
  assert.deepStrictEqual(sweepDeadWorkspaces({ ...deps, fs: locked }).removed.map((r) => r.name), [path.basename(dir)]);
  assert.ok(!fs.existsSync(dir));
});

test('a record that was taken out of a folder that then will not go, and cannot be moved back, stays beside the folder, whole — it is never written into the folder again — and the next sweep finishes the removal from it', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const dir = plant(deps, goneRecord());
  const sidecar = `${dir}${REMOVING_SUFFIX}`;
  const before = fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8');
  const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  const stuck = {
    ...fs,
    rmdirSync: (target, ...rest) => { if (target === dir) throw eperm(); return fs.rmdirSync(target, ...rest); },
    // The way back is shut as well: the record is not moved into the folder again.
    renameSync: (from, to) => { if (to === path.join(dir, OWNER_FILE)) throw eperm(); return fs.renameSync(from, to); },
  };
  const result = sweepDeadWorkspaces({ ...deps, fs: stuck });
  assert.deepStrictEqual(result.failed.map((f) => [f.name, f.error]), [[path.basename(dir), 'EPERM']]);
  assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), before, 'the record is beside the folder, word for word');
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'and nothing was written into the folder: it is empty, which is what the next sweep finishes the removal from');
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), [path.basename(dir), path.basename(sidecar)].sort());
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed.map((r) => r.name), [path.basename(dir)], 'the next sweep finishes the removal');
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'the folder and the record beside it are gone');
});

test('a record that cannot be moved back is not WRITTEN into the folder either, however the write ends: one that is cut off — a full disk, a kill — would leave a damaged record beside the whole one, and neither could finish the removal', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const dir = plant(deps, goneRecord());
  const marker = path.join(dir, OWNER_FILE);
  const sidecar = `${dir}${REMOVING_SUFFIX}`;
  const record = fs.readFileSync(marker, 'utf8');
  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  const writes = [];
  const faulty = {
    ...fs,
    rmdirSync: (target, ...rest) => { if (target === dir) throw busy(); return fs.rmdirSync(target, ...rest); },
    renameSync: (from, to, ...rest) => { if (from === sidecar && to === marker) throw busy(); return fs.renameSync(from, to, ...rest); },
    // A write of the record into the folder that is cut off half way: the half is really written, and then the write fails.
    writeFileSync: (file, text, ...rest) => {
      if (file !== marker) return fs.writeFileSync(file, text, ...rest);
      writes.push(file);
      fs.writeFileSync(file, String(text).slice(0, 6), ...rest);
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    },
  };
  const first = sweepDeadWorkspaces({ ...deps, fs: faulty });
  assert.deepStrictEqual(first.failed.map((f) => [f.name, f.error]), [[path.basename(dir), 'EBUSY']], 'the failure that stopped the removal is the one that is reported');
  assert.deepStrictEqual(writes, [], 'no record is written into the folder');
  assert.strictEqual(fs.readFileSync(sidecar, 'utf8'), record, 'the complete record is beside the folder');
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'and no half of one is in it');
  // Sweeps that run on a healthy file system finish it: the folder is empty, and the record beside it is whole.
  const second = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual([second.removed.map((r) => r.name), second.failed], [[path.basename(dir)], []]);
  assert.deepStrictEqual(fs.readdirSync(parent), []);
  assert.deepStrictEqual([sweepDeadWorkspaces(deps).removed, sweepDeadWorkspaces(deps).failed], [[], []], 'and nothing is left for the ones after');
});

test('a removal that fails at any step writes no file at all — the record is only ever moved — and leaves the failure to be reported and the removal to the next sweep', (t) => {
  for (const [what, breaks] of [
    ['a file that cannot be removed', () => ({ rmSync: (target, options) => { if (path.basename(target) === 'manifest.json') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return fs.rmSync(target, options); } })],
    ['a record that cannot be moved out', () => ({ renameSync: (from, to) => { if (path.basename(from) === OWNER_FILE) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return fs.renameSync(from, to); } })],
    ['a folder that will not go', (dir) => ({ rmdirSync: (target, ...rest) => { if (target === dir) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return fs.rmdirSync(target, ...rest); } })],
  ]) {
    const { deps } = tempRoot(t);
    const dir = plant(deps, goneRecord());
    const written = [];
    const watched = { ...fs, writeFileSync: (file, ...rest) => { written.push(path.basename(file)); return fs.writeFileSync(file, ...rest); }, ...breaks(dir) };
    const result = sweepDeadWorkspaces({ ...deps, fs: watched });
    assert.strictEqual(result.failed.length, 1, what);
    assert.deepStrictEqual(written, [], `${what}: nothing was written`);
    assert.ok(recordOfFolder(dir), `${what}: and the folder is still recorded`);
    assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed.map((r) => r.name), [path.basename(dir)], `${what}: the next sweep takes it`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The name a workspace is given: `<prefix><pid>-<random>`, and the sweep reads the pid back from the hyphen before it
// ---------------------------------------------------------------------------------------------------------------------

test('a prefix that does not end in a hyphen still makes a workspace a sweep recognises — the pid always follows a hyphen — and a prefix that ends in one is named exactly as it was', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const gone = deadPid();
  const asked = [];
  const made = (prefix) => makeTempWorkspace(prefix, { ...deps, owner: { pid: gone }, mkdtempSync: (start) => { asked.push(start); return fs.mkdtempSync(start); } });
  const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Each is a name the module accepts as a prefix (letters, digits, `.`, `_`, `-`); only the last two end in a hyphen.
  const prefixes = ['work', 'work.', 'work_', 'w', '9', 'a.b', 'model-app-2', 'work-', 'model-app-2-'];
  const dirs = prefixes.map((prefix) => made(prefix));
  prefixes.forEach((prefix, i) => {
    const named = prefix.endsWith('-') ? prefix : `${prefix}-`;
    assert.deepStrictEqual([path.dirname(dirs[i]), asked[i]], [parent, path.join(parent, `${named}${gone}-`)], `${prefix}: made in the plugin's folder, asked for the name <prefix>[-]<pid>-`);
    assert.match(path.basename(dirs[i]), new RegExp(`^${escaped(named)}${gone}-[A-Za-z0-9]{6}$`), prefix);
    assert.strictEqual(recordOfFolder(dirs[i]).pid, gone, `${prefix}: recorded, with the pid that is in the name`);
  });
  const result = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual(result.removed.map((r) => r.name).sort(), dirs.map((dir) => path.basename(dir)).sort(), 'a sweep recognises every one of them as its own, and takes each: its maker is gone');
  assert.deepStrictEqual(fs.readdirSync(parent), []);
  // The plain call a workspace falls back to is as it always was: the caller's prefix, as it is.
  const plain = tempRoot(t);
  fs.writeFileSync(workspaceParent(plain.deps), 'in the way');
  assert.match(path.basename(makeTempWorkspace('work', plain.deps)), /^work[A-Za-z0-9]{6}$/, 'no hyphen is added to the name mkdtemp makes in the temp folder');
});

// ---------------------------------------------------------------------------------------------------------------------
// Fair discovery. A sweep looks at no more than LIMITS.MAX_EXAMINED entries, so that the time of one run is bounded however many a folder has collected. If it were always the FIRST ones, a folder whose first
// MAX_EXAMINED entries must be kept — folders no record vouches for, a record that cannot be read — would hide every entry after them for good: a dead run's workspace, and a removal that a kill left half done.
// So the window moves on: a sweep that could not look at everything writes down where it stopped (CURSOR_FILE), and the next one — in this process or in a new one — carries on from there.
// ---------------------------------------------------------------------------------------------------------------------

// A listing in name order, whatever order the file system gives, so that a test that says "the first MAX_EXAMINED entries are the ones to keep" says it on every system: NTFS lists by name and ext4 does not.
const nameOf = (entry) => String(entry.name || entry);
const inNameOrder = { ...fs, readdirSync: (target, options) => fs.readdirSync(target, options).sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : 1)) };

// What a sweep has to leave — MAX_EXAMINED folders named for a pid that is gone, with no record to say whose they are — and, sorting after them, what it should take: the workspace of a dead run, and a removal
// that a kill left half done (the empty folder, and the record beside it).
function retainedHead(t) {
  const { root, deps } = tempRoot(t);
  const gone = goneRecord();
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const retained = Array.from({ length: LIMITS.MAX_EXAMINED }, () => fs.mkdtempSync(path.join(parent, `a-genpage-${gone.pid}-`)));
  const ordinary = plant(deps, gone, { prefix: 'z-genpage-' });
  const killed = interrupted(deps, { record: gone, prefix: 'z-interrupted-' });
  return { root, deps, parent, retained, ordinary, killed };
}
const namesOf = (dirs) => dirs.map((dir) => path.basename(dir)).sort();

test('a folder whose first MAX_EXAMINED entries must all be kept does not hide what comes after them: the workspace of a dead run and a removal a kill left half done are both taken within the sweeps its size needs — and nothing that was kept is touched', (t) => {
  const { deps, parent, retained, ordinary, killed } = retainedHead(t);
  const entries = fs.readdirSync(parent).length;
  assert.strictEqual(entries, LIMITS.MAX_EXAMINED + 3, 'the folders to keep, the dead run\'s workspace, the folder of the killed removal and the record beside it');
  const bound = Math.ceil(entries / LIMITS.MAX_EXAMINED);
  const taken = [];
  for (let sweeps = 1; sweeps <= bound; sweeps += 1) {
    const result = sweepDeadWorkspaces({ ...deps, fs: inNameOrder });
    assert.deepStrictEqual(result.failed, [], `sweep ${sweeps}`);
    taken.push(...result.removed.map((r) => r.name));
  }
  assert.deepStrictEqual(taken.sort(), namesOf([ordinary, killed.dir]), `both are taken within ${bound} sweeps`);
  assert.ok(!fs.existsSync(ordinary) && !fs.existsSync(killed.dir) && !fs.existsSync(killed.sidecar), 'the workspace is gone, and so are the folder of the killed removal and its record');
  assert.deepStrictEqual(fs.readdirSync(parent).filter((name) => name !== CURSOR_FILE).sort(), namesOf(retained), 'and every folder a sweep had to keep is where it was: nothing it cannot show to be a dead run\'s is removed');
});

test('REAL PROCESSES: the same folder swept by a new process each time — nothing is remembered in memory — is worked off all the same: the next process carries on where the last one stopped', async (t) => {
  const { root, parent, retained, ordinary, killed } = retainedHead(t);
  const bound = Math.ceil(fs.readdirSync(parent).length / LIMITS.MAX_EXAMINED);
  const taken = [];
  for (let sweeps = 1; sweeps <= bound; sweeps += 1) {
    const sweeper = startTarget(t, ['sweep', root], { env: tempEnv(root) });
    const said = JSON.parse((await sweeper.waitFor(/^swept /)).slice('swept '.length));
    await sweeper.exited;
    assert.strictEqual(said.failed, 0, `process ${sweeps}`);
    taken.push(...said.removed);
  }
  assert.deepStrictEqual(taken.sort(), namesOf([ordinary, killed.dir]), `both are taken by the ${bound} processes`);
  assert.ok(!fs.existsSync(ordinary) && !fs.existsSync(killed.dir) && !fs.existsSync(killed.sidecar));
  assert.deepStrictEqual(fs.readdirSync(parent).filter((name) => name !== CURSOR_FILE).sort(), namesOf(retained), 'and what had to be kept is where it was');
});

test('each sweep looks at the next MAX_EXAMINED entries in name order and wraps round to the first, so every entry is looked at within ceil(entries / MAX_EXAMINED) sweeps — and none is looked at twice by one sweep', (t) => {
  const pids = Array.from({ length: 11 }, (_, i) => 2000000000 + i);
  const sweepsOf = (deps, maxExamined) => {
    const asked = [];
    const owner = { platform: 'win32', probe: (pid) => { asked.push(pid); return 'alive'; } };
    return () => { asked.length = 0; sweepDeadWorkspaces({ ...deps, owner, limits: { maxExamined } }); return [...asked]; };
  };
  // The order the file system lists in is nobody's business: the windows are the same from a listing in name order and from one in the opposite order.
  const descending = { ...fs, readdirSync: (target, options) => fs.readdirSync(target, options).sort((a, b) => (nameOf(a) < nameOf(b) ? 1 : -1)) };
  for (const [what, system] of [['the system\'s own order', fs], ['the opposite order', descending]]) {
    const { deps } = tempRoot(t);
    for (const pid of pids) plant(deps, null, { pid });
    const sweep = sweepsOf({ ...deps, fs: system }, 4);
    assert.deepStrictEqual(sweep(), pids.slice(0, 4), what);
    assert.deepStrictEqual(sweep(), pids.slice(4, 8), what);
    assert.deepStrictEqual(sweep(), [...pids.slice(8), pids[0]], `${what}: the third reaches the end and wraps round to the first`);
    assert.deepStrictEqual(sweep(), pids.slice(1, 5), `${what}: and the fourth goes on from there`);
  }
  // Whatever the size of the window: every entry within ceil(entries / window) sweeps, and no sweep looks at more than its window.
  for (const window of [1, 2, 3, 5, 10]) {
    const { deps } = tempRoot(t);
    for (const pid of pids) plant(deps, null, { pid });
    const next = sweepsOf(deps, window);
    const seen = new Set();
    for (let sweeps = 1; sweeps <= Math.ceil(pids.length / window); sweeps += 1) {
      const asked = next();
      assert.ok(asked.length <= window && new Set(asked).size === asked.length, `window ${window}, sweep ${sweeps}: ${asked.length} looked at`);
      asked.forEach((pid) => seen.add(pid));
    }
    assert.deepStrictEqual([...seen].sort(), pids, `window ${window}: all ${pids.length} looked at within ${Math.ceil(pids.length / window)} sweeps`);
  }
});

test('the cursor is written BEFORE the entries are looked at: a sweep that cannot get past an entry — it throws, or its process is killed there — does not make the next one start at the same window', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const pids = Array.from({ length: 11 }, (_, i) => 2000000000 + i);
  for (const pid of pids) plant(deps, null, { pid });
  try {
    sweepDeadWorkspaces({ ...deps, owner: { platform: 'win32', probe: (pid) => { if (pid === pids[1]) throw new Error('this sweep cannot get past this entry'); return 'alive'; } }, limits: { maxExamined: 4 } });
  } catch { /* whether the sweep reports it or not, what matters is where the next one starts */ }
  const sorted = fs.readdirSync(parent).filter((name) => name !== CURSOR_FILE).sort();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(parent, CURSOR_FILE), 'utf8')), { v: 1, after: sorted[3] }, 'the window was taken, though it was not all looked at');
  const asked = [];
  sweepDeadWorkspaces({ ...deps, owner: { platform: 'win32', probe: (pid) => { asked.push(pid); return 'alive'; } }, limits: { maxExamined: 4 } });
  assert.deepStrictEqual(asked, pids.slice(4, 8), 'and the next sweep goes on past it');
});

test('a sweep that can look at every entry — the folder holds no more than a window — reads and writes no cursor, and looks at them as it always did: in the order the file system lists them', (t) => {
  const { deps } = tempRoot(t);
  for (let i = 0; i < 6; i += 1) plant(deps, null, { pid: 2000000000 + i });
  const parent = workspaceParent(deps);
  const touched = [];
  const watched = {
    ...fs,
    // A listing in an order of its own (name order, reversed): the file system's order is whatever it is, and a sweep that can look at all of it goes by that.
    readdirSync: (target, options) => (target === parent && options && options.withFileTypes ? inNameOrder.readdirSync(target, options).reverse() : fs.readdirSync(target, options)),
    lstatSync: (file, ...rest) => { if (path.basename(file) === CURSOR_FILE) touched.push(['lstat', CURSOR_FILE]); return fs.lstatSync(file, ...rest); },
    readFileSync: (file, ...rest) => { touched.push(['read', path.basename(file)]); return fs.readFileSync(file, ...rest); },
    writeFileSync: (file, ...rest) => { touched.push(['write', path.basename(file)]); return fs.writeFileSync(file, ...rest); },
    renameSync: (from, to) => { touched.push(['rename', path.basename(to)]); return fs.renameSync(from, to); },
    rmSync: (target, ...rest) => { touched.push(['remove', path.basename(target)]); return fs.rmSync(target, ...rest); },
  };
  const asked = [];
  sweepDeadWorkspaces({ ...deps, fs: watched, owner: { platform: 'win32', probe: (pid) => { asked.push(pid); return 'alive'; } }, limits: { maxExamined: 6 } });
  assert.deepStrictEqual(asked, Array.from({ length: 6 }, (_, i) => 2000000005 - i), 'in the order the system listed them (here, name order reversed)');
  assert.deepStrictEqual(touched, [], 'and nothing was read, written, renamed or removed, the cursor included: it is not looked for');
  assert.ok(!fs.existsSync(path.join(parent, CURSOR_FILE)));
});

test('the cursor is one small file in the plugin\'s folder, written whole and holding the name of the last entry looked at — there only while a sweep cannot look at everything — and it is never a workspace, a record or an entry that is looked at', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const owner = { platform: 'win32', probe: () => 'alive' };
  for (let i = 0; i < 7; i += 1) plant(deps, null, { pid: 2000000000 + i });
  const names = fs.readdirSync(parent).sort();
  // Things in the plugin's folder that are not the sweep's: a sweep never removes them, whatever it does with its own.
  const notes = path.join(parent, 'notes.txt');
  fs.writeFileSync(notes, 'somebody\'s');
  const strangers = path.join(parent, 'somebody-elses-folder');
  fs.mkdirSync(strangers);
  fs.writeFileSync(path.join(strangers, 'keep.txt'), 'x');
  const all = [...names, 'notes.txt', 'somebody-elses-folder'].sort();
  const log = [];
  const watched = {
    ...fs,
    writeFileSync: (file, data, options) => { log.push(['write', path.basename(file).replace(/\.\d+\.[a-z0-9]+\.tmp$/, '.<pid>.<random>.tmp'), options && options.flag]); return fs.writeFileSync(file, data, options); },
    renameSync: (from, to) => { log.push(['rename', path.basename(from).replace(/\.\d+\.[a-z0-9]+\.tmp$/, '.<pid>.<random>.tmp'), path.basename(to)]); return fs.renameSync(from, to); },
  };
  sweepDeadWorkspaces({ ...deps, fs: watched, owner, limits: { maxExamined: 3 } });
  assert.deepStrictEqual(log, [['write', `${CURSOR_FILE}.<pid>.<random>.tmp`, 'wx'], ['rename', `${CURSOR_FILE}.<pid>.<random>.tmp`, CURSOR_FILE]], 'one write, to a file that did not exist, and one rename over to the cursor: a reader finds the old cursor or the whole of the new');
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), [...all, CURSOR_FILE].sort(), 'the cursor is the one thing added, and no temporary copy is left');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(parent, CURSOR_FILE), 'utf8')), { v: 1, after: all[2] }, 'it names the last of the three entries that were looked at');
  // A name that no workspace, no record of a removal and no temporary copy of a record can have: a workspace ends in `-<pid>-<six characters>`, a record in `.removing`.
  for (const name of [CURSOR_FILE, `${CURSOR_FILE}.4242.abc123.tmp`]) {
    assert.ok(!/-\d{1,10}-[A-Za-z0-9]{6}$/.test(name) && !name.endsWith(REMOVING_SUFFIX), `${name} is not a name the sweep gives a meaning`);
  }
  // It is not one of the entries: with a window of exactly the entries there are, a sweep looks at every one of them — and then there is no use for it, and it is removed.
  sweepDeadWorkspaces({ ...deps, owner, limits: { maxExamined: all.length } });
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), all, 'a sweep that looked at everything leaves no cursor');
  assert.strictEqual(fs.readFileSync(notes, 'utf8'), 'somebody\'s');
  assert.strictEqual(fs.readFileSync(path.join(strangers, 'keep.txt'), 'utf8'), 'x', 'and no entry that is not a cursor was touched');
  // What a sweep that was killed while it wrote the cursor leaves — a temporary copy — goes the same way, and only that and the cursor itself: names that only look like them are entries like any other.
  sweepDeadWorkspaces({ ...deps, owner, limits: { maxExamined: 3 } });
  const stray = path.join(parent, `${CURSOR_FILE}.4242.abc123.tmp`);
  fs.writeFileSync(stray, '{"v":1');
  const lookAlikes = [`${CURSOR_FILE}.backup`, `${CURSOR_FILE}.tmp`, `${CURSOR_FILE}.notes.tmp`, `${CURSOR_FILE}.4242.abc123.tmp.old`, 'sweep-cursor.json'];
  for (const name of lookAlikes) fs.writeFileSync(path.join(parent, name), 'somebody\'s');
  fs.mkdirSync(path.join(parent, `${CURSOR_FILE}.4242.abc123.tmp.d`));
  sweepDeadWorkspaces({ ...deps, owner, limits: { maxExamined: 100 } });
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), [...all, ...lookAlikes, `${CURSOR_FILE}.4242.abc123.tmp.d`].sort(), 'the cursor and the copy are gone, and nothing that only looks like them is');
  assert.ok(!fs.existsSync(stray));
});

test('the copies of the cursor that killed sweeps left are removed a window\'s worth per sweep, the cursor first: a pile of them is worked off over runs, never in one burst, and nothing else is touched', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const owner = { platform: 'win32', probe: () => 'alive' };
  plant(deps, null, { pid: 2000000000 });
  const live = fs.readdirSync(parent);
  fs.writeFileSync(path.join(parent, CURSOR_FILE), JSON.stringify({ v: 1, after: live[0] }));
  // What twelve sweeps killed while they wrote the cursor leave: partial copies under names of their own.
  for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(parent, `${CURSOR_FILE}.${4000 + i}.abc${String(i).padStart(3, '0')}.tmp`), '{"v":1');
  const removed = [];
  const counting = { ...fs, rmSync: (file, ...rest) => { removed.push(path.basename(file)); return fs.rmSync(file, ...rest); } };
  const copies = () => fs.readdirSync(parent).filter((name) => name.startsWith(`${CURSOR_FILE}.`)).length;
  sweepDeadWorkspaces({ ...deps, fs: counting, owner, limits: { maxExamined: 5 } });
  assert.strictEqual(removed.length, 5, 'no more than a window\'s worth of the sweep\'s own files in one sweep');
  assert.strictEqual(removed[0], CURSOR_FILE, 'the cursor goes first: a folder worked off down to nothing must not keep one');
  assert.strictEqual(copies(), 8, 'eight copies are left for the next sweeps');
  sweepDeadWorkspaces({ ...deps, owner, limits: { maxExamined: 5 } });
  sweepDeadWorkspaces({ ...deps, owner, limits: { maxExamined: 5 } });
  assert.strictEqual(copies(), 0, 'and they are worked off over runs');
  assert.deepStrictEqual(fs.readdirSync(parent), live, 'the live workspace is where it was, and nothing else was touched');
});

test('a cursor that is missing, unreadable or not what was written starts the sweep at the first entry — and is replaced by a good one — and one that names an entry that is gone, or is past the last, resumes at the next name', (t) => {
  const pids = Array.from({ length: 11 }, (_, i) => 2000000000 + i);
  const run = (cursorText) => {
    const { deps } = tempRoot(t);
    const parent = workspaceParent(deps);
    for (const pid of pids) plant(deps, null, { pid });
    const sorted = fs.readdirSync(parent).sort();
    if (cursorText !== undefined) fs.writeFileSync(path.join(parent, CURSOR_FILE), typeof cursorText === 'function' ? cursorText(sorted) : cursorText);
    const asked = [];
    sweepDeadWorkspaces({ ...deps, owner: { platform: 'win32', probe: (pid) => { asked.push(pid); return 'alive'; } }, limits: { maxExamined: 4 } });
    return { asked, sorted, parent };
  };
  const first = pids.slice(0, 4);
  assert.deepStrictEqual(run().asked, first, 'no cursor');
  for (const [what, text] of [
    ['an empty file', ''],
    ['text that is not JSON', '{"v":1,"aft'],
    ['JSON that is not a cursor', '[1, 2]'],
    ['a name that is not a string', '{"v":1,"after":5}'],
    ['a cursor of another version', (sorted) => JSON.stringify({ v: 2, after: sorted[4] })],
    ['a file far too large to be one, though what it says is a name', (sorted) => JSON.stringify({ v: 1, after: sorted[4], padding: 'x'.repeat(5000) })],
  ]) {
    const { asked, sorted, parent } = run(text);
    assert.deepStrictEqual(asked, first, `${what}: the first entries`);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(parent, CURSOR_FILE), 'utf8')), { v: 1, after: sorted[3] }, `${what}: and the cursor is a good one now`);
  }
  // A name is compared with the names in the folder and nothing else: one that is not there goes on from where it would have been.
  assert.deepStrictEqual(run((sorted) => JSON.stringify({ v: 1, after: `${sorted[4]}-gone-meanwhile` })).asked, pids.slice(5, 9), 'an entry that is gone: the next name after it');
  assert.deepStrictEqual(run(JSON.stringify({ v: 1, after: 'zzzz-past-the-last' })).asked, first, 'past the last: round to the first');
  assert.deepStrictEqual(run(JSON.stringify({ v: 1, after: '' })).asked, first, 'an empty name sorts before every entry');
  assert.deepStrictEqual(run(JSON.stringify({ v: 1, after: '../../etc/passwd' })).asked, first, 'and a name is only ever compared, never used as a path');
});

test('POSIX: a cursor that is a link is no cursor — it is not followed, and what it points at is not written to — and a sweep that has no use for a cursor does not remove a link either', onlyPosix, (t) => {
  const { root, deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const pids = Array.from({ length: 6 }, (_, i) => 2000000000 + i);
  for (const pid of pids) plant(deps, null, { pid });
  const elsewhere = path.join(root, 'elsewhere.json');
  const pointedAt = JSON.stringify({ v: 1, after: fs.readdirSync(parent).sort()[3] });
  fs.writeFileSync(elsewhere, pointedAt);
  const link = path.join(parent, CURSOR_FILE);
  fs.symlinkSync(elsewhere, link);
  const asked = [];
  const owner = { platform: 'win32', probe: (pid) => { asked.push(pid); return 'alive'; } };
  sweepDeadWorkspaces({ ...deps, owner, limits: { maxExamined: 3 } });
  assert.deepStrictEqual(asked, pids.slice(0, 3), 'what the link points at says to start after the fourth entry: it is not read');
  assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), pointedAt, 'and it is not written to');
  // The cursor that sweep wrote took the link's place. A link put there again is not removed by a sweep that has no use for a cursor: only a file is.
  fs.rmSync(link);
  fs.symlinkSync(elsewhere, link);
  sweepDeadWorkspaces({ ...deps, owner, limits: { maxExamined: 100 } });
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still there');
  assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), pointedAt);
});

test('a folder that is named like the cursor is not a cursor, and is not touched: the sweep starts at the first entry, cannot write a cursor over it, leaves no temporary copy, and fails at nothing', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const pids = Array.from({ length: 6 }, (_, i) => 2000000000 + i);
  for (const pid of pids) plant(deps, null, { pid });
  const folder = path.join(parent, CURSOR_FILE);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'x');
  const asked = [];
  const owner = { platform: 'win32', probe: (pid) => { asked.push(pid); return 'alive'; } };
  const result = sweepDeadWorkspaces({ ...deps, owner, limits: { maxExamined: 3 }, pause: () => {} });
  assert.deepStrictEqual([asked, result.failed], [pids.slice(0, 3), []]);
  assert.deepStrictEqual(fs.readdirSync(parent).filter((name) => name.startsWith(CURSOR_FILE)), [CURSOR_FILE], 'no temporary copy is left beside the folder');
  assert.deepStrictEqual(fs.readdirSync(folder), ['keep.txt']);
  sweepDeadWorkspaces({ ...deps, owner, limits: { maxExamined: 100 } });
  assert.deepStrictEqual(fs.readdirSync(folder), ['keep.txt'], 'and a sweep that looked at everything does not remove it');
});

test('a cursor that cannot be written — the disk is full, a scanner holds the folder — is no failure of the sweep and leaves no temporary copy: it costs only that the next sweep starts at the first entry again', (t) => {
  const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  for (const [what, breaks] of [
    ['the write fails', { writeFileSync: (file, ...rest) => { if (path.basename(file).startsWith(CURSOR_FILE)) throw full; return fs.writeFileSync(file, ...rest); } }],
    ['the rename fails', { renameSync: (from, to) => { if (path.basename(to) === CURSOR_FILE) throw full; return fs.renameSync(from, to); } }],
  ]) {
    const { deps } = tempRoot(t);
    const parent = workspaceParent(deps);
    const pids = Array.from({ length: 8 }, (_, i) => 2000000000 + i);
    for (const pid of pids) plant(deps, null, { pid });
    // A dead run's workspace, in the first window: a sweep that cannot write its cursor takes it all the same.
    const dead = plant(deps, goneRecord(), { prefix: 'a-genpage-' });
    const before = fs.readdirSync(parent).filter((name) => name !== path.basename(dead)).sort();
    const failing = sweepDeadWorkspaces({ ...deps, fs: { ...fs, ...breaks }, limits: { maxExamined: 3 } });
    assert.deepStrictEqual([failing.removed.map((r) => r.name), failing.failed], [[path.basename(dead)], []], what);
    assert.deepStrictEqual(fs.readdirSync(parent).sort(), before, `${what}: no cursor, and no temporary copy`);
    const asked = [];
    sweepDeadWorkspaces({ ...deps, owner: { platform: 'win32', probe: (pid) => { asked.push(pid); return 'alive'; } }, limits: { maxExamined: 3 } });
    assert.deepStrictEqual(asked, pids.slice(0, 3), `${what}: the next sweep, on a healthy file system, starts at the first entry`);
  }
});

test('the removal cap does not narrow the window: what a sweep looked at and kept for the cap is for a later one, and every dead run\'s workspace is taken in a bounded number of sweeps', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const gone = goneRecord();
  const dirs = Array.from({ length: 9 }, () => plant(deps, gone));
  const limits = { maxExamined: 4, maxRemoved: 1 };
  const left = () => dirs.filter((dir) => fs.existsSync(dir));
  let sweeps = 0;
  while (left().length > 0 && sweeps < 2 * dirs.length) {
    const before = left().length;
    const result = sweepDeadWorkspaces({ ...deps, limits });
    sweeps += 1;
    assert.deepStrictEqual([result.removed.length, before - left().length], [1, 1], `sweep ${sweeps}: one taken, which is the cap, and what it says it took is gone`);
  }
  assert.deepStrictEqual(left(), [], `every one is taken, in ${sweeps} sweeps`);
  assert.deepStrictEqual(fs.readdirSync(parent), [], 'and the folder is left as empty as it was found: no cursor either');
});
