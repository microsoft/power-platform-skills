'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'add-page-to-solution.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('adds appmodule (80) with required components', () => {
  assert.match(scriptSrc, /APPMODULE_COMPONENT_TYPE\s*=\s*80/);
  assert.match(scriptSrc, /addComponent\([^)]*APPMODULE_COMPONENT_TYPE,\s*true\)/);
});

test('adds connection references by confirmed component type', () => {
  assert.match(scriptSrc, /connectionreferences\?\$filter=connectionreferencelogicalname/);
  assert.match(scriptSrc, /CONNECTION_REFERENCE_COMPONENT_TYPE\s*=\s*10158/);
});

test('adds the GenPage uxagentproject explicitly (type 10372)', () => {
  assert.match(scriptSrc, /UXAGENTPROJECT_COMPONENT_TYPE\s*=\s*10372/);
  assert.match(scriptSrc, /flags\['page-ids'\]/);
});

test('missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

const { connectionRefsToAdd } = require(scriptPath);

test('connection references are gated by the connectors flag (added only when ON)', () => {
  assert.deepEqual(connectionRefsToAdd(['new_a', 'new_b'], true), ['new_a', 'new_b']);
  assert.deepEqual(connectionRefsToAdd(['new_a', 'new_b'], false), []);
});
