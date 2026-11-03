'use strict';
// A temp folder of the test file's own. Requiring this module points TEMP, TMP and TMPDIR at a new, empty folder inside the temp folder the
// process was given (the suite's own, from scripts/run-tests.js) for the rest of the process, so that os.tmpdir() — and with it the folder
// lib/temp-workspace.js keeps the plugin's throwaway workspaces in, `<temp>/power-platform-skills-model-apps` — belongs to this test file alone.
//
// WHY. node --test runs every test file in a process of its own, many at once, and run-tests.js gives them all ONE temp folder, so every process
// that makes a throwaway workspace makes it in the same plugin folder, and every such process removes that folder when it ends with nothing left
// in it (lib/temp-workspace.js, THE END OF A RUN). Windows keeps a folder that is being removed until the last handle on it closes, and refuses a
// new entry in it meanwhile; makeTempWorkspace waits for that (WAITS_MS, about 0.8 s in all) and then makes the workspace in the plain temp folder
// instead, as designed (a busy plugin folder is never a reason for a run to fail), and does not ask that folder again for the rest of the process.
// Under load the wait ran out, and a test that checks WHERE a workspace is made — in the plugin's folder, recorded, under the run's pid — failed
// although the code did what it promises: verify's workspace was `<temp>/verify-<random>`, and the settings copy's work folder was not asked for
// in the plugin's folder at all, in that test and in the next. With a temp folder of its own, no other process makes or removes this one's
// plugin folder. Every test file that checks where a workspace is made in its own process requires this module. (Measured since, the commoner way
// a workspace went to the plain temp folder there was another: on Windows judging the plugin's folder takes about a second, and the ends of other
// processes kept removing it under the judgement until the maker ran out of attempts. A run now holds the folder while it judges it
// (lib/temp-workspace.js, A RUN HOLDS THE FOLDER), and this module still keeps what such a test checks free of every other process.)
//
// Require it at the TOP of the test file, before anything reads os.tmpdir(), so that a path the file works out when it loads is inside the folder
// too. A child process that a test starts with this process's environment shares the folder, as it shared the suite's before.
//
// THE END. The folder is removed when the process ends — after lib/temp-workspace.js has removed the workspaces this process made, and then the
// plugin's folder: the removal is registered from the file's `after` hook, so it runs after every `exit` listener the tests' workspaces registered —
// and only if nothing is left in it: `rmdir` takes an empty folder and nothing else. A test that leaves anything behind leaves this folder in the
// suite's temp folder, where the runner's check names it (`own-<letters>-<hash>-<random>`, below) and fails the run.
//
// THE NAME is short, and bounded whatever the test file is called. Every workspace a test makes is two levels below this folder, and Windows refuses
// fs.mkdtempSync a folder whose whole path is 248 characters or more (measured on Node 20 and 22: 247 is made, 248 is ENAMETOOLONG — MAX_PATH less
// room for an 8.3 name, https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation). A name holding the whole file name took 51 of
// them for `solution-settings-real-bundle.test.js` (measured): under a temp folder of 134 characters — long, but one the suite can use — the settings
// copy's work folder no longer fit, went to the plain temp folder, and the test that checks where it is made failed. So the name is `own-`, the first
// letter of each word of the file's name (at most six), four hex digits of a hash of the whole name, and mkdtemp's six characters:
// `solution-settings-real-bundle.test.js` is `own-ssrb-<4 hex>-AbC123`, 22 characters at most, so this folder costs a workspace path 23 characters at
// most. The letters say which file it was, the hash tells two files with the same letters apart, and a file's name is the same on every run.
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// os.tmpdir() reads TEMP, then TMP, on Windows and TMPDIR on macOS and Linux (https://nodejs.org/api/os.html#ostmpdir); run-tests.js sets all three.
const NAMES = ['TEMP', 'TMP', 'TMPDIR'];
// On Windows a folder whose last entry was just removed can refuse its own removal for a moment (a scanner still holds the entry): the same
// short waits lib/temp-workspace.js gives a folder that is being removed. Elsewhere a removal is not refused for a moment, and nothing waits.
const WAITS_MS = [25, 50, 100, 200, 400];
const pauseSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// `solution-settings-real-bundle.test.js` → `own-ssrb-<4 hex>-`: the words are the runs of letters and digits before `.test.js`.
const testFile = require.main && require.main.filename ? path.basename(require.main.filename) : 'test';
const letters = testFile.replace(/(?:\.test)?\.[cm]?js$/, '').split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word[0].toLowerCase()).join('').slice(0, 6) || 't';
const hash = crypto.createHash('sha256').update(testFile).digest('hex').slice(0, 4);
const ownTemp = fs.mkdtempSync(path.join(os.tmpdir(), `own-${letters}-${hash}-`));
for (const name of NAMES) process.env[name] = ownTemp;
if (os.tmpdir() !== ownTemp) throw new Error(`os.tmpdir() is ${os.tmpdir()}, not this test file's own temp folder ${ownTemp}`);

function removeOwnTemp() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmdirSync(ownTemp);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      // Anything else that is not a Windows refusal of the moment — on every system a folder that something was left in — keeps the folder.
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code) || attempt >= WAITS_MS.length) return;
      pauseSync(WAITS_MS[attempt]);
    }
  }
}

// Registered when the file's tests are done, so that this `exit` listener runs after lib/temp-workspace.js's, which the first workspace a test
// made registered (a listener added later runs later: https://nodejs.org/api/events.html#emitteremiteventname-args).
test.after(() => { process.once('exit', removeOwnTemp); });

module.exports = { ownTemp };
