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
  const capture = (screen, platform, dynamicType, captureId) => ({
    screen,
    screenId: screen,
    platform,
    dynamicType,
    result: 'pass',
    captureId,
    dimensions: { width: platform === 'ios' ? 390 : 412, height: platform === 'ios' ? 844 : 915 },
    captureState: 'stable',
    cleanliness: { metroOverlay: 'absent', developmentErrorOverlay: 'absent', hostDebugChrome: 'absent' },
  });
  return {
    schemaVersion: 1,
    referenceFidelity: 'strict-structural',
    captureMatrix: [
      capture('Home', 'ios', 'default', 'ios-home-default'),
      capture('Home', 'android', 'default', 'android-home-default'),
      capture('Home', 'ios', 'large', 'ios-home-large'),
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

test('strict evidence rejects Refreshing and development overlay frames', () => {
  const manifest = passingManifest();
  manifest.captureMatrix[0].overlayText = 'Refreshing...';
  manifest.captureMatrix[1].cleanliness.developmentErrorOverlay = 'present';
  const issues = validateVisualQaEvidence(manifest, 'strict-structural');
  assert.ok(issues.some((issue) => issue.rule === 'unclean-native-capture' && /overlay text/.test(issue.message)));
  assert.ok(issues.some((issue) => issue.rule === 'unclean-native-capture' && /development error overlay/.test(issue.message)));
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
  const checks = ['focalPoint', 'regionOrder', 'primaryAction', 'taskFit', 'contentRealism', 'signatureMotifs', 'forbiddenDefaults', 'contrast', 'touchTargets', 'safeAreas', 'headerOwnership', 'mediaFallback', 'cardListDensity', 'contentCrop', 'bottomClearance', 'offlineState', 'screenReaderOrder', 'responsiveLayout', 'localizedContent']
    .map((id) => ({ id, status: 'pass', scopes, evidence: [`native evidence for ${id}`], captureIds: ['normal', 'key-normal'] }));
  checks.push({ id: 'keyboard', status: 'not-applicable', scopes, evidence: ['No text input occurs in capture review.'], captureIds: ['normal', 'key-normal'], reason: 'The reviewed capture flow has no keyboard-triggering control.' });
  const manifest = {
    schemaVersion: 1,
    experienceContractRoute: contract.primaryScreen.route,
    keyFlowRoute: keyFlow.route,
    captureMatrix: [
      { route: contract.primaryScreen.route, screenId: 'Home', fontScale: 1, status: 'pass', captureId: 'normal', platform: 'ios', device: 'iPhone 15', dimensions: { width: 390, height: 844 }, captureState: 'stable', cleanliness: { metroOverlay: 'absent', developmentErrorOverlay: 'absent', hostDebugChrome: 'absent' } },
      { route: contract.primaryScreen.route, screenId: 'Home', fontScale: 1.4, status: 'pass', captureId: 'large', platform: 'ios', device: 'iPhone 15', dimensions: { width: 390, height: 844 }, captureState: 'stable', cleanliness: { metroOverlay: 'absent', developmentErrorOverlay: 'absent', hostDebugChrome: 'absent' } },
      { route: keyFlow.route, screenId: 'CaptureReview', fontScale: 1, status: 'pass', captureId: 'key-normal', platform: 'android', device: 'Pixel 8', dimensions: { width: 412, height: 915 }, captureState: 'stable', cleanliness: { metroOverlay: 'absent', developmentErrorOverlay: 'absent', hostDebugChrome: 'absent' } },
      { route: keyFlow.route, screenId: 'CaptureReview', fontScale: 1.4, status: 'pass', captureId: 'key-large', platform: 'android', device: 'Pixel 8', dimensions: { width: 412, height: 915 }, captureState: 'stable', cleanliness: { metroOverlay: 'absent', developmentErrorOverlay: 'absent', hostDebugChrome: 'absent' } },
    ],
    checks,
  };
  assert.deepEqual(validateExperienceQaEvidence(manifest, projectRoot), []);
});
