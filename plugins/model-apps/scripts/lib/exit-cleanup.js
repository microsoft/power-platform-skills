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
// A signal: Node does not end the process for a signal it has a listener for, so once the cleanups have run the listeners THIS module added are taken off and — when nothing else listens for that
// signal — the signal is raised again, at this process, so that the default action acts: the process ends BY the signal, as it would have had nothing been listening (a parent sees the signal, not an exit
// status). When something else does listen, it is told as it always was and decides how the process ends. Windows has no signals to raise: `process.kill` there ends the process with status 1 for SIGINT,
// SIGTERM and SIGKILL and answers ENOSYS for the others (SIGHUP, SIGBREAK), where the process is ended with status 1 all the same.
// See: https://nodejs.org/api/process.html#signal-events and https://nodejs.org/api/process.html#processkillpid-signal

// SIGHUP is a closed terminal (on Windows, a closed console window, which ends the process about ten seconds later whatever it does); SIGBREAK is Ctrl+Break on Windows and is never delivered elsewhere, where
// listening for it is harmless.
const SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);

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
  if (registries.get(proc) === registry) registries.delete(proc);
}

function endAs(proc, signal) {
  try {
    proc.kill(proc.pid, signal);
  } catch {
    // The platform has no such signal to send (Windows, for SIGHUP and SIGBREAK): the process still ends.
    proc.exit(1);
  }
}

function install(proc) {
  const registry = { cleanups: new Set(), onExit: null, onSignal: new Map() };
  registry.onExit = () => runAll(registry);
  proc.on('exit', registry.onExit);
  for (const signal of SIGNALS) {
    const listener = () => {
      runAll(registry);
      uninstall(proc, registry);
      // `listenerCount` after ours is off: a program with a handler of its own for this signal keeps it, and with it the decision how the process ends.
      if (proc.listenerCount(signal) === 0) endAs(proc, signal);
    };
    registry.onSignal.set(signal, listener);
    proc.on(signal, listener);
  }
  registries.set(proc, registry);
  return registry;
}

/**
 * Registers `cleanup` — a synchronous function — to run if the process ends while it is registered. Returns `release()`, which takes it off again (safe to call twice, and after the cleanup ran): call it
 * when the work the cleanup is for is done and has cleaned up after itself.
 * @param {() => void} cleanup
 * @param {{ process?: object }} [deps] - test seam: a stand-in for `process` (`on`, `removeListener`, `listenerCount`, `kill`, `exit`, `pid`)
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
