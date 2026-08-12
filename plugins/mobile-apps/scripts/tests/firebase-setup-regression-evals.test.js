'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  matchFirebaseApp,
  resolveFirebaseAppIdentity,
} = require('../resolve-firebase-app-identity');
const {
  validateAndroidConfig,
  validateIosConfig,
} = require('../validate-firebase-client-config');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const EVAL_PATH = path.join(PLUGIN_ROOT, 'skills/setup-fcm/evals/evals.json');
const FIXTURE_ROOT = path.join(PLUGIN_ROOT, 'skills/setup-fcm/evals/fixtures');
const EXPECTED_COVERAGE = [
  'missing-adc',
  'mismatched-adc',
  'existing-project-selection',
  'create-new-project',
  'add-firebase-existing-gcp',
  'placeholder-native-identifiers',
  'exact-app-reuse',
  'missing-app-creation',
  'ambiguous-app-conflicts',
  'downloaded-android-project-mismatch',
  'downloaded-android-app-id-mismatch',
  'downloaded-android-package-mismatch',
  'downloaded-ios-project-mismatch',
  'downloaded-ios-app-id-mismatch',
  'downloaded-ios-bundle-mismatch',
  'safe-config-reuse',
  'conflict-replacement-gate',
  'android-only',
  'ios-only',
  'both-native-platforms',
  'auto-discovery-explicit-override',
  'firebase-admin-key-forbidden',
  'apns-manual-handoff',
].sort();
const EXPECTED = {
  projectId: 'field-ops-prod',
  androidAppId: '1:123456789:android:a1b2c3',
  iosAppId: '1:123456789:ios:d4e5f6',
  identifier: 'com.contoso.fieldops',
};

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURE_ROOT, name));
}

function readJsonFixture(name) {
  return JSON.parse(readFixture(name).toString('utf8'));
}

test('every planned setup-fcm scenario is traceable exactly once', () => {
  const document = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  assert.strictEqual(document.skill_name, 'setup-fcm');
  assert.deepStrictEqual(
    document.evals.map(({ coverage }) => coverage).sort(),
    EXPECTED_COVERAGE,
  );
  assert.deepStrictEqual(
    document.evals.map(({ id }) => id),
    Array.from({ length: EXPECTED_COVERAGE.length }, (_, index) => index + 1),
  );

  for (const evaluation of document.evals) {
    assert.ok(evaluation.prompt.trim(), `${evaluation.coverage} needs a prompt`);
    assert.ok(evaluation.expected_output.trim(), `${evaluation.coverage} needs expected output`);
    for (const relativePath of evaluation.files) {
      const fixturePath = path.resolve(PLUGIN_ROOT, relativePath);
      assert.ok(
        fixturePath.startsWith(`${FIXTURE_ROOT}${path.sep}`),
        `${evaluation.coverage} fixture must stay under setup-fcm/evals/fixtures`,
      );
      assert.ok(fs.statSync(fixturePath).isFile(), `${relativePath} must be a fixture file`);
    }
  }
});

test('sanitized identity and app-list fixtures drive deterministic offline branches', () => {
  const platformCases = [
    ['expo-android-only.json', ['android', 'web'], 'ready'],
    ['expo-ios-only.json', ['ios', 'web'], 'ready'],
    ['expo-both.json', ['ios', 'android', 'web'], 'ready'],
    ['expo-placeholder-both.json', ['ios', 'android'], 'invalid'],
  ];
  for (const [name, platforms, status] of platformCases) {
    const result = resolveFirebaseAppIdentity(readJsonFixture(name));
    assert.strictEqual(result.status, status, name);
    assert.deepStrictEqual(result.targetPlatforms, platforms, name);
  }

  const exact = readJsonFixture('firebase-apps-exact.json');
  assert.strictEqual(
    matchFirebaseApp(exact, 'android', EXPECTED.identifier).status,
    'match',
  );
  assert.strictEqual(
    matchFirebaseApp(exact, 'ios', EXPECTED.identifier).status,
    'match',
  );
  assert.strictEqual(
    matchFirebaseApp(
      readJsonFixture('firebase-apps-missing.json'),
      'android',
      EXPECTED.identifier,
    ).status,
    'no-match',
  );
  assert.strictEqual(
    matchFirebaseApp(
      readJsonFixture('firebase-apps-ambiguous.json'),
      'android',
      EXPECTED.identifier,
    ).status,
    'ambiguous',
  );
});

test('sanitized SDK fixtures cover exact project, app, package, and bundle validation', () => {
  const androidExpected = {
    projectId: EXPECTED.projectId,
    appId: EXPECTED.androidAppId,
    identifier: EXPECTED.identifier,
  };
  assert.deepStrictEqual(
    validateAndroidConfig(readFixture('google-services-valid.json'), androidExpected),
    [],
  );
  assert.deepStrictEqual(
    validateAndroidConfig(
      readFixture('google-services-wrong-project.json'),
      androidExpected,
    ).map(({ code }) => code),
    ['project-id-mismatch'],
  );
  assert.deepStrictEqual(
    validateAndroidConfig(
      readFixture('google-services-wrong-app.json'),
      androidExpected,
    ).map(({ code }) => code),
    ['android-app-identity-mismatch'],
  );
  assert.deepStrictEqual(
    validateAndroidConfig(
      readFixture('google-services-wrong-package.json'),
      androidExpected,
    ).map(({ code }) => code),
    ['android-app-identity-mismatch'],
  );
  assert.deepStrictEqual(
    validateAndroidConfig(
      readFixture('firebase-admin-redacted.json'),
      androidExpected,
    ).map(({ code }) => code),
    ['admin-service-account-forbidden'],
  );

  const iosExpected = {
    projectId: EXPECTED.projectId,
    appId: EXPECTED.iosAppId,
    identifier: EXPECTED.identifier,
  };
  assert.deepStrictEqual(
    validateIosConfig(readFixture('GoogleService-Info-valid.plist'), iosExpected),
    [],
  );
  assert.deepStrictEqual(
    validateIosConfig(
      readFixture('GoogleService-Info-wrong-project.plist'),
      iosExpected,
    ).map(({ code }) => code),
    ['project-id-mismatch'],
  );
  assert.deepStrictEqual(
    validateIosConfig(
      readFixture('GoogleService-Info-wrong-app.plist'),
      iosExpected,
    ).map(({ code }) => code),
    ['ios-app-id-mismatch'],
  );
  assert.deepStrictEqual(
    validateIosConfig(
      readFixture('GoogleService-Info-wrong-bundle.plist'),
      iosExpected,
    ).map(({ code }) => code),
    ['ios-bundle-id-mismatch'],
  );
});

test('fixtures and workflow remain sanitized and require no network or Admin key', () => {
  const fixtureNames = fs.readdirSync(FIXTURE_ROOT).sort();
  assert.strictEqual(fixtureNames.length, 17);
  for (const name of fixtureNames) {
    const content = readFixture(name).toString('utf8');
    assert.doesNotMatch(content, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    assert.doesNotMatch(content, /ya29\.|AIza[0-9A-Za-z_-]{20,}/);
  }

  const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/setup-fcm/SKILL.md'), 'utf8');
  assert.match(skill, /projects:create <PROJECT_ID>/);
  assert.match(skill, /projects:addfirebase <PROJECT_ID>/);
  assert.match(skill, /apps:create ANDROID/);
  assert.match(skill, /apps:create IOS/);
  assert.match(skill, /\/setup-apns/);
  assert.match(skill, /Never request, download, copy, or commit a Firebase Admin/);
  assert.doesNotMatch(skill, /firebase-tools\s+(?:login|login:add|logout)(?:\s|`)/);
});
