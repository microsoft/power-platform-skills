'use strict';
// The access tokens a process obtained never reach what a script WRITES: its stdout, its stderr — what Node prints when an error ends the script included — and the files it writes (the build's journal, its baseline, a result,
// a download, the SDK's workspace). Each test runs the scenarios of helpers/token-boundary-child.js in a REAL process, with the production SDK factory over the real vendored bundle and the production az-token HTTP client, and
// reads back what reached the process's file descriptors and its folder — not what a function was handed. (A test that swaps `process.stderr.write` in its own process swaps the very function that keeps the token out, and
// measures its own replacement.)
//
// The token is taken out of the TEXT a script writes, wherever the text came from: an SDK error that quotes a refused part of a change set, a warning an SDK method returns, the data of a successful answer, an error of an odd
// shape (frozen, an accessor for a message, a stack that writes). Nothing is done to the error, the warning or the answer: they stay exactly what the SDK and the service made, and the strict readers of a `$batch` answer, and
// the retry they decide, see what they always saw (tests/output-token-real-bundle.test.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { SECRETS, FOLDED, REFUSALS, LEADING_N_PARTS, LEADING_N_SECRETS } = require('./helpers/synthetic-token.js');
const { leaksIn } = require('./helpers/token-leaks.js');

const CHILD = path.join(__dirname, 'helpers', 'token-boundary-child.js');
const MARK = '<token>';

function filesUnder(root, base = root, out = new Map()) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) filesUnder(full, base, out);
    else out.set(path.relative(base, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
  }
  return out;
}

// One scenario, in a real process: what it printed on each descriptor, how it ended, what it knew (`facts`: booleans and counts, never the token), and every file it wrote. `env` is added to the process's environment
// (FORCE_COLOR=1 makes the console print in colours, as it does on a terminal, which a pipe's reader would never see).
function run(scenario, parameters = {}, env = {}) {
  const dir = makeTempDir('token-boundary-');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const factsFile = path.join(dir, 'facts.json');
  const result = spawnSync(process.execPath, [CHILD, scenario, JSON.stringify(parameters)], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1', TOKEN_BOUNDARY_DIR: work, TOKEN_BOUNDARY_FACTS: factsFile, ...env },
    encoding: 'utf8',
    timeout: 120000,
  });
  const facts = fs.existsSync(factsFile) ? JSON.parse(fs.readFileSync(factsFile, 'utf8')) : {};
  assert.ok(!facts.harnessFailure, `the scenario itself failed: ${facts.harnessFailure}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, facts, files: filesUnder(work) };
}

const writtenBy = (ran) => [['stdout', ran.stdout], ['stderr', ran.stderr], ...[...ran.files].map(([name, text]) => [`the file ${name}`, text])];

// Nothing that reached a descriptor or a file holds the token in any spelling; and what is still JSON is still JSON — a journal line, a status file, a baseline and the SDK's own workspace files are read back by the next run.
// `jsonStdout` is false for a scenario whose stdout is not JSON (an object printed with console.log). `secrets` is what must not be readable (the synthetic token and its parts unless a scenario sends another).
function assertNothingLeaks(ran, what, { jsonStdout = true, secrets = SECRETS } = {}) {
  for (const [where, text] of writtenBy(ran)) {
    assert.deepStrictEqual(leaksIn(text, secrets), [], `${what}: ${where} holds the token, or a part of it, in some spelling`);
    if (/^the file .*\.json$/.test(where)) assert.doesNotThrow(() => JSON.parse(text), `${what}: ${where} is still JSON`);
    if (/^the file .*\.jsonl$/.test(where)) for (const line of text.split('\n').filter(Boolean)) assert.doesNotThrow(() => JSON.parse(line), `${what}: a line of ${where} is still JSON`);
  }
  if (jsonStdout) for (const line of ran.stdout.split('\n').filter((l) => l.startsWith('{'))) assert.doesNotThrow(() => JSON.parse(line), `${what}: a JSON line of stdout is still JSON`);
}

const wroteMark = (ran) => writtenBy(ran).some(([, text]) => text.includes(MARK));

// ── A change set the service refuses as a whole: the SDK quotes the refused part into the error it raises ──────────────────────────────────────────────────────────────────

for (const [index, { name }] of REFUSALS.entries()) {
  test(`a change set refused as a whole, the part repeating the access token — ${name} — is reported without it: on both descriptors, in the journal, the baseline and the result files`, () => {
    const ran = run('change-set', { index });
    assert.strictEqual(ran.facts.refused, true, 'the edit is refused');
    assert.strictEqual(ran.status, 1, 'and the script ends as it did: with the failure');
    assertNothingLeaks(ran, name);
    assert.ok(wroteMark(ran), 'the token stood where the marker is: the scenario did write what quoted it');
    assert.match(ran.stderr, /HTTP 403 from \S+\/workflows\([^)]+\): /, 'what the service said is still there');
    assert.ok(ran.files.has('journal/build-log.jsonl') && ran.files.has('journal/build-status.json') && ran.files.has('baseline.json') && ran.files.has('result.json'), 'the journal, the status, the baseline and the result were written');
  });
}

// ── A console that prints in colours ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// On a terminal (and with FORCE_COLOR=1) `console.error(error)` prints the body an error keeps with `util.inspect`'s colours: a long string is cut after each line break, each piece wrapped in its own colour codes, and the
// pieces joined by a quote, a plus sign and a line break with the codes between them. A pipe's reader never sees it, a person at a console does.
for (const [index, name] of [[5, 'JSON with the token folded onto several lines'], [9, 'plain text with the token folded onto several lines'], [3, 'JSON with the first character of each part spelled as a \\u escape']]) {
  test(`a change set refused as a whole, ${name}, printed by a console that prints in colours — the codes between the pieces of a long string do not hide the token`, () => {
    const ran = run('change-set', { index }, { FORCE_COLOR: '1' });
    assert.strictEqual(ran.facts.refused, true);
    assert.strictEqual(ran.status, 1);
    assert.match(ran.stderr, /\u001b\[\d+m/, 'the console printed in colours: this is the scenario');
    assertNothingLeaks(ran, `${name}, in colours`);
    assert.ok(wroteMark(ran), 'the token stood where the marker is');
    assert.match(ran.stderr, /HTTP 403 from \S+\/workflows\([^)]+\): /, 'what the service said is still there');
  });
}

for (const how of ['console-log-folded-object', 'console-error-object']) {
  test(`${how} on a console that prints in colours reaches stdout and stderr without the token`, () => {
    const ran = run('print', { how }, { FORCE_COLOR: '1' });
    assert.strictEqual(ran.status, 0);
    assert.match(`${ran.stdout}${ran.stderr}`, /\u001b\[\d+m/, 'in colours');
    assertNothingLeaks(ran, how, { jsonStdout: false });
    assert.ok(wroteMark(ran));
  });
}

// ── A literal backslash right before a part of the token ───────────────────────────────────────────────────────────────────────────────────────────────────────────

// A diagnostic that says `... \nSyntheticSignature...` with a LITERAL backslash — JSON writes it `\\n` — is not a line break followed by `ySyntheticSignature...`: the `n` is the first character of the signature.
const LEADING_N = [
  ['signature', 'the signature alone, with a literal backslash right before it'],
  ['folded', 'the whole token folded onto several lines, with a literal backslash before the signature'],
  ['escaped-fold', 'the whole token with a JSON-escaped fold, and a literal backslash before the signature'],
];
// The token as `child 'leading-n'` quotes it — the backslash before the signature included — cut where it is folded: no piece of it may be left in anything the script wrote, which is what a person reassembling a folded
// token reads (the pieces are the fold's own, and a text can spell them with escapes no view of `leaksIn` joins).
const [, , SIGNATURE] = LEADING_N_PARTS;
const PIECES = `${LEADING_N_PARTS[0]}.${LEADING_N_PARTS[1]}.\\${SIGNATURE}`.match(/.{1,8}/g).filter((piece) => /^[A-Za-z0-9_-]{8}$/.test(piece));
for (const colours of [false, true]) {
  for (const [spelling, what] of LEADING_N) {
    test(`a change set refused as a whole, quoting ${what}${colours ? ', on a console that prints in colours' : ''}, is reported without the token — on both descriptors, in the journal, the baseline and the result files`, () => {
      const ran = run('leading-n', { spelling }, colours ? { FORCE_COLOR: '1' } : {});
      assert.strictEqual(ran.facts.refused, true, 'the edit is refused');
      assert.strictEqual(ran.status, 1);
      assertNothingLeaks(ran, what, { secrets: LEADING_N_SECRETS });
      if (spelling !== 'signature') for (const [where, text] of writtenBy(ran)) for (const piece of PIECES) assert.ok(!text.includes(piece), `${what}: ${where} holds the piece ${piece} of the token`);
      if (spelling === 'signature') for (const [where, text] of writtenBy(ran)) assert.ok(!text.includes(SIGNATURE) && !text.includes(SIGNATURE.slice(1)), `${what}: ${where} holds the signature, or all of it but its first character`);
      assert.ok(wroteMark(ran), 'the token stood where the marker is');
      assert.match(ran.stderr, /HTTP 403 from \S+\/workflows\([^)]+\): /, 'what the service said is still there');
      if (colours) assert.match(ran.stderr, /\u001b\[\d+m/, 'in colours');
    });
  }
}

// ── A warning the SDK RETURNS: no error object carries it ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a form saved whose read-back is refused with the token folded onto several lines: the warning the SDK returns reaches stderr, the result, the journal and the baseline without it', () => {
  const ran = run('form');
  assert.strictEqual(ran.facts.saved, true, 'the push is saved');
  assert.strictEqual(ran.facts.refusedReads, 1, 'the read-back was refused');
  assert.strictEqual(ran.facts.warnings, 1, 'and the SDK said so in a warning');
  assert.strictEqual(ran.facts.warningHoldsToken, true, 'the warning the SDK returned holds the token: it is not rewritten, it is what is written that is clean');
  assert.strictEqual(ran.status, 0);
  assertNothingLeaks(ran, 'the read-back warning');
  assert.match(ran.stderr, /WARNING: form Main: The form was saved, but its new version could not be read \(HTTP 403 from /, 'the warning is said on stderr');
  assert.match(ran.stderr, /Rejected bearer <token>\)\./);
  assert.match(ran.stdout, /Rejected bearer <token>\)\./, 'and is in the result');
  const journal = ran.files.get('journal/build-log.jsonl').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(journal.some((entry) => entry.status === 'warning' && /Rejected bearer <token>\)/.test(entry.detail)), 'and in the journal');
});

// ── An error of an odd shape, carried as the SDK's cause ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ODD_ERRORS = {
  plain: 'an ordinary transport error',
  frozen: 'a frozen transport error',
  accessor: 'a transport error whose message is an accessor',
  'stack-getter': 'a transport error whose stack is a getter that writes',
};
for (const [shape, what] of Object.entries(ODD_ERRORS)) {
  test(`${what} is reported without the token, and nothing but the transport's own code reads it while the SDK call runs`, () => {
    const ran = run('error-shape', { shape });
    assert.strictEqual(ran.facts.refused, true);
    // The transport itself reads the message once, to name the failure; the error is not walked by anything else, so a getter is not run on a script's behalf, and the one that writes is not run at all before it is printed.
    assert.ok(ran.facts.getterReadsDuringCall <= (shape === 'accessor' ? 1 : 0), `the getter ran ${ran.facts.getterReadsDuringCall} time(s) during the SDK call`);
    assert.strictEqual(ran.status, 1);
    assertNothingLeaks(ran, shape);
    assert.ok(wroteMark(ran), 'the token stood where the marker is');
  });
}

// ── A successful answer, and a token obtained from the Azure CLI ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a success answer that repeats the token — the data a script prints and a download writes — reaches stdout and its file without it, valid JSON still, and the token the process obtained from the Azure CLI is known', () => {
  const ran = run('answer');
  assert.strictEqual(ran.facts.obtained, true, 'the token came from `az`, as it does for a script');
  assert.strictEqual(ran.status, 0);
  assertNothingLeaks(ran, 'the answer');
  const printed = JSON.parse(ran.stdout);
  assert.strictEqual(printed.value[0].name, 'Account', 'the rest of the data is what it was');
  assert.strictEqual(printed.value[0].plain, 'bearer <token>');
  assert.strictEqual(printed.value[0].note, 'Rejected bearer <token>', 'a token folded onto several lines is one marker');
  assert.strictEqual(printed.value[0]['<token>'], 'as a key', 'a key too');
  assert.deepStrictEqual(JSON.parse(ran.files.get('answer.json')), printed, 'the file holds what stdout does');
});

// ── Every way a script prints ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const PRINTS = [
  ['stdout-write', 0], ['stderr-write', 0], ['console-log', 0], ['console-info', 0], ['console-debug', 0], ['console-warn', 0], ['console-error', 0], ['console-error-object', 0],
  ['console-log-folded-object', 0], ['json-line', 0], ['write-callback', 0], ['emit-ok', 0], ['emit-ok-ascii', 0], ['emit-error', 1], ['emit-text', 1], ['emit-structured', 1],
];
for (const [how, status] of PRINTS) {
  test(`a script that prints the token it obtained with ${how} writes the marker, and the script ends as it did`, () => {
    const ran = run('print', { how });
    assert.strictEqual(ran.facts.obtained, true);
    assert.strictEqual(ran.status, status);
    assertNothingLeaks(ran, how, { jsonStdout: how !== 'console-log-folded-object' });
    assert.ok(wroteMark(ran), 'the marker stands where the token stood');
  });
}

// ── What Node prints when an error ends the script: not through process.stderr.write ───────────────────────────────────────────────────────────────────────────────────────

for (const how of ['throw', 'reject', 'async-main']) {
  test(`an error that ends the script (${how}) is printed without the token — and still printed — and the script ends with status 1`, () => {
    for (const source of ['plain', 'change-set']) {
      const ran = run('fatal', { source, index: 5, how });
      assert.strictEqual(ran.status, 1, `${source}: an uncaught error ends the process with 1`);
      assertNothingLeaks(ran, `${how} of ${source}`);
      assert.match(ran.stderr, source === 'plain' ? /push form failed: Rejected bearer <token>/ : /HTTP 403 from \S+\/workflows\(/, `${source}: the error is still reported, with its message`);
    }
  });
}

test('an error that ends the script still lets the script\'s own handlers for the end of the process run — the ones that clean up a work folder — with the status 1', () => {
  const ran = run('fatal', { source: 'plain', how: 'throw', exitHandler: true });
  assert.strictEqual(ran.status, 1);
  assert.strictEqual(ran.files.get('exit-handler.txt'), 'ran with 1');
  assertNothingLeaks(ran, 'the end of the process');
});

// ── A large result ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('a result of several megabytes with the token in one row is written whole — one JSON document, every row, the token out of the one that held it — when the script exits right after writing it', () => {
  const rows = 30000;
  const dir = makeTempDir('token-boundary-big-');
  const factsFile = path.join(dir, 'facts.json');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const started = Date.now();
  const result = spawnSync(process.execPath, [CHILD, 'big', JSON.stringify({ rows })], {
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1', TOKEN_BOUNDARY_DIR: work, TOKEN_BOUNDARY_FACTS: factsFile },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120000,
  });
  const facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(facts.bytes > 3 * 1024 * 1024, `the result is several megabytes (${facts.bytes} characters)`);
  assert.deepStrictEqual(leaksIn(result.stdout, SECRETS), []);
  const printed = JSON.parse(result.stdout);
  assert.strictEqual(printed.length, rows, 'every row');
  assert.strictEqual(printed[rows / 2].note, 'Rejected bearer <token>');
  assert.strictEqual(printed[0].note, 'The platform answered with a diagnostic that says nothing about credentials.');
  const escaped = JSON.stringify(FOLDED).slice(1, -1);
  assert.strictEqual(result.stdout.length, facts.bytes - escaped.length + MARK.length + 1, 'and nothing else was changed: the folded token, as JSON writes it, became the marker, and a line break ends the text');
  assert.ok(Date.now() - started < 60000, 'in a moment');
});
