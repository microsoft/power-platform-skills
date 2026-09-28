'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateVisualQaEvidence } = require('../validate-visual-qa-evidence');

function passingManifest() {
  return {
    schemaVersion: 1,
    referenceFidelity: 'strict-structural',
    captureMatrix: [
      { screen: 'Home', platform: 'ios', dynamicType: 'default', result: 'pass' },
      { screen: 'Home', platform: 'android', dynamicType: 'default', result: 'pass' },
      { screen: 'Home', platform: 'ios', dynamicType: 'large', result: 'pass' },
    ],
    referenceChecks: [
      { requirement: 'hero hierarchy', result: 'pass' },
      { requirement: 'no generic product grid', result: 'pass' },
    ],
    findings: [],
    missingCoverage: [],
  };
}

test('strict visual QA evidence requires the full Home capture baseline', () => {
  assert.deepStrictEqual(validateVisualQaEvidence(passingManifest(), 'strict-structural'), []);
});

test('strict visual QA evidence rejects missing Android and unresolved reference drift', () => {
  const manifest = passingManifest();
  manifest.captureMatrix = manifest.captureMatrix.filter((capture) => capture.platform !== 'android');
  manifest.referenceChecks[1].result = 'failed';
  const rules = new Set(validateVisualQaEvidence(manifest, 'strict-structural').map((issue) => issue.rule));
  assert.ok(rules.has('missing-platform-home-capture'));
  assert.ok(rules.has('failed-reference-check'));
});

test('directional designs do not require the strict capture matrix', () => {
  assert.deepStrictEqual(validateVisualQaEvidence({}, 'directional'), []);
});
