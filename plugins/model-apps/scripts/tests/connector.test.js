'use strict';
// scripts/connector.js — what a connector offers: the CLI contract (flags, refusals), the pac commands it falls back to, which form is whose,
// and what it prints. The SDK and pac are stood in for; tests/connectivity-real-bundle.test.js drives the real bundle and the real script.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const realAuth = require('../lib/dataverse-auth.js');
const realPac = require('../lib/pac-fallback.js');
const { connectivity, connectivityRefusal } = require('../lib/sdk-first.js');

const SCRIPT = path.resolve(__dirname, '..', 'connector.js');
const { readRequest, pacArgs, answer, describeFailure, connectorShortName } = require(SCRIPT);

const ENV = 'https://contoso.crm.dynamics.com';
const CONNECTION = '00000000000000000000000000000001';
const ops = (...flags) => ['operations', '--env', ENV, '--connector-id', 'shared_office365users', '--connection-id', CONNECTION, ...flags];
const schema = (...flags) => ['schema', '--env', ENV, '--connector-id', 'shared_office365users', '--connection-id', CONNECTION, ...flags];

// --- the contract -----------------------------------------------------------------------------------------------------------------

test('each of the three questions is one request: its form, the environment\'s origin, the connector\'s short name and the connection', () => {
  const base = { env: ENV, connector: 'shared_office365users', connectionId: CONNECTION };
  assert.deepStrictEqual(readRequest(ops()), { request: { ...base, form: 'operations' } });
  assert.deepStrictEqual(readRequest(schema('--operation', 'MyProfile_V2')), { request: { ...base, form: 'operation', operation: 'MyProfile_V2' } });
  assert.deepStrictEqual(
    readRequest(schema('--dataset', 'https://contoso.sharepoint.com/sites/pets', '--table', '3f2a0c5e-1111-4222-8333-444455556666')),
    { request: { ...base, form: 'table', dataset: 'https://contoso.sharepoint.com/sites/pets', table: '3f2a0c5e-1111-4222-8333-444455556666' } }
  );
});

test('the environment is used as its origin, and the connector by its short name whichever way it was written', () => {
  assert.strictEqual(readRequest(['operations', '--env', `${ENV}/`, '--connector-id', 'shared_sql', '--connection-id', CONNECTION]).request.env, ENV);
  for (const written of ['shared_sql', '/providers/Microsoft.PowerApps/apis/shared_sql', '/PROVIDERS/microsoft.powerapps/APIS/shared_sql']) {
    assert.strictEqual(readRequest(['operations', '--env', ENV, '--connector-id', written, '--connection-id', CONNECTION]).request.connector, 'shared_sql', written);
  }
  assert.strictEqual(connectorShortName('shared_office365users'), 'shared_office365users');
  assert.strictEqual(connectorShortName('/providers/Microsoft.PowerApps/apis/shared_x'), 'shared_x');
});

test('a command is required, and is one of the two', () => {
  assert.match(readRequest([]).error, /a command is required: operations or schema/);
  assert.match(readRequest(['list']).error, /unknown command 'list': use operations or schema/);
  assert.match(readRequest(['--env', ENV, 'operations']).error, /unknown command '--env'/);
});

test('an unknown flag is a usage error with the nearest name, not a token silently swallowed', () => {
  assert.match(readRequest(ops('--envv', ENV)).error, /unknown flag\(s\): --envv \(did you mean --env\?\)/);
  assert.match(readRequest(['operations', '--env', ENV, '--connector-id', 'shared_x', '--connection_id', CONNECTION]).error, /unknown flag\(s\): --connection_id \(did you mean --connection-id\?\)/);
  // The pac spelling of the environment flag is not this script's: nothing is dropped silently, and the value after it is not taken for another flag's.
  assert.match(readRequest(ops('--environment', ENV)).error, /unknown flag\(s\): --environment/);
  assert.match(readRequest(['operations', '--env', ENV, '--connector-id', 'shared_x', '--connectionid', 'x']).error, /unknown flag\(s\): --connectionid/);
});

test('every flag needs a value, and the three that every form needs are required', () => {
  assert.match(readRequest(['operations', '--env']).error, /--env requires a value/);
  assert.match(readRequest(['operations', '--env', ENV, '--connector-id', '--connection-id', CONNECTION]).error, /--connector-id requires a value/);
  assert.match(readRequest(schema('--operation')).error, /--operation requires a value/);
  assert.match(readRequest(['operations', '--connector-id', 'shared_x', '--connection-id', CONNECTION]).error, /--env is required/);
  assert.match(readRequest(['operations', '--env', ENV, '--connection-id', CONNECTION]).error, /--connector-id is required/);
  assert.match(readRequest(['operations', '--env', ENV, '--connector-id', 'shared_x']).error, /--connection-id is required/);
  assert.match(readRequest(['operations', 'extra', '--env', ENV, '--connector-id', 'shared_x', '--connection-id', CONNECTION]).error, /unexpected argument 'extra'/);
});

test('an environment that is not a Dataverse origin is refused — it would be the SDK\'s org and the token\'s audience', () => {
  for (const bad of ['https://contoso.example.com', 'http://contoso.crm.dynamics.com', `${ENV}/api/data/v9.2`, 'contoso', `${ENV}:8443`]) {
    assert.match(readRequest(['operations', '--env', bad, '--connector-id', 'shared_x', '--connection-id', CONNECTION]).error, /is not a Dataverse environment URL/, bad);
  }
});

test('a connector id is a short name or a full API id — letters, digits, _ . - — and nothing that names another resource', () => {
  for (const bad of ['', 'shared sql', 'shared/sql', '..', '.', 'a'.repeat(129), '/providers/Microsoft.PowerApps/apis/', '/providers/Microsoft.PowerApps/apis/x/connections/y', 'shared_sql?x=1', 'shared_sql#', '%2e%2e', '\u0000x']) {
    const result = readRequest(['operations', '--env', ENV, '--connector-id', bad || ' ', '--connection-id', CONNECTION]);
    assert.ok(result.error, `${JSON.stringify(bad)} is refused`);
  }
  assert.match(readRequest(['operations', '--env', ENV, '--connector-id', 'shared sql', '--connection-id', CONNECTION]).error, /--connector-id must be a connector's short name/);
  assert.ok(!readRequest(['operations', '--env', ENV, '--connector-id', 'a'.repeat(128), '--connection-id', CONNECTION]).error);
});

test('a connection id has the shapes the plugin meets — 32 hex digits, a GUID, shared-<connector>-<guid>, a resource path — and nothing a command line would split', () => {
  for (const good of [CONNECTION, '00000000-0000-0000-0000-000000000001', 'shared-sharepointonl-00000000-0000-0000-0000-000000000001', '/providers/Microsoft.PowerApps/apis/shared_sql/connections/abc123']) {
    assert.ok(!readRequest(['operations', '--env', ENV, '--connector-id', 'shared_x', '--connection-id', good]).error, good);
  }
  for (const bad of ['a b', 'a;b', 'a"b', 'a|b', '$(x)', 'a`b', '-x', 'a&b', 'a%b', 'x'.repeat(301)]) {
    assert.match(readRequest(['operations', '--env', ENV, '--connector-id', 'shared_x', '--connection-id', bad]).error, /--connection-id must be a connection's id/, bad);
  }
});

test('operations takes none of the schema flags', () => {
  for (const [flag, value] of [['--operation', 'X'], ['--dataset', 'd'], ['--table', 't']]) {
    assert.match(readRequest(ops(flag, value)).error, new RegExp(`${flag} does not apply to operations`));
  }
});

test('schema reads one operation or one table — never both, never half a table, never nothing', () => {
  assert.match(readRequest(schema()).error, /schema needs --operation, or --dataset with --table/);
  assert.match(readRequest(schema('--operation', 'X', '--dataset', 'd')).error, /--operation cannot be combined with --dataset or --table/);
  assert.match(readRequest(schema('--operation', 'X', '--table', 't')).error, /--operation cannot be combined with --dataset or --table/);
  assert.match(readRequest(schema('--dataset', 'd')).error, /--dataset and --table go together/);
  assert.match(readRequest(schema('--table', 't')).error, /--dataset and --table go together/);
});

test('a value pac would read as a flag, a line break, or a value out of all proportion is refused', () => {
  assert.match(readRequest(schema('--operation', '-x')).error, /--operation must be an operation id/);
  assert.match(readRequest(schema('--operation', 'a\nb')).error, /--operation must be an operation id/);
  assert.match(readRequest(schema('--operation', 'x'.repeat(257))).error, /--operation must be an operation id/);
  assert.match(readRequest(schema('--operation', '   ')).error, /--operation requires a value/);
  assert.match(readRequest(schema('--dataset', '-d', '--table', 't')).error, /--dataset must be text/);
  assert.match(readRequest(schema('--dataset', 'd', '--table', 't\r\nx')).error, /--table must be text/);
  assert.match(readRequest(schema('--dataset', 'd'.repeat(1001), '--table', 't')).error, /--dataset must be text/);
  // What a real dataset or table looks like passes: a SharePoint site and list, a SQL server and table.
  assert.ok(!readRequest(schema('--dataset', 'https://contoso.sharepoint.com/sites/Pets', '--table', '3f2a0c5e-1111-4222-8333-444455556666')).error);
  assert.ok(!readRequest(schema('--dataset', 'contoso.database.windows.net,PetsDb', '--table', '[dbo].[Pets]')).error);
});

// --- the pac commands ---------------------------------------------------------------------------------------------------------------

test('each form is its own pac command, pinned to the environment it was asked about — only the two connector verbs are ever run', () => {
  const base = { env: ENV, connector: 'shared_office365users', connectionId: CONNECTION };
  const common = ['--environment', ENV, '--connector-id', 'shared_office365users', '--connection-id', CONNECTION];
  assert.deepStrictEqual(pacArgs({ ...base, form: 'operations' }), ['model', 'genpage', 'list-connector-operations', ...common]);
  assert.deepStrictEqual(pacArgs({ ...base, form: 'operation', operation: 'MyProfile_V2' }), ['model', 'genpage', 'get-connector-schema', ...common, '--operation', 'MyProfile_V2']);
  assert.deepStrictEqual(pacArgs({ ...base, form: 'table', dataset: 'ds', table: 'tb' }), ['model', 'genpage', 'get-connector-schema', ...common, '--dataset', 'ds', '--table', 'tb']);
});

// --- which form is answered from where ---------------------------------------------------------------------------------------------

const BANNER = 'Connected as maker@contoso.onmicrosoft.com\n';
const pacRunning = (stdout, extra = {}) => {
  const calls = [];
  return { calls, pac: { spawn: (name, args, options) => { calls.push({ name, args, options }); return { status: 0, stdout, stderr: '', ...extra }; } } };
};

test('operations: the SDK is asked for the connector\'s operations, by its short name — with the connectivity rule, and PAC as the refusal\'s answer', async () => {
  const seen = [];
  const sdkFirst = async (env, plan) => {
    seen.push({ env, plan });
    const sdk = { listConnectorOperations: async (connector) => ({ operations: [{ name: 'Op', summary: connector }] }) };
    return { source: 'sdk', value: await plan.fromSdk(sdk) };
  };
  const request = readRequest(['operations', '--env', ENV, '--connector-id', '/providers/Microsoft.PowerApps/apis/shared_sql', '--connection-id', CONNECTION]).request;
  const out = await answer(request, { sdkFirst });
  assert.deepStrictEqual(out, { source: 'sdk', value: { operations: [{ name: 'Op', summary: 'shared_sql' }] } });
  assert.strictEqual(seen[0].env, ENV);
  assert.strictEqual(seen[0].plan.refusal, connectivityRefusal);
  assert.strictEqual(seen[0].plan.preflight, connectivity.preflight);
  assert.deepStrictEqual({ ...seen[0].plan.sdkOptions }, { connectivity: true });
});

test('schema --operation: the SDK is asked for that operation of that connector', async () => {
  const calls = [];
  const sdkFirst = async (env, plan) => ({ source: 'sdk', value: await plan.fromSdk({ getConnectorOperationSchema: async (...args) => { calls.push(args); return { operation: 'GetOrganizations', parameters: [], response: {} }; } }) });
  const request = readRequest(schema('--operation', 'GetOrganizations')).request;
  const out = await answer(request, { sdkFirst });
  assert.deepStrictEqual(calls, [['shared_office365users', 'GetOrganizations']]);
  assert.strictEqual(out.value.operation, 'GetOrganizations');
});

test('schema --dataset --table is pac\'s alone: the SDK has no read of a tabular connector, so it is never asked, and there is no refusal to report', async () => {
  const sdkFirst = async () => { throw new Error('the SDK must not be asked about a table'); };
  const { pac, calls } = pacRunning(`${BANNER}{"table":"Pets","columns":[{"name":"Title","type":"string","required":false}]}\n`);
  const request = readRequest(schema('--dataset', 'https://contoso.sharepoint.com/sites/Pets', '--table', 'list-1')).request;
  const out = await answer(request, { sdkFirst, pac });
  assert.deepStrictEqual(out, { source: 'pac', value: { table: 'Pets', columns: [{ name: 'Title', type: 'string', required: false }] } });
  assert.deepStrictEqual(calls.map((c) => c.args), [pacArgs(request)]);
  assert.strictEqual(calls[0].name, 'pac');
});

test('when the SDK refuses, pac answers the same question: its JSON after the banner, with the refusal as the fallback', async () => {
  const refusal = { code: 'CONNECTIVITY_ROUTE_DECOMMISSIONED', message: 'the service has been switched off' };
  const { pac, calls } = pacRunning(`${BANNER}{"operations":[{"name":"GetItems","summary":"Get items"}]}\n`);
  const sdkFirst = async (env, plan) => ({ source: 'pac', value: await plan.fromPac(refusal), fallback: refusal });
  const request = readRequest(ops()).request;
  const out = await answer(request, { sdkFirst, pac });
  assert.deepStrictEqual(out, { source: 'pac', value: { operations: [{ name: 'GetItems', summary: 'Get items' }] }, fallback: refusal });
  assert.deepStrictEqual(calls[0].args, ['model', 'genpage', 'list-connector-operations', '--environment', ENV, '--connector-id', 'shared_office365users', '--connection-id', CONNECTION]);
});

test('pac\'s failures are the script\'s, each with a code of its own and the reason pac was asked — and a table has no such reason', async () => {
  const refusal = { code: 'CONNECTIVITY_CLOUD_UNSUPPORTED', message: 'GCC' };
  const viaPac = (pac, request) => answer(request, { sdkFirst: async (env, plan) => ({ source: 'pac', value: await plan.fromPac(refusal), fallback: refusal }), pac });
  const opsRequest = readRequest(ops()).request;
  const cases = [
    ['PAC_MISSING', { spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn pac ENOENT: not found on PATH'), { code: 'ENOENT' }) }) }, /could not run/],
    ['PAC_TIMEOUT', { spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }) }) }, /did not finish within/],
    ['PAC_REFUSED', { spawn: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('cannot pass "a%b" to pac.cmd: a Windows batch file cannot receive a double quote, %, a control character unchanged'), { code: 'EARGUMENT' }) }) }, /was not run, and nothing was sent to pac: cannot pass/],
    ['PAC_FAILED', { spawn: () => ({ status: 1, stdout: '', stderr: 'Error: the connection was not found' }) }, /failed \(exit 1\): Error: the connection was not found/],
    ['PAC_OUTPUT_UNREADABLE', { spawn: () => ({ status: 0, stdout: 'Warning: odd\n{"operations":[]}', stderr: '' }) }, /a line before the JSON is not pac's sign-in banner/],
    ['PAC_OUTPUT_UNREADABLE', { spawn: () => ({ status: 0, stdout: `${BANNER}{"error":"nope"}`, stderr: '' }) }, /printed JSON without an "operations" list/],
    ['PAC_OUTPUT_UNREADABLE', { spawn: () => ({ status: 0, stdout: `${BANNER}[1]`, stderr: '' }) }, /the JSON is not an object/],
  ];
  for (const [code, pac, message] of cases) {
    await assert.rejects(viaPac(pac, opsRequest), (err) => {
      assert.strictEqual(err.code, code);
      assert.match(err.message, message);
      assert.deepStrictEqual(err.fallback, refusal, 'the failure says why pac had been asked');
      return true;
    }, code);
  }
  const tableRequest = readRequest(schema('--dataset', 'd', '--table', 't')).request;
  await assert.rejects(answer(tableRequest, { pac: { spawn: () => ({ status: 1, stdout: '', stderr: 'boom' }) } }), (err) => err.code === 'PAC_FAILED' && err.fallback === undefined);
});

test('each form accepts only the JSON that is its own answer', async () => {
  const sdkFirst = async (env, plan) => ({ source: 'pac', value: await plan.fromPac(null), fallback: null });
  const tryForm = (request, json) => answer(request, { sdkFirst, pac: pacRunning(`${BANNER}${JSON.stringify(json)}`).pac });
  const operationRequest = readRequest(schema('--operation', 'X')).request;
  const tableRequest = readRequest(schema('--dataset', 'd', '--table', 't')).request;
  assert.deepStrictEqual((await tryForm(operationRequest, { operation: 'X', parameters: [], response: {} })).value.operation, 'X');
  await assert.rejects(tryForm(operationRequest, { operations: [] }), /an "operation" and a "parameters" list/);
  await assert.rejects(tryForm(operationRequest, { operation: 'X' }), /an "operation" and a "parameters" list/);
  assert.deepStrictEqual((await answer(tableRequest, { pac: pacRunning(`${BANNER}{"table":"t","columns":[]}`).pac })).value.columns, []);
  await assert.rejects(answer(tableRequest, { pac: pacRunning(`${BANNER}{"table":"t"}`).pac }), /a "columns" list/);
});

// --- what is printed ----------------------------------------------------------------------------------------------------------------

async function runCli(argv, { sdkFirst, runPac } = {}) {
  const emitted = [];
  const requires = {
    './lib/dataverse-auth.js': {
      ...realAuth,
      emitResult: (ok, payload, options) => {
        emitted.push({ ok, payload, options });
        const exit = new Error(`process.exit(${ok ? 0 : 1})`);
        exit.exitCode = ok ? 0 : 1;
        throw exit;
      },
    },
    './lib/sdk-first.js': { connectivity, sdkFirst: sdkFirst || (async () => { throw new Error('unexpected SDK read'); }) },
    './lib/pac-fallback.js': { ...realPac, runPac: runPac || (() => { throw new Error('unexpected pac run'); }) },
  };
  const cli = loadCli(SCRIPT, { requires, argv });
  let exitCode = 0;
  try {
    await cli.main();
  } catch (err) {
    if (typeof err.exitCode !== 'number') throw err;
    exitCode = err.exitCode;
  }
  return { emitted, exitCode, stdout: cli.stdoutText(), stderr: cli.stderrText() };
}

test('a usage error exits 1 with the problem and the usage on stderr, prints nothing on stdout, and reads nothing', async () => {
  const run = await runCli(['schema', '--env', ENV, '--connector-id', 'shared_x', '--connection-id', CONNECTION]);
  assert.strictEqual(run.exitCode, 1);
  assert.strictEqual(run.stdout, '');
  assert.match(run.stderr, /✗ schema needs --operation, or --dataset with --table/);
  assert.match(run.stderr, /Usage:\n {2}node scripts\/connector\.js operations/);
  assert.deepStrictEqual(run.emitted, []);
});

test('an answer is printed as pac\'s JSON plus ok and source, as ASCII; a fallback adds its reason', async () => {
  const value = { operations: [{ name: 'GetItems', summary: 'Get items \u2014 all' }] };
  const sdk = await runCli(ops(), { sdkFirst: async () => ({ source: 'sdk', value }) });
  assert.strictEqual(sdk.exitCode, 0);
  assert.deepStrictEqual(sdk.emitted[0].payload, { ok: true, operations: value.operations, source: 'sdk' });
  assert.deepStrictEqual(sdk.emitted[0].options, { ascii: true }, 'pure ASCII on stdout');

  const refusal = { code: 'CONNECTIVITY_ROUTE_DECOMMISSIONED', message: 'gone' };
  const pac = await runCli(ops(), { sdkFirst: async () => ({ source: 'pac', value, fallback: refusal }) });
  assert.deepStrictEqual(pac.emitted[0].payload, { ok: true, operations: value.operations, source: 'pac', fallback: refusal });
});

test('pac\'s own keys cannot hide the source: ok and source are the script\'s, written last', async () => {
  const run = await runCli(ops(), { sdkFirst: async () => ({ source: 'pac', value: { operations: [], source: 'pac-says-sdk', ok: false } }) });
  assert.strictEqual(run.emitted[0].payload.source, 'pac');
  assert.strictEqual(run.emitted[0].payload.ok, true);
});

test('a failure prints ok:false with the message, the code and the reason pac was asked, exits 1, and names nothing as an answer', async () => {
  const refusal = { code: 'CONNECTIVITY_CLOUD_UNSUPPORTED', message: 'GCC' };
  const failure = Object.assign(new Error('`pac model genpage list-connector-operations` failed (exit 1): boom'), { code: 'PAC_FAILED', fallback: refusal });
  const run = await runCli(ops(), { sdkFirst: async () => { throw failure; } });
  assert.strictEqual(run.exitCode, 1);
  assert.deepStrictEqual(run.emitted[0].payload, { ok: false, error: failure.message, code: 'PAC_FAILED', fallback: refusal });
  assert.deepStrictEqual(run.emitted[0].options, { ascii: true });
  assert.ok(!('operations' in run.emitted[0].payload));
  assert.deepStrictEqual(describeFailure(new Error('plain')), { ok: false, error: 'plain' });
  assert.deepStrictEqual(describeFailure(Object.assign(new Error('sdk'), { code: 'CONNECTION_ERROR' })), { ok: false, error: 'sdk', code: 'CONNECTION_ERROR' });
});
