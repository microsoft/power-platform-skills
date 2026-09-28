'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'create-connection-reference.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('posts to connectionreferences', () => {
  assert.match(scriptSrc, /connectionreferences/);
});

test('binds connectorid and logical name', () => {
  assert.match(scriptSrc, /connectionreferencelogicalname/);
  assert.match(scriptSrc, /connectorid/);
});

test('missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('the rollback switch still works end to end (exit 3 before any Dataverse call)', () => {
  const res = spawnSync(
    process.execPath,
    [scriptPath, 'https://contoso.crm.dynamics.com', 'new_x', '/providers/Microsoft.PowerApps/apis/shared_x'],
    { encoding: 'utf8', env: { ...process.env, GENPAGE_ENABLE_CONNECTORS: '0' } }
  );
  assert.equal(res.status, 3);
  assert.match(res.stderr, /disabled/i);
});

// --- Wire-level contract ----------------------------------------------------

const { loadCli } = require('./helpers/cli-harness.js');
const ENV = 'https://contoso.crm.dynamics.com';
const SP = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';

function harness({ argv, response }) {
  const calls = [];
  const emitted = [];
  const real = require('../lib/dataverse-auth.js');
  const authStub = {
    parseArgs: real.parseArgs,
    validateFlags: real.validateFlags,
    ensureOk: (res, what) => {
      if (!res || res.status < 200 || res.status >= 300) throw new Error(`${what} failed: ${res && res.status}`);
    },
    emitResult: (ok, payload) => { emitted.push({ ok, payload }); },
    dataverseRequest: async (envUrl, method, p, body, opts) => {
      calls.push({ envUrl, method, path: p, body, opts });
      return response || { status: 204, headers: {}, data: {} };
    },
  };
  const cli = loadCli(scriptPath, { requires: { './lib/dataverse-auth': authStub }, argv });
  return { cli, calls, emitted };
}

test('POSTs the connection reference with logical name, display name and connector id', async () => {
  const { cli, calls } = harness({
    argv: [ENV, 'new_sp', SP, '--display-name', 'Team Docs'],
    response: { status: 204, headers: { 'odata-entityid': `${ENV}/api/data/v9.2/connectionreferences(11111111-2222-3333-4444-555555555555)` }, data: {} },
  });
  await cli.main();
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, 'connectionreferences');
  assert.deepEqual(calls[0].body, {
    connectionreferencelogicalname: 'new_sp',
    connectionreferencedisplayname: 'Team Docs',
    connectorid: SP,
  });
  // includeHeaders is required: the new row's id only comes back on the OData-EntityId header.
  assert.equal(calls[0].opts.includeHeaders, true);
});

test('the display name defaults to the logical name when not supplied', async () => {
  const { cli, calls } = harness({ argv: [ENV, 'new_sp', SP] });
  await cli.main();
  assert.equal(calls[0].body.connectionreferencedisplayname, 'new_sp');
});

test('--connection-id binds immediately; omitting it leaves the ref unbound for ALM to fill', async () => {
  const bound = harness({ argv: [ENV, 'new_sp', SP, '--connection-id', 'conn-1'] });
  await bound.cli.main();
  assert.equal(bound.calls[0].body.connectionid, 'conn-1');

  const unbound = harness({ argv: [ENV, 'new_sp', SP] });
  await unbound.cli.main();
  // Absent, not null/empty: a deployment-settings import supplies the target-env ConnectionId, and
  // sending an explicit null would overwrite that.
  assert.ok(!Object.prototype.hasOwnProperty.call(unbound.calls[0].body, 'connectionid'));
});

test('the new row id is parsed from the OData-EntityId header, in either header casing', async () => {
  // Dataverse returns:  OData-EntityId: https://org/api/data/v9.2/connectionreferences(<guid>)
  // Node lower-cases response headers, but the raw casing shows up through some transports, so
  // both spellings must resolve or the caller silently gets connectionReferenceId: null.
  for (const key of ['odata-entityid', 'OData-EntityId']) {
    const { cli, emitted } = harness({
      argv: [ENV, 'new_sp', SP],
      response: { status: 204, headers: { [key]: `${ENV}/api/data/v9.2/connectionreferences(11111111-2222-3333-4444-555555555555)` }, data: {} },
    });
    await cli.main();
    assert.equal(emitted[0].ok, true);
    assert.equal(emitted[0].payload.connectionReferenceId, '11111111-2222-3333-4444-555555555555', `casing: ${key}`);
    assert.equal(emitted[0].payload.logicalName, 'new_sp');
  }
});

test('a missing or unparseable entity header yields a null id rather than a crash', async () => {
  for (const headers of [{}, { 'odata-entityid': 'not-a-url' }]) {
    const { cli, emitted } = harness({ argv: [ENV, 'new_sp', SP], response: { status: 204, headers, data: {} } });
    await cli.main();
    assert.equal(emitted[0].ok, true, 'the row WAS created — only its id is unknown');
    assert.equal(emitted[0].payload.connectionReferenceId, null);
  }
});

test('a non-2xx create is reported as a failure, not a success with a null id', async () => {
  const { cli, emitted } = harness({
    argv: [ENV, 'new_sp', SP],
    response: { status: 400, headers: {}, data: { error: { message: 'duplicate logical name' } } },
  });
  await cli.main();
  assert.equal(emitted[0].ok, false);
});
