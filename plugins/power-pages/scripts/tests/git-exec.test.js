'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  runGit,
  scrubToken,
  clone,
  fetch,
  checkout,
  merge,
  mergeAbort,
  push,
  status,
  revParse,
  lsRemote,
  add,
  addAll,
  commit,
} = require('../lib/git-exec');

function fakeSpawnQueue(responses, calls = []) {
  return (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const next = responses.shift() || { status: 0, stdout: '', stderr: '' };
    if (next.throw) throw next.throw;
    return next;
  };
}

function successSpawn(calls) {
  return fakeSpawnQueue([{ status: 0, stdout: 'ok\n', stderr: '' }], calls);
}

test('git-exec: injects token as per-invocation http.extraHeader config', () => {
  const calls = [];
  const token = 'SECRET_TOKEN';
  const r = runGit({
    cwd: 'C:\\repo',
    args: ['ls-remote', 'https://dev.azure.com/o/p/_git/r'],
    token,
    spawnImpl: successSpawn(calls),
  });

  assert.equal(r.ok, true);
  assert.equal(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args.slice(0, 4), [
    '-c', 'core.longpaths=true',
    '-c', `http.extraHeader=AUTHORIZATION: bearer ${token}`,
  ]);
  assert.deepEqual(calls[0].args.slice(4), ['ls-remote', 'https://dev.azure.com/o/p/_git/r']);
});

test('git-exec: scrubToken replaces token in text', () => {
  assert.equal(scrubToken('AUTHORIZATION: bearer SECRET_TOKEN', 'SECRET_TOKEN'), 'AUTHORIZATION: bearer ***');
  assert.equal(scrubToken(Buffer.from('x SECRET_TOKEN y'), 'SECRET_TOKEN'), 'x *** y');
  assert.equal(scrubToken(null, 'SECRET_TOKEN'), '');
});

test('git-exec: scrubs token from returned stdout and stderr', () => {
  const token = 'SECRET_TOKEN';
  const r = runGit({
    args: ['fetch', 'origin'],
    token,
    retries: 0,
    spawnImpl: fakeSpawnQueue([
      {
        status: 128,
        stdout: `echoed http.extraHeader=AUTHORIZATION: bearer ${token}`,
        stderr: `fatal: unable to access with ${token}`,
      },
    ]),
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 128);
  assert.doesNotMatch(r.stdout, new RegExp(token));
  assert.doesNotMatch(r.stderr, new RegExp(token));
  assert.match(r.stdout, /\*\*\*/);
  assert.match(r.stderr, /\*\*\*/);
});

test('git-exec: thrown programming errors do not include token', () => {
  const token = 'SECRET_TOKEN';
  assert.throws(
    () => runGit({ args: 'status', token, spawnImpl: successSpawn([]) }),
    (e) => {
      assert.doesNotMatch(e.message, new RegExp(token));
      return /args must be an array/.test(e.message);
    },
  );
});

test('git-exec: retries transient failures then succeeds', () => {
  const calls = [];
  const r = runGit({
    args: ['fetch', 'origin'],
    retries: 2,
    sleepImpl: () => {},
    spawnImpl: fakeSpawnQueue([
      { status: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: dev.azure.com' },
      { status: 128, stdout: '', stderr: 'fatal: unable to access: connection timed out' },
      { status: 0, stdout: 'done', stderr: '' },
    ], calls),
  });

  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'done');
  assert.equal(calls.length, 3);
});

test('git-exec: auth failures do not retry', () => {
  const calls = [];
  const r = runGit({
    args: ['fetch', 'origin'],
    retries: 2,
    spawnImpl: fakeSpawnQueue([
      { status: 128, stdout: '', stderr: 'fatal: unable to access: The requested URL returned error: 403' },
      { status: 0, stdout: 'should not happen', stderr: '' },
    ], calls),
  });

  assert.equal(r.ok, false);
  assert.equal(r.code, 128);
  assert.equal(calls.length, 1);
});

test('git-exec: result shape is correct for success and failure', () => {
  const success = runGit({
    args: ['status'],
    spawnImpl: fakeSpawnQueue([{ status: 0, stdout: 'clean', stderr: '' }]),
  });
  assert.deepEqual(success, { ok: true, code: 0, stdout: 'clean', stderr: '' });

  const failure = runGit({
    args: ['status'],
    retries: 0,
    spawnImpl: fakeSpawnQueue([{ status: 1, stdout: '', stderr: 'failed' }]),
  });
  assert.deepEqual(failure, { ok: false, code: 1, stdout: '', stderr: 'failed' });
});

test('git-exec: convenience wrappers call expected git subcommands and args', () => {
  const cases = [
    [() => clone({ repoUrl: 'https://example/repo', dir: 'repo', branch: 'main', spawnImpl: successSpawn(calls) }), ['clone', '--branch', 'main', 'https://example/repo', 'repo']],
    [() => fetch({ remote: 'upstream', refspec: ['main', 'feature'], spawnImpl: successSpawn(calls) }), ['fetch', 'upstream', 'main', 'feature']],
    [() => checkout({ newBranch: 'feature', startPoint: 'origin/main', spawnImpl: successSpawn(calls) }), ['checkout', '-b', 'feature', 'origin/main']],
    [() => checkout({ ref: 'main', spawnImpl: successSpawn(calls) }), ['checkout', 'main']],
    [() => merge({ ref: 'origin/main', spawnImpl: successSpawn(calls) }), ['merge', 'origin/main']],
    [() => mergeAbort({ spawnImpl: successSpawn(calls) }), ['merge', '--abort']],
    [() => push({ remote: 'origin', refspec: 'HEAD:main', spawnImpl: successSpawn(calls) }), ['push', 'origin', 'HEAD:main']],
    [() => status({ spawnImpl: successSpawn(calls) }), ['status', '--porcelain']],
    [() => revParse({ rev: 'HEAD', spawnImpl: successSpawn(calls) }), ['rev-parse', 'HEAD']],
    [() => lsRemote({ remote: 'origin', refs: ['refs/heads/main'], spawnImpl: successSpawn(calls) }), ['ls-remote', 'origin', 'refs/heads/main']],
    [() => add({ paths: ['file.txt'], spawnImpl: successSpawn(calls) }), ['add', 'file.txt']],
    [() => addAll({ spawnImpl: successSpawn(calls) }), ['add', '--all']],
    [() => commit({ message: 'merge result', spawnImpl: successSpawn(calls) }), ['commit', '-m', 'merge result']],
  ];

  const calls = [];
  for (const [invoke] of cases) invoke();

  // Each invocation is prefixed with `-c core.longpaths=true`; compare the rest.
  assert.deepEqual(calls.map((c) => c.args.slice(2)), cases.map((c) => c[1]));
});
