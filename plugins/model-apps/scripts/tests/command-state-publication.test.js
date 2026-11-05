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

test('the publication message says what each table\'s rows are known to hold, never "saved" for a write that is not known to have landed', () => {
  const wording = (rows) => {
    const o = observerWith('new_a');
    o.trackRows(() => rows.map(([outcome, entity = 'new_a'], i) => ({ entity, rowId: `r${i}`, outcome })));
    const error = new Error('halted');
    o.attachFailure(error);
    assert.strictEqual(error.commandStatePublicationError.code, CODES.publishUnconfirmed);
    assert.match(error.commandStatePublicationError.message, /required table publication was not confirmed; run the build again with publishing\.$/, 'the code\'s remedy is kept');
    return error.commandStatePublicationError.message.split(' — ')[0];
  };
  assert.strictEqual(wording([['acknowledged']]), 'new_a: saved, not published');
  assert.strictEqual(wording([['observed-matching-after-unknown-send']]), 'new_a: held the declared flags after a write with no answer (not known to be this build\'s), not published', 'a lost answer whose row was later read holding the flags is not called saved');
  assert.strictEqual(wording([['unknown']]), 'new_a: write outcome unknown, not published');
  assert.strictEqual(wording([['refused']]), 'new_a: not written, not published');
  assert.strictEqual(wording([['planned']]), 'new_a: not written, not published', 'a row the attempt never reached');
  assert.strictEqual(wording([['unchanged']]), 'new_a: already held the declared flags, not published by this build');
  assert.strictEqual(wording([['acknowledged'], ['unknown'], ['planned'], ['acknowledged', 'new_other']]), 'new_a: 3 rows (1 saved, 1 outcome unknown, 1 not written), not published', 'mixed rows are counted, per table');
  assert.strictEqual(wording([]), 'new_a: publication not confirmed', 'no row results: no claim about the rows');
  assert.strictEqual(wording([['acknowledged'], ['observed-matching-after-unknown-send'], ['unchanged']]), 'new_a: 3 rows (1 saved, 1 held after a write with no answer, 1 already held), not published');
});
// Every row outcome the writer can record, worded by every message the build says after that row's step: one closed mapping
// (ROW_OUTCOMES / ROW_WORDS / ROW_MESSAGES). Only an acknowledged write (answered, then read back holding the flags) may be "accepted" or
// "saved"; an unanswered send says its answer was unknown and what the later read showed; a row this build did not write says so.
test('every row outcome is worded by every late message path under one rule set', () => {
  const { ROW_OUTCOMES, ROW_MESSAGES } = require('../lib/command-state-run.js');
  const now = { hidden: false, disabled: false };
  const paths = {
    publicationUnconfirmed: (row) => {
      const o = observerWith('new_a');
      o.trackRows(() => [row]);
      const error = new Error('halted');
      o.attachFailure(error);
      return error.commandStatePublicationError.message.split(' — ')[0];
    },
    postWriteRead: (row) => ROW_MESSAGES.postWriteMismatch(row, { row: now }),
    finalDrift: (row) => ROW_MESSAGES.finalDrift(row, now),
    lateMembershipRefusal: (row) => ROW_MESSAGES.lateNote([row]),
    resultLine: (row) => ROW_MESSAGES.resultLine(row),
  };
  const RULES = {
    acknowledged: [/accepted and read back holding the declared flags|saved, not published/],
    'observed-matching-after-unknown-send': [/no answer/, /later read found the declared flags|held the declared flags after a write with no answer/],
    unchanged: [/not written by this build \(it already held the declared flags\)|already held the declared flags, not published by this build/],
    planned: [/not written/],
    refused: [/not written/],
    unknown: [/unknown/],
  };
  assert.deepStrictEqual(Object.keys(RULES).sort(), [...ROW_OUTCOMES].sort(), 'the table covers every outcome');
  for (const outcome of ROW_OUTCOMES) {
    const row = { entity: 'new_a', location: 'MainTab', scope: 'table', rowId: 'r1', outcome, changed: [] };
    for (const [path, say] of Object.entries(paths)) {
      const text = say(row);
      for (const rule of RULES[outcome]) assert.match(text, rule, `${outcome} via ${path}: ${text}`);
      if (outcome !== 'acknowledged') {
        const claims = text.replace('not proof this build saved them', '');
        assert.doesNotMatch(claims, /accepted|saved|(?<!not )written by this build/, `${outcome} via ${path} claims a write: ${text}`);
      }
    }
  }
  assert.match(ROW_MESSAGES.finalDrift({ entity: 'new_a', location: 'MainTab', rowId: 'r1', outcome: 'acknowledged' }, now), /this build did not overwrite that change and rolls nothing back/);
  // An outcome no list names is said as unknown, never as a write that landed.
  assert.match(ROW_MESSAGES.lateNote([{ entity: 'new_a', location: 'MainTab', rowId: 'r1', outcome: 'something-new' }]), /unknown outcome/);
});

test('the writer records no row outcome the mapping does not name, and no message outside it words a row as accepted or saved', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { ROW_OUTCOMES, ROW_WORDS } = require('../lib/command-state-run.js');
  assert.deepStrictEqual(Object.keys(ROW_WORDS), [...ROW_OUTCOMES]);
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'command-state-run.js'), 'utf8');
  // A row's outcome is set in two places only: the results map's initial `planned`, and `record(rowId, { outcome: '...' })`.
  const recorded = new Set([...source.matchAll(/record\([^,]+,\s*\{\s*outcome:\s*'([^']+)'/g)].map((m) => m[1]));
  for (const m of source.matchAll(/rowId: s\.rowId, outcome: '([^']+)'/g)) recorded.add(m[1]);
  assert.deepStrictEqual([...recorded].sort(), [...ROW_OUTCOMES].sort(), 'every recorded outcome is named, and every named one is recorded');
  // Every other outcome literal in the file is a table's publication outcome, not a row's.
  const all = [...source.matchAll(/outcome(?::|\s*=)\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(all.filter((o) => !recorded.has(o)))].sort(), ['confirmed', 'unconfirmed']);
  // Outside the mapping's own block, no string in the code says "accepted" or "saved" (the table publication's own "saved customizations"
  // is about the table, not a row).
  const start = source.indexOf('const ROW_WORDS = ');
  const end = source.indexOf('\n', source.indexOf('const KIND_ORDER = '));
  assert.ok(start > 0 && end > start);
  const rest = (source.slice(0, start) + source.slice(end)).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join('\n');
  const strings = [...rest.matchAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)].map((m) => m[0]);
  assert.deepStrictEqual(strings.filter((s) => /\baccepted\b|\bsaved\b(?! customizations)/.test(s)), [], 'only the mapping words a row as accepted or saved');
  // The result lines the CLI prints go through the mapping too.
  const cli = fs.readFileSync(path.join(__dirname, '..', 'build-model-app.js'), 'utf8');
  const print = cli.slice(cli.indexOf('function printCommandStateResult('), cli.indexOf('function reportCommandStatesOfHalt('));
  assert.match(print, /ROW_MESSAGES\.resultLine\(row\)/);
  assert.doesNotMatch(print, /row\.outcome/, 'no raw outcome wording beside the mapping');
});