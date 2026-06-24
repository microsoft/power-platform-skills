'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSerialSelection, describeInvalidSelection } = require('../lib/parse-serial-selection');

const VALID = [9, 10, 11, 12, 13, 14, 15];

test('parses comma-separated serials', () => {
  const r = parseSerialSelection('9,12,15', VALID);
  assert.equal(r.ok, true);
  assert.deepEqual(r.accepted, [9, 12, 15]);
});

test('parses space-separated serials', () => {
  const r = parseSerialSelection('9 12 15', VALID);
  assert.deepEqual(r.accepted, [9, 12, 15]);
});

test('parses mixed commas + spaces', () => {
  const r = parseSerialSelection(' 9, 12   15 ', VALID);
  assert.deepEqual(r.accepted, [9, 12, 15]);
});

test('expands ranges (inclusive) and dedupes', () => {
  const r = parseSerialSelection('9-11, 11, 13', VALID);
  assert.equal(r.ok, true);
  assert.deepEqual(r.accepted, [9, 10, 11, 13]);
});

test('tolerates reversed ranges (11-9)', () => {
  const r = parseSerialSelection('11-9', VALID);
  assert.deepEqual(r.accepted, [9, 10, 11]);
});

test('"all" shortcut → every valid serial', () => {
  const r = parseSerialSelection('all', VALID);
  assert.equal(r.all, true);
  assert.deepEqual(r.accepted, VALID);
});

test('"none" and empty → no incoming', () => {
  for (const inp of ['none', '', '   ']) {
    const r = parseSerialSelection(inp, VALID);
    assert.equal(r.none, true);
    assert.deepEqual(r.accepted, []);
  }
});

test('out-of-range numbers → ok:false with the offending numbers', () => {
  const r = parseSerialSelection('9, 20, 3', VALID);
  assert.equal(r.ok, false);
  assert.deepEqual(r.outOfRange, [3, 20]);
});

test('non-numeric garbage → ok:false with the bad tokens', () => {
  const r = parseSerialSelection('9, foo, 12', VALID);
  assert.equal(r.ok, false);
  assert.deepEqual(r.invalidTokens, ['foo']);
});

test('range that overflows the valid set flags only the out-of-range members', () => {
  const r = parseSerialSelection('14-17', VALID);
  assert.equal(r.ok, false);
  assert.deepEqual(r.outOfRange, [16, 17]);
});

test('accepts a Set for validSerials', () => {
  const r = parseSerialSelection('10', new Set([9, 10, 11]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.accepted, [10]);
});

test('describeInvalidSelection summarizes both kinds of error', () => {
  const r = parseSerialSelection('foo, 99', VALID);
  const msg = describeInvalidSelection(r);
  assert.match(msg, /not a number\/range: foo/);
  assert.match(msg, /out of range: 99/);
});

test('huge range is clamped (no multi-million loop), flags out-of-range upper bound', () => {
  const start = Date.now();
  const r = parseSerialSelection('9-2000000000', VALID);
  const ms = Date.now() - start;
  assert.ok(ms < 100, `should be fast, took ${ms}ms`);
  assert.equal(r.ok, false);            // contains out-of-range
  assert.ok(r.outOfRange.includes(2000000000));
  assert.deepEqual(r.accepted, [9, 10, 11, 12, 13, 14, 15]); // valid ones still captured
});

test('range entirely above the valid set is flagged without enumerating', () => {
  const start = Date.now();
  const r = parseSerialSelection('2000000-2000005', VALID);
  assert.ok(Date.now() - start < 100);
  assert.equal(r.ok, false);
  assert.ok(r.outOfRange.includes(2000000) && r.outOfRange.includes(2000005));
  assert.deepEqual(r.accepted, []);
});
