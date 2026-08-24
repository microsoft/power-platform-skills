'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateContract } = require('../validate-apple-ios-provisioning');

const SCRIPT = path.join(__dirname, '..', 'validate-apple-ios-provisioning.js');
const TEST_ROOT = path.join(__dirname, '.validate-apple-ios-provisioning-work');
const NOW = new Date('2026-08-21T06:00:00.000Z');
const TEAM_ID = 'A1B2C3D4E5';
const BUNDLE_ID = 'com.contoso.fieldapp';

function contract() {
  const commonProfile = {
    expiresAt: '2027-08-21T06:00:00.000Z',
    bundleId: 'com.contoso.fieldapp',
    teamId: 'A1B2C3D4E5',
    deviceCount: 12,
    proof: 'installed-profile-metadata-readback',
  };
  return {
    version: 1,
    modes: ['development', 'ad-hoc'],
    teamId: 'A1B2C3D4E5',
    bundleId: 'com.contoso.fieldapp',
    pushCapability: {
      capability: 'aps-environment',
      enabled: true,
      proof: 'app-id-capability-readback',
    },
    keychain: {
      serviceIdentifier: 'security-default-keychain',
      pathFingerprint: `sha256:${'a'.repeat(64)}`,
    },
    certificates: {
      development: {
        resourceId: `apple-development:${'b'.repeat(64)}`,
        type: 'apple-development',
        expiresAt: '2027-08-21T06:00:00.000Z',
        proof: 'keychain-identity-readback',
      },
      distribution: {
        resourceId: `apple-distribution:${'c'.repeat(64)}`,
        type: 'apple-distribution',
        expiresAt: '2027-08-21T06:00:00.000Z',
        proof: 'keychain-identity-readback',
      },
    },
    profiles: {
      development: {
        ...commonProfile,
        uuid: '11111111-2222-3333-4444-555555555555',
        type: 'development',
        apnsEnvironment: 'development',
        getTaskAllow: true,
        certificateResourceId: `apple-development:${'b'.repeat(64)}`,
        certificateType: 'apple-development',
      },
      adHoc: {
        ...commonProfile,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        type: 'ad-hoc',
        apnsEnvironment: 'production',
        getTaskAllow: false,
        certificateResourceId: `apple-distribution:${'c'.repeat(64)}`,
        certificateType: 'apple-distribution',
      },
    },
    proof: {
      verifier: 'apple-ios-provisioning-preflight',
      verifierVersion: '1.0.0',
      verifiedAt: '2026-08-21T05:00:00.000Z',
      validUntil: '2026-08-22T05:00:00.000Z',
      steps: {
        teamAndBundleVerified: true,
        pushCapabilityVerified: true,
        keychainVerified: true,
        developmentCertificateVerified: true,
        distributionCertificateVerified: true,
        developmentProfileVerified: true,
        adHocProfileVerified: true,
      },
    },
  };
}

function codes(value, options = {}) {
  return validateContract(value, { now: NOW, ...options }).map((entry) => entry.code);
}

test.after(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

test('CLI accepts an explicit supported selected mode', () => {
  const root = path.join(TEST_ROOT, 'selected-mode');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'apple-ios-provisioning.json'), JSON.stringify(contract()));
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--project-root', root,
    '--expected-team', TEAM_ID,
    '--expected-bundle', BUNDLE_ID,
    '--expected-mode', 'development',
    '--now', NOW.toISOString(),
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stdout);
  assert.strictEqual(JSON.parse(result.stdout).status, 'valid');
});

test('CLI rejects App Store as a selected provisioning mode', () => {
  const root = path.join(TEST_ROOT, 'unsupported-selected-mode');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'apple-ios-provisioning.json'), JSON.stringify(contract()));
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--project-root', root,
    '--expected-team', TEAM_ID,
    '--expected-bundle', BUNDLE_ID,
    '--expected-mode', 'app-store',
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.strictEqual(JSON.parse(result.stdout).issues[0].code, 'invalid-expected-mode');
});

test('accepts a complete non-secret version 1 contract', () => {
  assert.deepStrictEqual(codes(contract(), {
    expectedTeam: 'A1B2C3D4E5',
    expectedBundle: 'com.contoso.fieldapp',
  }), []);
});

test('rejects unknown versions, fields, wrong expected identity, and invalid proof modes', () => {
  const value = contract();
  value.version = 2;
  value.modes = ['app-store'];
  value.extra = true;
  value.proof.verifier = 'other-tool';
  assert.ok(codes(value, {
    expectedTeam: 'Z9Y8X7W6V5',
    expectedBundle: 'com.contoso.other',
  }).includes('unsupported-version'));
  assert.ok(codes(value).includes('unsupported-mode'));
  assert.ok(codes(value).includes('unknown-field'));
  assert.ok(codes(value).includes('proof-verifier-mismatch'));
  assert.ok(codes(value, { expectedTeam: 'Z9Y8X7W6V5' }).includes('team-mismatch'));
  assert.ok(codes(value, { expectedBundle: 'com.contoso.other' }).includes('bundle-mismatch'));
});

test('rejects Apple identities, secrets, signing contents, paths, and UDIDs', () => {
  for (const [key, value] of [
    ['appleId', 'maker@contoso.com'],
    ['password', 'not-allowed'],
    ['twoFactorCode', '123456'],
    ['sessionCookie', 'cookie'],
    ['apiKey', 'not-allowed'],
    ['privateKey', '-----BEGIN PRIVATE KEY-----'],
    ['certificatePath', '/Users/maker/signing.p12'],
    ['profileContent', '<?xml version="1.0"?><plist></plist>'],
    ['udid', '00008110-001234123456801E'],
  ]) {
    const valueContract = contract();
    valueContract[key] = value;
    const result = codes(valueContract);
    assert.ok(
      result.includes('secret-field-forbidden') || result.includes('sensitive-value-forbidden'),
      `${key} should be rejected`,
    );
  }
});

test('rejects incomplete, stale, future, and overlong proof', () => {
  const incomplete = contract();
  incomplete.proof.steps.adHocProfileVerified = false;
  assert.ok(codes(incomplete).includes('proof-step-incomplete'));

  const stale = contract();
  stale.proof.verifiedAt = '2026-08-19T05:00:00.000Z';
  stale.proof.validUntil = '2026-08-20T05:00:00.000Z';
  assert.ok(codes(stale).includes('stale-proof'));

  const future = contract();
  future.proof.verifiedAt = '2026-08-21T07:00:00.000Z';
  future.proof.validUntil = '2026-08-22T07:00:00.000Z';
  assert.ok(codes(future).includes('proof-from-future'));

  const overlong = contract();
  overlong.proof.validUntil = '2026-08-23T05:00:00.000Z';
  assert.ok(codes(overlong).includes('invalid-proof-window'));
});

test('rejects invalid certificate/profile metadata and APNs mappings', () => {
  const value = contract();
  value.certificates.development.type = 'apple-distribution';
  value.certificates.distribution.expiresAt = '2026-08-21T05:30:00.000Z';
  value.profiles.development.teamId = 'Z9Y8X7W6V5';
  value.profiles.development.bundleId = 'com.contoso.other';
  value.profiles.development.deviceCount = 0;
  value.profiles.adHoc.apnsEnvironment = 'development';
  value.profiles.adHoc.getTaskAllow = true;
  value.profiles.adHoc.certificateResourceId = 'different-resource';
  const result = codes(value);
  assert.ok(result.includes('certificate-type-mismatch'));
  assert.ok(result.includes('expired-or-insufficient-resource'));
  assert.ok(result.includes('profile-team-mismatch'));
  assert.ok(result.includes('profile-bundle-mismatch'));
  assert.ok(result.includes('invalid-device-count'));
  assert.ok(result.includes('profile-apns-mismatch'));
  assert.ok(result.includes('profile-mode-mismatch'));
  assert.ok(result.includes('profile-certificate-resource-mismatch'));
});

test('CLI emits structured JSON and uses exit 0/2 for valid/invalid contracts', () => {
  const root = path.join(TEST_ROOT, 'cli-project');
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'apple-ios-provisioning.json');
  fs.writeFileSync(file, JSON.stringify(contract()));

  const valid = spawnSync(process.execPath, [
    SCRIPT,
    '--project-root', root,
    '--expected-team', 'A1B2C3D4E5',
    '--expected-bundle', 'com.contoso.fieldapp',
    '--now', NOW.toISOString(),
  ], { encoding: 'utf8' });
  assert.strictEqual(valid.status, 0, valid.stdout);
  assert.strictEqual(JSON.parse(valid.stdout).status, 'valid');

  const invalid = contract();
  invalid.pushCapability.enabled = false;
  fs.writeFileSync(file, JSON.stringify(invalid));
  const result = spawnSync(process.execPath, [
    SCRIPT,
    '--project-root', root,
    '--now', NOW.toISOString(),
  ], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.strictEqual(JSON.parse(result.stdout).status, 'invalid');
});

test('CLI rejects outside, symlinked file, nested symlink, and symlinked project paths', (t) => {
  const root = path.join(TEST_ROOT, 'safe-project');
  const outside = path.join(TEST_ROOT, 'outside.json');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(outside, JSON.stringify(contract()));

  const outsideResult = spawnSync(process.execPath, [
    SCRIPT, '--project-root', root, '--file', '../outside.json',
  ], { encoding: 'utf8' });
  assert.strictEqual(outsideResult.status, 1);

  const fileLink = path.join(root, 'apple-ios-provisioning.json');
  fs.symlinkSync(outside, fileLink);
  t.after(() => fs.rmSync(fileLink, { force: true }));
  const fileLinkResult = spawnSync(process.execPath, [
    SCRIPT, '--project-root', root,
  ], { encoding: 'utf8' });
  assert.strictEqual(fileLinkResult.status, 1);

  const nestedTarget = path.join(root, 'real');
  fs.mkdirSync(nestedTarget);
  fs.writeFileSync(path.join(nestedTarget, 'contract.json'), JSON.stringify(contract()));
  const nestedLink = path.join(root, 'linked');
  fs.symlinkSync(nestedTarget, nestedLink);
  t.after(() => fs.rmSync(nestedLink, { force: true }));
  const nestedResult = spawnSync(process.execPath, [
    SCRIPT, '--project-root', root, '--file', 'linked/contract.json',
  ], { encoding: 'utf8' });
  assert.strictEqual(nestedResult.status, 1);

  const rootLink = path.join(TEST_ROOT, 'project-link');
  fs.symlinkSync(root, rootLink);
  t.after(() => fs.rmSync(rootLink, { force: true }));
  const rootResult = spawnSync(process.execPath, [
    SCRIPT, '--project-root', rootLink, '--file', 'real/contract.json',
  ], { encoding: 'utf8' });
  assert.strictEqual(rootResult.status, 1);
});
