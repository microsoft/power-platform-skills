'use strict';
// scripts/list-command-states.js end to end: the command line, then the listing through the real SDK bundle (its API root) and the plugin's
// real raw client over a fake Dataverse (helpers/command-state-org.js) — so the requests counted are the ones that would reach the wire.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const realAuth = require('../lib/dataverse-auth.js');
const realHttp = require('../lib/sdk-http-client.js');
const { listCommandStates } = require('../list-command-states.js');
const { createCommandStateOrg, commandRow, json, ORIGIN, APP_ID, OTHER_APP_ID } = require('./helpers/command-state-org.js');

const SCRIPT = path.resolve(__dirname, '..', 'list-command-states.js');
const API = `${ORIGIN}/api/data/v9.0`;
const TICKET = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORDER = 'aaaaaaaa-0000-4000-8000-000000000002';
const NOTE = 'aaaaaaaa-0000-4000-8000-000000000003';
const TABLES = { contoso_ticket: { metadataId: TICKET }, contoso_order: { metadataId: ORDER }, contoso_note: { metadataId: NOTE, inApp: false } };
const id = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROWS = [
  commandRow(id(1), 'contoso_ticket', TICKET, { buttonlabeltext: 'Escalate' }),
  commandRow(id(2), 'contoso_ticket', TICKET, { buttonlabeltext: 'Escalate', _appmoduleid_value: APP_ID, hidden: true }),
  commandRow(id(3), 'contoso_ticket', TICKET, { buttonlabeltext: 'Approve', location: 1, isdisabled: true }),
  commandRow(id(4), 'contoso_ticket', TICKET, { buttonlabeltext: 'Bulk', location: 2, _appmoduleid_value: OTHER_APP_ID }),
  commandRow(id(5), 'contoso_ticket', TICKET, { buttonlabeltext: 'Header', location: 4 }),
  commandRow(id(6), 'contoso_order', ORDER, { buttonlabeltext: 'Ship', statecode: 1, statuscode: 2 }),
  commandRow(id(7), 'contoso_note', NOTE, { buttonlabeltext: 'Pin' }),
];
const clientFor = (org) => realHttp.createAzHttpClient(ORIGIN, { getToken: () => 'test-token', request: org.request, sleep: async () => {} });

async function run(argv, org = createCommandStateOrg({ tables: TABLES, rows: ROWS })) {
  const emitted = [];
  const requires = {
    './lib/dataverse-auth.js': {
      ...realAuth,
      emitResult: (ok, payload) => {
        emitted.push({ ok, payload });
        const exit = new Error(`process.exit(${ok ? 0 : 1})`);
        exit.exitCode = ok ? 0 : 1;
        throw exit;
      },
    },
    './lib/sdk-http-client.js': { ...realHttp, createAzHttpClient: (env) => realHttp.createAzHttpClient(env, { getToken: () => 'test-token', request: org.request, sleep: async () => {} }) },
  };
  const cli = loadCli(SCRIPT, { requires, argv });
  let exitCode = 0;
  try {
    await cli.main();
  } catch (err) {
    if (typeof err.exitCode !== 'number') throw err;
    exitCode = err.exitCode;
  }
  return { org, exitCode, emitted, stdout: cli.stdoutText(), stderr: cli.stderrText(), payload: emitted.length ? emitted[0].payload : undefined };
}

// --- the command line ------------------------------------------------------------------------------------------

test('a usage error or a write flag prints nothing on stdout, names the flag on stderr, and reads nothing', async () => {
  const cases = [
    [[], /--env is required/],
    [['--env', ORIGIN], /--app is required/],
    [['--env', 'http://contoso.crm.dynamics.com', '--app', 'a'], /https/],
    [['--env', ORIGIN, '--app', 'a', '--location', 'Grid'], /--location must be one of MainTab, HomeTab, ContextualTab/],
    [['--env', ORIGIN, '--app', 'a', '--entity', 'not a table'], /--entity 'not a table' is not a table's logical name/],
    [['--env', ORIGIN, '--app', 'a', '--table', 'x'], /--table/],
    [['--env', ORIGIN, '--app', 'a', 'extra'], /unexpected argument 'extra'/],
    [['--env', ORIGIN, '--app', 'a', '--apply'], /--apply is not accepted: list-command-states only reads/],
    [['--env', ORIGIN, '--app', 'a', '--publish'], /--publish is not accepted/],
    [['--env', ORIGIN, '--app', 'a', '--authorize=overwrite:x'], /--authorize is not accepted/],
    [['--env', ORIGIN, '--app', 'a', '--yes'], /--yes is not accepted/],
  ];
  for (const [argv, message] of cases) {
    const r = await run(argv);
    assert.strictEqual(r.exitCode, 1, argv.join(' '));
    assert.strictEqual(r.stdout, '', argv.join(' '));
    assert.match(r.stderr, message, argv.join(' '));
    assert.match(r.stderr, /Usage: node scripts\/list-command-states\.js/, argv.join(' '));
    assert.deepStrictEqual(r.org.requests, [], argv.join(' '));
  }
});

test('the listing prints every button of the named table, candidates and excluded rows alike, reading only', async () => {
  const r = await run(['--env', ORIGIN, '--app', 'contoso_Support', '--entity', 'Contoso_Ticket']);
  assert.strictEqual(r.exitCode, 0, r.stderr);
  assert.strictEqual(r.emitted[0].ok, true);
  const out = r.payload;
  assert.deepStrictEqual({ app: out.app, entity: out.entity, optimisticConcurrency: out.optimisticConcurrency, tables: out.tables, count: out.count, candidates: out.candidates },
    { app: { uniqueName: 'contoso_Support', appId: APP_ID }, entity: 'contoso_ticket', optimisticConcurrency: true, tables: [{ entity: 'contoso_ticket', metadataId: TICKET, inApp: true }], count: 5, candidates: 3 });
  assert.deepStrictEqual(out.commands.map((c) => [c.bar, c.location, c.caption, c.rowId, c.scope, c.hidden, c.disabled, c.candidate, c.reasons]), [
    ['MainTab', 0, 'Escalate', id(1), 'table', false, false, true, []],
    ['MainTab', 0, 'Escalate', id(2), 'app', true, false, true, []],
    ['HomeTab', 1, 'Approve', id(3), 'table', false, true, true, []],
    ['ContextualTab', 2, 'Bulk', id(4), 'other-app', false, false, false, ['other-app']],
    ['unsupported', 4, 'Header', id(5), 'table', false, false, false, ['location-unsupported']],
  ]);
  assert.deepStrictEqual(out.commands[0].sameCaption, [id(2)]);
  assert.deepStrictEqual(out.commands[1].sameCaption, [id(1)]);
  assert.strictEqual(out.commands[2].sameCaption, undefined);
  assert.ok(r.org.requests.length > 0);
  assert.ok(r.org.requests.every((req) => req.method === 'GET'), 'only reads');
  assert.ok(r.org.requests.every((req) => req.url.startsWith(`${API}/`)), 'only the SDK\u2019s API root on the named origin');
  assert.deepStrictEqual(r.org.unexpected, []);
});

test('without --entity every table of the app is listed, and --location keeps one bar', async () => {
  const org = createCommandStateOrg({ tables: TABLES, rows: ROWS });
  const all = await listCommandStates(ORIGIN, { app: 'contoso_Support' }, clientFor(org));
  assert.deepStrictEqual(all.tables.map((t) => t.entity), ['contoso_order', 'contoso_ticket'], 'the app\u2019s tables, not every table');
  assert.deepStrictEqual(all.commands.map((c) => c.rowId), [id(6), id(1), id(2), id(3), id(4), id(5)]);
  assert.deepStrictEqual(all.commands[0].reasons, ['inactive']);
  assert.strictEqual(all.commands[0].active, false);
  const home = await listCommandStates(ORIGIN, { app: 'contoso_Support', location: 'HomeTab' }, clientFor(createCommandStateOrg({ tables: TABLES, rows: ROWS })));
  assert.deepStrictEqual([home.location, home.commands.map((c) => c.rowId)], ['HomeTab', [id(3)]]);
  // A table that is not one of the app's is listed with that reason, not silently read as if it were.
  const note = await listCommandStates(ORIGIN, { app: 'contoso_Support', entity: 'contoso_note' }, clientFor(createCommandStateOrg({ tables: TABLES, rows: ROWS })));
  assert.deepStrictEqual([note.tables[0].inApp, note.commands.map((c) => [c.rowId, c.candidate, c.reasons])], [false, [[id(7), false, ['table-not-in-app']]]]);
  assert.deepStrictEqual(org.writes(), []);
});

test('with row versions off for the table of commands no button is a candidate, and the listing says so', async () => {
  const out = await listCommandStates(ORIGIN, { app: 'contoso_Support', entity: 'contoso_ticket' }, clientFor(createCommandStateOrg({ tables: TABLES, rows: ROWS, concurrency: false })));
  assert.strictEqual(out.optimisticConcurrency, false);
  assert.strictEqual(out.candidates, 0);
  assert.ok(out.commands.every((c) => c.reasons.includes('version-unavailable')));
});

test('a failed or incomplete read prints ok:false with its code and exits 1, never an empty success', async () => {
  const cases = [
    [{ apps: [] }, 'command-state-context-unverified'],
    [{ concurrency: 'omit' }, 'command-state-version-unavailable'],
    [{ overrides: (req) => (req.path.startsWith('/appactions?') && req.path.includes('$skiptoken=2') ? json(403, { error: { code: '0x80040220', message: 'denied' } }) : undefined) }, 'command-state-row-unreadable'],
  ];
  for (const [options, code] of cases) {
    const r = await run(['--env', ORIGIN, '--app', 'contoso_Support', '--entity', 'contoso_ticket'], createCommandStateOrg({ tables: TABLES, rows: ROWS, ...options }));
    assert.strictEqual(r.exitCode, 1, code);
    assert.strictEqual(r.emitted[0].ok, false, code);
    assert.strictEqual(r.payload.ok, false, code);
    assert.strictEqual(r.payload.code, code);
    assert.strictEqual(typeof r.payload.error, 'string');
    assert.strictEqual(r.payload.commands, undefined, 'no partial list');
    assert.deepStrictEqual(r.org.writes(), []);
  }
});
