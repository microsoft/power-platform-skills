'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateTotalPayloadSize,
  DEFAULT_THRESHOLD_MB,
} = require('../lib/validate-total-payload-size');

test('validateTotalPayloadSize: throws on non-array input', () => {
  assert.throws(() => validateTotalPayloadSize(null), /must be an array/);
});

test('validateTotalPayloadSize: returns ok with empty items and info summary', () => {
  const r = validateTotalPayloadSize([]);
  assert.equal(r.ok, true);
  assert.equal(r.totalChecked, 0);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.info.length, 1);
  assert.equal(r.info[0].key, 'total-payload-summary');
});

test('validateTotalPayloadSize: sums encoded bytes correctly', () => {
  const items = [
    { estimatedBytes: 1024 * 1024 },     // 1 MB
    { estimatedBytes: 2 * 1024 * 1024 }, // 2 MB
  ];
  const r = validateTotalPayloadSize(items);
  assert.equal(r.info[0].details.totalRawBytes, 3 * 1024 * 1024);
  // Encoded ≈ 4 MB; well under 100 MB default threshold → no warn.
  assert.equal(r.warnings.length, 0);
});

test('validateTotalPayloadSize: WARNs when encoded total exceeds threshold', () => {
  // 80 MB raw → ~106 MB encoded → exceeds default 100 MB threshold.
  const items = [{ estimatedBytes: 80 * 1024 * 1024 }];
  const r = validateTotalPayloadSize(items);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].key, 'total-payload-size-warning');
});

test('validateTotalPayloadSize: custom threshold honored', () => {
  // 4 MB raw → ~5.3 MB encoded → exceeds 5 MB threshold.
  const items = [{ estimatedBytes: 4 * 1024 * 1024 }];
  const r = validateTotalPayloadSize(items, { thresholdMb: 5 });
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].details.thresholdMb, 5);
});

test('validateTotalPayloadSize: skips items without estimatedBytes and counts them in info', () => {
  const items = [
    { estimatedBytes: 1024 },
    { componentName: 'no-size-1' },
    { componentName: 'no-size-2' },
  ];
  const r = validateTotalPayloadSize(items);
  assert.equal(r.info[0].details.itemsWithoutSize, 2);
});

test('validateTotalPayloadSize: DEFAULT_THRESHOLD_MB is 100', () => {
  assert.equal(DEFAULT_THRESHOLD_MB, 100);
});

test('validateTotalPayloadSize: ok is always true (informational only)', () => {
  const items = [{ estimatedBytes: 200 * 1024 * 1024 }];
  const r = validateTotalPayloadSize(items);
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
});
