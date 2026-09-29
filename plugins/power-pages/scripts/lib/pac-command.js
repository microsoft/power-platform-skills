'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PAC_LOG_TAIL_BYTES = 32 * 1024;
const PAC_LOG_SCAN_CHUNK_BYTES = 16 * 1024;
const PAC_LOG_SCAN_OVERLAP_CHARS = 512;
const GUID_PATTERN_SOURCE = String.raw`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`;
const PORTAL_FILE_UPLOAD_FAILURE_PATTERN = /PortalFileContentUploadFailed/i;
const MISSING_POWERPAGE_COMPONENT_PATTERN = new RegExp(
  String.raw`Entity\s+'powerpagecomponent'\s+With\s+Id\s*=\s*\{?` +
  GUID_PATTERN_SOURCE +
  String.raw`\}?\s+Does\s+Not\s+Exist`,
  'i'
);
const AUTHENTICATION_FAILURE_PATTERN =
  /(?:Authentication failed|not authenticated|AADSTS\d+|401 Unauthorized|403 Forbidden|access token (?:has )?expired|run\s+pac\s+auth)/i;
const BLOCKED_ATTACHMENT_FAILURE_PATTERN =
  /(?:javascript[^\r\n]{0,256}attachment[^\r\n]{0,256}blocked|blocked file type[^\r\n]{0,256}\.js|blocked[^\r\n]{0,256}attachment[^\r\n]{0,256}\.js)/i;

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

function hasPacRecoveryExclusion(value) {
  const text = String(value || '');
  return AUTHENTICATION_FAILURE_PATTERN.test(text) ||
    BLOCKED_ATTACHMENT_FAILURE_PATTERN.test(text);
}

function scanPacLogDiagnostics(filePath, fsImpl = fs) {
  const flags = {
    hasPortalFileUploadFailure: false,
    hasMissingPowerpageComponent: false,
    hasRecoveryExclusion: false,
  };
  const buffer = Buffer.alloc(PAC_LOG_SCAN_CHUNK_BYTES);
  const fd = fsImpl.openSync(filePath, 'r');
  let overlap = '';
  let position = 0;

  try {
    while (true) {
      const bytesRead = fsImpl.readSync(
        fd,
        buffer,
        0,
        PAC_LOG_SCAN_CHUNK_BYTES,
        position
      );
      if (bytesRead === 0) break;
      position += bytesRead;
      const window = overlap + buffer.toString('latin1', 0, bytesRead);
      flags.hasPortalFileUploadFailure ||= PORTAL_FILE_UPLOAD_FAILURE_PATTERN.test(window);
      flags.hasMissingPowerpageComponent ||= MISSING_POWERPAGE_COMPONENT_PATTERN.test(window);
      flags.hasRecoveryExclusion ||= hasPacRecoveryExclusion(window);
      overlap = window.slice(-PAC_LOG_SCAN_OVERLAP_CHARS);
    }
  } finally {
    fsImpl.closeSync(fd);
  }

  return {
    staleManifestUploadFailure:
      flags.hasPortalFileUploadFailure &&
      flags.hasMissingPowerpageComponent &&
      !flags.hasRecoveryExclusion,
  };
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
  let diagnostics = { staleManifestUploadFailure: false };

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
    // PAC upload logs can contain:
    //   Unable to upload webfile ... <GUID> ... PortalFileContentUploadFailed
    //   ... Entity 'powerpagecomponent' With Id = <GUID> Does Not Exist
    // Repeated upload details can push the root cause before the bounded tail. Logs may
    // also contain upload tokens, so scan the full file in chunks and return only booleans.
    diagnostics = scanPacLogDiagnostics(logPath, fsImpl);
  } catch {
    // Classification is advisory and must fail closed without replacing the PAC result.
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
    diagnostics,
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
  PAC_LOG_SCAN_CHUNK_BYTES,
  PAC_LOG_TAIL_BYTES,
  commandError,
  hasPacRecoveryExclusion,
  readFileTail,
  runPac,
  scanPacLogDiagnostics,
};
