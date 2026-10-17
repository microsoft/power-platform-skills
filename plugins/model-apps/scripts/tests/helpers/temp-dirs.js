'use strict';
// Temporary folders for a test file, removed when the file's tests are done.
//
// node --test runs every test file in its own process, several at once, and a folder a test leaves in the OS temp
// folder stays there for good. A full run of this suite used to leave about 260 of them, so a developer's temp folder
// grew by hundreds of thousands of entries. scripts/run-tests.js now runs the suite in a temporary folder of its own and
// fails when anything is left in it, so a test must remove what it makes; this is the shared way to do that.
//
// The removal is registered as a root `after` hook of the test file that loads this module, so a folder can outlive the
// test that made it (some tests hand a folder to the next), but never the file. Require this module at the TOP of a test
// file: node:test attaches a hook to the test that is running when the hook is registered, so a hook registered from
// inside a test would run when that one test ends, and the folders made by later tests would be left behind.
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const made = [];

test.after(() => {
  for (const dir of made.splice(0)) {
    // On Windows a folder can refuse removal for a moment after a child process that used it exits (EBUSY, EPERM,
    // ENOTEMPTY while a scanner or a detached hook still holds a file in it). Node retries exactly those errors, with
    // a back-off that grows by retryDelay each time, so these settings wait up to about five seconds in all.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * A new, empty folder under the OS temp folder, removed after the last test of the file that loaded this module.
 * @param {string} prefix - the start of the folder's name (mkdtemp adds six random characters)
 * @returns {string} the folder's path
 */
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

module.exports = { makeTempDir };
