'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateFileSizes, base64Length, CAP_BYTES } = require('../lib/validate-file-sizes');

test('validate-file-sizes: base64Length math', () => {
  assert.equal(base64Length(0), 0);
  assert.equal(base64Length(1), 4);
  assert.equal(base64Length(3), 4);
  assert.equal(base64Length(4), 8);
  assert.equal(base64Length(6), 8);
  // raw ~12.75 MB → encoded ~17 MB (the boundary)
  assert.equal(base64Length(12 * 1024 * 1024), Math.ceil((12 * 1024 * 1024) / 3) * 4);
});

test('validate-file-sizes: CAP_BYTES is 17 MiB', () => {
  assert.equal(CAP_BYTES, 17 * 1024 * 1024);
});

test('validate-file-sizes: throws on non-array items', () => {
  assert.throws(() => validateFileSizes(null), /items must be an array/);
  assert.throws(() => validateFileSizes('x'), /items must be an array/);
});

test('validate-file-sizes: empty items → ok', () => {
  const r = validateFileSizes([]);
  assert.equal(r.totalFiles, 0);
  assert.equal(r.totalRawBytes, 0);
  assert.equal(r.totalEncodedBytes, 0);
  assert.deepEqual(r.blocking, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
});

test('validate-file-sizes: small files all pass', () => {
  const items = [
    { componentId: '1', componentName: 'a', estimatedBytes: 1024 },
    { componentId: '2', componentName: 'b', estimatedBytes: 10 * 1024 * 1024 }, // 10 MB raw → ~13.3 MB encoded
  ];
  const r = validateFileSizes(items);
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.totalRawBytes, 1024 + 10 * 1024 * 1024);
});

test('validate-file-sizes: file just over raw cap blocks', () => {
  // 13 MB raw → encoded ≈ 17.33 MB → BLOCKS
  const raw = 13 * 1024 * 1024;
  const items = [{ componentId: 'big', componentName: 'BigCanvas', estimatedBytes: raw }];
  const r = validateFileSizes(items);
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].componentId, 'big');
  assert.ok(r.blocking[0].encodedBytes > CAP_BYTES);
  assert.ok(r.blocking[0].overByBytes > 0);
});

test('validate-file-sizes: file in 80%-100% band warns but does not block', () => {
  // 11 MB raw → encoded ≈ 14.67 MB → 86% of 17 MB cap → warn
  const raw = 11 * 1024 * 1024;
  const items = [{ componentId: 'w', componentName: 'WarnFile', estimatedBytes: raw }];
  const r = validateFileSizes(items);
  assert.equal(r.ok, true);
  assert.equal(r.blocking.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].componentId, 'w');
  assert.ok(r.warnings[0].percentOfCap >= 80);
  assert.ok(r.warnings[0].percentOfCap < 100);
});

test('validate-file-sizes: missing estimatedBytes is skipped (conservative)', () => {
  const items = [
    { componentId: 'unknown', componentName: 'x' /* no estimatedBytes */ },
    { componentId: 'small', componentName: 's', estimatedBytes: 1024 },
  ];
  const r = validateFileSizes(items);
  assert.equal(r.ok, true);
  assert.equal(r.totalRawBytes, 1024); // unknown not counted
});

test('validate-file-sizes: aggregates totals', () => {
  const items = [
    { estimatedBytes: 1000 },
    { estimatedBytes: 2000 },
    { estimatedBytes: 3000 },
  ];
  const r = validateFileSizes(items);
  assert.equal(r.totalRawBytes, 6000);
  assert.equal(r.totalEncodedBytes, base64Length(1000) + base64Length(2000) + base64Length(3000));
});

test('validate-file-sizes: capBytes override works', () => {
  const items = [{ componentId: 'tiny', estimatedBytes: 1000 }];
  // encoded = 1336 bytes; with cap=1000 → blocking
  const r = validateFileSizes(items, { capBytes: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.blocking.length, 1);
});

test('validate-file-sizes: warnThreshold override moves the band', () => {
  // 9 MB raw → encoded ≈ 12 MB → 70.6% of 17 MB cap
  const items = [{ componentId: 'm', estimatedBytes: 9 * 1024 * 1024 }];
  // default warnThreshold (80%) → no warning
  let r = validateFileSizes(items);
  assert.equal(r.warnings.length, 0);
  // warnThreshold 50% → warning
  r = validateFileSizes(items, { warnThreshold: 0.50 });
  assert.equal(r.warnings.length, 1);
});
