'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  BOM, stripBom, detectBom, toLF, detectEol, applyEol, applyBom, detectShape, matchShape,
} = require('../lib/eol-bom');

test('stripBom removes only a leading BOM', () => {
  assert.strictEqual(stripBom(BOM + 'abc'), 'abc');
  assert.strictEqual(stripBom('abc'), 'abc');
  assert.strictEqual(stripBom('a' + BOM + 'b'), 'a' + BOM + 'b');
  assert.strictEqual(stripBom(123), 123);
});

test('detectBom', () => {
  assert.strictEqual(detectBom(BOM + 'x'), true);
  assert.strictEqual(detectBom('x'), false);
  assert.strictEqual(detectBom(''), false);
});

test('toLF normalizes CRLF and lone CR', () => {
  assert.strictEqual(toLF('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('detectEol', () => {
  assert.strictEqual(detectEol('a\r\nb'), '\r\n');
  assert.strictEqual(detectEol('a\nb'), '\n');
  assert.strictEqual(detectEol('abc'), null);
  assert.strictEqual(detectEol(42), null);
});

test('applyEol', () => {
  assert.strictEqual(applyEol('a\nb', '\r\n'), 'a\r\nb');
  assert.strictEqual(applyEol('a\r\nb', '\n'), 'a\nb');
});

test('applyBom adds (idempotent) and strips', () => {
  assert.strictEqual(applyBom('x', true), BOM + 'x');
  assert.strictEqual(applyBom(BOM + 'x', true), BOM + 'x');
  assert.strictEqual(applyBom(BOM + 'x', false), 'x');
  assert.strictEqual(applyBom('x', false), 'x');
});

test('detectShape reports eol + bom together', () => {
  assert.deepStrictEqual(detectShape(BOM + 'a\r\nb'), { eol: '\r\n', bom: true });
  assert.deepStrictEqual(detectShape('a\nb'), { eol: '\n', bom: false });
  assert.deepStrictEqual(detectShape('abc'), { eol: null, bom: false });
});

test('matchShape reshapes OURS to a CRLF+BOM repo file', () => {
  const repoFile = BOM + 'line1\r\nline2\r\n';
  const ours = 'line1\nline2-changed\n'; // LF, no BOM
  assert.strictEqual(matchShape(ours, detectShape(repoFile)), BOM + 'line1\r\nline2-changed\r\n');
});

test('matchShape to LF/no-BOM strips BOM and CRLF', () => {
  assert.strictEqual(matchShape(BOM + 'a\r\nb', { eol: '\n', bom: false }), 'a\nb');
});

test('matchShape defaults to LF when eol undeterminable', () => {
  assert.strictEqual(matchShape('a\r\nb', {}), 'a\nb');
});

test('matchShape round-trips a CRLF file unchanged in content', () => {
  const repoFile = 'x\r\ny\r\nz';
  // OURS identical content but LF — should come back byte-identical to repo shape
  assert.strictEqual(matchShape('x\ny\nz', detectShape(repoFile)), 'x\r\ny\r\nz');
});
