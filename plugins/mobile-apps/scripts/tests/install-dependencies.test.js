'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LOG_FILE,
  RESULT_FILE,
  STATE_DIR,
  STATE_FILE,
  npmCliPath,
  readStatus,
  runInstall,
  startInstall,
  waitForInstall,
} = require('../install-dependencies');

const scriptPath = path.resolve(__dirname, '..', 'install-dependencies.js');

function tempProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"probe"}\n');
  return root;
}

function statePath(projectRoot, fileName) {
  return path.join(projectRoot, STATE_DIR, fileName);
}

function writeState(projectRoot, value) {
  fs.mkdirSync(path.join(projectRoot, STATE_DIR), { recursive: true });
  fs.writeFileSync(statePath(projectRoot, STATE_FILE), `${JSON.stringify(value)}\n`);
}

/**
 * Point the install at a stub CLI so these tests exercise the real spawn, detach and
 * exit-code plumbing without downloading the template's dependency tree. The stub runs
 * under `node`, so it behaves identically on Windows and POSIX.
 */
function fakeNpm(t, { exitCode = 0, message = 'fake npm install' } = {}) {
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-npm-'));
  const stub = path.join(stubDir, 'fake-npm-cli.js');
  fs.writeFileSync(
    stub,
    `process.stdout.write(${JSON.stringify(`${message}\n`)});\nprocess.exit(${exitCode});\n`,
  );

  const original = process.env.POWER_PLATFORM_SKILLS_FAKE_NPM;
  process.env.POWER_PLATFORM_SKILLS_FAKE_NPM = stub;
  t.after(() => {
    if (original === undefined) delete process.env.POWER_PLATFORM_SKILLS_FAKE_NPM;
    else process.env.POWER_PLATFORM_SKILLS_FAKE_NPM = original;
  });
  return stub;
}

test('a folder with no install attempt reports not-started', () => {
  const project = tempProject('install-fresh');
  const status = readStatus(project);
  assert.equal(status.state, 'not-started');
  assert.equal(status.dependenciesInstalled, false);
});

test('dependencies present without plugin state count as already installed', () => {
  const project = tempProject('install-preinstalled');
  fs.mkdirSync(path.join(project, 'node_modules', 'expo'), { recursive: true });
  assert.equal(readStatus(project).state, 'already-installed');
});

test('a live worker reports running and a dead one reports stalled', () => {
  const project = tempProject('install-liveness');

  writeState(project, { pid: process.pid, startedAt: new Date().toISOString() });
  assert.equal(readStatus(project).state, 'running');

  // A PID that cannot belong to a live process; a vanished worker must never be
  // reported as success even when node_modules looks partially populated.
  writeState(project, { pid: -1, startedAt: new Date().toISOString() });
  fs.mkdirSync(path.join(project, 'node_modules', 'expo'), { recursive: true });
  const stalled = readStatus(project);
  assert.equal(stalled.state, 'stalled');
  assert.equal(stalled.dependenciesInstalled, true);
});

test('a recorded exit code decides success or failure', () => {
  const project = tempProject('install-result');
  fs.mkdirSync(path.join(project, STATE_DIR), { recursive: true });
  fs.writeFileSync(path.join(project, STATE_DIR, LOG_FILE), 'npm ERR! code E404\n');

  fs.writeFileSync(statePath(project, RESULT_FILE), JSON.stringify({ exitCode: 0 }));
  const succeeded = readStatus(project);
  assert.equal(succeeded.state, 'succeeded');
  assert.equal(succeeded.logTail, undefined, 'a clean install needs no log excerpt');

  fs.writeFileSync(statePath(project, RESULT_FILE), JSON.stringify({ exitCode: 1 }));
  const failed = readStatus(project);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.exitCode, 1);
  assert.match(failed.logTail, /E404/);
});

test('runInstall records a successful npm run', (t) => {
  const project = tempProject('install-run-ok');
  fakeNpm(t);

  assert.equal(runInstall(project), 0);
  assert.equal(readStatus(project).state, 'succeeded');
  assert.match(
    fs.readFileSync(path.join(project, STATE_DIR, LOG_FILE), 'utf8'),
    /fake npm install/,
  );
});

test('runInstall records a failing npm run with its output', (t) => {
  const project = tempProject('install-run-fail');
  fakeNpm(t, { exitCode: 1, message: 'npm ERR! code E404' });

  assert.equal(runInstall(project), 1);
  const status = readStatus(project);
  assert.equal(status.state, 'failed');
  assert.match(status.logTail, /E404/);
});

test('an npm that cannot launch is a failure, not a silent success', (t) => {
  const project = tempProject('install-run-missing');
  const original = process.env.POWER_PLATFORM_SKILLS_FAKE_NPM;
  process.env.POWER_PLATFORM_SKILLS_FAKE_NPM = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'empty-bin-')),
    'does-not-exist.js',
  );
  t.after(() => {
    if (original === undefined) delete process.env.POWER_PLATFORM_SKILLS_FAKE_NPM;
    else process.env.POWER_PLATFORM_SKILLS_FAKE_NPM = original;
  });

  assert.notEqual(runInstall(project), 0);
  assert.equal(readStatus(project).state, 'failed');
});

test('npm is reachable without a shell on this platform', () => {
  // Guards the Windows branch of spawnNpmInstall: if npm ever stops living beside
  // node.exe, the install would fail at runtime with no way to fall back.
  if (process.platform !== 'win32') return;
  assert.notEqual(npmCliPath(), '', 'npm-cli.js must exist next to node.exe');
});

test('start detaches a worker that the caller can later wait on', (t) => {
  const project = tempProject('install-start');
  fakeNpm(t);

  const started = startInstall(project);
  assert.equal(started.state, 'running');
  assert.ok(started.pid > 0);

  const finished = waitForInstall(project, 60000);
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.exitCode, 0);
});

test('start adopts an install already in flight instead of launching a second npm', () => {
  const project = tempProject('install-reentry');
  writeState(project, { pid: process.pid, startedAt: new Date().toISOString() });

  const started = startInstall(project);
  assert.equal(started.state, 'running');
  assert.equal(started.pid, process.pid);
});

test('start refuses a folder with no package.json', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'install-nopkg-'));
  assert.throws(() => startInstall(project), /nothing to install/);
});

test('wait gives up on a worker that never finishes', () => {
  const project = tempProject('install-timeout');
  writeState(project, { pid: process.pid, startedAt: new Date().toISOString() });

  const timedOut = waitForInstall(project, 10);
  assert.equal(timedOut.state, 'timeout');
  assert.equal(timedOut.timeoutMs, 10);
});

test('the CLI exits non-zero until dependencies are actually installed', (t) => {
  const project = tempProject('install-cli');
  fakeNpm(t);

  const notStarted = spawnSync(process.execPath, [scriptPath, '--working-dir', project, 'status'], {
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(notStarted.status, 1);
  assert.equal(JSON.parse(notStarted.stdout.trim()).state, 'not-started');

  const started = spawnSync(process.execPath, [scriptPath, '--working-dir', project, 'start'], {
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout.trim()).state, 'running');

  const waited = spawnSync(
    process.execPath,
    [scriptPath, '--working-dir', project, 'wait', '--timeout-ms', '60000'],
    { encoding: 'utf8', env: process.env },
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout.trim()).state, 'succeeded');
});

test('the CLI rejects an unknown command', () => {
  const rejected = spawnSync(process.execPath, [scriptPath, 'reinstall'], { encoding: 'utf8' });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Unknown command: reinstall/);
});
