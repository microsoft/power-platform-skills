'use strict';
// scripts/genpage-shared-check.js: the check the /genpage edit flow runs before it uploads an edit — the other apps whose navigation shows the page. The backend's own scan is tested in
// genpage-sdk-verbs.test.js (`sharedWith`); this file says what the SCRIPT does with each answer: what it asks, what it prints, and — the point of it — the exit status, which is how the skill
// tells "ask the user" (2) from "could not tell" (1) from "nothing to say" (0).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main, parseCommand, decide, unconfirmedMessage, UsageError, UNCONFIRMED_EXIT } = require('../genpage-shared-check.js');

const SCRIPT = path.join(__dirname, '..', 'genpage-shared-check.js');
const ENV = 'https://contoso.crm.dynamics.com';
const APP = '22222222-0000-4000-8000-0000000000bb';
const P1 = '11111111-0000-4000-8000-000000000001';
const FLAGS = ['--env', ENV, '--app-id', APP, '--page-id', P1];
const OPS = { uniqueName: 'contoso_ops', name: 'Operations', appId: '33333333-0000-4000-8000-000000000001', savedOnly: false };
const HR = { uniqueName: 'contoso_hr', name: 'People', appId: '33333333-0000-4000-8000-000000000002', savedOnly: true };

// A page backend that answers `sharedWith` with `apps`, or throws `failure`; it records what it was asked and how often it was disposed.
function fakeBackend({ apps = [], failure = null } = {}) {
  const backend = {
    asked: [],
    disposed: 0,
    async sharedWith(pageId, appId, options) {
      backend.asked.push({ pageId, appId, options });
      if (failure) throw failure;
      return { pageId, appId, appUniqueName: 'contoso_edited', apps };
    },
    async dispose() { backend.disposed += 1; return { removed: true }; },
  };
  return backend;
}

async function run(argv, backend = fakeBackend(), extra = {}) {
  const seen = { emitted: [], usage: [], stderr: [], envs: [] };
  await main(argv, {
    makeGenpageSdk: (env) => { seen.envs.push(env); return backend; },
    emit: (ok, payload, options) => { seen.emitted.push({ ok, payload, options, disposedWhenEmitted: backend.disposed }); },
    usageError: (message) => { seen.usage.push(message); },
    stderr: (text) => { seen.stderr.push(text); },
    ...extra,
  });
  seen.backend = backend;
  seen.result = seen.emitted[0];
  return seen;
}

// ── the command line ─────────────────────────────────────────────────────────────────────────────────────────────

test('parseCommand: the origin and both ids are checked, and an id is read in lower case', () => {
  const command = parseCommand(['--env', ENV, '--app-id', APP.toUpperCase(), '--page-id', P1]);
  assert.deepStrictEqual(command, { env: ENV, appId: APP, pageId: P1, confirmed: [] });
  assert.deepStrictEqual(parseCommand([...FLAGS, '--confirmed-apps', 'contoso_ops, contoso_hr']).confirmed, ['contoso_ops', 'contoso_hr']);
});

test('parseCommand: a missing, blank, repeated or malformed flag is a usage error — a confirmation is never half a list or a guess', () => {
  const bad = [
    [['--env', ENV, '--app-id', APP], /--page-id is required/],
    [['--app-id', APP, '--page-id', P1], /--env is required/],
    [[...FLAGS, '--confirmed-apps'], /./],
    [[...FLAGS, '--confirmed-apps', ''], /./],
    [[...FLAGS, '--confirmed-apps', 'contoso_ops,,contoso_hr'], /empty app name/],
    [[...FLAGS, '--confirmed-apps', 'contoso_ops', '--confirmed-apps', 'contoso_hr'], /more than once/],
    [['--env', ENV, '--app-id', 'nope', '--page-id', P1], /--app-id 'nope' is not an id/],
    [['--env', ENV, '--app-id', APP, '--page-id', 'nope'], /--page-id 'nope' is not an id/],
    [['--env', 'https://example.com', '--app-id', APP, '--page-id', P1], /./],
    [[...FLAGS, '--allow-destructive'], /./],
    [[...FLAGS, 'extra'], /unexpected argument 'extra'/],
  ];
  for (const [argv, pattern] of bad) {
    assert.throws(() => parseCommand(argv), (e) => e instanceof UsageError && pattern.test(e.message), JSON.stringify(argv));
  }
});

test('a usage error is reported and nothing is read: the backend is not even made', async () => {
  const seen = await run(['--env', ENV]);
  assert.strictEqual(seen.usage.length, 1);
  assert.deepStrictEqual([seen.emitted.length, seen.envs.length], [0, 0]);
});

// ── the answers ──────────────────────────────────────────────────────────────────────────────────────────────────

test('a page no other app shows: exit 0, nothing to confirm — the answer says shared: false and the user is told nothing', async () => {
  const seen = await run(FLAGS);
  assert.strictEqual(seen.result.ok, true);
  assert.deepStrictEqual(seen.result.payload, { ok: true, shared: false, pageId: P1, appId: APP, apps: [] });
  assert.strictEqual(seen.result.options, undefined, 'no exit status of its own: a success is 0');
  assert.deepStrictEqual(seen.backend.asked, [{ pageId: P1, appId: APP, options: {} }]);
  assert.deepStrictEqual(seen.stderr, []);
});

test('a page other apps show, with no confirmation: exit 2, every app named, nothing changed', async () => {
  const seen = await run(FLAGS, fakeBackend({ apps: [OPS, HR] }));
  const { ok, payload, options } = seen.result;
  assert.strictEqual(ok, false);
  assert.strictEqual(options.failureExitCode, 2);
  assert.strictEqual(UNCONFIRMED_EXIT, 2);
  assert.strictEqual(payload.code, 'GENPAGE_SHARED_PAGE_UNCONFIRMED');
  assert.strictEqual(payload.outcome, 'nothing');
  assert.deepStrictEqual(payload.apps, [OPS, HR]);
  assert.deepStrictEqual(payload.unconfirmed, ['contoso_ops', 'contoso_hr']);
  assert.match(payload.error, /^this change also affects "Operations" \(contoso_ops\) and "People" \(contoso_hr\) \[saved, not published\]: /);
  assert.match(payload.error, /--confirmed-apps 'contoso_ops,contoso_hr'/);
  assert.match(payload.error, /An unattended run stops here and reports the apps/);
});

test('the confirmation covers the apps it names: all of them continue, an extra name is harmless, a missing one stops again and is named', async () => {
  const all = await run([...FLAGS, '--confirmed-apps', 'contoso_ops,contoso_hr'], fakeBackend({ apps: [OPS, HR] }));
  assert.strictEqual(all.result.ok, true);
  assert.deepStrictEqual(all.result.payload, { ok: true, shared: true, confirmed: true, pageId: P1, appId: APP, apps: [OPS, HR] });

  const extra = await run([...FLAGS, '--confirmed-apps', 'CONTOSO_OPS,contoso_other'], fakeBackend({ apps: [OPS] }));
  assert.strictEqual(extra.result.ok, true, 'names are compared in lower case, and a confirmed app that does not show the page changes nothing');

  // An app began to show the page after the user was asked: it is not in what they confirmed.
  const later = await run([...FLAGS, '--confirmed-apps', 'contoso_ops'], fakeBackend({ apps: [OPS, HR] }));
  assert.strictEqual(later.result.ok, false);
  assert.strictEqual(later.result.options.failureExitCode, 2);
  assert.deepStrictEqual(later.result.payload.unconfirmed, ['contoso_hr']);
  assert.match(later.result.payload.error, /Not yet confirmed: contoso_hr\./);
});

test('a scan that could not tell fails closed: exit 1 (no exit status of its own), never an empty list, and the confirmation does not get past it', async () => {
  const failure = Object.assign(new Error('the navigation of this app could not be read — contoso_x'), { code: 'GENPAGE_APPS_UNREADABLE', outcome: 'nothing', apps: [OPS], unreadableApps: ['contoso_x'] });
  for (const argv of [FLAGS, [...FLAGS, '--confirmed-apps', 'contoso_ops,contoso_x']]) {
    const seen = await run(argv, fakeBackend({ failure }));
    const { ok, payload, options } = seen.result;
    assert.strictEqual(ok, false);
    assert.strictEqual(options, undefined, 'a failure is exit 1: only a question is 2');
    assert.strictEqual(payload.code, 'GENPAGE_APPS_UNREADABLE');
    assert.deepStrictEqual(payload.unreadableApps, ['contoso_x']);
    assert.strictEqual(payload.shared, undefined);
  }
  const other = await run(FLAGS, fakeBackend({ failure: new Error('boom') }));
  assert.strictEqual(other.result.ok, false);
  assert.strictEqual(other.result.payload.error, 'boom');
});

test('the backend is disposed BEFORE the result is emitted, whichever way it came out; a waits override reaches the scan', async () => {
  for (const backend of [fakeBackend(), fakeBackend({ apps: [OPS] }), fakeBackend({ failure: new Error('x') })]) {
    const seen = await run(FLAGS, backend, { waits: [] });
    assert.strictEqual(seen.result.disposedWhenEmitted, 1);
    assert.deepStrictEqual(backend.asked[0].options, { waits: [] });
  }
});

test('decide: a name is covered only by a name in the list, compared in lower case', () => {
  assert.deepStrictEqual(decide([], ['contoso_ops']), { shared: false, confirmed: false, unconfirmed: [] });
  assert.deepStrictEqual(decide([OPS], []), { shared: true, confirmed: false, unconfirmed: ['contoso_ops'] });
  assert.deepStrictEqual(decide([OPS, HR], ['Contoso_Ops']), { shared: true, confirmed: false, unconfirmed: ['contoso_hr'] });
  assert.deepStrictEqual(decide([OPS], ['contoso_op']), { shared: true, confirmed: false, unconfirmed: ['contoso_ops'] });
  assert.deepStrictEqual(decide([OPS, HR], ['contoso_hr', 'contoso_ops']), { shared: true, confirmed: true, unconfirmed: [] });
});

test('unconfirmedMessage: one app is "that app", the unique name stands in for a name that could not be read', () => {
  const message = unconfirmedMessage({ pageId: P1, apps: [{ uniqueName: 'contoso_ops', savedOnly: false }], unconfirmed: ['contoso_ops'] });
  assert.match(message, /^this change also affects contoso_ops: page .* is in its navigation too/);
  assert.match(message, /for that app, then run this check again with --confirmed-apps 'contoso_ops'/);
});

// ── the exit status, as a process ────────────────────────────────────────────────────────────────────────────────

// The real `emitResult` ends the process, so its exit status is only seen from outside: the script's own `main`, with the backend replaced, in a child process.
function runAsProcess(argv, backendSource) {
  const code = `
    const { main } = require(${JSON.stringify(SCRIPT)});
    const backend = ${backendSource};
    main(JSON.parse(process.env.ARGV), { makeGenpageSdk: () => backend }).catch((e) => { process.stderr.write(String(e)); process.exit(9); });`;
  return spawnSync(process.execPath, ['-e', code], { env: { ...process.env, ARGV: JSON.stringify(argv), POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' }, encoding: 'utf8', timeout: 60000 });
}
const BACKEND = (sharedWith) => `{ sharedWith: ${sharedWith}, dispose: async () => ({}) }`;

test('exit statuses: 0 for a page nobody else shows, 2 for a question, 1 for a failure — one line of ASCII on stdout each', () => {
  const none = runAsProcess(FLAGS, BACKEND('async (pageId, appId) => ({ pageId, appId, apps: [] })'));
  const some = runAsProcess(FLAGS, BACKEND(`async (pageId, appId) => ({ pageId, appId, apps: [${JSON.stringify({ ...OPS, name: 'Opérations' })}] })`));
  const confirmed = runAsProcess([...FLAGS, '--confirmed-apps', 'contoso_ops'], BACKEND(`async (pageId, appId) => ({ pageId, appId, apps: [${JSON.stringify(OPS)}] })`));
  const failure = runAsProcess(FLAGS, BACKEND('async () => { const e = new Error("unreadable"); e.code = "GENPAGE_APPS_UNREADABLE"; throw e; }'));
  const usage = runAsProcess(['--env', ENV], BACKEND('async () => ({})'));
  assert.deepStrictEqual([none.status, some.status, confirmed.status, failure.status, usage.status], [0, 2, 0, 1, 1], [none, some, confirmed, failure, usage].map((r) => r.stderr).join('|'));
  for (const result of [none, some, confirmed, failure]) {
    assert.strictEqual(result.stdout.trim().split('\n').length, 1);
    assert.match(result.stdout, /^[\x20-\x7e]+\n?$/, 'pure ASCII');
  }
  assert.strictEqual(JSON.parse(some.stdout).code, 'GENPAGE_SHARED_PAGE_UNCONFIRMED');
  assert.strictEqual(JSON.parse(failure.stdout).code, 'GENPAGE_APPS_UNREADABLE');
  assert.strictEqual(usage.stdout, '', 'a usage error is stderr only');
});

// ── the edit flow's text ─────────────────────────────────────────────────────────────────────────────────────────

const fs = require('node:fs');
const PHASE6 = (() => {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'skills', 'genpage', 'edit-flow.md'), 'utf8');
  const start = text.indexOf('## Edit Phase 6:');
  return text.slice(start, text.indexOf('## Edit Phase 7:', start)).replace(/\s+/g, ' ');
})();

test('edit flow, Phase 6: the check runs BEFORE the upload command; a question is asked or — unattended — halts; a failure halts; the result is logged', () => {
  const check = PHASE6.indexOf('scripts/genpage-shared-check.js');
  const upload = PHASE6.indexOf('scripts/genpage-upload.js"');
  assert.ok(check > 0 && upload > check, 'the check comes before the upload command');
  assert.ok(PHASE6.indexOf('Exit 0, `"shared": false`') > check && PHASE6.indexOf('Exit 0, `"shared": false`') < upload);
  assert.match(PHASE6, /Exit 0, `"shared": false`\*\* — .*Say nothing to the user and go on to the upload/);
  assert.match(PHASE6, /Exit 2, `"code": "GENPAGE_SHARED_PAGE_UNCONFIRMED"`\*\* — .*Attended:\*\* tell the user "This change also affects/);
  assert.match(PHASE6, /Unattended:\*\* STOP and report the apps\. Never pass `--confirmed-apps` without the user's answer — suppressing a prompt never authorizes/);
  assert.match(PHASE6, /Exit 1\*\* — the check could not tell .*STOP and report the `error`, whichever mode the run is in\. Do not take the page to be unshared/);
  assert.match(PHASE6, /A confirmation covers only the apps it names/);
  assert.match(PHASE6, /`workflow-log\.md`/);
});
