'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'add-page-to-solution.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('adds appmodule (80) with required components', () => {
  assert.match(scriptSrc, /ComponentType: 80/);
  assert.match(scriptSrc, /AddRequiredComponents: true/);
});

test('adds connection references by confirmed component type', () => {
  assert.match(scriptSrc, /connectionreferences\?\$filter=connectionreferencelogicalname/);
  assert.match(scriptSrc, /CONNECTION_REFERENCE_COMPONENT_TYPE\s*=\s*371/);
});

test('missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});
