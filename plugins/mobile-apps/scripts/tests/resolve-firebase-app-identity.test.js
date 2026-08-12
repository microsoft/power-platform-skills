'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  matchFirebaseApp,
  resolveFirebaseAppIdentity,
} = require('../resolve-firebase-app-identity');

const SCRIPT = path.join(__dirname, '..', 'resolve-firebase-app-identity.js');

function validConfig(overrides = {}) {
  return {
    name: 'Field Service',
    platforms: ['ios', 'android', 'web'],
    android: { package: 'com.contoso.fieldservice' },
    ios: { bundleIdentifier: 'com.contoso.field-service' },
    ...overrides,
  };
}

function run(args, input = '') {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8',
    input,
  });
}

function createProjectFixture() {
  // Keep runtime fixtures under the repository instead of the OS temp directory. This
  // also makes the path-containment tests exercise the same project boundary as callers.
  return fs.mkdtempSync(path.join(__dirname, '.firebase-identity-fixture-'));
}

test('resolves all selected identities from direct Expo public config', () => {
  const result = resolveFirebaseAppIdentity(validConfig());

  assert.strictEqual(result.status, 'ready');
  assert.deepStrictEqual(result.identity, {
    displayName: 'Field Service',
    androidPackage: 'com.contoso.fieldservice',
    iosBundleIdentifier: 'com.contoso.field-service',
  });
  assert.deepStrictEqual(result.targetPlatforms, ['ios', 'android', 'web']);
  assert.strictEqual(result.platforms.android.state, 'valid');
  assert.strictEqual(result.platforms.ios.state, 'valid');
  assert.deepStrictEqual(result.issues, []);
});

test('flags selected template placeholders', () => {
  const result = resolveFirebaseAppIdentity(validConfig({
    platforms: ['android', 'ios'],
    android: { package: 'com.contoso.powerappsapp' },
    ios: { bundleIdentifier: 'COM.CONTOSO.POWERAPPSAPP' },
  }));

  assert.strictEqual(result.status, 'invalid');
  assert.strictEqual(result.platforms.android.placeholder, true);
  assert.strictEqual(result.platforms.ios.placeholder, true);
  assert.deepStrictEqual(
    result.issues.map((entry) => entry.code),
    ['ios-identifier-placeholder', 'android-identifier-placeholder'],
  );
});

test('validates only identifiers for selected native platforms', () => {
  const result = resolveFirebaseAppIdentity(validConfig({
    platforms: ['android', 'web'],
    android: { package: '9invalid.package' },
    ios: { bundleIdentifier: 'com.contoso.powerappsapp' },
  }));

  assert.strictEqual(result.status, 'invalid');
  assert.deepStrictEqual(result.targetPlatforms, ['android', 'web']);
  assert.strictEqual(result.platforms.ios.state, 'not-selected');
  assert.strictEqual(result.platforms.ios.placeholder, true);
  assert.deepStrictEqual(result.issues.map((entry) => entry.code), ['android-identifier-invalid']);
});

test('flags missing display name, missing selected identifier, and invalid platforms', () => {
  const result = resolveFirebaseAppIdentity({
    name: ' ',
    platforms: ['ios', 'windows', 'ios'],
    ios: {},
  });

  assert.strictEqual(result.status, 'invalid');
  assert.deepStrictEqual(result.targetPlatforms, ['ios']);
  assert.deepStrictEqual(
    result.issues.map((entry) => entry.code),
    ['display-name-missing', 'platform-invalid', 'platform-duplicate', 'ios-identifier-missing'],
  );
});

test('reads evaluated config from stdin and emits structured JSON', () => {
  const result = run(['--project-root', '.'], JSON.stringify(validConfig({
    platforms: ['web'],
    android: {},
    ios: {},
  })));

  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.status, 'ready');
  assert.deepStrictEqual(output.source, { kind: 'stdin' });
  assert.deepStrictEqual(output.targetPlatforms, ['web']);
  assert.strictEqual(output.platforms.android.state, 'not-selected');
  assert.strictEqual(result.stderr, '');
});

test('reads a file inside project root and reports its relative source', (t) => {
  const root = createProjectFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'expo-public.json'), JSON.stringify(validConfig()));

  const result = run([
    '--project-root', root,
    '--input', 'config/expo-public.json',
  ]);

  assert.strictEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.deepStrictEqual(output.source, { kind: 'file', path: 'config/expo-public.json' });
  assert.strictEqual(output.identity.androidPackage, 'com.contoso.fieldservice');
});

test('rejects traversal outside project root without reading the file', (t) => {
  const root = createProjectFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(path.dirname(root), 'outside-public-config.json');
  fs.writeFileSync(outside, JSON.stringify(validConfig()));
  t.after(() => fs.rmSync(outside, { force: true }));

  const result = run([
    '--project-root', root,
    '--input', path.relative(root, outside),
  ]);

  assert.strictEqual(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.status, 'error');
  assert.strictEqual(output.issues[0].code, 'input-outside-project-root');
});

test('rejects a project-local symlink rather than following it', (t) => {
  const root = createProjectFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.json');
  const link = path.join(root, 'linked.json');
  fs.writeFileSync(target, JSON.stringify(validConfig()));
  fs.symlinkSync(target, link);

  const result = run(['--project-root', root, '--input', 'linked.json']);

  assert.strictEqual(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.issues[0].code, 'input-symbolic-link');
});

test('returns exit 2 with findings for invalid evaluated config', () => {
  const result = run(['--project-root', '.'], JSON.stringify(validConfig({
    platforms: ['android'],
    android: { package: 'com.contoso.powerappsapp' },
  })));

  assert.strictEqual(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.status, 'invalid');
  assert.strictEqual(output.issues[0].field, 'android.package');
});

test('matches an exact Android package in the Firebase CLI success envelope', () => {
  const result = matchFirebaseApp({
    status: 'success',
    result: [
      {
        appId: '1:123:android:exact',
        displayName: 'Field Service Android',
        platform: 'ANDROID',
        packageName: 'com.contoso.fieldservice',
      },
      {
        appId: '1:123:android:case-different',
        platform: 'ANDROID',
        packageName: 'com.Contoso.FieldService',
      },
    ],
  }, 'android', 'com.contoso.fieldservice');

  assert.strictEqual(result.status, 'match');
  assert.strictEqual(result.app.appId, '1:123:android:exact');
  assert.strictEqual(result.app.packageName, 'com.contoso.fieldservice');
});

test('matches an exact iOS bundle ID from a direct Firebase app array', () => {
  const result = matchFirebaseApp([
    {
      appId: '1:123:ios:exact',
      displayName: 'Field Service iOS',
      platform: 'IOS',
      bundleId: 'com.contoso.field-service',
    },
  ], 'ios', 'com.contoso.field-service');

  assert.strictEqual(result.status, 'match');
  assert.strictEqual(result.app.appId, '1:123:ios:exact');
});

test('accepts an apps platform-bucket envelope and reports no exact match', () => {
  const result = matchFirebaseApp({
    apps: {
      android: [{
        appId: '1:123:android:other',
        platform: 'ANDROID',
        packageName: 'com.contoso.other',
      }],
      ios: [],
      web: [],
    },
  }, 'android', 'com.contoso.fieldservice');

  assert.strictEqual(result.status, 'no-match');
  assert.strictEqual(result.app, null);
});

test('reports ambiguous when multiple app IDs have the exact Android package', () => {
  const result = matchFirebaseApp({
    status: 'success',
    result: [
      {
        appId: '1:123:android:first',
        platform: 'ANDROID',
        packageName: 'com.contoso.fieldservice',
      },
      {
        appId: '1:123:android:second',
        platform: 'ANDROID',
        packageName: 'com.contoso.fieldservice',
      },
    ],
  }, 'android', 'com.contoso.fieldservice');

  assert.strictEqual(result.status, 'ambiguous');
  assert.deepStrictEqual(result.matches.map((app) => app.appId), [
    '1:123:android:first',
    '1:123:android:second',
  ]);
  assert.strictEqual(result.conflicts[0].code, 'duplicate-identity');
});

test('reports conflicting duplicate app ID records as ambiguous', () => {
  const result = matchFirebaseApp([
    {
      appId: '1:123:ios:shared',
      platform: 'IOS',
      bundleId: 'com.contoso.field-service',
    },
    {
      appId: '1:123:ios:shared',
      platform: 'IOS',
      bundleId: 'com.contoso.other',
    },
  ], 'ios', 'com.contoso.field-service');

  assert.strictEqual(result.status, 'ambiguous');
  assert.strictEqual(result.conflicts[0].code, 'app-id-conflict');
});

test('does not create around an exact identity record with missing platform metadata', () => {
  const result = matchFirebaseApp([
    {
      appId: '1:123:android:unknown-platform',
      packageName: 'com.contoso.fieldservice',
    },
  ], 'android', 'com.contoso.fieldservice');

  assert.strictEqual(result.status, 'ambiguous');
  assert.strictEqual(result.conflicts[0].code, 'platform-conflict');
});

test('CLI matching mode emits structured status and rejects failed Firebase envelopes', () => {
  const matched = run(
    ['--project-root', '.', '--match-platform', 'ios', '--identifier', 'com.contoso.field-service'],
    JSON.stringify({
      status: 'success',
      result: [{
        appId: '1:123:ios:exact',
        platform: 'IOS',
        bundleId: 'com.contoso.field-service',
      }],
    }),
  );
  assert.strictEqual(matched.status, 0);
  assert.strictEqual(JSON.parse(matched.stdout).status, 'match');

  const failed = run(
    ['--project-root', '.', '--match-platform', 'ios', '--identifier', 'com.contoso.field-service'],
    JSON.stringify({ status: 'error', result: [] }),
  );
  assert.strictEqual(failed.status, 1);
  assert.strictEqual(JSON.parse(failed.stdout).issues[0].code, 'apps-list-failed');
});
