'use strict';
// The command-state publication observer (lib/command-state-run.js createCommandStatePublicationObserver): it only records what the build's
// existing before-app table publication answered, and it is the one thing that lets an apply with command states report success. Only a
// non-empty plain publish answered ok, or a managed flush that lists the table as published, confirms a table — and only until the next row
// write on it.

const test = require('node:test');
const assert = require('node:assert');
const { createCommandStatePublicationObserver, CODES } = require('../lib/command-state-run.js');

const observerWith = (...tables) => {
  const o = createCommandStatePublicationObserver();
  for (const t of tables) o.register(t, []);
  return o;
};
const outcomes = (o) => o.snapshot().map((t) => [t.entity, t.outcome]);

test('only a non-empty plain publish answered ok confirms, and only the tables it named', () => {
  const o = observerWith('new_a', 'new_b');
  o.observePlain([], { ok: true });
  assert.deepStrictEqual(o.unconfirmed(), ['new_a', 'new_b'], 'an empty list answers ok without a request: it confirms nothing');
  o.observePlain(['new_a'], { ok: false, reason: 'HTTP 500' });
  assert.deepStrictEqual(o.unconfirmed(), ['new_a', 'new_b'], 'a refused publish confirms nothing');
  assert.strictEqual(o.snapshot()[0].reason, 'failed');
  o.observePlain(['NEW_A', 'new_other'], { ok: true });
  assert.deepStrictEqual(outcomes(o), [['new_a', 'confirmed'], ['new_b', 'unconfirmed']], 'a name is matched in any case; a table nobody declared is ignored');
  assert.strictEqual(o.snapshot()[0].path, 'plain-before-app');
  assert.strictEqual(o.snapshot()[1].code, CODES.publishUnconfirmed);
});

test('a managed flush confirms only the tables it lists as published; a withheld one stays unconfirmed and says why', () => {
  const o = observerWith('new_a', 'new_b', 'new_c');
  o.observeManaged({ published: ['new_a'], withheld: ['new_b'] });
  o.observeManaged(undefined);
  o.observeManaged({ published: 'new_c' });
  assert.deepStrictEqual(outcomes(o), [['new_a', 'confirmed'], ['new_b', 'unconfirmed'], ['new_c', 'unconfirmed']]);
  assert.strictEqual(o.snapshot()[0].path, 'managed-before-app');
  assert.strictEqual(o.snapshot()[1].reason, 'withheld');
  // A table confirmed earlier is not un-confirmed by a later withheld or failed answer about it.
  o.observeManaged({ withheld: ['new_a'] });
  o.observePlain(['new_a'], { ok: false });
  assert.strictEqual(outcomes(o)[0][1], 'confirmed');
});

test('a row write after a confirmation needs a new one: an earlier publication cannot pay for a later write', () => {
  const o = observerWith('new_a');
  o.observePlain(['new_a'], { ok: true });
  assert.deepStrictEqual(o.unconfirmed(), []);
  o.noteRowWrite('new_a');
  assert.deepStrictEqual(o.unconfirmed(), ['new_a']);
  o.noteRowWrite('new_not_declared');
  o.observePlain(['new_a'], { ok: true });
  assert.deepStrictEqual(o.unconfirmed(), []);
});

test('declaredTables is every registered table once, in order, for the before-app request to name', () => {
  const o = observerWith('new_b', 'NEW_A', 'new_b');
  assert.deepStrictEqual(o.declaredTables(), ['new_a', 'new_b']);
});

test('a halt carries the rows and the publication, not enumerable, and says which tables are saved but not published', () => {
  const o = observerWith('new_a', 'new_b');
  o.trackRows(() => [{ rowId: 'x', outcome: 'acknowledged' }]);
  o.observePlain(['new_b'], { ok: true });
  const error = new Error('halted');
  o.attachFailure(error);
  assert.deepStrictEqual(error.commandStates.rows, [{ rowId: 'x', outcome: 'acknowledged' }]);
  assert.deepStrictEqual(error.commandStates.publication.map((t) => [t.entity, t.outcome, t.reason]), [['new_a', 'unconfirmed', 'halted-before-send'], ['new_b', 'confirmed', undefined]]);
  assert.deepStrictEqual(error.commandStatePublicationError.tables, ['new_a']);
  assert.strictEqual(error.commandStatePublicationError.code, CODES.publishUnconfirmed);
  assert.deepStrictEqual(Object.keys(error), [], 'nothing reaches a serialized error, the journal or a retry\u2019s reading of it');

  const allConfirmed = observerWith('new_a');
  allConfirmed.observePlain(['new_a'], { ok: true });
  const other = new Error('later halt');
  allConfirmed.attachFailure(other);
  assert.strictEqual(other.commandStatePublicationError, undefined);
  assert.ok(other.commandStates);
});

test('an observation that cannot be made never throws and confirms nothing', () => {
  const o = observerWith('new_a');
  assert.doesNotThrow(() => o.observePlain(null, { ok: true }));
  assert.doesNotThrow(() => o.observePlain(['new_a'], null));
  assert.doesNotThrow(() => o.observeManaged({ get published() { throw new Error('boom'); } }));
  assert.doesNotThrow(() => o.attachFailure(Object.freeze(new Error('frozen'))));
  assert.doesNotThrow(() => o.attachFailure(undefined));
  assert.deepStrictEqual(o.unconfirmed(), ['new_a']);
});
