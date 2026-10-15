'use strict';
// lib/temp-workspace.js: the one maker of the plugin's throwaway workspace folders, and the sweep of the ones a killed run left. The sweep removes a
// folder — and the page source in it — so the tests spend their words on what it must NOT remove, and on what it does when it is racing live runs.
// Real processes decide what a kill leaves, and race the sweep; the rest is driven through the module's seams, in folders of the test's own.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PARENT_NAME, OWNER_FILE, LIMITS, workspaceParent, makeTempWorkspace, sweepDeadWorkspaces, sweepWarning, lendWorkspace,
} = require('../lib/temp-workspace.js');
const { ownerStamp, isOwnerStamp, LENT_PENDING_MS } = require('../lib/process-owner.js');
const { privateTempRoot, tempEnv, startTarget, deadPid, pause, isRunning, waitUntil } = require('./helpers/kill-target-client.js');

const POSIX = process.platform !== 'win32';
const onlyPosix = { skip: !POSIX && 'POSIX modes, owners and links' };

// A temp folder of the test's own, and the `os` that names it, so that nothing the plugin makes is outside it. On Windows an existing plugin's folder is judged by its access list (lib/windows-folder-acl.js), which
// in a folder made in the machine's own temp folder is whatever that machine gives it: the tests of what the maker and the sweep do with a folder of their own are not about that machine, so the reader is
// stood in for (`folderPrivacy`, a seam that POSIX ignores) — `realReader` takes the stand-in away, for the few tests that are about the reader.
function tempRoot(t, { realReader = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-ws-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, deps: { os: { tmpdir: () => root }, ...(realReader ? {} : { folderPrivacy: () => ({ ok: true, reason: 'stood in for' }) }) } };
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
    return options && options.withFileTypes ? listing.map((entry) => (entry.name === name ? { name: entry.name, isDirectory: () => true } : entry)) : listing;
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
      if (dir === parent) return names.map((name) => ({ name, isDirectory: () => true }));
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
      if (reads === 2) fs.writeFileSync(marker, JSON.stringify({ ...ownerStamp(), pid: gone.pid }));
    }
    return fs.readFileSync(file, encoding);
  } };
  const result = sweepDeadWorkspaces({ ...deps, fs: racing, owner: { probe: (pid) => (pid === gone.pid ? 'gone' : 'alive') } });
  assert.strictEqual(reads, 2, 'the record was read again before the removal');
  assert.deepStrictEqual(result.removed, []);
  assert.ok(fs.existsSync(path.join(dir, 'apps', 'page.json')), 'the workspace is whole');
});

test('no script of the plugin makes a workspace folder by hand: every one goes through makeTempWorkspace — but the two developer tools', () => {
  const { SCRIPTS_DIR, productionScripts, withoutComments } = require('./helpers/production-scripts.js');
  // The scripts' code, comments left out, read once: each of the two scans below is over all of it.
  const code = productionScripts().map((file) => ({ name: path.relative(SCRIPTS_DIR, file).split(path.sep).join('/'), text: withoutComments(fs.readFileSync(file, 'utf8')) }));
  const scriptsMatching = (pattern) => code.filter(({ text }) => text.search(pattern) !== -1).map(({ name }) => name).sort();
  // smoke-eval.js builds a whole app folder (its spec and its own `.maker-workspace`) for a live smoke run against a scratch environment, and
  // regenerate-verified-icons.js runs `npm install` in a scratch folder: a maintainer runs each by hand, and neither is a step of a skill.
  assert.deepStrictEqual(scriptsMatching(/\btmpdir\s*\(/), ['lib/temp-workspace.js', 'regenerate-verified-icons.js', 'smoke-eval.js']);
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

test('when a process ends it removes the plugin\'s folder if nothing is left in it — and leaves it if a workspace was left', async (t) => {
  const root = privateTempRoot(t);
  const deps = { os: { tmpdir: () => root } };
  const clean = startTarget(t, ['workspace-exit', 'genpage-'], { env: tempEnv(root) });
  await clean.waitFor(/^done$/);
  await clean.exited;
  assert.deepStrictEqual(fs.readdirSync(root), [], 'a normal run leaves the temp folder as it found it');

  const careless = startTarget(t, ['workspace-keep', 'genpage-'], { env: tempEnv(root) });
  const left = (await careless.waitFor(/^workspace /)).slice('workspace '.length);
  await careless.exited;
  assert.ok(fs.existsSync(path.join(left, 'page.tsx')), 'a workspace a run did not remove is left where it is');
  assert.deepStrictEqual(fs.readdirSync(root), [path.basename(workspaceParent(deps))], 'in the plugin\'s folder');
  // The run has ended — it is gone — so the next sweep takes its workspace, and not the folder.
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed.map((r) => r.name), [path.basename(left)]);
  assert.ok(fs.existsSync(workspaceParent(deps)));
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
// icacls and whoami are the programs of Windows itself, started by name as the tests of the access-list reader start them.
const runWindows = (program, args) => {
  const run = spawnSync(program, args, { encoding: 'utf8', windowsHide: true });
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
  t.after(() => fs.chmodSync(parent, 0o700));
  const dir = makeTempWorkspace('genpage-', deps);
  assert.strictEqual(path.dirname(dir), root);
  assert.deepStrictEqual(fs.readdirSync(parent), []);
});

test('Windows: a plugin\'s folder that exists and denies this user the right to add a folder (as a read-only one does) is skipped — the workspace is made in the temp folder', onlyWindows, (t) => {
  const { root, deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  fs.mkdirSync(parent);
  const sid = currentSid();
  runWindows('icacls', [parent, '/deny', `*${sid}:(AD)`]);
  try {
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

test('a folder that is removed while its access list is being read — another run ended with nothing left in it — is made again, not taken for an unsafe one', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent({ ...deps, uid: null });
  fs.mkdirSync(parent);
  let asked = 0;
  // What the reader makes of a folder that goes away under it: it cannot save a list of what is not there, and says no.
  const own = { ...deps, uid: null, folderPrivacy: () => { asked += 1; fs.rmdirSync(parent); return { ok: false, reason: 'its access list could not be saved' }; } };
  const dir = makeTempWorkspace('genpage-', own);
  assert.strictEqual(path.dirname(dir), parent, 'made again in the plugin\'s folder, as the run that asked is owed — not in the temp folder, unrecorded');
  assert.ok(recordOfFolder(dir), 'and recorded');
  assert.strictEqual(asked, 1, 'the folder it was made in is the run\'s own, which is not asked about');
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

// ---------------------------------------------------------------------------------------------------------------------
// A workspace lent to a program of another make. The program is not the run: pac, given a path inside the workspace, outlives a run that is killed on POSIX, and the workspace is its
// until it ends. The record names every such program; a sweep needs all of them gone, and a spawn that was never recorded keeps the workspace for a day.
// ---------------------------------------------------------------------------------------------------------------------

const recordOfFolder = (dir) => {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'));
    return isOwnerStamp(stamp) ? stamp : null;
  } catch {
    return null;
  }
};
const lentOf = (dir) => { const stamp = recordOfFolder(dir); return stamp ? stamp.lent : undefined; };
// A program that runs until it is killed.
const runningProgram = (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(() => child.kill('SIGKILL'));
  return { pid: child.pid, kill: () => { child.kill('SIGKILL'); return exited; } };
};

test('lendWorkspace: the record says a program is about to be given the workspace, then which one — what the launch answers is what comes back — and with the program gone it is the plain record again', async (t) => {
  const { deps } = tempRoot(t);
  const dir = makeTempWorkspace('genpage-', deps);
  const before = fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8');
  assert.strictEqual(recordOfFolder(dir).lent, undefined);
  const gone = deadPid();
  const seen = {};
  const answer = await lendWorkspace(dir, async (onSpawn) => {
    seen.starting = lentOf(dir);
    onSpawn(gone);
    seen.started = lentOf(dir);
    return { ok: true };
  }, deps);
  assert.deepStrictEqual(answer, { ok: true });
  assert.deepStrictEqual([seen.starting.pending, seen.starting.pids], [1, []], 'before the program is started the record says one is about to be');
  assert.ok(Number.isFinite(seen.starting.at));
  assert.deepStrictEqual([seen.started.pending, seen.started.pids.map((p) => p.pid)], [0, [gone]], 'once it exists the record names it, and no longer says one is about to be');
  assert.strictEqual(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'), before, 'the program is gone and the launch is over: the record is byte for byte the one the maker wrote');
  assert.deepStrictEqual(fs.readdirSync(dir), [OWNER_FILE], 'no temp copy of the record is left');
});

test('lendWorkspace: a program that still runs when the launch is over stays recorded; on Linux it is recorded with its start, as the maker is', async (t) => {
  const { deps } = tempRoot(t);
  const dir = makeTempWorkspace('genpage-', deps);
  const program = runningProgram(t);
  await lendWorkspace(dir, async (onSpawn) => { onSpawn(program.pid); }, deps);
  assert.deepStrictEqual(lentOf(dir).pids.map((p) => p.pid), [program.pid]);
  assert.strictEqual(lentOf(dir).pending, 0);
  await program.kill();
  await lendWorkspace(dir, async () => undefined, deps);
  assert.strictEqual(lentOf(dir), undefined, 'the next lend finds it gone, and drops it');
  // Linux: the start the machine gives for the program's pid, so that a pid handed out again is not taken for it.
  const linux = makeTempWorkspace('genpage-', tempRoot(t).deps);
  const owner = linuxSide(LINUX_NS, { startOf: (pid) => ({ token: `${LINUX_BOOT}:${pid}`, state: 'S' }) });
  await lendWorkspace(linux, async (onSpawn) => { onSpawn(program.pid); }, { owner });
  assert.deepStrictEqual(lentOf(linux).pids, [{ pid: program.pid, start: `${LINUX_BOOT}:${program.pid}` }]);
});

test('a workspace lent to a program is kept by a sweep for as long as the program runs after its maker is gone — the sweep needs EVERY recorded process gone', async (t) => {
  const { deps } = tempRoot(t);
  const dir = plant(deps, goneRecord());
  const a = runningProgram(t);
  const b = runningProgram(t);
  await lendWorkspace(dir, async (onSpawn) => { onSpawn(a.pid); }, deps);
  await lendWorkspace(dir, async (onSpawn) => { onSpawn(b.pid); }, deps);
  assert.deepStrictEqual(lentOf(dir).pids.map((p) => p.pid).sort(), [a.pid, b.pid].sort());
  const during = sweepDeadWorkspaces(deps);
  assert.deepStrictEqual([during.removed, during.failed], [[], []], 'its maker is gone and two programs it lent it to run');
  assert.ok(fs.existsSync(path.join(dir, 'apps', 'page.json')), 'the source is whole');
  await a.kill();
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed, [], 'one of the two is gone: still kept');
  assert.ok(fs.existsSync(dir));
  await b.kill();
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed.map((r) => r.name), [path.basename(dir)], 'both gone: removed');
});

test('a launch that never reports the program it started — the run died between starting it and writing its pid — keeps the workspace for a day by the record\'s own time, and then releases it', async (t) => {
  const { deps } = tempRoot(t);
  const dir = plant(deps, goneRecord());
  const never = lendWorkspace(dir, () => new Promise(() => {}), deps);
  never.catch(() => {});
  assert.strictEqual(lentOf(dir).pending, 1);
  const { at } = lentOf(dir);
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed, [], 'a program may have been started with it, and nothing says which');
  assert.deepStrictEqual(sweepDeadWorkspaces({ ...deps, owner: { now: () => at + LENT_PENDING_MS - 1 } }).removed, [], 'a millisecond short of a day');
  assert.strictEqual(LENT_PENDING_MS, 24 * 60 * 60 * 1000);
  assert.deepStrictEqual(sweepDeadWorkspaces({ ...deps, owner: { now: () => at + LENT_PENDING_MS } }).removed.map((r) => r.name), [path.basename(dir)], 'a day: no program of ours runs that long');
});

test('lendWorkspace: a launch that throws, or that never started a program, leaves no spawn pending — and the error is the launch\'s own', async (t) => {
  const { deps } = tempRoot(t);
  const dir = makeTempWorkspace('genpage-', deps);
  const before = fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8');
  await assert.rejects(lendWorkspace(dir, async () => { throw new Error('pac could not be started'); }, deps), /pac could not be started/);
  assert.strictEqual(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'), before);
  await assert.rejects(lendWorkspace(dir, () => { throw new Error('thrown at once'); }, deps), /thrown at once/);
  assert.strictEqual(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'), before);
  assert.strictEqual(await lendWorkspace(dir, async () => 'no program was started', deps), 'no program was started');
  assert.strictEqual(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'), before);
  // Reports that are not a process id are not recorded.
  await lendWorkspace(dir, async (onSpawn) => { for (const odd of [undefined, null, 'x', -3, 0, 1.5, NaN]) onSpawn(odd); }, deps);
  assert.strictEqual(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'), before);
});

test('lendWorkspace: two programs lent at once are both recorded, whichever ends first', async (t) => {
  const { deps } = tempRoot(t);
  const dir = makeTempWorkspace('genpage-', deps);
  const a = runningProgram(t);
  const b = runningProgram(t);
  let end;
  const first = lendWorkspace(dir, (onSpawn) => new Promise((resolve) => { onSpawn(a.pid); end = resolve; }), deps);
  const second = lendWorkspace(dir, async (onSpawn) => { onSpawn(b.pid); }, deps);
  await second;
  assert.deepStrictEqual(lentOf(dir).pids.map((p) => p.pid).sort(), [a.pid, b.pid].sort());
  assert.strictEqual(lentOf(dir).pending, 0);
  end();
  await first;
  assert.deepStrictEqual(lentOf(dir).pids.map((p) => p.pid).sort(), [a.pid, b.pid].sort(), 'both run still');
});

test('lendWorkspace on a folder nothing records — the plain temp folder\'s, one whose record could not be written or is damaged — just runs the launch: such a folder is never swept', async (t) => {
  const { root, deps } = tempRoot(t);
  const plain = fs.mkdtempSync(path.join(root, 'genpage-'));
  const damaged = plant(deps, 'not json {', { pid: deadPid() });
  let ran = 0;
  assert.strictEqual(await lendWorkspace(plain, async (onSpawn) => { ran += 1; onSpawn(deadPid()); return 'answer'; }, deps), 'answer');
  assert.strictEqual(await lendWorkspace(damaged, async () => { ran += 1; return 'answer'; }, deps), 'answer');
  assert.strictEqual(ran, 2);
  assert.deepStrictEqual(fs.readdirSync(plain), [], 'nothing was written in the plain folder');
  assert.strictEqual(fs.readFileSync(path.join(damaged, OWNER_FILE), 'utf8'), 'not json {', 'and the damaged record is as it was');
});

test('lendWorkspace never starts a program while its record cannot say so: it takes the record away — an unrecorded folder is never swept — or does not start the program', async (t) => {
  const { deps } = tempRoot(t);
  const full = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  // The rewrite fails, the record can be removed: the program is started, and the folder is no longer one a sweep may remove.
  const dir = makeTempWorkspace('genpage-', deps);
  const noRewrite = { ...fs, writeFileSync: (file, ...rest) => { if (path.basename(file) !== OWNER_FILE && path.basename(file).startsWith(OWNER_FILE)) throw full; return fs.writeFileSync(file, ...rest); } };
  let started = 0;
  await lendWorkspace(dir, async () => { started += 1; }, { ...deps, fs: noRewrite });
  assert.strictEqual(started, 1);
  assert.deepStrictEqual(fs.readdirSync(dir), [], 'unrecorded now: no sweep can take it from under the program, and no half-written copy is left');
  // Neither can be done: the program is not started, and the record is as it was.
  const stuck = makeTempWorkspace('genpage-', deps);
  const before = fs.readFileSync(path.join(stuck, OWNER_FILE), 'utf8');
  const denied = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  const unremovable = { ...noRewrite, rmSync: (file, ...rest) => { if (path.basename(file) === OWNER_FILE) throw denied(); return fs.rmSync(file, ...rest); }, unlinkSync: (file) => { if (path.basename(file) === OWNER_FILE) throw denied(); return fs.unlinkSync(file); } };
  await assert.rejects(lendWorkspace(stuck, async () => { started += 1; }, { ...deps, fs: unremovable }), (e) => e === full);
  assert.strictEqual(started, 1, 'the program was not started');
  assert.strictEqual(fs.readFileSync(path.join(stuck, OWNER_FILE), 'utf8'), before);
  assert.deepStrictEqual(fs.readdirSync(stuck), [OWNER_FILE]);
});

test('the record is rewritten whole — a temp file beside it, renamed over it — so a sweep or a kill sees the old record or the new, never half; a rewrite that fails leaves the old one and no temp file', async (t) => {
  const { deps } = tempRoot(t);
  const dir = makeTempWorkspace('genpage-', deps);
  const log = [];
  const watched = {
    ...fs,
    writeFileSync: (file, data, options) => { log.push(['write', path.basename(file), options && options.flag]); return fs.writeFileSync(file, data, options); },
    renameSync: (from, to) => { log.push(['rename', path.basename(from), path.basename(to)]); return fs.renameSync(from, to); },
  };
  await lendWorkspace(dir, async (onSpawn) => { onSpawn(deadPid()); }, { ...deps, fs: watched });
  const writes = log.filter((entry) => entry[0] === 'write');
  assert.ok(writes.length >= 3, JSON.stringify(log));
  for (const [, name, flag] of writes) assert.ok(name.startsWith(`${OWNER_FILE}.`) && name.endsWith('.tmp') && flag === 'wx', `written to a new temp file, never in place: ${name}`);
  for (const [, from, to] of log.filter((entry) => entry[0] === 'rename')) assert.ok(from.startsWith(`${OWNER_FILE}.`) && to === OWNER_FILE, `${from} → ${to}`);
  assert.deepStrictEqual(fs.readdirSync(dir), [OWNER_FILE]);

  // The report of the program's pid cannot be written: the record keeps saying one is about to be (more than is needed, never less), whole, with no temp file left.
  const other = makeTempWorkspace('genpage-', deps);
  let renames = 0;
  const flaky = { ...fs, renameSync: (from, to) => { renames += 1; if (renames === 2) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); return fs.renameSync(from, to); } };
  let during;
  await lendWorkspace(other, async (onSpawn) => { onSpawn(deadPid()); during = lentOf(other); }, { ...deps, fs: flaky });
  assert.deepStrictEqual([during.pending, during.pids], [1, []], 'the old record stood while the new one could not be written');
  assert.deepStrictEqual(fs.readdirSync(other), [OWNER_FILE], 'no temp file is left');
  assert.ok(lentOf(other).pending >= 1, 'and what was recorded is not less than what was known');
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

test('a record that was taken out of a folder that then will not go, and cannot be moved back, is written again — the folder is never left recorded by nothing', (t) => {
  const { deps } = tempRoot(t);
  const parent = workspaceParent(deps);
  const dir = plant(deps, goneRecord());
  const before = fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8');
  const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
  const stuck = {
    ...fs,
    rmdirSync: (target, ...rest) => { if (target === dir) throw eperm(); return fs.rmdirSync(target, ...rest); },
    // The way back is shut as well: only a record that is written again is left.
    renameSync: (from, to) => { if (to === path.join(dir, OWNER_FILE)) throw eperm(); return fs.renameSync(from, to); },
  };
  const result = sweepDeadWorkspaces({ ...deps, fs: stuck });
  assert.deepStrictEqual(result.failed.map((f) => [f.name, f.error]), [[path.basename(dir), 'EPERM']]);
  assert.strictEqual(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8'), before, 'the record is back, word for word');
  assert.deepStrictEqual(fs.readdirSync(parent), [path.basename(dir)], 'and no copy of it is left beside the folder');
  assert.deepStrictEqual(sweepDeadWorkspaces(deps).removed.map((r) => r.name), [path.basename(dir)], 'and the next sweep removes the folder');
  assert.deepStrictEqual(fs.readdirSync(parent), []);
});
