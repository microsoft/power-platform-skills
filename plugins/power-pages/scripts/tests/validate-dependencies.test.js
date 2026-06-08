'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateDependencies, extractReferences, KNOWN_REFERENCE_FIELDS, GUID_REGEX,
} = require('../lib/validate-dependencies');

const G1 = '11111111-1111-1111-1111-111111111111';
const G2 = '22222222-2222-2222-2222-222222222222';
const G3 = '33333333-3333-3333-3333-333333333333';

test('validate-dependencies: GUID_REGEX matches and rejects correctly', () => {
  assert.ok(GUID_REGEX.test(G1));
  assert.ok(!GUID_REGEX.test('not-a-guid'));
  assert.ok(!GUID_REGEX.test(G1.replace(/-/g, '')));
});

test('validate-dependencies: KNOWN_REFERENCE_FIELDS contains canonical Pages fields', () => {
  assert.ok(KNOWN_REFERENCE_FIELDS.includes('mspp_websiteid'));
  assert.ok(KNOWN_REFERENCE_FIELDS.includes('webpageId'));
});

test('validate-dependencies: extractReferences finds known fields', () => {
  const refs = extractReferences({
    componentId: G1,
    mspp_websiteid: G2,
    formId: G3,
  });
  assert.equal(refs.length, 2);
  assert.ok(refs.some((r) => r.field === 'mspp_websiteid' && r.id === G2));
  assert.ok(refs.some((r) => r.field === 'formId' && r.id === G3));
});

test('validate-dependencies: extractReferences also reads references[] array', () => {
  const refs = extractReferences({
    componentId: G1,
    references: [
      { field: 'parent', referencedId: G2 },
      { field: 'other', referencedId: G3 },
      { field: 'bad', referencedId: 'not-a-guid' },
    ],
  });
  assert.equal(refs.length, 2);
});

test('validate-dependencies: throws on non-array', () => {
  assert.throws(() => validateDependencies(null), /items must be an array/);
});

test('validate-dependencies: empty items → no missing', () => {
  const r = validateDependencies([]);
  assert.equal(r.totalReferences, 0);
  assert.deepEqual(r.missing, []);
});

test('validate-dependencies: all referenced ids present → none missing', () => {
  const items = [
    { componentId: G1, componentName: 'parent' },
    { componentId: G2, componentName: 'child', mspp_websiteid: G1 },
  ];
  const r = validateDependencies(items);
  assert.equal(r.totalReferences, 1);
  assert.equal(r.missing.length, 0);
});

test('validate-dependencies: missing reference is surfaced', () => {
  const items = [
    { componentId: G1, componentName: 'orphan', componentType: 'mspp_webpage', mspp_websiteid: G2 },
  ];
  const r = validateDependencies(items);
  assert.equal(r.totalReferences, 1);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].referencedId, G2);
  assert.equal(r.missing[0].fromComponent.componentId, G1);
  assert.equal(r.missing[0].severity, 'warn');
});

test('validate-dependencies: self-reference is skipped', () => {
  const items = [
    { componentId: G1, componentName: 'self', mspp_webpageid: G1 },
  ];
  const r = validateDependencies(items);
  assert.equal(r.missing.length, 0);
});

test('validate-dependencies: id matching is case-insensitive', () => {
  const items = [
    { componentId: G1.toUpperCase() },
    { componentId: G2, mspp_websiteid: G1.toLowerCase() },
  ];
  const r = validateDependencies(items);
  assert.equal(r.missing.length, 0);
});

test('validate-dependencies: ok is always true (warnings only)', () => {
  const items = [{ componentId: G1, mspp_websiteid: G2 }];
  const r = validateDependencies(items);
  assert.equal(r.ok, true);
});

test('validate-dependencies: multiple missing references aggregated', () => {
  const items = [
    {
      componentId: G1,
      componentName: 'webpage',
      mspp_websiteid: G2,
      webtemplateId: G3,
    },
  ];
  const r = validateDependencies(items);
  assert.equal(r.totalReferences, 2);
  assert.equal(r.missing.length, 2);
});

test('validate-dependencies: non-guid string in reference field is ignored', () => {
  const items = [
    { componentId: G1, mspp_websiteid: 'not-a-guid' },
  ];
  const r = validateDependencies(items);
  assert.equal(r.totalReferences, 0);
});
