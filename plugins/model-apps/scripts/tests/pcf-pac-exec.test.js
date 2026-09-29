'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pacExec = require('../lib/pac-exec.js');
const genpage = require('../lib/genpage-cli.js');

test('genpage-cli keeps re-exporting the PAC helpers (backward compatible)', () => {
  assert.equal(genpage.buildPacInvocation, pacExec.buildPacInvocation);
  assert.equal(genpage.runPac, pacExec.runPac);
  assert.equal(genpage.quoteArg, pacExec.quoteArg);
});

test('win32 invocation is one command line with shell:true and carries cwd', () => {
  const inv = pacExec.buildPacInvocation(['pcf', 'push', '--environment', 'https://contoso.crm.dynamics.com'], 'win32', { cwd: 'C:\\p' });
  assert.equal(inv.args, undefined);
  assert.equal(inv.options.shell, true);
  assert.equal(inv.options.cwd, 'C:\\p');
  assert.match(inv.command, /^pac pcf push --environment https:\/\/contoso\.crm\.dynamics\.com$/);
});

test('posix invocation is an argv array without a shell', () => {
  const inv = pacExec.buildPacInvocation(['pcf', 'push'], 'linux', { cwd: '/p' });
  assert.deepEqual(inv.args, ['pcf', 'push']);
  assert.equal(inv.options.shell, undefined);
  assert.equal(inv.options.cwd, '/p');
});

test('runPac preserves spawn timeout error and signal for callers that need timeout handling', () => {
  const timeout = Object.assign(new Error('spawnSync pac ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const result = pacExec.runPac(['pcf', 'push'], {
    platform: 'linux',
    spawnSync: (command, args, options) => {
      assert.equal(command, 'pac');
      assert.deepEqual(args, ['pcf', 'push']);
      assert.equal(options.shell, undefined);
      return { status: null, stdout: '', stderr: 'timed out', error: timeout, signal: 'SIGTERM' };
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'timed out');
  assert.equal(result.error, timeout);
  assert.equal(result.signal, 'SIGTERM');
});
