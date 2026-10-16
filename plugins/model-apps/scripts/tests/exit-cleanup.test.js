'use strict';
// A cleanup that runs, synchronously, when the process ends in a way JavaScript can see (lib/exit-cleanup.js): `process.exit`, an exit through an uncaught error, and a termination signal — after which the
// process ends as it would have had nothing been listening: BY the signal on POSIX, with STATUS_CONTROL_C_EXIT (0xC000013A) on Windows, which has no signal to raise — unless the program has a handler of its
// own for the signal, which keeps the decision. The signal handling is tested with a stand-in for `process` (it cannot be delivered the same way on every platform, and the real thing would end the test run),
// and the whole of it with real child processes: the exit and the uncaught error everywhere, a signal the child raises in itself everywhere, a signal sent from outside where the platform has them (POSIX), and
// on Windows the real Ctrl+C and Ctrl+Break — console events, which are not signals and which `child.kill()` cannot send (helpers/console-event.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { fork } = require('node:child_process');
const { onProcessEnd, SIGNALS } = require('../lib/exit-cleanup.js');
const { runInConsoles, controlProblem } = require('./helpers/console-event.js');

const WINDOWS = process.platform === 'win32';
const CHILD = path.join(__dirname, 'helpers', 'exit-cleanup-child.js');
// STATUS_CONTROL_C_EXIT, the status Windows gives a process that a console event ended and that nothing handled — written out here, not taken from the module: this is what the test says Windows does.
// See: https://learn.microsoft.com/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55
const CONTROL_C_EXIT = 0xC000013A;

// What the module is given in place of `process`: an emitter that records what is asked of the process.
function standIn(platform = 'linux') {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.platform = platform;
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
  test(`POSIX, ${signal}: the cleanups run, the listeners come off, and — when nothing else listens for it — the same signal is raised again, so the process ends as ${signal} ends it`, () => {
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

// Windows has no signal to raise: `process.kill` there is TerminateProcess, which ends the process with status 1 whatever the signal was, and cannot send SIGHUP or SIGBREAK at all. A process that a console event
// (Ctrl+C, Ctrl+Break, the console window closed) ends and that nothing handles ends with STATUS_CONTROL_C_EXIT, and so that is the status the cleanup's process must end with: it is how a caller tells an
// interrupted run from a failed one.
for (const signal of SIGNALS) {
  test(`Windows, ${signal}: the cleanups run, the listeners come off, and the process ends with STATUS_CONTROL_C_EXIT (0xC000013A) — what a console event ends a process with — not with the status 1 that process.kill gives`, () => {
    const proc = standIn('win32');
    const ran = [];
    onProcessEnd(() => ran.push('first'), { process: proc });
    onProcessEnd(() => ran.push('second'), { process: proc });
    proc.emit(signal, signal);
    assert.deepStrictEqual(ran, ['first', 'second']);
    assert.deepStrictEqual(listenerCounts(proc), NONE, 'no listener of ours is left');
    assert.deepStrictEqual(proc.killed, [], 'process.kill is not asked: on Windows it ends a process with status 1');
    assert.deepStrictEqual(proc.exited, [CONTROL_C_EXIT], 'the process is ended once, with the status a console event gives it');
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

// A program that has a handler of its own for the signal keeps the decision how the process ends: the cleanups run, our listeners come off, nothing is done to the process, and the handler is neither removed nor
// replaced. Node takes a ONE-SHOT handler off the list just before it calls it, and a handler can take itself off, so by the time a listener that runs after such a handler looks, the handler is no longer there
// to be counted — and a program that began an orderly shutdown in it (the usual use of `process.once('SIGINT', …)`) would be ended under its feet. Whichever was registered first — and however it was put on the
// list: `prepend…` puts it AHEAD of everything there, the cleanup's listener included, which is where a one-shot handler is out of the count unless the cleanup is put back in front of it.
const HOW = Object.freeze({
  on: 'persistent',
  once: 'one-shot',
  'self-removing': 'self-removing',
  prepend: 'prepended persistent',
  'prepend-once': 'prepended one-shot',
  'prepend-self-removing': 'prepended self-removing',
});
const PERSISTENT = new Set(['on', 'prepend']);
function registerOwner(proc, signal, how, heard) {
  const owner = function owner() {
    heard.push(how);
    if (how.endsWith('self-removing')) proc.removeListener(signal, owner);
  };
  if (how === 'once') proc.once(signal, owner);
  else if (how === 'prepend-once') proc.prependOnceListener(signal, owner);
  else if (how.startsWith('prepend')) proc.prependListener(signal, owner);
  else proc.on(signal, owner);
  return owner;
}
function ownerKeepsTheDecision(platform, signal, how, when) {
  const proc = standIn(platform);
  const heard = [];
  const ran = [];
  let owner;
  if (when === 'before') owner = registerOwner(proc, signal, how, heard);
  onProcessEnd(() => ran.push('cleanup'), { process: proc });
  if (when === 'after') owner = registerOwner(proc, signal, how, heard);
  proc.emit(signal, signal);
  assert.deepStrictEqual(heard, [how], 'the program\'s handler was told of the signal');
  assert.deepStrictEqual(ran, ['cleanup'], 'and the cleanup ran');
  assert.deepStrictEqual(proc.killed, [], 'the signal is not raised again');
  assert.deepStrictEqual(proc.exited, [], 'the process is not ended: that is the handler\'s to do, when and how it chooses');
  assert.deepStrictEqual(listenerCounts(proc), { ...NONE, [signal]: PERSISTENT.has(how) ? 1 : 0 }, 'our listeners are off, and nothing but the program\'s own is left');
  if (PERSISTENT.has(how)) assert.deepStrictEqual(proc.listeners(signal), [owner], 'a persistent handler is still there, the same function');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(proc, 'prependListener'), false, 'and the process has its own prependListener again, not the cleanup\'s');
}
for (const platform of ['linux', 'win32']) {
  const where = platform === 'win32' ? 'Windows' : 'POSIX';
  for (const how of Object.keys(HOW)) {
    for (const when of ['before', 'after']) {
      test(`${where}: a program's own ${HOW[how]} SIGINT handler, registered ${when} the cleanup, keeps the decision how the process ends`, () => ownerKeepsTheDecision(platform, 'SIGINT', how, when));
    }
  }
  for (const signal of SIGNALS.filter((name) => name !== 'SIGINT')) {
    test(`${where}: a one-shot ${signal} handler registered before the cleanup keeps the decision too — every signal the cleanup listens for`, () => ownerKeepsTheDecision(platform, signal, 'once', 'before'));
    test(`${where}: and so does a one-shot ${signal} handler that the program PREPENDS after the cleanup`, () => ownerKeepsTheDecision(platform, signal, 'prepend-once', 'after'));
  }
}

test('the cleanup is first in line for a signal, so that it can count every handler that is to be told of it — the program\'s own handlers keep their places after it, in the order they were registered', () => {
  const proc = standIn();
  const handlers = [() => {}, () => {}];
  proc.on('SIGINT', handlers[0]);
  onProcessEnd(() => {}, { process: proc });
  proc.on('SIGINT', handlers[1]);
  const listeners = proc.listeners('SIGINT');
  assert.strictEqual(listeners.length, 3);
  assert.deepStrictEqual(listeners.slice(1), handlers);
});

// Appending keeps the cleanup first; PREPENDING does not, and a program may do it at any time — `process.prependOnceListener('SIGINT', shutdown)` is how a one-shot handler is put in front of the others. A
// one-shot handler in front of the cleanup is taken off the list by Node before the cleanup looks, so the cleanup would count no handler at all and end the process under the handler's shutdown. The cleanup
// is put back in front before the program's call returns: a signal can be raised in the very turn that it is made (`process.emit`), so there is no later moment at which to do it.
test('the cleanup STAYS first in line when the program prepends a handler — prependListener and prependOnceListener, at any time — and the program\'s handlers keep the order they asked for after it', () => {
  const proc = standIn();
  const [a, b, c, d] = [() => {}, () => {}, () => {}, () => {}];
  proc.on('SIGINT', a);
  proc.on('SIGTERM', d);
  onProcessEnd(() => {}, { process: proc });
  proc.prependListener('SIGINT', b);
  proc.prependOnceListener('SIGINT', c);
  proc.prependListener('SIGTERM', () => {});
  const [first, ...rest] = proc.rawListeners('SIGINT');
  assert.deepStrictEqual(rest.map((listener) => listener.listener || listener), [c, b, a], 'the program\'s handlers are in the order it asked for, as if the cleanup were not there');
  assert.ok(![a, b, c].includes(first.listener || first), 'and the one in front of them is not one of theirs');
  assert.strictEqual(proc.rawListeners('SIGTERM').length, 3);
  assert.strictEqual(proc.rawListeners('SIGTERM')[2], d, 'another signal is kept the same way');
  assert.deepStrictEqual(listenerCounts(proc), { exit: 1, SIGINT: 4, SIGTERM: 3, SIGHUP: 1, SIGBREAK: 1 }, 'nothing was lost, nothing was added twice');
});

test('a prepend that is NOT for one of the cleanup\'s signals is the program\'s alone — it is passed to the process\'s own method as it came, and its answer is the process\'s', () => {
  const proc = standIn();
  onProcessEnd(() => {}, { process: proc });
  const handler = () => {};
  assert.strictEqual(proc.prependListener('SIGUSR2', handler), proc, 'an EventEmitter answers itself');
  assert.strictEqual(proc.prependOnceListener('custom', handler), proc);
  assert.deepStrictEqual(proc.listeners('SIGUSR2'), [handler]);
  assert.strictEqual(proc.listenerCount('custom'), 1);
});

// The wrapping lasts as long as a cleanup is registered, and leaves the process as it found it.
test('the process\'s own prependListener is wrapped only while a cleanup is registered, and is the process\'s own again after — and what a program had put there before stays', () => {
  const proc = standIn();
  const release = onProcessEnd(() => {}, { process: proc });
  assert.notStrictEqual(proc.prependListener, EventEmitter.prototype.prependListener, 'wrapped while the cleanup is registered');
  assert.strictEqual(Object.prototype.propertyIsEnumerable.call(proc, 'prependListener'), false, 'and not where an enumeration of the process would see it');
  release();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(proc, 'prependListener'), false);
  assert.strictEqual(proc.prependListener, EventEmitter.prototype.prependListener);

  const calls = [];
  const programs = function prependListener(...args) { calls.push(args[0]); return EventEmitter.prototype.prependListener.apply(this, args); };
  proc.prependListener = programs;
  const releaseAgain = onProcessEnd(() => {}, { process: proc });
  const before = calls.length; // the cleanup's own listeners were put on through it
  proc.prependOnceListener('SIGINT', () => {});
  assert.strictEqual(calls[before], 'SIGINT', 'the wrapper the program had put there is still called for the program\'s own prepend, through ours');
  releaseAgain();
  assert.strictEqual(proc.prependListener, programs, 'and is what is there again');
});

test('a wrapper that the program puts over ours is left where it is when the cleanup is released — it keeps working, and the cleanup does not come back', () => {
  const proc = standIn();
  const release = onProcessEnd(() => {}, { process: proc });
  const ours = proc.prependListener;
  const later = function prependListener(...args) { return ours.apply(this, args); };
  proc.prependListener = later;
  release();
  assert.strictEqual(proc.prependListener, later, 'not ours to take off');
  const handler = () => {};
  proc.prependOnceListener('SIGINT', handler);
  assert.deepStrictEqual(proc.rawListeners('SIGINT').map((listener) => listener.listener || listener), [handler], 'nothing of the cleanup is put back on the list');
  assert.deepStrictEqual(listenerCounts(proc), { ...NONE, SIGINT: 1 });
});

test('a cleanup that the program removed itself — removeAllListeners — is not put back by a later prepend: the program\'s own handlers are all that is left to it', () => {
  const proc = standIn();
  onProcessEnd(() => {}, { process: proc });
  proc.removeAllListeners('SIGINT');
  const handler = () => {};
  proc.prependOnceListener('SIGINT', handler);
  assert.deepStrictEqual(proc.rawListeners('SIGINT').map((listener) => listener.listener || listener), [handler]);
});

test('a process whose bookkeeping cannot be done never fails the program\'s own call — the handler is still registered, and the cleanup still runs when the process exits', () => {
  const proc = standIn();
  const ran = [];
  onProcessEnd(() => ran.push('cleanup'), { process: proc });
  proc.rawListeners = () => { throw new Error('this stand-in has no way to list its listeners'); };
  const handler = () => {};
  assert.doesNotThrow(() => proc.prependListener('SIGINT', handler));
  assert.ok(proc.listeners('SIGINT').includes(handler));
  proc.emit('exit', 0);
  assert.deepStrictEqual(ran, ['cleanup']);
});

// Putting the cleanup back in front is two calls on the process — one takes its listener off, the other puts it on — and each is ANNOUNCED: the process emits `removeListener` as the listener goes, `newListener` as it
// is about to be added (before it is on the list). A program may watch those (to count listeners, to log them) and may do anything there, the cleanup's release included. A cleanup that was released meanwhile must STAY
// released: the release took its listeners off the process and the wrapper off the method, and a listener put back afterwards belongs to a registry that is gone, with nothing to keep it first — a one-shot handler the
// program prepends later goes in front of it, is taken off the list before it is called, and leaves it counting no handler but its own: it would end the process under the handler's shutdown.
// What the program does there, and what is left: a stand-in for the process, both platforms (the signal is delivered by `proc.emit`, as in the tests above).
function releasedFromNotification(platform, event, { registeringAgain = false } = {}) {
  const proc = standIn(platform);
  const ran = [];
  const trace = [];
  const addedAfterRelease = [];
  let released = false;
  const release = onProcessEnd(() => ran.push('cleanup'), { process: proc });
  const trigger = () => {};
  const observer = (type, listener) => {
    // `removeListener`: the cleanup's own listener is the first to come off a list of SIGINT. `newListener`: the program's trigger is the first to go on it (nothing to do yet), and the cleanup's listener the second.
    if (type !== 'SIGINT' || listener === trigger) return;
    proc.removeListener(event, observer);
    release();
    released = true;
    if (registeringAgain) onProcessEnd(() => ran.push('again'), { process: proc });
  };
  proc.on(event, observer);
  proc.on('newListener', (type, listener) => { if (type === 'SIGINT' && released) addedAfterRelease.push(listener); });
  proc.prependListener('SIGINT', trigger);
  proc.removeListener('SIGINT', trigger);
  release();
  // What was put on the list since the release, before the program prepends a handler of its own: the cleanup's listener, should it have been put back.
  const putBack = [...addedAfterRelease];
  const afterRelease = listenerCounts(proc);
  const ownsPrepend = Object.prototype.hasOwnProperty.call(proc, 'prependListener');
  proc.prependOnceListener('SIGINT', () => trace.push('the program\'s handler began its shutdown'));
  proc.emit('SIGINT', 'SIGINT');
  return { proc, ran, trace, afterRelease, ownsPrepend, putBack };
}
for (const platform of ['linux', 'win32']) {
  const where = platform === 'win32' ? 'Windows' : 'POSIX';
  for (const event of ['removeListener', 'newListener']) {
    test(`${where}: a cleanup released from a ${event} notification of the process stays released — no listener of it is left, and a one-shot handler the program prepends afterwards keeps the decision how the process ends`, () => {
      const { proc, ran, trace, afterRelease, ownsPrepend, putBack } = releasedFromNotification(platform, event);
      // From `newListener` the release is made while the listener is on its way onto the list, which is announced before it is on it: that one is taken off again; from `removeListener` nothing is put back at all.
      if (event === 'removeListener') assert.strictEqual(putBack.length, 0, 'a cleanup that was released is not put back, not even for a moment');
      assert.deepStrictEqual(afterRelease, NONE, 'the release took every listener of the cleanup off, and the wrapper was not put back after it');
      assert.strictEqual(ownsPrepend, false, 'and the process has its own prependListener again');
      assert.deepStrictEqual(trace, ['the program\'s handler began its shutdown'], 'the program\'s handler was told of the signal');
      assert.deepStrictEqual(ran, [], 'a cleanup that was released does not run');
      assert.deepStrictEqual(proc.killed, [], 'the signal is not raised again');
      assert.deepStrictEqual(proc.exited, [], 'the process is not ended: that is the handler\'s to do, when and how it chooses');
      assert.deepStrictEqual(listenerCounts(proc), NONE, 'and nothing is left on the process');
    });
  }
}

test('a cleanup released from the notification and registered AGAIN there belongs to the new registry alone — the one that was released does not put its listener back beside it', () => {
  const { proc, ran, trace, afterRelease } = releasedFromNotification('linux', 'removeListener', { registeringAgain: true });
  assert.deepStrictEqual(afterRelease, { exit: 1, SIGINT: 1, SIGTERM: 1, SIGHUP: 1, SIGBREAK: 1 }, 'one listener each: the new registry\'s, and none of the one that was released');
  assert.deepStrictEqual(trace, ['the program\'s handler began its shutdown']);
  assert.deepStrictEqual(ran, ['again'], 'the signal reached the new registry once, and its cleanup ran');
  assert.deepStrictEqual(proc.killed, [], 'the handler, not the cleanup, decides how the process ends');
  assert.deepStrictEqual(proc.exited, []);
  assert.deepStrictEqual(listenerCounts(proc), NONE, 'and the new registry took its listeners off, as a signal makes it');
});

test('a notification that FAILS while the cleanup is put back in front does not cost it its place — it is put back all the same, and the program\'s own call does not fail', () => {
  const proc = standIn();
  const ran = [];
  onProcessEnd(() => ran.push('cleanup'), { process: proc });
  proc.on('removeListener', function failing(type) {
    if (type !== 'SIGINT') return;
    proc.removeListener('removeListener', failing);
    throw new Error('an observer that fails');
  });
  const handler = () => {};
  assert.doesNotThrow(() => proc.prependListener('SIGINT', handler));
  assert.deepStrictEqual(proc.rawListeners('SIGINT').slice(1), [handler], 'the program\'s handler is registered, behind the cleanup');
  assert.strictEqual(proc.listenerCount('SIGINT'), 2);
  proc.emit('SIGINT', 'SIGINT');
  assert.deepStrictEqual(ran, ['cleanup'], 'and the cleanup runs on the signal');
});

test('a program that only WATCHES the notifications sees the cleanup taken off and put back in front of its handler, and the order is the one there would be without the watching', () => {
  const proc = standIn();
  onProcessEnd(() => {}, { process: proc });
  const [ours] = proc.rawListeners('SIGINT');
  const seen = [];
  proc.on('newListener', (type, listener) => { if (type === 'SIGINT') seen.push(['added', listener === ours ? 'cleanup' : 'handler']); });
  proc.on('removeListener', (type, listener) => { if (type === 'SIGINT') seen.push(['removed', listener === ours ? 'cleanup' : 'handler']); });
  const handler = () => {};
  proc.prependListener('SIGINT', handler);
  assert.deepStrictEqual(seen, [['added', 'handler'], ['removed', 'cleanup'], ['added', 'cleanup']], 'the handler goes on, then the cleanup comes off and goes on in front of it');
  assert.deepStrictEqual(proc.rawListeners('SIGINT'), [ours, handler]);
});

test('a handler for ANOTHER signal does not take the decision: SIGINT, which only the cleanup listens for, still ends the process', () => {
  const proc = standIn();
  proc.on('SIGTERM', () => {});
  proc.once('SIGHUP', () => {});
  onProcessEnd(() => {}, { process: proc });
  proc.emit('SIGINT', 'SIGINT');
  assert.deepStrictEqual(proc.killed, [[4242, 'SIGINT']]);
});

test('releasing every cleanup takes our listeners off and leaves the program\'s own where they were — the same functions, in the same order', () => {
  const proc = standIn();
  const own = { SIGINT: [() => {}, () => {}], SIGTERM: [() => {}], exit: [() => {}] };
  for (const [name, handlers] of Object.entries(own)) for (const handler of handlers) proc.on(name, handler);
  const release = onProcessEnd(() => {}, { process: proc });
  onProcessEnd(() => {}, { process: proc })();
  release();
  for (const [name, handlers] of Object.entries(own)) assert.deepStrictEqual(proc.listeners(name), handlers, name);
});

test('when `process.kill` refuses the signal — it is not one this platform has: SIGBREAK is a Windows signal — the process is still ended, with status 1, after the cleanups', () => {
  const proc = standIn();
  proc.kill = () => { throw Object.assign(new TypeError('Unknown signal: SIGBREAK'), { code: 'ERR_UNKNOWN_SIGNAL' }); };
  const ran = [];
  onProcessEnd(() => ran.push('cleanup'), { process: proc });
  proc.emit('SIGBREAK', 'SIGBREAK');
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

// Starts helpers/exit-cleanup-child.js — it registers a cleanup that writes `marker` — and waits until it has. `ending` says how it ends: exit | throw | release | wait (for a signal) | emit:<SIGNAL> (the child raises
// it in itself, on a later turn) | emit-now:<SIGNAL> (in the very turn that an owner with `when: 'now'` is put in place); `owner` gives it a handler of its own, and `releaseFrom` has it release the cleanup from a notification
// of the process (`removeListener` | `newListener`), as the helper's header says. `ready` is what the child said when it was ready.
async function child(t, ending, { owner, releaseFrom } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-cleanup-'));
  dirs.push(dir);
  const marker = path.join(dir, 'cleaned.txt');
  const handled = path.join(dir, 'handled.txt');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ marker, ending, owner: owner && { handled, ...owner }, releaseFrom }));
  const proc = fork(CHILD, [config], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
  return { proc, exited, marker, handled, ready: message, stderr: () => stderr };
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

// A signal the child raises in ITSELF (`process.emit`) reaches the listeners exactly as a delivered one does, and this works on every platform — including Windows, where nothing can be delivered from outside with
// `child.kill()`. What follows is the whole behavior, in a real process: the cleanup runs, and the process ends as one that nothing listens for would — BY the signal on POSIX, and on Windows with the status a
// console event gives (0xC000013A: a status of 3,221,225,786, not 1 and not clamped to 255).
for (const signal of SIGNALS.filter((name) => WINDOWS || name !== 'SIGBREAK')) {
  test(`real process: ${signal} raised in the process runs the cleanup, and the process then ends ${WINDOWS ? 'with STATUS_CONTROL_C_EXIT (0xC000013A)' : `BY ${signal}`} — as a process that had no handler would`, async (t) => {
    const run = await child(t, `emit:${signal}`);
    assert.deepStrictEqual(await run.exited, WINDOWS ? [CONTROL_C_EXIT, null] : [null, signal]);
    assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
  });
}

// A program whose own one-shot handler starts an orderly shutdown — it schedules the exit — keeps the decision: the status the process ends with is the handler's, not the cleanup's.
for (const when of ['before', 'after']) {
  test(`real process: a program whose own one-shot SIGTERM handler, registered ${when} the cleanup, begins an asynchronous shutdown keeps the decision — the cleanup runs, and the process ends with the handler's status`, async (t) => {
    const run = await child(t, 'emit:SIGTERM', { owner: { signal: 'SIGTERM', how: 'once', when, status: 9, delayMs: 50 } });
    assert.deepStrictEqual(await run.exited, [9, null], 'the program\'s own shutdown ended it, with its own status');
    assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
    assert.strictEqual(fs.readFileSync(run.handled, 'utf8'), 'handled');
  });
}

// ...and so does one the program PREPENDS after the cleanup, which puts it ahead of the cleanup's own listener: Node takes a one-shot handler off the list before it calls it, so the cleanup, if it were
// left behind it, would find no handler and end the process under the handler's shutdown. Raised in the very turn that the handler is put in place — `process.prependOnceListener('SIGINT', …)` and then
// `process.emit('SIGINT')`, with nothing between them — and on a later turn, as the operating system delivers one.
for (const how of ['prepend-once', 'prepend-self-removing']) {
  test(`real process: a ${HOW[how]} SIGINT handler that the program puts in place after the cleanup, in the very turn that it raises the signal, keeps the decision — the cleanup runs, and the process ends with the handler's status`, async (t) => {
    const run = await child(t, 'emit-now:SIGINT', { owner: { signal: 'SIGINT', how, when: 'now', status: 23, delayMs: 50 } });
    assert.deepStrictEqual(await run.exited, [23, null], 'the program\'s own shutdown ended it, with its own status — not the cleanup, with the status of a cancellation');
    assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
    assert.strictEqual(fs.readFileSync(run.handled, 'utf8'), 'handled');
  });
  test(`real process: the same on a later turn — a ${HOW[how]} SIGINT handler registered after the cleanup, and the signal raised afterwards`, async (t) => {
    const run = await child(t, 'emit:SIGINT', { owner: { signal: 'SIGINT', how, when: 'after', status: 23, delayMs: 50 } });
    assert.deepStrictEqual(await run.exited, [23, null]);
    assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
    assert.strictEqual(fs.readFileSync(run.handled, 'utf8'), 'handled');
  });
}

// A program that watches the notifications the process makes about its own listeners can release the cleanup from one of them — the one the cleanup itself causes, when it is taken off the list and put back in front of
// a handler the program prepends — and a cleanup that was released stays released: nothing of it is on the list afterwards, and the one-shot handler the program prepends next, in the very turn that it raises the
// signal, keeps the decision how the process ends. (A stale listener of the released cleanup would find no handler but its own once the one-shot handler was taken off the list, and end the process under the handler's
// shutdown: STATUS_CONTROL_C_EXIT on Windows, the signal itself elsewhere.)
for (const releaseFrom of ['removeListener', 'newListener']) {
  test(`real process: a cleanup released from a ${releaseFrom} notification stays released — no listener of it is left, and a one-shot SIGINT handler the program prepends afterwards, in the very turn that it raises the signal, ends the process with its own status`, async (t) => {
    const run = await child(t, 'emit-now:SIGINT', { owner: { signal: 'SIGINT', how: 'prepend-once', when: 'now', status: 23, delayMs: 50 }, releaseFrom });
    assert.deepStrictEqual(await run.exited, [23, null], 'the program\'s own shutdown ended the process, with its own status — not a released cleanup, with the status of a cancellation');
    assert.strictEqual(run.ready.sigint, 0, 'the process had no SIGINT listener left once the cleanup was released: none of the cleanup\'s was put back');
    assert.strictEqual(fs.readFileSync(run.handled, 'utf8'), 'handled');
    assert.strictEqual(fs.existsSync(run.marker), false, 'a cleanup that was released does not run');
  });
}

test('real process: with no handler of the program\'s in the way, the same turn changes nothing — the cleanup runs and the process ends as a process that nothing listens for does', async (t) => {
  const run = await child(t, 'emit-now:SIGINT');
  assert.deepStrictEqual(await run.exited, WINDOWS ? [CONTROL_C_EXIT, null] : [null, 'SIGINT']);
  assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
});

// A signal from OUTSIDE — a real one, delivered by the operating system — where the platform has them.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`real process: ${signal} runs the cleanup, and the process then ends BY ${signal} — the status a process that had no handler would have had`, { skip: WINDOWS && 'Windows has no signals to deliver: a signal sent to a process ends it at once, without running anything (its console events are tested below)' }, async (t) => {
    const run = await child(t, 'wait');
    run.proc.kill(signal);
    assert.deepStrictEqual(await run.exited, [null, signal]);
    assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
  });
}

test('real process: a program that has its own SIGTERM handler keeps it — the cleanup runs and the handler decides how the process ends', { skip: WINDOWS && 'Windows has no signals to deliver' }, async (t) => {
  const run = await child(t, 'wait', { owner: { signal: 'SIGTERM', how: 'on', when: 'before', status: 9 } });
  run.proc.kill('SIGTERM');
  assert.deepStrictEqual(await run.exited, [9, null], 'the program\'s own handler ended it, with its own status');
  assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
  assert.strictEqual(fs.readFileSync(run.handled, 'utf8'), 'handled');
});

for (const when of ['before', 'after']) {
  test(`real process: a program whose own one-shot SIGTERM handler, registered ${when} the cleanup, begins an asynchronous shutdown keeps the decision when the signal is delivered from outside`, { skip: WINDOWS && 'Windows has no signals to deliver' }, async (t) => {
    const run = await child(t, 'wait', { owner: { signal: 'SIGTERM', how: 'once', when, status: 9, delayMs: 50 } });
    run.proc.kill('SIGTERM');
    assert.deepStrictEqual(await run.exited, [9, null], 'the process ended by the program\'s own shutdown, not by the cleanup');
    assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
    assert.strictEqual(fs.readFileSync(run.handled, 'utf8'), 'handled');
  });
}

test('real process: and so does a one-shot SIGTERM handler that the program PREPENDS after the cleanup, when the signal is delivered from outside', { skip: WINDOWS && 'Windows has no signals to deliver' }, async (t) => {
  const run = await child(t, 'wait', { owner: { signal: 'SIGTERM', how: 'prepend-once', when: 'after', status: 9, delayMs: 50 } });
  run.proc.kill('SIGTERM');
  assert.deepStrictEqual(await run.exited, [9, null], 'the process ended by the program\'s own shutdown, not by the cleanup');
  assert.strictEqual(fs.readFileSync(run.marker, 'utf8'), 'cleaned');
  assert.strictEqual(fs.readFileSync(run.handled, 'utf8'), 'handled');
});

// --- Windows: Ctrl+C and Ctrl+Break, as the console sends them ----------------------------------------------------------------------------------------

// A real console event is the only thing that ends a Windows process "by a signal" — and the status it gives (0xC000013A) is what the cleanup's process must end with: not 1, which is all `process.kill` and
// `process.exit(1)` can give. Each scenario below is a child started in a console of its own and sent the event as the console sends it (helpers/console-event.js, one PowerShell for all of them). The CONTROL
// of each event is a child that registers nothing of ours: how Windows ends a process that nothing handles — which is what a cleanup's process has to end as. The scenarios of one event take a few seconds;
// they are run once, together, and each test reads its own.
const CONSOLE_SCENARIOS = [
  { id: 'plain', event: 'CTRL_C', config: { plain: true } },
  { id: 'cleanup', event: 'CTRL_C', config: {} },
  { id: 'once-before', event: 'CTRL_C', config: { owner: { signal: 'SIGINT', how: 'once', when: 'before', status: 23, delayMs: 50 } } },
  { id: 'once-after', event: 'CTRL_C', config: { owner: { signal: 'SIGINT', how: 'once', when: 'after', status: 23, delayMs: 50 } } },
  { id: 'prepend-once-after', event: 'CTRL_C', config: { owner: { signal: 'SIGINT', how: 'prepend-once', when: 'after', status: 23, delayMs: 50 } } },
  { id: 'persistent-before', event: 'CTRL_C', config: { owner: { signal: 'SIGINT', how: 'on', when: 'before', status: 9 } } },
  { id: 'plain', event: 'CTRL_BREAK', config: { plain: true } },
  { id: 'cleanup', event: 'CTRL_BREAK', config: {} },
  { id: 'once-before', event: 'CTRL_BREAK', config: { owner: { signal: 'SIGBREAK', how: 'once', when: 'before', status: 23, delayMs: 50 } } },
  { id: 'prepend-once-after', event: 'CTRL_BREAK', config: { owner: { signal: 'SIGBREAK', how: 'prepend-once', when: 'after', status: 23, delayMs: 50 } } },
];
let consoleRuns;
function inConsoles() {
  if (!consoleRuns) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-cleanup-console-'));
    dirs.push(dir);
    const items = CONSOLE_SCENARIOS.map((scenario, index) => {
      const base = path.join(dir, String(index));
      const files = { marker: `${base}.cleaned`, handled: `${base}.handled`, ready: `${base}.ready`, config: `${base}.json` };
      const owner = scenario.config.owner && { handled: files.handled, ...scenario.config.owner };
      fs.writeFileSync(files.config, JSON.stringify({ marker: files.marker, ending: 'wait', ready: files.ready, ...scenario.config, owner }));
      return { ...scenario, files };
    });
    consoleRuns = runInConsoles(items.map((item) => ({ event: item.event, script: CHILD, args: [item.files.config], ready: item.files.ready }))).then((results) => {
      const byName = {};
      items.forEach((item, index) => { byName[`${item.id}/${item.event}`] = { ...results[index], files: item.files }; });
      return byName;
    });
  }
  return consoleRuns;
}
const KEYS = { CTRL_C: 'Ctrl+C', CTRL_BREAK: 'Ctrl+Break' };
const SIGNAL_OF = { CTRL_C: 'SIGINT', CTRL_BREAK: 'SIGBREAK' };

// The result of `id` for `event`, and the control's; null (the test is skipped, with the reason) when this machine cannot send the event, or its control — a child that registers nothing — does not end as a cancelled
// process: a console that does not take events says nothing about the cleanup. The answer is the one every console test gives (helpers/console-event.js `controlProblem`): the machine's unsuitability skips, a defect of the
// sender or of the child fails, and so does a scenario that is not delivered once its control was.
async function consoleRun(t, id, event) {
  const runs = await inConsoles();
  const control = runs[`plain/${event}`];
  const problem = controlProblem(control, KEYS[event]);
  if (problem) {
    t.skip(problem);
    return null;
  }
  const run = runs[`${id}/${event}`];
  assert.deepStrictEqual([run.delivered, run.exited, run.error], [true, true, null], JSON.stringify({ ...run, files: undefined }));
  return { run, control };
}

for (const event of ['CTRL_C', 'CTRL_BREAK']) {
  test(`real ${KEYS[event]} (Windows console event): the cleanup runs, and the process ends exactly as a process that nothing listens for does — with STATUS_CONTROL_C_EXIT, not with status 1`, { skip: !WINDOWS && 'console events are a Windows thing: POSIX has signals, tested above' }, async (t) => {
    const answer = await consoleRun(t, 'cleanup', event);
    if (!answer) return;
    assert.strictEqual(answer.run.status, answer.control.status, 'the same status as the control');
    assert.strictEqual(fs.readFileSync(answer.run.files.marker, 'utf8'), 'cleaned');
  });
}

for (const [id, what, status] of [
  ['once-before', 'one-shot', 23],
  ['once-after', 'one-shot', 23],
  ['prepend-once-after', 'one-shot PREPENDED', 23],
  ['persistent-before', 'persistent', 9],
]) {
  test(`real Ctrl+C (Windows console event): a program whose own ${what} SIGINT handler is registered ${id.endsWith('before') ? 'before' : 'after'} the cleanup keeps the decision — the cleanup runs, and the process ends with the handler's status ${status}`, { skip: !WINDOWS && 'console events are a Windows thing' }, async (t) => {
    const answer = await consoleRun(t, id, 'CTRL_C');
    if (!answer) return;
    assert.strictEqual(answer.run.status, status, 'ended by the program\'s own handler, not by the cleanup');
    assert.strictEqual(fs.readFileSync(answer.run.files.marker, 'utf8'), 'cleaned');
    assert.strictEqual(fs.readFileSync(answer.run.files.handled, 'utf8'), 'handled');
  });
}

for (const id of ['once-before', 'prepend-once-after']) {
  test(`real Ctrl+Break (Windows console event): a program whose own one-shot SIGBREAK handler is registered ${id.endsWith('before') ? 'before' : 'after (and PREPENDED)'} the cleanup keeps the decision too`, { skip: !WINDOWS && 'console events are a Windows thing' }, async (t) => {
    const answer = await consoleRun(t, id, 'CTRL_BREAK');
    if (!answer) return;
    assert.strictEqual(answer.run.status, 23);
    assert.strictEqual(fs.readFileSync(answer.run.files.marker, 'utf8'), 'cleaned');
    assert.strictEqual(fs.readFileSync(answer.run.files.handled, 'utf8'), 'handled');
  });
}

// A notification that throws makes the wrapper put the cleanup's listener back in a recovery step, and that add is announced too (`newListener`, before
// the listener is on the list). A program that releases the cleanup there must find it released: a listener put back for a registry that is gone would
// stay first for nobody, count no handler of the program's one-shot owner, and end the process under that owner's own shutdown.
for (const kind of ['remove-throws', 'new-throws']) {
  for (const platform of ['linux', 'darwin', 'win32']) {
    test(`${platform}: a cleanup released while its listener is put back after a notification that threw (${kind}) stays released, and the program's one-shot owner keeps its shutdown`, () => {
      const { EventEmitter } = require('node:events');
      const proc = new EventEmitter();
      const trace = [];
      Object.assign(proc, { platform, pid: 736, exit: (status) => trace.push(['exit', status]), kill: (_, signal) => trace.push(['kill', signal]) });
      const release = onProcessEnd(() => trace.push(['cleanup']), { process: proc });
      const [ours] = proc.rawListeners('SIGINT');
      let attempts = 0;
      if (kind === 'remove-throws') {
        proc.on('removeListener', function failing(type, listener) {
          if (type !== 'SIGINT' || listener !== ours) return;
          proc.removeListener('removeListener', failing);
          throw new Error('synthetic observer failure');
        });
      }
      proc.on('newListener', function observed(type, listener) {
        if (type !== 'SIGINT' || listener !== ours) return;
        attempts += 1;
        if (kind === 'new-throws' && attempts === 1) throw new Error('synthetic observer failure');
        proc.removeListener('newListener', observed);
        release();
      });
      const trigger = () => {};
      proc.prependListener('SIGINT', trigger);
      proc.removeListener('SIGINT', trigger);
      release();
      assert.strictEqual(proc.listenerCount('SIGINT'), 0, 'no listener of the released cleanup is left on the process');
      assert.ok(!Object.hasOwn(proc, 'prependListener'), 'and the wrapper is off the process');
      proc.prependOnceListener('SIGINT', () => trace.push(['owner-starts-shutdown']));
      proc.emit('SIGINT', 'SIGINT');
      assert.deepStrictEqual(trace, [['owner-starts-shutdown']], 'the owner is told, and nothing ends the process under it');
    });
  }
}
