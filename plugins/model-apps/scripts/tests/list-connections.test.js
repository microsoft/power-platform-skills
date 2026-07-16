'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'list-connections.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('reads connection references (ready-to-bind first)', () => {
  assert.match(scriptSrc, /connectionreferences\?\$select=connectionreferencelogicalname,connectorid,connectionid/);
  assert.match(scriptSrc, /readyToBind/);
});

test('invokes pac connection list', () => {
  assert.match(scriptSrc, /connection['"\s,]+list/);
});

test('documents raw pac output parsed', () => {
  assert.match(scriptSrc, /Connection Name/);
});

test('missing args exits 1 with usage', () => {
  // Enable connectors so the run reaches arg validation instead of the feature gate.
  const res = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CONNECTORS: '1' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('exits 3 with a disabled message when the connectors flag is OFF', () => {
  // Gate runs before any pac/Dataverse call, so a valid-looking env URL still bails.
  const res = spawnSync(process.execPath, [scriptPath, 'https://example.crm.dynamics.com'], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CONNECTORS: '0' },
  });
  assert.equal(res.status, 3);
  assert.match(res.stderr, /disabled/i);
});

// --- Unit tests for the pure helpers (require.main guard keeps main() from running) ---
const { sortReadyToBindFirst, pacFailureMessage } = require(scriptPath);

const SP_API = '/providers/Microsoft.PowerApps/apis/shared_sharepointonline';

test('readyToBind requires a connectionreference bound to THIS connection (by connectionId), not just a connectorId match', () => {
  const connections = [
    { displayName: 'Bound SP', connectionId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline/connections/aaa', connectorId: SP_API },
    { displayName: 'Unbound SP', connectionId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline/connections/bbb', connectorId: SP_API },
  ];
  const connectionReferences = [
    // bound to connection aaa via connectionId
    { logicalName: 'new_bound', connectorId: SP_API, connectionId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline/connections/aaa' },
    // same connector, but not bound to any connection (connectionId null)
    { logicalName: 'new_unbound', connectorId: SP_API, connectionId: null },
  ];
  const result = sortReadyToBindFirst(connections, connectionReferences);
  const bound = result.find((c) => c.displayName === 'Bound SP');
  const unbound = result.find((c) => c.displayName === 'Unbound SP');

  // The connection that actually has a bound connectionreference is ready to bind.
  assert.equal(bound.readyToBind, true);
  // A connection matched only by connectorId (no connectionreference bound to it) is NOT ready.
  assert.equal(unbound.readyToBind, false);
  // ...but the broader connectionReferences list still surfaces connector-id matches.
  assert.ok(unbound.connectionReferences.includes('new_bound'));
  assert.ok(unbound.connectionReferences.includes('new_unbound'));
  // Ready-to-bind connections sort first.
  assert.equal(result[0].displayName, 'Bound SP');
});

test('pacFailureMessage distinguishes a missing PAC CLI (spawn error) from a command failure', () => {
  const missing = pacFailureMessage({ error: new Error('spawn pac ENOENT'), status: null });
  assert.match(missing, /ENOENT/);
  assert.match(missing, /PATH/i);
  assert.doesNotMatch(missing, /exit null/);

  const failed = pacFailureMessage({ status: 1, stderr: 'Access denied', stdout: '' });
  assert.match(failed, /exit 1/);
  assert.match(failed, /Access denied/);
});
