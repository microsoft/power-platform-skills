'use strict';
// A script prints its result and ends at once — `emitResult` exits right after its writes, and so do the output guard's printer of an error that ends the process and dataverse-request.js — and an agent reads that
// result through a pipe. Node writes to a pipe asynchronously on Linux and macOS, and `process.exit` does not wait for what is still queued (https://nodejs.org/api/process.html#a-note-on-process-io), so a large result
// reached its reader cut short there: the Linux and macOS CI jobs read the 3.5 MB result of output-token-boundary.test.js as a JSON text that ended mid-string. Windows makes a pipe on stdout and stderr synchronous,
// so that test passes there whatever the code does. lib/output-redaction.js → makeWritesBlocking is the fix: the last writes are made blocking first.
//
// These tests show the failure, and the fix, on EVERY platform:
//   - in real processes whose stdout and stderr are the kind of stream Linux and macOS give a pipe (helpers/queued-stdio-preload.js: sockets over descriptors 3 and 4, which Node leaves asynchronous on Windows too):
//     every branch of emitResult, the guard's printer of a fatal error, dataverse-request.js and the 3.5 MB scenario of output-token-boundary.test.js, each with a text of several megabytes — and each also over the
//     process's own stdout and stderr, which are queued pipes on Linux and macOS;
//   - in this process, with stand-ins for stdout and stderr that take what a pipe takes at once and queue the rest: emitResult has every text it wrote taken whole when it calls `process.exit`, and never returns.
// And they pin what must not change: the bytes and exit status of every branch for a small result, and makeWritesBlocking's leaving everything but the handle as it was (the output guard stays on the path).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { table, longText, ACCENT } = require('./helpers/exit-output-child.js');
const { SECRETS, FOLDED } = require('./helpers/synthetic-token.js');
const { leaksIn } = require('./helpers/token-leaks.js');
const { makeWritesBlocking, guardStream } = require('../lib/output-redaction.js');

const CHILD = path.join(__dirname, 'helpers', 'exit-output-child.js');
const QUEUED = path.join(__dirname, 'helpers', 'queued-stdio-preload.js');
const TOKEN_CHILD = path.join(__dirname, 'helpers', 'token-boundary-child.js');
const DATAVERSE_REQUEST = path.join(__dirname, '..', 'dataverse-request.js');
const AUTH = path.join(__dirname, '..', 'lib', 'dataverse-auth.js');
// 30,000 rows: a text of about 3.5 MB, some fifty times what a pipe takes at once (64 KiB on Linux). 2 rows: a text any pipe takes at once.
const BIG = 30000;
const SMALL = 2;

// How the output reaches its reader: `queued` — the kind of pipe Linux and macOS give a script, on every platform (the preload's sockets over descriptors 3 and 4); `own` — the process's own stdout and stderr (queued
// pipes on Linux and macOS, synchronous ones on Windows).
const MODES = ['queued', 'own'];

function run(args, mode, env = {}) {
  const queued = mode === 'queued';
  const result = spawnSync(process.execPath, [...(queued ? ['--require', QUEUED] : []), ...args], {
    stdio: ['ignore', 'pipe', 'pipe', ...(queued ? ['pipe', 'pipe'] : [])],
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1', ...env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120000,
  });
  assert.equal(result.error, undefined, `the process could not be run: ${result.error}`);
  if (!queued) return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  // With the preload, everything the script prints goes to descriptors 3 and 4; what reached 1 and 2 is Node's own (a failure to start), shown if the test fails.
  return { status: result.status, stdout: result.output[3], stderr: result.output[4], own: `${result.stdout}${result.stderr}` };
}

const runScenario = (scenario, rows, mode) => run([CHILD, scenario, JSON.stringify({ rows })], mode);

// What each branch of emitResult prints — the bytes and the status it always printed. `stdout` and `stderr` are exact texts; the ascii branch is checked by what it means (every character escaped, the same document).
const EXPECTED = {
  ok: (rows) => ({ status: 0, stdout: `${JSON.stringify(table(rows))}\n`, stderr: '' }),
  ascii: (rows) => ({ status: 0, document: table(rows, ACCENT), stderr: '' }),
  'structured-error': (rows) => ({ status: 1, stdout: `${JSON.stringify({ ok: false, error: longText(rows), rows: table(rows) })}\n`, stderr: `${longText(rows)}\n` }),
  'structured-errors': (rows) => ({ status: 1, stdout: `${JSON.stringify({ ok: false, errors: table(rows) })}\n`, stderr: `Operation completed with ${rows} error(s); see stdout JSON\n` }),
  'structured-unexplained': (rows) => ({ status: 1, stdout: `${JSON.stringify({ ok: false, rows: table(rows) })}\n`, stderr: 'Operation failed with an unstructured error; see stdout JSON\n' }),
  error: (rows) => ({ status: 1, stdout: '', stderr: `${longText(rows)}\n` }),
  text: (rows) => ({ status: 1, stdout: '', stderr: `${longText(rows)}\n` }),
};

// Compares a long text by its length and its two ends first, so that a text cut short fails with a message a person can read (not the whole of two texts of megabytes).
function assertSameText(actual, expected, what) {
  assert.equal(typeof actual, 'string', `${what}: nothing was read`);
  if (actual === expected) return;
  const ending = (text) => JSON.stringify(text.slice(-60));
  assert.fail(`${what}: ${actual.length} characters arrived of the ${expected.length} written; it ends with ${ending(actual)} where the text ends with ${ending(expected)}`);
}

function assertPrinted(ran, expected, what) {
  assert.equal(ran.status, expected.status, `${what}: the exit status (${ran.own || ''})`);
  if (expected.document) {
    assert.ok(ran.stdout.endsWith('\n') && ran.stdout.indexOf('\n') === ran.stdout.length - 1, `${what}: one line, ended by a line break — ${ran.stdout.length} characters arrived`);
    assert.match(ran.stdout, /^[\x00-\x7e]*$/, `${what}: every character above U+007E is escaped`);
    assert.deepEqual(JSON.parse(ran.stdout), expected.document, `${what}: the same document`);
  } else {
    assertSameText(ran.stdout, expected.stdout, `${what}: stdout`);
  }
  assertSameText(ran.stderr, expected.stderr, `${what}: stderr`);
}

// ── emitResult, in a real process ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

for (const scenario of Object.keys(EXPECTED)) {
  test(`emitResult (${scenario}) writes a result of several megabytes whole before the process ends — through a pipe that queues what it cannot take at once, and through the process's own stdout and stderr`, () => {
    for (const mode of MODES) assertPrinted(runScenario(scenario, BIG, mode), EXPECTED[scenario](BIG), `${scenario}, ${mode}`);
  });
}

test('emitResult prints a small result exactly as it always did, with the same exit status, in every branch and through both kinds of stream', () => {
  for (const scenario of Object.keys(EXPECTED)) {
    for (const mode of MODES) assertPrinted(runScenario(scenario, SMALL, mode), EXPECTED[scenario](SMALL), `${scenario}, ${mode}`);
  }
});

// ── An error that ends the process: the output guard prints it ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('an error that ends the process after a token was obtained is printed whole — a message of several megabytes, the token out of it — and the process ends with status 1', () => {
  for (const mode of MODES) {
    for (const rows of [BIG, SMALL]) {
      const ran = runScenario('fatal', rows, mode);
      const what = `${rows} rows, ${mode}`;
      assert.equal(ran.status, 1, `${what}: the status of an error nothing caught (${ran.own || ''})`);
      assert.equal(ran.stdout, '', `${what}: nothing on stdout`);
      const head = `Uncaught Error: ${longText(rows)} Rejected bearer <token>\n`;
      assertSameText(ran.stderr.slice(0, head.length), head, `${what}: the message, with the token taken out`);
      assert.match(ran.stderr.slice(head.length), /^ {4}at [^\n]+\n[\s\S]*\n$/, `${what}: then the stack, to its last line — ${ran.stderr.length} characters arrived`);
      assert.deepEqual(leaksIn(ran.stderr, SECRETS), [], `${what}: no part of the token`);
    }
  }
});

// ── The output guard stays on the path ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('the 3.5 MB result of output-token-boundary.test.js — the token in one row — is whole and clean through a pipe that queues what it cannot take at once, as it is on Linux and macOS', () => {
  const dir = makeTempDir('whole-before-exit-');
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const factsFile = path.join(dir, 'facts.json');
  const ran = run([TOKEN_CHILD, 'big', JSON.stringify({ rows: BIG })], 'queued', { TOKEN_BOUNDARY_DIR: work, TOKEN_BOUNDARY_FACTS: factsFile });
  const facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  assert.equal(facts.obtained, true, 'the token was obtained, so the output guard was on the streams');
  assert.equal(ran.status, 0, ran.stderr);
  const escaped = JSON.stringify(FOLDED).slice(1, -1);
  assert.equal(ran.stdout.length, facts.bytes - escaped.length + '<token>'.length + 1, `the whole text, with only the token changed — ${ran.stdout.length} characters arrived of ${facts.bytes}`);
  assert.deepEqual(leaksIn(ran.stdout, SECRETS), []);
  const printed = JSON.parse(ran.stdout);
  assert.equal(printed.length, BIG, 'every row');
  assert.equal(printed[BIG / 2].note, 'Rejected bearer <token>');
});

// ── dataverse-request.js prints its answer itself ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// The real script, with the request replaced by an answer of `rows` rows (or a failure whose message is that long), run as a process. The request is the one thing replaced: every other export of
// lib/dataverse-auth.js is the real one, and lib/output-redaction.js is loaded as it is.
function runDataverseRequest(rows, { fail = false, mode = 'queued' } = {}) {
  const code = `
    const Module = require('node:module');
    const realAuth = require(${JSON.stringify(AUTH)});
    const { table, longText } = require(${JSON.stringify(CHILD)});
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
      if (Module._resolveFilename(request, parent, isMain) === ${JSON.stringify(AUTH)}) {
        return { ...realAuth, dataverseRequest: async () => {
          if (${fail}) throw new Error(longText(${rows}));
          return { status: 200, data: { value: table(${rows}) } };
        } };
      }
      return originalLoad.apply(this, arguments);
    };
    process.argv = [process.execPath, ${JSON.stringify(DATAVERSE_REQUEST)}, 'https://contoso.crm.dynamics.com', 'GET', 'accounts'];
    require(${JSON.stringify(DATAVERSE_REQUEST)});
  `;
  return run(['-e', code], mode);
}

test('dataverse-request.js prints an answer of several megabytes whole before it exits, and a failure as long whole on stderr — through both kinds of stream; a small one exactly as before', () => {
  for (const mode of MODES) {
    for (const rows of [BIG, SMALL]) {
      const what = `${rows} rows, ${mode}`;
      const answered = runDataverseRequest(rows, { mode });
      assert.equal(answered.status, 0, `${what}: ${answered.stderr}${answered.own || ''}`);
      assertSameText(answered.stdout, `${JSON.stringify({ status: 200, data: { value: table(rows) } })}\n`, `${what}: the answer`);
      assert.equal(answered.stderr, '', `${what}: nothing on stderr`);
      const failed = runDataverseRequest(rows, { fail: true, mode });
      assert.equal(failed.status, 1, `${what}: a failure exits 1`);
      assert.equal(failed.stdout, '', `${what}: nothing on stdout`);
      assertSameText(failed.stderr, `${longText(rows)}\n`, `${what}: the failure`);
    }
  }
});

// ── In this process: the order of the writes and the exit ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A stand-in for a pipe whose reader is reading but has not caught up: a write puts at most `capacity` characters in the pipe at once and queues the rest for a later turn of the event loop — unless the handle was made
// blocking, when the write returns with all of it taken (https://docs.libuv.org/en/v1.x/stream.html#c.uv_stream_set_blocking). A write made while something is queued waits behind it, blocking or not, as a real
// stream's does. `taken` is what the reader can read; `written` is what the process wrote.
function queuingPipe(capacity = 64 * 1024) {
  const pipe = { written: '', taken: '', queued: '', blocking: false, waiting: [] };
  const drain = () => {
    pipe.taken += pipe.queued;
    pipe.queued = '';
    for (const callback of pipe.waiting.splice(0)) callback();
  };
  pipe.stream = {
    _handle: { setBlocking(flag) { pipe.blocking = flag === true; return 0; } },
    write(chunk, encoding, callback) {
      const text = String(chunk);
      const done = typeof encoding === 'function' ? encoding : callback;
      pipe.written += text;
      if (!pipe.queued) {
        const now = pipe.blocking ? text : text.slice(0, capacity);
        pipe.taken += now;
        pipe.queued = text.slice(now.length);
        if (pipe.queued) setImmediate(drain);
      } else {
        pipe.queued += text;
      }
      if (typeof done === 'function') {
        if (pipe.queued) pipe.waiting.push(done);
        else process.nextTick(done);
      }
      return !pipe.queued;
    },
  };
  return pipe;
}

// Runs `fn` with the stand-ins as this process's stdout and stderr, and with a `process.exit` that records what the reader had been given when it was called — and then throws, so that nothing after it runs, as
// nothing runs after the real one. Everything is put back however `fn` ends.
function endedWith(fn) {
  const out = queuingPipe();
  const err = queuingPipe();
  const saved = { stdout: Object.getOwnPropertyDescriptor(process, 'stdout'), stderr: Object.getOwnPropertyDescriptor(process, 'stderr'), exit: process.exit };
  const END = new Error('process.exit');
  const ended = { code: undefined, returned: false, takenAtExit: undefined };
  Object.defineProperty(process, 'stdout', { configurable: true, enumerable: true, get: () => out.stream });
  Object.defineProperty(process, 'stderr', { configurable: true, enumerable: true, get: () => err.stream });
  process.exit = (code) => {
    ended.code = code;
    ended.takenAtExit = { stdout: out.taken, stderr: err.taken };
    throw END;
  };
  try {
    fn();
    ended.returned = true;
  } catch (error) {
    if (error !== END) throw error;
  } finally {
    Object.defineProperty(process, 'stdout', saved.stdout);
    Object.defineProperty(process, 'stderr', saved.stderr);
    process.exit = saved.exit;
  }
  return { ...ended, written: { stdout: out.written, stderr: err.written } };
}

test('emitResult has every text it wrote taken whole by the pipe when it calls process.exit — a pipe that takes 64 KiB at once and queues the rest — and never returns to its caller', () => {
  const { emitResult } = require('../lib/dataverse-auth.js');
  const calls = {
    ok: () => emitResult(true, table(BIG)),
    ascii: () => emitResult(true, table(BIG, ACCENT), { ascii: true }),
    'structured-error': () => emitResult(false, { ok: false, error: longText(BIG), rows: table(BIG) }),
    'structured-errors': () => emitResult(false, { ok: false, errors: table(BIG) }),
    error: () => emitResult(false, new Error(longText(BIG))),
    text: () => emitResult(false, longText(BIG)),
  };
  for (const [name, call] of Object.entries(calls)) {
    const ended = endedWith(call);
    assert.equal(ended.returned, false, `${name}: emitResult never returns — the exit follows its writes at once`);
    assert.equal(ended.code, name === 'ok' || name === 'ascii' ? 0 : 1, `${name}: the exit status`);
    assert.ok(ended.written.stdout.length + ended.written.stderr.length > 2 * 1024 * 1024, `${name}: a text of megabytes was written`);
    for (const stream of ['stdout', 'stderr']) {
      assert.equal(ended.takenAtExit[stream].length, ended.written[stream].length, `${name}: the pipe had taken all of ${stream} when process.exit was called`);
    }
  }
});

test('a small result was always taken at once by such a pipe, and still is: emitResult writes the same texts in the same order', () => {
  const { emitResult } = require('../lib/dataverse-auth.js');
  const ended = endedWith(() => emitResult(false, { ok: false, error: 'the build stopped: sign in with az login', rows: table(SMALL) }));
  assert.equal(ended.code, 1);
  assert.equal(ended.takenAtExit.stdout, `${JSON.stringify({ ok: false, error: 'the build stopped: sign in with az login', rows: table(SMALL) })}\n`);
  assert.equal(ended.takenAtExit.stderr, 'the build stopped: sign in with az login\n');
});

// ── makeWritesBlocking itself ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('makeWritesBlocking makes each handle blocking and leaves everything else as it was: a stream with no handle, a handle with no setBlocking, one that answers an error code and one that throws are passed over, and it never throws', () => {
  const calls = [];
  const write = function write() { return true; };
  const piped = { write, _handle: { setBlocking: (flag) => { calls.push(['piped', flag]); return 0; } } };
  // EINVAL, which libuv answers for a terminal on Windows: only a pipe can be made blocking there.
  const refusing = { _handle: { setBlocking: (flag) => { calls.push(['refusing', flag]); return -4071; } } };
  const throwing = { _handle: { setBlocking: () => { calls.push(['throwing']); throw new Error('the handle is closed'); } } };
  assert.equal(makeWritesBlocking(piped, null, undefined, {}, { _handle: null }, { _handle: {} }, refusing, throwing, piped), undefined);
  assert.deepEqual(calls, [['piped', true], ['refusing', true], ['throwing'], ['piped', true]]);
  assert.equal(piped.write, write, 'the stream\'s own write is left as it was');
  assert.doesNotThrow(() => makeWritesBlocking());
});

test('makeWritesBlocking leaves the output guard on the stream: what is written after it is still cleaned of the tokens the process obtained', () => {
  const taken = [];
  const stream = { write: (chunk) => { taken.push(chunk); return true; }, _handle: { setBlocking: () => 0 } };
  assert.equal(guardStream(stream, (text) => text.replace('secret-value', '<token>')), true);
  const guarded = stream.write;
  makeWritesBlocking(stream);
  assert.equal(stream.write, guarded, 'the guard is still the stream\'s write');
  stream.write('Rejected bearer secret-value\n');
  assert.deepEqual(taken, ['Rejected bearer <token>\n']);
});
