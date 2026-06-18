'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pollPendingChanges, classifyTrend } = require('../lib/poll-pending-changes');

// A deterministic clock + sleep pair: sleep advances the virtual clock so the
// poller's time budget logic runs without real waiting.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
  };
}

// A scripted probe: returns the next count from a queue on each call.
function scriptedProbe(counts) {
  let i = 0;
  return async () => {
    const c = counts[Math.min(i, counts.length - 1)];
    i++;
    return { count: c };
  };
}

// ===== classifyTrend =====

test('classifyTrend: identical samples → stable', () => {
  assert.equal(classifyTrend([{ count: 5 }, { count: 5 }, { count: 5 }]), 'stable');
});

test('classifyTrend: monotonic up → increasing', () => {
  assert.equal(classifyTrend([{ count: 2 }, { count: 100 }, { count: 344 }]), 'increasing');
});

test('classifyTrend: monotonic down → decreasing', () => {
  assert.equal(classifyTrend([{ count: 344 }, { count: 10 }, { count: 0 }]), 'decreasing');
});

test('classifyTrend: up then down → fluctuating', () => {
  assert.equal(classifyTrend([{ count: 2 }, { count: 100 }, { count: 50 }]), 'fluctuating');
});

// ===== pollPendingChanges =====

test('returns stable once stableReads consecutive identical counts are seen', async () => {
  const clk = fakeClock();
  // climbs 2 → 100 → 344 → 344 → 344 (stable after 3 identical)
  const r = await pollPendingChanges({
    intervalMs: 30000, stableReads: 3, maxMs: 300000,
    _probeImpl: scriptedProbe([2, 100, 344, 344, 344]),
    _sleepImpl: clk.sleep, _nowImpl: clk.now,
  });
  assert.equal(r.stable, true);
  assert.equal(r.finalCount, 344);
  assert.equal(r.timedOut, false);
  assert.equal(r.reads, 5);
  // 4 sleeps of 30s elapsed between the 5 reads.
  assert.equal(r.polledForMs, 120000);
});

test('reports the STABLE count, not the early-poll count (the §17 ramp scenario)', async () => {
  const clk = fakeClock();
  const r = await pollPendingChanges({
    intervalMs: 30000, stableReads: 3, maxMs: 600000,
    _probeImpl: scriptedProbe([2, 2, 50, 200, 344, 344, 344]),
    _sleepImpl: clk.sleep, _nowImpl: clk.now,
  });
  assert.equal(r.stable, true);
  assert.equal(r.finalCount, 344, 'must not return the early count:2');
  assert.equal(r.trend, 'increasing');
});

test('times out with stable:false and the last observed count when the count never settles', async () => {
  const clk = fakeClock();
  // never repeats 3× in a row before the 5-min budget runs out
  const r = await pollPendingChanges({
    intervalMs: 30000, stableReads: 3, maxMs: 120000,
    _probeImpl: scriptedProbe([1, 2, 3, 4, 5, 6, 7, 8]),
    _sleepImpl: clk.sleep, _nowImpl: clk.now,
  });
  assert.equal(r.stable, false);
  assert.equal(r.timedOut, true);
  // Budget 120s, interval 30s: reads at 0,30,60,90,120 then next sleep would exceed → stop.
  assert.ok(r.polledForMs <= 120000);
  assert.equal(r.trend, 'increasing');
});

test('settles immediately when the first stableReads reads are already identical', async () => {
  const clk = fakeClock();
  const r = await pollPendingChanges({
    intervalMs: 30000, stableReads: 3, maxMs: 300000,
    _probeImpl: scriptedProbe([0, 0, 0]),
    _sleepImpl: clk.sleep, _nowImpl: clk.now,
  });
  assert.equal(r.stable, true);
  assert.equal(r.finalCount, 0);
  assert.equal(r.reads, 3);
});

test('surfaces a probe error and stops polling', async () => {
  const clk = fakeClock();
  const r = await pollPendingChanges({
    intervalMs: 30000, stableReads: 3, maxMs: 300000,
    _probeImpl: async () => ({ error: 'HTTP 403', statusCode: 403 }),
    _sleepImpl: clk.sleep, _nowImpl: clk.now,
  });
  assert.equal(r.error, 'HTTP 403');
  assert.equal(r.statusCode, 403);
});

test('stableReads=1 returns after the first read', async () => {
  const clk = fakeClock();
  const r = await pollPendingChanges({
    intervalMs: 30000, stableReads: 1, maxMs: 300000,
    _probeImpl: scriptedProbe([42]),
    _sleepImpl: clk.sleep, _nowImpl: clk.now,
  });
  assert.equal(r.stable, true);
  assert.equal(r.finalCount, 42);
  assert.equal(r.reads, 1);
});
