'use strict';
// The build's transient retry re-runs a phase as soon as the phase reports a failure. A bounded fan-out
// that reports the first failure while sibling writes are still in flight lets those writes land after
// the retry's discovery has already looked — the retry then creates the same view again under a new id.
// These pin that mapLimit starts nothing after a failure and reports it only once every in-flight item
// has settled.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRunner } = require('../lib/entity-provision.js');

const { mapLimit } = makeRunner({ emit() {}, total: 0 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('mapLimit keeps input order on success', async () => {
  const out = await mapLimit([30, 5, 15], 2, async (ms, idx) => { await sleep(ms); return idx; });
  assert.deepStrictEqual(out, [0, 1, 2]);
});

test('mapLimit reports a failure only after in-flight items settle, and starts nothing new', async () => {
  const events = [];
  const started = [];
  const failure = new Error('first failure');
  const run = mapLimit(['fails', 'slow', 'later-1', 'later-2'], 2, async (item) => {
    started.push(item);
    if (item === 'fails') { await sleep(5); events.push('failed'); throw failure; }
    if (item === 'slow') { await sleep(60); events.push('slow write landed'); return item; }
    events.push(`${item} ran`);
    return item;
  });
  await assert.rejects(run, (err) => err === failure);
  events.push('reported');
  assert.deepStrictEqual(events, ['failed', 'slow write landed', 'reported']);
  assert.deepStrictEqual(started, ['fails', 'slow'], 'nothing is started after the first failure');
});

test('mapLimit rethrows the first failure when several in-flight items fail', async () => {
  const first = new Error('first');
  const second = new Error('second');
  await assert.rejects(
    mapLimit([5, 25], 2, async (ms) => { await sleep(ms); throw ms === 5 ? first : second; }),
    (err) => err === first,
  );
});

// verify and download fan out READS whose report must not depend on which response came back first.
test('the runner and the module export are one limiter', () => {
  assert.strictEqual(require('../lib/entity-provision.js').mapLimit, mapLimit);
});

test('firstInOrder rethrows the failure of the lowest-indexed item, not the first to settle', async () => {
  const low = new Error('item 0 (slow to fail)');
  const high = new Error('item 1 (fails first)');
  const started = [];
  await assert.rejects(
    mapLimit(['slow', 'quick', 'never'], 2, async (item) => {
      started.push(item);
      if (item === 'slow') { await sleep(40); throw low; }
      await sleep(2);
      throw high;
    }, { firstInOrder: true }),
    (err) => err === low,
  );
  assert.deepStrictEqual(started, ['slow', 'quick'], 'nothing is started after a failure');
});

test('without firstInOrder the same two failures report the first to settle (the build contract)', async () => {
  const low = new Error('item 0 (slow to fail)');
  const high = new Error('item 1 (fails first)');
  await assert.rejects(
    mapLimit(['slow', 'quick'], 2, async (item) => {
      if (item === 'slow') { await sleep(40); throw low; }
      await sleep(2);
      throw high;
    }),
    (err) => err === high,
  );
});

test('firstInOrder keeps the output order and the drain-before-report rule', async () => {
  const out = await mapLimit([30, 5, 15], 2, async (ms, idx) => { await sleep(ms); return idx; }, { firstInOrder: true });
  assert.deepStrictEqual(out, [0, 1, 2]);
  const events = [];
  const failure = new Error('item 1');
  await assert.rejects(
    mapLimit(['ok-slow', 'fails', 'later'], 2, async (item) => {
      if (item === 'fails') { await sleep(2); events.push('failed'); throw failure; }
      if (item === 'ok-slow') { await sleep(40); events.push('slow landed'); return item; }
      events.push('started after the failure');
      return item;
    }, { firstInOrder: true }),
    (err) => err === failure,
  );
  events.push('reported');
  assert.deepStrictEqual(events, ['failed', 'slow landed', 'reported']);
});
