'use strict';
// A child process for exit-cleanup.test.js: it registers a cleanup that writes a marker, says it is ready, and then ends — or waits to be signalled — as its configuration says.
//
//   node exit-cleanup-child.js <config.json>
//     marker   the cleanup writes this file (the text `cleaned`)
//     ending   exit     process.exit(7)
//              throw    an error nothing catches
//              release  the cleanup is released, and the process ends normally
//              wait     stays alive until it is signalled
//              emit:S   raises the signal S in the process itself (`process.emit`), on a later turn of the event loop — as the operating system delivers one: what a signal does to the process's listeners, on a
//                       platform that cannot deliver one from outside
//              emit-now:S  the same, in the very turn that the owner (below, `when: now`) is registered: a program that puts a handler in place and raises the signal at once
//     owner    when given, the program has a handler of its own for `owner.signal`, which writes the file `owner.handled` and ends the process with `owner.status` — at once, or `owner.delayMs` later (an
//              asynchronous shutdown). It is registered `owner.when` the cleanup (before | after | now: once the child has said it is ready, in the turn it raises the signal), with `process.on` or `process.once`
//              (`owner.how`), or — `prepend`, `prepend-once` — with `process.prependListener` / `process.prependOnceListener`, which put it AHEAD of every listener that is there, the cleanup's included. A handler that
//              is `self-removing` or `prepend-self-removing` takes itself off the list as soon as it is called.
//     plain    registers no cleanup at all: the control, the process as it is when nothing of ours listens
//     ready    where the child says it is ready: a file, written whole by a rename. A child that has no IPC channel — one started in a console of its own — has no other way; with none given the
//              message goes over the channel.
const fs = require('node:fs');
const { onProcessEnd } = require('../../lib/exit-cleanup.js');

const { marker, ending, owner, ready, plain } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

function registerOwner() {
  const handler = () => {
    fs.writeFileSync(owner.handled, 'handled');
    if (owner.how.endsWith('self-removing')) process.removeListener(owner.signal, handler);
    if (owner.delayMs) setTimeout(() => process.exit(owner.status), owner.delayMs);
    else process.exit(owner.status);
  };
  if (owner.how === 'once') process.once(owner.signal, handler);
  else if (owner.how === 'prepend-once') process.prependOnceListener(owner.signal, handler);
  else if (owner.how.startsWith('prepend')) process.prependListener(owner.signal, handler);
  else process.on(owner.signal, handler);
}

if (owner && owner.when === 'before') registerOwner();
const release = plain ? () => {} : onProcessEnd(() => fs.writeFileSync(marker, 'cleaned'));
if (owner && owner.when === 'after') registerOwner();
const hold = setInterval(() => {}, 1000);

function announce(then) {
  const message = { kind: 'ready', cleanedYet: fs.existsSync(marker), pid: process.pid };
  if (!ready) return process.send(message, then);
  fs.writeFileSync(`${ready}.new`, JSON.stringify(message));
  fs.renameSync(`${ready}.new`, ready);
  return then();
}

announce(() => {
  if (owner && owner.when === 'now') registerOwner();
  if (ending === 'exit') process.exit(7);
  if (ending === 'throw') setImmediate(() => { throw new Error('an error nothing catches'); });
  if (ending.startsWith('emit:')) setImmediate(() => process.emit(ending.slice('emit:'.length), ending.slice('emit:'.length)));
  if (ending.startsWith('emit-now:')) process.emit(ending.slice('emit-now:'.length), ending.slice('emit-now:'.length));
  if (ending === 'release') {
    release();
    clearInterval(hold);
    if (process.connected) process.disconnect();
  }
});
