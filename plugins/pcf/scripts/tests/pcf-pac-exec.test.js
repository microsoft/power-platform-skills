'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pacExec = require('../lib/pac-exec.js');

test('buildPacInvocation delegates to process-runner with the real Windows batch invocation shape', () => {
  const env = {
    Path: 'C:\\tools',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  };
  const inv = pacExec.buildPacInvocation(['pcf', 'push', '--environment', 'https://contoso.crm.dynamics.com'], {
    platform: 'win32',
    env,
    exists: (file) => file === 'C:\\tools\\pac.cmd',
    readFile: () => '@echo off\r\n',
  });

  assert.deepEqual(inv, {
    file: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', '""C:\\tools\\pac.cmd" pcf push --environment https://contoso.crm.dynamics.com"'],
    options: {
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' },
    },
  });
});

test('runPac uses process-runner spawnResultSync with cwd, timeout, and utf8 encoding', () => {
  const calls = [];
  const result = pacExec.runPac(['pcf', 'push'], {
    cwd: 'C:\\p',
    timeoutMs: 1234,
    spawnResultSync: (name, args, options, deps) => {
      calls.push({ name, args, options, deps });
      return { status: 0, stdout: 'ok', stderr: '', signal: null };
    },
    env: { PATH: 'C:\\tools' },
  });

  assert.equal(result.status, 0);
  assert.deepEqual(calls, [{
    name: 'pac',
    args: ['pcf', 'push'],
    options: { cwd: 'C:\\p', env: { PATH: 'C:\\tools' }, encoding: 'utf8', timeout: 1234 },
    deps: { env: { PATH: 'C:\\tools' } },
  }]);
});

test('runPac preserves process-runner timeout error and signal for callers that need timeout handling', () => {
  const timeout = Object.assign(new Error('spawnSync pac ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const result = pacExec.runPac(['pcf', 'push'], {
    spawnResultSync: (name, args, options) => {
      assert.equal(name, 'pac');
      assert.deepEqual(args, ['pcf', 'push']);
      assert.equal(options.encoding, 'utf8');
      return { status: null, stdout: '', stderr: 'timed out', error: timeout, signal: 'SIGTERM' };
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'timed out');
  assert.equal(result.error, timeout);
  assert.equal(result.signal, 'SIGTERM');
});

test('runPac reports process-runner argument refusals as a structured failed process result', () => {
  const refused = Object.assign(new Error('cannot pass "%" to pac.cmd'), { code: 'EARGUMENT' });
  const result = pacExec.runPac(['pcf', 'push', '--environment', 'https://contoso.crm.dynamics.com/%bad'], {
    spawnResultSync: () => ({ status: null, stdout: '', stderr: '', error: refused, signal: null }),
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'cannot pass "%" to pac.cmd');
  assert.equal(result.error.code, 'EARGUMENT');
});
