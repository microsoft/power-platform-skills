'use strict';
// lib/process-owner.js: who made a lock or a workspace, and whether that process is gone. The verdict is one-sided on purpose — every doubt is "keep" — so
// these tests spend most of their words on what must NOT be called gone. Real processes decide what a kill leaves; the rest is the table of what each
// answer of the machine means (the Linux reads are fed the text the kernel gives, since the suite also runs where there is no /proc).
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const os = require('node:os');
const {
  STAMP_VERSION, processAlive, probeProcess, parseProcStat, ownerStamp, isOwnerStamp, ownerState, describeOwner,
} = require('../lib/process-owner.js');
const { processAlive: storesProcessAlive } = require('../lib/apply-snapshot-store.js');
const { deadPid } = require('./helpers/kill-target-client.js');
const killsWith = (t, code) => t.mock.method(process, 'kill', () => { throw Object.assign(new Error(`kill ${code}`), { code }); });

test('processAlive is the one check the snapshot lease has always used: a running process, one that belongs to another user, and nothing else', (t) => {
  assert.strictEqual(storesProcessAlive, processAlive, 'the store re-exports it: there is no second copy');
  assert.strictEqual(processAlive(process.pid), true);
  assert.strictEqual(processAlive(deadPid()), false);
  for (const nothing of [0, undefined, null, '1', NaN, {}]) assert.strictEqual(processAlive(nothing), false, String(nothing));
  killsWith(t, 'EPERM');
  assert.strictEqual(processAlive(4242), true, 'EPERM: it exists, and is not ours to signal');
});

test('processAlive answers false for every other error, as it always did', (t) => {
  killsWith(t, 'EINVAL');
  assert.strictEqual(processAlive(4242), false);
});

test('probeProcess says "gone" only for a pid that no process has, and "unknown" for what it cannot tell', (t) => {
  assert.strictEqual(probeProcess(process.pid), 'alive');
  assert.strictEqual(probeProcess(deadPid()), 'gone');
  for (const nothing of [0, -1, 1.5, '1', NaN, undefined, null]) assert.strictEqual(probeProcess(nothing), 'unknown', String(nothing));
  killsWith(t, 'EPERM');
  assert.strictEqual(probeProcess(4242), 'alive', 'EPERM is a process that exists');
  t.mock.restoreAll();
  killsWith(t, 'EINVAL');
  assert.strictEqual(probeProcess(4242), 'unknown', 'an error that is neither "no such process" nor "not permitted" says nothing');
  t.mock.restoreAll();
  killsWith(t, 'ESRCH');
  assert.strictEqual(probeProcess(4242), 'gone');
});

test('parseProcStat reads the state and the start time after the LAST ")" of the line: a command name may hold spaces and parentheses', () => {
  const tail = '4000 4242 4000 34816 4242 4194560 20961 0 0 0 51 9 0 0 20 0 11 0 5382613 1207963648 38437 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';
  assert.deepStrictEqual(parseProcStat(`4242 (node) S ${tail}`), { state: 'S', start: '5382613' });
  assert.deepStrictEqual(parseProcStat(`4242 (node) S ${tail}\n`), { state: 'S', start: '5382613' }, 'the line ends in a newline');
  assert.deepStrictEqual(parseProcStat(`4242 (a) b) Z ${tail}`), { state: 'Z', start: '5382613' }, 'a name with a ")" in it');
  assert.deepStrictEqual(parseProcStat(`4242 (my node (v22)) R ${tail}`), { state: 'R', start: '5382613' }, 'a name with spaces and nested parentheses');
  for (const damaged of ['', 'no parenthesis at all', '4242 (node) S 4000 4242', `4242 (node) 5 ${tail}`, '4242 (node) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 not-a-number 20']) {
    assert.strictEqual(parseProcStat(damaged), null, JSON.stringify(damaged));
  }
  assert.strictEqual(parseProcStat(undefined), null);
});

const BOOT = '11111111-2222-3333-4444-555555555555';
const NS = 'pid:[4026531836]';
const LINUX = { platform: 'linux', hostname: () => 'build-box', ns: NS, pid: 100 };

test('ownerStamp records who made it: this process, this machine, this kind of system — and on Linux its pid namespace and start time', () => {
  const stamp = ownerStamp({ ...LINUX, now: () => 1760483934512, startOf: (pid) => ({ token: `${BOOT}:${pid}0`, state: 'S' }) });
  assert.deepStrictEqual(stamp, { v: STAMP_VERSION, pid: 100, at: 1760483934512, host: 'build-box', platform: 'linux', ns: NS, start: `${BOOT}:1000` });
  assert.ok(isOwnerStamp(stamp));
  // Elsewhere there is nothing cheap to read: the record is shorter, and what it cannot prove it leaves out.
  const elsewhere = ownerStamp({ platform: 'win32', hostname: () => 'DESKTOP-1', pid: 7, now: () => 5 });
  assert.deepStrictEqual(elsewhere, { v: STAMP_VERSION, pid: 7, at: 5, host: 'DESKTOP-1', platform: 'win32' });
  // The Linux reads that fail leave no ns and no start, and do not throw.
  const blind = ownerStamp({ platform: 'linux', hostname: () => 'build-box', pid: 8, now: () => 5, readFile: () => { throw new Error('no /proc'); }, readlink: () => { throw new Error('no /proc'); } });
  assert.deepStrictEqual(blind, { v: STAMP_VERSION, pid: 8, at: 5, host: 'build-box', platform: 'linux' });
  // With nothing replaced it is this process, on this machine.
  const mine = ownerStamp();
  assert.deepStrictEqual([mine.pid, mine.host, mine.platform], [process.pid, os.hostname(), process.platform]);
  assert.ok(isOwnerStamp(mine));
  // A host name that cannot be read is no host: such a record names nobody and is never believed.
  assert.strictEqual(isOwnerStamp(ownerStamp({ ...LINUX, hostname: () => { throw new Error('no host'); } })), false);
});

test('isOwnerStamp accepts what ownerStamp writes, and nothing that merely looks like it', () => {
  const good = { v: 1, pid: 4242, at: 1, host: 'h', platform: 'linux', ns: NS, start: `${BOOT}:1` };
  assert.ok(isOwnerStamp(good));
  assert.ok(isOwnerStamp({ ...good, rnd: 'an extra key, such as a lock\'s own token adds' }));
  assert.ok(isOwnerStamp({ v: 1, pid: 1, at: 0, host: 'h', platform: 'win32' }), 'ns and start are optional');
  for (const [what, bad] of [
    ['no record', undefined], ['null', null], ['a number', 5], ['text', 'text'], ['a list', [good]],
    ['the record a release before this one wrote: { pid, at }', { pid: 4242, at: 1 }],
    ['a later version', { ...good, v: 2 }], ['no version', { ...good, v: undefined }],
    ['a pid that is not an integer', { ...good, pid: 4242.5 }], ['a pid that is text', { ...good, pid: '4242' }], ['pid 0', { ...good, pid: 0 }], ['a negative pid', { ...good, pid: -4 }],
    ['no time', { ...good, at: undefined }], ['a time that is not finite', { ...good, at: Infinity }],
    ['no host', { ...good, host: undefined }], ['an empty host', { ...good, host: '' }], ['no platform', { ...good, platform: '' }],
    ['an ns that is not text', { ...good, ns: 7 }], ['a start that is not text', { ...good, start: 7 }],
  ]) {
    assert.strictEqual(isOwnerStamp(bad), false, what);
  }
});

// The verdict. `here` is this process as the verdict sees it; the stamp is what some process wrote.
const here = { ...LINUX, pid: 100 };
const stampOf = (overrides = {}) => ({ v: 1, pid: 200, at: 1, host: 'build-box', platform: 'linux', ns: NS, start: `${BOOT}:900`, ...overrides });
const verdict = (stamp, deps = {}) => ownerState(stamp, { ...here, ...deps });

test('ownerState: a pid that no process has is gone — and nothing else is, on the strength of the pid alone', () => {
  assert.strictEqual(verdict(stampOf(), { probe: () => 'gone' }).state, 'gone');
  assert.strictEqual(verdict(stampOf(), { probe: () => 'unknown' }).state, 'unknown');
  assert.strictEqual(verdict(stampOf(), { probe: () => 'alive', startOf: () => null }).state, 'alive', 'a process runs under the pid and its start cannot be read: it may be the maker');
  assert.strictEqual(verdict(stampOf({ start: undefined }), { probe: () => 'alive', startOf: () => { throw new Error('not asked: the record has no start'); } }).state, 'alive');
  // Where there is no start to compare (Windows, macOS), a running process under the pid is taken for the maker.
  const win = { platform: 'win32', hostname: () => 'DESKTOP-1', pid: 100 };
  const winStamp = { v: 1, pid: 200, at: 1, host: 'DESKTOP-1', platform: 'win32' };
  assert.strictEqual(ownerState(winStamp, { ...win, probe: () => 'alive' }).state, 'alive');
  assert.strictEqual(ownerState(winStamp, { ...win, probe: () => 'gone' }).state, 'gone');
});

test('ownerState: a pid handed out again (Linux) is another process — a different start, or one that is a zombie — and one that cannot be read is NOT proof', () => {
  const running = (start, state = 'S') => ({ probe: () => 'alive', startOf: () => ({ token: start, state }) });
  assert.strictEqual(verdict(stampOf(), running(`${BOOT}:900`)).state, 'alive', 'the same start: the same process');
  assert.strictEqual(verdict(stampOf(), running(`${BOOT}:901`)).state, 'gone', 'another start: the pid was handed out again');
  assert.strictEqual(verdict(stampOf(), running('another-boot:900')).state, 'gone', 'another boot');
  for (const state of ['Z', 'X', 'x']) assert.strictEqual(verdict(stampOf(), running(`${BOOT}:900`, state)).state, 'gone', `state ${state}`);
  for (const state of ['R', 'S', 'D', 'T', 't', 'I']) assert.strictEqual(verdict(stampOf(), running(`${BOOT}:900`, state)).state, 'alive', `state ${state}`);
  assert.strictEqual(verdict(stampOf(), { probe: () => 'alive', startOf: () => null }).state, 'alive');
});

test('ownerState: this process is alive — unless Linux shows the pid was another process\'s when the record was made', () => {
  assert.strictEqual(verdict(stampOf({ pid: 100 }), { probe: () => { throw new Error('a process does not look itself up'); }, startOf: () => ({ token: `${BOOT}:900`, state: 'R' }) }).state, 'alive');
  assert.strictEqual(verdict(stampOf({ pid: 100 }), { startOf: () => ({ token: `${BOOT}:777`, state: 'R' }) }).state, 'gone', 'an earlier process had this pid');
  assert.strictEqual(verdict(stampOf({ pid: 100, start: undefined }), { startOf: () => ({ token: `${BOOT}:777`, state: 'R' }) }).state, 'alive', 'no start recorded: it is this process');
  assert.strictEqual(verdict(stampOf({ pid: 100 }), { startOf: () => null }).state, 'alive', 'a start that cannot be read is not proof');
  const win = { platform: 'win32', hostname: () => 'DESKTOP-1', pid: 100 };
  assert.strictEqual(ownerState({ v: 1, pid: 100, at: 1, host: 'DESKTOP-1', platform: 'win32' }, win).state, 'alive');
});

test('ownerState: a record that is not this machine\'s, this system\'s or this pid namespace\'s — or not a record — decides nothing, whatever its pid says', () => {
  const gone = { probe: () => 'gone', startOf: () => null };
  const unknown = (stamp, deps = {}) => verdict(stamp, { ...gone, ...deps }).state;
  assert.strictEqual(unknown(stampOf()), 'gone', 'control: with nothing else wrong, the pid decides');
  assert.strictEqual(unknown(stampOf({ host: 'another-box' })), 'unknown', 'another machine (a network share, a synced folder)');
  assert.strictEqual(unknown(stampOf({ platform: 'win32' })), 'unknown', 'another kind of system: WSL and Windows see one folder and have two pid spaces');
  assert.strictEqual(unknown(stampOf({ ns: 'pid:[4026532000]' })), 'unknown', 'another pid namespace: a container with the same host name');
  assert.strictEqual(unknown(stampOf({ ns: undefined })), 'unknown', 'a record with no namespace, read where there is one');
  assert.strictEqual(unknown(stampOf(), { ns: null }), 'unknown', 'a record with a namespace, read where it cannot be named');
  assert.strictEqual(unknown(stampOf({ ns: undefined }), { ns: null }), 'gone', 'no namespace on either side (no /proc): the same pid space as far as anything shows');
  assert.strictEqual(unknown({ pid: 200, at: 1 }), 'unknown', 'a lock from a release before the record: { pid, at }');
  assert.strictEqual(unknown(stampOf({ v: 2 })), 'unknown');
  assert.strictEqual(unknown(null), 'unknown');
  assert.strictEqual(unknown('not a record'), 'unknown');
  assert.strictEqual(unknown(stampOf({ pid: 'two hundred' })), 'unknown');
  assert.strictEqual(verdict(stampOf({ host: 'BUILD-BOX' }), gone).state, 'unknown', 'a host name is compared as it is: a name that differs in case is not shown to be this machine');
});

test('REAL PROCESSES: a process that runs is alive, and the same process after it is killed is gone — on every platform, with no seam', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(() => { child.kill('SIGKILL'); });
  // The record this process would have made for the child (on Linux, with the child's real start time read from /proc).
  const stamp = ownerStamp({ pid: child.pid });
  assert.ok(isOwnerStamp(stamp));
  assert.strictEqual(ownerState(stamp).state, 'alive');
  child.kill('SIGKILL');
  await exited;
  assert.strictEqual(ownerState(stamp).state, 'gone', ownerState(stamp).reason);
  // The record of this very process names it, as alive, wherever it is read.
  assert.strictEqual(ownerState(ownerStamp()).state, 'alive');
});

test('REAL PROCESSES (Linux): a record whose start differs from the live process\'s is a pid handed out again — gone; the same start is alive', { skip: process.platform !== 'linux' && 'reads /proc' }, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { child.kill('SIGKILL'); });
  const stamp = ownerStamp({ pid: child.pid });
  assert.match(stamp.start, new RegExp(`^${'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}'}:\\d+$`), 'a start was read from /proc');
  assert.match(stamp.ns, /^pid:\[\d+\]$/);
  assert.strictEqual(ownerState(stamp).state, 'alive');
  assert.strictEqual(ownerState({ ...stamp, start: stamp.start.replace(/:\d+$/, ':1') }).state, 'gone');
  assert.strictEqual(ownerState({ ...ownerStamp(), start: `${stamp.start.split(':')[0]}:1` }).state, 'gone', 'this pid, another start');
});

test('the Linux reads together: a /proc as the kernel lays it out gives the start token and the namespace — and a damaged one gives neither, and never a "gone"', () => {
  const stat = (state, start) => `4242 (node) ${state} 4000 4242 4000 34816 4242 4194560 20961 0 0 0 51 9 0 0 20 0 11 0 ${start} 1207963648 38437 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n`;
  const proc = (files) => ({
    readFile: (file) => { if (Object.prototype.hasOwnProperty.call(files, file)) return files[file]; throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }); },
    readlink: (file) => { if (file === '/proc/self/ns/pid' && files[file] !== undefined) return files[file]; throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' }); },
  });
  const files = { '/proc/4242/stat': stat('S', 5382613), '/proc/sys/kernel/random/boot_id': `${BOOT}\n`, '/proc/self/ns/pid': NS };
  const stamp = ownerStamp({ platform: 'linux', hostname: () => 'build-box', pid: 4242, now: () => 7, ...proc(files) });
  assert.deepStrictEqual(stamp, { v: 1, pid: 4242, at: 7, host: 'build-box', platform: 'linux', ns: NS, start: `${BOOT}:5382613` });

  // Read back by another process: the same pid, still running, with the same start → alive; another start → gone; a zombie → gone.
  const reader = (overrides) => ({ platform: 'linux', hostname: () => 'build-box', pid: 100, probe: () => 'alive', ...proc({ ...files, ...overrides }) });
  assert.strictEqual(ownerState(stamp, reader({})).state, 'alive');
  assert.strictEqual(ownerState(stamp, reader({ '/proc/4242/stat': stat('S', 5999999) })).state, 'gone', 'the pid was handed out again');
  assert.strictEqual(ownerState(stamp, reader({ '/proc/4242/stat': stat('Z', 5382613) })).state, 'gone', 'a zombie');
  assert.strictEqual(ownerState(stamp, reader({ '/proc/sys/kernel/random/boot_id': '66666666-7777-8888-9999-000000000000\n' })).state, 'gone', 'another boot');

  // What cannot be read, or is not what the kernel writes, proves nothing: the process stays "alive".
  for (const [what, damaged] of [
    ['a process whose /proc entry cannot be read (hidepid)', { '/proc/4242/stat': undefined }],
    ['a stat that is not in the shape', { '/proc/4242/stat': 'garbage' }],
    ['a boot id that is not one', { '/proc/sys/kernel/random/boot_id': 'not-a-uuid\n' }],
  ]) {
    const files2 = { ...files, ...damaged };
    if (files2['/proc/4242/stat'] === undefined) delete files2['/proc/4242/stat'];
    assert.strictEqual(ownerState(stamp, { platform: 'linux', hostname: () => 'build-box', pid: 100, probe: () => 'alive', ...proc(files2) }).state, 'alive', what);
  }
  // A record made where /proc has no start or namespace to give carries neither, and is read the same way.
  const bare = ownerStamp({ platform: 'linux', hostname: () => 'build-box', pid: 4242, now: () => 7, ...proc({}) });
  assert.deepStrictEqual(Object.keys(bare), ['v', 'pid', 'at', 'host', 'platform']);
  assert.strictEqual(ownerState(bare, { platform: 'linux', hostname: () => 'build-box', pid: 100, probe: () => 'gone', ...proc({}) }).state, 'gone');
});

test('describeOwner names the pid, the machine and the time — and a time that cannot be shown does not stop the message', () => {
  assert.strictEqual(describeOwner({ pid: 4242, host: 'build-box', at: Date.UTC(2026, 9, 14, 23, 38, 54, 512) }), 'pid 4242 on build-box, since 2026-10-14T23:38:54.512Z');
  assert.strictEqual(describeOwner({ pid: 4242, host: 'build-box', at: 1e20 }), 'pid 4242 on build-box');
});
