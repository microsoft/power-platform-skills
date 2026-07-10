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
