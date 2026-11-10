'use strict';
// A child process for the page-tree crash tests (download-model-app.test.js): it downloads into <out> as tests/helpers/page-swap.js does
// and STOPS DEAD (process.exit: no catch, no finally, no clean-up runs, as for a kill) at one boundary of writePageTree's swap:
//   partial  while the second page of the new tree is being written;
//   staged   with the new tree whole, just before pages/ is moved aside;
//   aside    just after pages/ is moved aside, before the new tree is moved in;
//   in       just after the new tree is moved to pages/, before the swap folder is removed;
//   removed  just after the swap folder is removed.
// It exits 86 at that point; any other exit means the point was never reached.
//   node page-swap-crash-child.js <out> <direct|managed> <point>
const fs = require('node:fs');
const path = require('node:path');
const { SWAP_B, swapDownload } = require('./page-swap.js');

const [out, mode, point] = process.argv.slice(2);
// The download moves and writes through the real path of <out> (an 8.3 short name names the same folder).
const realOut = fs.realpathSync.native(out);
const pagesDir = path.join(realOut, 'pages');
// The swap folder of the publish to <out> (`<out>/.pages-replace.*`), not the one the managed download stages its tree with.
const inSwap = (p) => {
  const rel = path.relative(realOut, String(p));
  return !rel.startsWith('..') && rel.split(path.sep)[0].startsWith('.pages-replace.');
};
const stop = () => process.exit(86);

const rename = fs.renameSync;
fs.renameSync = function (from, to) {
  if (point === 'staged' && from === pagesDir) stop();
  const result = rename.apply(this, arguments);
  if (point === 'aside' && from === pagesDir) stop();
  if (point === 'in' && to === pagesDir && inSwap(from)) stop();
  return result;
};
const rm = fs.rmSync;
fs.rmSync = function (p) {
  const result = rm.apply(this, arguments);
  if (point === 'removed' && path.dirname(String(p)) === realOut && inSwap(p)) stop();
  return result;
};
const open = fs.openSync;
fs.openSync = function (p) {
  if (point === 'partial' && inSwap(p) && path.relative(realOut, String(p)).split(path.sep).includes(SWAP_B)) stop();
  return open.apply(this, arguments);
};

swapDownload(out, mode === 'managed').then(
  () => { process.exitCode = 0; },
  (e) => { process.stderr.write(`${(e && e.stack) || e}\n`); process.exitCode = 1; },
);
