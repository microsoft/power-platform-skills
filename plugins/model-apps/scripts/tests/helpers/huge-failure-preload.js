'use strict';
// Loaded with `node --require` ahead of a script, for tests/printers-whole-before-exit.test.js: makes a script's OWN failure printers print a text of
// HUGE_FAILURE_SIZE characters — with no command line that long (Windows allows 32,767 characters, Linux 128 KiB per argument):
//   HUGE_FAILURE=flag   validateFlags (lib/dataverse-auth.js) answers every call with a message that long, which each script prints as its usage error
//                       (check-auth.js as the message of its usage blocker, on stdout);
//   HUGE_FAILURE=throw  parseArgs throws an error with that message, which a script whose main rejects prints from its last-resort handler.
// Everything else is the real module, and the code that prints the text and ends the process is the script's own. A test requires this file for
// hugeFailureText (HUGE_FAILURE is not set in the test's own process, so nothing is replaced there).
const path = require('node:path');

// The text, recognisable at both ends so that a test can tell a whole one from one cut short.
function hugeFailureText(kind, size) {
  return `${kind}-failure<${'0123456789'.repeat(Math.ceil(size / 10)).slice(0, size)}>`;
}

module.exports = { hugeFailureText };

if (process.env.HUGE_FAILURE) {
  const target = require.resolve(path.join(__dirname, '..', '..', 'lib', 'dataverse-auth.js'));
  const real = require(target);
  const kind = process.env.HUGE_FAILURE;
  const text = hugeFailureText(kind, Number(process.env.HUGE_FAILURE_SIZE || 0));
  // A script takes its helpers from the module cache when it is loaded, so it is handed this object.
  require.cache[target].exports = {
    ...real,
    ...(kind === 'flag' ? { validateFlags: () => text } : {}),
    ...(kind === 'throw' ? { parseArgs: () => { throw new Error(text); } } : {}),
  };
}
