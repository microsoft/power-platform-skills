'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  SafeError,
  assertProfilePath,
  parseArgs,
  resolveProvisioningProfilesDirectory,
  verifyProfile,
} = require('../verify-apple-ios-build-signing');

const TEAM = 'ABCD1234EF';
const BUNDLE = 'com.contoso.fieldops';
const UUID = '11111111-2222-3333-4444-555555555555';
const WORK = path.join(__dirname, '.verify-apple-signing-work');

test.afterEach(() => fs.rmSync(WORK, { recursive: true, force: true }));

function certificate(commonName) {
  // Tests keep cryptographic parsing out of fixtures; profile checks accept the
  // same inert certificate through a narrowly scoped X509 constructor mock.
  return { commonName, fingerprint: 'AA'.repeat(20) };
}

function profile(mode = 'development') {
  return {
    UUID,
    TeamIdentifier: [TEAM],
    ExpirationDate: '2099-01-01T00:00:00.000Z',
    ProvisionedDevices: ['redacted-device'],
    DeveloperCertificates: ['inert-base64'],
    Entitlements: {
      'application-identifier': `${TEAM}.${BUNDLE}`,
      'com.apple.developer.team-identifier': TEAM,
      'aps-environment': mode === 'development' ? 'development' : 'production',
      'get-task-allow': mode === 'development',
    },
  };
}

function withMockedX509(mockCertificate, callback) {
  const original = crypto.X509Certificate;
  crypto.X509Certificate = class {
    constructor() {
      this.subject = `CN=${mockCertificate.commonName}\nOU=${TEAM}`;
      this.fingerprint = mockCertificate.fingerprint;
    }
  };
  try {
    callback();
  } finally {
    crypto.X509Certificate = original;
  }
}

test('requires an explicit supported build mode and exact identity arguments', () => {
  assert.deepStrictEqual(
    parseArgs([
      '--project-root', '.',
      '--mode', 'ad-hoc',
      '--expected-team', TEAM,
      '--expected-bundle', BUNDLE,
    ]).mode,
    'ad-hoc',
  );
  assert.throws(() => parseArgs(['--project-root', '.']), /invalid-arguments/);
  assert.throws(
    () => parseArgs([
      '--project-root', '.',
      '--mode', 'app-store',
      '--expected-team', TEAM,
      '--expected-bundle', BUNDLE,
    ]),
    /invalid-arguments/,
  );
});

test('resolves the installed-profile directory from an explicitly mocked Xcode version', () => {
  assert.strictEqual(
    resolveProvisioningProfilesDirectory({
      home: '/Users/sanitized',
      xcodeVersion: 'Xcode 16.2\nBuild version 16C5032a',
    }),
    '/Users/sanitized/Library/Developer/Xcode/UserData/Provisioning Profiles',
  );
  assert.strictEqual(
    resolveProvisioningProfilesDirectory({
      home: '/Users/sanitized',
      xcodeVersion: 'Xcode 15.4\nBuild version 15F31d',
    }),
    '/Users/sanitized/Library/MobileDevice/Provisioning Profiles',
  );
});

test('accepts the deeper Xcode 16 profile path without deriving the wrong home', () => {
  const profileRoot = path.join(
    WORK,
    'Library',
    'Developer',
    'Xcode',
    'UserData',
    'Provisioning Profiles',
  );
  fs.mkdirSync(profileRoot, { recursive: true });
  const profilePath = path.join(profileRoot, `${UUID}.mobileprovision`);
  fs.writeFileSync(profilePath, 'sanitized');
  assert.doesNotThrow(() => assertProfilePath(profilePath, profileRoot, WORK));
});

test('proves a development profile has matching Team, bundle, APNs mode, and identity', () => {
  withMockedX509(certificate('Apple Development: Hidden'), () => {
    assert.doesNotThrow(() => verifyProfile(
      profile('development'),
      { uuid: UUID },
      TEAM,
      BUNDLE,
      'development',
      new Set(['AA'.repeat(20)]),
    ));
  });
});

test('proves an ad-hoc profile uses production APNs and a distribution identity', () => {
  withMockedX509(certificate('Apple Distribution: Hidden'), () => {
    assert.doesNotThrow(() => verifyProfile(
      profile('ad-hoc'),
      { uuid: UUID },
      TEAM,
      BUNDLE,
      'ad-hoc',
      new Set(['AA'.repeat(20)]),
    ));
  });
});

test('blocks APNs drift without exposing profile UUID or certificate name', () => {
  const candidate = profile('development');
  candidate.Entitlements['aps-environment'] = 'production';
  let error;
  try {
    verifyProfile(
      candidate,
      { uuid: UUID },
      TEAM,
      BUNDLE,
      'development',
      new Set(['AA'.repeat(20)]),
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof SafeError);
  assert.strictEqual(error.code, 'installed-profile-apns-mismatch');
  assert.doesNotMatch(error.message, new RegExp(UUID));
  assert.doesNotMatch(error.message, /Apple Development/);
});

test('blocks a profile that does not contain the usable dedicated-keychain identity', () => {
  withMockedX509(certificate('Apple Development: Hidden'), () => {
    assert.throws(
      () => verifyProfile(
        profile('development'),
        { uuid: UUID },
        TEAM,
        BUNDLE,
        'development',
        new Set(['BB'.repeat(20)]),
      ),
      /installed-profile-identity-mismatch/,
    );
  });
});
