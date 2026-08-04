#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LOG_DIR_PARTS = ['.powernative', 'metro-logs'];
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_MAX_TAIL_BYTES = 256 * 1024;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseArgs(argv) {
  const options = {
    command: '',
    projectRoot: process.cwd(),
    cursor: null,
    lines: DEFAULT_TAIL_LINES,
    maxBytes: DEFAULT_MAX_TAIL_BYTES,
    waitMs: 0,
  };

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    options.command = 'help';
    return options;
  }

  options.command = argv[0];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project-root') {
      options.projectRoot = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--cursor') {
      options.cursor = Number(argv[index + 1]);
      index += 1;
    } else if (argument === '--lines') {
      options.lines = Number(argv[index + 1]);
      index += 1;
    } else if (argument === '--max-bytes') {
      options.maxBytes = Number(argv[index + 1]);
      index += 1;
    } else if (argument === '--wait-ms') {
      options.waitMs = Number(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!options.projectRoot) throw new Error('--project-root cannot be empty');
  if (options.cursor !== null && (!Number.isInteger(options.cursor) || options.cursor < 0)) {
    throw new Error('--cursor must be a non-negative integer');
  }
  if (!Number.isInteger(options.lines) || options.lines < 1) {
    throw new Error('--lines must be a positive integer');
  }
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error('--max-bytes must be a positive integer');
  }
  if (!Number.isInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > 30000) {
    throw new Error('--wait-ms must be an integer from 0 to 30000');
  }

  return options;
}

function resolvePaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const logDir = path.join(root, ...LOG_DIR_PARTS);
  return { projectRoot: root, logDir };
}

function processIsAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function portListenerPids(port, options = {}) {
  if (!Number.isInteger(port) || port <= 0) return null;
  const platform = options.platform || process.platform;
  const run = options._spawnSync || spawnSync;

  if (platform === 'win32') {
    const result = run('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    if (!result || result.error || typeof result.stdout !== 'string') return null;
    const pids = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (match && Number(match[2]) === port) pids.add(Number(match[3]));
    }
    return [...pids];
  }

  const result = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (!result || result.error || typeof result.stdout !== 'string') return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function parseLogFile(filePath) {
  const base = path.basename(filePath);
  const match = base.match(/^metro-(.+)-pid-(\d+)-port-(\d+|unknown)\.log$/);
  if (!match) return null;
  let modifiedMs = 0;
  let size = 0;
  try {
    const stats = fs.statSync(filePath);
    modifiedMs = stats.mtimeMs;
    size = stats.size;
  } catch {
    return null;
  }
  return {
    logPath: filePath,
    startedAt: match[1],
    pid: Number(match[2]),
    port: match[3] === 'unknown' ? null : Number(match[3]),
    modifiedMs,
    size,
  };
}

function listLogs(projectRoot) {
  const paths = resolvePaths(projectRoot);
  let names;
  try {
    names = fs.readdirSync(paths.logDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^metro-.+-pid-\d+-port-(?:\d+|unknown)\.log$/.test(name))
    .map((name) => parseLogFile(path.join(paths.logDir, name)))
    .filter(Boolean)
    .sort((left, right) => right.modifiedMs - left.modifiedMs);
}

function resolveLog(projectRoot, options = {}) {
  const logs = listLogs(projectRoot);
  if (Number.isInteger(options.port)) {
    const exact = logs.find((log) => log.port === options.port);
    if (exact) return exact;
  }
  return logs[0] || null;
}

function resolveStatus(log, options = {}) {
  if (!log) {
    return { status: 'not-started', running: false };
  }

  const isAlive = options._isProcessAlive || processIsAlive;
  const probe = options._portListenerPids || portListenerPids;
  const processAlive = isAlive(log.pid);
  const listeners = log.port ? probe(log.port, options) : null;
  const ownsPort = !log.port || listeners === null ? null : listeners.includes(log.pid);

  let status;
  if (processAlive && ownsPort === false && listeners.length > 0) status = 'port-conflict';
  else if (processAlive) status = 'running';
  else if (listeners && listeners.length > 0) status = 'port-taken';
  else status = 'stopped';

  return {
    status,
    running: status === 'running',
    pid: log.pid,
    port: log.port,
    processAlive,
    portListeners: listeners,
    portOwnedBySession: ownsPort,
  };
}

function getStatus(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot);
  const log = resolveLog(projectRoot, options);
  const status = resolveStatus(log, options);
  return {
    ok: true,
    ...status,
    projectRoot: paths.projectRoot,
    logDir: paths.logDir,
    logPath: log ? log.logPath : null,
    logSize: log ? log.size : 0,
  };
}

function readLogBytes(logPath, start, length) {
  const descriptor = fs.openSync(logPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function tailSession(projectRoot, options = {}) {
  let status = getStatus(projectRoot, options);
  let observationComplete = options.waitMs === 0;

  if (Number.isInteger(options.cursor) && options.waitMs > 0 && status.running) {
    const deadline = Date.now() + options.waitMs;
    while (Date.now() < deadline) {
      const current = getStatus(projectRoot, options);
      if (!current.running || current.logPath !== status.logPath) {
        status = current;
        observationComplete = false;
        break;
      }
      sleepSync(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    if (Date.now() >= deadline) {
      status = getStatus(projectRoot, options);
      observationComplete = status.running;
    }
  }

  const size = status.logPath ? status.logSize : 0;
  const maxBytes = options.maxBytes || DEFAULT_MAX_TAIL_BYTES;
  let start;
  let rotationLost = false;
  if (Number.isInteger(options.cursor)) {
    start = options.cursor;
    if (start > size) {
      start = 0;
      rotationLost = true;
    }
  } else {
    start = Math.max(0, size - maxBytes);
  }

  const readLength = Math.min(maxBytes, Math.max(0, size - start));
  const buffer = readLength > 0 && status.logPath && fs.existsSync(status.logPath)
    ? readLogBytes(status.logPath, start, readLength)
    : Buffer.alloc(0);
  let output = buffer.toString('utf8');
  if (!Number.isInteger(options.cursor)) {
    const lines = output.split(/\r?\n/);
    output = lines.slice(-1 * (options.lines || DEFAULT_TAIL_LINES) - 1).join('\n');
  }

  return {
    ...status,
    cursor: start,
    nextCursor: start + buffer.length,
    truncated: rotationLost || start + buffer.length < size,
    rotationLost,
    observationComplete: observationComplete && status.running,
    output,
  };
}

function printHelp() {
  process.stdout.write(
    'Usage:\n' +
      '  node metro-session.js status [--project-root <dir>]\n' +
      '  node metro-session.js tail   [--project-root <dir>] [--cursor <bytes>] [--wait-ms <n>] [--lines <n>] [--max-bytes <n>]\n'
  );
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    printHelp();
    return;
  }

  if (options.command === 'status') {
    printJson(getStatus(options.projectRoot, options));
  } else if (options.command === 'tail') {
    printJson(tailSession(options.projectRoot, options));
  } else {
    printHelp();
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  getStatus,
  listLogs,
  parseArgs,
  parseLogFile,
  portListenerPids,
  processIsAlive,
  readLogBytes,
  resolveLog,
  resolvePaths,
  resolveStatus,
  tailSession,
};
