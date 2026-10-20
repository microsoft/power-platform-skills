'use strict';
// A script that writes and then ends the process at once must write the whole text first — round two of result-whole-before-exit.test.js (which
// holds emitResult, the printer of an error that ends the process, and dataverse-request.js). Here: every printer a script has of its OWN — check-auth.js,
// genpage-plan-provenance.js, promote-intent-pages.js, check-page-files.js, genpage-worker-output.js — every usage error and last-resort handler of the
// scripts, the "last writes" a script makes right before its result, and the hooks' messages. Each makes its writes blocking first
// (lib/output-redaction.js makeWritesBlocking); exit-writes-inventory.test.js holds that no exit is left out.
//
// How a test proves it, on every platform: the script runs as a real process whose stdout and stderr are the kind of pipe Linux and macOS give it
// (helpers/queued-stdio-preload.js), and NOTHING is read from them until the process has ended, or has written and then stopped (it waits for the
// reader). A script that ends at once after writing more than a pipe and its reader's buffer take (64 KiB each) loses the rest — every time — while
// one whose writes are blocking waits and delivers it all. The texts are megabytes long and are made without a command line that long (Windows allows
// 32,767 characters): helpers/huge-failure-preload.js makes the plugin's flag check answer with such a message, or its argument parser throw one;
// helpers/fake-auth-check-preload.js refuses check-auth.js's WhoAmI with such a diagnostic; plans, specs and pages are files. Each case also runs over
// the process's own stdout and stderr (queued pipes on Linux and macOS, synchronous ones on Windows) — the reference the queued run must equal — and
// with a small text, whose bytes and exit status must be what they always were.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeTempDir } = require('./helpers/temp-dirs.js');
const { hugeFailureText } = require('./helpers/huge-failure-preload.js');
const { validateFlags } = require('../lib/dataverse-auth.js');

const SCRIPTS = path.join(__dirname, '..');
const HOOKS = path.join(SCRIPTS, '..', 'hooks');
const QUEUED = path.join(__dirname, 'helpers', 'queued-stdio-preload.js');
const HUGE = path.join(__dirname, 'helpers', 'huge-failure-preload.js');
const FAKE_AUTH = path.join(__dirname, 'helpers', 'fake-auth-check-preload.js');
const ENV_URL = 'https://contoso.crm.dynamics.com';
// A megabyte: some eight times what a pipe and its reader's buffer take before the writer has to wait.
const BIG = 1024 * 1024;
const MODES = ['queued', 'own'];
// A held process that has written something and then written nothing more for this long, while still running, is waiting for its reader.
const QUIET_MS = 300;
const CAP_MS = 10000;

// Runs `node <args>` and reads what it printed. `queued`: stdout and stderr are descriptors 3 and 4 (the preload), held unread as described above;
// `own`: the process's own stdout and stderr, read as they come. `input` is written to stdin (a hook's payload).
function runScript(args, { mode = 'queued', preloads = [], env = {}, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const queued = mode === 'queued';
    const child = spawn(process.execPath, [...(queued ? ['--require', QUEUED] : []), ...preloads.flatMap((p) => ['--require', p]), ...args], {
      cwd,
      env: { ...process.env, POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1', ...env },
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

// Runs `task` over `items`, at most `width` at a time — the cases are independent processes, and one after another would take long.
async function eachAtOnce(items, task, width = 6) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  }));
  return results;
}

// Compares a long text by its length and its two ends first, so that a text cut short fails with a message a person can read.
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

// The same script, the same text, through both kinds of stream: the queued run held unread must equal the reference, and both must hold `text` whole.
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

// ── check-auth.js: one JSON line on stdout, exit 0 whatever it says ─────────────────────────────────────────────────────────────────────────────────

const CHECK_AUTH = path.join(SCRIPTS, 'check-auth.js');
const CHECK_AUTH_USAGE = 'Usage: node check-auth.js --env <url> [--require-pac]';
const usageBlocker = (flagError) => ({ ok: false, blocker: 'usage', message: `${flagError}. ${CHECK_AUTH_USAGE}`, warnings: [], azUser: null, pacUser: null, envUrl: null, identitiesMatch: false, whoAmI: null });

test('check-auth.js prints a usage blocker that quotes a message of a megabyte whole, and still exits 0 — through both kinds of stream; a mistyped flag exactly as before', async () => {
  const text = hugeFailureText('flag', BIG);
  const expected = { status: 0, stdout: `${JSON.stringify(usageBlocker(text))}\n`, stderr: '' };
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
    assert.equal(queued.stdout.indexOf('\n'), queued.stdout.length - 1, 'one line');
    const result = JSON.parse(queued.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.blocker, 'whoami_error');
    assert.equal(result.whoAmI.message, text, 'the service\'s whole diagnostic, as the result has always carried it');
    assert.equal(queued.stderr, '');
  }
});

// ── genpage-plan-provenance.js: a mismatch carries both change lists, exit 3 ────────────────────────────────────────────────────────────────────────

test('genpage-plan-provenance.js prints a mismatch whose two change lists are megabytes long whole, with exit 3; a mismatch of two changes exactly as before', async () => {
  const dir = makeTempDir('provenance-whole-');
  const id = '11111111-2222-3333-4444-555555555555';
  for (const changes of [12000, 2]) {
    const details = Array.from({ length: changes }, (_, i) => `- Change ${i}: update the grid, filter, empty state, row actions, and keyboard navigation for the named field.`).join('\n');
    const written = path.join(dir, `written-${changes}.md`);
    const approved = path.join(dir, `approved-${changes}.txt`);
    fs.writeFileSync(written, `# Genpage Edit Plan\n## File Being Edited\n- **Page ID:** ${id}\n## Requested Changes\n${details}\n`);
    fs.writeFileSync(approved, `## Genpage Edit Plan\n### Current State\n- **File:** ${id}/page.tsx\n### Proposed Changes\n${details}\n- Change the title.\n`);
    const lastChange = `- Change ${changes - 1}: update the grid`;
    const { queued } = await assertWholeBothWays([path.join(SCRIPTS, 'genpage-plan-provenance.js'), 'verify', '--plan', written, '--approved', `@${approved}`], { status: 3, stream: 'stdout', text: 'Change the title.' }, `${changes} changes`);
    const result = JSON.parse(queued.stdout);
    assert.equal(result.ok, false);
    assert.match(result.error, /do not match the approved Proposed Changes/);
    assert.ok(JSON.stringify(result.writtenChanges).includes(lastChange.slice(2)) && JSON.stringify(result.approvedChanges).includes('Change the title.'), 'both lists, whole');
    if (changes > 2) assert.ok(queued.stdout.length > 2 * 1024 * 1024, `megabytes were written (${queued.stdout.length})`);
  }
});

// ── promote-intent-pages.js: every failed page's diagnostics on both streams, exit 3 ─────────────────────────────────────────────────────────────────

test('promote-intent-pages.js prints the diagnostics of a page with forty thousand stray page references whole on both streams, with exit 3; one reference exactly as before', async () => {
  for (const refs of [40000, 1]) {
    const dir = makeTempDir('promote-whole-');
    fs.writeFileSync(path.join(dir, 'app-spec.json'), JSON.stringify({ app: { name: 'Probe' }, pages: [{ key: 'overview', name: 'Overview', source: { kind: 'intent' } }] }));
    fs.writeFileSync(path.join(dir, 'overview.tsx'), `export default function Page(){ return <div>${Array.from({ length: refs }, (_, i) => `<p>PAGEREF_detail${i}</p>`).join('\n')}</div>; }\n`);
    const last = `PAGEREF_detail${refs - 1}`;
    const args = [path.join(SCRIPTS, 'promote-intent-pages.js'), '--spec', `@${path.join(dir, 'app-spec.json')}`, '--working-dir', dir];
    const { queued } = await assertWholeBothWays(args, { status: 3, stream: 'stdout', text: last, cwd: dir }, `${refs} references, stdout`);
    assert.ok(queued.stderr.includes(last) && queued.stderr.endsWith('\n'), `${refs} references: stderr whole too — ${queued.stderr.length} characters`);
    assert.match(queued.stderr, /^promotion aborted — 1 of 1 page\(s\) failed validation; app-spec\.json was NOT modified\n {2}- overview\.tsx: /);
    const result = JSON.parse(queued.stdout);
    assert.equal(result.ok, false);
    assert.deepEqual(result.promoted, []);
    assert.equal(result.failed.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'app-spec.json'), 'utf8')).pages[0].source.kind, 'intent', 'the spec was not touched');
  }
});

// ── check-page-files.js: every file and problem of the plan, exit 3 ─────────────────────────────────────────────────────────────────────────────────

test('check-page-files.js prints the files and problems of a plan of twenty thousand pages whole, with exit 3; a plan of two pages exactly as before', async () => {
  for (const pages of [20000, 2]) {
    const dir = makeTempDir('page-files-whole-');
    const plan = path.join(dir, 'genpage-plan.md');
    fs.writeFileSync(plan, `# Plan\n\n## Pages\n\n| Page | File |\n|---|---|\n${Array.from({ length: pages }, (_, i) => `| Page ${i} | ../escape-${i}.tsx |`).join('\n')}\n`);
    const { queued } = await assertWholeBothWays([path.join(SCRIPTS, 'check-page-files.js'), '--plan', plan, '--working-dir', dir], { status: 3, stream: 'stdout', text: `escape-${pages - 1}.tsx` }, `${pages} pages`);
    const result = JSON.parse(queued.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.files.length, pages);
    assert.equal(result.problems.length, pages, 'a problem for every page that leaves the working directory');
  }
});

// ── genpage-worker-output.js: its result quotes the path it was given ───────────────────────────────────────────────────────────────────────────────

test('genpage-worker-output.js prints a result that quotes the longest path a command line can carry whole, with exit 3; a short one exactly as before', async () => {
  // Bounded by the command line (32,767 characters on Windows): three bytes a character makes the longest text the platform allows. On Windows that
  // fits a pipe and its reader's buffer, so the queued run cannot show a cut there; on Linux and macOS the own run is the real case.
  const dir = makeTempDir('worker-output-whole-');
  for (const name of [`${'\u20ac'.repeat(30000)}.tsx`, 'missing.tsx']) {
    const file = path.join(dir, name);
    const { queued } = await assertWholeBothWays([path.join(SCRIPTS, 'genpage-worker-output.js'), '--file', file], { status: 3, stream: 'stdout', text: JSON.stringify(file).slice(1, -1) }, `${name.length} characters`);
    const result = JSON.parse(queued.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.filePath, file);
  }
});

// ── Every script's own usage error ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

// The script, the arguments that reach its flag check (a verb where it takes one), and the environment it needs to get there.
const USAGE_CASES = [
  ['add-page-to-solution.js'], ['ai-preflight.js'], ['apps.js', ['list']], ['build-model-app.js'], ['connector.js', ['operations']],
  ['create-connection-reference.js'], ['dataverse-request.js'], ['download-model-app.js'], ['genpage.js', ['list']], ['list-connections.js'],
  ['list-custom-apis.js', [], { GENPAGE_ENABLE_CUSTOM_API: '1' }], ['list-languages.js'], ['list-tables.js'], ['preview-app.js'], ['preview-form.js'],
  ['promote-intent-pages.js'], ['provision-entities.js'], ['provision-solution.js'], ['solution-settings.js', ['template']], ['teardown-model-app.js'],
  ['verify-model-app.js'], ['write-app-spec-doc.js'], ['write-page-plan.js'],
].map(([script, args = [], env = {}]) => ({ script, args, env }));

test('every script prints a usage error that quotes a message of a megabyte whole on stderr, with exit 1 — through both kinds of stream', async () => {
  const text = hugeFailureText('flag', BIG);
  await eachAtOnce(USAGE_CASES, ({ script, args, env }) => assertWholeBothWays([path.join(SCRIPTS, script), ...args], {
    preloads: [HUGE], env: { ...env, HUGE_FAILURE: 'flag', HUGE_FAILURE_SIZE: String(BIG) }, status: 1, stream: 'stderr', text: `✗ ${text}\n`,
  }, script).then(({ queued }) => assert.equal(queued.stdout, '', `${script}: nothing on stdout`)));
});

test('every script\'s usage error is what it always was: the message, then the usage text, on stderr, with exit 1', async () => {
  const text = hugeFailureText('flag', 10);
  await eachAtOnce(USAGE_CASES, async ({ script, args, env }) => {
    const ran = await runScript([path.join(SCRIPTS, script), ...args], { preloads: [HUGE], env: { ...env, HUGE_FAILURE: 'flag', HUGE_FAILURE_SIZE: '10' } });
    assert.equal(ran.status, 1, `${script}: ${ran.own}${ran.stderr}`);
    assert.equal(ran.stdout, '', `${script}: nothing on stdout`);
    assert.match(ran.stderr, new RegExp(`^✗ ${text.replace(/[<>]/g, '\\$&')}\\n\\S[^]*\\n$`), `${script}: ${JSON.stringify(ran.stderr.slice(0, 200))}`);
  });
});

// ── Every script's last-resort handler ───────────────────────────────────────────────────────────────────────────────────────────────────────────

// A script whose main rejects when its argument parser throws: the handlers of the scripts' own (`Error: <message>` or the message) and, for the
// scripts that hand the error to emitResult, emitResult's.
const THROW_CASES = [
  ['ai-preflight.js'], ['apps.js', ['list']], ['connector.js', ['operations']], ['genpage.js', ['list']], ['genpage-base.js', ['check']], ['genpage-upload.js'],
  ['list-languages.js'], ['list-tables.js'], ['build-model-app.js'], ['download-model-app.js'], ['provision-entities.js'], ['provision-solution.js'],
  ['teardown-model-app.js'], ['verify-model-app.js'], ['write-app-spec-doc.js'],
].map(([script, args = []]) => ({ script, args }));

test('every script\'s last-resort handler prints an error of a megabyte whole on stderr, with exit 1 — through both kinds of stream', async () => {
  const text = hugeFailureText('throw', BIG);
  await eachAtOnce(THROW_CASES, ({ script, args }) => assertWholeBothWays([path.join(SCRIPTS, script), ...args], {
    preloads: [HUGE], env: { HUGE_FAILURE: 'throw', HUGE_FAILURE_SIZE: String(BIG) }, status: 1, stream: 'stderr', text: `${text}\n`,
  }, script).then(({ queued }) => assert.match(queued.stderr, /^(?:Error: )?throw-failure</, `${script}: the message, as the handler always printed it`)));
});

test('every script\'s last-resort handler prints a small error as it always did, with exit 1; solution-settings.js names only the kind of failure', async () => {
  const text = hugeFailureText('throw', 10);
  await eachAtOnce(THROW_CASES, async ({ script, args }) => {
    const ran = await runScript([path.join(SCRIPTS, script), ...args], { preloads: [HUGE], env: { HUGE_FAILURE: 'throw', HUGE_FAILURE_SIZE: '10' } });
    assert.equal(ran.status, 1, `${script}: ${ran.own}${ran.stderr}`);
    assert.match(ran.stderr, new RegExp(`^(?:Error: )?${text.replace(/[<>]/g, '\\$&')}\\n$`), `${script}: ${JSON.stringify(ran.stderr.slice(0, 200))}`);
  });
  const settings = await runScript([path.join(SCRIPTS, 'solution-settings.js'), 'template'], { preloads: [HUGE], env: { HUGE_FAILURE: 'throw', HUGE_FAILURE_SIZE: String(BIG) } });
  assertPrinted(settings, { status: 1, stdout: '', stderr: 'Error: solution-settings.js failed unexpectedly (Error).\n' }, 'solution-settings.js');
});

// ── The hooks' messages ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('validate-icon-imports.js blocks a page that imports sixty thousand unverified icons with its whole message, exit 2; one unverified icon as before', async () => {
  for (const icons of [60000, 1]) {
    const dir = makeTempDir('icon-hook-whole-');
    const names = Array.from({ length: icons }, (_, i) => `NotAVerifiedIcon${i}Regular`);
    const content = `import * as React from 'react';\nimport { ${names.join(', ')} } from '@fluentui/react-icons';\nconst GeneratedComponent = () => null;\nexport default GeneratedComponent;\n`;
    const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'page.tsx'), content }, cwd: dir });
    const { queued } = await assertWholeBothWays([path.join(HOOKS, 'validate-icon-imports.js')], { input, cwd: dir, status: 2, stream: 'stderr', text: `  - ${names[icons - 1]}\n` }, `${icons} icons`);
    assert.match(queued.stderr, new RegExp(`^\\[model-apps\\] The write was blocked: it imported ${icons} icon name\\(s\\)`));
    assert.equal(queued.stdout, '');
  }
});

test('validate-write-safety.js flags a write outside the project whose path is a megabyte long with its whole message, exit 1; a short path as before', async () => {
  for (const size of [BIG, 10]) {
    const dir = makeTempDir('write-safety-whole-');
    fs.writeFileSync(path.join(dir, 'app-spec.json'), '{}');
    const target = path.join(path.parse(dir).root, `outside-${'p'.repeat(size)}.tsx`);
    const input = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: target, content: '' }, cwd: dir });
    const { queued } = await assertWholeBothWays([path.join(HOOKS, 'validate-write-safety.js')], { input, cwd: dir, status: 1, stream: 'stderr', text: `targeted "${target}", which is outside your project folder` }, `${size} characters`);
    assert.match(queued.stderr, /^\[model-apps\] Heads up: a model-apps Write targeted "/);
    assert.match(queued.stderr, /Silence with MODEL_APPS_SKIP_WRITE_GUARD=1 or MODEL_APPS_DISABLE_HOOKS=1\.\n$/);
  }
});

// ── launch-playwright-mcp.js: a server that cannot be started ────────────────────────────────────────────────────────────────────────────────────

// A stand-in for a pipe whose reader is reading but has not caught up: a write puts at most `capacity` characters in the pipe at once and queues the
// rest for a later turn of the event loop — unless the handle was made blocking, when the write returns with all of it taken.
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

test('launch-playwright-mcp.js reports a server that cannot be started with its whole message before it exits 1 — in this process, over a pipe that queues what it cannot take at once', () => {
  const { launch } = require('../launch-playwright-mcp.js');
  for (const size of [BIG, 10]) {
    const message = hugeFailureText('spawn', size);
    const err = queuingPipe();
    const out = queuingPipe();
    const saved = { stdout: Object.getOwnPropertyDescriptor(process, 'stdout'), stderr: Object.getOwnPropertyDescriptor(process, 'stderr'), exit: process.exit };
    const END = new Error('process.exit');
    let ended;
    Object.defineProperty(process, 'stdout', { configurable: true, enumerable: true, get: () => out.stream });
    Object.defineProperty(process, 'stderr', { configurable: true, enumerable: true, get: () => err.stream });
    process.exit = (code) => { ended = { code, taken: err.taken }; throw END; };
    try {
      assert.throws(() => launch({ browser: 'chrome', spawnFn: () => { throw new Error(message); } }), (e) => e === END);
    } finally {
      Object.defineProperty(process, 'stdout', saved.stdout);
      Object.defineProperty(process, 'stderr', saved.stderr);
      process.exit = saved.exit;
    }
    assert.equal(ended.code, 1);
    assert.equal(ended.taken, `Failed to launch Playwright MCP server: ${message}\n`, `${size} characters: the whole message was taken before process.exit`);
  }
});
