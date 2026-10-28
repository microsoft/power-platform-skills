'use strict';
// A fake `pac` for tests that run a script in a REAL process: an executable named `pac` in a folder of its own, which the test puts alone on PATH.
// A script finds it the way it finds the real one — lib/process-runner.js resolves `pac` against PATH to an absolute file and starts it with no shell
// — so what the test sees is what a machine with that pac would see: the arguments as the runner passed them, and an exit status.
//
//   Windows  pac.cmd, a batch shim that forwards %* to the program, reached through cmd.exe exactly as a pac that is a launcher script is
//   other    an executable `pac` shell script
// With `launcher: 'forwarder'` (Windows only) pac is installed the way the Windows MSI installs it: pac.cmd is the two-line launcher
//   @echo off
//   "%~dp0pac.launcher.exe" %*
// beside a native `pac.launcher.exe`, which the process runner recognises as a plain forwarder and starts DIRECTLY, with no cmd.exe between. The native program
// here is node.exe itself (a copy), told by an environment variable to `--require` helpers/fake-pac-program.js, which answers for pac and exits
// before node looks for the script its first argument would otherwise name.
// helpers/fake-pac-program.js is what runs; the configuration is a JSON file (see that file).
const fs = require('node:fs');
const path = require('node:path');

const PROGRAM = path.resolve(__dirname, 'fake-pac-program.js');

// A COPY, never a hard link: Windows refuses (EPERM) to delete any name of an executable that is running, and the test runner is running this very node.exe,
// so a link to it could never be removed with the rest of the run's folder.
function copyProgram(from, to) {
  fs.copyFileSync(from, to);
}

/**
 * Installs a fake pac in `dir` (which must exist) and returns what a test needs to use it.
 * @param {string} dir
 * @param {{ responses: object[], launcher?: 'forwarder' }} config
 */
function installFakePac(dir, config) {
  const log = path.join(dir, 'pac-calls.jsonl');
  const configPath = path.join(dir, 'pac-config.json');
  fs.writeFileSync(configPath, JSON.stringify({ log, responses: config.responses }));
  const env = {};
  if (process.platform === 'win32' && config.launcher === 'forwarder') {
    fs.writeFileSync(path.join(dir, 'pac.cmd'), '@echo off\r\n"%~dp0pac.launcher.exe" %*\r\n', 'utf8');
    copyProgram(process.execPath, path.join(dir, 'pac.launcher.exe'));
    // Inside double quotes NODE_OPTIONS reads a backslash as an escape, which JSON.stringify's doubled backslashes satisfy.
    env.NODE_OPTIONS = `--require=${JSON.stringify(PROGRAM)}`;
  } else if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'pac.cmd'), `@"${process.execPath}" "${PROGRAM}" %*\r\n`, 'utf8');
  } else {
    const file = path.join(dir, 'pac');
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${PROGRAM}" "$@"\n`, 'utf8');
    fs.chmodSync(file, 0o755);
  }
  return {
    dir,
    configPath,
    env,
    // Every call the program has seen, in order: { args, snapshots }.
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
  };
}

/**
 * `base` with PATH set to `onlyDir` and nothing else — on Windows every spelling of the variable is dropped first, because Node forwards the
 * lexicographically first of `Path`/`PATH`, and an ambient `pac` or `az` further along the path would otherwise answer. An empty folder as
 * `onlyDir` is a machine with no pac.
 */
function envWithOnlyOnPath(base, onlyDir, extra = {}) {
  const env = { ...base };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = onlyDir;
  return { ...env, ...extra };
}

module.exports = { installFakePac, envWithOnlyOnPath };
