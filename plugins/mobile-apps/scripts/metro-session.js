#!/usr/bin/env node

/**
 * Cross-host Metro session manager.
 *
 * Skills cannot rely on a host terminal ID surviving a VS Code/Claude restart,
 * and different hosts expose different terminal-output tools. This wrapper owns
 * Metro as a detached process and persists its sanitized output under the app's
 * already-ignored `.expo/` directory so every host can inspect the same state.
 *
 * The dev-server **port** is the session's identity. It is the number the QR
 * encodes, the number the device dials, and the only session fact with external
 * ground truth: the OS knows which process holds a listening socket, so
 * liveness is a socket probe rather than a heartbeat we wrote ourselves. That
 * also catches the failure a self-reported heartbeat cannot — our Metro died
 * and a *different* project's Metro now owns the port, making our log stale.
 *
 * Usage:
 *   node metro-session.js start  [--project-root <dir>] [--clear] [--wait-ready-ms <n>]
 *   node metro-session.js status [--project-root <dir>]
 *   node metro-session.js tail   [--project-root <dir>] [--cursor <bytes>] [--lines <n>]
 *   node metro-session.js stop   [--project-root <dir>]
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const STATE_SCHEMA_VERSION = 2;
const SESSION_DIR_PARTS = ['.expo', 'metro-session'];
const STATE_FILE = 'state.json';
const LOG_FILE = 'metro.log';
const DEFAULT_TAIL_LINES = 200;
const DEFAULT_MAX_TAIL_BYTES = 256 * 1024;
const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_PENDING_LINE_BYTES = 1024 * 1024;
const START_LOCK_STALE_MS = 60000;
const START_LOCK_TIMEOUT_MS = 5000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseArgs(argv) {
  const options = {
    command: '',
    projectRoot: process.cwd(),
    clear: false,
    cursor: null,
    lines: DEFAULT_TAIL_LINES,
    maxBytes: DEFAULT_MAX_TAIL_BYTES,
    waitReadyMs: 1500,
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
    } else if (argument === '--wait-ready-ms') {
      options.waitReadyMs = Number(argv[index + 1]);
      index += 1;
    } else if (argument === '--wait-ms') {
      options.waitMs = Number(argv[index + 1]);
      index += 1;
    } else if (argument === '--clear') {
      options.clear = true;
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

  return options;
}

function resolvePaths(projectRoot) {
  const root = path.resolve(projectRoot);
  const sessionDir = path.join(root, ...SESSION_DIR_PARTS);
  return {
    projectRoot: root,
    sessionDir,
    statePath: path.join(sessionDir, STATE_FILE),
    logPath: path.join(sessionDir, LOG_FILE),
    startLockPath: path.join(sessionDir, 'start.lock'),
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

function writeState(paths, state) {
  ensureSessionDir(paths);
  // Atomic rename is the only write primitive needed: readers either see the
  // previous complete file or the next one, never a partial write. There is no
  // read-modify-write lock because the runner is the sole writer once started.
  const temporaryPath = `${paths.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, paths.statePath);
  return state;
}

function updateState(paths, patch, expectedRunnerPid = 0) {
  const current = readState(paths) || {};
  // A zombie runner from a replaced session must not clobber the live session's
  // state. Ownership is the recorded runner PID, which is unforgeable enough
  // here because a replaced session always rewrites it.
  if (expectedRunnerPid && Number(current.runnerPid) !== expectedRunnerPid) return current;
  return writeState(paths, { ...current, ...patch, updatedAt: new Date().toISOString() });
}

/**
 * Minimal mutual exclusion for start/stop only. `mkdir` is atomic on POSIX and
 * Windows, so the directory itself is the mutex. A lock older than
 * START_LOCK_STALE_MS is assumed abandoned by a crashed process. This is
 * deliberately not a general-purpose lock: state writes use atomic rename, and
 * concurrent Metro launches are additionally prevented by the OS refusing to
 * bind an in-use port.
 */
function withStartLock(lockPath, callback, options = {}) {
  const wait = options._sleepSync || sleepSync;
  const deadline = Date.now() + (options.timeoutMs || START_LOCK_TIMEOUT_MS);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { continue; }
      if (age > START_LOCK_STALE_MS) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the Metro start lock: ${lockPath}`);
      }
      wait(10);
    }
  }

  try {
    return callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
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

/**
 * PIDs holding a listening TCP socket on `port`, or null when the host provides
 * no usable probe (then callers fall back to PID liveness).
 *
 * macOS/Linux `lsof -nP -iTCP:8081 -sTCP:LISTEN -t` prints one PID per line:
 *   41233
 * Windows `netstat -ano -p tcp` prints a fixed-column table:
 *     Proto  Local Address      Foreign Address    State       PID
 *     TCP    0.0.0.0:8081       0.0.0.0:0          LISTENING   41233
 * IPv6 rows use bracketed hosts (`[::]:8081`), so match on a trailing `:<port>`
 * of the local-address column rather than parsing the host.
 */
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
  // lsof exits 1 with empty stdout when nothing matches, which is a valid
  // "nothing is listening" answer. Only a missing binary is "unknown".
  if (!result || result.error || typeof result.stdout !== 'string') return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Collapses PID liveness and the port probe into one verdict.
 *
 * - `running`   — our recorded process is alive and, when the port can be
 *                 probed, nothing contradicts our ownership of it.
 * - `port-conflict` — our process is alive but another process holds our port.
 * - `port-taken`    — our process is gone and someone else now holds the port,
 *                 so `metro.log` is stale and must not be trusted.
 */
function resolveLiveness(state, options = {}) {
  const isAlive = options._isProcessAlive || processIsAlive;
  const probe = options._portListenerPids || portListenerPids;
  const runnerAlive = isAlive(Number(state.runnerPid));
  const metroAlive = isAlive(Number(state.metroPid));
  const processAlive = runnerAlive || metroAlive;
  const port = Number.isInteger(state.port) ? state.port : null;
  const listeners = port ? probe(port, options) : null;

  const ownsPort = listeners === null
    ? null
    : listeners.some((pid) => pid === Number(state.runnerPid) || pid === Number(state.metroPid));

  let status;
  if (processAlive && ownsPort === false && listeners.length > 0) status = 'port-conflict';
  else if (processAlive) status = 'running';
  else if (listeners && listeners.length > 0) status = 'port-taken';
  else status = 'stopped';

  return {
    status,
    running: status === 'running',
    runnerAlive,
    metroAlive,
    port,
    portListeners: listeners,
    portOwnedBySession: ownsPort,
  };
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
  ensureSessionDir(paths);
  fs.appendFileSync(paths.logPath, sanitized, { encoding: 'utf8', mode: 0o600 });
  return sanitized;
}

function createSanitizedStreamWriter(paths, options = {}) {
  let pending = '';
  let discardingOversizedLine = false;
  const maxPendingBytes = options.maxPendingBytes || DEFAULT_MAX_PENDING_LINE_BYTES;

  function persist(value) {
    if (!value) return '';
    return appendSanitized(paths, redactLogText(value), { alreadySanitized: true });
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

/**
 * Copy-then-truncate keeps the active path present so tail readers never race a
 * rename. Readers detect rotation without a generation counter: a saved cursor
 * beyond the current file size can only mean the file was truncated.
 */
function rotateLog(paths, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  if (!fs.existsSync(paths.logPath)) return null;
  if (fs.statSync(paths.logPath).size < maxBytes) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rotatedPath = path.join(paths.sessionDir, `metro.${stamp}.log`);
  fs.copyFileSync(paths.logPath, rotatedPath);
  fs.truncateSync(paths.logPath, 0);
  return rotatedPath;
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

/**
 * Metro announces its URL on a banner line, e.g.:
 *   › Metro: http://192.168.1.24:8081
 *   Metro: exp://192.168.1.24:8082
 */
function extractMetroUrl(value) {
  const match = String(value).match(/(?:^|\n)\s*›?\s*Metro:\s*(\S+)/);
  return match ? match[1] : null;
}

/**
 * Port from a Metro URL. Expo rolls to the next free port when 8081 is taken,
 * so this must be read from the banner rather than assumed.
 *
 * Dev-client banners nest the real URL as a percent-encoded query parameter:
 *   exp+myapp://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081
 * so decode before matching, otherwise the `%3A` hides the port delimiter.
 */
function extractMetroPort(value) {
  const url = typeof value === 'string' && /^[\w+.-]+:\/\//.test(value) ? value : extractMetroUrl(value);
  if (!url) return null;
  let candidate = String(url);
  try { candidate = decodeURIComponent(candidate); } catch { /* keep the raw form */ }
  const match = candidate.match(/:(\d{2,5})(?:[/?#]|$)/);
  const port = match ? Number(match[1]) : null;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

function startSession(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot);
  ensureProject(paths.projectRoot);
  ensureSessionDir(paths);

  const initial = withStartLock(paths.startLockPath, () => startSessionLocked(paths, options), {
    timeoutMs: options.startLockTimeoutMs,
    _sleepSync: options._sleepSync,
  });

  // Wait for the runner to publish the Metro URL/port so callers can render a
  // QR immediately instead of polling status themselves.
  if (!options._spawn && options.waitReadyMs !== 0 && !initial.alreadyRunning) {
    const deadline = Date.now() + options.waitReadyMs;
    while (Date.now() < deadline) {
      const current = readState(paths);
      if (current && (current.metroUrl || ['failed', 'stopped'].includes(current.status))) break;
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
  const existing = readState(paths);
  if (existing) {
    const liveness = resolveLiveness(existing, options);
    if (liveness.running) {
      return {
        ok: true,
        alreadyRunning: true,
        ...existing,
        ...liveness,
        statePath: paths.statePath,
        logPath: paths.logPath,
      };
    }
  }

  rotateLog(paths, options.maxLogBytes || DEFAULT_MAX_LOG_BYTES);
  const spawnImpl = options._spawn || spawn;
  const runner = spawnImpl(
    process.execPath,
    [__filename, '__run', '--project-root', paths.projectRoot, ...(options.clear ? ['--clear'] : [])],
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
  // Minimal by design. Everything else a caller might want (Metro URL history,
  // start time, failure text) is already in metro.log; the only fact with no
  // other durable home is which PID is supposed to own the port, because the
  // log rotates and would eventually discard its own session header.
  writeState(paths, {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: 'starting',
    runnerPid: runner.pid,
    metroPid: null,
    port: null,
    metroUrl: null,
    updatedAt: now,
  });
  if (typeof runner.unref === 'function') runner.unref();

  return {
    ok: true,
    alreadyRunning: false,
    ...(readState(paths) || {}),
    statePath: paths.statePath,
    logPath: paths.logPath,
  };
}

function getStatus(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot);
  const state = readState(paths);
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

  const liveness = resolveLiveness(state, options);
  // A recorded terminal state is authoritative over the probe: an exited Metro
  // whose port was immediately reused should still report why it exited.
  const status = ['failed', 'stopped'].includes(state.status) && liveness.status !== 'running'
    ? (liveness.status === 'port-taken' ? 'port-taken' : state.status)
    : liveness.status;

  return {
    ok: true,
    ...state,
    ...liveness,
    status,
    running: status === 'running',
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
  const status = getStatus(projectRoot, options);
  let observationComplete = options.waitMs === 0;

  // Hold the poll open for the full interval so a caller may only count a cycle
  // "clean" after genuinely observing that window. Data arriving early does not
  // shorten it; every byte is read once, after the wait.
  if (Number.isInteger(options.cursor) && options.waitMs > 0 && status.running) {
    const now = options._nowFn || Date.now;
    const wait = options._sleepSync || sleepSync;
    const deadline = now() + options.waitMs;
    let transitionDetected = false;
    while (now() < deadline) {
      const current = readState(paths);
      if (!current || !['starting', 'running'].includes(current.status)) {
        transitionDetected = true;
        break;
      }
      wait(Math.min(50, Math.max(1, deadline - now())));
    }
    observationComplete = !transitionDetected;
  }

  let size = 0;
  try { size = fs.statSync(paths.logPath).size; } catch { /* no active log */ }

  const maxBytes = options.maxBytes || DEFAULT_MAX_TAIL_BYTES;
  let start;
  let rotationLost = false;
  if (Number.isInteger(options.cursor)) {
    start = options.cursor;
    // The log only ever grows or is truncated by rotation, so a cursor past the
    // end can only mean rotation happened between polls.
    if (start > size) {
      start = 0;
      rotationLost = true;
    }
  } else {
    start = Math.max(0, size - maxBytes);
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
    truncated: rotationLost || start + buffer.length < size,
    rotationLost,
    observationComplete: observationComplete && status.running,
    output,
  };
}

function killProcessTree(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const platform = options.platform || process.platform;
  const isAlive = options._isProcessAlive || processIsAlive;
  const kill = options._kill || process.kill;
  const spawnSyncImpl = options._spawnSync || spawnSync;
  const wait = options._sleepSync || sleepSync;
  if (!isAlive(pid)) return false;

  if (platform === 'win32') {
    const result = spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    if (result.status !== 0) return false;
    const deadline = Date.now() + 1500;
    while (isAlive(pid) && Date.now() < deadline) wait(25);
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
  while (isAlive(pid) && Date.now() < deadline) wait(25);
  if (isAlive(pid)) {
    try {
      kill(-pid, 'SIGKILL');
    } catch {
      try { kill(pid, 'SIGKILL'); } catch { /* best effort */ }
    }
  }
  const finalDeadline = Date.now() + 500;
  while (isAlive(pid) && Date.now() < finalDeadline) wait(25);
  return !isAlive(pid);
}

function stopSession(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot);
  return withStartLock(paths.startLockPath, () => stopSessionLocked(paths, options), {
    timeoutMs: options.startLockTimeoutMs,
    _sleepSync: options._sleepSync,
  });
}

function stopSessionLocked(paths, options = {}) {
  const state = readState(paths);
  if (!state) {
    return { ok: true, status: 'not-started', stopped: false, projectRoot: paths.projectRoot };
  }

  const isAlive = options._isProcessAlive || processIsAlive;
  const liveness = resolveLiveness(state, options);
  // Never signal PIDs we no longer own. A dead session's recorded PIDs may have
  // been recycled by an unrelated process.
  const ownsLiveProcess = liveness.status === 'running' || liveness.status === 'port-conflict';
  const signaledRunner = ownsLiveProcess ? killProcessTree(Number(state.runnerPid), options) : false;
  const signaledMetro = ownsLiveProcess && isAlive(Number(state.metroPid))
    ? killProcessTree(Number(state.metroPid), options)
    : false;
  const runnerAlive = ownsLiveProcess && isAlive(Number(state.runnerPid));
  const metroAlive = ownsLiveProcess && isAlive(Number(state.metroPid));
  const fullyStopped = ownsLiveProcess && !runnerAlive && !metroAlive;

  const next = updateState(paths, {
    status: fullyStopped ? 'stopped' : ownsLiveProcess ? 'stop-failed' : 'stopped',
    reason: fullyStopped
      ? 'stopped by metro-session command'
      : ownsLiveProcess
        ? `failed to stop Metro process tree (runnerAlive=${runnerAlive}, metroAlive=${metroAlive})`
        : 'recorded Metro processes were no longer running',
  });

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

/**
 * Blocks until the parent has published state naming *this* process as the
 * runner. The parent can only record the PID after `spawn` returns, so a fast
 * runner may first observe no state at all, or the previous session's state.
 * Waiting for `runnerPid === process.pid` is what makes a replaced session's
 * zombie runner exit instead of adopting (and then clobbering) the new one.
 */
function waitForOwnState(paths, timeoutMilliseconds = 5000, options = {}) {
  const wait = options._sleepSync || sleepSync;
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = readState(paths);
    if (state && Number(state.runnerPid) === process.pid) return state;
    wait(25);
  }
  return null;
}

function runWorker(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot);
  const state = (options._waitForOwnState || waitForOwnState)(paths);
  if (!state) {
    throw new Error('Metro session state was not initialized by the parent process.');
  }

  const cliPath = (options._resolveExpoCli || resolveExpoCli)(paths.projectRoot);
  appendSanitized(paths, `\n--- Metro session started ${new Date().toISOString()} ---\n`);

  // `--clear` arrives on this runner's own argv, so it does not need to be
  // round-tripped through state.json.
  const child = (options._spawn || spawn)(
    process.execPath,
    [cliPath, 'start', ...(options.clear ? ['--clear'] : [])],
    {
      cwd: paths.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    }
  );

  updateState(paths, { status: 'running', metroPid: child.pid }, process.pid);

  let rollingText = '';
  const stdoutWriter = createSanitizedStreamWriter(paths);
  const stderrWriter = createSanitizedStreamWriter(paths);
  const consume = (writer) => (chunk) => {
    const sanitized = writer.write(chunk);
    if (!sanitized) return;
    rollingText = `${rollingText}${sanitized}`.slice(-8192);
    const metroUrl = extractMetroUrl(rollingText);
    if (metroUrl) {
      const port = extractMetroPort(metroUrl);
      const current = readState(paths);
      if (!current || current.metroUrl !== metroUrl || current.port !== port) {
        updateState(paths, { metroUrl, port }, process.pid);
      }
    }
    rotateLog(paths);
  };
  child.stdout.on('data', consume(stdoutWriter));
  child.stderr.on('data', consume(stderrWriter));

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { child.kill(signal === 'SIGINT' ? 'SIGINT' : 'SIGTERM'); } catch { /* best effort */ }
    updateState(paths, { status: 'stopping', reason: `runner received ${signal}` }, process.pid);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  child.on('error', (error) => {
    stdoutWriter.flush();
    stderrWriter.flush();
    appendSanitized(paths, `\nMetro launch failed: ${error.message}\n`);
    updateState(paths, {
      status: 'failed',
      reason: error.message,
    }, process.pid);
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    stdoutWriter.flush();
    stderrWriter.flush();
    appendSanitized(
      paths,
      `\n--- Metro exited code=${code === null ? 'null' : code} signal=${signal || 'none'} ${new Date().toISOString()} ---\n`
    );
    updateState(paths, {
      status: shuttingDown || code === 0 ? 'stopped' : 'failed',
      reason: shuttingDown ? 'runner stopped' : `Metro exited with code ${code}`,
    }, process.pid);
    process.exitCode = code || 0;
  });
}

function printHelp() {
  process.stdout.write(
    'Usage:\n' +
      '  node metro-session.js start  [--project-root <dir>] [--clear] [--wait-ready-ms <n>]\n' +
      '  node metro-session.js status [--project-root <dir>]\n' +
      '  node metro-session.js tail   [--project-root <dir>] [--cursor <bytes>] [--wait-ms <n>] [--lines <n>] [--max-bytes <n>]\n' +
      '  node metro-session.js stop   [--project-root <dir>]\n'
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
    try {
      runWorker(options.projectRoot, options);
    } catch (error) {
      const paths = resolvePaths(options.projectRoot);
      appendSanitized(paths, `\nMetro runner failed before startup: ${error.message}\n`);
      updateState(paths, {
        status: 'failed',
        reason: error.message,
      });
      process.exitCode = 1;
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
  appendSanitized,
  createSanitizedStreamWriter,
  extractMetroPort,
  extractMetroUrl,
  getStatus,
  killProcessTree,
  parseArgs,
  portListenerPids,
  processIsAlive,
  readState,
  redactLogText,
  resolveExpoCli,
  resolveLiveness,
  resolvePaths,
  rotateLog,
  runWorker,
  startSession,
  stopSession,
  stripAnsi,
  tailSession,
  waitForOwnState,
  withStartLock,
  writeState,
  updateState,
  STATE_SCHEMA_VERSION,
};
