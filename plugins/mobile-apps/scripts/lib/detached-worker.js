'use strict';

/**
 * detached-worker.js — shared plumbing for skill-owned background processes.
 *
 * Skills run inside agent hosts that spawn a fresh shell per command, so a
 * shell-backgrounded job can be torn down with its parent and its exit code
 * cannot be recovered portably. Long-running work (`npm install`) therefore runs
 * as a detached Node process that owns its own state files, and a later step reads
 * those files to find out what happened.
 *
 * Every consumer follows the same shape: a `state` file naming the live pid, an
 * optional `result` file published once the work reaches a terminal outcome, and
 * a log file. Publishing both files with an atomic rename is what lets a reader
 * in another process poll them without ever seeing a half-written object.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // A missing file and a truncated one are the same to a poller: nothing to
    // report yet. Callers distinguish states from which files exist, not from
    // parse failures.
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user, which still counts
    // as alive; only ESRCH proves it is gone. A recycled PID can therefore read as
    // alive after the real worker died, so callers that can hang need their own timeout.
    return error.code === 'EPERM';
  }
}

/**
 * Re-enter this repo's own scripts as a detached child. `process.execPath` keeps the
 * worker on the same Node version as its parent, which matters because the worker
 * shares the parent's module code.
 */
function spawnDetached(scriptPath, args, { cwd } = {}) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd,
    detached: true,
    stdio: 'ignore',
  });
  // Release the child from the parent's event loop so this process can exit while
  // the work keeps running.
  child.unref();
  return child;
}

function sleepSync(milliseconds) {
  // Synchronous sleep without a busy loop, for commands whose whole job is to block.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

module.exports = {
  isProcessAlive,
  readJson,
  sleepSync,
  spawnDetached,
  writeJsonAtomic,
};
