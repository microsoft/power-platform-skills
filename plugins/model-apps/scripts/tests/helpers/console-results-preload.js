'use strict';
// `node --require` for console-test-skips.test.js: it puts a stand-in where `runInConsoles` of helpers/console-event.js is, so that the console tests of a test file run — and answer — as if this machine's consoles were the
// kind CONSOLE_RESULTS names, and NOTHING sends a console event. A test file takes `runInConsoles` from the helper's exports when it loads, which is after a preload.
//   attach-denied  every scenario fails to attach to its child's console (the operating system's words, in PowerShell's wrapper for what a .NET method throws)
//   constrained    the PowerShell is in a constrained language mode, and cannot compile the sender
//   shared         the sender refuses every scenario: the child's console is shared with another process
//   wrong-status   every scenario was sent the event, and its child ended with status 1 — which is not what a cancellation ends with
//   defect         the sender explains nothing: the child was never ready
const path = require('node:path');

const helper = require(path.resolve(__dirname, 'console-event.js'));

const RESULTS = {
  'attach-denied': { delivered: false, exited: false, status: null, error: 'Exception calling "Send" with "2" argument(s): "The handle is invalid"' },
  constrained: { delivered: false, exited: false, status: null, error: 'this PowerShell is in ConstrainedLanguage language mode, which does not allow the helper that sends console events' },
  shared: { delivered: false, exited: false, status: null, error: 'Exception calling "Send" with "2" argument(s): "the child\'s console is shared with another process: no event was sent"' },
  'wrong-status': { delivered: true, exited: true, status: 1, error: null },
  defect: { delivered: false, exited: false, status: null, error: 'the child ended before it was ready' },
};

const result = RESULTS[process.env.CONSOLE_RESULTS];
if (!result) throw new Error(`CONSOLE_RESULTS must be one of ${Object.keys(RESULTS).join(', ')}`);
helper.runInConsoles = async (scenarios) => scenarios.map(() => ({ ...result }));
