'use strict';
// The HTTP client draws its waits for a throttled answer from the run's throttle budget (lib/sdk-http-client.js, lib/throttle-budget.js): these tests hold the WIRING that gives every client of a run the one budget — the build's SDK, the
// page backend's, and the upload script's — and nothing else. What the client does with a budget is held in sdk-http-client.test.js, and what the build's loop does with a wait the client was refused is held in build-model-app.test.js;
// sdk-build-pages-deploy.test.js runs all three together over the real SDK.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const { FakeGenPageServer, INSTANCE } = require('./helpers/fake-genpage-server.js');
const { makeGenpageSdk } = require('../lib/genpage-sdk.js');
const { makeThrottleBudget } = require('../lib/throttle-budget.js');

const scriptsDir = path.join(__dirname, '..');
const SOURCE = "import * as React from 'react';\nexport default function Page() { return <div>Hello</div>; }\n";
const isBudget = (value) => ['fits', 'spend', 'announce', 'decline', 'declined', 'note'].every((name) => typeof (value && value[name]) === 'function');

// ── The page backend ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The backend makes the HTTP client of its own SDK (the build's pages phase, the verify after it and the upload script all use one), and hands it the budget it was given: what the client waits for on a throttled read or publish is
// then the run's, with the backend's own waits for a page write.
test('the page backend gives the budget it was handed to the HTTP client it makes — and none when it was handed none', async () => {
  for (const [what, deps, expected] of [['a budget', { throttle: makeThrottleBudget() }, 'given'], ['none', {}, undefined]]) {
    const server = new FakeGenPageServer();
    const seen = [];
    const genpage = makeGenpageSdk(INSTANCE, { ...deps, createHttpClient: (env, options) => { seen.push({ env, options }); return server.http(); } });
    try {
      assert.strictEqual((await genpage.enumerateEnv()).ok, true, what);
      assert.strictEqual(seen.length, 1, `${what}: one client, made once`);
      assert.strictEqual(seen[0].env, INSTANCE);
      assert.strictEqual(seen[0].options.throttle, expected === 'given' ? deps.throttle : undefined, `${what}: the client is given the backend's budget, or none`);
    } finally {
      await genpage.dispose();
    }
  }
});

test('a client that is injected is the caller\'s own: the backend does not make one, and so hands a budget to nothing', async () => {
  const server = new FakeGenPageServer();
  let made = 0;
  const genpage = makeGenpageSdk(INSTANCE, { httpClient: server.http(), throttle: makeThrottleBudget(), createHttpClient: () => { made += 1; return server.http(); } });
  try {
    assert.strictEqual((await genpage.enumerateEnv()).ok, true);
    assert.strictEqual(made, 0);
  } finally {
    await genpage.dispose();
  }
});

// A page write is given the run's budget by the build (`args.throttle`); the upload script gives none to its write, and hands its backend one instead, so the write's resends and the client's waits are drawn from the same
// five minutes. A backend that was handed nothing gives each write a budget of its own, as it always did.
test('a page write that is given no budget spends the one its backend was handed — the client\'s waits and the write\'s resends are one budget — and one it is given wins', async () => {
  const throttledFirst = () => {
    const server = new FakeGenPageServer();
    server.failBatch = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '9' } } : undefined);
    return server;
  };
  const backend = (server, deps, slept) => makeGenpageSdk(INSTANCE, { httpClient: server.http(), sleep: async (ms) => { slept.push(ms); }, random: () => 0, ...deps });
  // Handed to the backend: the write draws from it.
  const own = makeThrottleBudget();
  const slept = [];
  const genpage = backend(throttledFirst(), { throttle: own }, slept);
  try {
    const out = await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(slept, [9000]);
    assert.strictEqual(own.spentMs(), 9000, 'the wait is the backend\'s budget\'s');
    assert.ok(out.pageId);
  } finally { await genpage.dispose(); }
  // Handed to the write as well: the write's own wins, and the backend's is not touched.
  const backendBudget = makeThrottleBudget();
  const writeBudget = makeThrottleBudget();
  const slept2 = [];
  const second = backend(throttledFirst(), { throttle: backendBudget }, slept2);
  try {
    await second.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r', throttle: writeBudget });
    assert.deepStrictEqual([writeBudget.spentMs(), backendBudget.spentMs()], [9000, 0]);
  } finally { await second.dispose(); }
  // Handed nothing: a budget of its own for each write, so two writes that are throttled for 200 s each both fit, as they always did.
  const slept3 = [];
  const server = new FakeGenPageServer();
  server.failBatch = (n) => (n === 1 || n === 3 ? { status: 429, headers: { 'retry-after': '200' } } : undefined);
  const plain = backend(server, {}, slept3);
  try {
    await plain.create({ name: 'First', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    await plain.create({ name: 'Second', source: SOURCE.replace('Hello', 'Other'), prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(slept3, [200000, 200000], 'each write had its own five minutes');
  } finally { await plain.dispose(); }
});

test('a budget that is not one is no budget — the backend\'s write makes one of its own, and its client is given none', async () => {
  const server = new FakeGenPageServer();
  server.failBatch = (n) => (n === 1 ? { status: 429, headers: { 'retry-after': '9' } } : undefined);
  const slept = [];
  const seen = [];
  const genpage = makeGenpageSdk(INSTANCE, { createHttpClient: (env, options) => { seen.push(options); return server.http(); }, throttle: { fits: true }, sleep: async (ms) => { slept.push(ms); }, random: () => 0 });
  try {
    await genpage.create({ name: 'Overview', source: SOURCE, prompt: 'p', agentMessage: 'r' });
    assert.deepStrictEqual(slept, [9000]);
    assert.strictEqual(isBudget(seen[0].throttle), false);
  } finally { await genpage.dispose(); }
});

// ── The build ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// build-model-app.js's main() makes the run's budget before anything else that sends, and hands that one object to the HTTP client its SDK is made over — both SDK instances share it, and verify's isolated reader — and to the
// engine, whose pages phase gives it to the page backend and to every page write, and to the retry loop. Run here as the CLI runs, over stand-ins for the SDK, the client and the engine, so the wires are what is held.
test('build-model-app.js makes ONE budget and hands it to the HTTP client of its SDK and to the engine — the same object, with the warn seam on stderr', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-wiring-'));
  try {
    fs.copyFileSync(path.join(scriptsDir, '..', 'samples', 'app-spec.support-desk.json'), path.join(dir, 'app-spec.json'));
    const authCli = loadCli(path.join(scriptsDir, 'lib', 'dataverse-auth.js'));
    const clients = [];
    const engines = [];
    const cli = loadCli(path.join(scriptsDir, 'build-model-app.js'), {
      argv: ['--env', INSTANCE, '--spec', `@${path.join(dir, 'app-spec.json')}`, '--no-live-plan'],
      requires: {
        './lib/dataverse-auth.js': authCli.exports,
        './lib/sdk-http-client.js': { createAzHttpClient: (env, deps) => { clients.push(deps); return {}; }, SQL_DEADLOCK_VICTIM: /Sql Number: 1205/ },
        './lib/maker-sdk.js': { createNodeWorkspaceStorage: (d) => ({ dir: d }), createMakerSdk: () => ({ initWorkspace: async () => {} }) },
        './lib/sdk-build.js': { ...require('../lib/sdk-build.js'), runSdkBuild: async (spec, options) => { engines.push(options); return { ok: true, dryRun: true, planItems: [] }; } },
      },
    });
    await assert.rejects(cli.main(), (err) => err && err.exitCode === 0);
    assert.strictEqual(clients.length, 1, 'one client, which both SDK instances and the isolated reader share');
    assert.ok(clients[0] && isBudget(clients[0].throttle), 'and it is made with the run\'s budget');
    assert.strictEqual(engines.length, 1);
    assert.strictEqual(engines[0].throttle, clients[0].throttle, 'the engine\'s pages phase spends from the very same one');
    // What the budget says goes to stderr — stdout carries the JSON result.
    clients[0].throttle.announce('a long wait', 60000);
    assert.deepStrictEqual(cli.stderr.filter((line) => /a long wait/.test(line)), ['⚠ a long wait\n']);
    assert.deepStrictEqual(cli.stdout.filter((line) => /a long wait/.test(line)), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
