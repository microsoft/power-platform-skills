'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const planContract = require('../lib/plan-contract');

test('memoizes parsed JSON until the source file changes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-plan-contract-'));
  const filePath = path.join(root, 'contract.json');
  t.after(() => {
    planContract.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(filePath, '{"version":1}\n');

  const first = planContract.readJson(filePath);
  const cached = planContract.readJson(filePath);
  assert.strictEqual(cached, first);

  fs.writeFileSync(filePath, '{"version":2,"changed":true}\n');
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(filePath, future, future);
  const updated = planContract.readJson(filePath);
  assert.notStrictEqual(updated, first);
  assert.deepEqual(updated, { version: 2, changed: true });
});

test('supports optional text reads without caching a missing file', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-plan-contract-'));
  const filePath = path.join(root, 'native-app-plan.md');
  t.after(() => {
    planContract.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(planContract.readText(filePath, { optional: true }), null);
  fs.writeFileSync(filePath, '# Plan\n');
  assert.equal(planContract.readText(filePath, { optional: true }), '# Plan\n');
});