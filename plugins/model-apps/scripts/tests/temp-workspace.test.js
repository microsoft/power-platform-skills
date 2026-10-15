'use strict';
// lib/temp-workspace.js: the one maker of the plugin's throwaway workspace folders, and the sweep of the ones a killed run left. The sweep removes a
// folder — and the page source in it — so the tests spend their words on what it must NOT remove, and on what it does when it is racing live runs.
// Real processes decide what a kill leaves, and race the sweep; the rest is driven through the module's seams, in folders of the test's own.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PARENT_NAME, OWNER_FILE, LIMITS, workspaceParent, makeTempWorkspace, sweepDeadWorkspaces, sweepWarning,
} = require('../lib/temp-workspace.js');
const { ownerStamp, isOwnerStamp } = require('../lib/process-owner.js');
const { privateTempRoot, tempEnv, startTarget, deadPid, pause } = require('./helpers/kill-target-client.js');

const POSIX = process.platform !== 'win32';
const onlyPosix = { skip: !POSIX && 'POSIX modes, owners and links' };

// A temp folder of the test's own, and the `os` that names it, so that nothing the plugin makes is outside it.
function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-ws-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, deps: { os: { tmpdir: () => root } } };
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

test('a plugin\'s folder removed under a run — another process ended just now with nothing left in it — is made again; any other failure is the caller\'s, once', (t) => {
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

  const refused = tempRoot(t);
  let asked = 0;
  assert.throws(() => makeTempWorkspace('genpage-', { ...refused.deps, mkdtempSync: () => { asked += 1; throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } }), (e) => e.code === 'EACCES');
  assert.strictEqual(asked, 1, 'asked once: the plain temp folder would have said the same');
  // A folder that is gone every time is not made forever.
  const vanishing = tempRoot(t);
  let tries = 0;
  const fallback = makeTempWorkspace('genpage-', { ...vanishing.deps, mkdtempSync: (start) => { tries += 1; if (tries <= 3) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return fs.mkdtempSync(start); } });
  assert.strictEqual(tries, 4);
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
    rmSync: (p, ...rest) => { if (folderOf(p)) { removed.push(p); return undefined; } return fs.rmSync(p, ...rest); },
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
  const answers = await Promise.all(runs.map((run) => run.waitFor(/^loop-done \d+$/)));
  sweeping = false;
  await sweeper;
  assert.deepStrictEqual(answers, Array(RUNS).fill('loop-done 0'), 'no run ever found its own workspace gone or unrecorded');
  assert.ok(!fs.existsSync(deadFolder), 'the dead run\'s workspace was removed, by one of the sweeps');
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
