'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSupportedObjectTypes, UNSUPPORTED, DEPRECATED,
} = require('../lib/validate-supported-object-types');

test('validate-supported-object-types: throws on non-array', () => {
  assert.throws(() => validateSupportedObjectTypes(null), /items must be an array/);
});

test('validate-supported-object-types: empty items → ok, no entries', () => {
  const r = validateSupportedObjectTypes([]);
  assert.equal(r.ok, true);
  assert.equal(r.unsupported.length, 0);
  assert.equal(r.deprecated.length, 0);
  assert.equal(r.supported, 0);
});

test('validate-supported-object-types: all supported types pass', () => {
  const items = [
    { componentId: '1', componentName: 'p', componentType: 'mspp_webpage' },
    { componentId: '2', componentName: 'f', componentType: 'mspp_webfile' },
  ];
  const r = validateSupportedObjectTypes(items);
  assert.equal(r.ok, true);
  assert.equal(r.supported, 2);
  assert.equal(r.unsupported.length, 0);
});

test('validate-supported-object-types: workflow_xaml blocks', () => {
  const items = [{ componentId: 'w', componentName: 'OldWf', componentType: 'workflow_xaml' }];
  const r = validateSupportedObjectTypes(items);
  assert.equal(r.ok, false);
  assert.equal(r.unsupported.length, 1);
  assert.equal(r.unsupported[0].componentType, 'workflow_xaml');
  assert.match(r.unsupported[0].reason, /XAML/);
});

test('validate-supported-object-types: case-insensitive type matching', () => {
  const items = [{ componentId: 'd', componentName: 'D', componentType: 'Dialog' }];
  const r = validateSupportedObjectTypes(items);
  assert.equal(r.ok, false);
  assert.equal(r.unsupported.length, 1);
});

test('validate-supported-object-types: deprecated types warn but do not block', () => {
  const items = [{ componentId: 'rc', componentName: 'cat', componentType: 'reportcategory' }];
  const r = validateSupportedObjectTypes(items);
  assert.equal(r.ok, true);
  assert.equal(r.deprecated.length, 1);
  assert.equal(r.unsupported.length, 0);
});

test('validate-supported-object-types: extraUnsupported merges into table', () => {
  const items = [{ componentId: 'x', componentType: 'custom_legacy' }];
  const r = validateSupportedObjectTypes(items, {
    extraUnsupported: { custom_legacy: 'Custom legacy block.' },
  });
  assert.equal(r.ok, false);
  assert.equal(r.unsupported[0].reason, 'Custom legacy block.');
});

test('validate-supported-object-types: items with null/missing type are counted as supported', () => {
  const items = [{ componentId: 'n' /* no componentType */ }];
  const r = validateSupportedObjectTypes(items);
  assert.equal(r.ok, true);
  assert.equal(r.supported, 1);
});

test('validate-supported-object-types: UNSUPPORTED + DEPRECATED tables exported', () => {
  assert.ok(typeof UNSUPPORTED.workflow_xaml === 'string');
  assert.ok(typeof DEPRECATED.reportcategory === 'string');
  // immutable
  assert.throws(() => { UNSUPPORTED.new = 'x'; });
});

test('validate-supported-object-types: mixed payload sorts correctly', () => {
  const items = [
    { componentId: 'a', componentType: 'mspp_webpage' },                  // supported
    { componentId: 'b', componentType: 'workflow_xaml' },                  // unsupported
    { componentId: 'c', componentType: 'reportcategory' },                 // deprecated
    { componentId: 'd', componentType: 'mspp_webfile' },                  // supported
    { componentId: 'e', componentType: 'sdkmessageprocessingstep_legacy' }, // unsupported
  ];
  const r = validateSupportedObjectTypes(items);
  assert.equal(r.ok, false);
  assert.equal(r.unsupported.length, 2);
  assert.equal(r.deprecated.length, 1);
  assert.equal(r.supported, 2);
  assert.equal(r.totalFiles, 5);
});
