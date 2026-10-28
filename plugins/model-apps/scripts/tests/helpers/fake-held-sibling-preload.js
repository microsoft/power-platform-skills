'use strict';
// `node --require` for a test of what `template` does when the temporary name its settings file was written under cannot be removed after the file was published: a scanner or a sync client holds a
// just-written file open without delete sharing, and `unlink` of it answers EBUSY for as long as it does (measured on NTFS). Only the hidden `.<name>.<pid>.<8 hex>.tmp` names of lib/safe-fs.js are
// affected; every other unlink is the real one. (On Windows the writer retries a lock code for about a second before it gives up, so a run with this preload takes that much longer.)
const fs = require('node:fs');

const real = fs.unlinkSync;
fs.unlinkSync = function unlinkSync(target, ...rest) {
  if (/[\\/]\.[^\\/]+\.\d+\.[0-9a-f]{8}\.tmp$/.test(String(target))) {
    throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${target}'`), { code: 'EBUSY', errno: -4082, syscall: 'unlink', path: String(target) });
  }
  return real.call(this, target, ...rest);
};
