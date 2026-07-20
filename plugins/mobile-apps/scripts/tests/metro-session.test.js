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
  cleanSession,
  createSanitizedStreamWriter,
  getStatus,
  redactLogText,
  resolvePaths,
  runWorker,
  startSession,
  tailSession,
  updateState,
  withDirectoryLock,
  writeState,
} = require('../metro-session');

function makeProject(prefix = 'mobile-metro-session-') {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: 'metro-session-fixture', private: true }, null, 2)}\n`
  );
  return projectRoot;
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

test('startSession records a detached runner without requiring a host terminal', () => {
  const projectRoot = makeProject();
  let spawnCall = null;
  let unrefCalled = false;
  const fakeRunner = {
    pid: 42001,
    unref() { unrefCalled = true; },
  };

  const result = startSession(projectRoot, {
    _isProcessAlive: () => false,
    _spawn(command, args, options) {
      spawnCall = { command, args, options };
      return fakeRunner;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.alreadyRunning, false);
  assert.equal(result.status, 'starting');
  assert.equal(result.runnerPid, 42001);
  assert.equal(unrefCalled, true);
  assert.equal(spawnCall.command, process.execPath);
  assert.equal(spawnCall.options.detached, true);
  assert.equal(spawnCall.options.cwd, projectRoot);
  assert.match(spawnCall.args.join(' '), /__run/);
  assert.ok(fs.existsSync(resolvePaths(projectRoot).statePath));
});

test('startSession reuses a live wrapper session instead of spawning again', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const now = new Date().toISOString();
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'existing-session',
    status: 'running',
    projectRoot,
    runnerPid: 111,
    metroPid: 222,
    startedAt: now,
    heartbeatAt: now,
    logGeneration: 0,
  });
  let spawnCalls = 0;

  const result = startSession(projectRoot, {
    _isProcessAlive: () => true,
    _spawn() { spawnCalls += 1; return { pid: 333, unref() {} }; },
  });

  assert.equal(result.alreadyRunning, true);
  assert.equal(result.sessionId, 'existing-session');
  assert.equal(spawnCalls, 0);
});

test('concurrent CLI starts in a path with spaces create exactly one session', async (context) => {
  const projectRoot = makeProject('mobile metro session ');
  installFakeExpo(projectRoot);

  context.after(() => {
    runCli('stop', projectRoot);
    runCli('clean', projectRoot, ['--force']);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    runCliAsync('start', projectRoot, ['--wait-ready-ms', '0']),
    runCliAsync('start', projectRoot, ['--wait-ready-ms', '0']),
  ]);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.json.sessionId, second.json.sessionId);
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

test('directory lock never displaces a live owner solely because it is old', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  fs.mkdirSync(paths.stateLockPath, { recursive: true });
  fs.writeFileSync(
    path.join(paths.stateLockPath, 'owner.json'),
    JSON.stringify({ token: 'live-owner', pid: 12345, acquiredAt: new Date(0).toISOString() })
  );
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(paths.stateLockPath, old, old);

  assert.throws(
    () => withDirectoryLock(paths.stateLockPath, () => 'unexpected', {
      timeoutMs: 10,
      staleMs: 1,
      _isProcessAlive: () => true,
      _sleepSync() {},
    }),
    /Timed out waiting for session lock/
  );
  assert.equal(readFile(path.join(paths.stateLockPath, 'owner.json')).token, 'live-owner');
});

test('directory lock reclaims a dead owner before running one successor', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  fs.mkdirSync(paths.stateLockPath, { recursive: true });
  fs.writeFileSync(
    path.join(paths.stateLockPath, 'owner.json'),
    JSON.stringify({ token: 'dead-owner', pid: 99999, acquiredAt: new Date(0).toISOString() })
  );
  let callbacks = 0;

  const result = withDirectoryLock(paths.stateLockPath, () => {
    callbacks += 1;
    return 'recovered';
  }, {
    timeoutMs: 500,
    staleMs: 1,
    _isProcessAlive: () => false,
    _sleepSync() {},
  });

  assert.equal(result, 'recovered');
  assert.equal(callbacks, 1);
  assert.equal(fs.existsSync(paths.stateLockPath), false);
  assert.equal(fs.existsSync(`${paths.stateLockPath}.reclaim`), false);
});

function readFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('expected-session update cannot recreate deleted or replaced state', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const result = updateState(paths, { status: 'running' }, 'old-session');
  assert.deepEqual(result, {});
  assert.equal(fs.existsSync(paths.statePath), false);

  writeState(paths, { schemaVersion: 1, sessionId: 'new-session', status: 'running' });
  const replaced = updateState(paths, { status: 'failed' }, 'old-session');
  assert.equal(replaced.sessionId, 'new-session');
  assert.equal(readFile(paths.statePath).status, 'running');
});

test('delayed worker cannot recreate state after the session is cleaned', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'delayed-worker-session',
    status: 'starting',
    runnerPid: 123,
    startedAt: new Date().toISOString(),
  });
  fs.rmSync(paths.sessionDir, { recursive: true, force: true });

  assert.throws(
    () => runWorker(projectRoot, 'delayed-worker-session', {
      _waitForSessionState: () => null,
    }),
    /state was not initialized/
  );
  assert.equal(fs.existsSync(paths.sessionDir), false);
});

test('conditional update waiting behind cleanup cannot recreate the session directory', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'cleanup-race-session',
    status: 'stopped',
    runnerPid: null,
    metroPid: null,
  });
  fs.mkdirSync(paths.stateLockPath, { recursive: true });
  fs.writeFileSync(
    path.join(paths.stateLockPath, 'owner.json'),
    JSON.stringify({ token: 'cleanup-owner', pid: process.pid, acquiredAt: new Date().toISOString() })
  );

  fs.rmSync(paths.sessionDir, { recursive: true, force: true });
  fs.rmSync(paths.stateLockPath, { recursive: true, force: true });
  const result = updateState(
    paths,
    { heartbeatAt: new Date().toISOString() },
    'cleanup-race-session'
  );

  assert.deepEqual(result, {});
  assert.equal(fs.existsSync(paths.sessionDir), false);
});

test('session-bound stream writer cannot recreate logs after cleanup', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'stale-writer-session',
    status: 'stopped',
  });
  const writer = createSanitizedStreamWriter(paths, {
    sessionId: 'stale-writer-session',
  });
  fs.rmSync(paths.sessionDir, { recursive: true, force: true });

  const result = writer.write('late line after cleanup\n');
  assert.equal(result, '');
  assert.equal(fs.existsSync(paths.sessionDir), false);
});

test('status marks a vanished recorded process as stale and persists recovery', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'stale-session',
    status: 'running',
    stale: false,
    projectRoot,
    runnerPid: 987654,
    metroPid: 987655,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  });

  const status = getStatus(projectRoot, { _isProcessAlive: () => false });
  assert.equal(status.status, 'stale');
  assert.equal(status.stale, true);
  assert.equal(status.running, false);
  assert.match(status.reason, /no longer running/);
  assert.equal(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).status, 'stale');
});

test('status rejects a recycled live PID when the runner heartbeat is stale', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'recycled-pid-session',
    status: 'running',
    stale: false,
    projectRoot,
    runnerPid: 12345,
    metroPid: 12346,
    startedAt: oldTimestamp,
    heartbeatAt: oldTimestamp,
  });

  const status = getStatus(projectRoot, {
    _isProcessAlive: () => true,
    _ownershipRecheckMs: 0,
  });
  assert.equal(status.status, 'stale');
  assert.equal(status.running, false);
  assert.match(status.reason, /no longer running/);
});

test('stop never signals recycled PIDs from a stale heartbeat', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'stale-stop-session',
    status: 'running',
    runnerPid: 54321,
    metroPid: 54322,
    startedAt: oldTimestamp,
    heartbeatAt: oldTimestamp,
  });
  let killCalls = 0;

  const result = require('../metro-session').stopSession(projectRoot, {
    _isProcessAlive: () => true,
    _ownershipRecheckMs: 0,
    _kill: () => { killCalls += 1; },
    _spawnSync: () => { killCalls += 1; return { status: 0 }; },
  });

  assert.equal(result.status, 'stale');
  assert.equal(result.stopped, false);
  assert.equal(killCalls, 0);
});

test('stop without a runner heartbeat never signals a starting PID', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'starting-no-heartbeat',
    status: 'starting',
    runnerPid: 43210,
    metroPid: null,
    startedAt: new Date().toISOString(),
  });
  let killCalls = 0;

  const result = require('../metro-session').stopSession(projectRoot, {
    _isProcessAlive: () => true,
    _ownershipRecheckMs: 0,
    _kill: () => { killCalls += 1; },
  });

  assert.equal(result.status, 'stale');
  assert.equal(result.stopped, false);
  assert.equal(killCalls, 0);
});

test('failed termination preserves stop-failed state and force clean refuses removal', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const now = new Date().toISOString();
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'unstoppable-session',
    status: 'running',
    runnerPid: 777,
    metroPid: 778,
    startedAt: now,
    heartbeatAt: now,
  });

  const stopResult = require('../metro-session').stopSession(projectRoot, {
    platform: 'win32',
    _isProcessAlive: () => true,
    _spawnSync: () => ({ status: 1 }),
    _ownershipRecheckMs: 0,
  });
  assert.equal(stopResult.status, 'stop-failed');
  assert.equal(stopResult.stopped, false);
  assert.ok(fs.existsSync(paths.statePath));

  assert.throws(
    () => cleanSession(projectRoot, {
      force: true,
      platform: 'win32',
      _isProcessAlive: () => true,
      _spawnSync: () => ({ status: 1 }),
      _ownershipRecheckMs: 0,
    }),
    /could not be stopped/
  );
  assert.ok(fs.existsSync(paths.sessionDir));
});

test('status recovers a live session when heartbeat refreshes after wake', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'wake-session',
    status: 'running',
    projectRoot,
    runnerPid: 123,
    metroPid: 456,
    startedAt: oldTimestamp,
    heartbeatAt: oldTimestamp,
  });

  const status = getStatus(projectRoot, {
    _isProcessAlive: () => true,
    _ownershipRecheckMs: 1,
    _sleepSync() {
      const current = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
      current.heartbeatAt = new Date().toISOString();
      writeState(paths, current);
    },
  });

  assert.equal(status.status, 'running');
  assert.equal(status.running, true);
  assert.equal(status.stale, undefined);
});

test('tail reads only bytes after a cursor and resets safely after log replacement', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  appendSanitized(paths, 'first line\n');
  const first = tailSession(projectRoot, { cursor: 0, maxBytes: 1024 });
  assert.equal(first.output, 'first line\n');
  assert.equal(first.nextCursor, Buffer.byteLength('first line\n'));

  appendSanitized(paths, 'second line\n');
  const second = tailSession(projectRoot, { cursor: first.nextCursor, maxBytes: 1024 });
  assert.equal(second.output, 'second line\n');

  fs.writeFileSync(paths.logPath, 'new log\n');
  const reset = tailSession(projectRoot, { cursor: second.nextCursor, maxBytes: 1024 });
  assert.equal(reset.cursor, 0);
  assert.equal(reset.truncated, true);
  assert.equal(reset.output, 'new log\n');
});

test('tail resets a cursor when the same session rotates to a new log generation', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const now = new Date().toISOString();
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'rotation-session',
    status: 'running',
    projectRoot,
    runnerPid: 111,
    metroPid: 222,
    startedAt: now,
    heartbeatAt: now,
    logGeneration: 3,
  });
  appendSanitized(paths, 'new generation line\n');

  const result = tailSession(projectRoot, {
    cursor: 8,
    generation: 2,
    maxBytes: 1024,
    _isProcessAlive: () => true,
  });

  assert.equal(result.generation, 3);
  assert.equal(result.cursor, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.rotationLost, true);
  assert.equal(result.output, 'new generation line\n');
});

test('tail waits for newly appended bytes before returning a clean observation', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const now = new Date().toISOString();
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'wait-session',
    status: 'running',
    projectRoot,
    runnerPid: 111,
    metroPid: 222,
    startedAt: now,
    heartbeatAt: now,
    logGeneration: 0,
  });
  appendSanitized(paths, 'baseline\n');
  const cursor = fs.statSync(paths.logPath).size;
  let waits = 0;
  let appended = false;

  const result = tailSession(projectRoot, {
    cursor,
    generation: 0,
    waitMs: 100,
    maxBytes: 1024,
    _isProcessAlive: () => true,
    _ownershipRecheckMs: 0,
    _sleepSync() {
      waits += 1;
      if (!appended) {
        appendSanitized(paths, 'new runtime error\n');
        appended = true;
      }
    },
  });

  assert.ok(waits >= 1);
  assert.equal(result.output, 'new runtime error\n');
  assert.ok(result.nextCursor > cursor);
  assert.equal(result.observationComplete, true);
});

test('tail marks observation incomplete when the session disappears while waiting', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  const now = new Date().toISOString();
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'disappearing-session',
    status: 'running',
    projectRoot,
    runnerPid: 111,
    metroPid: 222,
    startedAt: now,
    heartbeatAt: now,
    logGeneration: 0,
  });
  appendSanitized(paths, 'baseline\n');
  const cursor = fs.statSync(paths.logPath).size;
  let removed = false;

  const result = tailSession(projectRoot, {
    cursor,
    generation: 0,
    waitMs: 100,
    _isProcessAlive: () => true,
    _ownershipRecheckMs: 0,
    _sleepSync() {
      if (!removed) {
        fs.rmSync(paths.statePath, { force: true });
        removed = true;
      }
    },
  });

  assert.equal(result.status, 'not-started');
  assert.equal(result.observationComplete, false);
});

test('clean refuses to remove a live session and removes stopped session state', () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  writeState(paths, {
    schemaVersion: 1,
    sessionId: 'live-session',
    status: 'running',
    runnerPid: 123,
    metroPid: 456,
    heartbeatAt: new Date().toISOString(),
  });
  appendSanitized(paths, 'log line\n');

  assert.throws(
    () => cleanSession(projectRoot, {
      _isProcessAlive: () => true,
      _ownershipRecheckMs: 0,
    }),
    /Metro is still running/
  );
  assert.ok(fs.existsSync(paths.sessionDir));

  const result = cleanSession(projectRoot, { _isProcessAlive: () => false });
  assert.equal(result.status, 'clean');
  assert.equal(fs.existsSync(paths.sessionDir), false);
});

test('concurrent clean callers serialize outside the removable session directory', async () => {
  const projectRoot = makeProject();
  const paths = resolvePaths(projectRoot);
  appendSanitized(paths, 'cleanup fixture\n');

  const results = await Promise.all(
    Array.from({ length: 20 }, () => runCliAsync('clean', projectRoot))
  );

  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.status, 'clean');
  }
  assert.equal(fs.existsSync(paths.sessionDir), false);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('CLI manages a real detached fixture across start, status, tail, stop, and clean', (context) => {
  const projectRoot = makeProject();
  installFakeExpo(projectRoot);

  context.after(() => {
    runCli('stop', projectRoot);
    runCli('clean', projectRoot, ['--force']);
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

  const cleaned = runCli('clean', projectRoot);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(cleaned.json.status, 'clean');
  assert.equal(fs.existsSync(resolvePaths(projectRoot).sessionDir), false);
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

test('skill contracts use portable Metro state and declare sub-skill invocation', () => {
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
  assert.match(debugSkill, /Host terminal APIs are optional only/);
  assert.doesNotMatch(debugSkill, /BashOutput|METRO_TERMINAL_ID/);
  assert.doesNotMatch(debugSkill, /Which terminal is running/);
});