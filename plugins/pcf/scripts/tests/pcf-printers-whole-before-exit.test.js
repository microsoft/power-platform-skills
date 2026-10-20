'use strict';
// A pcf script that writes and then ends the process at once must write the whole text first — round two of pcf-result-whole-before-exit.test.js
// (which holds emitResult and the result printers of pcf-inventory.js, verify-pcf.js and lint-pcf.js). Here: check-auth.js (this plugin's copy of
// model-apps' script), every script's usage error, and the write-safety hook's message. Each makes its writes blocking first
// (lib/output-redaction.js makeWritesBlocking); pcf-exit-writes-inventory.test.js holds that no exit is left out.
//
// How a test proves it, on every platform: the script runs as a real process whose stdout and stderr are the kind of pipe Linux and macOS give it
// (helpers/queued-stdio-preload.js), and NOTHING is read from them until the process has ended, or has written and then stopped (it waits for the
// reader). A script that ends at once after writing more than a pipe holds loses the rest — every time — while one whose writes are blocking waits
// and delivers it all. The texts are a megabyte long, made without a command line that long: helpers/huge-failure-preload.js makes the plugin's flag
// check answer with such a message; helpers/fake-auth-check-preload.js refuses check-auth.js's WhoAmI with such a diagnostic. Each case also runs
// over the process's own stdout and stderr — the reference the queued run must equal — and with a small text, whose bytes and exit status must be
// what they always were.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { hugeFailureText } = require('./helpers/huge-failure-preload.js');
const { validateFlags } = require('../lib/dataverse-auth.js');

const SCRIPTS = path.join(__dirname, '..');
const HOOKS = path.join(SCRIPTS, '..', 'hooks');
const QUEUED = path.join(__dirname, 'helpers', 'queued-stdio-preload.js');
const HUGE = path.join(__dirname, 'helpers', 'huge-failure-preload.js');
const FAKE_AUTH = path.join(__dirname, 'helpers', 'fake-auth-check-preload.js');
const ENV_URL = 'https://contoso.crm.dynamics.com';
const BIG = 1024 * 1024;
const MODES = ['queued', 'own'];
const QUIET_MS = 300;
const CAP_MS = 10000;

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// Runs `node <args>` and reads what it printed. `queued`: stdout and stderr are descriptors 3 and 4 (the preload), held unread until the process has
// ended or has written and then stopped; `own`: the process's own stdout and stderr, read as they come. `input` is written to stdin (a hook's payload).
function runScript(args, { mode = 'queued', preloads = [], env = {}, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const queued = mode === 'queued';
    const child = spawn(process.execPath, [...(queued ? ['--require', QUEUED] : []), ...preloads.flatMap((p) => ['--require', p]), ...args], {
      cwd: cwd || makeTempDir('pcf-printers-cwd-'),
      env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_PCF_OPTOUT: '1', ...env },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', ...(queued ? ['pipe', 'pipe'] : [])],
    });
    if (input !== undefined) child.stdin.end(input);
    const readers = queued ? [child.stdio[3], child.stdio[4]] : [child.stdout, child.stderr];
    const read = [[], []];
    const own = [];
    readers.forEach((reader, i) => reader.on('data', (chunk) => read[i].push(chunk)));
    if (queued) for (const reader of [child.stdout, child.stderr]) reader.on('data', (chunk) => own.push(chunk));
    let held = queued;
    let timer = null;
    const release = () => {
      if (!held) return;
      held = false;
      clearInterval(timer);
      for (const reader of readers) reader.resume();
    };
    if (held) {
      for (const reader of readers) reader.pause();
      const started = Date.now();
      let seen = -1;
      let quietSince = started;
      timer = setInterval(() => {
        const taken = readers.reduce((sum, reader) => sum + reader.readableLength, 0);
        if (taken !== seen) {
          seen = taken;
          quietSince = Date.now();
        }
        if ((taken > 0 && Date.now() - quietSince >= QUIET_MS) || Date.now() - started >= CAP_MS) release();
      }, 25);
    }
    child.on('exit', release);
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({
      status,
      signal,
      stdout: Buffer.concat(read[0]).toString('utf8'),
      stderr: Buffer.concat(read[1]).toString('utf8'),
      own: Buffer.concat(own).toString('utf8'),
    }));
  });
}

async function eachAtOnce(items, task, width = 6) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  }));
}

function assertSameText(actual, expected, what) {
  assert.equal(typeof actual, 'string', `${what}: nothing was read`);
  if (actual === expected) return;
  const ending = (text) => JSON.stringify(text.slice(-60));
  assert.fail(`${what}: ${actual.length} characters arrived of the ${expected.length} expected; it ends with ${ending(actual)} where the text ends with ${ending(expected)}`);
}

function assertPrinted(ran, expected, what) {
  assert.equal(ran.status, expected.status, `${what}: the exit status (${ran.own || ''}${ran.status === 0 ? '' : ran.stderr.slice(0, 300)})`);
  assertSameText(ran.stdout, expected.stdout, `${what}: stdout`);
  assertSameText(ran.stderr, expected.stderr, `${what}: stderr`);
}

async function assertWholeBothWays(args, { preloads, env, cwd, input, status, stream, text }, what) {
  const [queued, own] = await Promise.all(MODES.map((mode) => runScript(args, { mode, preloads, env, cwd, input })));
  for (const [ran, mode] of [[queued, 'queued'], [own, 'own']]) {
    assert.equal(ran.status, status, `${what}, ${mode}: the exit status (${ran.own}${ran.stderr.slice(0, 300)})`);
    assert.ok(ran[stream].includes(text), `${what}, ${mode}: the whole text is on ${stream} — ${ran[stream].length} characters arrived, and they do not hold the ${text.length}-character text that ends it`);
    assert.ok(ran[stream].endsWith('\n'), `${what}, ${mode}: ${stream} ends with its line break`);
  }
  assertSameText(queued.stdout, own.stdout, `${what}: stdout, queued and own`);
  assertSameText(queued.stderr, own.stderr, `${what}: stderr, queued and own`);
  return { queued, own };
}

// ── check-auth.js ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const CHECK_AUTH = path.join(SCRIPTS, 'check-auth.js');
const usageBlocker = (flagError) => ({ ok: false, blocker: 'usage', message: `${flagError}. Usage: node check-auth.js --env <url> [--require-pac]`, warnings: [], azUser: null, pacUser: null, envUrl: null, identitiesMatch: false, whoAmI: null });

test('check-auth.js prints a usage blocker that quotes a message of a megabyte whole, and still exits 0 — through both kinds of stream; a mistyped flag exactly as before', async () => {
  const expected = { status: 0, stdout: `${JSON.stringify(usageBlocker(hugeFailureText('flag', BIG)))}\n`, stderr: '' };
  for (const mode of MODES) {
    assertPrinted(await runScript([CHECK_AUTH, '--env', ENV_URL], { mode, preloads: [HUGE], env: { HUGE_FAILURE: 'flag', HUGE_FAILURE_SIZE: String(BIG) } }), expected, `a megabyte, ${mode}`);
  }
  const argv = ['--env', ENV_URL, '--requir-pac'];
  const small = { status: 0, stdout: `${JSON.stringify(usageBlocker(validateFlags(argv, { known: ['env', 'require-pac'], needValue: ['env'] })))}\n`, stderr: '' };
  for (const mode of MODES) assertPrinted(await runScript([CHECK_AUTH, ...argv], { mode }), small, `--requir-pac, ${mode}`);
});

test('check-auth.js prints a refused WhoAmI whose diagnostic is a megabyte long whole, and still exits 0; a short diagnostic exactly as before', async () => {
  for (const size of [BIG, 12]) {
    const text = hugeFailureText('whoami', size);
    const { queued } = await assertWholeBothWays([CHECK_AUTH, '--env', ENV_URL], { preloads: [FAKE_AUTH], env: { FAKE_WHOAMI_DIAGNOSTIC_SIZE: String(size) }, status: 0, stream: 'stdout', text }, `${size} characters`);
    const result = JSON.parse(queued.stdout);
    assert.equal(result.blocker, 'whoami_error');
    assert.equal(result.whoAmI.message, text, 'the service\'s whole diagnostic, as the result has always carried it');
    assert.equal(queued.stderr, '');
  }
});

// ── Every script's own usage error ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Each prints `${USAGE}\n${message}\n` (its usageError), or `✗ ${message}\n${USAGE}\n` (lint-pcf.js, write-pcf-plan.js), or `${message}\n${USAGE}\n`
// (telemetry-config.js) — and exits 1.
const USAGE_SCRIPTS = ['lint-pcf.js', 'pcf-build.js', 'pcf-ci-build.js', 'pcf-doctor.js', 'pcf-gates.js', 'pcf-inventory.js', 'pcf-push.js', 'pcf-scaffold.js',
  'pcf-upgrade.js', 'telemetry-config.js', 'verify-pcf.js', 'write-pcf-plan.js'];

test('every pcf script prints a usage error that quotes a message of a megabyte whole on stderr, with exit 1 — through both kinds of stream', async () => {
  const text = hugeFailureText('flag', BIG);
  await eachAtOnce(USAGE_SCRIPTS, (script) => assertWholeBothWays([path.join(SCRIPTS, script)], {
    preloads: [HUGE], env: { HUGE_FAILURE: 'flag', HUGE_FAILURE_SIZE: String(BIG) }, status: 1, stream: 'stderr', text: `${text}\n`,
  }, script).then(({ queued }) => assert.equal(queued.stdout, '', `${script}: nothing on stdout`)));
});

test('every pcf script\'s usage error is what it always was: the message and the usage text on stderr, with exit 1', async () => {
  const text = hugeFailureText('flag', 10);
  await eachAtOnce(USAGE_SCRIPTS, async (script) => {
    const ran = await runScript([path.join(SCRIPTS, script)], { preloads: [HUGE], env: { HUGE_FAILURE: 'flag', HUGE_FAILURE_SIZE: '10' } });
    assert.equal(ran.status, 1, `${script}: ${ran.own}${ran.stderr}`);
    assert.equal(ran.stdout, '', `${script}: nothing on stdout`);
    assert.ok(ran.stderr.includes(`${text}\n`) && /usage/i.test(ran.stderr) && ran.stderr.endsWith('\n'), `${script}: ${JSON.stringify(ran.stderr.slice(0, 300))}`);
  });
});

// ── The write-safety hook ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('validate-write-safety.js flags a write outside the project whose path is a megabyte long with its whole message, exit 1; a short path as before', async () => {
  for (const size of [BIG, 10]) {
    const dir = makeTempDir('pcf-write-safety-whole-');
    fs.writeFileSync(path.join(dir, 'pcf-plan.md'), '# plan\n');
    const target = path.join(path.parse(dir).root, `outside-${'p'.repeat(size)}.tsx`);
    const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: target, content: '' }, cwd: dir });
    const { queued } = await assertWholeBothWays([path.join(HOOKS, 'validate-write-safety.js')], { input, cwd: dir, status: 1, stream: 'stderr', text: `targeted "${target}", which is outside your project folder` }, `${size} characters`);
    assert.match(queued.stderr, /^\[pcf\] Heads up: a pcf Write targeted "/);
    assert.match(queued.stderr, /Silence with PCF_SKIP_WRITE_GUARD=1 or PCF_DISABLE_HOOKS=1\.\n$/);
  }
});
