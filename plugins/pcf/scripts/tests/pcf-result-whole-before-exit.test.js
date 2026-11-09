'use strict';
// pcf's result printers end the process right after their writes — `emitResult` (lib/dataverse-auth.js), and the printers of pcf-inventory.js, verify-pcf.js and lint-pcf.js — and an agent reads the result through a
// pipe. Node writes to a pipe asynchronously on Linux and macOS, and `process.exit` does not wait for what is still queued (https://nodejs.org/api/process.html#a-note-on-process-io), so a large result reached its reader
// cut short there; Windows makes a pipe on stdout and stderr synchronous, so nothing shows it there. Each printer now makes its writes blocking first (makeWritesBlocking, lib/output-redaction.js).
//
// The tests check it on every platform. THE ORDER: each real process records when it makes stdout or stderr blocking and when it writes to them
// (helpers/write-order-preload.js), and each stream it wrote to must have been made blocking before its first write — which does not depend on the
// platform, the runtime or how fast the reader reads, so it fails on every run for a printer without the call. THE TEXT: the same processes, whose
// stdout and stderr are the kind of stream Linux and macOS give a pipe (helpers/queued-stdio-preload.js: sockets over descriptors 3 and 4, which Node
// leaves asynchronous on Windows too), print a result of megabytes — and the same over the process's own stdout and stderr; how much of it a printer
// without the call loses depends on the runtime and on how fast this process reads, so this half shows what a reader gets, not the fix. In this
// process, stand-ins for stdout and stderr that take what a pipe takes at once and queue the rest show that emitResult has every text taken whole when
// it calls `process.exit`, and never returns — as deterministic as the order. A small result is pinned to the bytes and the exit status it always had.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { rows, longText, controls } = require('./helpers/big-results.js');

const SCRIPTS = path.join(__dirname, '..');
const QUEUED = path.join(__dirname, 'helpers', 'queued-stdio-preload.js');
const ORDER = path.join(__dirname, 'helpers', 'write-order-preload.js');
const FAKE_ORG = path.join(__dirname, 'helpers', 'fake-big-org-preload.js');
const BUILDERS = path.join(__dirname, 'helpers', 'big-results.js');
const AUTH = path.join(SCRIPTS, 'lib', 'dataverse-auth.js');
const BIG = 30000;
const SMALL = 2;
// `queued`: the kind of pipe Linux and macOS give a script, on every platform. `own`: the process's own stdout and stderr (queued pipes on Linux and macOS, synchronous ones on Windows).
const MODES = ['queued', 'own'];

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Where each run's record of the order of its writes goes (helpers/write-order-preload.js): one file a run.
let orderDir = null;
let orderRuns = 0;
const orderFile = () => path.join(orderDir || (orderDir = makeTempDir('pcf-write-order-')), `${orderRuns += 1}.json`);

function run(args, mode, env = {}) {
  const queued = mode === 'queued';
  const record = orderFile();
  const result = spawnSync(process.execPath, [...(queued ? ['--require', QUEUED] : []), '--require', ORDER, ...args], {
    cwd: makeTempDir('pcf-whole-before-exit-'),
    stdio: ['ignore', 'pipe', 'pipe', ...(queued ? ['pipe', 'pipe'] : [])],
    env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT: '1', ...env, WRITE_ORDER_FILE: record },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120000,
  });
  assert.equal(result.error, undefined, `the process could not be run: ${result.error}`);
  const order = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')).events : null;
  if (!queued) return { status: result.status, stdout: result.stdout, stderr: result.stderr, order };
  // With the preload everything the script prints goes to descriptors 3 and 4; what reached 1 and 2 is Node's own (a failure to start), shown if the test fails.
  return { status: result.status, stdout: result.output[3], stderr: result.output[4], own: `${result.stdout}${result.stderr}`, order };
}

// Each stream the process wrote to was made blocking before its first write — the order the fix is, read from the process itself.
function assertBlockingFirst(ran, what) {
  assert.ok(Array.isArray(ran.order), `${what}: the process left no record of its writes`);
  for (const name of ['stdout', 'stderr']) {
    const firstWrite = ran.order.indexOf(`write ${name}`);
    if (firstWrite === -1) continue;
    const blocking = ran.order.indexOf(`blocking ${name}`);
    assert.ok(blocking !== -1 && blocking < firstWrite, `${what}: ${name} is made blocking before it is written to — ${blocking === -1 ? 'it never was' : 'only after'} (${ran.order.slice(0, 8).join(', ')})`);
  }
}

// Compares a long text by its length and its two ends first, so that a text cut short fails with a message a person can read.
function assertSameText(actual, expected, what) {
  assert.equal(typeof actual, 'string', `${what}: nothing was read`);
  if (actual === expected) return;
  const ending = (text) => JSON.stringify(text.slice(-60));
  assert.fail(`${what}: ${actual.length} characters arrived of the ${expected.length} written; it ends with ${ending(actual)} where the text ends with ${ending(expected)}`);
}

function assertPrinted(ran, expected, what) {
  assert.equal(ran.status, expected.status, `${what}: the exit status (${ran.own || ''})`);
  assertBlockingFirst(ran, what);
  assertSameText(ran.stdout, expected.stdout, `${what}: stdout`);
  assertSameText(ran.stderr, expected.stderr, `${what}: stderr`);
}

// ── emitResult ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Each branch of pcf's emitResult: the call, and the bytes and status it always printed (an Error is also a `{ ok:false, error }` line on stdout — pcf's own contract).
const EMITS = {
  ok: { call: (n) => `emitResult(true, rows(${n}))`, expected: (n) => ({ status: 0, stdout: `${JSON.stringify(rows(n))}\n`, stderr: '' }) },
  error: { call: (n) => `emitResult(false, new Error(longText(${n})))`, expected: (n) => ({ status: 1, stdout: `${JSON.stringify({ ok: false, error: longText(n) })}\n`, stderr: `${longText(n)}\n` }) },
  'structured-error': {
    call: (n) => `emitResult(false, { ok: false, error: longText(${n}), rows: rows(${n}) })`,
    expected: (n) => ({ status: 1, stdout: `${JSON.stringify({ ok: false, error: longText(n), rows: rows(n) })}\n`, stderr: `${longText(n)}\n` }),
  },
  'structured-errors': {
    call: (n) => `emitResult(false, { ok: false, errors: rows(${n}) })`,
    expected: (n) => ({ status: 1, stdout: `${JSON.stringify({ ok: false, errors: rows(n) })}\n`, stderr: `Operation completed with ${n} error(s); see stdout JSON\n` }),
  },
  'structured-unexplained': {
    call: (n) => `emitResult(false, { ok: false, rows: rows(${n}) })`,
    expected: (n) => ({ status: 1, stdout: `${JSON.stringify({ ok: false, rows: rows(n) })}\n`, stderr: 'Operation failed with an unstructured error; see stdout JSON\n' }),
  },
  text: { call: (n) => `emitResult(false, longText(${n}))`, expected: (n) => ({ status: 1, stdout: '', stderr: `${longText(n)}\n` }) },
};

const runEmit = (branch, n, mode) => run(['-e', `const { emitResult } = require(${JSON.stringify(AUTH)}); const { rows, longText } = require(${JSON.stringify(BUILDERS)}); ${EMITS[branch].call(n)};`], mode);

for (const branch of Object.keys(EMITS)) {
  test(`pcf emitResult (${branch}) writes a result of megabytes whole before the process ends — through a pipe that queues what it cannot take at once, and through the process's own stdout and stderr`, () => {
    for (const mode of MODES) assertPrinted(runEmit(branch, BIG, mode), EMITS[branch].expected(BIG), `${branch}, ${mode}`);
  });
}

test('pcf emitResult prints a small result exactly as it always did, with the same exit status, in every branch and through both kinds of stream', () => {
  for (const branch of Object.keys(EMITS)) {
    for (const mode of MODES) assertPrinted(runEmit(branch, SMALL, mode), EMITS[branch].expected(SMALL), `${branch}, ${mode}`);
  }
});

// A stand-in for a pipe whose reader is reading but has not caught up: a write puts at most `capacity` characters in the pipe at once and queues the rest for a later turn of the event loop — unless the handle was made
// blocking, when the write returns with all of it taken. A write made while something is queued waits behind it, as a real stream's does.
function queuingPipe(capacity = 64 * 1024) {
  const pipe = { written: '', taken: '', queued: '', blocking: false };
  pipe.stream = {
    _handle: { setBlocking(flag) { pipe.blocking = flag === true; return 0; } },
    write(chunk) {
      const text = String(chunk);
      pipe.written += text;
      if (pipe.queued) {
        pipe.queued += text;
      } else {
        const now = pipe.blocking ? text : text.slice(0, capacity);
        pipe.taken += now;
        pipe.queued = text.slice(now.length);
        if (pipe.queued) setImmediate(() => { pipe.taken += pipe.queued; pipe.queued = ''; });
      }
      return !pipe.queued;
    },
  };
  return pipe;
}

// Runs `fn` with the stand-ins as this process's stdout and stderr and a `process.exit` that records what the reader had been given when it was called, then throws — nothing runs after the real one either.
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

test('pcf emitResult has every text it wrote taken whole by the pipe when it calls process.exit — a pipe that takes 64 KiB at once and queues the rest — and never returns to its caller', () => {
  const { emitResult } = require('../lib/dataverse-auth.js');
  const calls = {
    ok: () => emitResult(true, rows(BIG)),
    error: () => emitResult(false, new Error(longText(BIG))),
    'structured-error': () => emitResult(false, { ok: false, error: longText(BIG), rows: rows(BIG) }),
    text: () => emitResult(false, longText(BIG)),
  };
  for (const [name, call] of Object.entries(calls)) {
    const ended = endedWith(call);
    assert.equal(ended.returned, false, `${name}: emitResult never returns — the exit follows its writes at once`);
    assert.equal(ended.code, name === 'ok' ? 0 : 1, `${name}: the exit status`);
    assert.ok(ended.written.stdout.length + ended.written.stderr.length > 2 * 1024 * 1024, `${name}: a text of megabytes was written`);
    for (const stream of ['stdout', 'stderr']) {
      assert.equal(ended.takenAtExit[stream].length, ended.written[stream].length, `${name}: the pipe had taken all of ${stream} when process.exit was called`);
    }
  }
});

// ── The scripts with printers of their own ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ENV_URL = 'https://contoso.crm.dynamics.com';
const inventoryRow = ({ name, version, isManaged, componentState }) => ({ name, version, isManaged, componentState });

test('pcf-inventory.js prints a listing of megabytes whole before it exits, and a failure that long whole on both streams — through both kinds of stream; a small listing exactly as before', () => {
  for (const mode of MODES) {
    for (const n of [BIG, SMALL]) {
      const what = `${n} controls, ${mode}`;
      const workspace = path.join(makeTempDir('pcf-inventory-workspace-'), 'ws');
      const args = ['--require', FAKE_ORG, path.join(SCRIPTS, 'pcf-inventory.js'), '--env', ENV_URL, '--include-managed', '--workspace', workspace];
      assertPrinted(run(args, mode, { FAKE_BIG_ORG_CONTROLS: String(n) }), { status: 0, stdout: `${JSON.stringify({ ok: true, controls: controls(n).map(inventoryRow) })}\n`, stderr: '' }, what);
      assertPrinted(run(args, mode, { FAKE_BIG_ORG_FAILURE: String(n) }), {
        status: 1,
        stdout: `${JSON.stringify({ ok: false, controls: [], error: longText(n) })}\n`,
        stderr: `${longText(n)}\n`,
      }, `${what}, failed`);
    }
  }
});

test('verify-pcf.js prints a failure of megabytes whole on both streams before it exits — through both kinds of stream; a small one exactly as before', () => {
  for (const mode of MODES) {
    for (const n of [BIG, SMALL]) {
      const workspace = path.join(makeTempDir('pcf-verify-workspace-'), 'ws');
      const args = ['--require', FAKE_ORG, path.join(SCRIPTS, 'verify-pcf.js'), '--env', ENV_URL, '--control', 'new_Contoso.Controls.StarRating',
        '--table', 'account', '--form', 'Information', '--column', 'name', '--workspace', workspace];
      assertPrinted(run(args, mode, { FAKE_BIG_ORG_FAILURE: String(n) }), {
        status: 1,
        stdout: `${JSON.stringify({ ok: false, error: longText(n), control: { registered: { ok: false, version: null, expected: null, componentState: null } }, bindings: [], runtime: 'not-checked' })}\n`,
        stderr: `${longText(n)}\n`,
      }, `${n} lines, ${mode}`);
    }
  }
});

test('lint-pcf.js prints findings of megabytes whole before it exits — through both kinds of stream — and a manifest with no finding as before', () => {
  const dir = makeTempDir('pcf-lint-whole-');
  const manifest = (version) => `<?xml version="1.0"?><manifest><control namespace="Contoso.Controls" constructor="Big" version="${version}" display-name-key="Big" description-key="Big"><resources><code path="index.ts" /></resources></control></manifest>`;
  // A version of three megabytes: the finding that names it is a text that long.
  const version = '9'.repeat(3 * 1024 * 1024);
  const big = path.join(dir, 'big', 'ControlManifest.Input.xml');
  const clean = path.join(dir, 'clean', 'ControlManifest.Input.xml');
  fs.mkdirSync(path.dirname(big));
  fs.mkdirSync(path.dirname(clean));
  fs.writeFileSync(big, manifest(version));
  fs.writeFileSync(clean, manifest('1.0.0'));
  const printed = {};
  for (const mode of MODES) {
    const ran = run([path.join(SCRIPTS, 'lint-pcf.js'), '--manifest', big], mode);
    assert.equal(ran.status, 1, `${mode}: findings exit 1 (${ran.own || ''})`);
    assertBlockingFirst(ran, `${mode}: the findings`);
    assert.ok(ran.stdout.endsWith('}\n') && ran.stdout.indexOf('\n') === ran.stdout.length - 1, `${mode}: one JSON line, ended by a line break — ${ran.stdout.length} characters arrived`);
    const result = JSON.parse(ran.stdout);
    assert.equal(result.ok, false);
    const finding = result.results[0].errors.find((item) => item.code === 'PCF_VERSION_FORMAT');
    assert.ok(finding && finding.message.includes(`'${version}'`), `${mode}: the finding names the whole version`);
    assert.equal(ran.stderr, 'PCF manifest lint failed; see stdout JSON\n', `${mode}: the note on stderr`);
    printed[mode] = ran.stdout;
    const fine = run([path.join(SCRIPTS, 'lint-pcf.js'), '--manifest', clean], mode);
    assert.equal(fine.status, 0, `${mode}: a manifest with no error exits 0 (${fine.stderr})`);
    assertBlockingFirst(fine, `${mode}: no finding`);
    assert.deepEqual(JSON.parse(fine.stdout), { ok: true, results: [{ manifest: clean, errors: [], warnings: JSON.parse(fine.stdout).results[0].warnings }] }, `${mode}: the same shape`);
    assert.equal(fine.stderr, '', `${mode}: nothing on stderr`);
  }
  assert.equal(printed.queued, printed.own, 'the same text through both kinds of stream');
});
