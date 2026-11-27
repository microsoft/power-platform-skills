'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  compareDerivedColumn,
  compareDerivedMetadata,
} = require('../lib/derived-metadata');

test('lookup reconciliation rejects a same-named lookup targeting another table', () => {
  const result = compareDerivedColumn(
    {
      table: 'cr1_order',
      logicalName: 'cr1_productid',
      kind: 'lookup',
      type: 'Lookup',
      sourceType: 0,
      lookupTarget: 'cr1_product',
    },
    {
      type: 'Lookup',
      sourceType: 0,
      lookupTargets: ['cr1_supplier'],
    },
  );
  assert.strictEqual(result.compatible, false);
  assert.match(result.reasons.join('; '), /lookup target mismatch/);
});

test('lookup reconciliation rejects a broader polymorphic target set', () => {
  const result = compareDerivedColumn(
    {
      table: 'cr1_order',
      logicalName: 'cr1_customerid',
      kind: 'lookup',
      type: 'Lookup',
      sourceType: 0,
      lookupTarget: 'account',
    },
    {
      type: 'Lookup',
      sourceType: 0,
      lookupTargets: ['account', 'contact'],
    },
  );
  assert.strictEqual(result.compatible, false);
  assert.match(result.reasons.join('; '), /lookup target mismatch/);
});

test('choice reconciliation requires every planned integer and label mapping', () => {
  const result = compareDerivedColumn(
    {
      table: 'cr1_order',
      logicalName: 'cr1_status',
      kind: 'choice',
      type: 'Picklist',
      sourceType: 0,
      options: [
        { value: 100000000, label: 'Open' },
        { value: 100000001, label: 'Closed' },
      ],
    },
    {
      type: 'Picklist',
      sourceType: 0,
      options: [
        { value: 100000000, label: 'Open' },
        { value: 100000001, label: 'Resolved' },
      ],
    },
  );
  assert.strictEqual(result.compatible, false);
  assert.match(result.reasons.join('; '), /label mismatch/);
});

test('ordinary columns reject live calculated or formula metadata', () => {
  const result = compareDerivedColumn(
    {
      table: 'cr1_order',
      logicalName: 'cr1_name',
      kind: 'ordinary',
      type: 'String',
      sourceType: 0,
    },
    { type: 'String', sourceType: 3 },
  );
  assert.strictEqual(result.compatible, false);
  assert.match(result.reasons.join('; '), /source type mismatch/);
});

test('malformed normalized metadata fails closed', () => {
  const result = compareDerivedColumn(
    {
      table: 'cr1_order',
      logicalName: 'cr1_productid',
      kind: 'lookup',
      type: 'Lookup',
      sourceType: 0,
      lookupTarget: 'cr1_product',
    },
    {
      type: 'Lookup',
      lookupTargets: 'cr1_product',
    },
  );
  assert.strictEqual(result.compatible, false);
  assert.match(result.reasons.join('; '), /sourceType is missing/);
  assert.match(result.reasons.join('; '), /lookupTargets must be an array/);
});

test('SourceType requires explicit null or integer evidence on both sides', () => {
  const expected = {
    table: 'cr1_order', logicalName: 'cr1_customerid', kind: 'lookup',
    type: 'Lookup', sourceType: 0, lookupTarget: 'account',
  };
  const actual = { type: 'Lookup', sourceType: 0, lookupTargets: ['account'] };
  for (const sourceType of [undefined, '', '0', false, true, [], {}, 0.5]) {
    for (const result of [
      compareDerivedColumn(expected, { ...actual, sourceType }),
      compareDerivedColumn({ ...expected, sourceType }, actual),
    ]) {
      assert.strictEqual(result.compatible, false, JSON.stringify({ sourceType }));
      assert.match(result.reasons.join('; '), /sourceType.*missing|sourceType.*malformed/);
    }
  }
  for (const sourceType of [null, 0]) {
    assert.strictEqual(compareDerivedColumn(expected, { ...actual, sourceType }).compatible, true);
  }
});

test('derived validator CLI reports malformed SourceType as BLOCKED', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'derived-metadata-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const expectedPath = path.join(directory, 'expected.json');
  const actualPath = path.join(directory, 'actual.json');
  const expected = {
    table: 'cr1_order', logicalName: 'cr1_customerid', kind: 'lookup',
    type: 'Lookup', sourceType: 0, lookupTarget: 'account',
  };
  fs.writeFileSync(expectedPath, JSON.stringify([expected]));
  fs.writeFileSync(actualPath, JSON.stringify([{
    table: expected.table, logicalName: expected.logicalName,
    type: 'Lookup', sourceType: '', lookupTargets: ['account'],
  }]));
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'validate-derived-metadata.js'),
    '--expected', expectedPath, '--actual', actualPath,
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.status, 'BLOCKED');
  assert.match(output.results[0].reasons.join('; '), /sourceType.*malformed/);
});

test('malformed expected contracts and duplicate live rows fail closed', () => {
  const malformed = compareDerivedColumn(
    { table: 'cr1_order', logicalName: 'cr1_status', kind: 'choice', type: 'Picklist' },
    { type: 'Picklist', sourceType: 0, options: [] },
  );
  assert.strictEqual(malformed.compatible, false);
  assert.match(malformed.reasons.join('; '), /sourceType is missing/);
  assert.match(malformed.reasons.join('; '), /expected choice options/);

  const duplicate = compareDerivedMetadata(
    [{
      table: 'cr1_order',
      logicalName: 'cr1_status',
      kind: 'ordinary',
      type: 'String',
      sourceType: 0,
    }],
    [
      { table: 'cr1_order', logicalName: 'cr1_status', type: 'String', sourceType: 0 },
      { table: 'cr1_order', logicalName: 'cr1_status', type: 'String', sourceType: 0 },
    ],
  );
  assert.strictEqual(duplicate[0].compatible, false);
  assert.match(duplicate[0].reasons.join('; '), /duplicate live metadata rows/);
});

test('malformed choice and Boolean mappings fail closed', () => {
  const emptyChoice = compareDerivedColumn(
    {
      table: 'cr1_order',
      logicalName: 'cr1_status',
      kind: 'choice',
      type: 'Picklist',
      sourceType: 0,
      options: [],
    },
    { type: 'Picklist', sourceType: 0, options: [] },
  );
  assert.strictEqual(emptyChoice.compatible, false);
  assert.match(emptyChoice.reasons.join('; '), /non-empty array/);

  const malformedBoolean = compareDerivedColumn(
    {
      table: 'cr1_order',
      logicalName: 'cr1_active',
      kind: 'boolean',
      type: 'Boolean',
      sourceType: 0,
      options: [{ value: 1, label: 'Yes' }, { value: 1, label: '' }],
    },
    {
      type: 'Boolean',
      sourceType: 0,
      options: [{ value: 0, label: 'No' }, { value: 1, label: 'Yes' }],
    },
  );
  assert.strictEqual(malformedBoolean.compatible, false);
  assert.match(malformedBoolean.reasons.join('; '), /duplicated|no label|exactly values 0 and 1/);
});

test('computed-column reuse requires an exact formula definition', () => {
  const results = compareDerivedMetadata(
    [{
      table: 'cr1_order',
      logicalName: 'cr1_total',
      kind: 'computed',
      type: 'Decimal',
      sourceType: 3,
      sourceTypeMask: 2,
      formulaDefinition: 'expected-definition',
    }],
    [{
      table: 'cr1_order',
      logicalName: 'cr1_total',
      type: 'Decimal',
      sourceType: 3,
      sourceTypeMask: 2,
      formulaDefinition: 'different-definition',
    }],
  );
  assert.strictEqual(results[0].compatible, false);
  assert.match(results[0].reasons.join('; '), /FormulaDefinition mismatch/);
});

test('computed-column reuse rejects invalid or mismatched source type masks', () => {
  const result = compareDerivedColumn(
    {
      table: 'cr1_order',
      logicalName: 'cr1_total',
      kind: 'computed',
      type: 'Decimal',
      sourceType: 3,
      sourceTypeMask: 2,
      formulaDefinition: 'definition',
    },
    {
      type: 'Decimal',
      sourceType: 3,
      sourceTypeMask: 32,
      formulaDefinition: 'definition',
    },
  );
  assert.strictEqual(result.compatible, false);
  assert.match(result.reasons.join('; '), /Invalid bit/);
});

test('computed masks cannot coerce missing or malformed evidence into zero', () => {
  const expected = {
    table: 'cr1_order', logicalName: 'cr1_total', kind: 'computed',
    type: 'Decimal', sourceType: 1, sourceTypeMask: 0,
    formulaDefinition: 'cr1_amount * 2',
  };
  const actual = {
    type: 'Decimal', sourceType: 1, sourceTypeMask: 0,
    formulaDefinition: expected.formulaDefinition,
  };
  assert.strictEqual(compareDerivedColumn(expected, actual).compatible, true);
  for (const sourceTypeMask of [null, undefined, '', '0', false, true, [], {}, 0.5, -64]) {
    for (const result of [
      compareDerivedColumn(expected, { ...actual, sourceTypeMask }),
      compareDerivedColumn({ ...expected, sourceTypeMask }, actual),
    ]) {
      assert.strictEqual(result.compatible, false, JSON.stringify({ sourceTypeMask }));
      assert.match(result.reasons.join('; '), /sourceTypeMask.*missing|sourceTypeMask.*malformed/);
    }
  }
});

test('legacy calculated-column helper fails before attempting mutation', () => {
  const script = path.resolve(__dirname, '..', 'create-calculated-column.js');
  const result = spawnSync(process.execPath, [
    script,
    'https://example.crm.dynamics.com',
    '--table', 'cr1_order',
    '--column', 'cr1_total_calc',
    '--type', 'decimal',
    '--formula', 'cr1_parentid.cr1_total',
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.status, 'BLOCKED');
  assert.strictEqual(output.code, 'UNSUPPORTED_FORMULA_DEFINITION_API');
});
