'use strict';
// Shared OData string-literal escaping helper: quote-doubling + null/undefined -> empty literal.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { odataLit } = require(path.join(__dirname, '..', 'lib', 'odata.js'));

test('odataLit doubles single quotes (OData v4 literal escaping)', () => {
  assert.strictEqual(odataLit("O'Brien"), "O''Brien");
  assert.strictEqual(odataLit("a'b'c"), "a''b''c");
});

test('odataLit leaves quote-free strings unchanged', () => {
  assert.strictEqual(odataLit('contoso_project'), 'contoso_project');
});

test('odataLit collapses null/undefined to an empty literal', () => {
  assert.strictEqual(odataLit(null), '');
  assert.strictEqual(odataLit(undefined), '');
});

test('odataLit stringifies non-string inputs before escaping', () => {
  assert.strictEqual(odataLit(42), '42');
});
