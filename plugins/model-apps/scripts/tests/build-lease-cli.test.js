'use strict';
// The build command (build-model-app.js main) under the build lease (lib/app-operation-lease.js): what it does BEFORE the lease, what it does under
// it, and what it prints after it is let go.
//
// An apply takes the app's build lease after its arguments, its spec and its paths are checked and BEFORE the auth check, the language read, the
// SDK's workspace, the journal, the snapshot and the baseline. So:
//   - a second apply of the same app in the workspace is refused at once, and has checked no identity, opened no SDK and touched no file the first
//     one is using — its journal, its status, its snapshot, its approval record, its baseline;
//   - every way an apply can end — refused identity, a language it cannot use, an SDK or a journal that cannot be opened, a halted phase, a verify that
//     could not run, a baseline that could not be written — happened while the lease was held, and what the command prints comes after the lease is
//     let go: the result printer ends the process, so a release after it would never run.
// The command is loaded with its real modules, the lease's included; only what reaches an environment or the SDK is a double
// (helpers/build-command-harness.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { appFolder: folderFor, command, settle } = require('./helpers/build-command-harness.js');
const realEntityProvision = require('../lib/entity-provision.js');
const { RETRY } = require('../lib/retry-policy.js');

const SPEC = {
  schemaVersion: 2,
  solution: { uniqueName: 'contoso', publisherPrefix: 'contoso' },
  app: { name: 'Lease Probe' },
  entities: [{ schemaName: 'contoso_order', primaryAttribute: { schemaName: 'contoso_name' }, columns: [] }],
  appShell: { areas: [{ label: 'Main', groups: [{ label: 'Main', subAreas: [] }] }] },
};
const appFolder = () => folderFor(SPEC);

function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return { opened, open };
}

test('a second apply of the same app is refused before its auth check, its SDK or its journal, and leaves the first one\'s journal, status, snapshot, approval and baseline as they were', async () => {
  const folder = appFolder();
  fs.mkdirSync(folder.workspaceDir, { recursive: true });
  // What the first build has on disk while it runs.
  const files = {
    'build-log.jsonl': '{"phase":"data-model","status":"ok"}\n',
    'build-status.json': '{"status":"running"}\n',
    'apply-snapshot.json': '{"schemaVersion":1,"eligible":true}\n',
    'destructive-approval.json': '{"schemaVersion":1,"formRemovals":{},"sitemapRemovals":[]}\n',
    'last-applied.json': '{"app":{"name":"Lease Probe"}}\n',
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(folder.workspaceDir, name), text);
  const bytes = () => Object.fromEntries(Object.keys(files).map((name) => [name, fs.readFileSync(path.join(folder.workspaceDir, name), 'utf8')]));
  const before = bytes();

  const held = gate();
  const inside = gate();
  const first = command(folder, { auth: async () => { inside.open(); await held.opened; return { ok: false, error: 'the first build stops here' }; } });
  const firstRun = settle(first);
  await inside.opened;

  const second = command(folder, { auth: () => ({ ok: false, error: 'the second build checked its identity' }) });
  const outcome = await settle(second);
  assert.ok(outcome.thrown, `refused, not run: ${JSON.stringify(outcome)} ${second.calls}`);
  assert.strictEqual(outcome.thrown.code, 'build-locked');
  assert.deepStrictEqual(second.calls, [], 'no auth check, no language read, no SDK');
  assert.deepStrictEqual(bytes(), before, 'the first build\'s files are as they were');
  // What main().catch prints for it: the refusal on stderr, nothing on stdout, exit 1.
  assert.throws(() => second.authCli.exports.emitResult(false, outcome.thrown), (e) => e.exitCode === 1);
  assert.strictEqual(second.authCli.stdoutText(), '', 'no stdout JSON');
  assert.strictEqual(second.authCli.stderrText(), `${outcome.thrown.message}\n`);
  assert.match(outcome.thrown.message, /^another build may be applying 'contoso_leaseprobe' in this workspace/);

  held.open();
  assert.deepStrictEqual(await firstRun, { exitCode: 1 });
  assert.ok(!first.held(), 'the first build let go when it ended');
});

test('an identity the auth check refuses, and a language that cannot be used, end an apply that already held its lease — and what is printed, or thrown to main().catch, comes after the release', async () => {
  // The identity: the result is the `{ ok: false, error }` the command has always printed for it.
  const refused = appFolder();
  let heldAtAuth = null;
  const auth = command(refused, { auth: (held) => { heldAtAuth = held(); return { ok: false, error: 'sign in as maker@contoso.onmicrosoft.com' }; } });
  assert.deepStrictEqual(await settle(auth), { exitCode: 1 });
  assert.strictEqual(heldAtAuth, true, 'the lease was held when the auth check ran');
  assert.strictEqual(auth.printed.heldThen, false, 'and let go before the result was printed');
  assert.deepStrictEqual(JSON.parse(auth.authCli.stdoutText()), { ok: false, error: 'sign in as maker@contoso.onmicrosoft.com' });
  assert.strictEqual(auth.authCli.stderrText(), 'sign in as maker@contoso.onmicrosoft.com\n');
  assert.deepStrictEqual(auth.calls, ['auth'], 'no language read, no SDK, no journal');
  assert.ok(!fs.existsSync(path.join(refused.workspaceDir, 'build-log.jsonl')), 'no journal was opened');

  // The language: an error, which main().catch prints.
  const language = appFolder();
  let heldAtLanguage = null;
  const lang = command(language, { language: (held) => { heldAtLanguage = held(); throw new Error('language 1031 is not provisioned in this environment'); } });
  const outcome = await settle(lang);
  assert.strictEqual(heldAtLanguage, true, 'the lease was held when the language was read');
  assert.ok(outcome.thrown instanceof Error && /1031 is not provisioned/.test(outcome.thrown.message), JSON.stringify(outcome));
  assert.strictEqual(outcome.heldThen, false, 'and let go before the error reached main().catch');
  assert.deepStrictEqual(lang.calls, ['auth', 'language'], 'no SDK, no journal');
  assert.strictEqual(lang.printed.ok, null, 'nothing was printed under the lease');
});

test('an SDK or a journal that cannot be opened, a halted phase, a verify that cannot run and a baseline that cannot be written each happen under the lease, which is let go before anything is printed', async () => {
  const halt = new realEntityProvision.BuildHalt('data-model failed: bad request', { phase: 'data-model', code: 'sdk-error', retry: RETRY.NEVER });
  const cases = [
    ['the SDK cannot be made', { makeSdk: () => { throw new Error('the SDK could not be made'); } }, { thrown: /SDK could not be made/ }],
    ['the journal cannot be opened', { openJournal: () => { throw new Error('the journal could not be opened'); } }, { thrown: /journal could not be opened/ }],
    ['a phase halts', { engine: () => { throw halt; } }, { thrown: /data-model failed/ }],
    ['the verify cannot run', { argv: ['--verify'], verify: () => { throw new Error('the verify could not read the app'); } }, { exitCode: 0 }],
    ['the baseline cannot be written', { writeBaseline: () => { throw new Error('ENOSPC: no space left on device'); } }, { exitCode: 0 }],
  ];
  for (const [what, doubles, expected] of cases) {
    const folder = appFolder();
    const heldAt = [];
    const wrapped = Object.fromEntries(Object.entries(doubles).map(([key, fn]) => [key, typeof fn === 'function' ? (held, ...rest) => { heldAt.push(held()); return fn(held, ...rest); } : fn]));
    const run = command(folder, wrapped);
    const outcome = await settle(run);
    assert.deepStrictEqual(heldAt, [true], `${what}: it happened while the lease was held`);
    if (expected.thrown) {
      assert.match(String(outcome.thrown && outcome.thrown.message), expected.thrown, `${what}: ${JSON.stringify(outcome)}`);
      assert.strictEqual(outcome.heldThen, false, `${what}: let go before the error reached main().catch`);
    } else {
      assert.deepStrictEqual(outcome, { exitCode: expected.exitCode }, what);
      assert.strictEqual(run.printed.heldThen, false, `${what}: let go before the result was printed`);
    }
    assert.ok(!run.held(), `${what}: no lock left`);
  }
});

test('the baseline a successful apply writes is written under the lease: a second apply started then is refused', async () => {
  const folder = appFolder();
  let refusal = null;
  const run = command(folder, {
    writeBaseline: () => {
      const other = command(folder);
      // Started from inside the first one's baseline write, so it is checked synchronously here: the lease it meets is the first one's.
      refusal = other.cli.main().then(() => null, (e) => e);
    },
  });
  assert.deepStrictEqual(await settle(run), { exitCode: 0 });
  const e = await refusal;
  assert.strictEqual(e && e.code, 'build-locked', String(e && e.stack));
});
