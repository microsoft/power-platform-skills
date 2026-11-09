'use strict';
// For the tests that are about what the import does WITH the settings copy it gives pac — not about how the copy is made private. The real `createPrivateFile` (lib/private-folder.js) asks Windows for an
// access list: `whoami` and `icacls`, six processes and about half a second for each copy, and a test that reaches pac through the importer makes one. The way it is made is pinned where it is the subject:
// private-folder.test.js (every step, over a stand-in for the process runner) and solution-settings-snapshot.test.js (the real tools, the result read back through another route).
//
// `install()` puts a plain exclusive create in its place — the same `wx` and mode 0600 the real one uses to create the file — and must run BEFORE solution-settings.js is loaded: the script takes the function
// when it loads. A test that wants the real one passes `privateFile: realCreatePrivateFile` among the importer's dependencies. The preload (fake-power-platform-preload.js) installs it for a child process
// unless its configuration says `realPrivateFolder`.
const fs = require('node:fs');
const path = require('node:path');

// The tests that use this are also run against the script as it was before lib/private-folder.js existed, to see which of them fail there (the regression tests of the change that added it): in a tree without
// the module there is nothing to replace, and the importer makes its copy as it did.
let privateFolder = null;
try {
  privateFolder = require('../../lib/private-folder.js');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const realCreatePrivateFile = privateFolder ? privateFolder.createPrivateFile : undefined;

function plainCreatePrivateFile(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
  return file;
}

function install() {
  if (privateFolder) privateFolder.createPrivateFile = plainCreatePrivateFile;
}

module.exports = { install, realCreatePrivateFile, plainCreatePrivateFile };
