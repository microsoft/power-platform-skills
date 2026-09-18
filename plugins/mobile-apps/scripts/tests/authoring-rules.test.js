'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRules, validateEntityRules, generateRulesRuntime } = require('../lib/authoring-rules');

const domain = {
  entities: [{
    id: 'inspections',
    fields: [
      { id: 'result', type: 'choice', options: [{ id: 'pass' }, { id: 'fail' }] },
      { id: 'damagePhoto', type: 'photo' },
    ],
  }],
  actions: [{ id: 'save-inspection', entityId: 'inspections', operation: 'save' }],
};
const rules = {
  schemaVersion: 1,
  rules: [{
    id: 'failure-photo',
    entityId: 'inspections',
    actionId: 'save-inspection',
    when: { fieldId: 'result', operator: 'equals', value: 'fail' },
    require: { fieldId: 'damagePhoto', message: 'Add a damage photo before saving a failed inspection.' },
  }],
};
const photo = { status: 'ready', uri: 'file:///app/evidence/photo.jpg' };

test('failed inspection requires a stored photo on every create and update', () => {
  for (const operation of ['create', 'update']) {
    assert.equal(validateEntityRules(domain, rules, 'inspections', { result: 'fail' }, operation).length, 1);
    assert.deepEqual(validateEntityRules(domain, rules, 'inspections', { result: 'fail', damagePhoto: photo }, operation), []);
    assert.deepEqual(validateEntityRules(domain, rules, 'inspections', { result: 'pass' }, operation), []);
  }
});

test('cancelled capture and unsuccessful upload never count as ready evidence', () => {
  for (const damagePhoto of [
    null, '', [], { ...photo, status: 'cancelled' }, { ...photo, status: 'pending' },
    { ...photo, status: 'failed' }, { status: 'ready', uri: '' }, { status: 'ready', uri: 'javascript:alert(1)' },
    [photo, { ...photo, status: 'pending' }],
  ]) {
    assert.equal(validateEntityRules(domain, rules, 'inspections', { result: 'fail', damagePhoto }, 'create').length, 1);
  }
});

test('updating another field preserves an existing stored photo without rewriting history', () => {
  const original = { id: 'inspection-1', result: 'fail', damagePhoto: photo };
  const merged = { ...original, note: 'Reviewed' };
  assert.deepEqual(validateEntityRules(domain, rules, 'inspections', merged, 'update'), []);
  assert.equal(original.damagePhoto, photo);
  assert.deepEqual(validateEntityRules(domain, rules, 'other-entity', { result: 'fail' }, 'create'), []);
});

test('rules must bind declared actions, fields, and exact choice IDs', () => {
  const rule = rules.rules[0];
  for (const changed of [
    { ...rule, actionId: 'unknown' },
    { ...rule, entityId: 'unknown' },
    { ...rule, when: { ...rule.when, fieldId: 'unknown' } },
    { ...rule, when: { ...rule.when, value: 'FAILED' } },
    { ...rule, expression: 'eval(input)' },
  ]) {
    assert.throws(() => validateRules(domain, { schemaVersion: 1, rules: [changed] }));
  }
  assert.throws(() => validateRules(domain, { ...rules, rules: [rule, rule] }), /Duplicate/);
});

test('the generated runtime keeps validation above interchangeable repositories', () => {
  const source = generateRulesRuntime(domain, rules);
  assert.match(source, /export function assertEntityRules/);
  assert.match(source, /class RuleValidationError/);
  assert.match(source, /value\.status === 'ready'/);
  assert.doesNotMatch(source, /eval\(|new Function|src\/generated|Dataverse|AsyncStorage/);
  assert.deepEqual(validateRules(domain, { schemaVersion: 1, rules: [] }), { schemaVersion: 1, rules: [] });
});
