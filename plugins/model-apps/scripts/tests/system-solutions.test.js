'use strict';
// Coverage for the shared built-in-solutions constant used by BOTH download recovery (exclude these
// when picking an app's real solution) and teardown (never attempt to delete these — Dataverse 400s).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { RESTRICTED_SOLUTION_UNIQUENAMES, isRestrictedSolution } = require(path.join(__dirname, '..', 'lib', 'system-solutions.js'));

test('RESTRICTED_SOLUTION_UNIQUENAMES holds the built-in system solutions (lower-cased)', () => {
  assert.ok(RESTRICTED_SOLUTION_UNIQUENAMES.has('default'));
  assert.ok(RESTRICTED_SOLUTION_UNIQUENAMES.has('active'));
  assert.ok(RESTRICTED_SOLUTION_UNIQUENAMES.has('basic'));
});

test('isRestrictedSolution is case-insensitive and null/non-string safe', () => {
  assert.strictEqual(isRestrictedSolution('Default'), true);
  assert.strictEqual(isRestrictedSolution('ACTIVE'), true);
  assert.strictEqual(isRestrictedSolution('Basic'), true);
  assert.strictEqual(isRestrictedSolution('NucleoLive2'), false);
  assert.strictEqual(isRestrictedSolution(''), false);
  assert.strictEqual(isRestrictedSolution(null), false);
  assert.strictEqual(isRestrictedSolution(undefined), false);
  assert.strictEqual(isRestrictedSolution(123), false);
});
