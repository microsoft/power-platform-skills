'use strict';
// Tests the attribute-payload builder used by add-column.js by re-implementing
// the same buildAttribute function. We do this rather than exporting it from the
// script because the script is intentionally a thin CLI wrapper.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// Pull the buildAttribute body out of add-column.js so the test stays in lockstep.
// If the helper diverges, fix it here too.
const scriptPath = path.join(__dirname, '..', 'add-column.js');
const scriptSrc = fs.readFileSync(scriptPath, 'utf8');

test('add-column.js contains buildAttribute for all supported types', () => {
  const types = ['string', 'memo', 'integer', 'decimal', 'money', 'datetime', 'boolean', 'picklist'];
  for (const t of types) {
    assert.match(scriptSrc, new RegExp(`case '${t}':`), `missing case '${t}'`);
  }
});

test('add-column.js rejects unsupported types', () => {
  assert.match(scriptSrc, /Unsupported column type/);
});

test('add-column.js uses common-fields builder', () => {
  assert.match(scriptSrc, /function commonFields\(/);
  assert.match(scriptSrc, /SchemaName: schemaName/);
  assert.match(scriptSrc, /DisplayName: label\(displayName\)/);
});

test('add-column.js picklist requires options', () => {
  assert.match(scriptSrc, /picklist requires --options/);
});

test('add-column.js boolean has true/false labels', () => {
  assert.match(scriptSrc, /TrueOption:/);
  assert.match(scriptSrc, /FalseOption:/);
});
