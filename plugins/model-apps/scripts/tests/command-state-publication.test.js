'use strict';
// The command-state publication observer (lib/command-state-run.js createCommandStatePublicationObserver): it only records what the build's
// existing before-app table publication answered, and it is the one thing that lets an apply with command states report success. Only a
// non-empty plain publish answered ok, a managed flush that lists the table as published, or the SDK's publication of a reconciled table
// answered as published confirms a table — and only until the next row write on it.

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

test('the SDK\'s publication of reconciled tables confirms only the tables it names, and a later row write needs a new one', () => {
  const o = observerWith('new_a', 'new_b');
  o.observePlain(['new_a', 'new_b'], { ok: false });
  o.observeSdk(undefined);
  o.observeSdk('new_b');
  o.observeSdk(['NEW_A', 'new_other']);
  assert.deepStrictEqual(outcomes(o), [['new_a', 'confirmed'], ['new_b', 'unconfirmed']]);
  assert.strictEqual(o.snapshot()[0].path, 'sdk-before-app');
  assert.strictEqual(o.snapshot()[1].reason, 'failed', 'a table it does not name keeps the reason it had');
  o.noteRowWrite('new_a');
  assert.deepStrictEqual(o.unconfirmed(), ['new_a', 'new_b']);
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

test('the publication message says what each table\'s rows are known to hold, from their facts, never "saved" for a write not read back', () => {
  const wording = (rows) => {
    const o = observerWith('new_a');
    o.trackRows(() => rows.map(([facts, entity = 'new_a'], i) => ({ entity, rowId: `r${i}`, facts })));
    const error = new Error('halted');
    o.attachFailure(error);
    assert.strictEqual(error.commandStatePublicationError.code, CODES.publishUnconfirmed);
    assert.match(error.commandStatePublicationError.message, /required table publication was not confirmed; run the build again with publishing\.$/, 'the code\'s remedy is kept');
    return error.commandStatePublicationError.message.split(' — ')[0];
  };
  const read = (result, phase = 'after-every-row') => ({ attempt: 1, kind: 'read', phase, result, ...(result === 'unreadable' ? { code: 'command-state-row-unreadable' } : { hidden: result === 'matched', disabled: false }) });
  const send = (answer, status) => ({ attempt: 1, kind: 'send', answer, ...(status ? { status } : {}), flags: { hidden: true } });
  const SAVED = [read('differed', 'own-step'), send('acknowledged', 204), read('matched', 'readback')];
  const LOST_MATCHED = [read('differed', 'own-step'), send('lost', 503), read('matched', 'readback')];
  const LOST = [read('differed', 'own-step'), send('lost'), read('differed', 'readback')];
  const HELD = [read('matched', 'preflight'), read('matched', 'own-step')];
  assert.strictEqual(wording([[SAVED]]), 'new_a: saved, not published');
  assert.strictEqual(wording([[LOST_MATCHED]]), 'new_a: held the declared flags after a write with no usable answer (not known to be this build\'s), not published', 'a lost answer whose row was later read holding the flags is not called saved');
  assert.strictEqual(wording([[LOST]]), 'new_a: write outcome unknown, not published');
  assert.strictEqual(wording([[[read('differed', 'own-step'), send('refused', 403)]]]), 'new_a: not written, not published');
  assert.strictEqual(wording([[[]]]), 'new_a: not written, not published', 'a row the attempt never reached');
  assert.strictEqual(wording([[HELD]]), 'new_a: already held the declared flags, not published by this build');
  // A read that found other flags, or could not be judged, after one that found them: said as what that last read did.
  assert.strictEqual(wording([[[...SAVED, read('differed')]]]), 'new_a: held other flags than declared at its last read, not published');
  assert.strictEqual(wording([[[...SAVED, read('unreadable')]]]), 'new_a: could not be read at its last read, not published', 'an unreadable read is never said to have found the flags absent');
  assert.strictEqual(wording([[[...HELD, read('unreadable')]]]), 'new_a: could not be read at its last read, not published');
  assert.strictEqual(wording([[SAVED], [LOST], [[]], [SAVED, 'new_other']]), 'new_a: 3 rows (1 saved, 1 outcome unknown, 1 not written), not published', 'mixed rows are counted, per table');
  assert.strictEqual(wording([]), 'new_a: publication not confirmed', 'no row results: no claim about the rows');
  assert.strictEqual(wording([[SAVED], [LOST_MATCHED], [HELD], [[...HELD, read('unreadable')]]]), 'new_a: 4 rows (1 saved, 1 held after a write with no usable answer, 1 already held, 1 could not be read at its last read), not published');
  assert.strictEqual(wording([[undefined]]), 'new_a: write outcome unknown, not published', 'a row with no facts claims nothing');
});