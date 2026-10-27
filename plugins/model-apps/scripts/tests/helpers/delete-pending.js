'use strict';
// A name in the state another build leaves it in when it deletes a lock file while a third process still has it open — reading it to judge the
// lock's owner. On Windows under a libuv before 1.48 (Node 20) the name stays until that handle closes ("delete pending"), and every lstat and
// create of it meanwhile fails with EPERM (https://github.com/libuv/libuv/issues/3839). From libuv 1.48 (Node 22), and on Linux and macOS, the
// delete removes the name at once, and the same steps leave no name at all.
const fs = require('node:fs');
const path = require('node:path');

// Writes `name`, opens it, and deletes it while it is open. `close()` lets go of the handle, and with it, the name.
function deletedWhileOpen(name, content = '{}') {
  fs.writeFileSync(name, content);
  const fd = fs.openSync(name, 'r');
  fs.rmSync(name);
  let open = true;
  return {
    close() {
      if (!open) return;
      open = false;
      fs.closeSync(fd);
    },
  };
}

// Whether a name deleted while open lingers here (the EPERM above), worked out in the folder `dir` and cleaned up again.
function deletedNamesLinger(dir) {
  const name = path.join(dir, 'delete-pending-probe');
  const probe = deletedWhileOpen(name);
  try {
    fs.lstatSync(name);
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return false;
    if (e && e.code === 'EPERM') return true;
    throw e;
  } finally {
    probe.close();
  }
}

module.exports = { deletedWhileOpen, deletedNamesLinger };
