'use strict';
// lib/throttle-budget.js: the budget a run allows itself for waiting out a throttled service — in the HTTP client (the waits before it sends a throttled request again), in the page backend (the waits between a page write's sends) and in the build's own retry loop (the wait before it runs again).
// The layers wait with seams of their own, so the budget only COUNTS: what a wait is, and whether it fits, is decided here, once.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { THROTTLE_BUDGET_MS, QUIET_WAIT_MS, makeThrottleBudget, waitDoesNotFit, refusedWait, spentNote } = require('../lib/throttle-budget.js');

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

// The line the HTTP client's refusal leaves on the warn seam is read by callers that have no business with what to run next: the upload script's client refuses a publish AFTER the page was created, where the same command again would create a
// second page. So it says what happened — what the service asked, that it does not fit, that the request was not sent again — and leaves the advice to the caller that knows its own state.
test('refusedWait: says what the service asked and that the request was not sent again — and nothing of what to run next', () => {
  const budget = makeThrottleBudget();
  budget.spend(245500);
  assert.strictEqual(
    refusedWait(budget, { askedMs: 600000, waitMs: 600000 }),
    'the service asked to wait 600 s before this request is sent again, which does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service (246 s are spent), so it was not sent again.',
  );
  assert.strictEqual(
    refusedWait(budget, { waitMs: 9000 }),
    'the next wait before this request is sent again, 9 s, does not fit in what is left of the 5 minutes a run allows itself for waiting out a throttled service (246 s are spent), so it was not sent again.',
    'with no request from the service the wait is the schedule\'s',
  );
  assert.match(refusedWait(budget, { askedMs: 60001, waitMs: 60001 }), /^the service asked to wait 61 s before this request/, 'rounded up, as the halt\'s sentence is');
  assert.match(refusedWait(makeThrottleBudget({ totalMs: 90000 }), { askedMs: 120000, waitMs: 120000 }), /what is left of the 90 seconds a run allows itself/, 'a budget that is not whole minutes is said in seconds');
  for (const said of [refusedWait(budget, { askedMs: 600000, waitMs: 600000 }), refusedWait(budget, { waitMs: 9000 })]) {
    assert.doesNotMatch(said, /same command|again later|Nothing more is sent now|continues from here/, 'no advice: whether a run of anything again is safe is not the client\'s to say');
  }
});

test('spentNote: how much of the budget is gone, in the words of the line that announces a wait', () => {
  const budget = makeThrottleBudget();
  budget.spend(46500);
  assert.strictEqual(spentNote(budget), '47 s of the 5 minutes a run allows itself for waiting out a throttled service are spent');
  assert.strictEqual(spentNote(makeThrottleBudget({ totalMs: 90000 })), '0 s of the 90 seconds a run allows itself for waiting out a throttled service are spent');
});

// The HTTP client's waits can OVERLAP: it sends several requests at once (the build runs four at a time), a service that throttles them answers them alike, and they wake together. What a run waited is the time it spent waiting, not
// the sum of its requests' waits, so a wait that is PLACED on the clock (`at`, the moment it starts) adds only what runs past the end of the waits already placed. The layers that wait one at a time — the page backend, the build's own
// loop — place nothing, and what they spend is added whole, as it always was.
test('a wait placed on the clock adds only what runs past the waits already under way — requests throttled together wake together, and the run waited once', () => {
  const budget = makeThrottleBudget();
  assert.strictEqual(budget.spend(60000, 1000), 60000, 'the first wait is added whole: the time it takes');
  assert.strictEqual(budget.spend(60000, 1005), 5, 'one that starts 5 ms later ends 5 ms later, and those 5 ms are all it adds');
  assert.strictEqual(budget.spend(30000, 1010), 0, 'one that ends before the others do adds nothing');
  assert.strictEqual(budget.spentMs(), 60005);
  assert.strictEqual(budget.spend(60000, 61005), 60000, 'a wait that starts when the others are over is a wait of its own, added whole');
  assert.strictEqual(budget.spentMs(), 120005);
  assert.strictEqual(budget.spend(1000, 200000), 1000, 'and so is one a long time after');
});

test('fits answers for a placed wait by what it would add — a wait inside the waits under way always fits, and one that runs past them fits when only the part past them does', () => {
  const budget = makeThrottleBudget({ totalMs: 100000 });
  budget.spend(60000, 0);
  assert.strictEqual(budget.fits(60000, 10), true, 'it adds 10 ms');
  assert.strictEqual(budget.fits(100000, 10), false, 'it would add 40.01 s, and 40 s are left');
  assert.strictEqual(budget.fits(100000, 0), true, 'it would add exactly the 40 s that are left');
  budget.spend(40000, 60000);
  assert.strictEqual(budget.remainingMs(), 0);
  assert.strictEqual(budget.fits(30000, 1000), true, 'nothing is left, and a wait that ends before the others do still adds nothing');
  assert.strictEqual(budget.fits(30000, 100000), false, 'one that starts when they are over would add all of it');
  assert.strictEqual(budget.fits(1), false, 'and a wait with no place is whole, as ever: nothing is left');
});

test('a wait with no place is added whole whatever has been placed — the page backend and the build wait one at a time and are never made smaller by the client\'s', () => {
  const budget = makeThrottleBudget();
  budget.spend(60000, 1000);
  assert.strictEqual(budget.spend(60000), 60000, 'it overlaps the placed wait on no clock, and is added whole');
  assert.strictEqual(budget.spend(5000), 5000);
  assert.strictEqual(budget.spentMs(), 125000);
  for (const nothing of [undefined, null, Number.NaN, -5, 0, 'x']) assert.strictEqual(budget.spend(nothing, 5), 0, `${nothing} is no wait, placed or not`);
  assert.strictEqual(budget.spentMs(), 125000);
  assert.strictEqual(budget.spend(1000, Number.NaN), 1000, 'a place that is not a moment is no place');
});

// A wait the HTTP client would not take is the client's to say: it hands the throttled answer back as it came — the SDK reports it as the 429 it is, and an answer carries nothing of what the service asked, nor of why nothing
// more was sent — so the budget is where it is written down, for the build, which owns the halt, to read.
test('decline: a wait that did not fit is counted, with the longest ask and wait, and said on the warn seam once for each longer wait', () => {
  const lines = [];
  const budget = makeThrottleBudget({ warn: (message) => lines.push(message) });
  assert.deepStrictEqual(budget.declined(), { count: 0, askedMs: 0, waitMs: 0 });
  budget.spend(250000);
  budget.decline({ askedMs: 90000, waitMs: 90000 });
  assert.deepStrictEqual(budget.declined(), { count: 1, askedMs: 90000, waitMs: 90000 });
  assert.deepStrictEqual(lines, [refusedWait(budget, { askedMs: 90000, waitMs: 90000 })], 'in the words of a refusal: what the service asked and that the request was not sent again');
  assert.doesNotMatch(lines[0], /same command|again later|Nothing more is sent now/, 'with no advice the caller that owns the state has to give');
  budget.decline({ askedMs: 60000, waitMs: 60000 });
  assert.deepStrictEqual(budget.declined(), { count: 2, askedMs: 90000, waitMs: 90000 }, 'a shorter one is counted, and the longest stays');
  assert.strictEqual(lines.length, 1, 'and is not said again: four requests that are refused together are one line');
  budget.decline({ waitMs: 120000 });
  assert.deepStrictEqual(budget.declined(), { count: 3, askedMs: 90000, waitMs: 120000 }, 'a longer wait with no ask of the service is the schedule\'s');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[1], /^the next wait before this request is sent again, 120 s, does not fit in what is left of the 5 minutes/);
  assert.doesNotThrow(() => makeThrottleBudget().decline({ waitMs: 1000 }), 'a budget with no warn seam says nothing, and is counted all the same');
  assert.strictEqual(makeThrottleBudget().declined().count, 0, 'a budget counts its own declines');
});

test('note: how much of the budget is gone, in the words of the line that announces a wait', () => {
  const budget = makeThrottleBudget();
  budget.spend(46500);
  assert.strictEqual(budget.note(), spentNote(budget));
  assert.strictEqual(budget.note(), '47 s of the 5 minutes a run allows itself for waiting out a throttled service are spent');
});

// What the module is NOT: it writes nothing itself. The lines it announces go to the caller's `warn` seam, which the build wires to stderr — stdout carries the JSON result of the run.
test('the module never writes to stdout or stderr itself — what it announces goes to the seam the caller gives', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'throttle-budget.js'), 'utf8');
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ''), /process\.(stdout|stderr)|console\.(log|error|warn|info)/);
});
