'use strict';
// The test side of helpers/kill-target.js: starts one of its processes, reads what it says, and kills it the way a timeout or "End task" does.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TARGET = path.join(__dirname, 'kill-target.js');
const { systemTool } = require('./windows-system-tools.js');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A pid that no process has: one that ran and ended just now.
function deadPid() {
  const ended = spawnSync(process.execPath, ['-e', ''], { windowsHide: true });
  if (!Number.isInteger(ended.pid) || ended.pid <= 0) throw new Error('a process that ends was not started');
  return ended.pid;
}

// A folder of the test's own, removed when the test ends, to be the temp folder of what it starts: TMPDIR on POSIX, TEMP and TMP on Windows.
// Everything such a process makes in "the temp folder" is then here, whatever the plugin calls its own folder in it.
// On Windows a folder of the plugin's own that already exists is judged by its access list (lib/windows-folder-acl.js), and a folder made in this one takes the list this one has: so that what
// the tests show about runs and sweeps is about the plugin and not about the machine's temp folder (a server's `TEMP=C:\Temp` that others can write to is a folder the plugin rightly refuses),
// this one's list is replaced by a single entry, this user's.
function privateTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-target-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (process.platform === 'win32') {
    const who = spawnSync(systemTool('whoami'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = /"(S-1-\d+(?:-\d+)+)"\s*$/m.exec(String(who.stdout));
    if (!sid) throw new Error(`the user's SID could not be read: ${who.stdout}${who.stderr}`);
    const set = spawnSync(systemTool('icacls'), [root, '/inheritance:r', '/grant:r', `*${sid[1]}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true });
    if (set.status !== 0) throw new Error(`the access list of ${root} could not be set: ${set.stdout}${set.stderr}`);
  }
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

// Whether a process with this pid is there to be signalled (one of another user's too).
function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === 'EPERM'; }
}

// Waits for `check()` to answer something other than false/undefined/null, and answers it; fails, naming `what`, when the time runs out.
async function waitUntil(check, what, ms = 60000) {
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
  t.after(async () => {
    try { fs.writeFileSync(release, ''); } catch { /* the folder is gone */ }
    child.kill('SIGKILL');
    await exited;
    fs.rmSync(signals, { recursive: true, force: true });
  });
  await waitUntil(() => {
    if (child.exitCode !== null) throw new Error(`the hold on ${file} ended: ${err}`);
    return fs.existsSync(ready);
  }, `the hold on ${file}`, 60000);
  return { release: async () => { fs.writeFileSync(release, ''); await exited; } };
}

module.exports = { privateTempRoot, tempEnv, startTarget, pause, deadPid, isRunning, waitUntil, readJsonWhenWritten, holdExclusively };
