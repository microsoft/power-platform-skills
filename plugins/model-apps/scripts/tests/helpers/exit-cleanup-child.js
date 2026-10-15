'use strict';
// A child process for exit-cleanup.test.js: it registers a cleanup that writes `marker`, says it is ready over the IPC channel, and then ends — or waits to be signalled — as `ending` says.
//
//   node exit-cleanup-child.js <marker> <ending> [<handled>]
//     ending   exit     process.exit(7)
//              throw    an error nothing catches
//              release  the cleanup is released, and the process ends normally
//              wait     stays alive until it is signalled
//     handled  when given, the program has a SIGTERM handler of its own — registered BEFORE the cleanup — that writes this file and exits with status 9
const fs = require('node:fs');
const { onProcessEnd } = require('../../lib/exit-cleanup.js');

const [marker, ending, handled] = process.argv.slice(2);
if (handled) process.on('SIGTERM', () => { fs.writeFileSync(handled, 'handled'); process.exit(9); });
const release = onProcessEnd(() => fs.writeFileSync(marker, 'cleaned'));
const hold = setInterval(() => {}, 1000);

process.send({ kind: 'ready', cleanedYet: fs.existsSync(marker) }, () => {
  if (ending === 'exit') process.exit(7);
  if (ending === 'throw') setImmediate(() => { throw new Error('an error nothing catches'); });
  if (ending === 'release') {
    release();
    clearInterval(hold);
    process.disconnect();
  }
});
