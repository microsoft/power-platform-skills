'use strict';
// A cleanup that runs when the process ends in a way JavaScript can see — `process.exit`, an exit through an error nothing catches, and the termination signals — and not otherwise.
//
// Why: a script that makes a folder for itself (the copy of a settings file that `pac solution import` is given, which holds values the maker has not shared) removes it when the work is done, and
// the work's own `finally` covers a failure. What a `finally` does not cover is the process being ended from outside while the work is still going — Ctrl+C, a closed terminal, a CI cancellation, a
// `process.exit` somewhere else — and for those the cleanup is registered here for as long as the work lasts.
//
// What it cannot cover: a process that is KILLED (SIGKILL on POSIX, TerminateProcess on Windows, which is also what `process.kill`, `child.kill()` and the end of a job object do there) runs no
// JavaScript at all. Nothing registered here runs then, and whatever the process had made stays where it is: a leftover from a killed run is for a later run, or a sweep of the temporary folder, to find.
//
// Synchronous on purpose: an 'exit' listener cannot wait for anything, and a signal handler that did would be racing the next signal. Every cleanup runs once, in the order registered, and one that throws
// does not stop the others — the process is ending, and there is nobody left to tell.
//
// A signal: Node does not end the process for a signal it has a listener for, so once the cleanups have run the listeners THIS module added are taken off — only ours, by identity: the program's own are neither
// removed nor replaced — and, when nothing else listens for that signal, the process ends as it would have had nothing been listening:
//   POSIX    the signal is raised again, at this process, so that the default action acts: the process ends BY the signal (a parent sees the signal, not an exit status).
//   Windows  there are no signals to raise: `process.kill` there is TerminateProcess, which ends the process with status 1 whatever the signal, and answers ENOSYS for SIGHUP and SIGBREAK. What a console
//            event (Ctrl+C, Ctrl+Break, a closed console window) does to a process that nothing handles is end it with STATUS_CONTROL_C_EXIT, 0xC000013A (3221225786) — the default handler of every
//            console process calls ExitProcess, and a Node process with no listener ends with that status for both Ctrl+C and Ctrl+Break, as measured — and that is the status the process ends with here, so
//            that whoever started it can still tell a run that was cancelled from one that failed.
// When something else does listen, it is told as it always was and decides how the process ends (how that is found out is explained in `install`, and how it stays right when the program prepends a handler of its own
// later, in `keepFirst`).
// See: https://nodejs.org/api/process.html#signal-events, https://nodejs.org/api/process.html#processkillpid-signal, https://learn.microsoft.com/windows/console/setconsolectrlhandler (the default handler
// calls ExitProcess) and https://learn.microsoft.com/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55 (the status, "{Application Exit by CTRL+C}")

// SIGHUP is a closed terminal (on Windows, a closed console window, which ends the process about ten seconds later whatever it does); SIGBREAK is Ctrl+Break on Windows and is never delivered elsewhere, where
// listening for it is harmless.
const SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);

// What Windows ends a process with when a console event reached it and nothing handled it.
const STATUS_CONTROL_C_EXIT = 0xC000013A;

// The registry of each process-like object (the real `process`, or a test's stand-in): the cleanups registered on it, and the listeners this module put there.
const registries = new Map();

function runAll(registry) {
  for (const cleanup of [...registry.cleanups]) {
    registry.cleanups.delete(cleanup);
    try {
      cleanup();
    } catch {
      // The process is ending: a cleanup that fails has nobody to tell, and must not keep the others from running.
    }
  }
}

function uninstall(proc, registry) {
  proc.removeListener('exit', registry.onExit);
  for (const [signal, listener] of registry.onSignal) proc.removeListener(signal, listener);
  registry.releasePrepend();
  if (registries.get(proc) === registry) registries.delete(proc);
}

// Ours has to be FIRST in line for a signal: the count that decides who ends the process (in `install`) is only right if it is made before any of the program's handlers has run, because Node takes a one-shot handler
// off the list just before it calls it and a handler can take itself off. Appending a handler leaves ours first; PREPENDING one does not, and a program may do it whenever it likes — `process.prependOnceListener('SIGINT', shutdown)`
// is how a one-shot handler is put in front of the others — which would leave ours behind a handler that is gone by the time ours looks, with nothing to count, and the process ended under the handler's shutdown.
// A listener of the program's cannot be kept from going in front, and `newListener` cannot put ours back in time: it is emitted BEFORE the listener is added, and a signal can be raised (`process.emit`) in the very turn
// that the handler is put in place. So the process's own `prependListener` — which `prependOnceListener` calls (`this.prependListener(…)`), so one wrapper sees both — is wrapped for as long as the registry is installed:
// once the program's listener is on the list, ours is taken off and put in front of it again, before the program's call returns. Only ours is moved (a listener of the program's is never removed, replaced or put
// anywhere but where the program put it, relative to its own others), and a cleanup that the program took off the list itself (`removeAllListeners`) is not put back.
// The wrapper is the process's property while the registry lasts and is taken off with it; if the program has put a wrapper of its own over ours by then, that one stays, and ours — in its chain — does nothing once the
// registry is gone. The program's own call never fails for this bookkeeping. What is not seen: a listener put on by a call that goes round the process's own method —
// `EventEmitter.prototype.prependListener.call(process, …)`, or a reference to `process.prependListener` kept from before the cleanup was registered — which is not what `process.prependOnceListener` or a call on `process` is.
// Taking ours off and putting it back are each ANNOUNCED — the process emits `removeListener` as ours goes, and `newListener` before ours is on the list — and whatever listens may do anything there, the cleanup's release
// included: it takes ours and this wrapper off the process (`uninstall`), and a registry of a later `onProcessEnd` may already be in their place. A cleanup that was released meanwhile stays released: its listener put back
// would belong to a registry that is gone, with nothing to keep it first — a one-shot handler the program prepends next goes in front of it, is taken off the list before it is called, and leaves it counting no handler
// but its own, so that it ends the process under that handler's shutdown, a cleanup nobody is waiting for.
// So what is on the process is settled once both calls are made, whatever they did: ours is on it if its registry is still the process's, and is not if it is not — also when a notification threw, unless `newListener` keeps
// throwing, which keeps ours off the list (the event is emitted before the listener is added) and cannot be helped from here.
function keepFirst(proc, registry) {
  const previous = Object.getOwnPropertyDescriptor(proc, 'prependListener');
  const original = proc.prependListener;
  function prependListener(...args) {
    const result = original.apply(this, args);
    try {
      const [type, listener] = args;
      const ours = this === proc && registries.get(proc) === registry ? registry.onSignal.get(type) : undefined;
      if (ours && listener !== ours && proc.rawListeners(type).indexOf(ours) > 0) {
        const released = () => registries.get(proc) !== registry || registry.onSignal.get(type) !== ours;
        try {
          proc.removeListener(type, ours);
          if (!released()) original.call(proc, type, ours);
        } finally {
          if (released()) proc.removeListener(type, ours);
          else if (!proc.rawListeners(type).includes(ours)) original.call(proc, type, ours);
        }
      }
    } catch {
      // The order could not be kept — the cleanup may then find fewer handlers than there are, as it did before this wrapper — but the program's own call has been made and must not fail for it.
    }
    return result;
  }
  Object.defineProperty(proc, 'prependListener', { value: prependListener, writable: true, configurable: true, enumerable: false });
  return function releasePrepend() {
    if (proc.prependListener !== prependListener) return;
    if (previous) Object.defineProperty(proc, 'prependListener', previous);
    else delete proc.prependListener;
  };
}

function endAs(proc, signal) {
  if (proc.platform === 'win32') {
    // Not `proc.kill`: on Windows that is TerminateProcess (status 1), which is how a failure ends, not a cancellation.
    proc.exit(STATUS_CONTROL_C_EXIT);
    return;
  }
  try {
    proc.kill(proc.pid, signal);
  } catch {
    // The platform has no such signal to send (SIGBREAK is Windows's): the process still ends.
    proc.exit(1);
  }
}

function install(proc) {
  const registry = { cleanups: new Set(), onExit: null, onSignal: new Map(), releasePrepend: null };
  registry.onExit = () => runAll(registry);
  proc.on('exit', registry.onExit);
  for (const signal of SIGNALS) {
    const listener = () => {
      // Counted BEFORE anything runs, while ours — first in line, see below — is the only listener of this delivery that has been called. Node takes a one-shot listener (`process.once`) off the list just
      // before it calls it, and a listener can take itself off, so a count made after the program's own handler had run would not see it: a program that began an orderly shutdown there would have the
      // process ended under it. Ours is still on the list, hence the one less.
      const others = proc.listenerCount(signal) - 1;
      runAll(registry);
      uninstall(proc, registry);
      // A program with a handler of its own for this signal keeps it, and with it the decision how the process ends.
      if (others === 0) endAs(proc, signal);
    };
    registry.onSignal.set(signal, listener);
    // First in line, so that the count above sees every listener this delivery will call, whichever was registered first: the program's own keep their order, after ours. And it STAYS first: a listener the
    // program prepends later is put behind ours again (keepFirst).
    proc.prependListener(signal, listener);
  }
  registry.releasePrepend = keepFirst(proc, registry);
  registries.set(proc, registry);
  return registry;
}

/**
 * Registers `cleanup` — a synchronous function — to run if the process ends while it is registered. Returns `release()`, which takes it off again (safe to call twice, and after the cleanup ran): call it
 * when the work the cleanup is for is done and has cleaned up after itself.
 * @param {() => void} cleanup
 * @param {{ process?: object }} [deps] - test seam: a stand-in for `process` (`platform`, `pid`, `on`, `prependListener`, `removeListener`, `listenerCount`, `rawListeners`, `kill`, `exit`)
 * @returns {() => void}
 */
function onProcessEnd(cleanup, { process: proc = process } = {}) {
  const registry = registries.get(proc) || install(proc);
  registry.cleanups.add(cleanup);
  return function release() {
    registry.cleanups.delete(cleanup);
    if (registry.cleanups.size === 0 && registries.get(proc) === registry) uninstall(proc, registry);
  };
}

module.exports = { onProcessEnd, SIGNALS };
