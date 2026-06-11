'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateNotDefaultSolution, RESERVED_SOLUTION_NAMES } = require('../lib/validate-not-default-solution');

test('RESERVED_SOLUTION_NAMES includes Default + Active', () => {
  assert.ok(RESERVED_SOLUTION_NAMES.has('Default'));
  assert.ok(RESERVED_SOLUTION_NAMES.has('Active'));
});

test('approves a regular solution name', () => {
  const r = validateNotDefaultSolution({ bindingType: 'solution', solutionUniqueName: 'InternLearning' });
  assert.equal(r.ok, true);
  assert.equal(r.totalChecked, 1);
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.info, []);
});

test('flags Default solution as BLOCKER citing IL-008', () => {
  const r = validateNotDefaultSolution({ bindingType: 'solution', solutionUniqueName: 'Default' });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].severity, 'blocker');
  assert.equal(r.blocking[0].key, 'default-solution-binding');
  assert.equal(r.blocking[0].ref, 'IL-008');
  assert.equal(r.blocking[0].details.solutionUniqueName, 'Default');
  assert.match(r.blocking[0].remediation, /non-Default/i);
});

test('flags Active solution as BLOCKER citing IL-008', () => {
  const r = validateNotDefaultSolution({ bindingType: 'solution', solutionUniqueName: 'Active' });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].key, 'default-solution-binding');
});

test('skips with info finding when bindingType !== solution', () => {
  const r = validateNotDefaultSolution({ bindingType: 'environment' });
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.info.length, 1);
  assert.equal(r.info[0].key, 'default-solution-check-skipped');
});

test('returns info finding when bindingType=solution but name missing', () => {
  const r = validateNotDefaultSolution({ bindingType: 'solution' });
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.info.length, 1);
  assert.equal(r.info[0].key, 'default-solution-no-name');
});

test('handles empty manifest gracefully', () => {
  const r = validateNotDefaultSolution({});
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
});
