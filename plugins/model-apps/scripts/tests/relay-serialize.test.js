// Tests for the relay serializer (scripts/relay/serialize.js).
// Run: node --test plugins/model-apps/scripts/tests/relay-serialize.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { Serializer } = require(path.join(__dirname, '..', 'relay', 'serialize.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runs ops one at a time, in submission order', async () => {
  const s = new Serializer();
  const log = [];
  const a = s.run(async () => { await sleep(25); log.push('a'); });
  const b = s.run(async () => { log.push('b'); });
  await Promise.all([a, b]);
  assert.deepStrictEqual(log, ['a', 'b']);
});

test('returns the op result and propagates its error without wedging the queue', async () => {
  const s = new Serializer();
  const ok = await s.run(async () => 42);
  assert.strictEqual(ok, 42);

  await assert.rejects(() => s.run(async () => { throw new Error('boom'); }), /boom/);

  // queue still works after a failure
  const after = await s.run(async () => 'still here');
  assert.strictEqual(after, 'still here');
});

test('times out a wedged op', async () => {
  const s = new Serializer();
  await assert.rejects(() => s.run(() => new Promise(() => {}), 30), /op timeout after 30ms/);
});
