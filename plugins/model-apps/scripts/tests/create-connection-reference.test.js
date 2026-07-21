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
  // Enable connectors so the run reaches arg validation instead of the feature gate.
  const res = spawnSync(process.execPath, [scriptPath], {
    encoding: 'utf8',
    env: { ...process.env, GENPAGE_ENABLE_CONNECTORS: '1' },
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('exits 3 with a disabled message when the connectors flag is OFF', () => {
  // Gate runs before any Dataverse call, so complete args still bail out early.
  const res = spawnSync(
    process.execPath,
    [scriptPath, 'https://example.crm.dynamics.com', 'new_x', '/providers/Microsoft.PowerApps/apis/shared_x'],
    { encoding: 'utf8', env: { ...process.env, GENPAGE_ENABLE_CONNECTORS: '0' } }
  );
  assert.equal(res.status, 3);
  assert.match(res.stderr, /disabled/i);
});
