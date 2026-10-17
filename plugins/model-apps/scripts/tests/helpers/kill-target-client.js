'use strict';
// The test side of helpers/kill-target.js: starts one of its processes, reads what it says, and kills it the way a timeout or "End task" does.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TARGET = path.join(__dirname, 'kill-target.js');
const { systemTool } = require('./windows-system-tools.js');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// How long a test waits for one thing a process should do — a line, a file, its end. Each takes well under a second on a workstation and
// seconds on a busy CI runner; a test that waits minutes for each of several things outlives the CI job, which is then cancelled with
// nothing reported (a Windows runner was, at 20 minutes). Long enough to be patient, short enough that a failure says what happened.
const WAIT_MS = 30000;
const EXIT_WAIT_MS = 30000;

// The processes the tests of this file started, for the watchdog below: each with its ChildProcess, so that the watchdog ends only one
// that is still running, through its handle — never a pid from the past, which the system may have given to another process since.
const started = [];
// A test file that starts real processes ends in seconds (each such file takes under half a minute on a workstation). If, for
// WATCHDOG_MS, none of its tests starts a process and none of its processes ends, it is not making progress: something holds it open —
// a process that was not killed, a pipe of a program one of them started — and the test runner would wait for it until the CI job's
// own limit cancels the whole run with nothing reported. So the file says what it started and what is holding it open, ends the
// processes of its own that still run, and exits with a failure. The timer is re-armed by every start and every end, and is unref'd:
// it never keeps a finished file alive.
const WATCHDOG_MS = 5 * 60 * 1000;
let watchdog = null;
let shuttingDown = false;
const endLiveChildren = () => { for (const s of started) if (!s.isEnded()) { try { s.child.kill('SIGKILL'); } catch { /* it ended */ } } };
function stalled() {
  // From here on the file ends with a failure, whatever else happens: the code is set before anything that could stop it (a kill
  // that releases the last handle ends the process at once), no process is started any more, and the exit comes in two seconds —
  // a referenced timer, which ends what was started meanwhile too.
  shuttingDown = true;
  process.exitCode = 1;
  const handles = typeof process._getActiveHandles === 'function'
    ? process._getActiveHandles().map((h) => (h && h.constructor && h.constructor.name) || typeof h)
    : [];
  const said = `kill-target-client: no process of this test file started or ended for ${WATCHDOG_MS / 60000} minutes. `
    + `Processes it started: ${JSON.stringify(started.map((s) => ({ args: s.args, pid: s.pid, ...s.said() })))}. `
    + `Open handles: ${JSON.stringify(handles)}\n`;
  // What this file started and still runs goes with it: on POSIX a child outlives a parent that exits.
  endLiveChildren();
  setTimeout(() => { endLiveChildren(); process.exit(1); }, 2000);
  // The words go through the thread pool (fs.write on fd 2), never the stderr stream: a pipe that does not drain blocks a stream
  // write on Windows, inside the call, and the ending above must not wait for it.
  try { fs.write(2, said, () => {}); } catch { /* the words are a courtesy; the ending is not */ }
}
function armWatchdog() {
  if (shuttingDown) return;
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(stalled, WATCHDOG_MS);
  watchdog.unref();
}
armWatchdog();

// A pid that no process has: one that ran and ended just now.
function deadPid() {
  const ended = spawnSync(process.execPath, ['-e', ''], { windowsHide: true, timeout: 30000 });
  if (!Number.isInteger(ended.pid) || ended.pid <= 0) throw new Error('a process that ends was not started');
  return ended.pid;
}

// What must end before a test's folder can go: the processes it started and the holds it took, per test, newest first.
// node:test runs a test's `after` hooks in the order they were added, and a hook that throws stops the ones after it. The folder of
// privateTempRoot is added first, so its hook would run while the test's processes still have files open in it (EBUSY on Windows),
// throw, and stop the hooks that kill them: a CI runner then kept a test file open until the job was cancelled. So that hook ends
// everything registered here itself, first.
const endings = new WeakMap();
function onTestEnd(t, end) {
  const list = endings.get(t) || [];
  list.push(end);
  endings.set(t, list);
}
async function endEverything(t) {
  const list = endings.get(t) || [];
  endings.delete(t);
  for (const end of list.reverse()) {
    try { await end(); } catch (e) { process.stderr.write(`kill-target-client: ${(e && e.message) || e}\n`); }
  }
}

// A folder a test's processes work in, removed when the test ends — after what the test registered has ended, with retries, and never
// throwing, so the hooks after it run whatever happens here. A folder that still cannot be removed is said on stderr and left for the
// runner's check of its temp folder (scripts/run-tests.js) to fail on.
function removeWhenTestEnds(t, dir) {
  t.after(async () => {
    await endEverything(t);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { process.stderr.write(`kill-target-client: ${dir} could not be removed: ${(e && e.code) || e}\n`); }
  });
}

// A folder of the test's own, removed when the test ends, to be the temp folder of what it starts: TMPDIR on POSIX, TEMP and TMP on Windows.
// Everything such a process makes in "the temp folder" is then here, whatever the plugin calls its own folder in it.
// On Windows a folder of the plugin's own that already exists is judged by its access list (lib/windows-folder-acl.js), and a folder made in this one takes the list this one has: so that what
// the tests show about runs and sweeps is about the plugin and not about the machine's temp folder (a server's `TEMP=C:\Temp` that others can write to is a folder the plugin rightly refuses),
// this one's list is replaced by a single entry, this user's.
function privateTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-target-'));
  removeWhenTestEnds(t, root);
  if (process.platform === 'win32') {
    const who = spawnSync(systemTool('whoami'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(String(who.stdout));
    if (!sid) throw new Error(`the user's SID could not be read: ${who.stdout}${who.stderr}`);
    const set = spawnSync(systemTool('icacls'), [root, '/inheritance:r', '/grant:r', `*${sid[1]}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (set.status !== 0) throw new Error(`the access list of ${root} could not be set: ${set.stdout}${set.stderr}`);
  }
  return root;
}
const tempEnv = (root) => ({ TMPDIR: root, TEMP: root, TMP: root });

// Starts `node kill-target.js ...args`. Registers the kill for when the test ends, so a test that fails half way does not leave a process running.
function startTarget(t, args, { env = {} } = {}) {
  if (shuttingDown) throw new Error(`kill-target-client: this test file is being ended by its watchdog; ${args[0]} is not started`);
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
  exited.then(() => { ended = true; armWatchdog(); });
  // Every wait on this process ends: a process that does not end in EXIT_WAIT_MS fails the wait with what it said, instead of
  // holding the test file open until the CI job's own limit cancels the whole run with nothing reported.
  const ending = (ms = EXIT_WAIT_MS) => {
    let timer;
    const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`the process ${child.pid} did not end in ${ms} ms: ${JSON.stringify({ stdout: out, stderr: err })}`)), ms); });
    return Promise.race([exited, late]).finally(() => clearTimeout(timer));
  };
  const target = {
    pid: child.pid,
    get exited() { return ending(); },
    lines: () => out.split('\n').filter(Boolean),
    stderr: () => err,
    // The first line that matches, waiting for it; fails, with what the process said, if it ends first or the time runs out.
    async waitFor(pattern, ms = WAIT_MS) {
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
      return ending();
    },
  };
  started.push({ args, pid: child.pid, child, isEnded: () => ended, said: () => ({ stdout: out.slice(-2000), stderr: err.slice(-2000), ended }) });
  armWatchdog();
  // After the test, the process is killed AND this side of its pipes is closed: a program it started may hold the other end of a
  // pipe it was given, and an open pipe keeps this test file's process alive however its tests ended. Once is enough; it is
  // registered twice — for privateTempRoot, which ends it before it removes the folder, and as a hook of its own.
  let finished = null;
  const finish = () => {
    finished = finished || (async () => {
      try {
        await target.kill();
      } finally {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
    })();
    return finished;
  };
  onTestEnd(t, finish);
  t.after(finish);
  return target;
}

// Whether a process with this pid is there to be signalled (one of another user's too).
function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

// Waits for `check()` to answer something other than false/undefined/null, and answers it; fails, naming `what`, when the time runs out.
async function waitUntil(check, what, ms = WAIT_MS) {
  const until = Date.now() + ms;
  for (;;) {
    const found = check();
    if (found !== false && found !== undefined && found !== null) return found;
    if (Date.now() > until) throw new Error(`gave up waiting for ${what} after ${ms} ms`);
    await pause(25);
  }
}

// The JSON a process of helpers/kill-target.js writes to `file`: waits for it, and for the whole of it.
const readJsonWhenWritten = (file, ms) => waitUntil(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }, file, ms);

// Opens `file` so that nobody else can read it — FileShare.None, which a backup, a virus scanner or an editor does to a file for a moment, and which Node cannot do: it always opens a file shared.
// A PowerShell process holds it, until `release()`. Windows only (the system's own PowerShell, by its place in System32). Resolves once the file is held.
const HOLD_SCRIPT = [
  '$handle = [System.IO.File]::Open($env:HOLD_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)',
  'try {',
  "  [System.IO.File]::WriteAllText($env:HOLD_READY, 'ready')",
  '  $end = [DateTime]::UtcNow.AddSeconds(120)',
  '  while (-not [System.IO.File]::Exists($env:HOLD_RELEASE)) {',
  "    if ([DateTime]::UtcNow -gt $end) { throw 'the hold ran out of time' }",
  '    Start-Sleep -Milliseconds 25',
  '  }',
  '} finally { $handle.Dispose() }',
].join('\n');
async function holdExclusively(t, file) {
  const signals = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-exclusive-'));
  const ready = path.join(signals, 'ready');
  const release = path.join(signals, 'release');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(HOLD_SCRIPT, 'utf16le').toString('base64')], {
    env: { ...process.env, HOLD_FILE: file, HOLD_READY: ready, HOLD_RELEASE: release },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let err = '';
  child.stderr.on('data', (chunk) => { err += chunk; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // A wait on the holder's end that ends, and never keeps a finished test file alive itself.
  const ended = () => Promise.race([exited, new Promise((resolve) => setTimeout(resolve, EXIT_WAIT_MS).unref())]);
  let finished = null;
  const finish = () => {
    finished = finished || (async () => {
      try { fs.writeFileSync(release, ''); } catch { /* the folder is gone */ }
      child.kill('SIGKILL');
      await ended();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      fs.rmSync(signals, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    })();
    return finished;
  };
  onTestEnd(t, finish);
  t.after(finish);
  await waitUntil(() => {
    if (child.exitCode !== null) throw new Error(`the hold on ${file} ended: ${err}`);
    return fs.existsSync(ready);
  }, `the hold on ${file}`, WAIT_MS);
  return { release: async () => { fs.writeFileSync(release, ''); await ended(); } };
}

module.exports = { privateTempRoot, removeWhenTestEnds, tempEnv, startTarget, pause, deadPid, isRunning, waitUntil, readJsonWhenWritten, holdExclusively, onTestEnd };
