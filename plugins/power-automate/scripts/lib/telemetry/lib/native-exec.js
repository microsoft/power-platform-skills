"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Starts a native command-line tool (pac) by absolute path, never by bare name.
//
// The telemetry hooks run in the user's project folder. Given a bare name,
// Node 20 on Windows looks for the executable in the working directory before
// PATH (measured: a `pac.exe` in the working directory ran; Node 22 no longer
// looks there), so a `pac.exe` left in a project would run instead of the real
// one. Resolving the name here, against absolute PATH entries only, gives the
// same answer on every Node version and platform.
//
// Only native executables are considered. These calls run without a shell, and
// Windows cannot start a .cmd or .bat that way, so a pac.cmd install is not
// found, as it was not before either.

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// A candidate the OS would actually start: a regular file and, off Windows,
// one the user may execute. Node's own lookup skips a non-executable `pac`
// earlier on PATH and keeps searching, so this does too.
function isRunnable(p, platform) {
  if (!isFile(p)) return false;
  if (platform === "win32") return true;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Windows variable names are case-insensitive. When an env object carries
// several spellings (a copied `Path` plus an added `PATH`), Node passes the
// child the lexicographically first one, so read that same one.
function envValue(env, name, platform) {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env)
    .filter((k) => k.toUpperCase() === name.toUpperCase())
    .sort()[0];
  return key === undefined ? undefined : env[key];
}

/**
 * Absolute path of a native executable found on PATH, or null. Relative PATH
 * entries (an empty entry means "the current directory" on POSIX) are skipped.
 * On Windows `.com` then `.exe` is tried whatever PATHEXT says, as Node's own
 * shell-free lookup does.
 */
function resolveNative(
  name,
  { platform = process.platform, env = process.env, exists = (p) => isRunnable(p, platform) } = {}
) {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const dirs = String(envValue(env, "PATH", platform) || "")
    .split(win ? ";" : ":")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => d && p.isAbsolute(d));
  const exts = win ? [".com", ".exe"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * execFileSync-shaped: returns stdout, and throws when the tool is not on PATH
 * (code ENOENT) or the run fails (with err.stdout attached, as execFileSync
 * does). Callers treat any throw as "no data".
 */
function runNative(name, args, options = {}, deps = {}) {
  const file = resolveNative(name, deps);
  if (!file) {
    const err = new Error(`${name} was not found on PATH`);
    err.code = "ENOENT";
    throw err;
  }
  return execFileSync(file, args, {
    encoding: options.encoding,
    timeout: options.timeout,
    stdio: options.stdio,
    windowsHide: true,
    shell: false,
  });
}

module.exports = { resolveNative, runNative };
