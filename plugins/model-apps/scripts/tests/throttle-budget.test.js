'use strict';
// lib/throttle-budget.js: the budget a run allows its own retry layers for waiting out a throttled service — in the page backend (the waits between a page write's sends) and in the build's own retry loop (the wait before it runs again). The HTTP client's own re-sends are not drawn from it.
// The layers wait with seams of their own, so the budget only COUNTS: what a wait is, and whether it fits, is decided here, once.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { THROTTLE_BUDGET_MS, QUIET_WAIT_MS, makeThrottleBudget, waitDoesNotFit, spentNote } = require('../lib/throttle-budget.js');

test('the budget is five minutes, and a wait of up to five seconds is not worth a line', () => {
  assert.strictEqual(THROTTLE_BUDGET_MS, 5 * 60 * 1000);
  assert.strictEqual(QUIET_WAIT_MS, 5000);
  const budget = makeThrottleBudget();
  assert.deepStrictEqual([budget.totalMs, budget.spentMs(), budget.remainingMs()], [300000, 0, 300000]);
});

test('a budget spends what is waited and fits what is left, to the millisecond — what is spent is never given back', () => {
  const budget = makeThrottleBudget();
  assert.strictEqual(budget.fits(0), true);
  assert.strictEqual(budget.fits(300000), true, 'all of it fits');
  assert.strictEqual(budget.fits(300001), false);
  budget.spend(120000);
  assert.deepStrictEqual([budget.spentMs(), budget.remainingMs()], [120000, 180000]);
  assert.strictEqual(budget.fits(180000), true);
  assert.strictEqual(budget.fits(180001), false, 'what is left is what was not spent');
  budget.spend(180000);
  assert.deepStrictEqual([budget.spentMs(), budget.remainingMs()], [300000, 0]);
  assert.strictEqual(budget.fits(1), false);
  assert.strictEqual(budget.fits(0), true, 'no wait always fits');
  budget.spend(5000);
  assert.strictEqual(budget.remainingMs(), 0, 'a wait that was taken anyway leaves nothing, never less than nothing');
  assert.strictEqual(makeThrottleBudget({ totalMs: 20000 }).remainingMs(), 20000, 'a caller may give another size');
  for (const nothing of [undefined, null, Number.NaN, -5, 'x']) {
    const budget2 = makeThrottleBudget();
    budget2.spend(nothing);
    assert.strictEqual(budget2.spentMs(), 0, `${nothing} is no wait`);
  }
});

test('announce: a wait longer than five seconds is announced through the warn seam — a shorter one, and a budget with no seam, say nothing', () => {
  const lines = [];
  const budget = makeThrottleBudget({ warn: (message) => lines.push(message) });
  budget.announce('quiet', 5000);
  budget.announce('quiet', 1000);
  assert.deepStrictEqual(lines, []);
  budget.announce('worth a line', 5001);
  budget.announce('another', 60000);
  assert.deepStrictEqual(lines, ['worth a line', 'another']);
  assert.doesNotThrow(() => makeThrottleBudget().announce('nobody listens', 60000));
});

test('waitDoesNotFit: says what the service asked, how much of the budget is left and that a later run continues — in whole seconds, rounded up', () => {
  const budget = makeThrottleBudget();
  budget.spend(245500);
  assert.strictEqual(
    waitDoesNotFit(budget, { askedMs: 600000, waitMs: 600000 }),
    'the service asked to wait 600 s before the next send, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service (246 s are spent). Nothing more is sent now: run the same command again later, and it continues from here.',
  );
  assert.match(waitDoesNotFit(budget, { askedMs: 60001, waitMs: 60001 }), /^the service asked to wait 61 s before the next send/, 'rounded up: a service that asked for 60.001 s is not asked less');
  assert.strictEqual(
    waitDoesNotFit(budget, { waitMs: 9000 }),
    'the next wait, 9 s, does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service (246 s are spent). Nothing more is sent now: run the same command again later, and it continues from here.',
    'with no request from the service the wait is the schedule\'s',
  );
  assert.match(waitDoesNotFit(makeThrottleBudget({ totalMs: 90000 }), { askedMs: 120000, waitMs: 120000 }), /what is left of the 90 seconds a run allows itself/, 'a budget that is not whole minutes is said in seconds');
  assert.match(waitDoesNotFit(makeThrottleBudget({ totalMs: 60000 }), { askedMs: 120000, waitMs: 120000 }), /what is left of the 1 minute a run allows itself/);
});

test('spentNote: how much of the budget is gone, in the words of the line that announces a wait', () => {
  const budget = makeThrottleBudget();
  budget.spend(46500);
  assert.strictEqual(spentNote(budget), '47 s of the 5 minutes a run allows itself for waiting out a throttled service are spent');
  assert.strictEqual(spentNote(makeThrottleBudget({ totalMs: 90000 })), '0 s of the 90 seconds a run allows itself for waiting out a throttled service are spent');
});

// What the module is NOT: it writes nothing itself. The lines it announces go to the caller's `warn` seam, which the build wires to stderr — stdout carries the JSON result of the run.
test('the module never writes to stdout or stderr itself — what it announces goes to the seam the caller gives', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'throttle-budget.js'), 'utf8');
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /process\.(stdout|stderr)|console\.(log|error|warn|info)/);
});
