#!/usr/bin/env node

/**
 * Cross-host Metro session manager.
 *
 * Skills cannot rely on a host terminal ID surviving a VS Code/Claude restart,
 * and different hosts expose different terminal-output tools. This wrapper owns
 * Metro as a detached process and persists its sanitized output under the app's
 * already-ignored `.expo/` directory so every host can inspect the same state.
 *
 * Usage:
 *   node metro-session.js start  [--project-root <dir>] [--clear]
 *   node metro-session.js status [--project-root <dir>]
 *   node metro-session.js tail   [--project-root <dir>] [--cursor <bytes>] [--lines <n>]
 *   node metro-session.js stop   [--project-root <dir>]
 *   node metro-session.js clean  [--project-root <dir>] [--force]
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const STATE_SCHEMA_VERSION = 1;
const SESSION_DIR_PARTS = ['.expo', 'metro-session'];
const STATE_FILE = 'state.json';
const LOG_FILE = 'metro.log';
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_MAX_TAIL_BYTES = 256 * 1024;
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 2000;
const HEARTBEAT_STALE_MS = 15000;
const STARTUP_GRACE_MS = 15000;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;
const DEFAULT_MAX_PENDING_LINE_BYTES = 1024 * 1024;
const OWNERSHIP_RECHECK_MS = HEARTBEAT_INTERVAL_MS + 750;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseArgs(argv) {
  const options = {
    command: '',
    projectRoot: process.cwd(),
    clear: false,
    force: false,
    cursor: null,
    lines: DEFAULT_TAIL_LINES,
    maxBytes: DEFAULT_MAX_TAIL_BYTES,
    waitReadyMs: 1500,
    waitMs: 0,
    generation: null,
    sessionId: '',
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
    } else if (argument === '--wait-ready-ms') {
      options.waitReadyMs = Number(argv[index + 1]);
      index += 1;
    } else if (argument === '--wait-ms') {
      options.waitMs = Number(argv[index + 1]);
      index += 1;
    } else if (argument === '--generation') {
      options.generation = Number(argv[index + 1]);
      index += 1;
    } else if (argument === '--session-id') {
      options.sessionId = argv[index + 1] || '';
      index += 1;
    } else if (argument === '--clear') {
      options.clear = true;
    } else if (argument === '--force') {
      options.force = true;
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
  if (!Number.isInteger(options.waitReadyMs) || options.waitReadyMs < 0 || options.waitReadyMs > 30000) {
    throw new Error('--wait-ready-ms must be an integer from 0 to 30000');
  }
  if (!Number.isInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > 30000) {
    throw new Error('--wait-ms must be an integer from 0 to 30000');
  }
  if (options.generation !== null && (!Number.isInteger(options.generation) || options.generation < 0)) {
    throw new Error('--generation must be a non-negative integer');
  }

  return options;
}

function resolvePaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const sessionDir = path.join(root, ...SESSION_DIR_PARTS);
  const lockDir = path.join(root, '.expo', 'metro-session-locks');
  return {
    projectRoot: root,
    sessionDir,
    lockDir,
    statePath: path.join(sessionDir, STATE_FILE),
    logPath: path.join(sessionDir, LOG_FILE),
    stateLockPath: path.join(lockDir, 'state.lock'),
    lifecycleLockPath: path.join(lockDir, 'lifecycle.lock'),
  };
}

function ensureProject(projectRoot) {
  const packagePath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(packagePath)) {
    throw new Error(`No package.json found at project root: ${projectRoot}`);
  }
}

function ensureSessionDir(paths) {
  fs.mkdirSync(paths.sessionDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(paths.sessionDir, 0o700); } catch { /* Windows or restricted filesystem */ }
}

function readJson(filePath, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      if (!fs.existsSync(filePath) || attempt === attempts - 1) return null;
      sleepSync(5);
    }
  }
  return null;
}

function readState(paths) {
  const state = readJson(paths.statePath);
  if (!state || state.schemaVersion !== STATE_SCHEMA_VERSION) return null;
  return state;
}

function withDirectoryLock(lockPath, callback, options = {}) {
  const timeoutMs = options.timeoutMs || LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs || LOCK_STALE_MS;
  const isAlive = options._isProcessAlive || processIsAlive;
  const wait = options._sleepSync || sleepSync;
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();
  const reclaimPath = `${lockPath}.reclaim`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    // A stale-owner reclaimer temporarily blocks all normal acquisitions. This
    // closes the race where two contenders both observe a dead owner and one
    // accidentally removes the other's newly acquired live lock.
    if (fs.existsSync(reclaimPath)) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for stale-lock recovery: ${path.basename(reclaimPath)}. ` +
          'The recovery owner may have crashed; inspect this directory before removing it.'
        );
      }
      wait(10);
      continue;
    }

    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(
        path.join(lockPath, 'owner.json'),
        `${JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
        { mode: 0o600 }
      );
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;

      let stale = false;
      try {
        const owner = readJson(path.join(lockPath, 'owner.json'), 1);
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        // Never displace a live owner solely because a laptop suspended or an
        // operation exceeded an arbitrary duration. A missing/corrupt owner is
        // removable only after the stale window; a dead owner is safe to reap.
        stale = owner && Number.isInteger(owner.pid)
          ? !isAlive(owner.pid)
          : age > staleMs;
      } catch {
        // The owner released between mkdir and stat; retry immediately.
        continue;
      }
      if (stale) {
        const reclaimToken = crypto.randomUUID();
        try {
          fs.mkdirSync(reclaimPath);
          fs.writeFileSync(
            path.join(reclaimPath, 'owner.json'),
            `${JSON.stringify({ token: reclaimToken, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
            { mode: 0o600 }
          );

          // Re-read only after winning the reclaim mutex. Every implementation
          // contender checks this mutex before normal acquisition, so the main
          // lock cannot change underneath this validation/removal sequence.
          const currentOwner = readJson(path.join(lockPath, 'owner.json'), 1);
          let stillStale = false;
          try {
            const age = Date.now() - fs.statSync(lockPath).mtimeMs;
            stillStale = currentOwner && Number.isInteger(currentOwner.pid)
              ? !isAlive(currentOwner.pid)
              : age > staleMs;
          } catch {
            stillStale = false;
          }
          if (stillStale) {
            fs.rmSync(lockPath, { recursive: true, force: true });
          }
        } catch (error) {
          if (!error || error.code !== 'EEXIST') throw error;
        } finally {
          const reclaimOwner = readJson(path.join(reclaimPath, 'owner.json'), 1);
          if (reclaimOwner && reclaimOwner.token === reclaimToken) {
            fs.rmSync(reclaimPath, { recursive: true, force: true });
          }
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for session lock: ${path.basename(lockPath)}`);
      }
      wait(10);
    }
  }

  try {
    return callback();
  } finally {
    const owner = readJson(path.join(lockPath, 'owner.json'), 1);
    // A displaced/expired owner must never remove a successor's lock.
    if (owner && owner.token === token) {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }
}

function writeStateFile(paths, state) {
  const temporaryPath = `${paths.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, paths.statePath);
}

function writeState(paths, state) {
  ensureSessionDir(paths);
  return withDirectoryLock(paths.stateLockPath, () => writeStateFile(paths, state));
}

function updateState(paths, patch, expectedSessionId = '') {
  if (expectedSessionId) {
    return withDirectoryLock(paths.stateLockPath, () => {
      const current = readState(paths) || {};
      if (current.sessionId !== expectedSessionId) return current;
      ensureSessionDir(paths);
      const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
      writeStateFile(paths, next);
      return next;
    });
  }
  ensureSessionDir(paths);
  return withDirectoryLock(paths.stateLockPath, () => {
    const current = readState(paths) || {};
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    writeStateFile(paths, next);
    return next;
  });
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

function timestampAge(timestamp, now = Date.now()) {
  const value = Date.parse(timestamp || '');
  return Number.isFinite(value) ? Math.max(0, now - value) : Number.POSITIVE_INFINITY;
}

function stateHasFreshHeartbeat(state, isAlive = processIsAlive, now = Date.now()) {
  if (!state) return false;
  const processAlive = isAlive(Number(state.runnerPid)) || isAlive(Number(state.metroPid));
  if (!processAlive) return false;
  return timestampAge(state.heartbeatAt, now) <= HEARTBEAT_STALE_MS;
}

function stateBlocksDuplicateStart(state, isAlive = processIsAlive, now = Date.now()) {
  if (stateHasFreshHeartbeat(state, isAlive, now)) return true;
  // The parent writes `starting` before the runner can publish its first
  // heartbeat. This grace suppresses duplicate starts only; it never authorizes
  // stop/kill operations.
  return Boolean(
    state &&
    state.status === 'starting' &&
    isAlive(Number(state.runnerPid)) &&
    timestampAge(state.startedAt, now) <= STARTUP_GRACE_MS
  );
}

function confirmOwnedProcess(paths, state, options = {}) {
  const isAlive = options._isProcessAlive || processIsAlive;
  const now = options._now || Date.now();
  if (stateHasFreshHeartbeat(state, isAlive, now)) return state;
  if (!state || !(isAlive(Number(state.runnerPid)) || isAlive(Number(state.metroPid)))) {
    return null;
  }

  // A machine sleep can make an otherwise healthy heartbeat look stale. Give
  // the runner one interval to refresh. A recycled unrelated PID cannot update
  // this session's heartbeat and therefore still fails ownership confirmation.
  const recheckMs = Object.hasOwn(options, '_ownershipRecheckMs')
    ? options._ownershipRecheckMs
    : OWNERSHIP_RECHECK_MS;
  if (recheckMs > 0) (options._sleepSync || sleepSync)(recheckMs);
  const refreshed = readState(paths);
  if (!refreshed || refreshed.sessionId !== state.sessionId) return null;
  return stateHasFreshHeartbeat(refreshed, isAlive, Date.now()) ? refreshed : null;
}

function stripAnsi(value) {
  // Metro uses ANSI color and cursor-control sequences. They are useful in a
  // terminal but make persisted logs difficult to parse across hosts.
  return String(value).replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '');
}

const SENSITIVE_JSON_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'clientsecret',
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'apikey',
  'accountkey',
  'sharedaccesskey',
]);

function normalizeSensitiveKey(value) {
  return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function redactStructuredValue(value, depth = 0) {
  if (depth > 4) return { value, changed: false };

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = redactStructuredValue(item, depth + 1);
      changed = changed || result.changed;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }

  if (value && typeof value === 'object') {
    let changed = false;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      if (SENSITIVE_JSON_KEYS.has(normalizeSensitiveKey(key))) {
        next[key] = '[REDACTED]';
        changed = true;
        continue;
      }
      const result = redactStructuredValue(item, depth + 1);
      next[key] = result.value;
      changed = changed || result.changed;
    }
    return { value: changed ? next : value, changed };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !['{', '[', '"'].includes(trimmed[0])) {
      return { value, changed: false };
    }
    try {
      const parsed = JSON.parse(trimmed);
      const result = redactStructuredValue(parsed, depth + 1);
      return result.changed
        ? { value: JSON.stringify(result.value), changed: true }
        : { value, changed: false };
    } catch {
      return { value, changed: false };
    }
  }

  return { value, changed: false };
}

function redactStructuredJsonLines(value) {
  return String(value).replace(/[^\r\n]+/g, (line) => {
    const leading = line.match(/^\s*/)[0];
    const payload = line.slice(leading.length);
    if (!payload) return line;
    try {
      const parsed = JSON.parse(payload);
      const result = redactStructuredValue(parsed);
      return result.changed ? `${leading}${JSON.stringify(result.value)}` : line;
    } catch {
      return line;
    }
  });
}

function redactAuthorizationLines(value) {
  return String(value).replace(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g, (line) => {
    // Authorization values appear in plain headers, JSON, nested serialized
    // JSON, and arbitrary logger prefixes. Once a physical line contains an
    // Authorization key/value delimiter, preserving fragments is not worth the
    // credential-leak risk: replace the complete line and retain only a marker.
    const hasAuthorizationValue =
      /authorization/i.test(line) &&
      /authorization(?:\\*["'])*\s*[:=]/i.test(line);
    if (!hasAuthorizationValue) return line;
    const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : line.endsWith('\r') ? '\r' : '';
    return `[metro-session] [REDACTED_AUTHORIZATION_LINE]${ending}`;
  });
}

function redactLogText(value) {
  let output = redactAuthorizationLines(redactStructuredJsonLines(stripAnsi(value)));

  // Keep diagnostic labels while replacing only credential values. Examples:
  //   Authorization: Bearer eyJ...
  //   client_secret=abc...
  //   https://host/path?sig=abc&other=value
  // Double-serialized forms first, e.g. {\"Authorization\":\"Basic ...\"}
  // or Authorization: \"Basic ...\". Replace the entire logical value so
  // escaped quotes inside credentials cannot terminate redaction early.
  output = output.replace(
    /\\(["'])(?:Proxy-)?Authorization\\\1\s*:\s*\\(["'])(?:(?:\\.)|[^\\\r\n])*?\\\2/gi,
    'Authorization: [REDACTED]'
  );
  output = output.replace(
    /\b(?:Proxy-)?Authorization\s*:\s*\\(["'])(?:(?:\\.)|[^\\\r\n])*?\\\1/gi,
    'Authorization: [REDACTED]'
  );
  output = output.replace(
    /(["'])((?:Proxy-)?Authorization)\1(\s*:\s*)(["'])([A-Za-z][A-Za-z0-9_-]*)(?:\s+)(?:(?:\\.)|[^\\\r\n])*?\4/gi,
    '$1$2$1$3$4$5 [REDACTED]$4'
  );
  output = output.replace(
    /(["'])((?:Proxy-)?Authorization)\1(\s*:\s*)(["'])(?:(?:\\.)|[^\\\r\n])*?\4/gi,
    '$1$2$1$3$4[REDACTED]$4'
  );
  output = output.replace(
    /\b((?:Proxy-)?Authorization)(\s*:\s*)(["'])(?:(?:\\.)|[^\\\r\n])*?\3/gi,
    '$1$2$3[REDACTED]$3'
  );
  output = output.replace(
    /\b((?:Proxy-)?Authorization)(\s*:\s*)([A-Za-z][A-Za-z0-9_-]*)(?:\s+)[^\r\n]+/gi,
    '$1$2$3 [REDACTED]'
  );
  output = output.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]');
  output = output.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]');
  output = output.replace(
    /(["']?)(client[_-]?secret|password|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|accountkey|sharedaccesskey)\1(\s*[:=]\s*)(["'])(?:(?:\\.)|[^\\\r\n])*?\4/gi,
    '$1$2$1$3$4[REDACTED]$4'
  );
  output = output.replace(
    /(["']?)(client[_-]?secret|password|token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|accountkey|sharedaccesskey)\1(\s*[:=]\s*)[^\s,"';&]+/gi,
    '$1$2$1$3[REDACTED]'
  );
  output = output.replace(
    /([?&](?:sig|se|sp|sv|token|access_token|code|client_secret)=)[^&#\s]+/gi,
    '$1[REDACTED]'
  );
  output = output.replace(/\b(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,})\b/g, '[REDACTED_KEY]');

  return output;
}

function appendSanitized(paths, value, options = {}) {
  const sanitized = options.alreadySanitized ? String(value) : redactLogText(value);
  const persist = () => {
    if (options.sessionId) {
      const state = readState(paths);
      if (!state || state.sessionId !== options.sessionId) return '';
    }
    ensureSessionDir(paths);
    fs.appendFileSync(paths.logPath, sanitized, { encoding: 'utf8', mode: 0o600 });
    return sanitized;
  };

  return options.sessionId
    ? withDirectoryLock(paths.stateLockPath, persist)
    : persist();
}

function createSanitizedStreamWriter(paths, options = {}) {
  let pending = '';
  let discardingOversizedLine = false;
  const maxPendingBytes = options.maxPendingBytes || DEFAULT_MAX_PENDING_LINE_BYTES;

  function persist(value) {
    if (!value) return '';
    const sanitized = redactLogText(value);
    return appendSanitized(paths, sanitized, {
      alreadySanitized: true,
      sessionId: options.sessionId || '',
    });
  }

  function boundCompleteLines(value) {
    const lines = String(value).match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || [];
    return lines.map((line) => {
      const byteLength = Buffer.byteLength(line, 'utf8');
      return byteLength > maxPendingBytes
        ? `[metro-session] [TRUNCATED_LOG_LINE bytes=${byteLength}]\n`
        : line;
    }).join('');
  }

  return {
    write(value) {
      let incoming = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
      if (discardingOversizedLine) {
        const newline = incoming.search(/[\r\n]/);
        if (newline < 0) return '';
        incoming = incoming.slice(newline + 1);
        discardingOversizedLine = false;
      }

      pending += incoming;
      const lastNewline = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
      if (lastNewline < 0) {
        if (Buffer.byteLength(pending, 'utf8') <= maxPendingBytes) return '';
        const length = Buffer.byteLength(pending, 'utf8');
        pending = '';
        discardingOversizedLine = true;
        return persist(`[metro-session] [TRUNCATED_UNTERMINATED_LOG_LINE bytes=${length}]\n`);
      }

      const complete = pending.slice(0, lastNewline + 1);
      pending = pending.slice(lastNewline + 1);
      let persisted = persist(boundCompleteLines(complete));
      if (Buffer.byteLength(pending, 'utf8') > maxPendingBytes) {
        const length = Buffer.byteLength(pending, 'utf8');
        pending = '';
        discardingOversizedLine = true;
        persisted += persist(`[metro-session] [TRUNCATED_UNTERMINATED_LOG_LINE bytes=${length}]\n`);
      }
      return persisted;
    },
    flush() {
      const remaining = pending;
      pending = '';
      discardingOversizedLine = false;
      return persist(remaining);
    },
    pendingLength() {
      return pending.length;
    },
  };
}

function rotateLog(paths, maxBytes = DEFAULT_MAX_LOG_BYTES, options = {}) {
  const rotate = () => {
    const state = options.sessionId ? readState(paths) : null;
    if (options.sessionId && (!state || state.sessionId !== options.sessionId)) return null;
    if (!fs.existsSync(paths.logPath)) return null;
    const stats = fs.statSync(paths.logPath);
    if (stats.size < maxBytes) return null;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedPath = path.join(paths.sessionDir, `metro.${stamp}.log`);
    // Keep the active path present so tail readers never race a rename. The
    // generation counter tells cursored readers that bytes in the previous file
    // may have been missed; they must not call that observation interval clean.
    fs.copyFileSync(paths.logPath, rotatedPath);
    fs.truncateSync(paths.logPath, 0);

    if (options.sessionId) {
      const next = {
        ...state,
        logGeneration: Number(state.logGeneration || 0) + 1,
        lastRotatedLog: rotatedPath,
        updatedAt: new Date().toISOString(),
      };
      writeStateFile(paths, next);
    }
    return rotatedPath;
  };

  return options.sessionId
    ? withDirectoryLock(paths.stateLockPath, rotate)
    : rotate();
}

function resolveExpoCli(projectRoot) {
  let packagePath;
  try {
    packagePath = require.resolve('expo/package.json', { paths: [projectRoot] });
  } catch {
    throw new Error('Expo is not installed in this project. Run npm install first.');
  }

  const expoPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const binEntry = typeof expoPackage.bin === 'string'
    ? expoPackage.bin
    : expoPackage.bin && (expoPackage.bin.expo || Object.values(expoPackage.bin)[0]);
  if (!binEntry) throw new Error('The installed Expo package does not declare a CLI entry point.');

  const cliPath = path.resolve(path.dirname(packagePath), binEntry);
  if (!fs.existsSync(cliPath)) throw new Error(`Expo CLI entry point is missing: ${cliPath}`);
  return cliPath;
}

function markStaleIfNeeded(paths, state, options = {}) {
  if (!state || !['starting', 'running', 'stopping', 'stop-failed'].includes(state.status)) return state;
  const isAlive = options._isProcessAlive || processIsAlive;
  if (stateBlocksDuplicateStart(state, isAlive, options._now || Date.now())) return state;
  const owned = confirmOwnedProcess(paths, state, options);
  if (owned) return owned;

  return updateState(paths, {
    status: 'stale',
    stale: true,
    stoppedAt: new Date().toISOString(),
    reason: 'recorded Metro processes are no longer running',
  }, state.sessionId);
}

function startSession(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot);
  ensureProject(paths.projectRoot);
  ensureSessionDir(paths);

  const initial = withDirectoryLock(paths.lifecycleLockPath, () => startSessionLocked(paths, options), {
    timeoutMs: options.startLockTimeoutMs || LOCK_TIMEOUT_MS,
    _isProcessAlive: options._isProcessAlive,
    _sleepSync: options._sleepSync,
  });

  if (
    !options._spawn &&
    options.waitReadyMs !== 0 &&
    !initial.alreadyRunning &&
    initial.sessionId
  ) {
    const deadline = Date.now() + options.waitReadyMs;
    while (Date.now() < deadline) {
      const current = readState(paths);
      if (
        current &&
        current.sessionId === initial.sessionId &&
        (current.metroUrl || ['failed', 'stopped'].includes(current.status))
      ) break;
      sleepSync(25);
    }
  }

  return {
    ...initial,
    ...(readState(paths) || {}),
    statePath: paths.statePath,
    logPath: paths.logPath,
  };
}

function startSessionLocked(paths, options = {}) {

  const isAlive = options._isProcessAlive || processIsAlive;
  const existing = markStaleIfNeeded(paths, readState(paths), options);
  if (stateBlocksDuplicateStart(existing, isAlive, options._now || Date.now())) {
    return {
      ok: true,
      alreadyRunning: true,
      ...existing,
      statePath: paths.statePath,
      logPath: paths.logPath,
    };
  }

  rotateLog(paths, options.maxLogBytes || DEFAULT_MAX_LOG_BYTES);
  const sessionId = crypto.randomUUID();
  const spawnImpl = options._spawn || spawn;
  const runner = spawnImpl(
    process.execPath,
    [
      __filename,
      '__run',
      '--project-root',
      paths.projectRoot,
      '--session-id',
      sessionId,
      ...(options.clear ? ['--clear'] : []),
    ],
    {
      cwd: paths.projectRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env },
    }
  );

  if (!runner || !Number.isInteger(runner.pid)) {
    throw new Error('Failed to launch the Metro session runner.');
  }

  const now = new Date().toISOString();
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    sessionId,
    status: 'starting',
    stale: false,
    projectRoot: paths.projectRoot,
    runnerPid: runner.pid,
    metroPid: null,
    startedAt: now,
    updatedAt: now,
    stoppedAt: null,
    clear: Boolean(options.clear),
    metroUrl: null,
    logGeneration: 0,
    logPath: paths.logPath,
  };
  writeState(paths, state);
  if (typeof runner.unref === 'function') runner.unref();

  return {
    ok: true,
    alreadyRunning: false,
    ...(readState(paths) || state),
    statePath: paths.statePath,
    logPath: paths.logPath,
  };
}

function getStatus(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot);
  const state = markStaleIfNeeded(
    paths,
    readState(paths),
    options
  );
  if (!state) {
    return {
      ok: true,
      status: 'not-started',
      running: false,
      projectRoot: paths.projectRoot,
      statePath: paths.statePath,
      logPath: paths.logPath,
    };
  }

  return {
    ok: true,
    ...state,
    running: ['starting', 'running', 'stopping', 'stop-failed'].includes(state.status) && stateBlocksDuplicateStart(
      state,
      options._isProcessAlive || processIsAlive
    ),
    statePath: paths.statePath,
    logPath: paths.logPath,
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
  const paths = resolvePaths(projectRoot);
  const initialStatus = getStatus(projectRoot, options);
  const observedSessionId = initialStatus.sessionId || null;
  let observationComplete = options.waitMs === 0;
  let transitionDetected = false;
  if (Number.isInteger(options.cursor) && options.waitMs > 0 && initialStatus.running) {
    const now = options._nowFn || Date.now;
    const deadline = now() + options.waitMs;
    const wait = options._sleepSync || sleepSync;
    while (now() < deadline) {
      const currentState = readState(paths);
      const currentGeneration = Number.isInteger(currentState && currentState.logGeneration)
        ? currentState.logGeneration
        : 0;
      let currentSize = 0;
      try { currentSize = fs.statSync(paths.logPath).size; } catch { /* rotation/startup window */ }
      const terminalState = Boolean(
        (currentState && observedSessionId && currentState.sessionId !== observedSessionId) ||
        !currentState ||
        !['starting', 'running'].includes(currentState.status)
      );
      const dataAvailable = Boolean(
        (Number.isInteger(options.generation) && currentGeneration !== options.generation) ||
        currentSize > options.cursor
      );
      if (terminalState) {
        transitionDetected = true;
        break;
      }
      // Even when data arrives, finish the full observation interval before a
      // caller may count the cycle clean. Keep waiting without changing the
      // caller's byte cursor; all bytes are read once after the interval.
      void dataAvailable;
      wait(Math.min(50, Math.max(1, deadline - now())));
    }
    observationComplete = !transitionDetected && now() >= deadline;
  }

  return withDirectoryLock(paths.stateLockPath, () => {
    const state = readState(paths);
    const sameSession = Boolean(state && observedSessionId && state.sessionId === observedSessionId);
    const running = Boolean(state && ['starting', 'running'].includes(state.status));
    if (!sameSession || !running) observationComplete = false;

    const status = state
      ? {
          ok: true,
          ...state,
          running,
          statePath: paths.statePath,
          logPath: paths.logPath,
        }
      : {
          ok: true,
          status: 'not-started',
          running: false,
          projectRoot: paths.projectRoot,
          statePath: paths.statePath,
          logPath: paths.logPath,
        };
    const generation = Number.isInteger(state && state.logGeneration) ? state.logGeneration : 0;
    const callerGeneration = Number.isInteger(options.generation) ? options.generation : generation;
    const generationBehind = callerGeneration !== generation;
    let size = 0;
    try { size = fs.statSync(paths.logPath).size; } catch { /* no active log */ }

    const maxBytes = options.maxBytes || DEFAULT_MAX_TAIL_BYTES;
    let start;
    let truncated = generationBehind;
    if (generationBehind) {
      start = 0;
    } else if (Number.isInteger(options.cursor)) {
      start = options.cursor;
      if (start > size) {
        start = 0;
        truncated = true;
      }
    } else {
      start = Math.max(0, size - maxBytes);
      truncated = start > 0;
    }

    const readLength = Math.min(maxBytes, Math.max(0, size - start));
    const buffer = readLength > 0 && fs.existsSync(paths.logPath)
      ? readLogBytes(paths.logPath, start, readLength)
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
      generation,
      nextGeneration: generation,
      truncated: truncated || start + buffer.length < size,
      rotationLost: generationBehind,
      observationComplete,
      output,
    };
  });
}

function killProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const platform = options.platform || process.platform;
  const isAlive = options._isProcessAlive || processIsAlive;
  const kill = options._kill || process.kill;
  const spawnSyncImpl = options._spawnSync || spawnSync;
  if (!isAlive(pid)) return false;

  if (platform === 'win32') {
    const result = spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    if (result.status !== 0) return false;
    const deadline = Date.now() + 1500;
    while (isAlive(pid) && Date.now() < deadline) sleepSync(25);
    return !isAlive(pid);
  }

  try {
    // The runner is detached and therefore leads the process group containing
    // Expo and Metro workers. Kill the group so no orphan watcher survives.
    kill(-pid, 'SIGTERM');
  } catch {
    try {
      kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
  }

  const deadline = Date.now() + 1500;
  while (isAlive(pid) && Date.now() < deadline) sleepSync(25);
  if (isAlive(pid)) {
    try {
      kill(-pid, 'SIGKILL');
    } catch {
      try { kill(pid, 'SIGKILL'); } catch { /* best effort */ }
    }
  }
  const finalDeadline = Date.now() + 500;
  while (isAlive(pid) && Date.now() < finalDeadline) sleepSync(25);
  return !isAlive(pid);
}

function stopSession(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot);
  return withDirectoryLock(
    paths.lifecycleLockPath,
    () => stopSessionLocked(paths, options),
    {
      _isProcessAlive: options._isProcessAlive,
      _sleepSync: options._sleepSync,
    }
  );
}

function stopSessionLocked(paths, options = {}) {
  const state = readState(paths);
  if (!state) {
    return { ok: true, status: 'not-started', stopped: false, projectRoot: paths.projectRoot };
  }

  const isAlive = options._isProcessAlive || processIsAlive;
  const ownedState = confirmOwnedProcess(paths, state, options);
  const ownsLiveProcess = Boolean(ownedState);
  const signaledRunner = ownsLiveProcess
    ? killProcessTree(Number(state.runnerPid), options)
    : false;
  const signaledMetro = ownsLiveProcess && isAlive(Number(state.metroPid))
    ? killProcessTree(Number(state.metroPid), options)
    : false;
  const runnerAlive = ownsLiveProcess && isAlive(Number(state.runnerPid));
  const metroAlive = ownsLiveProcess && isAlive(Number(state.metroPid));
  const fullyStopped = ownsLiveProcess && !runnerAlive && !metroAlive;
  const next = updateState(paths, {
    status: fullyStopped ? 'stopped' : ownsLiveProcess ? 'stop-failed' : 'stale',
    stale: !ownsLiveProcess,
    stoppedAt: fullyStopped ? new Date().toISOString() : null,
    reason: fullyStopped
      ? 'stopped by metro-session command'
      : ownsLiveProcess
        ? `failed to stop Metro process tree (runnerAlive=${runnerAlive}, metroAlive=${metroAlive})`
      : 'session heartbeat is stale; recorded PIDs were not signaled',
  }, state.sessionId);

  return {
    ok: true,
    ...next,
    stopped: fullyStopped,
    signalAttempted: signaledRunner || signaledMetro,
    runnerAlive,
    metroAlive,
    statePath: paths.statePath,
    logPath: paths.logPath,
  };
}

function cleanSession(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot);
  return withDirectoryLock(
    paths.lifecycleLockPath,
    () => cleanSessionLocked(paths, options),
    {
      _isProcessAlive: options._isProcessAlive,
      _sleepSync: options._sleepSync,
    }
  );
}

function cleanSessionLocked(paths, options = {}) {
  const state = readState(paths);
  const ownedState = confirmOwnedProcess(paths, state, options);
  if (ownedState && !options.force) {
    throw new Error('Metro is still running. Run stop first, or use clean --force.');
  }
  if (ownedState && options.force) {
    const stopped = stopSessionLocked(paths, options);
    if (!stopped.stopped) {
      throw new Error('Metro could not be stopped; session state and logs were preserved.');
    }
  }

  withDirectoryLock(paths.stateLockPath, () => {
    // Conditional worker updates use this same external state lock. Removing the
    // session directory while holding it guarantees a delayed heartbeat cannot
    // pass its session-id check and recreate state after cleanup.
    fs.rmSync(paths.sessionDir, { recursive: true, force: true });
  });
  return { ok: true, status: 'clean', projectRoot: paths.projectRoot, removed: paths.sessionDir };
}

function extractMetroUrl(value) {
  const match = String(value).match(/(?:^|\n)\s*›?\s*Metro:\s*(\S+)/);
  return match ? match[1] : null;
}

function waitForSessionState(paths, sessionId, timeoutMilliseconds = 5000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = readState(paths);
    if (state && state.sessionId === sessionId) return state;
    sleepSync(25);
  }
  return null;
}

function runWorker(projectRoot, sessionId, options = {}) {
  const paths = resolvePaths(projectRoot);
  const state = (options._waitForSessionState || waitForSessionState)(paths, sessionId);
  if (!state) throw new Error('Metro session state was not initialized by the parent process.');

  const claimedState = updateState(
    paths,
    { heartbeatAt: new Date().toISOString() },
    sessionId
  );
  if (!claimedState || claimedState.sessionId !== sessionId) {
    throw new Error('Metro session was cleaned or replaced before the runner claimed it.');
  }

  const cliPath = (options._resolveExpoCli || resolveExpoCli)(paths.projectRoot);
  appendSanitized(
    paths,
    `\n--- Metro session ${sessionId} started ${new Date().toISOString()} ---\n`,
    { sessionId }
  );

  const child = (options._spawn || spawn)(
    process.execPath,
    [cliPath, 'start', ...(state.clear ? ['--clear'] : [])],
    {
      cwd: paths.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    }
  );

  updateState(paths, {
    status: 'running',
    metroPid: child.pid,
    heartbeatAt: new Date().toISOString(),
    command: [process.execPath, cliPath, 'start', ...(state.clear ? ['--clear'] : [])],
  }, sessionId);

  const heartbeat = setInterval(() => {
    updateState(paths, { heartbeatAt: new Date().toISOString() }, sessionId);
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  let rollingText = '';
  const stdoutWriter = createSanitizedStreamWriter(paths, { sessionId });
  const stderrWriter = createSanitizedStreamWriter(paths, { sessionId });
  const consume = (writer) => (chunk) => {
    const sanitized = writer.write(chunk);
    if (!sanitized) return;
    rollingText = `${rollingText}${sanitized}`.slice(-8192);
    const metroUrl = extractMetroUrl(rollingText);
    if (metroUrl) {
      updateState(paths, {
        metroUrl,
        readyAt: new Date().toISOString(),
      }, sessionId);
    }
    rotateLog(paths, DEFAULT_MAX_LOG_BYTES, { sessionId });
  };
  child.stdout.on('data', consume(stdoutWriter));
  child.stderr.on('data', consume(stderrWriter));

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { child.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM'); } catch { /* best effort */ }
    updateState(paths, {
      status: 'stopping',
      reason: `runner received ${signal}`,
    }, sessionId);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  child.on('error', (error) => {
    clearInterval(heartbeat);
    stdoutWriter.flush();
    stderrWriter.flush();
    appendSanitized(paths, `\nMetro launch failed: ${error.message}\n`, { sessionId });
    updateState(paths, {
      status: 'failed',
      stoppedAt: new Date().toISOString(),
      reason: error.message,
    }, sessionId);
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    clearInterval(heartbeat);
    stdoutWriter.flush();
    stderrWriter.flush();
    appendSanitized(
      paths,
      `\n--- Metro exited code=${code === null ? 'null' : code} signal=${signal || 'none'} ${new Date().toISOString()} ---\n`,
      { sessionId }
    );
    updateState(paths, {
      status: shuttingDown || code === 0 ? 'stopped' : 'failed',
      stoppedAt: new Date().toISOString(),
      exitCode: code,
      exitSignal: signal,
      reason: shuttingDown ? 'runner stopped' : `Metro exited with code ${code}`,
    }, sessionId);
    process.exitCode = code || 0;
  });
}

function printHelp() {
  process.stdout.write(
    'Usage:\n' +
      '  node metro-session.js start  [--project-root <dir>] [--clear] [--wait-ready-ms <n>]\n' +
      '  node metro-session.js status [--project-root <dir>]\n' +
      '  node metro-session.js tail   [--project-root <dir>] [--cursor <bytes>] [--generation <n>] [--wait-ms <n>] [--lines <n>] [--max-bytes <n>]\n' +
      '  node metro-session.js stop   [--project-root <dir>]\n' +
      '  node metro-session.js clean  [--project-root <dir>] [--force]\n'
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

  if (options.command === '__run') {
    if (!options.sessionId) throw new Error('__run requires --session-id');
    try {
      runWorker(options.projectRoot, options.sessionId);
    } catch (error) {
      const paths = resolvePaths(options.projectRoot);
      const current = readState(paths);
      if (current && current.sessionId === options.sessionId) {
        appendSanitized(paths, `\nMetro runner failed before startup: ${error.message}\n`, {
          sessionId: options.sessionId,
        });
        updateState(paths, {
          status: 'failed',
          stoppedAt: new Date().toISOString(),
          reason: error.message,
        }, options.sessionId);
      }
      throw error;
    }
    return;
  }

  if (options.command === 'start') {
    printJson(startSession(options.projectRoot, {
      clear: options.clear,
      waitReadyMs: options.waitReadyMs,
    }));
  } else if (options.command === 'status') {
    printJson(getStatus(options.projectRoot));
  } else if (options.command === 'tail') {
    printJson(tailSession(options.projectRoot, options));
  } else if (options.command === 'stop') {
    printJson(stopSession(options.projectRoot));
  } else if (options.command === 'clean') {
    printJson(cleanSession(options.projectRoot, { force: options.force }));
  } else {
    throw new Error(`Unknown command: ${options.command}`);
  }
}

module.exports = {
  appendSanitized,
  cleanSession,
  confirmOwnedProcess,
  createSanitizedStreamWriter,
  extractMetroUrl,
  getStatus,
  killProcessTree,
  markStaleIfNeeded,
  parseArgs,
  processIsAlive,
  readState,
  redactLogText,
  resolveExpoCli,
  resolvePaths,
  rotateLog,
  runWorker,
  startSession,
  stopSession,
  tailSession,
  updateState,
  withDirectoryLock,
  writeState,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exit(1);
  }
}