'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeGenpageCli: realMakeGenpageCli, parsePageId, parseList, buildPacInvocation, classifyListOutput, parseListCount, runPac } = require('../lib/genpage-cli.js');

// Keep every new Dataverse read offline, including one added by a future recovery change.
const makeGenpageCli = (env, deps = {}) => realMakeGenpageCli(env, {
  request: async () => { throw new Error('unexpected offline Dataverse read'); },
  ...deps,
});
const createdPage = (name = 'Overview') => async () => ({ status: 200, data: { name, createdon: new Date().toISOString() } });

const GUID = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';
// Scratch goes in the OS temp dir, never beside this file. Tests that walk scripts/ (the await scan in
// sdk-async-surface.test.js) list every .js file first and read each one seconds later, so a scratch
// directory this file deletes in between failed them with ENOENT.
const scratchDirs = [];
const scratch = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
};
test.after(() => { for (const d of scratchDirs) fs.rmSync(d, { recursive: true, force: true }); });

// REAL `pac model genpage list` output — a fixed-width TABLE (header + GUID/Name/Published rows), captured
// LIVE from a Dataverse test environment (2026-07). Columns auto-size to the longest name. `listText` reproduces
// that exact shape; `countOverride` lets a test set the "Found N" summary independently of the rows (to
// exercise the count-mismatch fail-closed path). NOTE (live): pac lists only SITEMAP-reachable pages.
function listText(rows, countOverride) {
  const count = countOverride == null ? rows.length : countOverride;
  const nameW = Math.max(4, ...rows.map((r) => String(r.name || '').length));
  const header = 'Page ID'.padEnd(37) + 'Name'.padEnd(nameW + 1) + 'Published';
  const body = rows.map((r) => `${r.pageId} ${String(r.name || '').padEnd(nameW)} ${r.published || '-'}`).join('\n');
  return `Connected as tester@contoso.com\nRetrieving generated pages...\nFound ${count} generated page(s):\n\n${header}\n${body}\n`;
}
// Empty app: the summary with count 0 and no rows (live-confirmed "Found 0 generated page(s):"; any
// unmatched zero-exit output is safely fail-closed 'unrecognized', never 'empty').
const LIST_ONE = listText([{ pageId: GUID, name: 'Overview' }]);
const LIST_EMPTY = 'Connected as tester@contoso.com\nRetrieving generated pages...\nFound 0 generated page(s):\n';

// Real GUIDs for env-wide enumeration tests (C2 / addenda cross-cutting note Imp9).
const GP_A = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
const GP_B = '5c0a4889-45fd-46ea-91a8-ff876914d644';
// Build a real fixed-width `pac model genpage list` table for env-wide enumerateEnv mocks.
// Column widths auto-size to the longest name (same as listText above); this helper uses a fixed
// 16-char name column wide enough for "Order Detail" so tests don't need to compute widths.
function envList(rows) {
  const nameW = 16;
  const header = `${'Page ID'.padEnd(37)}${'Name'.padEnd(nameW + 1)}Published`;
  const body = rows.map((r) => `${r.pageId} ${String(r.name || '').padEnd(nameW)} -`).join('\n');
  const count = rows.length;
  return `Connected as user@contoso.com\nRetrieving generated pages...\nFound ${count} generated page(s):\n\n${header}\n${body}\n`;
}

// A Windows machine where pac is either the dotnet-tool pac.exe or an MSI-style pac.cmd shim.
// The fake pac.cmd forwards %* like an MSI install's shim, without turning delayed expansion on.
const winPac = (file) => ({ platform: 'win32', env: { Path: 'C:\\pac', PATHEXT: '.EXE;.CMD', SystemRoot: 'C:\\Windows' }, exists: (p) => p === file, readFile: () => '@"%~dp0tools\\pac.exe" %*\r\n' });
const PAC_EXE = winPac('C:\\pac\\pac.exe');
const PAC_CMD = winPac('C:\\pac\\pac.cmd');

// A listing row whose GUID runs straight into more identifier text is not a page id followed by a
// name. The row parser used an ASCII `\b`, which JavaScript places before `東`, so `<guid>東京` was
// read as a valid id and a count-matched listing was accepted as authoritative.
test('parseList skips a row whose GUID runs into more identifier text, and the listing fails closed', () => {
  for (const suffix of ['東京', 'é', '_x', '-x']) {
    const out = listText([{ pageId: GUID + suffix, name: 'Overview' }]);
    assert.deepStrictEqual(parseList(out), [], `a row starting ${JSON.stringify(GUID + suffix)} is not a page`);
    assert.strictEqual(classifyListOutput(out).kind, 'unrecognized', `suffix ${JSON.stringify(suffix)} must fail closed`);
  }
  const mixed = listText([{ pageId: GUID, name: 'Overview' }, { pageId: GP_A + '東京', name: 'Detail' }]);
  assert.strictEqual(classifyListOutput(mixed).kind, 'unrecognized', 'one bad row makes the whole listing untrustworthy');
  // Control: the same listing with a clean id is authoritative, so the refusals above are about the suffix.
  assert.deepStrictEqual(classifyListOutput(listText([{ pageId: GUID, name: 'Overview' }])),
    { kind: 'pages', pages: [{ pageId: GUID, name: 'Overview' }] });
});
test('buildPacInvocation starts pac.exe directly with every argument unchanged, and no shell', () => {
  const inv = buildPacInvocation(['model', 'genpage', 'upload', '--name', 'a "quote" & 50%!'], PAC_EXE);
  assert.strictEqual(inv.file, 'C:\\pac\\pac.exe');
  assert.deepStrictEqual(inv.args, ['model', 'genpage', 'upload', '--name', 'a "quote" & 50%!']);
  assert.strictEqual(inv.options.shell, false);
});

// An update sends a page's CURRENT name on the user's behalf. Whether pac can be handed it is decided without
// starting anything, so an update can leave out a name a pac.cmd shim would refuse instead of failing on it.
test('argumentRefusal says why a pac.cmd shim cannot receive a value, and is null when pac can', () => {
  const shim = makeGenpageCli('https://contoso.crm.dynamics.com', { pacInvocation: PAC_CMD });
  for (const value of ['Revenue 100%', 'Say "hi"']) assert.match(shim.argumentRefusal(value), /cannot pass .* to pac\.cmd/, value);
  assert.strictEqual(shim.argumentRefusal('Plain name — “curly” it\'s 東京'), null);
  const exe = makeGenpageCli('https://contoso.crm.dynamics.com', { pacInvocation: PAC_EXE });
  for (const value of ['Revenue 100%', 'Say "hi"']) assert.strictEqual(exe.argumentRefusal(value), null, value);
  // pac not installed at all is the upload's own error to report, not a refusal of the value.
  const none = makeGenpageCli('https://contoso.crm.dynamics.com', { pacInvocation: { ...PAC_EXE, exists: () => false } });
  assert.strictEqual(none.argumentRefusal('Revenue 100%'), null);
});

test('buildPacInvocation runs a pac.cmd shim through cmd.exe and refuses what cmd.exe would reinterpret', () => {
  const inv = buildPacInvocation(['model', 'genpage', 'list', '--name', 'Order Detail'], PAC_CMD);
  assert.strictEqual(inv.file, 'C:\\Windows\\System32\\cmd.exe');
  assert.strictEqual(inv.args[4], '""C:\\pac\\pac.cmd" model genpage list --name "Order Detail""');
  assert.strictEqual(inv.options.windowsVerbatimArguments, true);
  for (const name of ['50% off', 'a "quote"']) {
    assert.throws(() => buildPacInvocation(['--name', name], PAC_CMD), (e) => e.code === 'EARGUMENT', name);
  }
  assert.ok(buildPacInvocation(['--name', 'Hello!'], PAC_CMD).args[4].endsWith('--name "Hello!""'), '! is literal with delayed expansion off');
});

test('buildPacInvocation (posix) spawns pac directly with an args array and no shell', () => {
  const posix = { platform: 'linux', env: { PATH: '/usr/bin' }, exists: (p) => p === '/usr/bin/pac' };
  const inv = buildPacInvocation(['model', 'genpage', 'upload', '--prompt', 'a "quote" & more'], posix);
  assert.strictEqual(inv.file, '/usr/bin/pac');
  assert.strictEqual(inv.options.shell, false, 'no shell on POSIX so metacharacters round-trip verbatim');
  assert.deepStrictEqual(inv.args, ['model', 'genpage', 'upload', '--prompt', 'a "quote" & more']);
});

test('buildPacInvocation collapses embedded newlines in args (every platform and pac form)', () => {
  const posix = buildPacInvocation(['--prompt', 'l1\r\nl2\nl3'], { platform: 'linux', env: { PATH: '/b' }, exists: () => true });
  assert.deepStrictEqual(posix.args, ['--prompt', 'l1 l2 l3'], 'multi-line prompt collapsed to spaces');
  const win = buildPacInvocation(['--prompt', 'l1\r\nl2'], PAC_CMD);
  assert.ok(!win.args[4].includes('\n'), 'no raw newline survives into a batch shim command line');
});
// Put a directory first on PATH for the duration of `fn`, so `pac` resolves to whatever it holds.
async function withPathFirst(dir, fn, { only = false } = {}) {
  const saved = process.env.PATH;
  process.env.PATH = only ? dir : dir + path.delimiter + saved;
  try { return await fn(); } finally { process.env.PATH = saved; }
}

// A fake `pac` to put first on PATH: `pac.cmd` on Windows, reached through cmd.exe exactly as the
// real one is, and an executable script elsewhere. By default it writes a multibyte character in two
// pieces 200 ms apart, then its argv, then an error, and exits 3. With `--big` it writes 1.5 MiB.
// With `--late` it starts a process that shares its stdout and writes 300 ms after the fake exits.
// With FAKE_PAC_HANG set to a file name it prints the start of a listing, records its own pid there and then runs for 30 s (a pac
// that never finishes its answer).
const BIG_OUTPUT_BYTES = 1536 * 1024;
function makeFakePac() {
  const dir = scratch('genpage-cli-fakepac-');
  const script = path.join(dir, 'fake-pac.js');
  fs.writeFileSync(script, [
    'if (process.env.FAKE_PAC_HANG) {',
    // Half a listing first — what a pac that is ended while it is still answering has already printed — and the pid only once
    // that has been written, so a test that sees the pid knows the partial output is on its way to the runner.
    "  process.stdout.write('Found 2 generated page(s):\\n6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 Ove', () => {",
    "    require('fs').writeFileSync(process.env.FAKE_PAC_HANG, String(process.pid));",
    '  });',
    '  setTimeout(() => {}, 30000);',
    `} else if (process.argv.includes('--big')) process.stdout.write('x'.repeat(${BIG_OUTPUT_BYTES}));`,
    "else if (process.argv.includes('--late')) {",
    "  require('child_process').spawn(process.execPath, ['-e', \"setTimeout(() => process.stdout.write('late'), 300)\"],",
    "    { stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true }).unref();",
    "  process.stdout.write('early ');",
    '} else {',
    "  const bytes = Buffer.from('東京', 'utf8');",
    '  process.stdout.write(bytes.subarray(0, 1));',
    '  setTimeout(() => {',
    "    process.stdout.write(Buffer.concat([bytes.subarray(1), Buffer.from(' ' + JSON.stringify(process.argv.slice(2)) + '\\n', 'utf8')]));",
    "    process.stderr.write('Error: fake failure\\n');",
    '    process.exitCode = 3;',
    '  }, 200);',
    '}',
    '',
  ].join('\n'), 'utf8');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'pac.cmd'), `@"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  } else {
    fs.writeFileSync(path.join(dir, 'pac'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  return dir;
}

// The default runner must YIELD while pac runs. genpage-upload.js overlaps an update's two
// listings, which saves nothing if every pac call freezes the process the way spawnSync did. The
// fake's split character catches a runner that decodes each chunk as it arrives.
test('runPac lets the event loop run while pac runs, and decodes output split mid-character', async () => {
  const dir = makeFakePac();
  const args = ['model', 'genpage', 'list', '--name', 'Order Detail'];
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  try {
    const r = await withPathFirst(dir, () => runPac(args));
    assert.strictEqual(r.status, 3, 'the exit code is passed through');
    assert.strictEqual(r.stdout, `東京 ${JSON.stringify(args)}\n`, 'the split character arrives whole, and the args intact');
    assert.match(r.stderr, /Error: fake failure/);
    assert.ok(ticks > 0, 'timers fired while pac was running, so the process was not blocked');
  } finally {
    clearInterval(timer);
  }
});

// spawnSync capped output at 1 MiB (its maxBuffer): past that it killed pac and returned a
// truncated listing as a failure. The runner keeps everything, and reads each pipe to its end before
// settling — pac can exit while the tail of a large write is still unread in the pipe.
test('runPac keeps output past 1 MiB, read to the end of the pipe', async () => {
  const dir = makeFakePac();
  const r = await withPathFirst(dir, () => runPac(['model', 'genpage', 'list', '--big']));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.length, BIG_OUTPUT_BYTES);
});

// Settling when pac EXITS would lose output a process it started writes afterwards. spawnSync
// returned only once the pipes closed, and so does the runner.
test('runPac settles when the pipes close, as spawnSync did, not when pac exits', async () => {
  const r = await withPathFirst(makeFakePac(), () => runPac(['model', 'genpage', 'list', '--late']));
  assert.strictEqual(r.stdout, 'early late');
  assert.strictEqual(r.status, 0, r.stderr);
});

// A pac that cannot be started must come back as an ordinary failed result — every caller branches
// on `status` and none of them catches. That is spawn's 'error' event (ENOENT), which spawnSync
// reported as status 1 with no text at all. On Windows pac runs through cmd.exe, which would print
// its own "not recognized" and exit, so the shell itself is made unstartable to reach that path.
test('runPac resolves with a non-zero status and the launch error when pac cannot be started', async () => {
  const empty = scratch('genpage-cli-nopac-');
  const savedComSpec = process.env.ComSpec;
  if (process.platform === 'win32') process.env.ComSpec = path.join(empty, 'no-such-shell.exe');
  let r;
  try {
    r = await withPathFirst(empty, () => runPac(['model', 'genpage', 'list']), { only: true });
  } finally {
    if (process.platform === 'win32') {
      if (savedComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = savedComSpec;
    }
  }
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /ENOENT/, `the failure must say why; got ${JSON.stringify(r)}`);
});

// A caller that stops needing pac's answer — a verify pass that failed — must be able to END it. pac has no timeout of its
// own, and on Windows it is usually a batch shim: Node's own kill of the cmd.exe it started leaves pac itself running.
// The fake records its pid and then hangs, so these tests see whether the process that matters is gone.
const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function waitUntil(condition, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
const withHangingPac = async (fn) => {
  const pidFile = path.join(scratch('genpage-cli-pid-'), 'pac.pid');
  process.env.FAKE_PAC_HANG = pidFile;
  try {
    return await withPathFirst(makeFakePac(), () => fn(pidFile));
  } finally {
    delete process.env.FAKE_PAC_HANG;
  }
};
const readPid = (pidFile) => Number(fs.readFileSync(pidFile, 'utf8'));
const endsWithin = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('still running'), ms))]);

test('runPac ends pac, and everything it started, when its signal aborts — the answer is a failed, output-free result marked ended', async () => {
  await withHangingPac(async (pidFile) => {
    const controller = new AbortController();
    const run = runPac(['model', 'genpage', 'list'], { signal: controller.signal });
    assert.ok(await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')), 'pac started');
    const pid = readPid(pidFile);
    assert.ok(processAlive(pid));
    // The half of a listing that pac printed before it hung has reached the runner by now; an ended run hands back none of it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();
    const r = await endsWithin(run, 5000);
    assert.notStrictEqual(r, 'still running', 'the run answers at once once it is ended');
    assert.notStrictEqual(r.status, 0);
    assert.strictEqual(r.ended, true);
    assert.strictEqual(r.stdout, '', 'a half-read listing is never handed back, where a caller could parse it');
    assert.match(r.stderr, /pac was ended/);
    assert.ok(await waitUntil(() => !processAlive(pid)), 'pac itself is gone — not only the shell that started it');
  });
});

test('runPac with a signal that has already aborted starts no pac at all', async () => {
  await withHangingPac(async (pidFile) => {
    const controller = new AbortController();
    controller.abort();
    const r = await runPac(['model', 'genpage', 'list'], { signal: controller.signal });
    assert.strictEqual(r.ended, true);
    assert.notStrictEqual(r.status, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(!fs.existsSync(pidFile), 'pac was never started');
  });
});

test('a pac run nobody aborts is not marked ended, and a signal that never fires changes nothing', async () => {
  const controller = new AbortController();
  const r = await withPathFirst(makeFakePac(), () => runPac(['model', 'genpage', 'list', '--big'], { signal: controller.signal }));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.ended, undefined);
  assert.strictEqual(r.stdout.length, BIG_OUTPUT_BYTES);
});

test('the client\'s abort() ends the pac runs it has in flight and a listing that was ended is not retried — and the client is usable afterwards', async () => {
  const sleeps = [];
  const cli = realMakeGenpageCli('https://contoso.crm.dynamics.com', { attempts: 3, sleep: async (ms) => { sleeps.push(ms); } });
  await withHangingPac(async (pidFile) => {
    const listing = cli.enumerateEnv();
    assert.ok(await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')), 'pac started');
    const pid = readPid(pidFile);
    cli.abort();
    const r = await endsWithin(listing, 5000);
    assert.notStrictEqual(r, 'still running');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /was ended/);
    assert.deepStrictEqual(sleeps, [], 'no retry: the attempt that was ended is not followed by the pause and the new attempt a flake would get');
    assert.ok(await waitUntil(() => !processAlive(pid)), 'pac is gone');
  });
  // Runs started after an abort are not affected.
  const after = await withPathFirst(makeFakePac(), () => cli.enumerateEnv());
  assert.strictEqual(after.ok, false);
  assert.doesNotMatch(String(after.error), /was ended/, 'it failed for the reason the fake pac fails (exit 3), not because the client was ended');
  assert.strictEqual(sleeps.length, 2, 'an ordinary failure is retried as before');
});

// A call that failed once pauses before it asks again, and an abort() that lands in that pause finds nothing in flight to end — so
// the attempt after the pause used to start a pac run that nothing would ever end (pac has no timeout of its own). A call that
// began before the abort starts nothing more, whichever call it is; a call that begins afterwards is an ordinary one.
const flakyRun = (runs) => async (args) => { runs.push(args); return { status: 1, stdout: '', stderr: 'Error: flaky' }; };

test('abort() during the pause between two attempts of a listing stops the call: no further pac run is started — and the client is usable afterwards', async () => {
  const listings = [
    ['the env-wide listing', (cli) => cli.enumerateEnv(), /^pac genpage list \(env-wide\) was ended/],
    ['an app\'s listing', (cli) => cli.enumeratePages('app-1'), /^pac genpage list was ended/],
  ];
  for (const [what, call, wanted] of listings) {
    const runs = [];
    const pauses = [];
    let abortInPause = true;
    let cli;
    cli = realMakeGenpageCli('https://contoso.crm.dynamics.com', { attempts: 3, run: flakyRun(runs), sleep: async (ms) => { pauses.push(ms); if (abortInPause) cli.abort(); } });
    const answer = await call(cli);
    assert.strictEqual(runs.length, 1, `${what}: the attempt after the pause was never started`);
    assert.strictEqual(answer.ok, false, what);
    assert.match(answer.error, wanted, what);
    assert.deepStrictEqual(pauses, [500], `${what}: and the call does not pause again for an attempt it will not make`);
    // A call that begins after the abort is an ordinary one, retried like any other.
    abortInPause = false;
    runs.length = 0;
    const later = await call(cli);
    assert.strictEqual(runs.length, 3, `${what}: a later call makes all its attempts`);
    assert.doesNotMatch(String(later.error), /was ended/, what);
  }
});

test('abort() during the pause between two attempts of an upload stops it as well: a create never starts — and an update that failed has no pause to stop, since it is never sent again', async () => {
  const runs = [];
  const pauses = [];
  let cli;
  cli = realMakeGenpageCli('https://contoso.crm.dynamics.com', { attempts: 3, run: flakyRun(runs), sleep: async (ms) => { pauses.push(ms); cli.abort(); } });
  await assert.rejects(
    cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'page.tsx', name: 'Overview' }),
    /pac genpage upload for 'Overview' failed \(Error: flaky\) — the UPDATE of page [^ ]+ MAY HAVE LANDED/,
  );
  assert.strictEqual(runs.length, 1, 'the update is sent once');
  assert.deepStrictEqual(pauses, [], 'and nothing waits for an attempt that will not be made');
  // A create takes its snapshot of the environment first: that listing is the call that is paused, and the create is never started.
  runs.length = 0;
  await assert.rejects(
    cli.upload({ appId: 'app-1', codeFile: 'page.tsx', name: 'Overview' }),
    /cannot snapshot the environment before create.*was ended/,
  );
  assert.strictEqual(runs.length, 1, 'only the listing attempt ran; no `upload` command was ever sent');
  assert.ok(!runs.some((args) => args.includes('upload')));
});

// The reconciliation of an uncertain create lists the environment again, and that listing must start nothing either once an abort has come.
test('abort() during the pause between two attempts of a create makes the reconciliation listing that follows an ended one, not a new pac run', async () => {
  const runs = [];
  let cli;
  const run = async (args) => {
    runs.push(args.includes('list') ? 'list' : 'upload');
    return args.includes('list') ? { status: 0, stdout: LIST_EMPTY, stderr: '' } : { status: 1, stdout: '', stderr: 'Error: flaky' };
  };
  cli = realMakeGenpageCli('https://contoso.crm.dynamics.com', { attempts: 3, run, sleep: async () => { cli.abort(); } });
  await assert.rejects(
    cli.upload({ appId: 'app-1', codeFile: 'page.tsx', name: 'Overview' }),
    /had an uncertain result and env enumeration failed.*was ended/,
  );
  assert.deepStrictEqual(runs, ['list', 'upload', 'list'], 'the snapshot, the create, its first reconciliation — and nothing after the abort');
});

test('abort() during the pause between two attempts of a listing, with a real pac, starts no second pac — the one an abort could not have ended', async () => {
  const pidFile = path.join(scratch('genpage-cli-pid-'), 'pac.pid');
  let cli;
  cli = realMakeGenpageCli('https://contoso.crm.dynamics.com', {
    attempts: 3,
    sleep: async () => {
      // From here on a pac that is started would hang, so one started after the abort is one nobody ends.
      process.env.FAKE_PAC_HANG = pidFile;
      cli.abort();
    },
  });
  try {
    await withPathFirst(makeFakePac(), async () => {
      const answer = await endsWithin(cli.enumerateEnv(), 8000);
      assert.notStrictEqual(answer, 'still running', 'the call answers: it did not wait for a second pac');
      assert.strictEqual(answer.ok, false);
      assert.match(answer.error, /was ended/);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.ok(!fs.existsSync(pidFile), 'no pac was started after the abort');
    });
  } finally {
    delete process.env.FAKE_PAC_HANG;
    cli.abort(); // ends the pac a client that starts one after an abort would have left behind
  }
});

test('abort() ends a download that is running: it fails at once with the reason, and its whole process tree is gone', async () => {
  const cli = realMakeGenpageCli('https://contoso.crm.dynamics.com');
  await withHangingPac(async (pidFile) => {
    const download = cli.download({ appId: 'app-1', outputDir: scratch('genpage-cli-out-'), pageIds: [GP_A] }).then(() => 'resolved', (error) => error);
    assert.ok(await waitUntil(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')), 'pac started');
    const pid = readPid(pidFile);
    cli.abort();
    const failure = await endsWithin(download, 5000);
    assert.notStrictEqual(failure, 'still running');
    assert.match(failure.message, /^pac genpage download failed: .*was ended/);
    assert.ok(await waitUntil(() => !processAlive(pid)), 'pac is gone');
  });
});

test('a verify pass that fails while pac is still listing pages ends that pac — the whole process tree — before it throws', async () => {
  const { verifySpec } = require('../lib/verify-spec.js');
  const { readerFor } = require('../verify-model-app.js');
  await withHangingPac(async (pidFile) => {
    const pacStarted = () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8');
    const sdk = {
      queryRecords: async () => [],
      // The first check fails once pac is running, so the page check's listing is what the pass gives up on.
      findTables: async () => { await waitUntil(pacStarted); throw new Error('the environment could not be read'); },
    };
    const spec = {
      schemaVersion: 2,
      solution: { uniqueName: 'verify_pac', publisherPrefix: 'new' },
      app: { name: 'Verify Pac', uniqueName: 'new_verifypac' },
      entities: [{ schemaName: 'new_t0', columns: [] }],
      pages: [{ key: 'overview', name: 'Overview', source: { kind: 'tsx', codeFile: 'overview.tsx' } }],
      appShell: { areas: [] },
    };
    const cli = realMakeGenpageCli('https://contoso.crm.dynamics.com');
    const reader = readerFor(sdk, 'new_verifypac', { genpageCli: cli });
    // The membership read is the first of the page reads; the existence listing — the pac run — comes next.
    reader.sitemapPageIds = async () => [GP_A];
    const outcome = await endsWithin(verifySpec(spec, reader, { concurrency: 4 }).then(() => ({}), (error) => ({ error })), 15000);
    assert.notStrictEqual(outcome, 'still running', 'the pass does not wait for the pac listing');
    assert.match(outcome.error.message, /the environment could not be read/);
    assert.ok(await waitUntil(() => !processAlive(readPid(pidFile)), 2000), 'pac, and not only the shell that started it, is gone by the time the pass is over');
  });
});

test('parsePageId extracts the guid from upload output', () => {
  assert.strictEqual(parsePageId(`Successfully pushed page. Page ID: ${GUID}\n`), GUID);
  assert.strictEqual(parsePageId('no id here'), null);
});

test('parseList parses the fixed-width GUID/Name/Published table (a spaced name is not split)', () => {
  const out = listText([{ pageId: GUID, name: 'Overview' }, { pageId: '11111111-2222-3333-4444-555555555555', name: 'Order Detail' }]);
  const pages = parseList(out);
  assert.strictEqual(pages.length, 2);
  assert.deepStrictEqual(pages[0], { pageId: GUID, name: 'Overview' });
  assert.strictEqual(pages[1].name, 'Order Detail'); // a name containing a space stays intact
});

test('upload builds pac args WITHOUT --add-to-sitemap and returns the pageId', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    // before-snapshot call: return an empty-env listing so enumerateEnv succeeds
    if (args[2] === 'list') return { status: 0, stdout: LIST_EMPTY, stderr: '' };
    return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const cli = makeGenpageCli('https://x', { run, sleep: async () => {} });
  const r = await cli.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', dataSources: ['new_o'] });
  assert.strictEqual(r.pageId, GUID);
  // The upload call is NOT calls[0] any more (before-snapshot is first); find by verb.
  const args = calls.find((a) => a[2] === 'upload');
  assert.ok(!args.includes('--add-to-sitemap'), 'never adds to sitemap (the SDK owns it)');
  assert.ok(args.includes('--prompt-file') && args.includes('--agent-message-file'), 'supplies pac-required prompt + agent-message BY FILE (multi-line safe)');
  assert.ok(!args.includes('--prompt') && !args.includes('--agent-message'), 'never inline --prompt/--agent-message (they would be lossily newline-collapsed)');
  assert.ok(args.includes('--data-sources') && args.includes('new_o'));
  assert.ok(args.includes('--environment') && args.includes('https://x'));
});

test('upload defaults prompt + agent-message when absent (pac requires both), delivered by file', async () => {
  const fs = require('node:fs');
  const calls = [];
  let promptText = null;
  let agentText = null;
  const run = async (args) => {
    calls.push(args);
    if (args[2] === 'list') return { status: 0, stdout: LIST_EMPTY, stderr: '' };
    // Read the temp files back while upload() still owns them (before its finally cleans up).
    const pi = args.indexOf('--prompt-file');
    const ai = args.indexOf('--agent-message-file');
    promptText = fs.readFileSync(args[pi + 1], 'utf8');
    agentText = fs.readFileSync(args[ai + 1], 'utf8');
    return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  await makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'X' });
  const uploadCall = calls.find((a) => a[2] === 'upload');
  assert.ok(uploadCall.includes('--prompt-file') && uploadCall.includes('--agent-message-file'));
  assert.ok(!uploadCall.includes('--prompt') && !uploadCall.includes('--agent-message'), 'defaults go by file too, never inline');
  assert.strictEqual(promptText, 'Generative page X', 'historical default prompt preserved, just delivered by file');
  assert.strictEqual(agentText, 'Authored by app-builder', 'historical default agent-message preserved, just delivered by file');
});

test('upload delivers the prompt via --prompt-file and a multi-line transcript round-trips verbatim (#565)', async () => {
  const fs = require('node:fs');
  // A real downloaded page prompt: a multi-line conversation transcript carrying BOTH \r\n and \n
  // breaks plus non-ASCII — exactly the shape the old inline --prompt path collapsed to spaces on an
  // edit-rebuild (`pac model genpage upload --help` documents --prompt-file for precisely this).
  const multiline = 'Conversation with 2 prompts:\r\n1. Show an overview \u2014 caf\u00e9 \u2615\n2. Add a bar chart';
  let promptFilePath = null;
  let roundTripped = null;
  const run = async (args) => {
    if (args[2] === 'list') return { status: 0, stdout: LIST_EMPTY, stderr: '' };
    assert.ok(!args.includes('--prompt'), 'prompt is never passed inline (that path is lossy for newlines)');
    const i = args.indexOf('--prompt-file');
    assert.ok(i >= 0, 'prompt is delivered via --prompt-file');
    promptFilePath = args[i + 1];
    // Read the file back while upload() still owns it (before the finally cleans it up).
    roundTripped = fs.readFileSync(promptFilePath, 'utf8');
    return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} })
    .upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview', prompt: multiline });
  assert.strictEqual(r.pageId, GUID);
  assert.strictEqual(roundTripped, multiline, 'every \\r\\n and \\n line break and the non-ASCII survive byte-for-byte');
  assert.ok(promptFilePath && !fs.existsSync(promptFilePath), 'the prompt temp file is cleaned up on success');
});

test('upload threads --compiled-code-file only when the caller supplies it (else pac auto-transpiles) (#565)', async () => {
  const seen = [];
  const run = async (args) => {
    if (args[2] === 'list') return { status: 0, stdout: LIST_EMPTY, stderr: '' };
    seen.push(args);
    return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const cli = makeGenpageCli('https://x', { run, sleep: async () => {} });
  // Absent → flag omitted so pac auto-transpiles the TypeScript (the live-verified default path).
  await cli.upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' });
  assert.ok(!seen[0].includes('--compiled-code-file'), 'no --compiled-code-file when the caller omits it');
  // Supplied → flag present with the exact caller path.
  await cli.upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', compiledCodeFile: 'o.js', name: 'Overview' });
  const ci = seen[1].indexOf('--compiled-code-file');
  assert.ok(ci >= 0 && seen[1][ci + 1] === 'o.js', 'passes --compiled-code-file <path> when supplied');
});

test('upload cleans up its temp files even when it throws after exhausting retries (#565)', async () => {
  const fs = require('node:fs');
  let promptPath = null;
  let agentPath = null;
  let creates = 0;
  const run = async (args) => {
    // A CREATE whose every attempt fails outright and leaves nothing in the listing — the one kind of upload that is retried — so the wrapper throws after
    // `attempts`. (An UPDATE that fails is not retried at all: it may have landed.) The finally must still remove the temp dir.
    if (args.includes('list')) return { status: 0, stdout: LIST_EMPTY, stderr: '' };
    creates += 1;
    const pi = args.indexOf('--prompt-file');
    const ai = args.indexOf('--agent-message-file');
    if (pi >= 0) promptPath = args[pi + 1];
    if (ai >= 0) agentPath = args[ai + 1];
    return { status: 1, stdout: '', stderr: 'boom' };
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }),
    /pac genpage upload failed for 'Overview': boom/
  );
  assert.strictEqual(creates, 3, 'every attempt was spent');
  assert.ok(promptPath && !fs.existsSync(promptPath), 'prompt temp file removed on the retry-exhaustion throw');
  assert.ok(agentPath && !fs.existsSync(agentPath), 'agent-message temp file removed on the retry-exhaustion throw');
});

test('upload cleans up its temp files even when it throws mid-loop (I7 identity mismatch) (#565)', async () => {
  const fs = require('node:fs');
  let promptPath = null;
  const run = async (args) => {
    const pi = args.indexOf('--prompt-file');
    if (pi >= 0) promptPath = args[pi + 1];
    // Return a DIFFERENT id than the requested pageId → the I7 guard throws from inside the loop.
    return { status: 0, stdout: `Page ID: ${GP_A}`, stderr: '' };
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run }).upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }),
    /unexpected Page ID|refusing to persist/i
  );
  assert.ok(promptPath && !fs.existsSync(promptPath), 'temp file removed even on a mid-loop throw');
});

test('upload with a pageId updates in place (adds --page-id)', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args); return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; };
  // Use GUID as the pageId so the I7 guard (returned id must equal pid) does not fire.
  await makeGenpageCli('https://x', { run }).upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' });
  assert.ok(calls[0].includes('--page-id') && calls[0].includes(GUID));
});

// A failed UPDATE is no proof that nothing landed: pac writes the page, records the prompt and the agent message, prints its Page ID, then publishes — so a failure in the
// publish comes after everything else is written, and a re-send records the prompt again. It is not sent again, flake or not. (A CREATE that failed outright and left
// nothing behind is still retried: see the uncertain-CREATE tests.)
test('upload does not send a failed UPDATE again, even when the failure may be a flake', async () => {
  let n = 0;
  const run = async () => { n += 1; return n === 1 ? { status: 1, stdout: '', stderr: 'flaky help dump' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }),
    /pac genpage upload for 'Overview' failed \(flaky help dump\) — the UPDATE of page 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 MAY HAVE LANDED: /);
  assert.strictEqual(n, 1, 'one send');
});

// The diff discovers a candidate, not authority to turn a failed CREATE into an UPDATE.
test('upload reports a failed CREATE candidate without an automatic UPDATE', async () => {
  const uploadArgs = [];
  let up = 0;
  let listN = 0;
  const run = async (args) => {
    if (args[2] === 'list') {
      listN++;
      // before-snapshot (listN=1): env is empty; after-snapshot (listN=2): GUID appeared
      return { status: 0, stdout: listN === 1 ? LIST_EMPTY : listText([{ pageId: GUID, name: 'Overview' }]), stderr: '' };
    }
    up += 1; uploadArgs.push(args);
    return up === 1 ? { status: 1, stdout: '', stderr: 'flaky' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  await assert.rejects(makeGenpageCli('https://x', { run, sleep: async () => {}, request: createdPage() }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }),
    (e) => e.message.includes(GUID) && /createdon|--page-id/.test(e.message));
  assert.strictEqual(uploadArgs.length, 1);
  assert.ok(!uploadArgs[0].includes('--page-id'), 'first attempt was a create (no page-id)');
});

// Updated for Plan 5 (C2): the BEFORE-snapshot is taken PRIOR to issuing any CREATE; if it fails,
// we HALT immediately — no CREATE is ever issued, so there is nothing to accidentally duplicate.
test('upload is fail-closed when a CREATE is uncertain and enumeration cannot run (no blind retry)', async () => {
  let creates = 0;
  const run = async (args) => { if (args[2] === 'list') return { status: 1, stdout: '', stderr: '' }; creates += 1; return { status: 1, stdout: '', stderr: 'boom' }; };
  await assert.rejects(makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'X' }), /cannot snapshot|refusing to (create|retry)/i);
  assert.strictEqual(creates, 0, 'no create issued — halted at before-env-snapshot (never risks a duplicate)');
});

test('list returns [] when pac fails', async () => {
  const run = async () => ({ status: 1, stdout: '', stderr: 'boom' });
  assert.deepStrictEqual(await makeGenpageCli('https://x', { run }).list({ appId: 'a' }), []);
});

// ── Task 4: parseListCount ────────────────────────────────────────────────────────────────────────

test('parseListCount reads the summary "Found N generated page(s)" count (else null)', () => {
  assert.strictEqual(parseListCount(LIST_ONE), 1);
  assert.strictEqual(parseListCount(LIST_EMPTY), 0);
  assert.strictEqual(parseListCount('  Overview\n    Page ID: abc'), null);
  assert.strictEqual(parseListCount(''), null);
  assert.strictEqual(parseListCount('Found 3 generated page(s):'), 3);
});

// ── Task 4: classifyListOutput (tri-state, COMPLETE-listing, I2) ──────────────────────────────────

test('classifyListOutput: pages / empty / unrecognized (tri-state, COMPLETE-listing, I2)', () => {
  // recognized-pages: count matches parsed pages, all have names
  assert.strictEqual(classifyListOutput(LIST_ONE).kind, 'pages');
  assert.deepStrictEqual(classifyListOutput(LIST_ONE).pages, [{ pageId: GUID, name: 'Overview' }]);
  // recognized-empty: explicit "Found 0" marker
  assert.strictEqual(classifyListOutput(LIST_EMPTY).kind, 'empty');
  assert.deepStrictEqual(classifyListOutput(LIST_EMPTY).pages, []);
  // recognized-empty: "no pages" phrase variant (observed in older pac builds)
  assert.strictEqual(classifyListOutput('No generated pages found.\n').kind, 'empty');
  assert.strictEqual(classifyListOutput('  No pages found  \n').kind, 'empty', 'a standalone no-pages line is accepted');
  assert.strictEqual(classifyListOutput('Warning: no pages could be retrieved because the service is unavailable\n').kind, 'unrecognized', 'a warning sentence is not proof of an empty app');
  assert.strictEqual(classifyListOutput('Status: No generated pages found after retry\n').kind, 'unrecognized', 'the no-pages phrase must occupy the whole trimmed line');
  // unrecognized: blank output (not proof of empty — could be a timeout or help-dump with no banner)
  assert.strictEqual(classifyListOutput('').kind, 'unrecognized');
  // unrecognized: help/usage banner (pac dumps usage on a flag error but exits 0 on some builds)
  assert.strictEqual(classifyListOutput('pac model genpage list\nUsage: pac model genpage ...\n').kind, 'unrecognized');
  // unrecognized: count mismatch — summary says 3 but only 1 row parsed → truncated listing
  assert.strictEqual(classifyListOutput(listText([{ pageId: GUID, name: 'Overview' }], 3)).kind, 'unrecognized');
  // unrecognized: an UNNAMED row (a GUID with a blank Name column) — fail-closed, would else reconcile
  // blindly against an unknown page
  assert.strictEqual(classifyListOutput(listText([{ pageId: GUID, name: '' }])).kind, 'unrecognized');
});

// REGRESSION (whole-branch review, Critical fail-OPEN): the "no pages" phrase is tested against the WHOLE
// stdout (names + descriptions), so a page NAMED or DESCRIBED with "no page(s)" text must NOT force an app
// WITH live pages to classify as EMPTY. A false 'empty' → reconcile sees zero live → duplicate CREATE on
// build + silent page-drop on download. Empty requires NO positive page evidence.
test('classifyListOutput: repeated page ids make a matching-count listing unrecognized', () => {
  const duplicateId = listText([
    { pageId: GUID, name: 'Overview' },
    { pageId: GUID.toUpperCase(), name: 'Summary' },
  ], 2);
  const k = classifyListOutput(duplicateId);
  assert.strictEqual(k.kind, 'unrecognized', `duplicate page identity must fail closed; got ${JSON.stringify(k)}`);
  assert.deepStrictEqual(k.pages, [], 'duplicate identities are not an authoritative set of pages');
});

test('classifyListOutput: a page NAMED "no pages" does NOT force empty when real pages are listed', () => {
  // A page literally named "No Pages" with a valid 1-page summary → 'pages', not 'empty'. The "no pages"
  // phrase is tested against the whole stdout (which includes page NAMES), so it must not fire here.
  const namedNoPages = listText([{ pageId: GUID, name: 'No Pages' }]);
  assert.strictEqual(classifyListOutput(namedNoPages).kind, 'pages');
  assert.deepStrictEqual(classifyListOutput(namedNoPages).pages, [{ pageId: GUID, name: 'No Pages' }]);
  // A 2-page listing where one page is named "No Pages" → 'pages' (both rows parsed, count matches).
  const OTHER = '11111111-2222-3333-4444-555555555555';
  const twoWithNoPages = listText([{ pageId: GUID, name: 'Overview' }, { pageId: OTHER, name: 'No Pages' }]);
  assert.strictEqual(classifyListOutput(twoWithNoPages).kind, 'pages');
  assert.strictEqual(classifyListOutput(twoWithNoPages).pages.length, 2);
  // enumerate must therefore report ok:true with the pages, NOT empty (the fail-OPEN blast radius).
  return makeGenpageCli('env', { run: async () => ({ status: 0, stdout: namedNoPages, stderr: '' }), sleep: async () => {} })
    .enumerate({ appId: 'a' })
    .then((r) => { assert.strictEqual(r.ok, true); assert.ok(!r.empty, 'a page named "No Pages" is NOT an empty app'); assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'No Pages' }]); });
});

// ── Task 4: enumerate (fail-closed, tri-state, retrying) ─────────────────────────────────────────

test('enumerate returns { ok:true, pages } on a COMPLETE zero-exit list (no retry on success)', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return { status: 0, stdout: LIST_ONE, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'Overview' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(n, 1, 'no retry needed when first response is a complete listing');
});

test('enumerate returns { ok:true, pages:[], empty:true } for an app that genuinely has no pages', async () => {
  const cli = makeGenpageCli('env', { run: async () => ({ status: 0, stdout: LIST_EMPTY, stderr: '' }), sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.empty, true);
  assert.deepStrictEqual(r.pages, []);
});

test('enumerate is fail-closed on a zero-exit UNRECOGNIZED / INCOMPLETE listing (blank/help/count-mismatch) — NOT empty (I2)', async () => {
  // count-mismatch: summary says 2 but only 1 Page ID parsed — could be a truncated/partial listing
  const cli = makeGenpageCli('env', { run: async () => ({ status: 0, stdout: listText([{ pageId: GUID, name: 'Overview' }], 2), stderr: '' }), sleep: async () => {}, attempts: 2 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.pages, []);
  assert.match(r.error, /unrecognized|incomplete/i);
});

test('enumerate is fail-closed on a persistent non-zero exit, after retrying', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return { status: 1, stdout: '', stderr: 'auth expired' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /after 3 attempt\(s\)/);
  assert.strictEqual(n, 3, 'retried the configured number of times before giving up');
});

test('enumerate recovers on a later attempt (transient flake)', async () => {
  let n = 0;
  const cli = makeGenpageCli('env', { run: async () => { n += 1; return n < 2 ? { status: 1, stdout: '', stderr: 'flake' } : { status: 0, stdout: LIST_ONE, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  const r = await cli.enumerate({ appId: 'app-1' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.pages, [{ pageId: GUID, name: 'Overview' }]);
  assert.strictEqual(n, 2, 'recovered on the second attempt');
});

// ── Task 4: upload uncertain-CREATE fail-closed retry (C3) ───────────────────────────────────────

// Updated for Plan 5 (C2): with the strict before/after diff, the BEFORE-snapshot is taken prior to
// any CREATE. If enumeration is broken, we HALT before issuing the CREATE — creates === 0.
test('upload: a possibly-successful CREATE + a failing enumeration NEVER issues a 2nd CREATE (C3)', async () => {
  let creates = 0;
  let lists = 0;
  const run = async (args) => {
    if (args.includes('upload')) { creates += 1; return { status: 0, stdout: 'done, no id here', stderr: '' }; }
    lists += 1; return { status: 1, stdout: '', stderr: 'list failed' };
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  await assert.rejects(cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' }), /cannot snapshot|refusing to (create|retry)/i);
  assert.strictEqual(creates, 0, 'zero creates — halted at before-env-snapshot, never risks a duplicate');
  assert.ok(lists >= 1, 'it tried to enumerate before deciding');
});

// A matching name and recent creation time are still only diagnostic data.
test('upload: an uncertain CREATE stops at the new env id without a duplicate or update', async () => {
  let creates = 0, updates = 0;
  let listN = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      if (args.includes('--page-id')) { updates += 1; return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }
      creates += 1; return { status: 0, stdout: 'no id', stderr: '' }; // uncertain create
    }
    listN++;
    // before-snapshot (listN=1): env empty; after-snapshot (listN=2): GUID appeared
    return { status: 0, stdout: listN === 1 ? LIST_EMPTY : LIST_ONE, stderr: '' };
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3, request: createdPage() });
  await assert.rejects(cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' }), (e) => e.message.includes(GUID) && /--page-id/.test(e.message));
  assert.strictEqual(creates, 1, 'one create attempt');
  assert.strictEqual(updates, 0, 'no candidate is automatically updated');
});

test('upload: an uncertain CREATE whose enumeration shows ZERO matches safely retries the CREATE', async () => {
  let creates = 0;
  const run = async (args) => {
    if (args.includes('upload')) { creates += 1; return creates === 1 ? { status: 0, stdout: 'no id', stderr: '' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }
    return { status: 0, stdout: LIST_EMPTY, stderr: '' }; // enumeration proves the create did NOT land
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, attempts: 3 });
  const r = await cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' });
  assert.strictEqual(r.pageId, GUID);
  assert.strictEqual(creates, 2, 'zero live matches → the retry re-issues a CREATE (not a duplicate — none existed)');
});

// ── Task 4: I7 upload-id guard (UPDATE returned id must equal pid) ───────────────────────────────

test('upload (I7): direct UPDATE with caller-provided pageId returns wrong Page ID → throws, as an error the build never retries', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const WRONG_ID = 'aaaaaaaa-0000-0000-0000-000000000000';
  const run = async () => ({ status: 0, stdout: `Page ID: ${WRONG_ID}`, stderr: '' });
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, request: createdPage() });
  // pageId: GUID but pac returns WRONG_ID → mismatch must halt. The send did something, and the message quotes the page's name — user text, here one that reads as a
  // SQL timeout to the build's check of a transient halt — so it carries `transient: false`.
  const error = await cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'x.tsx', name: 'SQL Timeouts' }).then(() => null, (e) => e);
  assert.match(String(error && error.message), /unexpected Page ID|mismatched/i);
  assert.strictEqual(error.transient, false);
  assert.strictEqual(isTransientHalt(error), false);
  assert.strictEqual(isTransientHalt(new Error(error.message)), true, 'the control: the words alone read as transient');
});

// Stop before any candidate update; the explicit-update returned-id guard remains above.
test('upload: uncertain CREATE cannot reach a candidate UPDATE returning another id', async () => {
  const WRONG_ID = 'aaaaaaaa-0000-0000-0000-000000000000';
  let listN = 0;
  let updates = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      if (args.includes('--page-id')) { updates++; return { status: 0, stdout: `Page ID: ${WRONG_ID}`, stderr: '' }; }
      return { status: 0, stdout: 'no id', stderr: '' }; // CREATE uncertain
    }
    listN++;
    // Before is empty; after contains the candidate, which must be reported without an update.
    return { status: 0, stdout: listN === 1 ? LIST_EMPTY : LIST_ONE, stderr: '' };
  };
  const cli = makeGenpageCli('env', { run, sleep: async () => {}, request: createdPage() });
  await assert.rejects(
    cli.upload({ appId: 'app-1', codeFile: 'x.tsx', name: 'Overview' }),
    (e) => e.message.includes(GUID) && /refusing.*update/i.test(e.message)
  );
  assert.strictEqual(updates, 0);
});

// ── Task 2: enumerateEnv (env-wide EXISTENCE authority) ──────────────────────────────────────────

test('enumerateEnv runs env-wide (no --app-id, with --include-unpublished) and returns lower-cased ids + pages', async () => {
  let seen;
  const run = async (args) => {
    seen = args;
    return { status: 0, stdout: envList([{ pageId: GP_A, name: 'Overview' }, { pageId: GP_B, name: 'Order Detail' }]), stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).enumerateEnv();
  assert.ok(!seen.includes('--app-id'), 'env-wide: no --app-id');
  assert.ok(seen.includes('--include-unpublished'), 'drafts included so a just-created page counts (C1)');
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ids, [GP_A, GP_B]); // GP_A/GP_B are already lower-case GUIDs
  assert.strictEqual(r.pages.length, 2);
  assert.deepStrictEqual(r.pages[0], { pageId: GP_A, name: 'Overview' });
});

test('enumerateEnv returns { ok:true, ids:[], pages:[] } for an empty environment ("Found 0")', async () => {
  const run = async () => ({ status: 0, stdout: LIST_EMPTY, stderr: '' });
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {} }).enumerateEnv();
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.ids, []);
  assert.deepStrictEqual(r.pages, []);
});

test('enumerateEnv is FAIL-CLOSED on an unrecognized/incomplete listing (never masquerades as empty)', async () => {
  // summary says 2 but only 1 row parsed → classifyListOutput 'unrecognized' → ok:false
  const bad = envList([{ pageId: GP_A, name: 'Overview' }]).replace('Found 1', 'Found 2');
  const run = async () => ({ status: 0, stdout: bad, stderr: '' });
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 2 }).enumerateEnv();
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.ids, []);
  assert.match(r.error, /unrecognized|incomplete|after 2 attempt/i);
});

test('enumerateEnv is FAIL-CLOSED on a non-zero exit, returns ok:false after retries', async () => {
  let n = 0;
  const run = async () => { n++; return { status: 1, stdout: '', stderr: 'auth expired' }; };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 2 }).enumerateEnv();
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /after 2 attempt/i);
  assert.strictEqual(n, 2);
});

// ── Task 2: uncertain-CREATE strict env-id diff (C2 / addenda) ───────────────────────────────────

test('upload uncertain-CREATE: one new id requires explicit user resolution', async () => {
  let uploadCalls = 0;
  let listN = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      uploadCalls++;
      // A second mutation would be a failure of the stop rule.
      if (uploadCalls === 1) return { status: 0, stdout: 'created, no id returned', stderr: '' };
      return { status: 0, stdout: `Page ID: ${GP_A}`, stderr: '' };
    }
    listN++;
    if (listN === 1) return { status: 0, stdout: envList([]), stderr: '' };                 // before: empty
    return { status: 0, stdout: envList([{ pageId: GP_A, name: 'Overview' }]), stderr: '' }; // after: GP_A appeared
  };
  await assert.rejects(makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 3, request: createdPage() })
    .upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' }),
    (e) => e.message.includes(GP_A) && /otherwise.*leave.*create/i.test(e.message));
  assert.strictEqual(uploadCalls, 1, 'no automatic second mutation');
});

test('upload uncertain-CREATE: newIds>1 → throws (ambiguous — cannot attribute) (C2)', async () => {
  let listN = 0;
  const run = async (args) => {
    if (args.includes('upload')) return { status: 0, stdout: 'no id', stderr: '' };
    listN++;
    if (listN === 1) return { status: 0, stdout: envList([]), stderr: '' };
    // after: TWO new pages appeared — cannot tell which one is ours
    return { status: 0, stdout: envList([{ pageId: GP_A, name: 'Page A' }, { pageId: GP_B, name: 'Page B' }]), stderr: '' };
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 3 })
      .upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' }),
    /ambiguous|cannot attribute/i
  );
});

test('upload uncertain-CREATE: newIds===0 (create did not land) → retries CREATE, then succeeds (C2)', async () => {
  let uploadCalls = 0;
  const run = async (args) => {
    if (args.includes('upload')) {
      uploadCalls++;
      // First two attempts return no id (page not yet visible); third succeeds
      if (uploadCalls < 3) return { status: 0, stdout: 'no id', stderr: '' };
      return { status: 0, stdout: `Page ID: ${GP_A}`, stderr: '' };
    }
    // env always empty → newIds===0 on each after-snapshot → proved not-landed → safe retry
    return { status: 0, stdout: envList([]), stderr: '' };
  };
  const r = await makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 3 })
    .upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' });
  assert.strictEqual(r.pageId, GP_A);
  assert.strictEqual(uploadCalls, 3, 'two proved-not-landed CREATEs + one successful CREATE');
});

test('upload uncertain-CREATE: enumerateEnv failure BEFORE CREATE → throws (fail-closed, no CREATE issued)', async () => {
  let uploadCalls = 0;
  const run = async (args) => {
    if (args.includes('upload')) { uploadCalls++; return { status: 0, stdout: `Page ID: ${GP_A}`, stderr: '' }; }
    return { status: 1, stdout: '', stderr: 'env-list failed' }; // before-snapshot always fails
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 2 })
      .upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' }),
    /cannot snapshot|refusing to (create|retry)/i
  );
  assert.strictEqual(uploadCalls, 0, 'no CREATE issued — halted at before-snapshot');
});

test('upload uncertain-CREATE: enumerateEnv failure DURING recovery (after-snapshot) → throws (fail-closed) (C2)', async () => {
  let listN = 0;
  const run = async (args) => {
    if (args.includes('upload')) return { status: 0, stdout: 'no id', stderr: '' }; // uncertain CREATE
    listN++;
    if (listN === 1) return { status: 0, stdout: envList([]), stderr: '' }; // before-snapshot succeeds
    return { status: 1, stdout: '', stderr: 'list failed' }; // after-snapshot fails → THROW
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {}, attempts: 2 })
      .upload({ appId: 'app', codeFile: 'o.tsx', name: 'Overview', prompt: 'p', agentMessage: 'm' }),
    /refusing to (retry|create)|enumeration failed/i
  );
});

// ── Task 2: download --page-id (by-id pull for sitemap membership) ───────────────────────────────

test('download passes --page-id <comma-joined> when pageIds provided; omits it otherwise (back-compat)', async () => {
  const downloadCalls = [];
  const run = async (args) => { if (args[2] === 'download') downloadCalls.push(args); return { status: 0, stdout: '', stderr: '' }; };
  const cli = makeGenpageCli('https://x', { run, sleep: async () => {} });

  await cli.download({ appId: 'a', outputDir: 'o', pageIds: [GP_A, GP_B] });
  await cli.download({ appId: 'a', outputDir: 'o' }); // no pageIds → all-pages

  const withIds = downloadCalls[0];
  const withoutIds = downloadCalls[1];
  const i = withIds.indexOf('--page-id');
  assert.ok(i > 0 && withIds[i + 1] === `${GP_A},${GP_B}`, 'ids comma-joined as a single --page-id arg');
  assert.ok(!withoutIds.includes('--page-id'), 'no --page-id when pageIds absent (all-pages back-compat)');
});

test('download passes --page-id for a single id (no trailing comma)', async () => {
  let seen;
  const run = async (args) => { if (args[2] === 'download') seen = args; return { status: 0, stdout: '', stderr: '' }; };
  await makeGenpageCli('https://x', { run, sleep: async () => {} }).download({ appId: 'a', outputDir: 'o', pageIds: [GP_A] });
  const i = seen.indexOf('--page-id');
  assert.ok(i > 0 && seen[i + 1] === GP_A, 'single id, no trailing comma');
});

// A nameless request still needs the id snapshot to detect a possible landed create, but it cannot
// corroborate the resulting candidate by name and must not turn it into an UPDATE.
test('a name-less uncertain create reports its candidate without retrying or updating it', async () => {
  const GP_NEW = '13ecbc57-a3a4-4132-b0a2-a6c6b12691e8';
  const seen = [];
  let uploads = 0;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      seen.push(args);
      if (args.includes('list')) {
        // Before the create: empty. After it: the page exists, so the create DID land.
        return { status: 0, stdout: uploads === 0 ? LIST_EMPTY : listText([{ pageId: GP_NEW, name: 'Whatever' }]), stderr: '' };
      }
      uploads += 1;
      // An UNCERTAIN result: zero exit, no Page ID. The create may or may not have landed.
      if (uploads === 1) return { status: 0, stdout: 'done', stderr: '' };
      return { status: 0, stdout: `Page ID: ${GP_NEW}`, stderr: '' };
    },
    sleep: async () => {},
  });
  await assert.rejects(cli.upload({ appId: 'a1', codeFile: 'p.tsx', prompt: 'p', agentMessage: 'm' }), (e) =>
    e.message.includes(GP_NEW) && /--page-id/.test(e.message));
  const uploadCalls = seen.filter((a) => a.includes('upload'));
  assert.strictEqual(uploadCalls.length, 1);
  assert.ok(!uploadCalls[0].includes('--page-id'), 'the first attempt is a create');
  assert.strictEqual(seen.filter((a) => a.includes('list')).length, 2, 'both id snapshots still run');
});

// --- #588.1: a page NAME must not be able to supply the list summary ----------------------------
// The count was matched anywhere in stdout, and pac prints names in a fixed-width table — so a page
// called "Found 1 generated page" made a listing with NO real summary line read as AUTHORITATIVE.
// An authoritative-looking but truncated listing is what drives a duplicate CREATE.
test('a page NAME cannot spoof the summary and make a truncated listing authoritative', () => {
  const spoof = [
    'Connected as tester@contoso.com',
    'Page ID                              Name                     Published',
    `${GUID} Found 1 generated page   Yes`,
  ].join('\n');
  const k = classifyListOutput(spoof);
  assert.strictEqual(k.kind, 'unrecognized',
    `a name-supplied count is not a summary; got ${JSON.stringify(k)}`);
  assert.deepStrictEqual(k.pages, [], 'an unrecognized listing yields no authoritative pages');
});

test('a REAL standalone summary line is still read (the fix must not break normal listings)', () => {
  const k = classifyListOutput(listText([{ pageId: GUID, name: 'Overview' }]));
  assert.strictEqual(k.kind, 'pages');
  assert.strictEqual(k.pages.length, 1);
  assert.strictEqual(parseListCount(LIST_EMPTY), 0, 'an explicit Found 0 is still read');
});

// --- #588.5: a page id is durable identity, so only a canonical GUID may become one --------------
// `[0-9a-fA-F-]{36}` accepted 36 characters from an alphabet containing `-`, so a row of dashes and
// any mis-grouped hex passed — and an OVERLONG token matched its first 36 characters, silently
// TRUNCATING a malformed id into a plausible one.
test('parsePageId REFUSES malformed and overlong ids instead of truncating them', () => {
  assert.strictEqual(parsePageId('Page ID: ------------------------------------'), null,
    'a run of dashes is 36 characters but not a GUID');
  assert.strictEqual(parsePageId('Page ID: 111111112222333344445555555555555555'), null,
    'ungrouped hex is not a canonical GUID');
  assert.strictEqual(parsePageId('Page ID: 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35f'), null,
    'an OVERLONG token must be refused, never trimmed to a valid-looking id');
  assert.strictEqual(parsePageId('Page ID: 6e0c28a2-cdbf-41ec-9186-d10fd5de6e3'), null,
    'a short token is refused too');
});

test('parsePageId still accepts a real id, in either case, with trailing output', () => {
  assert.strictEqual(parsePageId('Page ID: 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35'),
    '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35');
  assert.strictEqual(parsePageId('Page ID: 6E0C28A2-CDBF-41EC-9186-D10FD5DE6E35\nDone.'),
    '6E0C28A2-CDBF-41EC-9186-D10FD5DE6E35', 'pac may normalize GUID casing');
});

// A malformed id must not simply vanish: with no parsable identity the upload is UNCERTAIN, and the
// env-wide before/after diff must still run, so a candidate is reported rather than blindly retried.
test('a malformed Page ID drives uncertain-create reconciliation, not a blind retry', async () => {
  const seen = [];
  let uploads = 0;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      seen.push(args);
      if (args.includes('list')) {
        return { status: 0, stdout: uploads === 0 ? LIST_EMPTY : listText([{ pageId: GUID, name: 'N' }]), stderr: '' };
      }
      uploads += 1;
      // Zero exit, but the id is malformed — historically parsed and stored as identity.
      if (uploads === 1) return { status: 0, stdout: 'Page ID: ------------------------------------', stderr: '' };
      return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
    },
    sleep: async () => {},
    request: createdPage('N'),
  });
  await assert.rejects(cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' }), (e) => e.message.includes(GUID) && /--page-id/.test(e.message));
  const uploadCalls = seen.filter((a) => a.includes('upload'));
  assert.strictEqual(uploadCalls.length, 1, 'one create, no automatic adopted update');
});

// --- G4: keep the diagnostic pac produced, and do not retry a deterministic failure -------------
// CAPTURED VERBATIM from `pac model genpage download` with no --app-id. pac prints a banner, then
// the error, then a full help dump — so the LAST non-empty line is a flag description and the real
// cause sits in the middle. The wrapper used to report exactly that last line.
const REAL_PAC_ARG_FAILURE = [
  'Microsoft PowerPlatform CLI',
  'Version: 0.1.0-dev (.NET 10.0.12)',
  'Online documentation: https://aka.ms/PowerPlatformCLI',
  'Feedback, Suggestions, Issues: https://github.com/microsoft/powerplatform-build-tools/discussions',
  '',
  'Error: A required argument --app-id is missing.',
  '',
  'Usage: pac model genpage download [--environment] --app-id [--page-id] [--output-directory]',
  '',
  '  --environment               Specifies the target Dataverse. (alias: -env)',
  '  --app-id                    The ID of the model-driven app.',
  '  --output-directory          Directory to save pulled pages. (alias: -o)',
].join('\n');

test('a REAL pac failure banner reports the Error line, not the last help row', async () => {
  let thrown = null;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      if (args.includes('list')) return { status: 0, stdout: LIST_EMPTY, stderr: '' };
      return { status: 1, stdout: REAL_PAC_ARG_FAILURE, stderr: '' };
    },
    sleep: async () => {},
  });
  try { await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' }); }
  catch (e) { thrown = e; }
  assert.ok(thrown, 'the upload must fail');
  assert.match(thrown.message, /required argument --app-id is missing/,
    `the real cause must survive; got ${thrown.message}`);
  assert.ok(!/alias: -o/.test(thrown.message),
    `a help row must not be reported as the error; got ${thrown.message}`);
});

test('a deterministic failure is reported at once, not retried until the budget is spent', async () => {
  let uploadAttempts = 0;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      if (args.includes('list')) return { status: 0, stdout: LIST_EMPTY, stderr: '' };
      uploadAttempts += 1;
      return { status: 1, stdout: REAL_PAC_ARG_FAILURE, stderr: '' };
    },
    sleep: async () => {},
  });
  await assert.rejects(() => cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' }));
  assert.strictEqual(uploadAttempts, 1,
    `an argument fault cannot succeed on a retry; attempted ${uploadAttempts} times`);
});

// The retry budget still exists for what it was built for: transient service flakes.
test('a TRANSIENT failure is still retried and can succeed', async () => {
  let uploadAttempts = 0;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      if (args.includes('list')) {
        return { status: 0, stdout: uploadAttempts === 0 ? LIST_EMPTY : LIST_EMPTY, stderr: '' };
      }
      uploadAttempts += 1;
      if (uploadAttempts === 1) return { status: 1, stdout: '', stderr: 'The service is temporarily unavailable. Please try again.' };
      return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
    },
    sleep: async () => {},
  });
  const res = await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' });
  assert.strictEqual(res.pageId, GUID);
  assert.strictEqual(uploadAttempts, 2, 'a transient failure must still be retried');
});

// --- #588.6: a path ending in a separator must not swallow the flags that follow ----------------
// Windows command-line parsing treats `\"` as an ESCAPED QUOTE, so a directory argument ending in
// a backslash escaped its own closing quote. Captured from a real cmd.exe parse before the fix:
//   ["--output-directory", "C:\\Users\\Power User\\download\" --app-id after"]
// i.e. the path absorbed the rest of the command line and --app-id was never passed.
test('a trailing backslash is doubled so it cannot escape the closing quote', () => {
  // `String.raw` cannot be used here: a template literal may not END with a backslash, because it
  // escapes the closing backtick. Ordinary escapes it is.
  const dir = 'C:\\Users\\Power User\\download\\';
  const inv = buildPacInvocation(['model', 'genpage', 'download', '--output-directory', dir, '--app-id', 'after'], PAC_CMD);
  // The run before the closing quote is doubled; the following flag stays a separate argument.
  assert.match(inv.args[4], /--output-directory "C:\\Users\\Power User\\download\\\\" --app-id after"$/,
    `the trailing separator must be escaped; got ${inv.args[4]}`);
});

test('interior backslashes are left alone (every Windows path has them)', () => {
  const inv = buildPacInvocation(['model', 'genpage', 'download', '--output-directory', String.raw`C:\Users\Power User\download`], PAC_CMD);
  assert.match(inv.args[4], /"C:\\Users\\Power User\\download"/,
    `an ordinary path must round-trip unchanged; got ${inv.args[4]}`);
});

test('POSIX passes args verbatim, with no cmd-style quoting at all', () => {
  const dir = '/home/user/download\\';
  const inv = buildPacInvocation(['model', 'genpage', 'download', '--output-directory', dir], { platform: 'linux', env: { PATH: '/b' }, exists: () => true });
  assert.deepStrictEqual(inv.args, ['model', 'genpage', 'download', '--output-directory', dir],
    'the POSIX path spawns pac directly, so nothing may be rewritten');
});
// --- review follow-up: a TRANSIENT message must NOT be mistaken for a deterministic one --------
// The first version matched the bare phrases "does not exist" and "could not be found", so a
// service message like "The resource does not exist yet; please retry." aborted the retry loop —
// losing a retry that would have SUCCEEDED. A lost retry fails a build; a needless retry costs
// about a second, and that asymmetry is what decides the trade.
const runRetryCase = async (stderr) => {
  let attempts = 0;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      if (args.includes('list')) return { status: 0, stdout: LIST_EMPTY, stderr: '' };
      attempts += 1;
      return { status: 1, stdout: '', stderr };
    },
    sleep: async () => {},
  });
  try { await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' }); } catch { /* expected */ }
  return attempts;
};

test('a transient message containing "does not exist" is still RETRIED', async () => {
  for (const msg of [
    'The resource does not exist yet; please retry.',
    'Error: The specified environment does not exist.',
    'Error: The app module could not be found.',
    'The service is temporarily unavailable. Please try again.',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const attempts = await runRetryCase(msg);
    assert.strictEqual(attempts, 3, `"${msg}" must be retried; attempted ${attempts} time(s)`);
  }
});

// The real pac wording for a missing file, MEASURED, carries argument AND file context — which is
// what makes it unambiguously deterministic where a bare phrase is not.
test('a REAL pac argument/file fault is still short-circuited', async () => {
  for (const msg of [
    'Error: A required argument --app-id is missing.',
    "Error: The value passed to '--code-file' is invalid. The file 'D:\\nope\\absent.tsx' could not be found.",
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const attempts = await runRetryCase(msg);
    assert.strictEqual(attempts, 1, `"${msg}" cannot succeed on a retry; attempted ${attempts} time(s)`);
  }
});

// --- review follow-up: the diagnostic fallback must not report only the banner -----------------
// `FLAG_HELP_RE` drops the help dump, but pac can print the ONLY diagnostic in that same indented
// shape. With no `Error:` line, the filtered set was empty and the fallback took the FIRST four
// lines — the banner — discarding the one line that said anything.
test('a flag-SHAPED sole diagnostic survives instead of being replaced by the banner', async () => {
  const out = [
    'Microsoft PowerPlatform CLI',
    'Version: 0.1.0-dev (.NET 10.0.12)',
    'Online documentation: https://aka.ms/PowerPlatformCLI',
    'Feedback, Suggestions, Issues: https://github.com/microsoft/powerplatform-build-tools/discussions',
    '  --output-directory does not exist: C:\\missing',
  ].join('\n');
  let thrown = null;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com/', {
    run: async (args) => {
      if (args.includes('list')) return { status: 0, stdout: LIST_EMPTY, stderr: '' };
      return { status: 1, stdout: out, stderr: '' };
    },
    sleep: async () => {},
  });
  try { await cli.upload({ appId: 'a1', codeFile: 'p.tsx', name: 'N', prompt: 'p', agentMessage: 'm' }); }
  catch (e) { thrown = e; }
  assert.ok(thrown);
  assert.match(thrown.message, /output-directory does not exist/,
    `the only real line must survive; got ${thrown.message}`);
  assert.ok(!/Microsoft PowerPlatform CLI/.test(thrown.message),
    `the banner must not be reported as the diagnostic; got ${thrown.message}`);
});

// --- review follow-up: both boundaries were the wrong SHAPE, not just missing ------------------

// The trailing boundary only rejected the GUID alphabet, so a suffix starting with any other
// character passed the lookahead and the id was accepted with the rest silently dropped. This
// value becomes DURABLE page identity, so a truncated id is a wrong-page write later.
test('parsePageId refuses a GUID followed by any identifier character, not just hex', () => {
  const G = '6e0c28a2-cdbf-41ec-9186-d10fd5de6e35';
  assert.strictEqual(parsePageId(`Page ID: ${G}`), G, 'the control: a clean id still parses');
  for (const suffix of ['oops', 'f', '-', '_x', '0', 'Z']) {
    assert.strictEqual(parsePageId(`Page ID: ${G}${suffix}`), null,
      `a token continuing with ${JSON.stringify(suffix)} must be refused, not trimmed to the GUID`);
  }
  // ...but punctuation genuinely ENDS the token — pac prints the id inside prose.
  assert.strictEqual(parsePageId(`Page ID: ${G}東京`), null,
    'a Unicode letter continues the token and must not be silently dropped');
  for (const suffix of ['.', ',', ')', ' ', '\n']) {
    assert.strictEqual(parsePageId(`Page ID: ${G}${suffix}`), G,
      `${JSON.stringify(suffix)} terminates the id and must still parse`);
  }
});

// Anchoring the START defeated the table-row spoof, but with the line END unconstrained a name
// that merely BEGAN with the summary text was accepted just the same — and a listing that looks
// authoritative but is truncated is exactly what drives a duplicate CREATE.
test('parseListCount requires the WHOLE line to be the summary, not just its start', () => {
  assert.strictEqual(parseListCount('Found 3 generated page(s):'), 3, 'the live-captured form still parses');
  assert.strictEqual(parseListCount('Found 0 generated page(s):'), 0);
  for (const bad of [
    'Found 1 generated pagex',
    'Found 1 generated page(s) extra',
    'Found 1 generated page(s): and then some',
  ]) {
    assert.strictEqual(parseListCount(bad), null,
      `${JSON.stringify(bad)} is not the summary grammar and must not supply a count`);
  }
});

// And the whole point: an unparsable summary must make the listing UNRECOGNIZED, never "empty" —
// "empty" is what authorises a create.
test('a malformed summary line makes the listing unrecognized, not empty', () => {
  const out = 'Connected as tester@contoso.com\nRetrieving generated pages...\nFound 0 generated pagex\n';
  assert.strictEqual(classifyListOutput(out).kind, 'unrecognized',
    'a summary that does not parse must fail closed');
});

// --- review follow-up: the retry guard was keyed on the wrong condition ------------------------
// "Stop retrying a deterministic failure" was gated on `!pid`, i.e. only on a CREATE. An ordinary
// update — where the caller supplies `pageId`, so `pid` is truthy from the first attempt — sat
// through every attempt on a fault that can never resolve itself, burying the real message under
// "after 3 attempt(s)". The correct test is whether the NEXT attempt runs the SAME command.
test('a deterministic failure on an ORDINARY update stops after one attempt, as an ordinary error: pac refused it before it sent anything', async () => {
  let attempts = 0;
  const run = async () => {
    attempts += 1;
    // Real pac wording for an argument fault — retrying cannot change the outcome.
    return { status: 1, stdout: '', stderr: "Error: The value passed to '--code-file' is invalid. The file 'o.tsx' could not be found." };
  };
  const error = await makeGenpageCli('https://x', { run, sleep: async () => {} })
    .upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }).then(() => null, (e) => e);
  assert.match(String(error && error.message), /^pac genpage upload failed for 'Overview': Error: The value passed to '--code-file' is invalid/);
  assert.doesNotMatch(error.message, /MAY HAVE LANDED/, 'pac checks its arguments before it sends anything, so nothing can have landed');
  assert.notStrictEqual(error.transient, false);
  assert.strictEqual(attempts, 1,
    `a deterministic UPDATE fault must not be retried; ran ${attempts} attempt(s)`);
});

// The control: a failure that is NOT about pac's arguments — a service message that invites a retry — is no proof that nothing was written (pac can fail in the
// publish, after the page and its messages are written), so an update is not sent again for it either: it is told as one that may have landed. Only a CREATE that
// failed outright and left nothing in the listing is retried.
test('a transient-looking failure on an ordinary update is not retried: it is reported as one that may have landed', async () => {
  let attempts = 0;
  const run = async () => {
    attempts += 1;
    return { status: 1, stdout: '', stderr: 'Error: The service is temporarily unavailable. Please try again.' };
  };
  await assert.rejects(
    makeGenpageCli('https://x', { run, sleep: async () => {} })
      .upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }),
    /failed \(Error: The service is temporarily unavailable\. Please try again\.\) — the UPDATE of page [^ ]+ MAY HAVE LANDED/);
  assert.strictEqual(attempts, 1,
    `a failed UPDATE must not be sent again; ran ${attempts} attempt(s)`);
});

// Even a deterministic-looking failure can leave a row, but its id does not authorize another mutation.
test('a deterministic-looking uncertain CREATE reports its candidate and stops', async () => {
  const uploads = [];
  let listN = 0;
  const run = async (args) => {
    if (args[2] === 'list') {
      listN += 1;
      // before the create: empty; after it: the page exists — the create DID land.
      return { status: 0, stdout: listN === 1 ? LIST_EMPTY : listText([{ pageId: GUID, name: 'Overview' }]), stderr: '' };
    }
    uploads.push(args);
    return uploads.length === 1
      ? { status: 1, stdout: '', stderr: "Error: The value passed to '--code-file' is invalid. The file 'o.tsx' could not be found." }
      : { status: 0, stdout: `Successfully pushed page. Page ID: ${GUID}`, stderr: '' };
  };
  await assert.rejects(makeGenpageCli('https://x', { run, sleep: async () => {}, request: createdPage() })
    .upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }), (e) => e.message.includes(GUID) && /--page-id/.test(e.message));
  assert.strictEqual(uploads.length, 1, 'the uncertain create is the only mutation');
  assert.ok(!uploads[0].includes('--page-id'), 'the first attempt was the create');
});


test('enumeratePages can include unpublished app-scoped pages without changing the default enumerate call', async () => {
  const seen = [];
  const run = async (args) => { seen.push(args); return { status: 0, stdout: LIST_ONE, stderr: '' }; };
  const cli = makeGenpageCli('https://x', { run, sleep: async () => {} });
  await cli.enumerate({ appId: 'app-1' });
  await cli.enumeratePages('app-1', { includeUnpublished: true });

  assert.ok(seen[0].includes('--app-id') && seen[0].includes('app-1'), 'default enumerate stays app-scoped');
  assert.ok(!seen[0].includes('--include-unpublished'), 'default enumerate call is unchanged for existing callers');
  assert.ok(seen[1].includes('--app-id') && seen[1].includes('app-1'), 'option still combines with --app-id');
  assert.ok(seen[1].includes('--include-unpublished'), 'the requested option reaches pac argv');
});

// ── A pac call has a time limit ──────────────────────────────────────────────────────────────────────────────────────────────────
// A page upload once stalled — no CPU, no network — for 17 minutes, until the process was killed by hand. So a pac call waits a bounded time, ends the WHOLE
// process tree when it runs out, and reports `{ status: null, timedOut: true }`, which no exit code is, so a caller can tell a stalled call from a failed one.
// What each caller does about it follows from what the call can have done before it was stopped (pac's upload writes the page, records its prompt and agent message,
// prints `Page ID`, then publishes):
//   list, download    read only                                              → retried once
//   upload (UPDATE)   may have landed, or be landing                         → NOT retried: a second send can record the prompt twice and overwrite a later change; reported as one that may have landed
//   upload (CREATE)   may have been created, or still be being created       → an UNCERTAIN create: reported, and it is NEVER re-run; a Page ID already printed names the page it made
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: sleepMs } = require('node:timers/promises');
const { PAC_TIMEOUT_ENV } = require('../lib/cli-failure.js');

// The deadline of a pac call, in the test's hands: runPac arms it with the budget it was given, and `fire()` is the moment that time passes. No test here waits for a real timer.
function manualClock() {
  const clock = {
    callback: null,
    armedFor: null,
    setTimeout(callback, ms) { clock.callback = callback; clock.armedFor = ms; return clock; },
    clearTimeout() { clock.callback = null; },
    unref() { return clock; },
    get armed() { return clock.callback !== null; },
    fire() {
      const callback = clock.callback;
      assert.ok(callback, 'the deadline is armed');
      clock.callback = null;
      callback();
    },
  };
  return clock;
}
// A pac that is never going to finish by itself: pipes to write to, a pid, and nothing else happens until the test says so.
function stalledChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.unrefs = 0;
  child.unref = () => { child.unrefs += 1; };
  return child;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
// Waits for something that will happen, and ends the moment it does; the bound only turns a hang into a failure that says what never happened.
async function until(condition, what, limitMs = 60000) {
  const deadline = Date.now() + limitMs;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`${what} did not happen within ${limitMs}ms`);
    await sleepMs(10);
  }
}
const timedOutRun = (ms = 180000, command = 'pac model genpage list') => ({ status: null, timedOut: true, timeoutMs: ms, command, stdout: '', stderr: '' });

test('runPac gives up on a pac that never finishes: partial output kept, the tree killed once, and a result that says it timed out', async () => {
  const clock = manualClock();
  const child = stalledChild();
  const killed = [];
  const results = [];
  const call = runPac(['model', 'genpage', 'upload', '--code-file', 'a.tsx'], { timeoutMs: 600000, clock, spawn: () => child, killTree: (c) => killed.push(c) })
    .then((r) => { results.push(r); return r; });
  assert.strictEqual(clock.armedFor, 600000, 'armed with the budget it was given');
  child.stdout.write('Connected as tester\n');
  child.stderr.write('Warning: slow response\n');
  await settle();
  assert.strictEqual(results.length, 0, 'still waiting: a slow call is not a stalled one');
  clock.fire();
  const r = await call;
  assert.strictEqual(r.status, null, 'no exit code, because there was no exit');
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.timeoutMs, 600000);
  assert.strictEqual(r.command, 'pac model genpage upload');
  assert.strictEqual(r.stdout, 'Connected as tester\n', 'what pac printed before it stalled is kept');
  assert.match(r.stderr, /Warning: slow response/);
  assert.deepStrictEqual(killed, [child], 'the whole tree is ended, once');
  assert.ok(child.stdout.destroyed && child.stderr.destroyed, 'the pipes are released, so a survivor that holds them cannot keep this process alive');
  assert.ok(child.unrefs >= 1, 'and the child no longer holds the event loop open');
  // A child that closes, or fails, after its time was up cannot settle the call a second time or be killed again.
  child.emit('error', new Error('late failure'));
  child.emit('close', 0);
  await settle();
  assert.strictEqual(results.length, 1, 'resolved once');
  assert.strictEqual(results[0], r);
  assert.strictEqual(r.status, null, 'the result is unchanged by the late close');
  assert.strictEqual(killed.length, 1);
});

test('runPac leaves a call that ends in time alone: no kill, and the deadline is disarmed', async () => {
  const clock = manualClock();
  const child = stalledChild();
  const killed = [];
  const call = runPac(['model', 'genpage', 'list'], { timeoutMs: 60000, clock, spawn: () => child, killTree: (c) => killed.push(c) });
  child.stdout.write('Found 0 generated page(s):\n');
  child.stdout.end();
  child.stderr.end();
  await settle();
  child.emit('close', 0);
  const r = await call;
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, 'Found 0 generated page(s):\n');
  assert.strictEqual(r.timedOut, undefined, 'a result that did not time out does not say so');
  assert.strictEqual(clock.armed, false, 'a deadline left armed would kill a later reader of the same pipes');
  assert.deepStrictEqual(killed, []);
  // A non-zero exit is still just an exit code.
  const failing = stalledChild();
  const failed = runPac(['model', 'genpage', 'list'], { timeoutMs: 60000, clock: manualClock(), spawn: () => failing, killTree: () => assert.fail('nothing to kill') });
  failing.emit('close', 3);
  assert.strictEqual((await failed).status, 3);
});

test('runPac never arms a deadline for a pac that could not be started, and every pac call is bounded by default', async () => {
  const clock = manualClock();
  const r = await runPac(['model', 'genpage', 'list'], { timeoutMs: 600000, clock, spawn: () => { throw new Error('spawn pac ENOENT: not found on PATH'); }, killTree: () => assert.fail('nothing to kill') });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /ENOENT/);
  assert.strictEqual(r.timedOut, undefined);
  assert.strictEqual(clock.armed, false);
  // No budget given: the read budget applies, so no call is ever unbounded.
  const unbounded = manualClock();
  const child = stalledChild();
  const call = runPac(['model', 'genpage', 'list'], { clock: unbounded, spawn: () => child, killTree: () => {} });
  assert.strictEqual(unbounded.armedFor, 180000);
  child.emit('close', 0);
  await call;
});

// The real thing, because a stub that "kills" a fake proves only what its author believed. On Windows pac is a `pac.cmd` shim, so the tree is
// cmd.exe → node (the stalled pac) → node (a process it started): ending the shim alone would leave the other two running. Each of the two writes a
// heartbeat file every 50 ms; a process that is gone stops writing — which, unlike asking whether a pid exists, cannot be fooled by a zombie or a reused pid.
function makeHangingPac() {
  const dir = scratch('genpage-cli-hangingpac-');
  const script = path.join(dir, 'hanging-pac.js');
  // Both processes end by themselves after a minute, so a run in which the kill failed (or never came) leaves nothing running on the machine.
  fs.writeFileSync(script, [
    "const fs = require('fs');",
    "const base = process.argv[process.argv.indexOf('--hang') + 1];",
    "const beat = \"const fs = require('fs'); setTimeout(() => process.exit(0), 60000); setInterval(() => fs.writeFileSync(process.argv[1], String(process.hrtime.bigint())), 50);\";",
    "require('child_process').spawn(process.execPath, ['-e', beat, base + '.grandchild'], { stdio: 'ignore', windowsHide: true });",
    'setTimeout(() => process.exit(0), 60000);',
    "setInterval(() => fs.writeFileSync(base + '.pac', String(process.hrtime.bigint())), 50);",
    '',
  ].join('\n'), 'utf8');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'pac.cmd'), `@"${process.execPath}" "${script}" %*\r\n`, 'utf8');
  } else {
    fs.writeFileSync(path.join(dir, 'pac'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  return dir;
}
const readBeat = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

test('runPac: a real stalled pac, and the process it started, are both ended when the time is up', async () => {
  const dir = makeHangingPac();
  const base = path.join(scratch('genpage-cli-beats-'), 'beat');
  const files = [`${base}.pac`, `${base}.grandchild`];
  const clock = manualClock();
  const result = await withPathFirst(dir, async () => {
    const call = runPac(['model', 'genpage', 'upload', '--hang', base], { timeoutMs: 600000, clock });
    // Both are running — each has beaten at least twice — before the deadline passes, so what is ended below is two live processes, however slow this machine is.
    const firstSeen = files.map(() => null);
    await until(() => files.every((file, i) => {
      const beat = readBeat(file);
      if (beat !== null && firstSeen[i] === null) firstSeen[i] = beat;
      return beat !== null && beat !== firstSeen[i];
    }), 'the stalled pac and the process under it starting');
    clock.fire();
    return call;
  });
  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.status, null);
  await sleepMs(300); // a beat already in flight lands
  const after = files.map(readBeat);
  await sleepMs(500); // ten beats of a live process
  assert.deepStrictEqual(files.map(readBeat), after, 'neither the stalled pac nor the process under it is still running');
});

// ── What the callers do with a timeout ───────────────────────────────────────────────────────────────────────────────────────────

test('every pac call gets the budget of its kind: 3 min to list or download, 10 min to upload, or the environment override', async () => {
  const seen = [];
  const run = async (args, options) => {
    seen.push([args[2], options && options.timeoutMs]);
    if (args[2] === 'list') return { status: 0, stdout: LIST_ONE, stderr: '' };
    return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' };
  };
  const exercise = async (processEnv) => {
    seen.length = 0;
    const cli = makeGenpageCli('https://x', { run, sleep: async () => {}, processEnv });
    await cli.enumerate({ appId: 'a' });
    await cli.enumeratePages('a', { includeUnpublished: true });
    await cli.enumerateEnv();
    await cli.list({ appId: 'a' });
    await cli.download({ appId: 'a', outputDir: 'out' });
    await cli.upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' });
    return seen.map(([kind, ms]) => `${kind}:${ms}`);
  };
  assert.deepStrictEqual(await exercise({}), ['list:180000', 'list:180000', 'list:180000', 'list:180000', 'download:180000', 'upload:600000']);
  assert.deepStrictEqual(await exercise({ [PAC_TIMEOUT_ENV]: '45000' }), ['list:45000', 'list:45000', 'list:45000', 'list:45000', 'download:45000', 'upload:45000']);
  assert.deepStrictEqual(await exercise({ [PAC_TIMEOUT_ENV]: 'soon' }), ['list:180000', 'list:180000', 'list:180000', 'list:180000', 'download:180000', 'upload:600000'], 'an unusable value keeps the defaults');
});

test('a listing that times out is retried once, then reported as a timeout — never as an empty app or environment', async () => {
  const calls = {
    enumerate: (cli) => cli.enumerate({ appId: 'app-1' }),
    enumeratePages: (cli) => cli.enumeratePages('app-1', { includeUnpublished: true }),
    enumerateEnv: (cli) => cli.enumerateEnv(),
  };
  for (const [name, call] of Object.entries(calls)) {
    let n = 0;
    const recovers = makeGenpageCli('env', { run: async () => { n += 1; return n === 1 ? timedOutRun() : { status: 0, stdout: LIST_ONE, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
    const ok = await call(recovers);
    assert.strictEqual(ok.ok, true, `${name}: the retry reads the listing`);
    assert.strictEqual(n, 2, `${name}: one retry`);

    n = 0;
    const stalls = makeGenpageCli('env', { run: async () => { n += 1; return timedOutRun(); }, sleep: async () => {}, attempts: 3 });
    const r = await call(stalls);
    assert.strictEqual(r.ok, false, `${name}: a listing that never answers is not an empty one`);
    assert.strictEqual(n, 2, `${name}: it stops after the second timeout, though the ordinary budget is three attempts`);
    assert.match(r.error, /failed after 2 attempt\(s\): `pac model genpage list` did not finish within 180 s and was stopped/, name);
    assert.match(r.error, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS=/, `${name}: and says how to allow it longer`);
    assert.doesNotMatch(r.error, /null/, `${name}: no "exited null"`);
  }
  // Ordinary failures keep the ordinary budget, and a timeout among them counts once.
  let n = 0;
  const mixed = makeGenpageCli('env', { run: async () => { n += 1; return n === 1 ? timedOutRun() : n === 2 ? { status: 1, stdout: '', stderr: 'flake' } : { status: 0, stdout: LIST_ONE, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  assert.strictEqual((await mixed.enumerateEnv()).ok, true);
  assert.strictEqual(n, 3);
});

test('a download that times out is retried once with the same arguments; any other failure is still reported at once', async () => {
  const seen = [];
  let n = 0;
  const recovers = makeGenpageCli('env', { run: async (args) => { seen.push(args); n += 1; return n === 1 ? timedOutRun(180000, 'pac model genpage download') : { status: 0, stdout: '', stderr: '' }; }, sleep: async () => {} });
  assert.strictEqual(await recovers.download({ appId: 'app-1', outputDir: 'out', pageIds: [GP_A] }), true);
  assert.strictEqual(seen.length, 2);
  assert.deepStrictEqual(seen[1], seen[0], 'a read is repeated exactly');

  n = 0;
  const stalls = makeGenpageCli('env', { run: async () => { n += 1; return timedOutRun(180000, 'pac model genpage download'); }, sleep: async () => {} });
  await assert.rejects(stalls.download({ appId: 'app-1', outputDir: 'out' }), /pac genpage download failed: `pac model genpage download` did not finish within 180 s and was stopped/);
  assert.strictEqual(n, 2, 'one retry, then the timeout is reported');

  n = 0;
  const fails = makeGenpageCli('env', { run: async () => { n += 1; return { status: 1, stdout: '', stderr: 'Error: boom' }; }, sleep: async () => {} });
  await assert.rejects(fails.download({ appId: 'app-1', outputDir: 'out' }), /pac genpage download failed: Error: boom/);
  assert.strictEqual(n, 1, 'an ordinary failure is not retried, as before');
});

// An UPDATE names the page it writes (`--page-id`), but a second send is not harmless for that: pac writes the page, records the prompt and the agent message in two separate
// requests, prints `Page ID`, then publishes — so a call stalled in the publish has already written everything, and a re-send records the prompt twice and goes out minutes after
// the caller's own checks, overwriting whatever the maker saved meanwhile. So it is reported, with what to look at, and the caller's own guards decide a re-run.
test('an UPDATE that times out is NOT sent again: it is reported as one that may have landed, with the check to run before anything is re-run', async () => {
  const seen = [];
  const run = async (args) => { seen.push(args); return seen.length === 1 ? timedOutRun(600000, 'pac model genpage upload') : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; };
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run, sleep: async () => {}, attempts: 3 });
  await assert.rejects(cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'out/overview.tsx', name: 'Overview' }), (e) => {
    assert.match(e.message, /^pac genpage upload for 'Overview' timed out after 600 s and was stopped — the UPDATE of page 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 MAY HAVE LANDED: /);
    assert.match(e.message, /pac writes the page, then records the prompt and the agent message, then publishes/, 'what it may have got through');
    assert.match(e.message, /It was NOT sent again: a second send can record the prompt twice, and would overwrite a change made to the page since\./);
    assert.match(e.message, /genpage-base\.js check --env https:\/\/contoso\.crm\.dynamics\.com --app-id app-1 --page-id 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 --file out\/overview\.tsx/, 'the check to run, with this call\'s own values');
    assert.match(e.message, /"contentSame": true means the update landed; "deployed": "unchanged" means it did not/);
    assert.match(e.message, /re-run the upload: its own checks decide whether it may go ahead\./);
    assert.match(e.message, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS=1200000 allows a slow upload longer\./);
    assert.doesNotMatch(e.message, /retry\b/i, 'a stalled upload is not told to "retry"');
    return true;
  });
  assert.strictEqual(seen.length, 1, 'one send, though the ordinary budget is three attempts: it is not run a second time, and nothing is listed or snapshotted around it');
  assert.strictEqual(seen[0][2], 'upload');
  assert.ok(seen[0].includes('--page-id') && seen[0].includes(GUID));
  // An update that FAILED is not sent again either (the tests of a failed UPDATE below): only how it is told differs.
  let n = 0;
  const flaky = makeGenpageCli('https://x', { run: async () => { n += 1; return n === 1 ? { status: 1, stdout: '', stderr: 'flaky' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }, sleep: async () => {} });
  await assert.rejects(flaky.upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }), /failed \(flaky\) — the UPDATE of page [^ ]+ MAY HAVE LANDED/);
  assert.strictEqual(n, 1, 'a failure that is not a timeout is not sent again either');
});

test('an UPDATE that timed out after pac printed the Page ID says the page was written and the stall came while it published; at the longest budget no longer one is offered', async () => {
  const run = async () => ({ ...timedOutRun(3600000, 'pac model genpage upload'), stdout: `Connected as tester@contoso.com\r\nUploading page...\r\nPage ID: ${GUID}\r\n` });
  await assert.rejects(makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }), (e) => {
    assert.match(e.message, /MAY HAVE LANDED: pac had printed the Page ID, which it does once the page and its messages are written, so the stall came while it was publishing\./);
    assert.doesNotMatch(e.message, /pac writes the page, then records/, 'the general account is replaced by the specific one');
    assert.match(e.message, /It was NOT sent again/);
    assert.doesNotMatch(e.message, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS/, 'at the longest budget there is no longer one to suggest');
    return true;
  });
  // A Page ID cut off mid-token is not one.
  const cut = async () => ({ ...timedOutRun(600000, 'pac model genpage upload'), stdout: 'Page ID: 6e0c28a2-cdbf-41ec-91' });
  await assert.rejects(makeGenpageCli('https://x', { run: cut, sleep: async () => {} }).upload({ appId: 'a', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }), /pac writes the page, then records the prompt/);
});

// The check is a command the user — or the agent — pastes, so a code file under a folder with a space in its name (a Windows profile folder is often one) has to stay one
// argument in it, and a path with shell syntax in it (an untrusted checkout) must not run any of it: such a path is single-quoted, and one no shell can be given unchanged
// (a quote or a line break in it, say) is not written into the command at all — a placeholder is, and the path is named as data.
test('the check an UPDATE that timed out points to is a whole command, and keeps a code file path one literal argument — or names it outside the command', async () => {
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run: async () => timedOutRun(600000, 'pac model genpage upload'), sleep: async () => {} });
  await assert.rejects(cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'C:\\Users\\Dev User\\pages\\overview.tsx', name: 'Overview' }), (e) => {
    assert.match(e.message, /First see what is deployed: node scripts\/genpage-base\.js check --env https:\/\/contoso\.crm\.dynamics\.com --app-id app-1 --page-id 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 --file 'C:\\Users\\Dev User\\pages\\overview\.tsx' \("contentSame"/);
    return true;
  });
  await assert.rejects(cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'out/overview.tsx', name: 'Overview' }), /--file out\/overview\.tsx \("contentSame"/, 'a plain path is shown as it is');
  await assert.rejects(cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'pages/x;rm -rf ~;$(curl e.vil).tsx', name: 'Overview' }), (e) => {
    assert.ok(e.message.includes("--file 'pages/x;rm -rf ~;$(curl e.vil).tsx' (\"contentSame\""), 'shell syntax in a path stays inside single quotes');
    return true;
  });
  await assert.rejects(cli.upload({ appId: 'app-1', pageId: GUID, codeFile: "pages/it's;echo x.tsx", name: 'Overview' }), (e) => {
    assert.ok(e.message.includes('--file <file> ("contentSame"'), 'a path with a quote is not written into the command');
    assert.ok(e.message.includes('<file> is "pages/it\'s;echo x.tsx"; it is not written into the command because no way of writing it reaches the command unchanged in both PowerShell and a POSIX shell. Then re-run the upload'), e.message);
    assert.ok(!e.message.includes("--file 'pages/it"), 'never as an argument');
    return true;
  });
  await assert.rejects(cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'pages/x"y.tsx', name: 'Overview' }), (e) => {
    assert.ok(e.message.includes('--file <file> ("contentSame"'), 'Windows PowerShell would drop the double quote on its way to node');
    assert.ok(e.message.includes('<file> is "pages/x\\"y.tsx"; it is not written into the command'), e.message);
    return true;
  });
});

// The upload script sends pac a COPY of the bytes it checked (removed once pac answers) and passes the file the caller named as `sourceFile`: the check the message points to is
// about that file — the one its base marker belongs to — never the copy, which is gone by the time anyone reads the message.
test('the check an UPDATE that timed out points to names the caller\'s file (sourceFile), never the copy pac read', async () => {
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run: async () => timedOutRun(600000, 'pac model genpage upload'), sleep: async () => {} });
  const copy = 'C:\\Users\\Dev User\\AppData\\Local\\Temp\\genpage-code-x1y2z3\\overview.tsx';
  await assert.rejects(cli.upload({ appId: 'app-1', pageId: GUID, codeFile: copy, sourceFile: 'C:\\Users\\Dev User\\pages\\overview.tsx', name: 'Overview' }), (e) => {
    assert.match(e.message, /--file 'C:\\Users\\Dev User\\pages\\overview\.tsx' \("contentSame"/);
    assert.ok(!e.message.includes('genpage-code-'), 'the copy is not named');
    return true;
  });
});

// The build is a different caller: it writes no base marker, so `genpage-base.js check` could only answer "unknown" about what is deployed, and the code file it hands pac — for
// every page — is a STAGING copy that the build deletes when it ends, so the command the standalone script is told to run fails on a missing file. The build's message sends the reader
// to the deployed page through the download the build already uses, and says what running the build again does (sdk-build.js passes `caller: 'build'`).
test('an UPDATE that times out under the BUILD is told to read the deployed page with pac\'s download and to run the build again — never to check a file the build deletes', async () => {
  const seen = [];
  const run = async (args) => { seen.push(args); return seen.length === 1 ? timedOutRun(600000, 'pac model genpage upload') : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; };
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run, sleep: async () => {}, attempts: 3 });
  const staging = 'C:\\Users\\Dev User\\crm\\.maker-workspace\\.pageref-deploy\\0c9b6f1e\\overview.tsx';
  await assert.rejects(cli.upload({ appId: 'app-1', pageId: GUID, codeFile: staging, name: 'Overview', caller: 'build' }), (e) => {
    assert.match(e.message, /^pac genpage upload for 'Overview' timed out after 600 s and was stopped — the UPDATE of page 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 MAY HAVE LANDED: /);
    assert.match(e.message, /pac writes the page, then records the prompt and the agent message, then publishes/, 'what it may have got through is still said');
    assert.match(e.message, /It was NOT sent again: a second send can record the prompt twice, and would overwrite a change made to the page since\./);
    assert.match(e.message, /First see what is deployed: pac model genpage download --environment https:\/\/contoso\.crm\.dynamics\.com --app-id app-1 --page-id 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 --output-directory <folder>, then read the page\.tsx in the folder under <folder> that is named for the page id \(pac writes the id in its own letter case, so look for it without regard to case; /);
    // pac names the downloaded folder with ITS casing of the id, which need not be the one the caller typed (genpage-base.js findDownloadedPageDir), so no path is built from the id as it was typed.
    assert.doesNotMatch(e.message, /<folder>[\\/]6e0c28a2/, 'no path spelled with the id as typed: on a case-sensitive file system it can name a folder that is not there');
    assert.match(e.message, /a page that links to another shows that page's id where its source in the app folder has a PAGEREF_ name/);
    assert.match(e.message, /Then run the build again: it sends this page once more, to the same page id, so nothing new is created — but if the stalled send did land, the page's history now records its prompt a second time, and anything saved to the page in Maker since is replaced by the app folder's version\. Look first if either matters\./);
    assert.match(e.message, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS=1200000 allows a slow upload longer\./);
    // Nothing the build cannot support: no check on a file it deletes, no base marker it never wrote, no upload script to re-run.
    assert.doesNotMatch(e.message, /genpage-base\.js|contentSame|"deployed"|base marker|re-run the upload|its own checks decide/);
    assert.ok(!e.message.includes(staging) && !e.message.includes('.pageref-deploy'), 'the staging copy is not named');
    assert.doesNotMatch(e.message, /retry\b/i, 'a stalled upload is not told to "retry"');
    assert.strictEqual(e.transient, false, 'marked so that nothing retries it');
    return true;
  });
  assert.strictEqual(seen.length, 1, 'one send, as for any caller: it is not sent again');
  assert.strictEqual(seen[0][2], 'upload');
  // The advice's command is whole: the download it names takes exactly the arguments the wrapper's own download passes.
  const download = [];
  await makeGenpageCli('https://contoso.crm.dynamics.com', { run: async (args) => { download.push(args); return { status: 0, stdout: '', stderr: '' }; }, sleep: async () => {} }).download({ appId: 'app-1', outputDir: '<folder>', pageIds: [GUID] });
  assert.deepStrictEqual(download[0].slice(0, 3), ['model', 'genpage', 'download']);
  for (const part of ['--environment', 'https://contoso.crm.dynamics.com', '--app-id', 'app-1', '--page-id', GUID, '--output-directory']) assert.ok(download[0].includes(part), part);
  // Any other caller — the upload script, which names no caller — keeps the check against its code file and the re-run through its own guards.
  for (const caller of [undefined, 'upload', 'other']) {
    await assert.rejects(makeGenpageCli('https://x', { run: async () => timedOutRun(600000, 'pac model genpage upload'), sleep: async () => {} }).upload({ appId: 'a', pageId: GUID, codeFile: 'out/p.tsx', name: 'N', caller }),
      /First see what is deployed: node scripts\/genpage-base\.js check --env https:\/\/x --app-id a --page-id [^ ]+ --file out\/p\.tsx[\s\S]*Then re-run the upload: its own checks decide whether it may go ahead\./, String(caller));
  }
});

// A stalled upload must never be sent again by anything — and the build has a retry of its own for a halt it judges transient (isTransientHalt, build-model-app.js), which would be a re-send.
// Neither message may read as transient, with or without the marker the error carries.
test('the message of an UPDATE that timed out is not one the build retries, for either caller', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const { BuildHalt } = require('../lib/entity-provision.js');
  for (const caller of ['build', undefined]) {
    const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run: async () => timedOutRun(600000, 'pac model genpage upload'), sleep: async () => {} });
    const error = await cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'out/overview.tsx', name: 'Overview', caller }).then(() => null, (e) => e);
    assert.ok(error, String(caller));
    // The way the build reports it: wrapped by the runner, with the error as its cause.
    assert.strictEqual(isTransientHalt(new BuildHalt(`pages failed: ${error.message}`, { phase: 'pages', code: 'sdk-error', cause: error })), false, `${String(caller)}: wrapped`);
    // The words alone, as an error that does not carry the marker.
    assert.strictEqual(isTransientHalt(new Error(error.message)), false, `${String(caller)}: the text itself`);
  }
});

// An UPDATE that FAILS is in the same state as one that stalled: pac can fail in the publish, after it wrote the page and recorded the prompt and the agent message, so a
// second send records them again and can overwrite a change saved in between. It is not sent again, and is told as one that may have landed — what pac had printed says how far
// it got — with each caller's own look-first advice. An exit 0 with no Page ID is one too, whatever its words: pac said it succeeded. Only a non-zero exit for pac's own
// arguments or files is an ordinary failure (the deterministic tests above): pac checks those before it sends anything.
test('an UPDATE that FAILS is NOT sent again: it is reported as one that may have landed, with how far pac got and the check to run', async () => {
  const cases = [
    ['a non-zero exit', { status: 1, stdout: '', stderr: 'Error: Something went wrong.' },
      /^pac genpage upload for 'Overview' failed \(Error: Something went wrong\.\) — the UPDATE of page 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 MAY HAVE LANDED: pac writes the page, then records the prompt and the agent message, then publishes, so the failure can have come after any of those\. /],
    ['a non-zero exit after pac printed the Page ID', { status: 1, stdout: `Uploading page...\r\nPage ID: ${GUID}\r\nPublishing...\r\n`, stderr: 'Error: Publish failed.' },
      /failed \(Error: Publish failed\.\) — the UPDATE of page [^ ]+ MAY HAVE LANDED: pac had printed the Page ID, which it does once the page and its messages are written, so the failure came while it was publishing\. /],
    ['an exit 0 with no Page ID', { status: 0, stdout: 'Uploading page...\r\n', stderr: '' },
      /failed \(returned no Page ID: Uploading page\.\.\.\) — the UPDATE of page [^ ]+ MAY HAVE LANDED: pac writes the page/],
    ['an exit 0 with no Page ID, in words that read like a refused file', { status: 0, stdout: "Error: The file 'x.tsx' could not be found.\r\n", stderr: '' },
      /failed \(returned no Page ID: Error: The file 'x\.tsx' could not be found\.\) — the UPDATE of page [^ ]+ MAY HAVE LANDED/],
    // After the Page ID pac's only step is the publish, whose error carries the server's own text — which can read like a refused file. The Page ID proves the page and its
    // messages were written, so it is no refusal of pac's arguments, whatever the words.
    ['a non-zero exit after pac printed the Page ID, in words that read like a refused file', { status: 1, stdout: `Page ID: ${GUID}\r\n`, stderr: 'Error: Required file not found.' },
      /failed \(Error: Required file not found\.\) — the UPDATE of page [^ ]+ MAY HAVE LANDED: pac had printed the Page ID, which it does once the page and its messages are written, so the failure came while it was publishing\. /],
  ];
  for (const [what, result, wanted] of cases) {
    const seen = [];
    const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run: async (args) => { seen.push(args); return result; }, sleep: async () => {}, attempts: 3 });
    await assert.rejects(cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'tmp/copy/overview.tsx', sourceFile: 'out/overview.tsx', name: 'Overview' }), (e) => {
      assert.match(e.message, wanted, what);
      assert.match(e.message, /It was NOT sent again: a second send can record the prompt twice, and would overwrite a change made to the page since\./, what);
      assert.match(e.message, /First see what is deployed: node scripts\/genpage-base\.js check --env https:\/\/contoso\.crm\.dynamics\.com --app-id app-1 --page-id 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 --file out\/overview\.tsx /, `${what}: the caller's file, never the copy pac read`);
      assert.match(e.message, /Then re-run the upload: its own checks decide whether it may go ahead\.$/, what);
      assert.doesNotMatch(e.message, /PAC_TIMEOUT_MS|timed out/, `${what}: a failure is not a timeout, and no longer budget is offered`);
      assert.strictEqual(e.transient, false, what);
      return true;
    });
    assert.strictEqual(seen.length, 1, `${what}: one send, though the budget is three attempts`);
    assert.ok(seen[0].includes('--page-id') && seen[0].includes(GUID), what);
  }
  // Under the build: it keeps no base marker and deletes its staging copies, so it is told to read the deployed page with pac's download, and what a re-run of the build costs.
  const built = makeGenpageCli('https://x', { run: async () => ({ status: 1, stdout: '', stderr: 'Error: Something went wrong.' }), sleep: async () => {} });
  await assert.rejects(built.upload({ appId: 'a', pageId: GUID, codeFile: 'staging/p.tsx', name: 'Overview', caller: 'build' }), (e) => {
    assert.match(e.message, /First see what is deployed: pac model genpage download --environment https:\/\/x --app-id a --page-id 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 --output-directory <folder>/);
    assert.match(e.message, /Then run the build again: it sends this page once more, to the same page id, so nothing new is created — but if the failed send did land, the page's history now records its prompt a second time/);
    assert.doesNotMatch(e.message, /genpage-base\.js|re-run the upload/, 'no advice the build cannot follow');
    return true;
  });
});

// The same for every error that follows a CREATE that was sent. Their text quotes the page's name — user text, so a page called "SQL Timeouts" reads as a SQL timeout to the build's check of a transient
// halt — and, for a listing that failed, pac's own words ("… try again later"); a re-run of the build is a second create. Each carries `transient: false`, which that check reads on the error and on
// the halt that wraps it. The words alone DO read as transient (the control), so it is the marker that is tested.
test('every error that follows a CREATE that was sent is one the build never retries — whatever the page is called, whatever pac said', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const { BuildHalt } = require('../lib/entity-provision.js');
  const TRY_AGAIN_LATER = 'Error: The service is unavailable. Please try again later.';
  const stalled = (stdout = '') => ({ ...timedOutRun(600000, 'pac model genpage upload'), stdout });
  const failed = (stdout = '', stderr = 'Error: the upload failed') => ({ status: 1, stdout, stderr });
  const nothing = () => ({ status: 0, stdout: LIST_EMPTY, stderr: '' });
  const broken = () => ({ status: 1, stdout: '', stderr: TRY_AGAIN_LATER });
  const shows = (name) => ({ status: 0, stdout: listText([{ pageId: GUID, name }]), stderr: '' });
  const scenarios = [
    ['stalled, nothing visible yet', () => stalled(), nothing, /UNCERTAIN create/],
    ['stalled, the listing then fails with "try again later"', () => stalled(), broken, /env enumeration failed/],
    ['stalled, its page then shows up', () => stalled(), shows, /ambiguous ownership/],
    ['stalled after pac printed the Page ID', () => stalled(`Page ID: ${GUID}`), nothing, /CREATED the page as/],
    ['failed, the listing then fails with "try again later"', () => failed(), broken, /env enumeration failed/],
    ['failed, its page then shows up', () => failed(), shows, /ambiguous ownership/],
    ['failed after pac printed the Page ID, saying "try again later"', () => failed(`Page ID: ${GUID}`, TRY_AGAIN_LATER), nothing, /CREATED the page as/],
  ];
  let controls = 0;
  for (const pageName of ['SQL Timeouts', 'Concurrent Deletes', 'Overview']) {
    for (const [what, create, after, says] of scenarios) {
      const uploads = [];
      let lists = 0;
      const run = async (args) => {
        if (args[2] === 'list') { lists += 1; return lists === 1 ? { status: 0, stdout: LIST_EMPTY, stderr: '' } : after(pageName); }
        uploads.push(args);
        return create();
      };
      const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run, sleep: async () => {}, attempts: 3, request: createdPage(pageName) });
      const error = await cli.upload({ appId: 'app-1', codeFile: 'o.tsx', name: pageName }).then(() => null, (e) => e);
      const label = `${what}, page "${pageName}"`;
      assert.ok(error, label);
      assert.match(error.message, says, label);
      assert.strictEqual(uploads.length, 1, `${label}: one create`);
      assert.strictEqual(error.transient, false, `${label}: marked`);
      assert.strictEqual(isTransientHalt(error), false, `${label}: bare`);
      assert.strictEqual(isTransientHalt(new BuildHalt(`pages failed: ${error.message}`, { phase: 'pages', code: 'sdk-error', cause: error })), false, `${label}: as the runner wraps it`);
      // The words alone, with no marker: what the check would have made of them.
      if (isTransientHalt(new Error(error.message))) controls += 1;
    }
  }
  assert.ok(controls >= 10, `the marker is what stops the retry: without it ${controls} of these read as transient`);
  // Not a blanket: a listing that fails BEFORE any create was sent leaves nothing to duplicate, and stays an error the build may retry.
  const snapshotFails = makeGenpageCli('https://x', { run: async () => ({ status: 1, stdout: '', stderr: TRY_AGAIN_LATER }), sleep: async () => {}, attempts: 3 });
  const early = await snapshotFails.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }).then(() => null, (e) => e);
  assert.match(early.message, /cannot snapshot the environment before create/);
  assert.notStrictEqual(early.transient, false);
  assert.strictEqual(isTransientHalt(early), true);
});

// A run its caller ENDED (abort(), runPac's `signal`) says as little about what it did as one that timed out: pac may have written the page, may still be writing it, or may never have started.
// So an upload that ends that way is held to the same rule — told like a stalled one, never sent again by the client's own attempts, and never by the build's re-run of a halt that reads as
// transient — in the UPDATE branch and in every branch of an uncertain CREATE.
test('an upload whose run was ENDED is never sent again — an UPDATE, and a CREATE in every branch — and each error is one the build never retries', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const { BuildHalt } = require('../lib/entity-provision.js');
  const TRY_AGAIN_LATER = 'Error: The service is unavailable. Please try again later.';
  const ended = (stdout = '') => ({ status: 1, stdout, stderr: 'pac was ended: its answer is no longer needed', ended: true });
  const nothing = () => ({ status: 0, stdout: LIST_EMPTY, stderr: '' });
  const broken = () => ({ status: 1, stdout: '', stderr: TRY_AGAIN_LATER });
  const shows = (name) => ({ status: 0, stdout: listText([{ pageId: GUID, name }]), stderr: '' });
  const neverRetried = (error, label) => {
    assert.strictEqual(error.transient, false, `${label}: marked`);
    assert.strictEqual(isTransientHalt(error), false, `${label}: bare`);
    assert.strictEqual(isTransientHalt(new BuildHalt(`pages failed: ${error.message}`, { phase: 'pages', code: 'sdk-error', cause: error })), false, `${label}: as the runner wraps it`);
    assert.doesNotMatch(error.message, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS/, `${label}: a longer budget is no answer to a run that was ended, not stalled`);
  };

  // An UPDATE: one send, no pause for a second, and the error says it may have landed.
  const sent = [];
  const pauses = [];
  const update = makeGenpageCli('https://contoso.crm.dynamics.com', { run: async (args) => { sent.push(args); return ended(); }, sleep: async (ms) => { pauses.push(ms); }, attempts: 3 });
  const updateError = await update.upload({ appId: 'app-1', pageId: GUID, codeFile: 'o.tsx', name: 'Overview' }).then(() => null, (e) => e);
  assert.match(updateError.message, /^pac genpage upload failed for 'Overview': pac was ended: its answer is no longer needed — the UPDATE of page 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 may have landed before it was ended, and it was NOT sent again: look at the page before running it again$/);
  assert.strictEqual(sent.length, 1, 'one send, though the ordinary budget is three attempts');
  assert.deepStrictEqual(pauses, [], 'and no pause for an attempt that will not be made');
  neverRetried(updateError, 'an UPDATE that was ended');

  // A CREATE. Each scenario is what the environment answers after the create was ended: nothing yet, a listing that fails, a page that shows up, and a Page ID pac had already printed.
  const scenarios = [
    ['nothing visible yet', () => ended(), nothing, /was ended before it answered — an UNCERTAIN create: no new page is visible in the environment yet/],
    ['the listing then fails with "try again later"', () => ended(), broken, /was ended before it answered, and had an uncertain result and env enumeration failed/],
    ['its page then shows up', () => ended(), shows, /was ended before it answered, and had an uncertain create \(ambiguous ownership\)/],
    ['after pac printed the Page ID', () => ended(`Page ID: ${GUID}`), nothing, /failed after it had CREATED the page as 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35/],
  ];
  for (const pageName of ['SQL Timeouts', 'Overview']) {
    for (const [what, create, after, says] of scenarios) {
      const uploads = [];
      let lists = 0;
      const run = async (args) => {
        if (args[2] === 'list') { lists += 1; return lists === 1 ? { status: 0, stdout: LIST_EMPTY, stderr: '' } : after(pageName); }
        uploads.push(args);
        return create();
      };
      const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run, sleep: async () => {}, attempts: 3, request: createdPage(pageName) });
      const error = await cli.upload({ appId: 'app-1', codeFile: 'o.tsx', name: pageName }).then(() => null, (e) => e);
      const label = `${what}, page "${pageName}"`;
      assert.ok(error, label);
      assert.match(error.message, says, label);
      assert.strictEqual(uploads.length, 1, `${label}: one create, never a second`);
      neverRetried(error, label);
    }
  }

  // The contrast: a create that FAILED outright (not ended) and left nothing is still safe to run again.
  let creates = 0;
  const failed = makeGenpageCli('https://x', { run: async (args) => { if (args[2] === 'list') return nothing(); creates += 1; return creates === 1 ? { status: 1, stdout: '', stderr: 'flaky' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  assert.strictEqual((await failed.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' })).pageId, GUID);
  assert.strictEqual(creates, 2);
});

// An UPDATE is never paused between two attempts: one that failed is not sent again (the tests of a failed UPDATE above), so it is reported at once — and its error is one
// the build never retries, whatever the page is called and whatever pac said. The words alone DO read as transient (the control), so it is the marker that is tested.
test('an UPDATE that fails is never paused for or sent again, and its error is one the build never retries — whatever the page is called, whatever pac said', async () => {
  const { isTransientHalt } = require('../build-model-app.js');
  const { BuildHalt } = require('../lib/entity-provision.js');
  for (const caller of ['build', undefined]) {
    const runs = [];
    const pauses = [];
    const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run: async (args) => { runs.push(args); return { status: 1, stdout: '', stderr: 'Error: The service is busy, try again later.' }; }, sleep: async (ms) => { pauses.push(ms); }, attempts: 3 });
    const error = await cli.upload({ appId: 'app-1', pageId: GUID, codeFile: 'o.tsx', name: 'SQL Timeouts', caller }).then(() => null, (e) => e);
    assert.match(String(error && error.message), /^pac genpage upload for 'SQL Timeouts' failed \(Error: The service is busy, try again later\.\) — the UPDATE of page [^ ]+ MAY HAVE LANDED/, String(caller));
    assert.strictEqual(runs.length, 1, `${String(caller)}: one send`);
    assert.deepStrictEqual(pauses, [], `${String(caller)}: no pause for an attempt that will not be made`);
    assert.strictEqual(error.transient, false, String(caller));
    assert.strictEqual(isTransientHalt(error), false, String(caller));
    assert.strictEqual(isTransientHalt(new BuildHalt(`pages failed: ${error.message}`, { phase: 'pages', code: 'sdk-error', cause: error })), false, `${String(caller)}: wrapped`);
    assert.strictEqual(isTransientHalt(new Error(error.message)), true, `${String(caller)}: the control — the text alone reads as transient`);
  }
});

// A CREATE that timed out may have landed, may be landing, or may never have started. The env-wide id diff reports what is already visible; what is not visible YET
// proves nothing, because the service may still be working — so a timed-out create is never run again, whatever the diff shows. And what is said to do next must not be
// "update it" or "create it again" when the page the stalled create left behind is not in the app's navigation: an update of such a page is refused, a create duplicates it.
// `printed` is what pac had written to stdout when it was stopped; `lists` counts the environment listings made.
function createRun({ afterShows = [], uploads, listFails = false, printed = '', lists = { n: 0 } }) {
  return async (args) => {
    if (args[2] === 'list') {
      lists.n += 1;
      if (lists.n > 1 && listFails) return { status: 1, stdout: '', stderr: 'list failed' };
      return { status: 0, stdout: lists.n === 1 || !afterShows.length ? LIST_EMPTY : listText(afterShows), stderr: '' };
    }
    uploads.push(args);
    return { ...timedOutRun(600000, 'pac model genpage upload'), stdout: printed };
  };
}
const ADD_PAGE = (id, app = 'a') => new RegExp(`add page ${id} to the app's navigation — in Maker, or with \`pac model genpage add --environment https://x --app-id ${app} --page-id ${id} --publish\``);

test('a CREATE that times out is an uncertain create: its candidates are reported, and no create or update follows', async () => {
  const uploads = [];
  const cli = makeGenpageCli('https://x', { run: createRun({ afterShows: [{ pageId: GUID, name: 'Overview' }], uploads }), sleep: async () => {}, request: createdPage() });
  await assert.rejects(cli.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }), (e) => {
    assert.match(e.message, /timed out and was stopped, and had an uncertain create \(ambiguous ownership\)/);
    assert.ok(e.message.includes(`${GUID}: stored name "Overview"`));
    // A candidate that appeared after a stalled create is most likely not in the app's navigation, so the advice places it first — an update of it would be refused.
    assert.match(e.message, ADD_PAGE(GUID), 'it says how to place the page');
    assert.match(e.message, new RegExp(`re-run the upload as an update with --page-id ${GUID} \\(a build: set that page's pageId to ${GUID} in the App Spec\\); or delete page ${GUID} and re-run the create`));
    assert.match(e.message, /otherwise leave them and re-run the create\./, 'and a page that is not yours is left alone');
    assert.doesNotMatch(e.message, /If it is yours, re-run the upload as an update/, 'update-it-straight-away is not the way on for a page the stalled create left out of the navigation');
    return true;
  });
  assert.strictEqual(uploads.length, 1, 'the one create; neither a second create nor an update of the candidate');
  assert.ok(!uploads[0].includes('--page-id'));
  // Two candidates: the advice does not pick one for the maker.
  const other = '5c0a4889-45fd-46ea-91a8-ff876914d644';
  const several = makeGenpageCli('https://x', { run: createRun({ afterShows: [{ pageId: GUID, name: 'Overview' }, { pageId: other, name: 'Detail' }], uploads: [] }), sleep: async () => {}, request: createdPage() });
  await assert.rejects(several.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }), (e) => ADD_PAGE('<its id>').test(e.message) && e.message.includes(GUID) && e.message.includes(other));
});

test('a CREATE that times out with nothing visible yet is NOT run again — the service may still be creating it', async () => {
  const uploads = [];
  const cli = makeGenpageCli('https://x', { run: createRun({ uploads }), sleep: async () => {}, attempts: 3 });
  await assert.rejects(cli.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }), (e) => {
    assert.match(e.message, /pac genpage upload for 'Overview' timed out/);
    assert.match(e.message, /UNCERTAIN create/);
    assert.match(e.message, /may still be (?:creating|running)/);
    assert.match(e.message, /Refusing to re-run the create/);
    assert.match(e.message, /pac model genpage list --environment https:\/\/x --include-unpublished/, 'it says how to look');
    // If the page does appear it is the unplaced page of a stalled create: placing it comes before any update, and deleting it before another create.
    assert.match(e.message, ADD_PAGE('<its id>'), 'and what to do if the page appears');
    assert.match(e.message, /; or delete page <its id> and re-run the create; if none appears, re-run the create\./);
    assert.match(e.message, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS=1200000 allows a slow upload longer\./);
    return true;
  });
  assert.strictEqual(uploads.length, 1, 'never a second create, though the ordinary budget is three attempts');
  // The contrast that pins the rule: a create that FAILED (not timed out) and left nothing is still safe to run again.
  let creates = 0;
  const failed = makeGenpageCli('https://x', { run: async (args) => { if (args[2] === 'list') return { status: 0, stdout: LIST_EMPTY, stderr: '' }; creates += 1; return creates === 1 ? { status: 1, stdout: '', stderr: 'flaky' } : { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; }, sleep: async () => {}, attempts: 3 });
  assert.strictEqual((await failed.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' })).pageId, GUID);
  assert.strictEqual(creates, 2);
});

// pac prints `Page ID: <id>` after it has written the page and its messages and before it publishes, and before `--add-to-sitemap` places it. A create stopped after that has
// CREATED the page: it is reported as that page, whatever else is visible, and the way on is to place it or delete it — never "update it" (refused: not in the app's
// navigation), and never "run the create again" (a duplicate).
test('a CREATE that times out after pac printed the Page ID is reported as created as that page, stalled before it was published or placed', async () => {
  const uploads = [];
  const lists = { n: 0 };
  const printed = `Connected as tester@contoso.com\r\nUploading page 'Overview'...\r\nPage ID: ${GUID}\r\n`;
  const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run: createRun({ uploads, printed, lists }), sleep: async () => {}, attempts: 3 });
  await assert.rejects(cli.upload({ appId: 'app-9', codeFile: 'o.tsx', name: 'Overview', addToSitemap: true }), (e) => {
    assert.match(e.message, /^pac genpage upload for 'Overview' timed out after 600 s and was stopped after it had CREATED the page as 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 /);
    assert.match(e.message, /stalled before the page was published, and before it was added to the app's navigation if that was asked for\./);
    assert.match(e.message, /The create was NOT run again: a second create would make a duplicate page\./);
    assert.match(e.message, new RegExp(`add page ${GUID} to the app's navigation — in Maker, or with \`pac model genpage add --environment https://contoso\\.crm\\.dynamics\\.com --app-id app-9 --page-id ${GUID} --publish\``));
    assert.match(e.message, new RegExp(`re-run the upload as an update with --page-id ${GUID} \\(a build: set that page's pageId to ${GUID} in the App Spec\\); or delete page ${GUID} and re-run the create\\.`));
    assert.match(e.message, /POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS=1200000 allows a slow upload longer\./);
    // The one way to run the create again comes only after the page has been deleted — never as the way on from a page that is still there.
    assert.doesNotMatch(e.message, /if none appears|UNCERTAIN create|Wait a few minutes/, 'no wait-and-see: the page is known to exist');
    assert.strictEqual((e.message.match(/re-run the create/g) || []).length, 1);
    return true;
  });
  assert.strictEqual(uploads.length, 1, 'never a second create, though the ordinary budget is three attempts');
  assert.strictEqual(lists.n, 1, 'only the snapshot before the create: the page is named by what pac printed, so nothing is listed to find it');
  // pac's partial output is read the way a finished one is: the id must be a whole GUID, and not the start of a longer token.
  for (const cut of ['Page ID: 6e0c28a2-cdbf-41ec-91', `Page ID: ${GUID}f`, 'Page ID: ', '']) {
    const lists2 = { n: 0 };
    const unsure = makeGenpageCli('https://x', { run: createRun({ uploads: [], printed: cut, lists: lists2 }), sleep: async () => {}, attempts: 3 });
    await assert.rejects(unsure.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }), /an UNCERTAIN create: no new page is visible/, JSON.stringify(cut));
    assert.strictEqual(lists2.n, 2, `${JSON.stringify(cut)}: no usable id, so the environment is listed to look for the page`);
  }
  // A page id printed by a create that FAILED is the same: pac prints it once the page is written, so the page exists — even when the environment's listing does not show it yet — and the
  // create is not run again. (A failure with no usable id is an ordinary uncertain create: the next test.)
  const failedLists = { n: 0 };
  const failedUploads = [];
  const failed = makeGenpageCli('https://x', { run: async (args) => {
    if (args[2] === 'list') { failedLists.n += 1; return { status: 0, stdout: LIST_EMPTY, stderr: '' }; }
    failedUploads.push(args);
    return { status: 1, stdout: `Page ID: ${GUID}`, stderr: 'boom' };
  }, sleep: async () => {}, attempts: 3 });
  await assert.rejects(failed.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }), /failed after it had CREATED the page as 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35/);
  assert.strictEqual(failedUploads.length, 1, 'one create, though the ordinary budget is three attempts');
  assert.strictEqual(failedLists.n, 1, 'only the snapshot before the create: the page is named by what pac printed');
});

test('a CREATE that times out after pac printed the Page ID is reported as that page even when the environment cannot be listed', async () => {
  const uploads = [];
  const cli = makeGenpageCli('https://x', { run: createRun({ uploads, listFails: true, printed: `Page ID: ${GUID}` }), sleep: async () => {}, attempts: 3 });
  await assert.rejects(cli.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }), /after it had CREATED the page as 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35/);
  assert.strictEqual(uploads.length, 1);
});

// A create that FAILS (exits non-zero) after pac printed `Page ID` is in the same state as one that stalled after it: pac has written the page, and the publish — or the placement — did not
// finish. So it is reported as that page and never sent again, whatever the environment's listing shows (the page need not be in it yet). And the page is then not in the app's navigation,
// so "re-run the upload as an update with --page-id" — what 2.13.0 said for such a create — is refused by genpage-upload.js ("not in the app's navigation", no base marker), and the build
// cannot bind it. The way on is the one a stalled create gets: place the page, or delete it.
test('a CREATE that FAILS after pac printed the Page ID is reported as created as that page and never sent again, whatever the listing shows — told to place it or delete it', async () => {
  const printed = `Connected as tester@contoso.com\r\nPage ID: ${GUID}\r\n`;
  for (const [what, listing] of [
    ['the listing does not show the page yet', () => LIST_EMPTY],
    ['the listing shows the page', () => listText([{ pageId: GUID, name: 'Overview' }])],
    ['the listing cannot be read', null],
  ]) {
    const lists = { n: 0 };
    const uploads = [];
    const run = async (args) => {
      if (args[2] === 'list') {
        lists.n += 1;
        if (lists.n > 1 && !listing) return { status: 1, stdout: '', stderr: 'list failed' };
        return { status: 0, stdout: lists.n === 1 || !listing ? LIST_EMPTY : listing(), stderr: '' };
      }
      uploads.push(args);
      return { status: 1, stdout: printed, stderr: 'Error: the page could not be published' };
    };
    const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run, sleep: async () => {}, attempts: 3, request: createdPage() });
    await assert.rejects(cli.upload({ appId: 'app-9', codeFile: 'o.tsx', name: 'Overview' }), (e) => {
      assert.match(e.message, /^pac genpage upload for 'Overview' failed after it had CREATED the page as 6e0c28a2-cdbf-41ec-9186-d10fd5de6e35 \(pac prints the Page ID once the page is written\) — /, what);
      assert.match(e.message, /it stopped before the page was published, or before it was added to the app's navigation if that was asked for \(Error: the page could not be published\)\./, `${what}: what pac said`);
      assert.match(e.message, /The create was NOT run again: a second create would make a duplicate page\./, what);
      assert.match(e.message, new RegExp(`To finish it, add page ${GUID} to the app's navigation — in Maker, or with \`pac model genpage add --environment https://contoso\\.crm\\.dynamics\\.com --app-id app-9 --page-id ${GUID} --publish\``), `${what}: how to place it`);
      assert.match(e.message, new RegExp(`and then re-run the upload as an update with --page-id ${GUID} \\(a build: set that page's pageId to ${GUID} in the App Spec\\); or delete page ${GUID} and re-run the create\\.$`), `${what}: update only after it is placed`);
      assert.doesNotMatch(e.message, /timed out|POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS|ambiguous ownership|If it is yours, re-run the upload as an update/, `${what}: it did not stall, and names no candidate`);
      assert.strictEqual(e.transient, false, `${what}: nothing re-runs it`);
      return true;
    }, what);
    assert.strictEqual(uploads.length, 1, `${what}: the create is not run again, though the ordinary budget is three attempts`);
    assert.strictEqual(lists.n, 1, `${what}: only the snapshot before the create — the page is named by what pac printed`);
  }
});

// With no usable id printed the page can only be found by the listing, and what it shows decides what is said. The same advice applies to a candidate: place it, or delete it.
test('a CREATE that FAILS with no Page ID printed and leaves a candidate behind is told to place the page or delete it, never to update it, which would be refused', async () => {
  for (const [what, stdout] of [['nothing printed', 'No page id returned'], ['a page id cut off mid-token', 'Page ID: 6e0c28a2-cdbf-41ec-91']]) {
    const lists = { n: 0 };
    const uploads = [];
    const run = async (args) => {
      if (args[2] === 'list') { lists.n += 1; return { status: 0, stdout: lists.n === 1 ? LIST_EMPTY : listText([{ pageId: GUID, name: 'Overview' }]), stderr: '' }; }
      uploads.push(args);
      return { status: 1, stdout, stderr: 'Error: the page could not be published' };
    };
    const cli = makeGenpageCli('https://contoso.crm.dynamics.com', { run, sleep: async () => {}, attempts: 3, request: createdPage() });
    await assert.rejects(cli.upload({ appId: 'app-9', codeFile: 'o.tsx', name: 'Overview' }), (e) => {
      assert.match(e.message, /had an uncertain create \(ambiguous ownership\)/, what);
      assert.doesNotMatch(e.message, /timed out|CREATED the page as/, `${what}: it did not stall, and no id was printed`);
      assert.ok(e.message.includes(`${GUID}: stored name "Overview"`), what);
      assert.match(e.message, new RegExp(`If one is yours, add page ${GUID} to the app's navigation — in Maker, or with \`pac model genpage add --environment https://contoso\\.crm\\.dynamics\\.com --app-id app-9 --page-id ${GUID} --publish\``), `${what}: how to place it`);
      assert.match(e.message, new RegExp(`and then re-run the upload as an update with --page-id ${GUID} \\(a build: set that page's pageId to ${GUID} in the App Spec\\); or delete page ${GUID} and re-run the create; otherwise leave them and re-run the create\\.`), `${what}: update only after it is placed`);
      assert.doesNotMatch(e.message, /If it is yours, re-run the upload as an update/, `${what}: the advice that is refused is gone`);
      assert.strictEqual(e.transient, false, `${what}: nothing re-runs it`);
      return true;
    }, what);
    assert.strictEqual(uploads.length, 1, `${what}: the create is not run again`);
  }
});

test('a CREATE that times out while the environment cannot be listed refuses to go on, as every uncertain create does — and says how to find out whether it made a page', async () => {
  const uploads = [];
  const cli = makeGenpageCli('https://x', { run: createRun({ uploads, listFails: true }), sleep: async () => {}, attempts: 3 });
  await assert.rejects(cli.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }), (e) => {
    assert.match(e.message, /^pac genpage upload for 'Overview' timed out after 600 s and was stopped, and had an uncertain result and env enumeration failed — refusing to retry \(would risk a duplicate\): pac genpage list \(env-wide\) failed after 3 attempt\(s\): list failed\. /);
    // Nothing is known about what the create made, so the way on is to look: wait, list, and place a page that is there — before anything is created again.
    assert.match(e.message, /The create may have made a page\. Wait a few minutes, then run `pac model genpage list --environment https:\/\/x --include-unpublished`: if a new page with this name appears and it is yours, /);
    assert.match(e.message, ADD_PAGE('<its id>'));
    assert.match(e.message, /; or delete page <its id> and re-run the create; if none appears, re-run the create\. POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS=1200000 allows a slow upload longer\.$/);
    assert.strictEqual(e.transient, false);
    return true;
  });
  assert.strictEqual(uploads.length, 1);
  // A create that FAILED (did not stall) and cannot be checked says the same, without the words about a stall or a longer budget.
  const failedUploads = [];
  let lists = 0;
  const failed = makeGenpageCli('https://x', { run: async (args) => {
    if (args[2] === 'list') { lists += 1; return lists === 1 ? { status: 0, stdout: LIST_EMPTY, stderr: '' } : { status: 1, stdout: '', stderr: 'list failed' }; }
    failedUploads.push(args);
    return { status: 1, stdout: '', stderr: 'Error: the upload failed' };
  }, sleep: async () => {}, attempts: 3 });
  await assert.rejects(failed.upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }), (e) => {
    assert.match(e.message, /^pac genpage upload for 'Overview' had an uncertain result and env enumeration failed — refusing to retry/);
    assert.doesNotMatch(e.message, /timed out|POWER_PLATFORM_SKILLS_PAC_TIMEOUT_MS/);
    assert.match(e.message, /The create may have made a page\. Wait a few minutes, then run `pac model genpage list/);
    assert.strictEqual(e.transient, false);
    return true;
  });
  assert.strictEqual(failedUploads.length, 1);
});

test('a listing that times out BEFORE a create stops it before anything is created', async () => {
  const uploads = [];
  const run = async (args) => { if (args[2] === 'list') return timedOutRun(); uploads.push(args); return { status: 0, stdout: `Page ID: ${GUID}`, stderr: '' }; };
  await assert.rejects(makeGenpageCli('https://x', { run, sleep: async () => {} }).upload({ appId: 'a', codeFile: 'o.tsx', name: 'Overview' }),
    /cannot snapshot the environment before create[\s\S]*did not finish within 180 s[\s\S]*refusing to create/);
  assert.deepStrictEqual(uploads, [], 'no create was issued');
});
