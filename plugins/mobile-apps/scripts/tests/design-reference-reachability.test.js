'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  buildReachabilityReport,
} = require('../design-reference-reachability');

const pluginRoot = path.resolve(__dirname, '../..');

test('every design reference is classified without loading optional files in automatic mode', () => {
  const report = buildReachabilityReport(pluginRoot);
  assert.equal(report.summary.total, 28);
  assert.deepEqual(
    report.references
      .filter((entry) => entry.classification === 'automatic')
      .map((entry) => entry.path)
      .sort(),
    ['auto-experience.md', 'design-system-schema.md', 'final-experience-preview.md'],
  );
  assert.ok(report.summary.explicitOptionalMode >= 20);
  assert.equal(report.summary.testOnly, 0);
  assert.equal(report.summary.genuinelyUnreachable, 0);
  assert.deepEqual(report.deletionCandidates, []);
  assert.deepEqual(report.warnings, []);
  for (const reference of [
    'figma-extraction.md',
    'gallery-review.md',
    'lifecycle-migration.md',
    'preview-template.md',
    'refresh-flow.md',
    'vibe/style-picker.md',
  ]) {
    assert.equal(
      report.references.find((entry) => entry.path === reference)?.classification,
      'explicit-optional-mode',
      reference,
    );
  }
});

test('missing optional references are warnings rather than generation blockers', () => {
  const report = buildReachabilityReport(pluginRoot);
  assert.equal(report.reportType, 'design-reference-reachability');
  assert.ok(Array.isArray(report.warnings));
});