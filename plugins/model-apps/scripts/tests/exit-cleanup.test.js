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
const { runInConsoles } = require('./helpers/console-event.js');

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
// to be counted — and a program that began an orderly shutdown in it (the usual use of `process.once('SIGINT', …)`) would be ended under its feet. Whichever was registered first.
const HOW = Object.freeze({ on: 'persistent', once: 'one-shot', 'self-removing': 'self-removing' });
function registerOwner(proc, signal, how, heard) {
  const owner = function owner() {
    heard.push(how);
    if (how === 'self-removing') proc.removeListener(signal, owner);
  };
  if (how === 'once') proc.once(signal, owner);
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
  assert.deepStrictEqual(listenerCounts(proc), { ...NONE, [signal]: how === 'on' ? 1 : 0 }, 'our listeners are off, and nothing but the program\'s own is left');
  if (how === 'on') assert.deepStrictEqual(proc.listeners(signal), [owner], 'a persistent handler is still there, the same function');
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
// it in itself); `owner` gives it a handler of its own, as the helper's header says.
async function child(t, ending, { owner } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-cleanup-'));
  dirs.push(dir);
  const marker = path.join(dir, 'cleaned.txt');
  const handled = path.join(dir, 'handled.txt');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ marker, ending, owner: owner && { handled, ...owner } }));
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
  { id: 'persistent-before', event: 'CTRL_C', config: { owner: { signal: 'SIGINT', how: 'on', when: 'before', status: 9 } } },
  { id: 'plain', event: 'CTRL_BREAK', config: { plain: true } },
  { id: 'cleanup', event: 'CTRL_BREAK', config: {} },
  { id: 'once-before', event: 'CTRL_BREAK', config: { owner: { signal: 'SIGBREAK', how: 'once', when: 'before', status: 23, delayMs: 50 } } },
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

// The result of `id` for `event`, and the control's; null (the test is skipped) when this environment could not deliver the event to its control — a console that does not take events says nothing about the cleanup.
async function consoleRun(t, id, event) {
  const runs = await inConsoles();
  const control = runs[`plain/${event}`];
  if (!control.delivered || !control.exited) {
    t.skip(`this environment could not deliver ${KEYS[event]} to a console child that registers nothing (${JSON.stringify({ ...control, files: undefined })}), so it cannot say how the cleanup's process ends`);
    return null;
  }
  assert.strictEqual(control.status, CONTROL_C_EXIT, `the control: Windows ends a process that nothing handles with STATUS_CONTROL_C_EXIT, however ${KEYS[event]} reached it`);
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

test('real Ctrl+Break (Windows console event): a program whose own one-shot SIGBREAK handler is registered before the cleanup keeps the decision too', { skip: !WINDOWS && 'console events are a Windows thing' }, async (t) => {
  const answer = await consoleRun(t, 'once-before', 'CTRL_BREAK');
  if (!answer) return;
  assert.strictEqual(answer.run.status, 23);
  assert.strictEqual(fs.readFileSync(answer.run.files.marker, 'utf8'), 'cleaned');
  assert.strictEqual(fs.readFileSync(answer.run.files.handled, 'utf8'), 'handled');
});
