'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pollGitOperation } = require('../lib/poll-git-operation');

test('poll-git-operation: returns reached=true on first attempt when check is immediately done', async () => {
  const r = await pollGitOperation({
    check: async () => ({ done: true, value: { x: 1 } }),
    intervalMs: 1,
    maxAttempts: 5,
  });
  assert.equal(r.reached, true);
  assert.equal(r.attempts, 1);
  assert.equal(r.timedOut, false);
  assert.deepEqual(r.finalValue, { x: 1 });
});

test('poll-git-operation: polls multiple times before done=true', async () => {
  let n = 0;
  const r = await pollGitOperation({
    check: async () => { n++; return { done: n >= 3, value: { n } }; },
    intervalMs: 1,
    maxAttempts: 10,
  });
  assert.equal(r.reached, true);
  assert.equal(r.attempts, 3);
  assert.deepEqual(r.finalValue, { n: 3 });
});

test('poll-git-operation: returns timedOut when maxAttempts is reached', async () => {
  let n = 0;
  const r = await pollGitOperation({
    check: async () => { n++; return { done: false, value: { n } }; },
    intervalMs: 1,
    maxAttempts: 4,
  });
  assert.equal(r.reached, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.attempts, 4);
  assert.deepEqual(r.finalValue, { n: 4 });
});

test('poll-git-operation: invokes onAttempt callback', async () => {
  const attempts = [];
  await pollGitOperation({
    check: async () => ({ done: false, value: 'v' }),
    intervalMs: 1,
    maxAttempts: 3,
    onAttempt: (a, v) => attempts.push({ a, v }),
  });
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0].a, 1);
  assert.equal(attempts[2].v, 'v');
});

test('poll-git-operation: rejects when check throws', async () => {
  await assert.rejects(
    pollGitOperation({
      check: async () => { throw new Error('boom'); },
      intervalMs: 1, maxAttempts: 3,
    }),
    /check threw on attempt 1: boom/,
  );
});

test('poll-git-operation: validates required check arg', async () => {
  await assert.rejects(pollGitOperation({}), /`check` callback is required/);
});

test('poll-git-operation: validates maxAttempts is positive int', async () => {
  await assert.rejects(
    pollGitOperation({ check: async () => ({ done: true }), maxAttempts: 0 }),
    /maxAttempts must be a positive integer/,
  );
});

test('poll-git-operation: exponential backoff caps and grows', async () => {
  // We use intervalMs=1 with maxAttempts=4 so test stays fast.
  // The cap (30s) isn't exercised, but the multiplier path is.
  let n = 0;
  const r = await pollGitOperation({
    check: async () => { n++; return { done: n >= 3 }; },
    intervalMs: 1,
    maxAttempts: 5,
    backoff: 'exponential',
  });
  assert.equal(r.reached, true);
  assert.equal(r.attempts, 3);
});
