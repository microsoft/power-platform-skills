'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PAC_LOG_TAIL_BYTES = 32 * 1024;

function readFileTail(filePath, maxBytes = PAC_LOG_TAIL_BYTES, fsImpl = fs) {
  const size = fsImpl.statSync(filePath).size;
  const length = Math.min(size, maxBytes);
  if (length === 0) return '';
  const buffer = Buffer.alloc(length);
  const fd = fsImpl.openSync(filePath, 'r');
  try {
    fsImpl.readSync(fd, buffer, 0, length, size - length);
  } finally {
    fsImpl.closeSync(fd);
  }
  return buffer.toString('utf8');
}

function runPac(args, deps = {}) {
  const fsImpl = deps.fs || fs;
  const tmpRoot = deps.tmpRoot || os.tmpdir();
  let logDirectory;
  let logPath;
  let logFd;
  let error;
  let status = 0;
  let output = '';
  let commandOutput;

  try {
    logDirectory = fsImpl.mkdtempSync(path.join(tmpRoot, 'powerpages-pac-'));
    logPath = path.join(logDirectory, 'output.log');
    logFd = fsImpl.openSync(logPath, 'w');
  } catch (err) {
    if (logDirectory) {
      try {
        fsImpl.rmSync(logDirectory, { recursive: true, force: true });
      } catch {
        // Preserve the setup error; the returned failure is still actionable.
      }
    }
    return { status: 1, stdout: '', stderr: '', error: err };
  }

  const options = {
    timeout: deps.timeoutMs || 900000,
    shell: false,
    // PAC can emit more than execFileSync's maxBuffer during a code-site upload.
    // Redirect both streams to disk so Node never terminates a healthy mutation
    // because its captured output grew too large.
    // See: https://nodejs.org/api/child_process.html#maxbuffer-and-unicode
    stdio: ['ignore', logFd, logFd],
  };
  if (deps.cwd) options.cwd = deps.cwd;
  try {
    const isWindows = (deps.platform || process.platform) === 'win32';
    const command = isWindows ? 'pac.exe' : 'pac';
    if (deps.runCommand) {
      commandOutput = deps.runCommand(command, args, options);
    } else if (isWindows) {
      // PAC ships as pac.exe on Windows. Invoke it directly so paths and other
      // arguments never receive an additional cmd.exe parsing pass.
      execFileSync('pac.exe', args, options);
    } else {
      execFileSync('pac', args, options);
    }
  } catch (err) {
    status = Number.isInteger(err.status) ? err.status : 1;
    error = err;
  } finally {
    try {
      fsImpl.closeSync(logFd);
    } catch {
      // The command result remains authoritative if closing an already-closed
      // diagnostic file descriptor fails.
    }
  }

  try {
    output = readFileTail(logPath, PAC_LOG_TAIL_BYTES, fsImpl);
    if (!output && commandOutput !== undefined && commandOutput !== null) {
      output = String(commandOutput);
    }
  } catch (err) {
    if (!error) {
      status = 1;
      error = err;
    }
  } finally {
    try {
      fsImpl.rmSync(logDirectory, { recursive: true, force: true });
    } catch {
      // Diagnostic cleanup must not replace the PAC command's result.
    }
  }

  return {
    status,
    stdout: status === 0 ? output : '',
    stderr: status === 0 ? '' : output,
    ...(error ? { error } : {}),
  };
}

function commandError(step, result) {
  const detail = String(result.stderr || result.stdout || '').trim();
  if (detail) return `${step} failed: ${detail}`;
  if (result.error) return `${step} failed: ${result.error.message}`;
  return `${step} failed with exit code ${result.status}`;
}

module.exports = {
  PAC_LOG_TAIL_BYTES,
  commandError,
  readFileTail,
  runPac,
};
