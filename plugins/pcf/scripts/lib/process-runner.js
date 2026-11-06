'use strict';
// The one place model-apps production code starts an external CLI (az, pac, npm, npx, git).
//
// Every call goes through `invocation()`, which returns an ABSOLUTE executable and an argv array, and
// is always spawned with `shell: false`. Two Windows facts shape it:
//
// 1. `az`, `npm` and `npx` are batch shims (`az.cmd`, `npm.cmd`, `npx.cmd`), and `pac` is `pac.exe`
//    or a `pac.cmd` shim depending on how it was installed. Node refuses to start a `.cmd`/`.bat`
//    with `shell: false` (EINVAL since Node 18.20.2 / 20.12.2), so a shim has to run under cmd.exe.
//    See: https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows
//    cmd.exe adds nothing to a shim that only forwards its arguments to a native program beside it
//    (the Windows MSI's `pac.cmd`): such a launcher is started as that program — see forwardedProgram.
//    `shell: true` is not the answer: it joins the arguments with spaces and hands the string to
//    cmd.exe without quoting any of them. So a shim runs as `cmd.exe /d /s /v:off /c <shim> <args>`,
//    and every argument must be INERT for cmd.exe — see CMD_INERT_ARG.
// 2. A bare name ("git", "pac") is looked up in the CURRENT DIRECTORY before PATH, both by Node's own
//    launcher and by cmd.exe, and the current directory is usually the user's project. So the name
//    is resolved here, against absolute PATH entries only, before anything is started.
//
// A native `.exe` on Windows, and everything on macOS/Linux, is started directly, so its arguments
// reach the program exactly as given (libuv applies the C-runtime quoting rules on Windows).
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// An argument handed to a batch shim is parsed by cmd.exe twice: once on the `/c` command line, and
// again when the shim forwards `%*`. The arguments that survive both parses unchanged, with no
// quoting at all, are the ones made only of characters cmd.exe gives no meaning to. Everything the
// shims are given today fits: fixed flags, an https origin, a GUID, a JMESPath query such as
// `{user:user.name,tenantId:tenantId}`. Anything else is refused BEFORE a process starts.
const CMD_INERT_ARG = /^[A-Za-z0-9_.,:/{}@=+-]+$/;

// How one argument is written on a batch shim's command line, or null when it cannot be.
// Inert text goes bare. Anything else is wrapped in double quotes, inside which cmd.exe treats
// & | < > ^ ( ) and spaces as plain text in both parses (the shim's `%*` keeps the quotes). What
// still acts inside quotes is refused: a double quote (it would end the quoting) and `%` (variable
// expansion happens before quotes are considered). `!` is literal on this command line (/v:off),
// so it is refused only when `bangExpands` says the shim turns delayed expansion back on. Control
// characters are refused because a line break ends the command.
// A trailing backslash run is doubled: the program's C runtime would read `\"` as an escaped quote.
// See: https://learn.microsoft.com/cpp/cpp/main-function-command-line-args#parsing-c-command-line-arguments
function cmdArgument(value, { bangExpands = false } = {}) {
  if (CMD_INERT_ARG.test(value)) return value;
  if (value === '') return '""';
  if (/["%\u0000-\u001f\u007f]/.test(value) || (bangExpands && value.includes('!'))) return null;
  return `"${value.replace(/(\\+)$/, '$1$1')}"`;
}

// Whether a batch shim turns delayed expansion on for itself (`setlocal enabledelayedexpansion`),
// in which case `!NAME!` in a forwarded argument would be replaced by that variable's value. The
// shims this plugin runs (az.cmd, npm.cmd, npx.cmd) do not. An unreadable shim is assumed to.
function shimExpandsBang(file, readFile = (p) => fs.readFileSync(p, 'latin1')) {
  try { return /enabledelayedexpansion/i.test(readFile(file)); } catch { return true; }
}

// A batch launcher that does nothing but start a native program beside it with the arguments it was given — the whole of the Power Platform CLI's `pac.cmd`, the launcher
// the Windows MSI installs (a two-line text file, which `pac.launcher.exe` then resolves to the installed version):
//     @echo off
//     "%~dp0pac.launcher.exe" %*
// cmd.exe adds nothing to such a launcher except its parsing, and that parsing is exactly what makes a `%` (or a double quote) in an argument impossible to hand over
// unchanged: the launcher IS the program it forwards to, so that program is started directly, as an install of `pac.exe` is, and the arguments reach it as
// given (libuv writes the command line by the C runtime's rules). `%~dp0` is the launcher's own folder:
// https://learn.microsoft.com/windows-server/administration/windows-commands/call#batch-parameters
//
// The recognition follows how cmd.exe reads a batch file — a line at a time — and is by the launcher's EXACT lines: at most one `@echo off` line, then ONE line that starts the
// sibling `<name>.exe` (a plain file name, no folder) with `%*`; blank lines (spaces and tabs only) are no-ops and may stand anywhere, and the program must be a file next to it.
// The lines matter. `@echo off "%~dp0pac.launcher.exe" %*` on ONE line is not a launcher: `echo off "…"` is the ECHO command with an argument, so cmd.exe prints the text and starts
// nothing (https://learn.microsoft.com/windows-server/administration/windows-commands/echo) — and a text that merely LOOKS like a forwarder, started as a program, would run what
// the batch file never ran, with arguments the checked route would have refused. Anything else — a line that sets a variable, picks a version itself, forwards `%1 %2`, joins two
// commands with `&` or ends in a caret that continues onto the next line, a control character other than a line end — is not recognised and keeps the checked cmd.exe route, with its refusals.
const ECHO_OFF_LINE = /^[ \t]*@?echo[ \t]+off[ \t]*$/i;
const FORWARD_LINE = /^[ \t]*@?"%~dp0([A-Za-z0-9_][A-Za-z0-9_.-]*\.exe)"[ \t]+%\*[ \t]*$/i;
const BLANK_LINE = /^[ \t]*$/;

// The physical lines of a batch file's text: a line ends at LF, a CR before the LF belongs to the line end (CRLF), and a byte order mark is dropped. Any other character stays in its
// line — a lone CR, NUL or form feed included — where the patterns above refuse it, because they allow nothing in a line but the command and spaces and tabs.
function launcherLines(text) {
  return String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
}

function forwardedProgram(file, { readFile = (p) => fs.readFileSync(p, 'utf8'), exists = isFile } = {}) {
  let text;
  try { text = String(readFile(file)); } catch { return null; }
  if (text.length > 1024) return null; // a launcher this simple is a few dozen bytes
  const meaningful = launcherLines(text).filter((line) => !BLANK_LINE.test(line));
  let forwardLine;
  if (meaningful.length === 1) forwardLine = meaningful[0];
  else if (meaningful.length === 2 && ECHO_OFF_LINE.test(meaningful[0])) forwardLine = meaningful[1];
  else return null;
  const match = FORWARD_LINE.exec(forwardLine);
  if (!match) return null;
  const program = path.win32.join(path.win32.dirname(file), match[1]);
  return exists(program) ? program : null;
}

// The value of an environment variable the way Node passes it to a child on Windows, where names
// are case-insensitive: when an env object carries several spellings (a copied `Path` plus an added
// `PATH`), Node sends the lexicographically first one, so resolution must read that same one.
// See: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options (options.env)
function envValue(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).filter((k) => k.toUpperCase() === name.toUpperCase()).sort()[0];
  return key === undefined ? undefined : env[key];
}

/**
 * A copy of `env` with `dir` first on the path. On Windows every spelling of PATH is replaced by one
 * `PATH` holding the value Node would have passed the child; on POSIX, where `Path` and `PATH` are
 * different variables, only `PATH` changes.
 */
function withPathFirst(env, dir, platform = process.platform) {
  const out = { ...env };
  if (platform !== 'win32') {
    out.PATH = out.PATH ? `${dir}:${out.PATH}` : dir;
    return out;
  }
  const current = envValue(env, 'PATH', platform);
  for (const k of Object.keys(out)) if (k.toUpperCase() === 'PATH') delete out[k];
  out.PATH = current ? `${dir};${current}` : dir;
  return out;
}

const WINDOWS_BATCH = /\.(?:cmd|bat)$/i;
const WINDOWS_NATIVE = /\.(?:exe|com)$/i;

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// Absolute directories on PATH, in order. Relative entries (including an empty entry, which POSIX
// shells read as "the current directory") are skipped for the same reason as the current directory.
function pathDirectories({ platform, env }) {
  const win = platform === 'win32';
  const raw = envValue(env, 'PATH', platform) || '';
  const isAbs = win ? path.win32.isAbsolute : path.posix.isAbsolute;
  return raw.split(win ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && isAbs(d));
}

/**
 * Resolve a command name to an absolute file on PATH, never from the current directory.
 * On Windows the PATHEXT order decides between, say, `pac.exe` and `pac.cmd` in the same folder,
 * as cmd.exe would, but only native executables and batch files are accepted.
 * @returns {string|null}
 */
function resolveExecutable(name, { platform = process.platform, env = process.env, exists = isFile } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const exts = platform === 'win32'
    ? String(envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim())
      .filter((e) => WINDOWS_BATCH.test(e) || WINDOWS_NATIVE.test(e))
    : [''];
  for (const dir of pathDirectories({ platform, env })) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

// cmd.exe itself, by absolute path. ComSpec is what Node's own `shell: true` uses; it is only
// trusted when it is an absolute path to a file named cmd.exe.
function windowsCmd(env = process.env) {
  const comspec = String(envValue(env, 'ComSpec', 'win32') || '');
  if (path.win32.isAbsolute(comspec) && /(?:^|\\)cmd\.exe$/i.test(comspec)) return comspec;
  return path.win32.join(envValue(env, 'SystemRoot', 'win32') || envValue(env, 'windir', 'win32') || 'C:\\Windows', 'System32', 'cmd.exe');
}

function codeError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Build the call that starts `name` with `args`: an absolute file, an argv array, and the options
 * that must accompany them. Callers add their own options (encoding, timeout, stdio, cwd) on top.
 * @throws {Error} code 'ENOENT' when `name` is not on PATH; code 'EARGUMENT' when an argument
 *   cannot be passed through a Windows batch shim unchanged.
 */
function invocation(name, args = [], { platform = process.platform, env = process.env, exists = isFile, readFile } = {}) {
  const argv = args.map((a) => String(a));
  const file = resolveExecutable(name, { platform, env, exists });
  // Worded like Node's own launch failure (`spawn pac ENOENT`) so existing diagnostics read the same.
  if (!file) throw codeError(`spawn ${name} ENOENT: not found on PATH`, 'ENOENT');
  if (platform !== 'win32' || !WINDOWS_BATCH.test(file)) {
    return { file, args: argv, options: { shell: false, windowsHide: true } };
  }
  // A launcher that only forwards to a native program beside it is started as that program (see forwardedProgram): nothing is parsed by cmd.exe, so nothing is refused.
  const forwarded = forwardedProgram(file, { readFile, exists });
  if (forwarded) return { file: forwarded, args: argv, options: { shell: false, windowsHide: true } };
  const bangExpands = argv.some((a) => a.includes('!')) && shimExpandsBang(file, readFile);
  const refused = argv.find((a) => cmdArgument(a, { bangExpands }) === null);
  if (refused !== undefined || /[%!"]/.test(file)) {
    throw codeError(
      `cannot pass ${JSON.stringify(refused === undefined ? file : refused)} to ${path.win32.basename(file)}: `
        + `a Windows batch file cannot receive a double quote, %, a control character${bangExpands ? ' or (for this one) !' : ''} unchanged`,
      'EARGUMENT'
    );
  }
  // The command line is written out in full, and `windowsVerbatimArguments` stops libuv from quoting
  // it a second time. This is the shape Node's own `shell: true` produces — `/d /s /c "<line>"`, where
  // /s strips exactly the outer pair of quotes — with the difference that the shim is quoted by
  // absolute path and every argument has already been checked. /d skips AutoRun commands; /v:off
  // keeps `!` literal even where delayed expansion is on by default.
  // See: https://learn.microsoft.com/windows-server/administration/windows-commands/cmd
  return {
    file: windowsCmd(env),
    args: ['/d', '/s', '/v:off', '/c', `""${file}" ${argv.map((a) => cmdArgument(a, { bangExpands })).join(' ')}"`],
    options: {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      // Stops cmd.exe itself from preferring a same-named file in the current directory for any
      // command the shim runs. It does not govern Node's own lookup, which is why `file` is absolute.
      env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' },
    },
  };
}

// Merge the invocation's required options over the caller's, so a caller cannot turn the shell on
// or drop the verbatim flag by accident.
//
// The four calls below are the only child_process calls in model-apps production code, and each is
// an exact, reviewed exception in scripts/validate-secure-process-execution.js (their executable is
// resolved at run time and their options are merged, so the validator cannot prove them statically).
function withOptions(inv, options = {}) {
  const merged = { ...options, ...inv.options };
  if (options.env && inv.options.env) merged.env = { ...options.env, NoDefaultCurrentDirectoryInExePath: '1' };
  return merged;
}

function runSync(name, args, options = {}, deps = {}) {
  const inv = invocation(name, args, deps);
  return childProcess.execFileSync(inv.file, inv.args, withOptions(inv, options));
}

// spawnSync-shaped: never throws, reports a launch failure through `error` as spawnSync does.
function spawnResultSync(name, args, options = {}, deps = {}) {
  let inv;
  try { inv = invocation(name, args, deps); } catch (error) {
    return { status: null, signal: null, stdout: '', stderr: '', error };
  }
  return childProcess.spawnSync(inv.file, inv.args, withOptions(inv, options));
}

// How long a call that ran out of time waits for the pipes of the tree it ended to close — so that what the processes wrote before they died is in the result — before
// it settles anyway (a process that was not in the tree can hold them open for ever).
const TREE_CLOSE_GRACE_MS = 5000;

/**
 * spawnResultSync's asynchronous twin, for a call that may have to be ENDED: the same result — `{ status, signal, stdout, stderr, error? }`, never rejecting, a launch
 * failure through `error` — and the options `encoding`, `maxBuffer` and `timeout` of spawnSync, but a call that outlasts its `timeout` has its WHOLE process tree ended
 * (killProcessTree) before the call settles. spawnSync cannot do that: it ends only the process it started, and on Windows that is cmd.exe running a batch launcher
 * (`pac.cmd`), whose child — the program that is actually working, and may be importing a solution — goes on running after the call has reported that it timed out.
 * The result of a call that was ended has `error.code` `ETIMEDOUT`; one that wrote past `maxBuffer` was ended too, with `ENOBUFS`.
 *
 * What such an error says about the process is `error.containment`, and a caller must not claim more than it says. `'confirmed'`: the pipes closed after the kill, so nothing that was holding them
 * is left — the call's process and every process that held its output were stopped. That is ALL it proves: a process the call started that never held the pipes (detached, with streams of its
 * own) is not covered, and can outlive the kill unnoticed, so a message says "pac and every process that held its output were stopped" (lib/pac-fallback.js stopClaim) and not that the tree is gone.
 * `'unconfirmed'`: the wait for the pipes (TREE_CLOSE_GRACE_MS) ran out first, so a process the call started still holds them and may
 * still be running — the case killProcessTree cannot reach, because it will not end a tree by the pid of a launcher that has already exited (the number may be another process's
 * by then) and what that launcher started has been re-parented, out of every tree that can be walked from a live pid. `error.pid` is the process the call started, when it has one:
 * for an unconfirmed ending that process is usually gone, and the survivor's own id is not known.
 * `deps` are the seams of `invocation`, plus `killTree` and `clock` ({ setTimeout, clearTimeout }) for a test.
 */
function spawnResultTree(name, args, options = {}, deps = {}) {
  const { timeout = 0, maxBuffer = 1024 * 1024, encoding = 'utf8', ...spawnOptions } = options;
  const killTree = deps.killTree || killProcessTree;
  const clock = deps.clock || { setTimeout, clearTimeout };
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(name, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions }, deps);
    } catch (error) {
      resolve({ status: null, signal: null, stdout: '', stderr: '', error });
      return;
    }
    const out = [];
    const err = [];
    let written = 0;
    let settled = false;
    let timer = null;
    let grace = null;
    let ending = null; // the error a call that is being ended will report, once its pipes have closed
    const decode = (chunks) => (encoding === 'buffer' ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding));
    const settle = (status, signal, error, pipesClosed = false) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      if (grace !== null) clock.clearTimeout(grace);
      if (error && ending) {
        // Said before the result is handed over: 'close' fired (every pipe is closed, so nothing that was started holds one), or the grace period ended with a pipe still open.
        error.containment = pipesClosed ? 'confirmed' : 'unconfirmed';
        if (Number.isInteger(child.pid)) error.pid = child.pid;
      }
      resolve({ status, signal, stdout: decode(out), stderr: decode(err), ...(error ? { error } : {}) });
      if (error && ending) {
        // A process that outlived the kill holds these pipes open, and a pipe nobody finished reading keeps this process alive at exit.
        for (const stream of [child.stdout, child.stderr]) {
          try { if (stream) stream.destroy(); } catch { /* already closed */ }
        }
        if (typeof child.unref === 'function') child.unref();
      }
    };
    const end = (error) => {
      if (ending || settled) return;
      ending = error;
      try { killTree(child); } catch { /* ended or not, the call is reported */ }
      grace = clock.setTimeout(() => settle(null, 'SIGKILL', ending, false), TREE_CLOSE_GRACE_MS);
      if (grace && typeof grace.unref === 'function') grace.unref();
    };
    const collect = (chunks) => (chunk) => {
      chunks.push(chunk);
      written += chunk.length;
      if (written > maxBuffer) end(Object.assign(new Error(`spawn ${name} ENOBUFS`), { code: 'ENOBUFS' }));
    };
    // EMFILE and ENFILE leave the pipes unset, hence the guards.
    if (child.stdout) child.stdout.on('data', collect(out));
    if (child.stderr) child.stderr.on('data', collect(err));
    // 'close', not 'exit': 'exit' comes when the process itself ends, while a process it started can still hold the pipes and write.
    child.on('error', (error) => settle(null, null, error));
    child.on('close', (status, signal) => (ending ? settle(null, signal || 'SIGKILL', ending, true) : settle(status, signal)));
    if (timeout > 0) {
      timer = clock.setTimeout(() => end(Object.assign(new Error(`spawn ${name} ETIMEDOUT`), { code: 'ETIMEDOUT' })), timeout);
      // The child keeps the loop alive while it runs; the deadline must not be what keeps a process running once it does not.
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  });
}

// execFile-shaped: the callback receives a resolution failure as its error, asynchronously.
function execFileAsync(name, args, options, callback, deps = {}) {
  let inv;
  try { inv = invocation(name, args, deps); } catch (error) {
    process.nextTick(() => callback(error, '', ''));
    return null;
  }
  return childProcess.execFile(inv.file, inv.args, withOptions(inv, options), callback);
}

function spawnProcess(name, args, options = {}, deps = {}) {
  const inv = invocation(name, args, deps);
  return childProcess.spawn(inv.file, inv.args, withOptions(inv, options));
}

// One `ps` listing line: `<pid> <ppid>`, optionally followed by the process's start time (`lstart`, which killProcessTree asks for), in any
// spacing, with no header (the `=` after each name blanks it):
//     100     1 Mon Oct 12 09:00:01 2026
//    4242   100 Mon Oct 12 09:12:30 2026
//    5000  4242 Mon Oct  5 09:12:31 2026
// The start time is kept as the text ps printed, with its runs of spaces made one: it is only ever compared with what ps prints for the same pid
// moments later, in the same environment, so its format and locale do not matter.
const PS_LINE = /^\s*(\d+)\s+(\d+)(?:\s+(\S.*?))?\s*$/;

// The pids under `rootPid` in such a listing. Parents come before their children (breadth first). Lines that are not a pid and a parent pid are
// skipped, and a process listed twice, or two that name each other as parent, are read once, so a damaged listing cannot loop.
function descendantPids(rootPid, listing) {
  const children = new Map();
  for (const line of String(listing == null ? '' : listing).split(/\r?\n/)) {
    const pair = PS_LINE.exec(line);
    if (!pair) continue;
    const parent = Number(pair[2]);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(Number(pair[1]));
  }
  const found = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  for (let i = 0; i < queue.length; i += 1) {
    for (const pid of children.get(queue[i]) || []) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

// Each pid's start time in such a listing, as `PS_LINE` reads it; a line with none gives none.
function startTimes(listing) {
  const started = new Map();
  for (const line of String(listing == null ? '' : listing).split(/\r?\n/)) {
    const row = PS_LINE.exec(line);
    if (row && row[3]) started.set(Number(row[1]), row[3].replace(/\s+/g, ' '));
  }
  return started;
}

// Whether `pid` still names the process a listing saw, read again just before it is signalled: `ps -o lstart= -p <pid>` must print the same start
// time. A descendant can exit after the listing, and its pid can then be given to an unrelated process — signalling the number would end that one.
// A pid the listing gave no start time for, one that is gone (ps exits 1 and prints nothing) and one that now started at another time are all left
// alone. This is best effort, not an identity the kernel keeps: two processes can share a start time (it is to the second), so a pid given out again
// within the second its first holder started passes; and a pid given out again after this read and before the signal is not seen, whatever its start.
function stillTheSame(pid, startedAt, run) {
  if (!startedAt) return false;
  try {
    const now = run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    return !!now && now.status === 0 && String(now.stdout == null ? '' : now.stdout).replace(/\s+/g, ' ').trim() === startedAt;
  } catch {
    return false;
  }
}

// Ends `child` AND everything it started, for a call that ran out of time. Killing only the process that was started is not enough: on Windows
// `pac.cmd` is a shim — cmd.exe, which runs pac.exe — so ending cmd.exe leaves the stalled pac running and holding its connections. A tree is
// ended by `taskkill /T /F` on Windows (https://learn.microsoft.com/windows-server/administration/windows-commands/taskkill) and, elsewhere, by
// SIGKILL to each process `ps` lists under it (SIGKILL, not SIGTERM: a stalled process may ignore that) — the child first, so it can start nothing
// more, then its descendants deepest first, each only once `ps` shows that its pid still has the start time the listing saw (stillTheSame — best
// effort, as it says). Both tools
// are started through spawnResultSync, the audited call above, so each is resolved to an absolute executable on PATH and never taken from the current
// directory. This never throws, whatever has gone wrong: the caller is already handling a failure, and a process that is already gone, a tool that is
// absent or one that times out still end with the child itself asked to die.
// `env` is the environment the tools are looked up in (a seam for the tests).
//
// A child that has ALREADY EXITED is not ended by its pid. Node's 'exit' can come before 'close' when a process the child started still holds its pipes — the very case a call that
// runs out of time is stopped in — and by then the number can belong to another process: Windows reuses ids at once, and a tree kill by it would end that process and everything it started.
// There is no tree to walk from a process that is gone, either: what it started was re-parented, and taskkill /T and the `ps` walk both start from a live pid. So such a child is only asked to
// die (a no-op), and whatever it left running is what the caller's own deadline already gave up on.
function killProcessTree(child, { platform = process.platform, env = process.env, run = spawnResultSync, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  const pid = child && child.pid;
  const endChild = () => {
    try { if (child && typeof child.kill === 'function') child.kill('SIGKILL'); } catch { /* already gone */ }
  };
  if (!Number.isInteger(pid) || pid <= 0) { endChild(); return; }
  // `exitCode` and `signalCode` are null while a ChildProcess runs; an object that is not one (a test's stand-in) has neither, which reads as running.
  if (child.exitCode != null || child.signalCode != null) { endChild(); return; }
  try {
    if (platform === 'win32') {
      // taskkill.exe lives in System32, next to cmd.exe. The lookup reads PATH like every executable here, and a PATH without that folder — a service, a CI
      // runner, a stripped-down shell — would make the kill find nothing and leave the stalled tree running, so System32 goes FIRST on the PATH this one lookup
      // reads. First also means no earlier, user-writable folder on PATH can stand in for taskkill. The caller's own environment is not changed.
      // Exits 128 when the process is already gone, which is the outcome wanted. windowsHide: no console window opens for the kill — spawnResultSync's own lookup
      // (invocation) already hides every child's window, and it is stated here too so that the kill stays hidden whichever `run` is in use.
      run('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 15000, windowsHide: true },
        { env: withPathFirst(env, path.win32.dirname(windowsCmd(env)), 'win32') });
      endChild();
    } else {
      const listing = run('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
      const listed = listing && listing.status === 0;
      const under = listed ? descendantPids(pid, listing.stdout) : [];
      const started = listed ? startTimes(listing.stdout) : new Map();
      endChild();
      for (const descendant of under.reverse()) {
        if (!stillTheSame(descendant, started.get(descendant), run)) continue;
        try { kill(descendant, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  } catch {
    endChild();
  }
}

module.exports = {
  CMD_INERT_ARG,
  cmdArgument,
  descendantPids,
  envValue,
  forwardedProgram,
  withOptions,
  execFileAsync,
  invocation,
  killProcessTree,
  resolveExecutable,
  runSync,
  spawnProcess,
  spawnResultSync,
  spawnResultTree,
  startTimes,
  windowsCmd,
  withPathFirst,
};