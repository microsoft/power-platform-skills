'use strict';
// One OS process of the configuration quarantine's crash and lease tests (configuration-create-state.test.js). The process is the
// boundary under test: it takes the real build lease (lib/app-operation-lease.js) and, inside the quarantine, the real record lease
// (lib/record-lease.js), exactly as the build's quarantine command does, and it can end at any file system step of the quarantine with
// no unwinding. Its leases then stay in the workspace under its pid, and the next process takes them over through the production lease
// code once that pid is gone (lib/process-owner.js); nothing removes a lock file by hand.
//   node configuration-quarantine-crash-child.js <base64 of the JSON input>
//   input: { dir, appUniqueName, quarantineId?, stop?, stopMatch?, pause?: { match, ready, release } }
// Every call of a node:fs function that can change a quarantine file is a CHECKPOINT, numbered from 1 in the order the calls run, once
// before and once after the call. A process that ends between two calls leaves exactly what an exit at the earlier one's `after` leaves,
// and reads change nothing, so these are all the distinct places an interruption can leave the workspace.
//   stop: n         - exit with CRASH_EXIT at checkpoint n (process.exit: no finally block, no lease release runs);
//   stopMatch: {..} - the same at the first checkpoint that matches { fn, phase, last } (`last` is the label of the last path argument);
//   pause: {..}     - at the first checkpoint that matches `match`, write `ready` and wait, still holding both leases, until `release` exists.
// The last line on stdout is JSON: { halt, quarantineId, trace } or { error, reason, nextStep, trace }, or at a stop { stopped, trace }.
const fs = require('node:fs');
const path = require('node:path');
const S = require('../../lib/configuration-create-state.js');
const { withAppBuildLease } = require('../../lib/app-operation-lease.js');

const CRASH_EXIT = 80;
const input = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'));

// The role of a path in the protocol, from its name alone (the workspace is the only folder this process touches; a name is safer than a
// path here, since the module may report the folder by its real path while the test holds an 8.3 short one). Lease files are the lease
// code's own subject and are never checkpoints:
//   configuration-create-state.v1.json                                   -> 'state'
//   configuration-create-state.quarantine.<id>.json                      -> 'marker'
//   configuration-create-state.unreadable.<id>.bin                       -> 'archive'
//   <any of the three>.<pid>.<ms>.<random>.tmp (one or two suffixes)     -> 'state-stage' | 'marker-stage' | 'archive-stage'
//   *.lock, *.lock.reclaim                                               -> null
function label(file) {
  if (typeof file === 'number') return descriptors.has(file) ? descriptors.get(file) : null;
  if (typeof file !== 'string' && !Buffer.isBuffer(file)) return null;
  const name = path.basename(String(file));
  if (name.includes('.lock')) return null;
  if (name === S.STATE_FILE) return 'state';
  if (name.startsWith(`${S.STATE_FILE}.`)) return 'state-stage';
  if (name.startsWith(S.QUARANTINE_FILE_PREFIX)) return name.endsWith('.json') ? 'marker' : 'marker-stage';
  if (name.startsWith(S.ARCHIVE_FILE_PREFIX)) return name.endsWith('.bin') ? 'archive' : 'archive-stage';
  return null;
}

// Only descriptors opened for writing are tracked: a read-only open (the archive inspection) and its close change nothing on disk.
const descriptors = new Map();
const writes = (flags) => flags !== undefined && flags !== 'r' && flags !== 'rs' && flags !== fs.constants.O_RDONLY;
const realWriteSync = fs.writeSync;
const realWriteFileSync = fs.writeFileSync;
const realExistsSync = fs.existsSync;
const emit = (data) => realWriteSync(1, `${JSON.stringify(data)}\n`);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const trace = [];
let paused = false;
function checkpoint(phase, fn, labels) {
  const point = { n: trace.length + 1, phase, fn, labels };
  trace.push(point);
  const m = input.stopMatch;
  const matches = (x) => x && x.fn === fn && x.phase === phase && (!x.last || labels[labels.length - 1] === x.last);
  if (input.stop === point.n || matches(m)) {
    emit({ stopped: point, trace });
    process.exit(CRASH_EXIT);
  }
  if (!paused && input.pause && matches(input.pause.match)) {
    paused = true;
    realWriteFileSync(input.pause.ready, 'ready');
    const end = Date.now() + 120000;
    while (!realExistsSync(input.pause.release)) {
      if (Date.now() > end) throw new Error('the test never released the paused quarantine');
      sleepSync(10);
    }
  }
}

const TWO_PATHS = new Set(['copyFileSync', 'renameSync', 'linkSync']);
for (const fn of ['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'copyFileSync', 'renameSync', 'linkSync', 'unlinkSync']) {
  const real = fs[fn];
  fs[fn] = (...args) => {
    let labels = (TWO_PATHS.has(fn) ? args.slice(0, 2) : args.slice(0, 1)).map(label);
    if (fn === 'openSync' && !writes(args[1])) labels = [null];
    const counted = labels.some(Boolean);
    if (counted) checkpoint('before', fn, labels);
    const value = real(...args);
    if (fn === 'openSync' && counted) descriptors.set(value, labels[0]);
    if (counted) checkpoint('after', fn, labels);
    if (fn === 'closeSync') descriptors.delete(args[0]);
    return value;
  };
}

const quarantine = () => S.quarantineUnreadableReceipt(input.dir, {
  acknowledgeUnknownDispatch: true,
  quarantineId: input.quarantineId || undefined,
  invalidate: () => ({ ok: true }),
});

(async () => {
  try {
    const out = await withAppBuildLease({ workspaceDir: input.dir, appUniqueName: input.appUniqueName }, quarantine);
    emit({ halt: out.halt.code, quarantineId: out.quarantineId, trace });
  } catch (e) {
    emit({ error: e.code || e.name, reason: e.reason, nextStep: e.nextStep, message: e.message, trace });
  }
})();
