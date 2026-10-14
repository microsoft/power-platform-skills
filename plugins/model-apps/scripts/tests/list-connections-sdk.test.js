'use strict';
// scripts/list-connections.js, the SDK's side: connections come from the bundled SDK first, as the same rows PAC's listing gives, beside the
// Dataverse connection references — and PAC is not asked unless the SDK refuses (tests/list-connections.test.js drives PAC's side, with an SDK
// that refuses; tests/connectivity-real-bundle.test.js drives the real bundle and the real script in a process).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadCli } = require('./helpers/cli-harness.js');
const realAuth = require('../lib/dataverse-auth.js');
const { connectivity, connectivityRefusal } = require('../lib/sdk-first.js');

const scriptPath = path.join(__dirname, '..', 'list-connections.js');
const { connectionRowFromSdk, parsePacConnectionList, pacFailureMessage } = require(scriptPath);

const ENV = 'https://contoso.crm.dynamics.com';
const SQL = '/providers/Microsoft.PowerApps/apis/shared_sql';
const WEATHER = '/providers/Microsoft.PowerApps/apis/shared_msnweather';
const ID = (n) => String(n).padStart(32, '0');

// What the SDK's `listConnections()` returns: its ConnectionInfo rows.
const sdkConnection = (n, displayName, connectorId, extra = {}) => ({
  connectionId: ID(n),
  displayName,
  connectorId,
  connectorName: connectorId.split('/').pop(),
  statuses: ['Connected'],
  ...extra,
});

// Runs main(). `sdkFirst` is what answers the plan; the others record whatever the script must not touch. `spawn` answers `pac connection list` when
// a test lets the fallback run (by default pac must not be started).
async function drive({ argv = [ENV], sdkFirst, refs = { status: 200, data: { value: [] } }, spawn } = {}) {
  const emitted = [];
  const queries = [];
  const asked = [];
  const spawned = [];
  const cli = loadCli(scriptPath, {
    argv,
    requires: {
      './lib/process-runner.js': {
        spawnResultTree: (...args) => {
          spawned.push(args);
          if (!spawn) return Promise.reject(new Error('pac must not be started'));
          return Promise.resolve(spawn(...args));
        },
      },
      './lib/sdk-first.js': {
        connectivity,
        sdkFirst: async (env, plan) => { asked.push({ env, plan }); return sdkFirst(env, plan); },
      },
      './lib/dataverse-auth': {
        parseArgs: realAuth.parseArgs,
        validateFlags: realAuth.validateFlags,
        ensureOk: realAuth.ensureOk,
        requireDataverseOrigin: realAuth.requireDataverseOrigin,
        dataverseRequest: async (envUrl, method, apiPath) => { queries.push({ envUrl, method, apiPath }); return refs; },
        emitResult: (ok, payload) => { emitted.push({ ok, payload }); },
      },
    },
  });
  await cli.main();
  return { emitted, queries, asked, spawned };
}

test('the SDK\'s connections are the answer: source "sdk", no fallback, PAC never started, and the rows are PAC\'s rows with readiness added', async () => {
  const run = await drive({
    sdkFirst: async () => ({ source: 'sdk', value: [sdkConnection(1, 'Zulu SQL', SQL), sdkConnection(2, 'Alpha Weather', WEATHER)].map(connectionRowFromSdk) }),
    refs: { status: 200, data: { value: [{ connectionreferencelogicalname: 'new_weather', connectorid: WEATHER, connectionid: ID(2) }] } },
  });
  assert.deepEqual(run.spawned, []);
  assert.equal(run.emitted.length, 1);
  assert.deepEqual(run.emitted[0], {
    ok: true,
    payload: {
      ok: true,
      connections: [
        { connectorId: WEATHER, connectionId: ID(2), displayName: 'Alpha Weather', readyToBind: true, connectionReferences: ['new_weather'] },
        { connectorId: SQL, connectionId: ID(1), displayName: 'Zulu SQL', readyToBind: false, connectionReferences: [] },
      ],
      connectionReferences: [{ logicalName: 'new_weather', connectorId: WEATHER, connectionId: ID(2) }],
      connectionsSource: 'sdk',
    },
  });
  assert.deepEqual(Object.keys(run.emitted[0].payload), ['ok', 'connections', 'connectionReferences', 'connectionsSource'], 'no connectionsFallback key when the SDK answered');
});

test('an environment with no connections is an empty SDK listing — a real answer — and the references are still read', async () => {
  const run = await drive({ sdkFirst: async () => ({ source: 'sdk', value: [] }) });
  assert.deepEqual(run.emitted[0].payload, { ok: true, connections: [], connectionReferences: [], connectionsSource: 'sdk' });
  assert.equal(run.queries.length, 1);
});

test('the listing and the references are read for the validated origin — the SDK is given the plan, with the connectivity rule — and the references only after the listing', async () => {
  const order = [];
  const cliRun = await drive({
    argv: [`${ENV}/`],
    sdkFirst: async (env) => { order.push(`listing:${env}`); return { source: 'sdk', value: [] }; },
  });
  const [call] = cliRun.asked;
  assert.equal(call.env, ENV, 'the origin, not the text the caller typed');
  assert.equal(cliRun.queries[0].envUrl, ENV);
  assert.equal(cliRun.queries[0].apiPath, 'connectionreferences?$select=connectionreferencelogicalname,connectorid,connectionid');
  assert.equal(call.plan.refusal, connectivityRefusal, 'the SDK\'s connectivity refusals decide when PAC is asked');
  assert.deepEqual({ ...call.plan.sdkOptions }, { connectivity: true });
  assert.equal(typeof call.plan.preflight, 'function');
  assert.equal(typeof call.plan.fromPac, 'function');
  assert.deepEqual(order, [`listing:${ENV}`]);
});

test('the SDK read the plan carries lists the connections and maps each to PAC\'s row', async () => {
  const run = await drive({ sdkFirst: async () => ({ source: 'sdk', value: [] }) });
  const rows = await run.asked[0].plan.fromSdk({ listConnections: async () => [sdkConnection(7, '  Contoso SQL  ', SQL)] });
  assert.deepEqual(rows, [{ connectorId: SQL, connectionId: ID(7), displayName: 'Contoso SQL' }]);
});

test('connectionRowFromSdk gives the row PAC\'s own listing gives for the same connection — same fields, same values', () => {
  // `pac connection list` prints a grid (live capture, PAC CLI 2.12.2; every value here is synthetic): Id, Name, API Id, Status.
  const grid = [
    'Connected as [maker001]',
    'Id                               Name        API Id                                                Status',
    `${ID(1)} Contoso SQL  ${SQL}                  Connected`,
    `${ID(2)} weather      ${WEATHER}     Connected`,
    '',
  ].join('\r\n');
  const fromPac = parsePacConnectionList(grid);
  const fromSdk = [sdkConnection(1, 'Contoso SQL', SQL), sdkConnection(2, 'weather', WEATHER)].map(connectionRowFromSdk);
  assert.deepEqual(fromSdk, fromPac);
  assert.deepEqual(Object.keys(fromSdk[0]), Object.keys(fromPac[0]), 'the same fields in the same order');
  assert.ok(!('statuses' in fromSdk[0]) && !('connectorName' in fromSdk[0]), 'the SDK\'s extras are not part of the row');
});

test('a name is trimmed and an empty one falls back to the connector, exactly as for a PAC row', () => {
  assert.equal(connectionRowFromSdk(sdkConnection(1, '   ', SQL)).displayName, SQL);
  assert.equal(connectionRowFromSdk(sdkConnection(1, '', SQL)).displayName, SQL);
  assert.equal(connectionRowFromSdk(sdkConnection(1, ' Contoso ', SQL)).displayName, 'Contoso');
});

test('a failure of the SDK that is not a refusal fails the script — nothing else is read, and PAC is not started — and an error that carries a code prints it, whoever raised it', async () => {
  const failure = Object.assign(new Error('HTTP 403 from https://api.bap.microsoft.com/x: forbidden'), { code: 'CONNECTION_ERROR', statusCode: 403 });
  const run = await drive({ sdkFirst: async () => { throw failure; } });
  assert.deepEqual(run.emitted, [{ ok: false, payload: { ok: false, error: failure.message, code: 'CONNECTION_ERROR' } }]);
  assert.deepEqual(run.queries, [], 'the references are not read after a failed listing');
  assert.deepEqual(run.spawned, []);
});

test('every failure is one ok:false line — the SDK\'s own read with its code, any other without one — and the line is pure ASCII', async () => {
  const { ConnectionError, InvalidArgumentError } = require('../lib/maker-sdk.js');
  const forbidden = new ConnectionError('https://api.bap.microsoft.com/x', 403, 'forbidden');
  const run = await drive({ sdkFirst: async () => { throw forbidden; } });
  assert.deepEqual(run.emitted, [{ ok: false, payload: { ok: false, error: forbidden.message, code: 'CONNECTION_ERROR' } }]);
  assert.match(run.emitted[0].payload.error, /^HTTP 403 from https:\/\/api\.bap\.microsoft\.com\/x: forbidden$/);
  const other = await drive({ sdkFirst: async () => { throw new InvalidArgumentError('listConnections: bad input'); } });
  assert.equal(other.emitted[0].payload.code, 'INVALID_ARGUMENT');
  // Every other failure has no code, and is printed all the same: the message, as an ok:false line.
  const plain = new Error('pac connection list failed (exit 1)');
  const pac = await drive({ sdkFirst: async () => { throw plain; } });
  assert.deepEqual(pac.emitted, [{ ok: false, payload: { ok: false, error: plain.message } }]);
});

test('failureLine: one ok:false line for whatever was thrown — its message, and its code only when that is a non-empty string', () => {
  const { failureLine } = require(scriptPath);
  const { ConnectionError } = require('../lib/maker-sdk.js');
  assert.deepEqual(failureLine(new Error('boom')), { ok: false, error: 'boom' });
  assert.deepEqual(failureLine(Object.assign(new Error('boom'), { code: 'X_CODE' })), { ok: false, error: 'boom', code: 'X_CODE' });
  for (const code of [undefined, null, '', 42, {}, true]) assert.deepEqual(failureLine(Object.assign(new Error('boom'), { code })), { ok: false, error: 'boom' }, String(code));
  assert.deepEqual(failureLine(new ConnectionError('https://api.bap.microsoft.com/x', 500, 'down')), { ok: false, error: 'HTTP 500 from https://api.bap.microsoft.com/x: down', code: 'CONNECTION_ERROR' });
  assert.deepEqual(Object.keys(failureLine(Object.assign(new Error('boom'), { code: 'X_CODE' }))), ['ok', 'error', 'code']);
  // What is not an Error is still reported, and never as an empty message.
  assert.deepEqual(failureLine('plain text'), { ok: false, error: 'plain text' });
  assert.deepEqual(failureLine(new Error('')), { ok: false, error: 'Error' });
  assert.deepEqual(failureLine(undefined), { ok: false, error: 'undefined' });
  assert.deepEqual(failureLine(null), { ok: false, error: 'null' });
  assert.deepEqual(failureLine({ message: 'from an object', code: 'C' }), { ok: false, error: 'from an object', code: 'C' });
});

test('an environment that is not a Dataverse origin is refused before the SDK, PAC or Dataverse is touched — and is reported as an ok:false line, with no code', async () => {
  for (const bad of ['https://contoso.example.com', 'http://contoso.crm.dynamics.com', 'https://contoso.crm.dynamics.com/api/data/v9.2', 'contoso']) {
    const run = await drive({ argv: [bad], sdkFirst: async () => { throw new Error('the SDK must not be asked'); } });
    assert.equal(run.asked.length, 0, bad);
    assert.equal(run.spawned.length, 0, bad);
    assert.equal(run.queries.length, 0, bad);
    assert.equal(run.emitted[0].ok, false, bad);
    assert.equal(run.emitted[0].payload.ok, false, bad);
    assert.match(run.emitted[0].payload.error, /is not a Dataverse environment URL/, bad);
    assert.ok(!('code' in run.emitted[0].payload), bad);
  }
});

test('a PAC listing carries its source and the SDK\'s reason, beside the same rows', async () => {
  const refusal = { code: 'CONNECTIVITY_ROUTE_DECOMMISSIONED', message: 'decommissioned' };
  const run = await drive({
    sdkFirst: async () => ({ source: 'pac', value: [{ connectorId: SQL, connectionId: ID(1), displayName: 'Contoso SQL' }], fallback: refusal }),
  });
  assert.deepEqual(run.emitted[0].payload, {
    ok: true,
    connections: [{ connectorId: SQL, connectionId: ID(1), displayName: 'Contoso SQL', readyToBind: false, connectionReferences: [] }],
    connectionReferences: [],
    connectionsSource: 'pac',
    connectionsFallback: refusal,
  });
  assert.deepEqual(Object.keys(run.emitted[0].payload), ['ok', 'connections', 'connectionReferences', 'connectionsSource', 'connectionsFallback']);
});

test('the pac listing is given the read budget — a fixed three minutes, as every other pac fallback — and a pac that runs out of it is reported as that, not as a missing pac', async () => {
  const refusal = { code: 'CONNECTIVITY_ROUTE_DECOMMISSIONED', message: 'decommissioned' };
  const timedOut = { status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: Object.assign(new Error('spawn pac ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
  const run = await drive({
    sdkFirst: async (env, plan) => ({ source: 'pac', value: await plan.fromPac(refusal), fallback: refusal }),
    spawn: () => timedOut,
  });
  assert.equal(run.spawned.length, 1);
  assert.deepEqual(run.spawned[0].slice(0, 2), ['pac', ['connection', 'list', '--environment', ENV]], 'the call PAC has always been given, pinned to the environment asked about');
  assert.equal(run.spawned[0][2].timeout, 180000);
  assert.deepEqual(run.spawned[0][2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(run.emitted[0].ok, false);
  assert.match(run.emitted[0].payload.error, /^pac connection list did not finish within 180 s; pac and every process that held its output were stopped\. A stalled call is usually transient, or pac is waiting for a sign-in/);
  assert.doesNotMatch(run.emitted[0].payload.error, /could not run|Ensure the PAC CLI is installed/);
  assert.deepEqual(run.queries, [], 'the references are not read after a failed listing');

  // The other launch failure keeps its words (a missing pac says how to install it).
  assert.match(pacFailureMessage({ error: Object.assign(new Error('spawn pac ENOENT'), { code: 'ENOENT' }), status: null }), /^pac connection list could not run: spawn pac ENOENT\. Ensure the PAC CLI is installed/);
});

test('a pac listing that ran out of time says what the runner confirmed: "pac and every process that held its output were stopped" for an ending it confirmed, and that a process it started may still be running for one that it did not', () => {
  const ended = (containment, pid) => ({ status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: Object.assign(new Error('spawn pac ETIMEDOUT'), { code: 'ETIMEDOUT', containment, pid }) });
  assert.match(pacFailureMessage(ended('confirmed', 7)), /^pac connection list did not finish within 180 s; pac and every process that held its output were stopped\. A stalled call is usually transient/);
  assert.match(pacFailureMessage(ended(undefined, undefined)), /^pac connection list did not finish within 180 s; pac and every process that held its output were stopped\./, 'an error that says nothing of containment reads as it always did');
  const unconfirmed = pacFailureMessage(ended('unconfirmed', 7));
  assert.match(unconfirmed, /^pac connection list did not finish within 180 s; pac was asked to stop, but a process it started still held its output when the wait for it ended, so it may still be running \(pac was started as process 7, which has exited; what it started is not known by id\)\. End any leftover pac process/);
  assert.match(unconfirmed, /pac is waiting for a sign-in \(`pac auth list` shows the profile it uses\): run it again\.$/);
  assert.doesNotMatch(unconfirmed, /stopped/);
});
