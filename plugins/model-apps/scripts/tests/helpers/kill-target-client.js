'use strict';
// The test side of helpers/kill-target.js: starts one of its processes, reads what it says, and kills it the way a timeout or "End task" does.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TARGET = path.join(__dirname, 'kill-target.js');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A pid that no process has: one that ran and ended just now.
function deadPid() {
  const ended = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  if (!Number.isInteger(ended.pid) || ended.pid <= 0) throw new Error('a process that ends was not started');
  return ended.pid;
}

// A folder of the test's own, removed when the test ends, to be the temp folder of what it starts: TMPDIR on POSIX, TEMP and TMP on Windows.
// Everything such a process makes in "the temp folder" is then here, whatever the plugin calls its own folder in it.
function privateTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const tempEnv = (root) => ({ TMPDIR: root, TEMP: root, TMP: root });

// Starts `node kill-target.js ...args`. Registers the kill for when the test ends, so a test that fails half way does not leave a process running.
function startTarget(t, args, { env = {} } = {}) {
  const child = spawn(process.execPath, [TARGET, ...args], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  let ended = false;
  exited.then(() => { ended = true; });
  const target = {
    pid: child.pid,
    exited,
    lines: () => out.split('\n').filter(Boolean),
    stderr: () => err,
    // The first line that matches, waiting for it; fails, with what the process said, if it ends first or the time runs out.
    async waitFor(pattern, ms = 120000) {
      const until = Date.now() + ms;
      for (;;) {
        const line = target.lines().find((l) => pattern.test(l));
        if (line !== undefined) return line;
        if (ended) {
          // `exit` can come before the last of its output has been read.
          await pause(50);
          const late = target.lines().find((l) => pattern.test(l));
          if (late !== undefined) return late;
          throw new Error(`the process ended before it said ${pattern}: ${JSON.stringify({ stdout: out, stderr: err })}`);
        }
        if (Date.now() > until) throw new Error(`the process did not say ${pattern} in ${ms} ms: ${JSON.stringify({ stdout: out, stderr: err })}`);
        await pause(25);
      }
    },
    // SIGKILL cannot be caught. On Windows `kill` is TerminateProcess whatever the signal: the process gets no word either.
    async kill() {
      if (!ended) child.kill('SIGKILL');
      return exited;
    },
  };
  t.after(() => target.kill());
  return target;
}

module.exports = { privateTempRoot, tempEnv, startTarget, pause, deadPid };
