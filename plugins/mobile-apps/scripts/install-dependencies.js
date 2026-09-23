#!/usr/bin/env node

/**
 * install-dependencies.js — run `npm install` for a mobile app folder as a
 * detached background job, then let a later step block on its result.
 *
 * `/create-mobile-app` starts the install as soon as the app folder exists and
 * only waits for it right before template preparation, so the download overlaps
 * requirements discovery and the planning gates instead of being charged to the
 * user up front. The template is ~540 packages: roughly 5-6 minutes on a cold npm
 * cache, which is what DEFAULT_TIMEOUT_MS is sized against.
 *
 * The background job is a detached copy of this script (`run`) rather than a
 * shell `&` job because the agent hosts that execute skills spawn a fresh shell
 * per command: a shell-backgrounded child can be torn down with its parent, and
 * capturing an exit code from it portably is not possible. A detached Node child
 * survives, works identically on Windows, and records its own exit code.
 *
 * Commands:
 *   start   — begin (or re-adopt) the install; returns immediately
 *   status  — report progress without blocking
 *   wait    — block until the install finishes, fails, or times out
 *   run     — internal: the detached worker; not called directly by skills
 *
 * Exit codes: 0 when dependencies are installed, 1 otherwise (failed, stalled,
 * timed out, never started), 2 for a bad invocation or a folder with no package.json.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { redact } = require('./redact-debug-diagnostic');

const STATE_DIR = path.join('.powernative', 'dependency-install');
const LOG_FILE = 'install.log';
const STATE_FILE = 'state.json';
const RESULT_FILE = 'result.json';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const LOG_TAIL_LINES = 40;

// `expo` is the package every other template import ultimately depends on, so its
// presence is the same install marker the skill's own gates already check for.
const INSTALL_MARKER = path.join('node_modules', 'expo');

// `--no-audit --no-fund` matches how CI installs the template and keeps the log
// limited to install progress and real failures.
const NPM_ARGS = ['install', '--no-audit', '--no-fund'];

function stateDir(projectRoot) {
  return path.join(projectRoot, STATE_DIR);
}

function statePath(projectRoot, fileName) {
  return path.join(stateDir(projectRoot), fileName);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  // `status` polls these files from another process, so publish them with a rename
  // to guarantee a reader never observes a half-written object.
  const temporary = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function dependenciesInstalled(projectRoot) {
  return fs.existsSync(path.join(projectRoot, INSTALL_MARKER));
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
    // alive after the worker died; `wait`'s timeout is the backstop for that.
    return error.code === 'EPERM';
  }
}

/**
 * Locate npm's own JS entry point next to the running node binary.
 *
 * On Windows npm ships as `npm.cmd`, and since the fix for CVE-2024-27980 Node refuses
 * to spawn a `.cmd`/`.bat` file unless it goes through a shell - which this repo's
 * process-execution rules forbid. Running `node .../npm-cli.js` sidesteps the shell
 * entirely. Every Windows Node distribution (official installer, nvm-windows, fnm)
 * keeps npm at this path beside `node.exe`.
 * See: https://nodejs.org/en/blog/vulnerability/april-2024-security-releases
 */
function npmCliPath() {
  const candidate = path.join(
    path.dirname(process.execPath),
    'node_modules', 'npm', 'bin', 'npm-cli.js',
  );
  return fs.existsSync(candidate) ? candidate : '';
}

/**
 * Run `npm install` for the project and return the spawnSync outcome.
 *
 * POSIX resolves `npm` from PATH directly; Windows goes through node + npm-cli.js for
 * the reason above. `POWER_PLATFORM_SKILLS_FAKE_NPM` is a test seam (same convention as
 * POWER_PLATFORM_SKILLS_FAKE_HTTPS) pointing at a stub CLI, so tests can exercise the
 * real detach and exit-code plumbing on every platform without downloading the
 * template's dependency tree. It is never set in normal use.
 */
function spawnNpmInstall(projectRoot, logFd) {
  const options = { cwd: projectRoot, stdio: ['ignore', logFd, logFd] };

  const fakeNpm = process.env.POWER_PLATFORM_SKILLS_FAKE_NPM || '';
  if (fakeNpm) {
    return spawnSync(process.execPath, [fakeNpm, ...NPM_ARGS], options);
  }

  if (process.platform !== 'win32') {
    return spawnSync('npm', NPM_ARGS, options);
  }

  const npmCli = npmCliPath();
  if (!npmCli) {
    return {
      error: new Error(
        'Could not find npm beside the running node binary. '
        + 'Run `npm install` in the app folder, then rerun this step.',
      ),
    };
  }
  return spawnSync(process.execPath, [npmCli, ...NPM_ARGS], options);
}

function logTail(projectRoot) {
  const logPath = statePath(projectRoot, LOG_FILE);
  if (!fs.existsSync(logPath)) return '';

  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  const tail = lines.slice(-LOG_TAIL_LINES).join('\n');
  // npm echoes its resolved registry configuration into failure output, which on a
  // private-feed setup can carry an auth token, and this tail is surfaced into agent
  // context that /report-issue may quote. The unredacted log stays on disk.
  return redact(tail, projectRoot);
}

function readStatus(projectRoot) {
  const root = path.resolve(projectRoot);
  const result = readJson(statePath(root, RESULT_FILE));
  const state = readJson(statePath(root, STATE_FILE));
  const logFile = path.join(STATE_DIR, LOG_FILE);

  if (result) {
    const succeeded = result.exitCode === 0;
    return {
      projectRoot: root,
      state: succeeded ? 'succeeded' : 'failed',
      exitCode: result.exitCode,
      startedAt: state ? state.startedAt : undefined,
      finishedAt: result.finishedAt,
      dependenciesInstalled: dependenciesInstalled(root),
      logFile,
      ...(succeeded ? {} : { logTail: logTail(root) }),
    };
  }

  if (state) {
    if (isProcessAlive(state.pid)) {
      return {
        projectRoot: root,
        state: 'running',
        pid: state.pid,
        startedAt: state.startedAt,
        dependenciesInstalled: false,
        logFile,
      };
    }
    // The worker vanished without publishing a result: the host killed it, the
    // machine slept through a shutdown, or the process was force-quit. Never report
    // this as success, even if node_modules looks partially populated.
    return {
      projectRoot: root,
      state: 'stalled',
      pid: state.pid,
      startedAt: state.startedAt,
      dependenciesInstalled: dependenciesInstalled(root),
      logFile,
      logTail: logTail(root),
    };
  }

  if (dependenciesInstalled(root)) {
    return {
      projectRoot: root,
      state: 'already-installed',
      dependenciesInstalled: true,
    };
  }

  return { projectRoot: root, state: 'not-started', dependenciesInstalled: false };
}

function startInstall(projectRoot) {
  const root = path.resolve(projectRoot);
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    const error = new Error(`No package.json in ${root}; nothing to install.`);
    error.exitCode = 2;
    throw error;
  }

  const current = readStatus(root);
  // Re-entering `start` (a resumed run, a retried step) must adopt the job in flight
  // rather than launching a second npm against the same node_modules tree.
  if (current.state === 'running' || current.state === 'already-installed') {
    return current;
  }

  fs.mkdirSync(stateDir(root), { recursive: true });
  for (const fileName of [RESULT_FILE, LOG_FILE]) {
    fs.rmSync(statePath(root, fileName), { force: true });
  }

  const worker = spawn(
    process.execPath,
    [__filename, '--working-dir', root, 'run'],
    { cwd: root, detached: true, stdio: 'ignore' },
  );
  const startedAt = new Date().toISOString();
  writeJsonAtomic(statePath(root, STATE_FILE), {
    pid: worker.pid,
    startedAt,
    command: `npm ${NPM_ARGS.join(' ')}`,
  });
  // Release the worker so this process can exit while the install keeps running.
  worker.unref();

  return {
    projectRoot: root,
    state: 'running',
    pid: worker.pid,
    startedAt,
    dependenciesInstalled: false,
    logFile: path.join(STATE_DIR, LOG_FILE),
  };
}

function runInstall(projectRoot) {
  const root = path.resolve(projectRoot);
  fs.mkdirSync(stateDir(root), { recursive: true });

  const logPath = statePath(root, LOG_FILE);
  const logFd = fs.openSync(logPath, 'a');
  let exitCode;
  try {
    const outcome = spawnNpmInstall(root, logFd);
    if (outcome.error) {
      fs.appendFileSync(logFd, `\nFailed to launch npm: ${outcome.error.message}\n`);
      // 127 is the conventional "command not found" status and distinguishes a
      // missing/unlaunchable npm from an install that ran and failed.
      exitCode = 127;
    } else if (outcome.signal) {
      fs.appendFileSync(logFd, `\nnpm install terminated by signal ${outcome.signal}\n`);
      exitCode = 1;
    } else {
      exitCode = outcome.status === null ? 1 : outcome.status;
    }
  } finally {
    fs.closeSync(logFd);
  }

  writeJsonAtomic(statePath(root, RESULT_FILE), {
    exitCode,
    finishedAt: new Date().toISOString(),
  });
  return exitCode;
}

function sleepSync(milliseconds) {
  // Synchronous sleep without a busy loop; `wait` is meant to block its caller.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForInstall(projectRoot, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const root = path.resolve(projectRoot);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const status = readStatus(root);
    if (status.state !== 'running') return status;
    if (Date.now() >= deadline) {
      return { ...status, state: 'timeout', timeoutMs, logTail: logTail(root) };
    }
    sleepSync(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

const SUCCESS_STATES = new Set(['succeeded', 'already-installed']);

function parseArgs(argv) {
  const options = { command: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--working-dir') options.workingDir = argv[++index];
    else if (argument === '--timeout-ms') options.timeoutMs = Number(argv[++index]);
    else if (!argument.startsWith('--') && !options.command) options.command = argument;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  options.workingDir = options.workingDir || process.cwd();
  options.command = options.command || 'status';
  if (!['start', 'status', 'wait', 'run'].includes(options.command)) {
    throw new Error(`Unknown command: ${options.command}`);
  }
  if (options.timeoutMs !== undefined
    && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('--timeout-ms must be a positive number of milliseconds');
  }
  return options;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === 'run') {
      process.exit(runInstall(options.workingDir) === 0 ? 0 : 1);
    }

    const status = options.command === 'start'
      ? startInstall(options.workingDir)
      : options.command === 'wait'
        ? waitForInstall(options.workingDir, options.timeoutMs || DEFAULT_TIMEOUT_MS)
        : readStatus(options.workingDir);

    process.stdout.write(`${JSON.stringify(status)}\n`);
    // `start` reports a job it just launched, so a still-running install is success
    // for that command; `status` and `wait` only succeed once npm is actually done.
    const ok = options.command === 'start'
      ? status.state === 'running' || SUCCESS_STATES.has(status.state)
      : SUCCESS_STATES.has(status.state);
    process.exit(ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exitCode || 2);
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  LOG_FILE,
  NPM_ARGS,
  RESULT_FILE,
  STATE_DIR,
  STATE_FILE,
  dependenciesInstalled,
  npmCliPath,
  readStatus,
  runInstall,
  startInstall,
  waitForInstall,
};
