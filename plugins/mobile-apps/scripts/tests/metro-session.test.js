'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'metro-session.js');
const {
  appendSanitized,
  createSanitizedStreamWriter,
  extractMetroPort,
  extractMetroUrl,
  getStatus,
  portListenerPids,
  redactLogText,
  resolveLiveness,
  resolvePaths,
  startSession,
  stopSession,
  tailSession,
  updateState,
  waitForOwnState,
  withStartLock,
  writeState,
  STATE_SCHEMA_VERSION,
} = require('../metro-session');

function makeProject(prefix = 'mobile-metro-session-') {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: 'metro-session-fixture', private: true }, null, 2)}\n`
  );
  return projectRoot;
}

function seedState(projectRoot, overrides = {}) {
  const paths = resolvePaths(projectRoot);
  writeState(paths, {
    schemaVersion: STATE_SCHEMA_VERSION,
    status: 'running',
    projectRoot,
    runnerPid: 111,
    metroPid: 222,
    port: 8081,
    metroUrl: 'http://127.0.0.1:8081',
    startedAt: new Date().toISOString(),
    ...overrides,
  });
  return paths;
}

function runCliAsync(command, projectRoot, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SCRIPT, command, '--project-root', projectRoot, ...extraArgs],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`metro-session ${command} timed out`));
    }, 10_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timeout);
      resolve({
        status,
        stdout,
        stderr,
        json: stdout.trim() ? JSON.parse(stdout) : null,
      });
    });
  });
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runCli(command, projectRoot, extraArgs = []) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, command, '--project-root', projectRoot, ...extraArgs],
    { encoding: 'utf8', timeout: 10_000 }
  );
  return {
    ...result,
    json: result.stdout.trim() ? JSON.parse(result.stdout) : null,
  };
}

function waitFor(predicate, timeoutMilliseconds = 5_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    sleep(25);
  }
  return null;
}

function installFakeExpo(projectRoot) {
  const expoRoot = path.join(projectRoot, 'node_modules', 'expo');
  const binDir = path.join(expoRoot, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(expoRoot, 'package.json'),
    `${JSON.stringify({
      name: 'expo',
      version: '0.0.0-test',
      bin: { expo: 'bin/cli.js' },
    }, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(binDir, 'cli.js'),
    [
      "'use strict';",
      "console.log('Starting Metro fixture');",
      "console.log('› Metro: exp+fixture://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081');",
      "console.log('Authorization: Bearer fixture-token-1234567890');",
      "console.log('client_secret=fixture-client-secret-1234567890');",
      'let heartbeat = 0;',
      "const timer = setInterval(() => console.log('[fixture] heartbeat ' + (++heartbeat)), 50);",
      "function stop() { clearInterval(timer); console.log('fixture stopping'); process.exit(0); }",
      "process.on('SIGTERM', stop);",
      "process.on('SIGINT', stop);",
      '',
    ].join('\n')
  );
}

test('redactLogText removes credentials while preserving diagnostic context', () => {
  const nestedSerializedAuthorization = JSON.stringify(JSON.stringify({
    Authorization: 'Basic embedded "LEAK_MARKER" suffix',
  }));
  const input = [
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.1234567890',
    'client_secret=super-secret-value-123456',
    'https://example.test/blob?sv=1&sig=secret-signature&sp=rw',
    'token=ordinary-diagnostic-word',
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'Authorization: Basic dXNlcjpwYXNz',
    'Authorization: Bearer short-token',
    'Authorization: "Basic quoted-basic-value"',
    '{"Authorization":"Basic json-basic-value"}',
    '{"Authorization":"Basic escaped \\"credential\\" suffix"}',
    String.raw`{\"Authorization\":\"Basic double-serialized-value\"}`,
    String.raw`Authorization: \"Basic double-serialized-plain\"`,
    String.raw`headers="{\"Authorization\":\"Basic prefix \\\"PREFIX_LEAK_MARKER\\\" suffix\"}"`,
    nestedSerializedAuthorization,
    'password="two word secret"',
    '{"client_secret":"json secret value"}',
    '{"client_secret":"escaped \\"secret\\" suffix"}',
  ].join('\n');

  const output = redactLogText(input);
  assert.match(output, /REDACTED_AUTHORIZATION_LINE/);
  assert.match(output, /client_secret=\[REDACTED\]/);
  assert.match(output, /sig=\[REDACTED\]/);
  assert.match(output, /sp=\[REDACTED\]/);
  assert.match(output, /token=\[REDACTED\]/);
  assert.match(output, /\[REDACTED_KEY\]/);
  assert.doesNotMatch(output, /super-secret-value|secret-signature|ghp_/);
  assert.doesNotMatch(
    output,
    /dXNlcjpwYXNz|short-token|quoted-basic-value|json-basic-value|credential|double-serialized|LEAK_MARKER|PREFIX_LEAK_MARKER|two word secret|json secret value|escaped|suffix/
  );
  assert.ok((output.match(/REDACTED_AUTHORIZATION_LINE/g) || []).length >= 8);
  assert.match(output, /password="\[REDACTED\]"/);
  assert.match(output, /"client_secret":"\[REDACTED\]"/);
});

test('stream writer redacts a credential split across output chunks', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const writer = createSanitizedStreamWriter(paths);

  assert.equal(writer.write('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.'), '');
  assert.equal(writer.write('eyJzdWIiOiJ1c2VyIn0.signature-value-123456\nnext line\n').includes('REDACTED_AUTHORIZATION_LINE'), true);
  writer.flush();

  const persisted = fs.readFileSync(paths.logPath, 'utf8');
  assert.match(persisted, /REDACTED_AUTHORIZATION_LINE/);
  assert.match(persisted, /next line/);
  assert.doesNotMatch(persisted, /eyJhbGci|signature-value/);
});

test('stream writer bounds an unterminated output line', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const writer = createSanitizedStreamWriter(paths, { maxPendingBytes: 32 });

  const persisted = writer.write('x'.repeat(64));
  assert.match(persisted, /TRUNCATED_UNTERMINATED_LOG_LINE/);
  assert.equal(writer.pendingLength(), 0);
  assert.doesNotMatch(fs.readFileSync(paths.logPath, 'utf8'), /x{32}/);
});

test('stream writer discards the remainder of an oversized split logical line', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const writer = createSanitizedStreamWriter(paths, { maxPendingBytes: 32 });

  writer.write(`Authorization: Bearer ${'a'.repeat(64)}`);
  writer.write('SECRET_TAIL_CONTINUES\nstable next line\n');
  writer.flush();

  const persisted = fs.readFileSync(paths.logPath, 'utf8');
  assert.match(persisted, /TRUNCATED_UNTERMINATED_LOG_LINE/);
  assert.match(persisted, /stable next line/);
  assert.doesNotMatch(persisted, /SECRET_TAIL_CONTINUES|a{32}/);
});

test('stream writer discards a suffix after a complete line plus oversized fragment', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const writer = createSanitizedStreamWriter(paths, { maxPendingBytes: 32 });

  writer.write(`complete line\nAuthorization: Bearer ${'b'.repeat(64)}`);
  writer.write('SECRET_SUFFIX\nnext safe line\n');
  writer.flush();

  const persisted = fs.readFileSync(paths.logPath, 'utf8');
  assert.match(persisted, /complete line/);
  assert.match(persisted, /TRUNCATED_UNTERMINATED_LOG_LINE/);
  assert.match(persisted, /next safe line/);
  assert.doesNotMatch(persisted, /SECRET_SUFFIX|b{32}/);
});

test('stream writer bounds an oversized completed output line', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const writer = createSanitizedStreamWriter(paths, { maxPendingBytes: 32 });

  const persisted = writer.write(`${'y'.repeat(64)}\nnormal\n`);
  assert.match(persisted, /TRUNCATED_LOG_LINE/);
  assert.match(persisted, /normal/);
  assert.doesNotMatch(fs.readFileSync(paths.logPath, 'utf8'), /y{32}/);
});

test('extractMetroPort reads the port from plain and dev-client banners', () => {
  assert.equal(extractMetroPort('› Metro: http://192.168.1.24:8081'), 8081);
  assert.equal(extractMetroPort('  Metro: exp://10.0.0.4:8082\n'), 8082);
  // Dev-client banners percent-encode the inner URL, hiding the ':' delimiter.
  assert.equal(
    extractMetroPort('› Metro: exp+fixture://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081'),
    8081
  );
  assert.equal(extractMetroPort('http://localhost:19000/'), 19000);
  assert.equal(extractMetroPort('no metro banner here'), null);
  assert.equal(extractMetroPort('› Metro: exp://no-port-here'), null);
  assert.equal(extractMetroUrl('› Metro: http://192.168.1.24:8081'), 'http://192.168.1.24:8081');
});

test('portListenerPids parses lsof output and distinguishes empty from unknown', () => {
  const listening = portListenerPids(8081, {
    platform: 'darwin',
    _spawnSync: () => ({ stdout: '41233\n41240\n', status: 0 }),
  });
  assert.deepEqual(listening, [41233, 41240]);

  // lsof exits 1 with empty stdout when nothing matches: a real "nobody is
  // listening" answer, not an unknown one.
  const free = portListenerPids(8081, {
    platform: 'darwin',
    _spawnSync: () => ({ stdout: '', status: 1 }),
  });
  assert.deepEqual(free, []);

  // A missing binary is genuinely unknown, so callers must fall back to PIDs.
  const unknown = portListenerPids(8081, {
    platform: 'darwin',
    _spawnSync: () => ({ error: new Error('spawn lsof ENOENT') }),
  });
  assert.equal(unknown, null);

  assert.equal(portListenerPids(null, { platform: 'darwin' }), null);
});

test('portListenerPids parses the Windows netstat table including IPv6 rows', () => {
  const stdout = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       41233',
    '  TCP    [::]:8081              [::]:0                 LISTENING       41233',
    '  TCP    0.0.0.0:8082           0.0.0.0:0              LISTENING       999',
    '  TCP    127.0.0.1:8081         127.0.0.1:5000         ESTABLISHED     777',
    '',
  ].join('\r\n');

  const pids = portListenerPids(8081, {
    platform: 'win32',
    _spawnSync: () => ({ stdout, status: 0 }),
  });
  assert.deepEqual(pids, [41233], 'only LISTENING rows on the requested port count');
});

test('resolveLiveness reports running when our process holds the port', () => {
  const liveness = resolveLiveness(
    { runnerPid: 111, metroPid: 222, port: 8081 },
    { _isProcessAlive: (pid) => pid === 222, _portListenerPids: () => [222] }
  );
  assert.equal(liveness.status, 'running');
  assert.equal(liveness.running, true);
  assert.equal(liveness.portOwnedBySession, true);
  assert.equal(liveness.port, 8081);
});

test('resolveLiveness falls back to PID liveness when the port cannot be probed', () => {
  const liveness = resolveLiveness(
    { runnerPid: 111, metroPid: 222, port: 8081 },
    { _isProcessAlive: (pid) => pid === 111, _portListenerPids: () => null }
  );
  assert.equal(liveness.status, 'running');
  assert.equal(liveness.portOwnedBySession, null, 'ownership is unknown, not false');
});

test('resolveLiveness flags a foreign Metro that took over a dead session port', () => {
  const liveness = resolveLiveness(
    { runnerPid: 111, metroPid: 222, port: 8081 },
    { _isProcessAlive: () => false, _portListenerPids: () => [90210] }
  );
  assert.equal(liveness.status, 'port-taken');
  assert.equal(liveness.running, false);
  assert.deepEqual(liveness.portListeners, [90210]);
});

test('resolveLiveness flags a port conflict while our process is still alive', () => {
  const liveness = resolveLiveness(
    { runnerPid: 111, metroPid: 222, port: 8081 },
    { _isProcessAlive: () => true, _portListenerPids: () => [90210] }
  );
  assert.equal(liveness.status, 'port-conflict');
  assert.equal(liveness.running, false, 'a conflicted port must not be treated as healthy');
});

test('resolveLiveness reports stopped when nothing is alive and the port is free', () => {
  const liveness = resolveLiveness(
    { runnerPid: 111, metroPid: 222, port: 8081 },
    { _isProcessAlive: () => false, _portListenerPids: () => [] }
  );
  assert.equal(liveness.status, 'stopped');
  assert.equal(liveness.running, false);
});

test('status surfaces a stale log when another Metro now owns the recorded port', () => {
  const projectRoot = makeProject();
  seedState(projectRoot);

  const status = getStatus(projectRoot, {
    _isProcessAlive: () => false,
    _portListenerPids: () => [90210],
  });

  assert.equal(status.status, 'port-taken');
  assert.equal(status.running, false);
  assert.equal(status.port, 8081);
  assert.deepEqual(status.portListeners, [90210]);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('status reports not-started when no session state exists', () => {
  const projectRoot = makeProject();
  const status = getStatus(projectRoot);
  assert.equal(status.status, 'not-started');
  assert.equal(status.running, false);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('status keeps a recorded failure reason when the port is free', () => {
  const projectRoot = makeProject();
  seedState(projectRoot, { status: 'failed', reason: 'Expo is not installed in this project.' });

  const status = getStatus(projectRoot, {
    _isProcessAlive: () => false,
    _portListenerPids: () => [],
  });

  assert.equal(status.status, 'failed');
  assert.match(status.reason, /Expo is not installed/);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('startSession records a detached runner without requiring a host terminal', () => {
  const projectRoot = makeProject();
  let spawnCall = null;
  let unrefCalled = false;

  const result = startSession(projectRoot, {
    _isProcessAlive: () => false,
    _portListenerPids: () => [],
    _spawn(command, args, options) {
      spawnCall = { command, args, options };
      return { pid: 42001, unref() { unrefCalled = true; } };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyRunning, false);
  assert.equal(result.status, 'starting');
  assert.equal(result.runnerPid, 42001);
  assert.equal(result.port, null, 'the port is unknown until Metro prints its banner');
  assert.equal(unrefCalled, true);
  assert.equal(spawnCall.command, process.execPath);
  assert.equal(spawnCall.options.detached, true);
  assert.equal(spawnCall.options.cwd, projectRoot);
  assert.match(spawnCall.args.join(' '), /__run/);
  assert.ok(fs.existsSync(resolvePaths(projectRoot).statePath));
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('startSession reuses a live session instead of spawning a second Metro', () => {
  const projectRoot = makeProject();
  seedState(projectRoot);
  let spawnCalls = 0;

  const result = startSession(projectRoot, {
    _isProcessAlive: () => true,
    _portListenerPids: () => [222],
    _spawn() { spawnCalls += 1; return { pid: 333, unref() {} }; },
  });

  assert.equal(result.alreadyRunning, true);
  assert.equal(result.port, 8081);
  assert.equal(spawnCalls, 0);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('startSession replaces a dead session whose port was taken by another Metro', () => {
  const projectRoot = makeProject();
  seedState(projectRoot);
  let spawnCalls = 0;

  const result = startSession(projectRoot, {
    _isProcessAlive: () => false,
    _portListenerPids: () => [90210],
    _spawn() { spawnCalls += 1; return { pid: 4242, unref() {} }; },
  });

  assert.equal(result.alreadyRunning, false);
  assert.equal(result.runnerPid, 4242);
  assert.equal(spawnCalls, 1, 'a foreign process on our old port must not block a restart');
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('start lock serializes contenders and reclaims an abandoned lock', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  fs.mkdirSync(paths.sessionDir, { recursive: true });
  fs.mkdirSync(paths.startLockPath, { recursive: true });

  assert.throws(
    () => withStartLock(paths.startLockPath, () => 'unexpected', {
      timeoutMs: 10,
      _sleepSync() {},
    }),
    /Timed out waiting for the Metro start lock/
  );

  // An abandoned lock older than the stale window must not deadlock the CLI.
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(paths.startLockPath, old, old);
  const result = withStartLock(paths.startLockPath, () => 'recovered', { _sleepSync() {} });
  assert.equal(result, 'recovered');
  assert.equal(fs.existsSync(paths.startLockPath), false, 'the lock is released on exit');
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('runner-scoped update cannot clobber a replaced session', () => {
  const projectRoot = makeProject();
  const paths = seedState(projectRoot, { runnerPid: 555 });

  const rejected = updateState(paths, { status: 'failed' }, 999);
  assert.equal(rejected.status, 'running', 'a zombie runner must not write');
  assert.equal(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).status, 'running');

  const accepted = updateState(paths, { status: 'stopped' }, 555);
  assert.equal(accepted.status, 'stopped');
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('a runner only starts once state names its own PID', () => {
  const projectRoot = makeProject();
  const paths = seedState(projectRoot, { runnerPid: process.pid });

  const own = waitForOwnState(paths, 1000);
  assert.ok(own, 'state naming this process is adopted immediately');
  assert.equal(own.runnerPid, process.pid);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('a replaced session is never adopted by the previous runner', () => {
  const projectRoot = makeProject();
  // State belongs to a newer runner, so this process must time out rather than
  // claim it — otherwise the stale runner would overwrite the live session.
  const paths = seedState(projectRoot, { runnerPid: process.pid + 1 });
  let waits = 0;

  const own = waitForOwnState(paths, 50, { _sleepSync() { waits += 1; } });

  assert.equal(own, null);
  assert.ok(waits >= 1);
  assert.equal(
    JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).runnerPid,
    process.pid + 1,
    'the live session PID must survive untouched'
  );
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('stop never signals PIDs it no longer owns', () => {
  const projectRoot = makeProject();
  seedState(projectRoot);
  const signals = [];

  const result = stopSession(projectRoot, {
    _isProcessAlive: () => false,
    _portListenerPids: () => [],
    _kill(pid, signal) { signals.push([pid, signal]); },
    _sleepSync() {},
  });

  assert.equal(result.stopped, false);
  assert.equal(result.signalAttempted, false);
  assert.deepEqual(signals, [], 'recycled PIDs must never be signaled');
  assert.match(result.reason, /no longer running/);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('tail reads only bytes after a cursor and resets safely after log replacement', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  appendSanitized(paths, 'first line\n');
  const first = tailSession(projectRoot, { cursor: 0, maxBytes: 1024, waitMs: 0 });
  assert.equal(first.output, 'first line\n');
  assert.equal(first.nextCursor, Buffer.byteLength('first line\n'));

  appendSanitized(paths, 'second line\n');
  const second = tailSession(projectRoot, { cursor: first.nextCursor, maxBytes: 1024, waitMs: 0 });
  assert.equal(second.output, 'second line\n');

  // Rotation truncates in place, so a cursor beyond EOF is the rotation signal.
  fs.writeFileSync(paths.logPath, 'new log\n');
  const reset = tailSession(projectRoot, { cursor: second.nextCursor, maxBytes: 1024, waitMs: 0 });
  assert.equal(reset.cursor, 0);
  assert.equal(reset.rotationLost, true);
  assert.equal(reset.truncated, true);
  assert.equal(reset.output, 'new log\n');
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('tail holds the full observation window before reporting a clean cycle', () => {
  const projectRoot = makeProject();
  const paths = seedState(projectRoot);
  appendSanitized(paths, 'baseline\n');
  const cursor = fs.statSync(paths.logPath).size;
  let waits = 0;
  let appended = false;

  const result = tailSession(projectRoot, {
    cursor,
    waitMs: 100,
    maxBytes: 1024,
    _isProcessAlive: () => true,
    _portListenerPids: () => [222],
    _sleepSync() {
      waits += 1;
      if (!appended) {
        appendSanitized(paths, 'new runtime error\n');
        appended = true;
      }
    },
  });

  assert.ok(waits >= 1);
  assert.equal(result.output, 'new runtime error\n', 'bytes are read once, after the wait');
  assert.ok(result.nextCursor > cursor);
  assert.equal(result.observationComplete, true);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('tail marks observation incomplete when the session disappears while waiting', () => {
  const projectRoot = makeProject();
  const paths = seedState(projectRoot);
  appendSanitized(paths, 'baseline\n');
  const cursor = fs.statSync(paths.logPath).size;
  let removed = false;

  const result = tailSession(projectRoot, {
    cursor,
    waitMs: 100,
    _isProcessAlive: () => true,
    _portListenerPids: () => [222],
    _sleepSync() {
      if (!removed) {
        fs.rmSync(paths.statePath, { force: true });
        removed = true;
      }
    },
  });

  assert.equal(result.observationComplete, false);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('tail refuses to call a port-taken session a clean observation', () => {
  const projectRoot = makeProject();
  const paths = seedState(projectRoot);
  appendSanitized(paths, 'stale output\n');

  const result = tailSession(projectRoot, {
    cursor: 0,
    waitMs: 0,
    _isProcessAlive: () => false,
    _portListenerPids: () => [90210],
  });

  assert.equal(result.status, 'port-taken');
  assert.equal(result.running, false);
  assert.equal(result.observationComplete, false);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('concurrent CLI starts in a path with spaces create exactly one session', async (context) => {
  const projectRoot = makeProject('mobile metro session ');
  installFakeExpo(projectRoot);

  context.after(() => {
    runCli('stop', projectRoot);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    runCliAsync('start', projectRoot, ['--wait-ready-ms', '0']),
    runCliAsync('start', projectRoot, ['--wait-ready-ms', '0']),
  ]);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.json.runnerPid, second.json.runnerPid, 'both callers share one runner');
  assert.equal(
    [first.json.alreadyRunning, second.json.alreadyRunning].filter(Boolean).length,
    1
  );

  const ready = waitFor(() => {
    const status = runCli('status', projectRoot);
    return status.status === 0 && status.json.running && status.json.metroUrl
      ? status.json
      : null;
  });
  assert.ok(ready, 'the single shared session should become ready');
});

test('CLI manages a real detached fixture across start, status, tail, and stop', (context) => {
  const projectRoot = makeProject();
  installFakeExpo(projectRoot);

  context.after(() => {
    runCli('stop', projectRoot);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const started = runCli('start', projectRoot);
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.json.ok, true);
  assert.equal(started.json.alreadyRunning, false);

  const ready = waitFor(() => {
    const status = runCli('status', projectRoot);
    return status.status === 0 && status.json.running && status.json.metroUrl
      ? status.json
      : null;
  });
  assert.ok(ready, 'fixture Metro process should become ready');
  assert.equal(ready.status, 'running');
  assert.match(ready.metroUrl, /^exp\+fixture:/);
  assert.equal(ready.port, 8081, 'the port is parsed out of the dev-client banner');

  const tailed = runCli('tail', projectRoot, ['--cursor', '0']);
  assert.equal(tailed.status, 0, tailed.stderr);
  assert.match(tailed.json.output, /Starting Metro fixture/);
  assert.match(tailed.json.output, /REDACTED_AUTHORIZATION_LINE/);
  assert.match(tailed.json.output, /client_secret=\[REDACTED\]/);
  assert.doesNotMatch(tailed.json.output, /fixture-token-1234567890/);
  assert.ok(tailed.json.nextCursor > 0);

  const stopped = runCli('stop', projectRoot);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.json.status, 'stopped');

  const stoppedStatus = waitFor(() => {
    const status = runCli('status', projectRoot);
    return status.status === 0 && !status.json.running ? status.json : null;
  });
  assert.ok(stoppedStatus);
});

test('CLI persists a failed state when Expo cannot be resolved', () => {
  const projectRoot = makeProject();
  const result = runCli('start', projectRoot, ['--wait-ready-ms', '3000']);

  assert.equal(result.status, 0, result.stderr);
  const failed = waitFor(() => {
    const status = runCli('status', projectRoot);
    return status.status === 0 && status.json.status === 'failed' ? status.json : null;
  });
  assert.ok(failed, 'runner should persist its bootstrap failure');
  assert.match(failed.reason, /Expo is not installed/);

  const tailed = runCli('tail', projectRoot, ['--lines', '20']);
  assert.match(tailed.json.output, /Metro runner failed before startup/);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('skill contracts use the port-anchored Metro session and declare sub-skill invocation', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const createSkill = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'),
    'utf8'
  );
  const debugSkill = fs.readFileSync(
    path.join(pluginRoot, 'skills', 'debug-app', 'SKILL.md'),
    'utf8'
  );

  const createFrontmatter = createSkill.split('---', 3)[1];
  assert.match(createFrontmatter, /allowed-tools:.*\bSkill\b/);
  assert.match(createSkill, /scripts\/metro-session\.js/);
  assert.match(debugSkill, /\.expo\/metro-session\/metro\.log/);
  assert.match(debugSkill, /port-taken/, 'debug must refuse a hijacked port');
  assert.doesNotMatch(debugSkill, /BashOutput|METRO_TERMINAL_ID/);
  assert.doesNotMatch(debugSkill, /Which terminal is running/);
});
