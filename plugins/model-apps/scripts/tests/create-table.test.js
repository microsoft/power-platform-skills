'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'create-table.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('create-table.js requires schemaName with publisher prefix', () => {
  assert.match(scriptSrc, /must include a publisher prefix/);
});

test('create-table.js builds primary name attribute as IsPrimaryName: true', () => {
  assert.match(scriptSrc, /IsPrimaryName: true/);
});

test('create-table.js posts to EntityDefinitions', () => {
  assert.match(scriptSrc, /EntityDefinitions\?\$select=LogicalName/);
});

test('create-table.js: missing args prints usage and exits 1', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('create-table.js: bad schemaName (no prefix) exits 1', () => {
  const res = spawnSync(
    process.execPath,
    [scriptPath, 'https://example.crm.dynamics.com', 'NoPrefix', 'Display', 'Displays'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /publisher prefix/);
});
