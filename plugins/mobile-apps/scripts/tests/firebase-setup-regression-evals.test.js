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
const APNS_EVAL_PATH = path.join(PLUGIN_ROOT, 'skills/setup-apns/evals/evals.json');
const FIXTURE_ROOT = path.join(PLUGIN_ROOT, 'skills/setup-fcm/evals/fixtures');
const EXPECTED_COVERAGE = [
  'missing-adc',
  'mismatched-adc',
  'existing-project-selection',
  'create-new-project',
  'add-firebase-existing-gcp',
  'placeholder-native-identifiers',
  'exact-app-reuse',
  'duplicate-app-selection',
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
const EXPECTED_APNS_COVERAGE = [
  'apple-handoff-team-bundle-mismatch',
  'exact-selected-app-reuse',
  'fastlane-pem-p12-forbidden',
  'plist-identity-mismatch',
  'apns-key-manual-only',
  'validated-plist-override',
  'duplicate-safe-selected-app-continuity',
  'stale-or-drifted-selected-app',
  'configured-pending-device-verification',
  'prescribed-ios-chain',
  'unsupported-auto-upload',
  'valid-apple-identifier-handoff',
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

test('every planned setup-apns scenario is traceable exactly once', () => {
  const document = JSON.parse(fs.readFileSync(APNS_EVAL_PATH, 'utf8'));
  assert.strictEqual(document.skill_name, 'setup-apns');
  assert.deepStrictEqual(
    document.evals.map(({ coverage }) => coverage).sort(),
    EXPECTED_APNS_COVERAGE,
  );
  assert.deepStrictEqual(
    document.evals.map(({ id }) => id),
    Array.from({ length: EXPECTED_APNS_COVERAGE.length }, (_, index) => index + 1),
  );

  for (const evaluation of document.evals) {
    assert.ok(evaluation.prompt.trim(), `${evaluation.coverage} needs a prompt`);
    assert.ok(evaluation.expected_output.trim(), `${evaluation.coverage} needs expected output`);
    assert.deepStrictEqual(
      evaluation.files,
      [],
      `${evaluation.coverage} must remain a fixture-free guidance scenario`,
    );
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
      readJsonFixture('firebase-apps-duplicate-safe.json'),
      'android',
      EXPECTED.identifier,
    ).status,
    'selection-required',
  );
  assert.strictEqual(
    matchFirebaseApp(
      readJsonFixture('firebase-apps-duplicate-safe.json'),
      'android',
      EXPECTED.identifier,
      '1:123456789:android:second',
    ).status,
    'match',
  );
  assert.strictEqual(
    matchFirebaseApp(
      readJsonFixture('firebase-apps-conflicting.json'),
      'android',
      EXPECTED.identifier,
    ).status,
    'ambiguous',
  );
});

test('APNs continuity preserves the recorded iOS app across safe duplicates and blocks drift', () => {
  const apps = {
    status: 'success',
    result: [
      {
        appId: '1:123456789:ios:first',
        platform: 'IOS',
        bundleId: EXPECTED.identifier,
      },
      {
        appId: EXPECTED.iosAppId,
        platform: 'IOS',
        bundleId: EXPECTED.identifier,
      },
      {
        appId: '1:123456789:ios:other',
        platform: 'IOS',
        bundleId: 'com.contoso.other',
      },
    ],
  };

  const selected = matchFirebaseApp(
    apps,
    'ios',
    EXPECTED.identifier,
    EXPECTED.iosAppId,
  );
  assert.strictEqual(selected.status, 'match');
  assert.strictEqual(selected.selectedExplicitly, true);
  assert.strictEqual(selected.app.appId, EXPECTED.iosAppId);
  assert.strictEqual(selected.app.platform, 'IOS');
  assert.strictEqual(selected.app.bundleId, EXPECTED.identifier);

  const disappeared = matchFirebaseApp(
    apps,
    'ios',
    EXPECTED.identifier,
    '1:123456789:ios:missing',
  );
  assert.strictEqual(disappeared.status, 'ambiguous');
  assert.strictEqual(disappeared.conflicts[0].code, 'selected-app-id-not-found');

  const drifted = matchFirebaseApp(
    apps,
    'ios',
    EXPECTED.identifier,
    '1:123456789:ios:other',
  );
  assert.strictEqual(drifted.status, 'ambiguous');
  assert.strictEqual(drifted.conflicts[0].code, 'selected-app-identity-mismatch');
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
  assert.strictEqual(fixtureNames.length, 18);
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
  assert.match(skill, /--selected-app-id "<ANDROID_APP_ID>"/);
  assert.match(skill, /selection-required/);
  assert.match(skill, /\/setup-apns/);
  assert.match(skill, /Never request, download, copy, or commit a Firebase Admin/);
  assert.doesNotMatch(skill, /firebase-tools\s+(?:login|login:add|logout)(?:\s|`)/);

  const apnsSkill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/setup-apns/SKILL.md'), 'utf8');
  assert.match(apnsSkill, /--selected-app-id "<IOS_APP_ID>"/);
  assert.match(apnsSkill, /selected-app-id-not-found/);
  assert.match(apnsSkill, /selected-app-identity-mismatch/);
  assert.match(apnsSkill, /never fall back[\s\S]*exact-bundle candidate/i);
  assert.match(apnsSkill, /configured, device verification\s+pending/i);
  assert.match(apnsSkill, /Only `\/verify-ios-push` may change the status to physically verified/);
  assert.match(apnsSkill, /Return to `\/add-push-notifications`/);
  assert.match(apnsSkill, /validate-apple-identifier-capability\.js/);
  assert.match(apnsSkill, /--expected-team "<APPLE_TEAM_ID>"/);
  assert.match(apnsSkill, /--expected-bundle "<IOS_BUNDLE_ID>"/);
  assert.match(apnsSkill, /route the user to `\/setup-apple-ios`/i);
  assert.match(apnsSkill, /only supported Firebase credential route[\s\S]*authentication key \(`\.p8`\)/i);
  assert.match(apnsSkill, /Do not use Fastlane `pem`/);
  assert.match(apnsSkill, /There is no supported\s+Firebase CLI or Firebase Management API operation/i);
  assert.match(apnsSkill, /outside this and every other repository/);
  assert.match(apnsSkill, /exact immutable iOS app ID and\s+bundle ID validated in Phase 1/i);
  assert.match(apnsSkill, /confirmation that the manual upload succeeded plus the safe Key\s+ID and Team ID/i);
  assert.doesNotMatch(apnsSkill, /apps:create IOS/);
});
