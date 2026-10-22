'use strict';
// `node --require` for a test of what `template` does on a file system that cannot make a hard link — a FAT or exFAT volume, some network shares and FUSE mounts. On Windows FAT and exFAT,
// CreateHardLinkW fails with ERROR_INVALID_FUNCTION, which libuv reports as EISDIR (the code lib/safe-fs.js reads as "this file system cannot link"); other file systems answer ENOTSUP or EPERM.
const fs = require('node:fs');

fs.linkSync = function linkSync(existing, created) {
  throw Object.assign(new Error(`EISDIR: illegal operation on a directory, link '${existing}' -> '${created}'`), { code: 'EISDIR', errno: -4068, syscall: 'link' });
};
