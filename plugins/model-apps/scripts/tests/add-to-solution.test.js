'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'add-to-solution.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('add-to-solution.js posts to AddSolutionComponent', () => {
  assert.match(scriptSrc, /AddSolutionComponent/);
});

test('add-to-solution.js builds canonical request body', () => {
  assert.match(scriptSrc, /ComponentId: componentId/);
  assert.match(scriptSrc, /ComponentType: componentType/);
  assert.match(scriptSrc, /SolutionUniqueName: solutionUniqueName/);
});

test('add-to-solution.js documents connection reference component type', () => {
  assert.match(scriptSrc, /10158\s*=\s*Connection Reference/);
});

test('add-to-solution.js notes uxagentproject travels via appmodule', () => {
  assert.match(scriptSrc, /uxagentproject/i);
});

test('add-to-solution.js: missing args exits 1 with usage', () => {
  const res = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage:/);
});

test('add-to-solution.js: non-numeric componentType exits 1', () => {
  const res = spawnSync(
    process.execPath,
    [scriptPath, 'https://example.crm.dynamics.com', 'MySolution', 'guid', 'not-a-number'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /componentType must be a number/);
});
