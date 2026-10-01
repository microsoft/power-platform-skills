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

module.exports = {
  CMD_INERT_ARG,
  cmdArgument,
  envValue,
  withOptions,
  execFileAsync,
  invocation,
  resolveExecutable,
  runSync,
  spawnProcess,
  spawnResultSync,
  windowsCmd,
  withPathFirst,
};