'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateExperienceQaEvidence,
  validateVisualQaEvidence,
} = require('../validate-visual-qa-evidence');
const { deriveExperienceFromBrief } = require('../experience-patterns');

function passingManifest() {
  return {
    schemaVersion: 1,
    referenceFidelity: 'strict-structural',
    captureMatrix: [
      { screen: 'Home', platform: 'ios', dynamicType: 'default', result: 'pass', captureId: 'ios-home-default' },
      { screen: 'Home', platform: 'android', dynamicType: 'default', result: 'pass', captureId: 'android-home-default' },
      { screen: 'Home', platform: 'ios', dynamicType: 'large', result: 'pass', captureId: 'ios-home-large' },
    ],
    referenceChecks: [
      { requirement: 'hero hierarchy', result: 'pass' },
      { requirement: 'required motifs', result: 'pass' },
      { requirement: 'forbidden drift', result: 'pass' },
    ],
    findings: [],
    missingCoverage: [],
  };
}

test('strict evidence accepts the complete native Home capture matrix', () => {
  assert.deepEqual(validateVisualQaEvidence(passingManifest(), 'strict-structural'), []);
});

test('strict evidence rejects missing Android capture and failed reference review', () => {
  const manifest = passingManifest();
  manifest.captureMatrix = manifest.captureMatrix.filter((capture) => capture.platform !== 'android');
  manifest.referenceChecks[2].result = 'failed';
  const rules = new Set(validateVisualQaEvidence(manifest, 'strict-structural').map((issue) => issue.rule));
  assert.ok(rules.has('missing-platform-home-capture'));
  assert.ok(rules.has('failed-reference-check'));
});

test('strict evidence requires an actual screenshot path or capture ID', () => {
  const manifest = passingManifest();
  for (const capture of manifest.captureMatrix) delete capture.captureId;
  const rules = new Set(validateVisualQaEvidence(manifest, 'strict-structural').map((issue) => issue.rule));
  assert.ok(rules.has('missing-platform-home-capture'));
  assert.ok(rules.has('missing-dynamic-type-home-capture'));
});

test('directional work does not require the strict native capture matrix', () => {
  assert.deepEqual(validateVisualQaEvidence({}, 'directional'), []);
});

test('optionally composes generic experience visual evidence', (context) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-experience-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true });
  const contract = deriveExperienceFromBrief('Let a user scan a receipt, capture its details, and submit the result.');
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-contract.json'), JSON.stringify(contract));
  const keyFlow = { route: '/(app)/capture/review', file: 'app/(app)/capture/review.tsx', outcome: 'Review the capture before submit.' };
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-screen-contract.json'), JSON.stringify({ schemaVersion: 1, keyFlow }));
  const scopes = ['primary', 'key-flow'];
  const checks = ['focalPoint', 'regionOrder', 'primaryAction', 'taskFit', 'contentRealism', 'signatureMotifs', 'forbiddenDefaults', 'contrast', 'touchTargets', 'safeAreas', 'offlineState', 'screenReaderOrder', 'responsiveLayout', 'localizedContent']
    .map((id) => ({ id, status: 'pass', scopes, evidence: [`native evidence for ${id}`], captureIds: ['normal', 'key-normal'] }));
  checks.push({ id: 'keyboard', status: 'not-applicable', scopes, evidence: ['No text input occurs in capture review.'], captureIds: ['normal', 'key-normal'], reason: 'The reviewed capture flow has no keyboard-triggering control.' });
  const manifest = {
    schemaVersion: 1,
    experienceContractRoute: contract.primaryScreen.route,
    keyFlowRoute: keyFlow.route,
    captureMatrix: [
      { route: contract.primaryScreen.route, fontScale: 1, status: 'pass', captureId: 'normal', platform: 'ios', device: 'iPhone 15' },
      { route: contract.primaryScreen.route, fontScale: 1.4, status: 'pass', captureId: 'large', platform: 'ios', device: 'iPhone 15' },
      { route: keyFlow.route, fontScale: 1, status: 'pass', captureId: 'key-normal', platform: 'android', device: 'Pixel 8' },
      { route: keyFlow.route, fontScale: 1.4, status: 'pass', captureId: 'key-large', platform: 'android', device: 'Pixel 8' },
    ],
    checks,
  };
  assert.deepEqual(validateExperienceQaEvidence(manifest, projectRoot), []);
});
