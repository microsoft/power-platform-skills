'use strict';
// `node --require` for a test of what solution-settings.js leaves on disk when the folder a pac fallback worked in cannot be removed: a scanner or a sync client that holds a file pac has just written
// makes the removal answer EBUSY, EPERM or EACCES on Windows, for as long as it holds it (lib/safe-fs.js `removeTreeWithRetry` retries for exactly that). Only the work folders of the script are held — the
// `solution-settings-<pid>-<random>` folders the maker makes in the plugin's own folder, and the `solution-settings-<random>` it falls back to in the temp folder (helpers/solution-settings-work-folder.js) — the
// removal of anything else is the real one, and nothing is removed from a held folder, so what pac wrote and what the script emptied is on disk when the process ends, for the test to read. The test points the
// temporary folder of the process (TEMP, TMP, TMPDIR) at a folder of its own, so that what is held is in a folder the test removes. Every process that inherits NODE_OPTIONS loads this, the fake pac included,
// which never removes a folder.
const fs = require('node:fs');
const path = require('node:path');
const { WORK_FOLDER } = require('./solution-settings-work-folder.js');

const real = fs.rmSync;
fs.rmSync = function rmSync(target, ...rest) {
  if (WORK_FOLDER.test(path.basename(String(target)))) {
    throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), { code: 'EBUSY', errno: -4082, syscall: 'rmdir', path: String(target) });
  }
  return real.call(this, target, ...rest);
};
