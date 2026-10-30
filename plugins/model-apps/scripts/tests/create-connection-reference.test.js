'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadCli } = require('./helpers/cli-harness.js');
const { createConfigOrg } = require('./helpers/fake-config-org.js');

const scriptPath = path.join(__dirname, '..', 'create-connection-reference.js');
const preloadPath = path.join(__dirname, 'helpers', 'fake-connection-reference-preload.js');
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';
const SQL = '/providers/Microsoft.PowerApps/apis/shared_sql';

test('missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

// --- The CLI over the fake org, through the SDK -------------------------------------------------------------------
// The CLI runs as written; only the az-token HTTP client is swapped for one over the fake org, and the raw request
// helper the script used to POST with is a tripwire: every write must go through the SDK.

const EXITED = Symbol('exited');
const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function harness({ org = createConfigOrg({ solution: { uniqueName: 'ContosoSol', version: '1.0.0.0', prefix: 'contoso' } }), answer } = {}) {
  const emitted = [];
  const realAuth = require('../lib/dataverse-auth.js');
  const realHttp = require('../lib/sdk-http-client.js');
  const authStub = {
    ...realAuth,
    dataverseRequest: async () => { throw new Error('the CLI must not send a raw Dataverse request'); },
    emitResult: (ok, payload) => { emitted.push({ ok, payload }); throw EXITED; },
  };
  // `answer(request, send)` may answer a request itself; `send()` hands it to the org (and commits it there).
  const request = async (req) => {
    const where = new URL(req.url).pathname.replace(/^\/api\/data\/v9\.\d/, '');
    const send = () => org.request(req);
    return answer ? answer({ method: String(req.method).toUpperCase(), path: where }, send) : send();
  };
  const httpStub = {
    ...realHttp,
    createAzHttpClient: (env, deps = {}) => realHttp.createAzHttpClient(org.origin, { ...deps, getToken: () => 'test-token-0123456789abcdef', request, sleep: async () => {} }),
  };
  const run = async (...argv) => {
    const cli = loadCli(scriptPath, { requires: { './lib/dataverse-auth.js': authStub, './lib/sdk-http-client.js': httpStub }, argv: [org.origin, ...argv] });
    const mark = org.requests.length;
    const before = emitted.length;
    try {
      await cli.main();
    } catch (err) {
      if (err !== EXITED && !(err && err.exitCode !== undefined)) throw err;
    }
    return { cli, emit: emitted[before], writes: org.writes(mark), requests: org.requests.slice(mark) };
  };
  return { org, run };
}

// A recorded path keeps its query (the SDK asks for the created row back, e.g. `/connectionreferences?$select=...`).
const posts = (requests) => requests.filter((r) => r.method === 'POST' && r.path.replace(/\?.*$/, '') === '/connectionreferences');
const header = (headers, name) => Object.entries(headers || {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

test('creates the reference through the SDK, prints only the id and logical name, and never sends a connection it was not given', async () => {
  const { org, run } = harness();
  const { emit, writes, requests } = await run('new_sp', SP);
  assert.deepEqual(writes, ['POST /connectionreferences']);
  const [post] = posts(requests);
  const [row] = org.rows('connectionreferences');
  // The create carries the row id it is made with, so a lost answer can still name the row to look for.
  assert.deepEqual(post.body, { connectionreferenceid: row.connectionreferenceid, connectionreferencelogicalname: 'new_sp', connectionreferencedisplayname: 'new_sp', connectorid: SP });
  // Absent, not null: an ALM import fills the target environment's ConnectionId, and an explicit null would clear it.
  assert.ok(!Object.hasOwn(post.body, 'connectionid'));
  assert.equal(emit.ok, true);
  assert.deepEqual(emit.payload, { ok: true, connectionReferenceId: row.connectionreferenceid, logicalName: 'new_sp' });
  assert.deepEqual(org.unexpected, []);
});

test('--display-name and --connection-id are sent with the create', async () => {
  const { run } = harness();
  const { requests, emit } = await run('new_sp', SP, '--display-name', 'Team Docs', '--connection-id', 'conn-1');
  const [post] = posts(requests);
  assert.equal(post.body.connectionreferencedisplayname, 'Team Docs');
  assert.equal(post.body.connectionid, 'conn-1');
  assert.equal(emit.ok, true);
});

test('a reference that already exists for the same connector is reused: nothing is created twice', async () => {
  const { org, run } = harness();
  const first = await run('new_sp', SP);
  const again = await run('new_sp', SP);
  assert.deepEqual(again.writes, []);
  assert.equal(org.rows('connectionreferences').length, 1);
  assert.deepEqual(again.emit.payload, { ok: true, connectionReferenceId: first.emit.payload.connectionReferenceId, logicalName: 'new_sp' });
});

test('a reference that exists for a different connector is refused before anything is written', async () => {
  const { run } = harness();
  await run('new_sp', SQL);
  const { emit, writes } = await run('new_sp', SP);
  assert.deepEqual(writes, []);
  assert.equal(emit.ok, false);
  assert.ok(emit.payload instanceof Error);
  assert.equal(emit.payload.message, 'Create connection reference new_sp failed: a connection reference with this logical name already exists for a different connector, and its connector cannot be changed (choose another logical name). Nothing was written.');
});

test('rebinding a bound reference needs the exact --authorize token, which the refusal names', async () => {
  const { org, run } = harness();
  await run('new_sp', SP, '--connection-id', 'conn-1');
  const refused = await run('new_sp', SP, '--connection-id', 'conn-2');
  assert.deepEqual(refused.writes, []);
  assert.equal(refused.emit.ok, false);
  assert.match(refused.emit.payload.message, /run this again with --authorize connectionReference:new_sp:connectionId\. Nothing was written\.$/);
  const done = await run('new_sp', SP, '--connection-id', 'conn-2', '--authorize', 'connectionReference:new_sp:connectionId');
  assert.equal(done.emit.ok, true);
  assert.equal(done.writes.length, 1);
  assert.match(done.writes[0], /^PATCH \/connectionreferences\(/);
  assert.equal(org.rows('connectionreferences')[0].connectionid, 'conn-2');
});

test('an --authorize token that names nothing this run can ask for is a usage error, and nothing is sent', async () => {
  for (const token of ['connectionReference:new_other:connectionId', 'environmentVariable:new_x:value', 'nonsense']) {
    const { org, run } = harness();
    const { cli, emit } = await run('new_sp', SP, '--authorize', token);
    assert.equal(cli.exitCode, 1, token);
    assert.equal(emit, undefined);
    assert.match(cli.stderrText(), /--authorize: /);
    assert.equal(org.requests.length, 0, token);
  }
});

test('a logical name or connector id Dataverse would not accept is a usage error, and nothing is sent', async () => {
  for (const argv of [['bad name', SP], ['new_sp', 'shared_sharepointonline']]) {
    const { org, run } = harness();
    const { cli } = await run(...argv);
    assert.equal(cli.exitCode, 1, argv.join(' '));
    assert.match(cli.stderrText(), /Usage:/);
    assert.equal(org.requests.length, 0);
  }
});

test('--solution makes the create in that solution, and adds a reference that exists outside it', async () => {
  const { org, run } = harness();
  const created = await run('new_sp', SP, '--solution', 'ContosoSol');
  assert.equal(header(posts(created.requests)[0].headers, 'MSCRM.SolutionUniqueName'), 'ContosoSol');
  assert.equal(created.emit.ok, true);

  await run('new_other', SP);
  const added = await run('new_other', SP, '--solution', 'ContosoSol');
  assert.deepEqual(added.writes, ['POST /AddSolutionComponent']);
  assert.equal(added.emit.ok, true);
});

test('a create the server refuses keeps the established refusal line, quoting only the server message', async () => {
  const { org, run } = harness({
    answer: (r, send) => (r.method === 'POST' && r.path === '/connectionreferences'
      ? json(400, { error: { code: '0x80040203', message: 'Invalid connector id' } }) : send()),
  });
  const { emit, cli } = await run('new_sp', SP);
  assert.equal(emit.ok, false);
  assert.ok(emit.payload instanceof Error);
  assert.equal(emit.payload.message, 'Create connection reference new_sp failed: HTTP 400 — Invalid connector id');
  assert.equal(cli.stdoutText(), '');
  assert.equal(org.rows('connectionreferences').length, 0);
});

test('a create whose answer is lost is sent once and reported unknown with the row id it was sent with', async () => {
  const { org, run } = harness({
    answer: async (r, send) => {
      const answered = await send();
      return r.method === 'POST' && r.path === '/connectionreferences' ? json(503, { error: { message: 'Service unavailable' } }) : answered;
    },
  });
  const { emit, requests } = await run('new_sp', SP);
  assert.equal(posts(requests).length, 1, 'the create is never sent again after a lost answer');
  const [row] = org.rows('connectionreferences');
  assert.equal(emit.ok, false);
  assert.match(emit.payload.message, /^Create connection reference new_sp failed: the outcome is unknown \(/);
  assert.ok(emit.payload.message.includes(`connectionreferences(${row.connectionreferenceid})`));
  assert.match(emit.payload.message, /Check the environment for connection reference new_sp before running this again\.$/);
  assert.doesNotMatch(emit.payload.message, /--resolve-create|Service unavailable/);
});

test('a lookup that cannot be read sends nothing, and says an earlier write may still exist', async () => {
  const { run } = harness({
    answer: (r, send) => (r.method === 'GET' && r.path === '/connectionreferences' ? json(500, { error: { message: 'boom' } }) : send()),
  });
  const { emit, writes } = await run('new_sp', SP);
  assert.deepEqual(writes, []);
  assert.equal(emit.ok, false);
  assert.match(emit.payload.message, /^Create connection reference new_sp failed: it could not be read \([A-Z_]+\), so this run sent nothing\. A write an earlier run made may still have been saved/);
});

// --- The bytes a caller sees ------------------------------------------------------------------------------------------

function spawnCli(scenario, ...argv) {
  return spawnSync(process.execPath, ['-r', preloadPath, scriptPath, 'https://contoso.crm.dynamics.com', ...argv], {
    encoding: 'utf8',
    env: { ...process.env, CCR_FAKE_SCENARIO: JSON.stringify(scenario), POWER_PLATFORM_SKILLS_TELEMETRY_MODEL_APPS_OPTOUT: '1' },
  });
}

test('success prints exactly one JSON line on stdout and nothing on stderr', () => {
  const res = spawnCli({}, 'new_sp', SP);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  assert.match(res.stdout, /^\{"ok":true,"connectionReferenceId":"[0-9a-f-]{36}","logicalName":"new_sp"\}\n$/);
});

test('a refusal prints nothing on stdout, one line on stderr, and exits 1', () => {
  const res = spawnCli({ refuse: { status: 400, message: 'Invalid connector id' } }, 'new_sp', SP);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr, 'Create connection reference new_sp failed: HTTP 400 — Invalid connector id\n');
});

// Dataverse can echo a request header, a URL or a value back in error.message, and stderr ends up in build logs: a message
// shaped like a credential or an address, or holding a line break, is replaced by fixed text. The plain message above is kept.
test('a refusal whose server message could quote a credential or an address prints fixed text instead', () => {
  const secret = 'notarealtoken0123456789abcdef0123456789';
  const fixed = 'Create connection reference new_sp failed: HTTP 400 — the server refused the request; its message is not shown because it may quote a credential or an address\n';
  for (const message of [
    `Invalid connector; Authorization: Bearer ${secret}`,
    'Invalid connector; Authorization: Bearer abc.def',
    'See https://contoso.crm.dynamics.com/api/data/v9.2/connectionreferences for details',
    'Invalid connector for maker@contoso.onmicrosoft.com',
    'Invalid connector; sig=abc',
    `Invalid connector ${secret}`,
    'Invalid connector\r\nInjected: second line',
    `Invalid connector ${'x'.repeat(600)}`,
  ]) {
    const res = spawnCli({ refuse: { status: 400, message } }, 'new_sp', SP);
    assert.equal(res.status, 1, message);
    assert.equal(res.stdout, '', message);
    assert.equal(res.stderr, fixed, message);
  }
});

test('a reused reference prints its existing id', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const res = spawnCli({ seed: [{ connectionreferenceid: id, connectionreferencelogicalname: 'new_sp', connectionreferencedisplayname: 'new_sp', connectorid: SP }] }, 'new_sp', SP);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `{"ok":true,"connectionReferenceId":"${id}","logicalName":"new_sp"}\n`);
});
