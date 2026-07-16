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
