'use strict';
// The engine's step guard (lib/entity-provision.js, makeRunner). Once a run's throttle budget has refused to wait for a throttled request (lib/throttle-budget.js, `decline`), the run is over: the build's retry loop stops with
// `throttle-budget-exhausted` instead of running the phases again to meet the same answer. A refusal can be swallowed on its way up the engine — a best-effort step reports a failure and goes on, a fallback answers a refused request
// with others — and the run would then go on sending requests to a service that asked it to hold back, and could even end as a success. So no step STARTS after a refusal; a step that is already running finishes. These tests hold
// the guard on the runner itself; the column change set it was made for is held in table-columns-in-create.test.js, against the real SDK.
const test = require('node:test');
const assert = require('node:assert');
const { makeRunner, runBestEffort, mapLimit, BuildHalt } = require('../lib/entity-provision.js');
const { makeThrottleBudget, waitDoesNotFit } = require('../lib/throttle-budget.js');
const { isTransientHalt } = require('../build-model-app.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// What the HTTP client does when the wait the service asked for does not fit: it tells the budget.
const refuse = (budget, askedMs = 600000) => budget.decline({ askedMs, waitMs: askedMs });
const narrated = (events) => events.map((e) => `${e.status} ${e.label}`);
const stopOf = (budget, phase) => `${phase ? `${phase} stopped` : 'the build stopped'}: ${waitDoesNotFit(budget, budget.declined())}`;

test('before any refusal the runner is what it was — steps run, are narrated and fail as they did — with a budget, with one that has refused nothing, and with none', async () => {
  const idle = makeThrottleBudget();
  for (const [what, throttle] of [['a budget that refused nothing', idle], ['no budget', undefined], ['a budget that cannot be asked', { fits: () => true }]]) {
    const events = [];
    const runner = makeRunner({ emit: (e) => events.push(e), total: 2, ...(throttle ? { throttle } : {}) });
    assert.strictEqual(await runner.run('data-model', 'one', async () => 7), 7, what);
    await assert.rejects(runner.run('data-model', 'two', async () => { throw new Error('boom'); }), (error) => {
      assert.ok(error instanceof BuildHalt, what);
      assert.strictEqual(error.message, 'data-model failed: boom', what);
      assert.notStrictEqual(error.code, 'throttle-budget-exhausted', what);
      return true;
    });
    assert.deepStrictEqual(narrated(events), ['start one', 'ok one', 'start two', 'error two'], what);
    assert.doesNotThrow(() => runner.stopIfRefused('data-model'), what);
  }
  assert.strictEqual(makeRunner({ emit: () => {}, total: 0 }).mapLimit, mapLimit, 'a runner with no budget is given the one limiter');
});

test('after the budget has refused a wait no step starts — the function is not called, nothing is narrated, and the halt is the budget\'s: transient, saying what the service asked', async () => {
  const budget = makeThrottleBudget();
  const events = [];
  const runner = makeRunner({ emit: (e) => events.push(e), total: 3, throttle: budget });
  assert.strictEqual(await runner.run('data-model', 'first', async () => 1), 1);
  refuse(budget);
  let called = 0;
  await assert.rejects(runner.run('data-model', 'second', async () => { called += 1; }), (error) => {
    assert.ok(error instanceof BuildHalt);
    assert.strictEqual(error.code, 'throttle-budget-exhausted');
    assert.strictEqual(error.phase, 'data-model');
    assert.strictEqual(error.recoverable, true);
    assert.strictEqual(error.statusCode, 429);
    assert.strictEqual(isTransientHalt(error), true, 'a later run goes on from here');
    assert.strictEqual(error.message, stopOf(budget, 'data-model'));
    assert.match(error.message, /^data-model stopped: the service asked to wait 600 s before the next send, which does not fit in what is left of the 5 minutes/);
    return true;
  });
  assert.strictEqual(called, 0, 'the step was not run');
  assert.deepStrictEqual(narrated(events), ['start first', 'ok first'], 'and not narrated: it never started');
  assert.throws(() => runner.stopIfRefused(), (error) => error.code === 'throttle-budget-exhausted' && /^the build stopped: /.test(error.message), 'asked outside a phase, the guard says "the build"');
});

test('a refusal made before the runner was is not its run\'s — one runner is one run of the phases, and what an earlier run met is over', async () => {
  const budget = makeThrottleBudget();
  refuse(budget);
  const runner = makeRunner({ emit: () => {}, total: 1, throttle: budget });
  assert.strictEqual(await runner.run('data-model', 'step', async () => 'ran'), 'ran');
  refuse(budget, 60000);
  await assert.rejects(runner.run('data-model', 'next', async () => {}), (error) => error.code === 'throttle-budget-exhausted');
});

test('a best-effort step after a refusal does not run and says why — and the next step that is required stops the phase', async () => {
  const budget = makeThrottleBudget();
  const runner = makeRunner({ emit: () => {}, total: 2, throttle: budget });
  refuse(budget);
  const warnings = [];
  let called = 0;
  const out = await runBestEffort(runner, 'data-model', 'optional', async () => { called += 1; }, (w) => warnings.push(w), 'could not do the optional thing');
  assert.strictEqual(out, undefined);
  assert.strictEqual(called, 0);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /^could not do the optional thing: data-model stopped: the service asked to wait 600 s before the next send/);
  await assert.rejects(runner.run('data-model', 'required', async () => { called += 1; }), (error) => error.code === 'throttle-budget-exhausted');
  assert.strictEqual(called, 0);
});

test('what settles a halt is let through after a refusal, and a skip is still narrated — neither sends a request that the service has asked the run to hold back', async () => {
  const budget = makeThrottleBudget();
  const events = [];
  const runner = makeRunner({ emit: (e) => events.push(e), total: 2, throttle: budget });
  refuse(budget);
  assert.strictEqual(await runner.run('data-model', 'settle what the halt left', async () => 'settled', { settling: true }), 'settled', 'a step that settles what a halted phase owes is not a step of the phase');
  runner.skip('data-model', 'skipped');
  assert.deepStrictEqual(narrated(events), ['start settle what the halt left', 'ok settle what the halt left', 'skip skipped']);
});

test('the runner\'s fan-out starts no item after a refusal — an item already running finishes, and the stop is what it reports', async () => {
  const budget = makeThrottleBudget();
  const runner = makeRunner({ emit: () => {}, total: 9, throttle: budget });
  const started = [];
  const finished = [];
  await assert.rejects(runner.mapLimit(['a', 'b', 'c', 'd'], 2, async (item) => {
    started.push(item);
    if (item === 'a') { await sleep(5); refuse(budget); finished.push('a'); return; }
    await sleep(40);
    finished.push(item);
  }), (error) => {
    assert.strictEqual(error.code, 'throttle-budget-exhausted');
    assert.strictEqual(isTransientHalt(error), true);
    return true;
  });
  assert.deepStrictEqual(started, ['a', 'b'], 'c and d never started');
  assert.deepStrictEqual(finished.sort(), ['a', 'b'], 'b was already running, and finished before the stop was reported');
  // Before a refusal it is the limiter it always was: input order, and the first failure reported once the items in flight settle.
  const quiet = makeRunner({ emit: () => {}, total: 9, throttle: makeThrottleBudget() });
  assert.deepStrictEqual(await quiet.mapLimit([30, 5, 15], 2, async (ms, index) => { await sleep(ms); return index; }), [0, 1, 2]);
  const failure = new Error('first failure');
  const seen = [];
  await assert.rejects(quiet.mapLimit(['fails', 'slow', 'later'], 2, async (item) => {
    seen.push(item);
    if (item === 'fails') { await sleep(5); throw failure; }
    await sleep(30);
    return item;
  }), (error) => error === failure);
  assert.deepStrictEqual(seen, ['fails', 'slow'], 'nothing is started after the first failure');
});
