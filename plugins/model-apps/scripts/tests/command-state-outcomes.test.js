'use strict';
// The row outcomes of the command-state writer (lib/command-state-run.js) and the words every message says for them.
//   - ROW_OUTCOMES is closed at run time: `record` is the one boundary a row's outcome is set through, and checkRowRecord throws on any value
//     the list does not name, however the code that hands it over spells it (a double-quoted literal, a value computed elsewhere).
//   - Each outcome names one history (a `drifted` row also keeps the outcome it had before), and ROW_MESSAGES is the one place a history
//     becomes words. The table below checks every outcome on every message path against what that history may and may not claim.
//   - The wording inventory reads every string, template and regular-expression literal of the writer's sources with the plugin's own lexer
//     (lib/source-literals.js), whatever the quotes, and fails on outcome wording outside the mapping.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { blankLiterals, commentRanges } = require('../lib/source-literals.js');
const LIB = path.join(__dirname, '..', 'lib', 'command-state-run.js');
const { ROW_OUTCOMES, DRIFT_BEFORE, ROW_WORDS, ROW_MESSAGES, checkRowRecord, createCommandStatePublicationObserver } = require(LIB);

const UNCHANGED = 'not written by this build (it already held the declared flags)';
const ACKNOWLEDGED = 'written by this build: the write was accepted and read back holding the declared flags';
const OBSERVED = 'this build\'s write got no answer, so its outcome is unknown; a later read found the declared flags, which is not proof this build saved them';
const DRIFT = 'then the read after every row\'s step did not show the declared flags';

// Every history the writer can record: each outcome, and a drifted row once per outcome it can have drifted from.
const HISTORIES = [
  ...ROW_OUTCOMES.filter((o) => o !== 'drifted').map((outcome) => ({ outcome })),
  ...DRIFT_BEFORE.map((before) => ({ outcome: 'drifted', before })),
];
const nameOf = (h) => (h.before ? `drifted after ${h.before}` : h.outcome);
// What each history's row-level text must say (post-write read, final drift, late refusal, result line) and its table's publication words.
const SAYS = {
  planned: { row: [/not written by this build \(the build stopped before it\)/], table: [/not written, not published/] },
  unchanged: { row: [new RegExp(UNCHANGED.replace(/[()]/g, '\\$&'))], table: [/already held the declared flags, not published by this build/] },
  acknowledged: { row: [new RegExp(ACKNOWLEDGED)], table: [/saved, not published/] },
  'observed-matching-after-unknown-send': { row: [/got no answer/, /a later read found the declared flags, which is not proof this build saved them/], table: [/held the declared flags after a write with no answer \(not known to be this build's\)/] },
  unknown: { row: [/this build sent a write and no read after it showed the row holding the declared flags, so its outcome is unknown/], table: [/write outcome unknown, not published/] },
  refused: { row: [/not written by this build \(it was refused\)/], table: [/not written, not published/] },
};
const drifted = (before) => ({ row: [...SAYS[before].row, new RegExp(`; ${DRIFT}`)], table: [/did not hold the declared flags at the read after every row's step, not published/] });

const now = { hidden: false, disabled: false };
const PATHS = {
  publicationUnconfirmed: (row) => {
    const o = createCommandStatePublicationObserver();
    o.register('new_a', []);
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

test('every history the writer can record is worded by every message path, and says only what that history proves', () => {
  for (const h of HISTORIES) {
    const row = { entity: 'new_a', location: 'MainTab', scope: 'table', rowId: 'r1', changed: [], ...h };
    const says = h.before ? drifted(h.before) : SAYS[h.outcome];
    assert.ok(says, `${nameOf(h)} has a rule`);
    const wrote = h.outcome === 'acknowledged' || h.before === 'acknowledged';
    const sent = wrote || h.outcome === 'unknown' || h.outcome === 'observed-matching-after-unknown-send' || h.before === 'observed-matching-after-unknown-send';
    const matchedOnce = h.outcome === 'drifted' || DRIFT_BEFORE.includes(h.outcome);
    for (const [where, say] of Object.entries(PATHS)) {
      const text = say(row);
      for (const rule of where === 'publicationUnconfirmed' ? says.table : says.row) assert.match(text, rule, `${nameOf(h)} via ${where}: ${text}`);
      // Only an acknowledged write (answered, then read back holding the flags) is accepted, saved or written by this build.
      if (!wrote) assert.doesNotMatch(text.replace('not proof this build saved them', ''), /accepted|saved|(?<!not )written by this build/, `${nameOf(h)} via ${where} claims a write: ${text}`);
      // A row this build sent nothing to is never said to have had a write of this build's.
      if (!sent) assert.doesNotMatch(text, /this build's write|this build sent/, `${nameOf(h)} via ${where} invents a write: ${text}`);
      // A row an exact read once found holding the flags is never said to have had no such read.
      if (matchedOnce) assert.doesNotMatch(text, /no read (after it )?showed/, `${nameOf(h)} via ${where} denies a matching read: ${text}`);
    }
  }
  // The rules name every outcome, and nothing else.
  assert.deepStrictEqual(Object.keys(SAYS).sort(), ROW_OUTCOMES.filter((o) => o !== 'drifted').sort());
  // A row whose outcome no list names (checkRowRecord refuses to record one) claims neither a write nor a read.
  for (const odd of [{ outcome: 'something-new' }, { outcome: 'drifted', before: 'unknown' }, { outcome: 'drifted' }]) {
    const text = ROW_MESSAGES.lateNote([{ entity: 'new_a', location: 'MainTab', rowId: 'r1', ...odd }]);
    assert.match(text, /what this build did to it is not known/);
    assert.doesNotMatch(text, /accepted|saved|write|read (back|found|showed)/);
  }
});

test('a row outcome is recorded only through checkRowRecord, which refuses any value the closed list does not name', () => {
  assert.deepStrictEqual(Object.keys(ROW_WORDS), [...ROW_OUTCOMES]);
  for (const outcome of ROW_OUTCOMES.filter((o) => o !== 'planned' && o !== 'drifted')) assert.strictEqual(checkRowRecord({ outcome }).outcome, outcome);
  for (const before of DRIFT_BEFORE) assert.strictEqual(checkRowRecord({ outcome: 'drifted', before }).before, before);
  const computed = ['send', 'lost'].join('-');
  for (const bad of [{ outcome: "send-lost" }, { outcome: computed }, { outcome: undefined }, {}, { outcome: 'planned' },
    { outcome: 'drifted' }, { outcome: 'drifted', before: 'unknown' }, { outcome: 'unknown', before: 'acknowledged' }]) {
    assert.throws(() => checkRowRecord(bad), (e) => e instanceof TypeError && /command-state writer defect/.test(e.message), JSON.stringify(bad));
  }
  // And the writer has no other way to set one: `record` passes every patch through it, and nothing else assigns a row result's outcome.
  const code = blankLiterals(fs.readFileSync(LIB, 'utf8'));
  assert.match(code, /const record = \(rowId, patch\) => Object\.assign\(results\.get\(rowId\), checkRowRecord\(patch\)\);/);
  assert.strictEqual((code.match(/Object\.assign\(results\.get\(/g) || []).length, 1);
  assert.deepStrictEqual([...code.matchAll(/(\w+)\.outcome\s*=(?!=)/g)].map((m) => m[1]).filter((who) => who !== 'entry'), [], 'only a table entry\'s outcome is assigned');
  assert.doesNotMatch(code, /results\.set\(/);
});

// The writer, compiled from `source` in place of the file (its own folder, so its requires resolve), without touching the module cache.
function writerFrom(source) {
  const m = new Module(LIB, module);
  m.filename = LIB;
  m.paths = Module._nodeModulePaths(path.dirname(LIB));
  m._compile(source, LIB);
  return m.exports;
}

test('a writer that would record an outcome the list does not name stops at the record, whether the value is quoted or computed', async () => {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const { createCommandStateTransport, commandStateSendOnce } = require('../lib/command-state-transport.js');
  const { createCommandStateOrg, commandRow, json, ORIGIN } = require('./helpers/command-state-org.js');
  const T = 'new_ticket';
  const MD = '44444444-4444-4444-8444-444444444444';
  const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const spec = { app: { name: 'Support', uniqueName: 'contoso_Support' }, commandStates: [{ entity: T, location: 'MainTab', scope: 'table', rowId: ROW, hidden: true }] };
  const source = fs.readFileSync(LIB, 'utf8');
  const lostSend = "record(item.rowId, { outcome: 'unknown', changed, code: CODES.writeUnknown });";
  assert.ok(source.includes(lostSend), 'the lost-send record this mutates is still in the writer');
  // The PATCH is answered 503 and never stored, so the read after it does not show the flags: the lost-send record.
  const apply = async (writer) => {
    const org = createCommandStateOrg({ writable: true, tables: { [T]: { metadataId: MD } }, rows: [commandRow(ROW, T, MD)],
      overrides: (req) => (req.method === 'PATCH' ? json(503, { error: { code: '0x80072321', message: 'unavailable' } }) : undefined) });
    const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {}, sendOnce: commandStateSendOnce });
    const transport = createCommandStateTransport({ client, apiUrl: (p) => `${ORIGIN}/api/data/v9.2${p}` });
    const plan = await writer.createCommandStateRun({ spec, transport, origin: ORIGIN }).plan();
    const approvals = { rows: new Set(plan.rows.map((r) => r.approval).filter(Boolean)), tables: new Set(plan.tables.map((t) => t.token)) };
    const run = writer.createCommandStateRun({ spec, transport, origin: ORIGIN, approvals });
    await run.preflight();
    await run.recheckAll();
    await run.applyRows();
  };
  await assert.rejects(apply(writerFrom(source)), (e) => e.code === 'command-state-write-unknown', 'the writer as shipped records unknown and halts');
  for (const [what, mutated] of [
    ['a double-quoted literal', source.replace(lostSend, 'record(item.rowId, { outcome: "send-lost", changed, code: CODES.writeUnknown });')],
    ['a computed value', source.replace(lostSend, "const nextOutcome = ['send', 'lost'].join('-'); record(item.rowId, { outcome: nextOutcome, changed, code: CODES.writeUnknown });")],
  ]) {
    await assert.rejects(apply(writerFrom(mutated)), (e) => e instanceof TypeError && /"send-lost" is not an outcome a row can be recorded with/.test(e.message), what);
  }
});

// Every literal (string of either quote, template, regular expression) in `source` that says outcome words, outside [from, to): found by the
// plugin's lexer, which blanks exactly the literals and comments, so neither the quote style nor a comment can hide or fake one.
const OUTCOME_WORDS = /\baccepted\b|\bsaved\b(?! customizations)|\bunknown outcome\b/g;
function outcomeWordingOutside(source, from = 0, to = 0) {
  const blank = blankLiterals(source);
  const comments = commentRanges(source);
  const found = [];
  for (const m of source.matchAll(OUTCOME_WORDS)) {
    const at = m.index;
    if (at >= from && at < to) continue;
    if (comments.some((c) => at >= c.start && at < c.end)) continue;
    // In code, a word stays as it is; in a literal the lexer blanks every character of it.
    if (blank[at] === source[at]) continue;
    const line = source.slice(source.lastIndexOf('\n', at) + 1, source.indexOf('\n', at) === -1 ? source.length : source.indexOf('\n', at)).trim();
    found.push(`${m[0]}: ${line.slice(0, 160)}`);
  }
  return found;
}
// The writer's sources: the writer and its transport whole (the mapping's vocabulary, ROW_OUTCOMES to KIND_ORDER, excepted), and the command-state printing of the build's CLI.
function writerSources() {
  const run = fs.readFileSync(LIB, 'utf8');
  const cli = fs.readFileSync(path.join(__dirname, '..', 'build-model-app.js'), 'utf8');
  const from = cli.indexOf('function printCommandStatePlan(');
  const to = cli.indexOf('const PREVIEW_REASON_WORDS');
  assert.ok(from > 0 && to > from, 'the CLI\'s command-state printing is where this reads it');
  return [
    ['lib/command-state-run.js', run, run.indexOf('const ROW_OUTCOMES = '), run.indexOf('const named = ')],
    ['lib/command-state-transport.js', fs.readFileSync(path.join(__dirname, '..', 'lib', 'command-state-transport.js'), 'utf8'), 0, 0],
    ['build-model-app.js (command states)', cli.slice(from, to), 0, 0],
  ];
}

test('no literal of the writer\'s sources says a row was accepted, saved or of unknown outcome outside the one mapping', () => {
  const [[, run, from, to]] = writerSources();
  assert.ok(from > 0 && to > from, 'the mapping block is where this reads it');
  for (const [name, source, start, end] of writerSources()) assert.deepStrictEqual(outcomeWordingOutside(source, start, end), [], name);
  // The CLI's row lines go through the mapping too, never through a row's raw outcome.
  const [, , [, cli]] = writerSources();
  const print = cli.slice(cli.indexOf('function printCommandStateResult('), cli.indexOf('function reportCommandStatesOfHalt('));
  assert.match(print, /ROW_MESSAGES\.resultLine\(row\)/);
  assert.doesNotMatch(blankLiterals(print), /row\.outcome/);
  // Each spelling is seen, outside the mapping and only there: the shapes a scan by one quote style misses.
  const label = 'const rowLabel = (r) => `command state ${r.entity}/${r.location}/${r.rowId}`;';
  assert.ok(run.includes(label));
  for (const [what, mutated] of [
    ['double quotes', run.replace(label, 'const rowLabel = (r) => "accepted " + `command state ${r.entity}/${r.location}/${r.rowId}`;')],
    ['single quotes', run.replace('const LATE_MISMATCH_REMEDY = \'', 'const LATE_MISMATCH_REMEDY = \'saved; ')],
    ['a template', run.replace('throw fail(CODES.notConfirmed, ROW_MESSAGES.postWriteMismatch(', 'throw fail(CODES.notConfirmed, `unknown outcome ${1}` + ROW_MESSAGES.postWriteMismatch(')],
  ]) {
    assert.notStrictEqual(mutated, run, what);
    const after = mutated.indexOf('const ROW_OUTCOMES = ');
    assert.strictEqual(outcomeWordingOutside(mutated, after, mutated.indexOf('const named = ')).length, 1, what);
  }
  // A comment saying the words is not a message, and a code name is not a literal.
  assert.deepStrictEqual(outcomeWordingOutside('// accepted\n/* saved */\nconst accepted = saved;\n'), []);
});
