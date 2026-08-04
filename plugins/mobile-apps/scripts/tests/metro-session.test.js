'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'metro-session.js');
const {
  getStatus,
  listLogs,
  parseArgs,
  parseLogFile,
  portListenerPids,
  processIsAlive,
  resolveLog,
  resolvePaths,
  resolveStatus,
  tailSession,
} = require('../metro-session');

function makeProject(prefix = 'mobile-metro-log-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeLog(projectRoot, options = {}) {
  const paths = resolvePaths(projectRoot);
  fs.mkdirSync(paths.logDir, { recursive: true });
  const stamp = options.stamp || '2026-08-04T08-00-00-000Z';
  const pid = options.pid || 111;
  const port = options.port === undefined ? 8081 : options.port;
  const name = `metro-${stamp}-pid-${pid}-port-${port === null ? 'unknown' : port}.log`;
  const logPath = path.join(paths.logDir, name);
  fs.writeFileSync(logPath, options.content || 'Starting Metro\nWaiting on http://localhost:8081\n');
  if (options.modifiedMs) {
    const time = new Date(options.modifiedMs);
    fs.utimesSync(logPath, time, time);
  }
  return logPath;
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

test('parseArgs validates status and tail options', () => {
  const status = parseArgs(['status', '--project-root', '/tmp/app']);
  assert.equal(status.command, 'status');
  assert.equal(status.projectRoot, '/tmp/app');

  const tail = parseArgs(['tail', '--cursor', '5', '--wait-ms', '100', '--lines', '10', '--max-bytes', '2048']);
  assert.equal(tail.cursor, 5);
  assert.equal(tail.waitMs, 100);
  assert.equal(tail.lines, 10);
  assert.equal(tail.maxBytes, 2048);

  assert.throws(() => parseArgs(['tail', '--cursor', '-1']), /--cursor/);
  assert.throws(() => parseArgs(['status', '--unknown']), /Unknown argument/);
});

test('parseLogFile extracts timestamp, PID, port, and size', () => {
  const projectRoot = makeProject();
  const logPath = writeLog(projectRoot, {
    stamp: '2026-08-04T08-10-11-123Z',
    pid: 4242,
    port: 8099,
    content: 'hello\n',
  });

  const parsed = parseLogFile(logPath);
  assert.equal(parsed.startedAt, '2026-08-04T08-10-11-123Z');
  assert.equal(parsed.pid, 4242);
  assert.equal(parsed.port, 8099);
  assert.equal(parsed.size, Buffer.byteLength('hello\n'));
  assert.equal(parseLogFile(path.join(projectRoot, 'not-a-log.txt')), null);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('listLogs sorts newest first and resolveLog can select by port', () => {
  const projectRoot = makeProject();
  const older = writeLog(projectRoot, { pid: 1, port: 8081, modifiedMs: Date.now() - 10_000 });
  const newer = writeLog(projectRoot, { stamp: '2026-08-04T08-20-00-000Z', pid: 2, port: 8082, modifiedMs: Date.now() });

  const logs = listLogs(projectRoot);
  assert.equal(logs[0].logPath, newer);
  assert.equal(logs[1].logPath, older);
  assert.equal(resolveLog(projectRoot).port, 8082);
  assert.equal(resolveLog(projectRoot, { port: 8081 }).logPath, older);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('portListenerPids parses lsof output and distinguishes empty from unknown', () => {
  assert.deepEqual(portListenerPids(8081, {
    platform: 'darwin',
    _spawnSync: () => ({ stdout: '41233\n41240\n', status: 0 }),
  }), [41233, 41240]);

  assert.deepEqual(portListenerPids(8081, {
    platform: 'darwin',
    _spawnSync: () => ({ stdout: '', status: 1 }),
  }), []);

  assert.equal(portListenerPids(8081, {
    platform: 'darwin',
    _spawnSync: () => ({ error: new Error('spawn lsof ENOENT') }),
  }), null);
});

test('portListenerPids parses Windows netstat LISTENING rows', () => {
  const stdout = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:8081           0.0.0.0:0              LISTENING       41233',
    '  TCP    [::]:8081              [::]:0                 LISTENING       41233',
    '  TCP    127.0.0.1:8081         127.0.0.1:5000         ESTABLISHED     777',
  ].join('\r\n');

  assert.deepEqual(portListenerPids(8081, {
    platform: 'win32',
    _spawnSync: () => ({ stdout, status: 0 }),
  }), [41233]);
});

test('resolveStatus reports running when the log PID owns the port', () => {
  const status = resolveStatus(
    { pid: 222, port: 8081, size: 0, logPath: 'x' },
    { _isProcessAlive: (pid) => pid === 222, _portListenerPids: () => [222] }
  );
  assert.equal(status.status, 'running');
  assert.equal(status.running, true);
  assert.equal(status.portOwnedBySession, true);
});

test('resolveStatus falls back to PID liveness when the port cannot be probed', () => {
  const status = resolveStatus(
    { pid: 222, port: 8081, size: 0, logPath: 'x' },
    { _isProcessAlive: (pid) => pid === 222, _portListenerPids: () => null }
  );
  assert.equal(status.status, 'running');
  assert.equal(status.portOwnedBySession, null);
});

test('resolveStatus flags port-taken and port-conflict', () => {
  const taken = resolveStatus(
    { pid: 222, port: 8081, size: 0, logPath: 'x' },
    { _isProcessAlive: () => false, _portListenerPids: () => [999] }
  );
  assert.equal(taken.status, 'port-taken');

  const conflict = resolveStatus(
    { pid: 222, port: 8081, size: 0, logPath: 'x' },
    { _isProcessAlive: () => true, _portListenerPids: () => [999] }
  );
  assert.equal(conflict.status, 'port-conflict');
});

test('getStatus returns latest log status and not-started without logs', () => {
  const projectRoot = makeProject();
  assert.equal(getStatus(projectRoot).status, 'not-started');
  writeLog(projectRoot, { pid: 222, port: 8081 });

  const status = getStatus(projectRoot, {
    _isProcessAlive: (pid) => pid === 222,
    _portListenerPids: () => [222],
  });
  assert.equal(status.status, 'running');
  assert.equal(status.port, 8081);
  assert.match(status.logPath, /metro-.*-pid-222-port-8081\.log$/);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('tailSession reads from a cursor and resets when the log shrinks', () => {
  const projectRoot = makeProject();
  const logPath = writeLog(projectRoot, { pid: process.pid, port: null, content: 'first\n' });
  const first = tailSession(projectRoot, { cursor: 0, maxBytes: 1024 });
  assert.equal(first.output, 'first\n');
  assert.equal(first.nextCursor, Buffer.byteLength('first\n'));

  fs.appendFileSync(logPath, 'second\n');
  const second = tailSession(projectRoot, { cursor: first.nextCursor, maxBytes: 1024 });
  assert.equal(second.output, 'second\n');

  fs.writeFileSync(logPath, 'new\n');
  const reset = tailSession(projectRoot, { cursor: second.nextCursor, maxBytes: 1024 });
  assert.equal(reset.cursor, 0);
  assert.equal(reset.rotationLost, true);
  assert.equal(reset.output, 'new\n');
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('tailSession waits the full observation window before clean output', () => {
  const projectRoot = makeProject();
  const logPath = writeLog(projectRoot, { pid: 222, port: 8081, content: 'baseline\n' });
  const cursor = fs.statSync(logPath).size;
  let appended = false;

  const result = tailSession(projectRoot, {
    cursor,
    waitMs: 100,
    maxBytes: 1024,
    _isProcessAlive: () => true,
    _portListenerPids: () => [222],
  });
  if (!appended) {
    fs.appendFileSync(logPath, 'after\n');
    appended = true;
  }

  assert.equal(result.observationComplete, true);
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('CLI status and tail read .powernative logs', () => {
  const projectRoot = makeProject();
  writeLog(projectRoot, { pid: process.pid, port: null, content: 'Starting Metro\n' });

  const status = runCli('status', projectRoot);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json.status, 'running');

  const tail = runCli('tail', projectRoot, ['--cursor', '0']);
  assert.equal(tail.status, 0, tail.stderr);
  assert.equal(tail.json.output, 'Starting Metro\n');
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

test('template Metro config writes .powernative logs and HTTP failures', () => {
  const templateRoot = path.resolve(__dirname, '..', '..', 'template');
  const metroConfig = fs.readFileSync(path.join(templateRoot, 'metro.config.js'), 'utf8');
  const gitignore = fs.readFileSync(path.join(templateRoot, '.gitignore'), 'utf8');

  assert.match(metroConfig, /\.powernative/);
  assert.match(metroConfig, /withPowerNativeLogging/);
  assert.match(metroConfig, /res\.statusCode >= 400/);
  assert.match(metroConfig, /REDACTED_SENSITIVE_LINE/);
  assert.match(gitignore, /^\.powernative\//m);
});

test('skill contracts use .powernative logs without terminal IDs or wrapper starts', () => {
  const pluginRoot = path.resolve(__dirname, '..', '..');
  const createSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'create-mobile-app', 'SKILL.md'), 'utf8');
  const debugSkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'debug-app', 'SKILL.md'), 'utf8');
  const deploySkill = fs.readFileSync(path.join(pluginRoot, 'skills', 'deploy', 'SKILL.md'), 'utf8');

  const createFrontmatter = createSkill.split('---', 3)[1];
  assert.match(createFrontmatter, /allowed-tools:.*\bSkill\b/);
  assert.match(createSkill, /\.powernative\/metro-logs/);
  assert.match(createSkill, /npm run dev/);
  assert.doesNotMatch(createSkill, /scripts\/metro-session\.js" start|dev:expo|copy the plugin wrapper/i);
  assert.match(debugSkill, /\.powernative\/metro-logs/);
  assert.match(debugSkill, /port-taken/);
  assert.doesNotMatch(debugSkill, /BashOutput|METRO_TERMINAL_ID|start --project-root/);
  assert.match(deploySkill, /\.powernative/);
});

test('processIsAlive handles invalid and current PIDs', () => {
  assert.equal(processIsAlive(0), false);
  assert.equal(processIsAlive(process.pid), true);
});
