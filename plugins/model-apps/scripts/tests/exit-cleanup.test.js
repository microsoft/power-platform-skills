'use strict';
// A cleanup that runs, synchronously, when the process ends in a way JavaScript can see (lib/exit-cleanup.js): `process.exit`, an exit through an uncaught error, and a termination signal — after which the
// process ends as it would have. The signal handling is tested with a stand-in for `process` (it cannot be delivered the same way on every platform, and the real thing would end the test run), and the
// whole of it with a real child process: the exit and the uncaught error everywhere, the signals where the platform has them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { fork } = require('node:child_process');
const { onProcessEnd, SIGNALS } = require('../lib/exit-cleanup.js');

const WINDOWS = process.platform === 'win32';
const CHILD = path.join(__dirname, 'helpers', 'exit-cleanup-child.js');

// What the module is given in place of `process`: an emitter that records what is asked of the process.
function standIn() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.killed = [];
  proc.exited = [];
  proc.kill = (pid, signal) => { proc.killed.push([pid, signal]); };
  proc.exit = (code) => { proc.exited.push(code); };
  return proc;
}
const listenerCounts = (proc) => Object.fromEntries(['exit', ...SIGNALS].map((name) => [name, proc.listenerCount(name)]));
const NONE = Object.freeze({ exit: 0, SIGINT: 0, SIGTERM: 0, SIGHUP: 0, SIGBREAK: 0 });

test('the signals are SIGINT, SIGTERM, SIGHUP and SIGBREAK — where the platform delivers them it is these that end a program from outside', () => {
  assert.deepStrictEqual([...SIGNALS], ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);
});

test('nothing is attached to the process until a cleanup is registered, one set of listeners serves every cleanup, and the last release takes them all off again', () => {
  const proc = standIn();
  assert.deepStrictEqual(listenerCounts(proc), NONE);
  const releaseA = onProcessEnd(() => {}, { process: proc });
  const releaseB = onProcessEnd(() => {}, { process: proc });
  assert.deepStrictEqual(listenerCounts(proc), { exit: 1, SIGINT: 1, SIGTERM: 1, SIGHUP: 1, SIGBREAK: 1 }, 'one listener each, however many cleanups');
  releaseA();
  assert.strictEqual(proc.listenerCount('exit'), 1, 'one cleanup is still registered');
  releaseB();
  assert.deepStrictEqual(listenerCounts(proc), NONE, 'no listener is left on the process');
  releaseB(); // a release is safe to repeat
  assert.deepStrictEqual(listenerCounts(proc), NONE);
});

test('a cleanup that was released does not run when the process exits — it is for a run that is still going', () => {
  const proc = standIn();
  const ran = [];
  const release = onProcessEnd(() => ran.push('first'), { process: proc });
  onProcessEnd(() => ran.push('second'), { process: proc });
  release();
  proc.emit('exit', 0);
  assert.deepStrictEqual(ran, ['second']);
});

test('on exit every registered cleanup runs, once, in the order registered — and one that throws does not stop the others', () => {
  const proc = standIn();
  const ran = [];
  onProcessEnd(() => ran.push('first'), { process: proc });
  onProcessEnd(() => { ran.push('second'); throw new Error('a cleanup that fails'); }, { process: proc });
  onProcessEnd(() => ran.push('third'), { process: proc });
  proc.emit('exit', 5);
  assert.deepStrictEqual(ran, ['first', 'second', 'third']);
  proc.emit('exit', 5);
  assert.deepStrictEqual(ran, ['first', 'second', 'third'], 'once: a second end of the process finds nothing to do');
  assert.deepStrictEqual(proc.killed, []);
  assert.deepStrictEqual(proc.exited, [], 'the exit is the process\'s own: nothing is asked of it');
});

for (const signal of SIGNALS) {
  test(`${signal}: the cleanups run, the listeners come off, and — when nothing else listens for it — the same signal is raised again, so the process ends as ${signal} ends it`, () => {
    const proc = standIn();
    const ran = [];
    onProcessEnd(() => ran.push('first'), { process: proc });
    onProcessEnd(() => ran.push('second'), { process: proc });
    proc.emit(signal, signal);
    assert.deepStrictEqual(ran, ['first', 'second']);
    assert.deepStrictEqual(listenerCounts(proc), NONE, 'no listener of ours is left: the default action of the signal can act');
    assert.deepStrictEqual(proc.killed, [[4242, signal]], 'the signal is raised once, at the process itself');
    assert.deepStrictEqual(proc.exited, []);
  });
}

test('a signal that another listener also has is that listener\'s to act on: the cleanups run and our listeners come off, and the signal is not raised again', () => {
  const proc = standIn();
  const ran = [];
  const heard = [];
  proc.on('SIGTERM', () => heard.push('the program\'s own handler'));
  onProcessEnd(() => ran.push('cleanup'), { process: proc });
  proc.emit('SIGTERM', 'SIGTERM');
  assert.deepStrictEqual(ran, ['cleanup']);
  assert.deepStrictEqual(heard, ['the program\'s own handler'], 'the other listener was told, as it would have been');
  assert.deepStrictEqual(proc.killed, [], 'it decides how the process ends');
  assert.deepStrictEqual(listenerCounts(proc), { ...NONE, SIGTERM: 1 }, 'and what is left on the process is its own listener');
});

test('when the signal cannot be raised again — a platform with no such signal to send — the process is ended with status 1 after the cleanups', () => {
  const proc = standIn();
  proc.kill = () => { throw Object.assign(new Error('kill ENOSYS'), { code: 'ENOSYS' }); };
  const ran = [];
  onProcessEnd(() => ran.push('cleanup'), { process: proc });
  proc.emit('SIGHUP', 'SIGHUP');
  assert.deepStrictEqual(ran, ['cleanup']);
  assert.deepStrictEqual(proc.exited, [1]);
});

test('a cleanup that throws in the face of a signal does not keep the process from ending, or the other cleanups from running', () => {
  const proc = standIn();
  const ran = [];
  onProcessEnd(() => { throw new Error('first fails'); }, { process: proc });
  onProcessEnd(() => ran.push('second'), { process: proc });
  proc.emit('SIGINT', 'SIGINT');
  assert.deepStrictEqual(ran, ['second']);
  assert.deepStrictEqual(proc.killed, [[4242, 'SIGINT']]);
});

test('after a signal the registry starts again: a cleanup registered later is served, and the one that ran is not run a second time', () => {
  const proc = standIn();
  const ran = [];
  onProcessEnd(() => ran.push('before'), { process: proc });
  proc.emit('SIGTERM', 'SIGTERM');
  onProcessEnd(() => ran.push('after'), { process: proc });
  assert.deepStrictEqual(listenerCounts(proc), { exit: 1, SIGINT: 1, SIGTERM: 1, SIGHUP: 1, SIGBREAK: 1 });
  proc.emit('exit', 0);
  assert.deepStrictEqual(ran, ['before', 'after']);
});

test('the registry belongs to the process it is given: the real process is not touched by a stand-in\'s, and a cleanup registered on the real process is released cleanly', () => {
  const before = listenerCounts(process);
  const proc = standIn();
  const releaseStandIn = onProcessEnd(() => {}, { process: proc });
  assert.deepStrictEqual(listenerCounts(process), before, 'nothing was added to the real process');
  const release = onProcessEnd(() => {});
  assert.strictEqual(process.listenerCount('exit'), before.exit + 1);
  release();
  releaseStandIn();
  assert.deepStrictEqual(listenerCounts(process), before, 'and nothing is left on it');
});

// --- a real process ----------------------------------------------------------------------------------------------------------------------------------

const dirs = [];
test.after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });

// Starts helpers/exit-cleanup-child.js — it registers a cleanup that writes `marker` — and waits until it has. `ending` says how it ends: exit | throw | wait (for a signal); `other` gives it a handler of its own
// for SIGTERM, registered before the cleanup.
async function child(t, ending, { other = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-cleanup-'));
  dirs.push(dir);
  const marker = path.join(dir, 'cleaned.txt');
  const handled = path.join(dir, 'handled.txt');
  const proc = fork(CHILD, [marker, ending, other ? handled : ''], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  proc.stderr.on('data', (data) => { stderr += data; });
  const exited = once(proc, 'exit');
  const ready = new Promise((resolve, reject) => {
    proc.once('message', resolve);
    proc.once('disconnect', () => reject(new Error(`the child ended before it was ready: ${stderr}`)));
  });
  t.after(async () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
      await exited;
    }
  });
  // What the child saw BEFORE it could end: a child that ends itself right after it speaks may have run its cleanup by the time the parent looks.
  const message = await ready;
  assert.strictEqual(message.kind, 'ready');
  assert.strictEqual(message.cleanedYet, false, 'nothing has been cleaned while the process runs');
  return { proc, exited, marker, handled, stderr: () => stderr };
}

test('real process: process.exit runs the cleanup, and the exit status is the one asked for', async (t) => {
  const run = await child(t, 'exit');
  assert.deepStrictEqual(await run.exited, [7, null]);
  assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
});

test('real process: an error nothing catches runs the cleanup, and the process still ends with a failure and says why', async (t) => {
  const run = await child(t, 'throw');
  const [code] = await run.exited;
  assert.notStrictEqual(code, 0);
  assert.match(run.stderr(), /an error nothing catches/);
  assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
});

test('real process: a process that ends normally, with its cleanup released, runs nothing — the cleanup is for a run that is still going', async (t) => {
  const run = await child(t, 'release');
  assert.deepStrictEqual(await run.exited, [0, null]);
  assert.strictEqual(fs.existsSync(run.marker), false);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`real process: ${signal} runs the cleanup, and the process then ends BY ${signal} — the status a process that had no handler would have had`, { skip: WINDOWS && 'Windows has no signals to deliver: a signal sent to a process ends it at once, without running anything' }, async (t) => {
    const run = await child(t, 'wait');
    run.proc.kill(signal);
    assert.deepStrictEqual(await run.exited, [null, signal]);
    assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
  });
}

test('real process: a program that has its own SIGTERM handler keeps it — the cleanup runs and the handler decides how the process ends', { skip: WINDOWS && 'Windows has no signals to deliver' }, async (t) => {
  const run = await child(t, 'wait', { other: true });
  run.proc.kill('SIGTERM');
  assert.deepStrictEqual(await run.exited, [9, null], 'the program\'s own handler ended it, with its own status');
  assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
  assert.strictEqual(fs.readFileSync(run.handled, 'utf8'), 'handled');
});
