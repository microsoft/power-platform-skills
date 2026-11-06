'use strict';
// What the command-state writer (lib/command-state-run.js) says about a row after its step, and the outcome it records for it.
//   - Every message words a row from its FACTS (each read and what it found, each write and how it was answered), through one renderer
//     (renderRowHistory) and one publication kind (rowKind). The table below builds every history of facts the writer can produce — no write,
//     an answered, unanswered or refused write; each read after it matched, other or unreadable; a later read; a retry of the build — and
//     checks every message path says what those facts show and nothing more.
//   - ROW_OUTCOMES is closed and checked against the facts at run time: `record` is the one boundary a row's outcome is set through, and
//     checkRowRecord throws on a value the list does not name, or one the row's facts do not show.
//   - The wording inventory reads every string, template and regular-expression literal of the writer's sources with the plugin's own lexer
//     (lib/source-literals.js), whatever the quotes or the case, and fails on claim wording outside the one vocabulary.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { blankLiterals, commentRanges } = require('../lib/source-literals.js');
const LIB = path.join(__dirname, '..', 'lib', 'command-state-run.js');
const { ROW_OUTCOMES, DRIFT_BEFORE, ROW_MESSAGES, renderRowHistory, checkRowRecord, createCommandStatePublicationObserver } = require(LIB);

const read = (result, phase, attempt = 1) => ({
  attempt, kind: 'read', phase, result, ...(result === 'unreadable' ? { code: 'command-state-row-unreadable' } : { hidden: result === 'matched', disabled: false }),
});
const send = (answer, status, attempt = 1) => ({ attempt, kind: 'send', answer, ...(status === undefined ? {} : { status }), flags: { hidden: true } });
const BEFORE_SEND = [read('differed', 'preflight'), read('differed', 'recheck'), read('differed', 'own-step')];

// Every history of facts the writer can record for a row, named.
function histories() {
  const out = [];
  const LATER = [null, 'matched', 'differed', 'unreadable'];
  const RETRY = {
    none: [],
    'retry, held': [read('matched', 'preflight', 2), read('matched', 'recheck', 2), read('matched', 'own-step', 2), read('matched', 'after-every-row', 2), read('matched', 'final', 2)],
    'retry, changed': [read('differed', 'preflight', 2)],
    'retry, unreadable': [read('unreadable', 'preflight', 2)],
  };
  for (const [retry, tail] of Object.entries(RETRY)) {
    for (const step of ['matched', 'differed', 'unreadable']) {
      for (const later of LATER) {
        const after = later ? [read(later, 'after-every-row')] : [];
        out.push({ name: `no write, own step ${step}, later ${later}, ${retry}`, facts: [read(step, 'preflight'), read(step, 'own-step'), ...after, ...tail] });
        for (const [what, s] of [['answered 204', send('acknowledged', 204)], ['no answer', send('lost')], ['answered 503', send('lost', 503)]]) {
          out.push({ name: `${what}, read back ${step}, later ${later}, ${retry}`, facts: [...BEFORE_SEND, s, read(step, 'readback'), ...after, ...tail] });
        }
      }
    }
    out.push({ name: `refused, ${retry}`, facts: [...BEFORE_SEND, send('refused', 403), ...tail] });
    out.push({ name: `never reached, ${retry}`, facts: [...tail] });
  }
  return out;
}

// What a history's facts alone establish, computed here from the facts, not by the writer.
function establish(facts) {
  const reads = facts.filter((e) => e.kind === 'read');
  const counted = facts.filter((e) => e.kind === 'send' && e.answer !== 'refused');
  const readBackAfterAck = facts.some((e, i) => e.kind === 'send' && e.answer === 'acknowledged' && facts[i + 1] && facts[i + 1].phase === 'readback' && facts[i + 1].result === 'matched');
  const firstSend = facts.findIndex((e) => e.kind === 'send');
  const narrated = firstSend < 0 ? reads : facts.slice(firstSend).filter((e) => e.kind === 'read');
  return {
    readBackAfterAck,
    sent: counted.length > 0,
    differedSaid: narrated.some((e) => e.result === 'differed'),
    unreadableSaid: narrated.some((e) => e.result === 'unreadable'),
    last: narrated[narrated.length - 1] || null,
    multi: new Set(facts.map((e) => e.attempt)).size > 1,
  };
}

// The claim words: a row was accepted or saved, or written by this build (any case, any inflection).
const CLAIM = /accept|\bsav(?:e|es|ed|ing)\b|(?<!not )written by this build/i;
const unclaimed = (text) => text.replaceAll('which is not proof this build saved them', '').replaceAll('not proof this build saved them', '');
const row = (facts) => ({ entity: 'new_a', location: 'MainTab', scope: 'table', rowId: 'r1', outcome: 'unknown', changed: [], facts });
const publicationOf = (r) => {
  const o = createCommandStatePublicationObserver();
  o.register('new_a', []);
  o.trackRows(() => [r]);
  const error = new Error('halted');
  o.attachFailure(error);
  return error.commandStatePublicationError.message.split(' — ')[0];
};

test('every history of facts is worded by every message path from those facts, and says only what they show', () => {
  const all = histories();
  assert.ok(all.length > 150, `the table covers the histories (${all.length})`);
  for (const { name, facts } of all) {
    const known = establish(facts);
    const r = row(facts);
    const history = renderRowHistory(facts);
    // One renderer: every row-level path carries the same history, whole.
    assert.strictEqual(ROW_MESSAGES.postWriteMismatch(r), `command state new_a/MainTab/r1: ${history}`, name);
    assert.ok(ROW_MESSAGES.finalDrift(r).includes(`: ${history} — `), name);
    assert.ok(ROW_MESSAGES.lateNote([r]).includes(`: ${history})`), name);
    assert.ok(ROW_MESSAGES.resultLine(r).endsWith(` — ${history}`), name);
    // Accepted, saved, or written by this build: only for a write answered 200/204 and then read back holding the flags.
    assert.strictEqual(CLAIM.test(unclaimed(history)), known.readBackAfterAck, `${name}: ${history}`);
    // A write of this build is mentioned exactly when one was sent and may have landed; otherwise the row was not written by this build.
    assert.strictEqual(/this build's write|(?<!not )written by this build/.test(history), known.sent, `${name}: ${history}`);
    assert.strictEqual(/not written by this build/.test(history), !known.sent, `${name}: ${history}`);
    // Other flags are said only of a read that found them; an unreadable read is said as unreadable, never as flags found or absent.
    assert.strictEqual(/found hidden/.test(history), known.differedSaid, `${name}: ${history}`);
    assert.strictEqual(/could not be read and judged/.test(history), known.unreadableSaid, `${name}: ${history}`);
    // The history ends with what the last read found.
    const end = history.replace(/ \(attempt \d+\)$/, '');
    if (known.last && known.last.result === 'unreadable') assert.match(end, /could not be read and judged [^;]* \(command-state-row-unreadable\)\)?$/, `${name}: ${history}`);
    if (known.last && known.last.result === 'differed') assert.match(end, /found hidden false, disabled false, not the declared flags\)?$/, `${name}: ${history}`);
    if (known.last && known.last.result === 'matched') assert.match(end, /declared flags\)?$|not proof this build saved them$/, `${name}: ${history}`);
    // A retry of the build says which attempt each clause is from; a single attempt does not.
    assert.strictEqual(/\(attempt \d+\)/.test(history), known.multi, `${name}: ${history}`);
    // The publication's words for the table: "saved" only for a write read back holding the flags, and never flags a read did not find.
    const table = publicationOf(r);
    if (CLAIM.test(unclaimed(table))) assert.ok(known.readBackAfterAck, `${name}: ${table}`);
    if (/other flags/.test(table)) assert.ok(known.last && known.last.result === 'differed', `${name}: ${table}`);
    if (/could not be read/.test(table)) assert.ok(known.last && known.last.result === 'unreadable', `${name}: ${table}`);
    assert.doesNotMatch(table, /did not hold|does not hold/, `${name}: ${table}`);
    if (known.last && known.last.result === 'unreadable') assert.doesNotMatch(table, /other flags|already held|saved, not/, `${name}: ${table}`);
    if (!known.sent) assert.doesNotMatch(table, /write outcome unknown|after a write/, `${name}: ${table}`);
  }
  // A row with no facts at all claims neither a write nor a read.
  for (const odd of [{ outcome: 'acknowledged' }, { outcome: 'something-new' }]) {
    const text = ROW_MESSAGES.lateNote([{ entity: 'new_a', location: 'MainTab', rowId: 'r1', ...odd }]);
    assert.match(text, /what this build did to it is not known/);
    assert.doesNotMatch(text, /accept|sav(e|ed)\b|write|read (back|found|showed)/i);
  }
});

test('the outcome a row is recorded with is one its facts show, and exactly one step outcome fits any facts', () => {
  const STEP = ['unchanged', 'acknowledged', 'observed-matching-after-unknown-send', 'unknown'];
  const fits = (outcome, facts, before) => { try { checkRowRecord({ outcome, ...(before ? { before } : {}) }, facts); return true; } catch { return false; } };
  for (const { name, facts } of histories()) {
    const known = establish(facts);
    const ok = STEP.filter((o) => fits(o, facts));
    const reads = facts.filter((e) => e.kind === 'read');
    const last = reads[reads.length - 1];
    if (fits('acknowledged', facts)) assert.ok(facts.some((e) => e.answer === 'acknowledged') && last.result === 'matched', name);
    if (fits('observed-matching-after-unknown-send', facts)) assert.ok(facts.some((e) => e.answer === 'lost') && last.result === 'matched', name);
    if (fits('unchanged', facts)) assert.ok(!known.sent && last.result === 'matched', name);
    if (fits('unknown', facts)) assert.ok(known.sent, name);
    assert.ok(ok.length <= 1, `${name}: ${ok}`);
    if (known.sent) assert.strictEqual(ok.length, 1, `${name}: a sent write always has one step outcome`);
    for (const before of DRIFT_BEFORE) if (fits('drifted', facts, before)) assert.notStrictEqual(last.result, 'matched', name);
  }
  const ack = [...BEFORE_SEND, send('acknowledged', 204), read('matched', 'readback')];
  const lost = [...BEFORE_SEND, send('lost', 503), read('matched', 'readback')];
  for (const [outcome, facts, before] of [
    ['acknowledged', [...BEFORE_SEND, send('acknowledged', 204), read('differed', 'readback')]],
    ['acknowledged', lost],
    ['unchanged', lost],
    ['unchanged', [read('differed', 'own-step')]],
    ['observed-matching-after-unknown-send', [...BEFORE_SEND, send('lost')]],
    ['unknown', ack],
    ['unknown', [read('differed', 'own-step')]],
    ['refused', ack],
    ['drifted', ack, 'acknowledged'],
    ['drifted', [...ack, read('unreadable', 'after-every-row')], 'unchanged'],
    ['drifted', [...lost, read('differed', 'after-every-row')], 'acknowledged'],
  ]) {
    assert.throws(() => checkRowRecord({ outcome, ...(before ? { before } : {}) }, facts), (e) => e instanceof TypeError && /is not what the row's facts show/.test(e.message), `${outcome} ${before || ''}`);
  }
  assert.strictEqual(checkRowRecord({ outcome: 'drifted', before: 'acknowledged' }, [...ack, read('unreadable', 'after-every-row')]).before, 'acknowledged');
  assert.strictEqual(checkRowRecord({ outcome: 'refused' }, [...BEFORE_SEND, send('refused', 412)]).outcome, 'refused');
});

test('a row outcome is recorded only through checkRowRecord, which refuses any value the closed list does not name', () => {
  for (const outcome of ROW_OUTCOMES.filter((o) => o !== 'planned' && o !== 'drifted')) assert.strictEqual(checkRowRecord({ outcome }).outcome, outcome);
  for (const before of DRIFT_BEFORE) assert.strictEqual(checkRowRecord({ outcome: 'drifted', before }).before, before);
  const computed = ['send', 'lost'].join('-');
  for (const bad of [{ outcome: "send-lost" }, { outcome: computed }, { outcome: undefined }, {}, { outcome: 'planned' },
    { outcome: 'drifted' }, { outcome: 'drifted', before: 'unknown' }, { outcome: 'unknown', before: 'acknowledged' }]) {
    assert.throws(() => checkRowRecord(bad), (e) => e instanceof TypeError && /command-state writer defect/.test(e.message), JSON.stringify(bad));
  }
  // And the writer has no other way to set one: `record` passes every patch and the row's facts through it, and nothing else assigns a row
  // result's outcome.
  const code = blankLiterals(fs.readFileSync(LIB, 'utf8'));
  assert.match(code, /const record = \(rowId, patch\) => \{\n\s+const row = results\.get\(rowId\);\n\s+checkRowRecord\(patch, row\.facts\);\n[\s\S]{0,400}?return Object\.assign\(row, patch\);\n\s+\};/);
  assert.strictEqual((code.match(/Object\.assign\(/g) || []).length, 1);
  assert.strictEqual((code.match(/checkRowRecord\(/g) || []).length, 2, 'its definition and the one call in record');
  assert.deepStrictEqual([...code.matchAll(/(\w+)\.outcome\s*=(?!=)/g)].map((m) => m[1]).filter((who) => who !== 'entry'), [], 'only a table entry\'s outcome is assigned');
  // A row's facts only grow, through `note`: nothing else adds to, replaces or empties them.
  assert.strictEqual((code.match(/\.facts\.push\(/g) || []).length, 1);
  assert.doesNotMatch(code, /\.facts\s*=(?!=)|facts\.(splice|pop|shift|length\s*=)/);
});

// The writer, compiled from `source` in place of the file (its own folder, so its requires resolve), without touching the module cache.
function writerFrom(source) {
  const m = new Module(LIB, module);
  m.filename = LIB;
  m.paths = Module._nodeModulePaths(path.dirname(LIB));
  m._compile(source, LIB);
  return m.exports;
}

const T = 'new_ticket';
const MD = '44444444-4444-4444-8444-444444444444';
const ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// One row through a writer's own steps against the fake org (a real raw client and the feature's transport): preflight, recheck, apply,
// then — when `drift` — the build's publication answered ok, the row changed, and the final proof.
async function throughWriter(writer, { hidden = false, patch, drift = false } = {}) {
  const { createAzHttpClient } = require('../lib/sdk-http-client.js');
  const { createCommandStateTransport, commandStateSendOnce } = require('../lib/command-state-transport.js');
  const { createCommandStateOrg, commandRow, ORIGIN } = require('./helpers/command-state-org.js');
  const spec = { app: { name: 'Support', uniqueName: 'contoso_Support' }, commandStates: [{ entity: T, location: 'MainTab', scope: 'table', rowId: ROW, hidden: true }] };
  const rows = [commandRow(ROW, T, MD, { hidden })];
  const org = createCommandStateOrg({ writable: true, tables: { [T]: { metadataId: MD } }, rows, overrides: (req) => (req.method === 'PATCH' && patch ? patch() : undefined) });
  const client = createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {}, sendOnce: commandStateSendOnce });
  const transport = createCommandStateTransport({ client, apiUrl: (p) => `${ORIGIN}/api/data/v9.2${p}` });
  const plan = await writer.createCommandStateRun({ spec, transport, origin: ORIGIN }).plan();
  const approvals = { rows: new Set(plan.rows.map((r) => r.approval).filter(Boolean)), tables: new Set(plan.tables.map((t) => t.token)) };
  const observer = writer.createCommandStatePublicationObserver();
  const run = writer.createCommandStateRun({ spec, transport, origin: ORIGIN, approvals, observer });
  await run.preflight();
  await run.recheckAll();
  await run.applyRows();
  if (!drift) return { org, run };
  observer.observePlain([T], { ok: true });
  rows[0].hidden = false;
  rows[0]['@odata.etag'] = 'W/"2000"';
  await run.assertComplete();
  return { org, run };
}

test('a writer that would record an outcome the list does not name, or its facts do not show, stops at the record', async () => {
  const { json } = require('./helpers/command-state-org.js');
  const source = fs.readFileSync(LIB, 'utf8');
  const lostSend = "record(item.rowId, { outcome: 'unknown', changed, code: CODES.writeUnknown });";
  assert.ok(source.includes(lostSend), 'the lost-send record this mutates is still in the writer');
  // The PATCH is answered 503 and never stored, so the read after it does not show the flags: the lost-send record.
  const lose = () => json(503, { error: { code: '0x80072321', message: 'unavailable' } });
  await assert.rejects(throughWriter(writerFrom(source), { patch: lose }), (e) => e.code === 'command-state-write-unknown', 'the writer as shipped records unknown and halts');
  for (const [what, mutated, said] of [
    ['a double-quoted literal', source.replace(lostSend, 'record(item.rowId, { outcome: "send-lost", changed, code: CODES.writeUnknown });'), /"send-lost" is not an outcome a row can be recorded with/],
    ['a computed value', source.replace(lostSend, "const nextOutcome = ['send', 'lost'].join('-'); record(item.rowId, { outcome: nextOutcome, changed, code: CODES.writeUnknown });"), /"send-lost" is not an outcome a row can be recorded with/],
    ['an outcome the facts do not show', source.replace(lostSend, "record(item.rowId, { outcome: 'acknowledged', changed });"), /"acknowledged" is not what the row's facts show/],
  ]) {
    await assert.rejects(throughWriter(writerFrom(mutated), { patch: lose }), (e) => e instanceof TypeError && said.test(e.message), what);
  }
});

// Every literal (string of either quote, template, regular expression) in `source` that says claim words, outside [from, to): found by the
// plugin's lexer, which blanks exactly the literals and comments, so neither the quote style, the case nor a comment can hide or fake one.
const CLAIM_WORDS = /\baccept(?:s|ed|ing|ance)?\b|\bsav(?:e|es|ed|ing)\b(?! customizations)|\bunknown outcome\b|\boutcome (?:is )?unknown\b|(?<!not )\bwritten by this build\b/gi;
function claimWordingOutside(source, from = 0, to = 0) {
  const blank = blankLiterals(source);
  const comments = commentRanges(source);
  const found = [];
  for (const m of source.matchAll(CLAIM_WORDS)) {
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
// The one vocabulary of the writer: from ROW_OUTCOMES to `named`. Its renderer, remedies and messages are outside it and are scanned.
const vocabularyOf = (run) => [run.indexOf('const ROW_OUTCOMES = '), run.indexOf('const named = ')];
function writerSources() {
  const run = fs.readFileSync(LIB, 'utf8');
  const cli = fs.readFileSync(path.join(__dirname, '..', 'build-model-app.js'), 'utf8');
  const from = cli.indexOf('function printCommandStatePlan(');
  const to = cli.indexOf('const PREVIEW_REASON_WORDS');
  assert.ok(from > 0 && to > from, 'the CLI\'s command-state printing is where this reads it');
  return [
    ['lib/command-state-run.js', run, ...vocabularyOf(run)],
    ['lib/command-state-transport.js', fs.readFileSync(path.join(__dirname, '..', 'lib', 'command-state-transport.js'), 'utf8'), 0, 0],
    ['build-model-app.js (command states)', cli.slice(from, to), 0, 0],
  ];
}

test('no literal of the writer\'s sources makes a claim about a row outside the one vocabulary, in any case or inflection', async () => {
  const [[, run, from, to]] = writerSources();
  assert.ok(from > 0 && to > from, 'the vocabulary block is where this reads it');
  assert.ok(!run.slice(from, to).includes('function '), 'the vocabulary holds words, not the renderer');
  assert.ok(run.indexOf('const LATE_MISMATCH_REMEDY = ') < from && run.indexOf('function renderRowHistory(') > to, 'remedy and renderer are scanned');
  for (const [name, source, start, end] of writerSources()) assert.deepStrictEqual(claimWordingOutside(source, start, end), [], name);
  // The CLI's row lines go through the renderer too, never through a row's raw outcome alone.
  const [, , [, cli]] = writerSources();
  const print = cli.slice(cli.indexOf('function printCommandStateResult('), cli.indexOf('function reportCommandStatesOfHalt('));
  assert.match(print, /ROW_MESSAGES\.resultLine\(row\)/);
  assert.doesNotMatch(blankLiterals(print), /row\.outcome/);
  // Each spelling is seen outside the vocabulary: either quote, a template, a capital letter, an inflection.
  const label = 'const rowLabel = (r) => `command state ${r.entity}/${r.location}/${r.rowId}`;';
  assert.ok(run.includes(label));
  const remedy = 'const LATE_MISMATCH_REMEDY = \'';
  for (const [what, mutated] of [
    ['double quotes', run.replace(label, 'const rowLabel = (r) => "accepted " + `command state ${r.entity}/${r.location}/${r.rowId}`;')],
    ['single quotes', run.replace(remedy, `${remedy}saved; `)],
    ['a capital letter', run.replace(remedy, `${remedy}Saved by this build; `)],
    ['an inflection', run.replace(remedy, `${remedy}the platform accepts it; `)],
    ['a template', run.replace('throw fail(CODES.notConfirmed, ROW_MESSAGES.postWriteMismatch(', 'throw fail(CODES.notConfirmed, `Unknown outcome ${1}` + ROW_MESSAGES.postWriteMismatch(')],
    ['a renderer clause', run.replace('`a read ${where} found the declared flags`', '`a read ${where} found the declared flags, so this build saved them`')],
  ]) {
    assert.notStrictEqual(mutated, run, what);
    assert.strictEqual(claimWordingOutside(mutated, ...vocabularyOf(mutated)).length, 1, what);
  }
  // A comment saying the words is not a message, and a code name is not a literal.
  assert.deepStrictEqual(claimWordingOutside('// accepted\n/* saved */\nconst accepted = saved;\n'), []);

  // And the same capitalized mutation through a real halt that sent nothing: the writer as shipped claims no write, the mutated one does.
  const halt = async (source) => {
    try { await throughWriter(writerFrom(source), { hidden: true, drift: true }); } catch (error) { return error; }
    assert.fail('the final proof halts');
  };
  const shipped = await halt(run);
  assert.strictEqual(shipped.code, 'command-state-not-confirmed');
  assert.doesNotMatch(unclaimed(shipped.message), CLAIM, shipped.message);
  const mutated = await halt(run.replace(remedy, `${remedy}Saved by this build; `));
  assert.match(mutated.message, CLAIM, 'the behavioural check sees the capitalized claim too');
});
