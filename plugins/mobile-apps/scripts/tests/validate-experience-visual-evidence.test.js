'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { deriveExperienceFromBrief } = require('../experience-patterns');
const { validate } = require('../validate-experience-visual-evidence');

function projectWithContract(context) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-visual-'));
  context.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(projectRoot, '.tmp'), { recursive: true });
  const contract = deriveExperienceFromBrief('Let a user scan a receipt, capture its details, and submit the result.');
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-contract.json'), `${JSON.stringify(contract, null, 2)}\n`);
  const keyFlow = {
    route: '/(app)/capture/review',
    file: 'app/(app)/capture/review.tsx',
    outcome: 'Review the captured receipt before submitting it.',
  };
  fs.writeFileSync(path.join(projectRoot, '.tmp', 'experience-screen-contract.json'), `${JSON.stringify({ schemaVersion: 1, keyFlow }, null, 2)}\n`);
  return { projectRoot, contract, keyFlow };
}

function passingManifest(contract, keyFlow) {
  const capture = (route, screenId, fontScale, captureId, platform, device) => ({
    route,
    screenId,
    fontScale,
    status: 'pass',
    captureId,
    platform,
    device,
    dimensions: { width: platform === 'ios' ? 390 : 412, height: platform === 'ios' ? 844 : 915 },
    captureState: 'stable',
    cleanliness: { metroOverlay: 'absent', developmentErrorOverlay: 'absent', hostDebugChrome: 'absent' },
  });
  const scopes = ['primary', 'key-flow'];
  const checks = ['focalPoint', 'regionOrder', 'primaryAction', 'taskFit', 'contentRealism', 'signatureMotifs', 'forbiddenDefaults', 'contrast', 'touchTargets', 'safeAreas', 'headerOwnership', 'mediaFallback', 'cardListDensity', 'contentCrop', 'bottomClearance', 'offlineState', 'screenReaderOrder', 'responsiveLayout', 'localizedContent']
    .map((id) => ({ id, status: 'pass', scopes, evidence: [`native review for ${id}`], captureIds: ['normal-home', 'normal-key-flow'] }));
  checks.push({ id: 'keyboard', status: 'not-applicable', scopes, evidence: ['Capture flow has no text entry in this review.'], captureIds: ['normal-home', 'normal-key-flow'], reason: 'No keyboard-triggering control is present in the approved key flow.' });
  return {
    schemaVersion: 1,
    experienceContractRoute: contract.primaryScreen.route,
    keyFlowRoute: keyFlow.route,
    captureMatrix: [
      capture(contract.primaryScreen.route, 'Home', 1, 'normal-home', 'ios', 'iPhone 15'),
      capture(contract.primaryScreen.route, 'Home', 1.4, 'large-home', 'ios', 'iPhone 15'),
      capture(keyFlow.route, 'CaptureReview', 1, 'normal-key-flow', 'android', 'Pixel 8'),
      capture(keyFlow.route, 'CaptureReview', 1.4, 'large-key-flow', 'android', 'Pixel 8'),
    ],
    checks,
  };
}

test('accepts native evidence for the generic experience contract', (context) => {
  const { projectRoot, contract, keyFlow } = projectWithContract(context);
  assert.deepEqual(validate(projectRoot, passingManifest(contract, keyFlow)), []);
});

test('rejects Metro Refreshing banners and host debug chrome even when capture status says pass', (context) => {
  const { projectRoot, contract, keyFlow } = projectWithContract(context);
  const manifest = passingManifest(contract, keyFlow);
  manifest.captureMatrix[0].ocrText = 'Refreshing...';
  manifest.captureMatrix[1].cleanliness.hostDebugChrome = 'present';
  const issues = validate(projectRoot, manifest);
  assert.ok(issues.some((issue) => issue.rule === 'unclean-native-capture' && /overlay text/.test(issue.message)));
  assert.ok(issues.some((issue) => issue.rule === 'unclean-native-capture' && /host debug chrome/.test(issue.message)));
});

test('rejects missing large-text capture and motif review', (context) => {
  const { projectRoot, contract, keyFlow } = projectWithContract(context);
  const manifest = passingManifest(contract, keyFlow);
  manifest.captureMatrix.pop();
  manifest.checks = manifest.checks.filter((check) => check.id !== 'signatureMotifs');
  const rules = new Set(validate(projectRoot, manifest).map((issue) => issue.rule));
  assert.ok(rules.has('missing-large-text-capture'));
  assert.ok(rules.has('missing-experience-check'));
});