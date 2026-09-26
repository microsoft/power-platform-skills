'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateProject } = require('../validate-ios-wrap-build');
const { bounded, redact, sanitize } = require('../filter-ios-build-output');

const TEST_ROOT = path.join(__dirname, '.ios-wrap-build-work');
const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = 'ABCD1234EF';
const EVAL_PATH = path.join(__dirname, '..', '..', 'skills', 'build-ios', 'evals', 'evals.json');
const SKILL_PATH = path.join(__dirname, '..', '..', 'skills', 'build-ios', 'SKILL.md');
const VERIFY_SKILL_PATH = path.join(__dirname, '..', '..', 'skills', 'verify-ios-push', 'SKILL.md');
const FILTER_PATH = path.join(__dirname, '..', 'filter-ios-build-output.js');

function project(name, overrides = {}) {
  const root = path.join(TEST_ROOT, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'firebase'), { recursive: true });
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), 'png');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { 'build:ios': 'wrap ios', 'bundle:ios': 'js-bundle ios' },
  }));
  fs.writeFileSync(path.join(root, 'auth.config.json'), JSON.stringify({
    msal: { clientId: CLIENT_ID, tenantId: TENANT_ID },
  }));
  const wrap = {
    bundleIdentifier: 'com.contoso.fieldops',
    displayName: 'Field Ops',
    version: '1.2.3',
    versionCode: 7,
    iconPath: './assets/icon.png',
    msal: { clientId: CLIENT_ID, tenantId: TENANT_ID },
    ios: {
      simulator: false,
      signing: { exportMethod: 'development', teamId: TEAM_ID },
    },
    outputPath: './dist',
    ...overrides.wrap,
  };
  fs.writeFileSync(path.join(root, 'wrap.config.json'), JSON.stringify(wrap));
  fs.writeFileSync(path.join(root, 'app.config.js'), `
module.exports = {
  name: process.env.APP_DISPLAY_NAME,
  version: process.env.APP_VERSION,
  icon: process.env.APP_ICON_PATH,
  ios: {
    bundleIdentifier: process.env.IOS_BUNDLE_IDENTIFIER,
    googleServicesFile: './firebase/GoogleService-Info.plist',
    entitlements: { 'aps-environment': process.env.APNS_ENVIRONMENT },
  },
};
`);
  const plistBundle = overrides.plistBundle || wrap.bundleIdentifier;
  fs.writeFileSync(path.join(root, 'firebase', 'GoogleService-Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PROJECT_ID</key><string>field-ops-prod</string>
<key>GOOGLE_APP_ID</key><string>1:123456789:ios:abc123</string>
<key>BUNDLE_ID</key><string>${plistBundle}</string>
</dict></plist>`);
  if (overrides.extraFile) {
    fs.writeFileSync(path.join(root, overrides.extraFile), overrides.extraContent || 'material');
  }
  return root;
}

test.after(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

test('build-ios evals cover every planned branch exactly once', () => {
  const document = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  assert.strictEqual(document.skill_name, 'build-ios');
  assert.deepStrictEqual(
    document.evals.map(({ coverage }) => coverage).sort(),
    [
      'apns-environment-mode-pairing',
      'apple-team-drift',
      'bounded-build-failure',
      'bundle-identity-drift',
      'manual-signing-confirmation',
      'manual-signing-failure-routing',
      'secret-signing-material',
      'successful-ad-hoc-artifact',
    ],
  );
  for (const evaluation of document.evals) {
    assert.ok(evaluation.prompt.trim());
    assert.ok(evaluation.expected_output.trim());
    assert.deepStrictEqual(evaluation.files, []);
  }
});

test('build-ios uses manual Xcode signing confirmation and direct Wrap execution', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  assert.match(skill, /confirm ios signing setup for <mode>/);
  assert.match(skill, /--expected-team-id "<APNS_HANDOFF_TEAM_ID>" &&/);
  assert.match(skill, /npm run type-check &&/);
  assert.match(skill, /never let a later successful command\s+mask an earlier failure/);
  assert.match(skill, /npm run build:ios 2>&1 \|\n\s*node "\$\{PLUGIN_ROOT\}\/scripts\/filter-ios-build-output\.js"/);
  assert.match(skill, /manual Xcode setup checklist/);
  assert.doesNotMatch(skill, /apple-ios-provisioning\.json/);
  assert.doesNotMatch(skill, /Fastlane/i);
  assert.doesNotMatch(skill, /manage-apple-signing-keychain/);
  assert.doesNotMatch(skill, /verify-apple-ios-build-signing/);
  assert.doesNotMatch(skill, /dedicated keychain/i);
  assert.match(skill, /write-ios-build-handoff\.js/);
  assert.match(skill, /validate-ios-build-handoff\.js/);
  assert.match(skill, /--write-input-snapshot \.tmp\/ios-build-inputs\.json/);
  assert.match(skill, /--build-start \.tmp\/ios-build-start \\\n\s+--input-snapshot \.tmp\/ios-build-inputs\.json &&/);
  assert.match(skill, /--file ios-build\.json/);
  assert.match(skill, /\*\*not\*\* signing,\s+certificate, provisioning-profile/);
  assert.match(skill, /pre\/post-build project-input continuity/);
  assert.match(skill, /does not cryptographically embed the input\s+digest in the IPA/);
  assert.match(skill, /--file ios-build\.json \\\n\s+--file memory-bank\.md/);
});

test('verify-ios-push validates lightweight IPA continuity without signing attestation', () => {
  const skill = fs.readFileSync(VERIFY_SKILL_PATH, 'utf8');
  assert.match(skill, /validate-ios-build-handoff\.js/);
  assert.match(skill, /Immediately before the first live case in the verification sequence/);
  assert.match(skill, /Do not rerun this validator before every individual send/);
  assert.match(skill, /if the sequence crosses the handoff's\s+valid-until time/);
  assert.match(skill, /IPA SHA-256\/size\/modification-time drift/);
  assert.match(skill, /manual `\/setup-apple-ios` and `\/setup-apns` Team, bundle,\s*\n\s*mode/);
  assert.match(skill, /does not attest signing, certificates,\s+provisioning profiles/);
  assert.match(skill, /does not cryptographically embed the input digest in the IPA/);
  assert.doesNotMatch(skill, /apple-ios-provisioning\.json/);
  assert.doesNotMatch(skill, /validate-apple-ios-provisioning/);
});

test('accepts a consistent development registered-device build', () => {
  const result = validateProject(project('development'), 'development', TEAM_ID);
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.exportMethod, 'development');
  assert.strictEqual(result.apnsEnvironment, 'development');
  assert.strictEqual(result.bundleStep, 'js-bundle ios');
});

test('accepts ad-hoc only with production APNs and ad-hoc export', () => {
  const root = project('ad-hoc', {
    wrap: {
      bundleIdentifier: 'com.contoso.fieldops',
      displayName: 'Field Ops',
      version: '1.2.3',
      versionCode: 7,
      iconPath: './assets/icon.png',
      msal: { clientId: CLIENT_ID, tenantId: TENANT_ID },
      ios: { simulator: false, signing: { exportMethod: 'ad-hoc', teamId: TEAM_ID } },
      outputPath: './dist',
    },
  });
  const result = validateProject(root, 'ad-hoc', TEAM_ID);
  assert.strictEqual(result.exportMethod, 'ad-hoc');
  assert.strictEqual(result.apnsEnvironment, 'production');
});

test('blocks Firebase bundle drift', () => {
  assert.throws(
    () => validateProject(project('bundle-drift', { plistBundle: 'com.contoso.other' }), 'development', TEAM_ID),
    /Firebase plist bundle ID differs/,
  );
});

test('blocks Apple Team ID drift', () => {
  assert.throws(
    () => validateProject(project('team-drift'), 'development', 'ZZZZ9999ZZ'),
    /differs from the confirmed APNs handoff/,
  );
});

test('blocks wrong export mode and APNs environment pairing', () => {
  assert.throws(
    () => validateProject(project('mode-drift'), 'ad-hoc', TEAM_ID),
    /exportMethod must be ad-hoc/,
  );
});

test('blocks project-local signing material without exposing contents', () => {
  assert.throws(
    () => validateProject(
      project('signing-material', { extraFile: 'ios_distribution.p12', extraContent: 'secret' }),
      'development',
      TEAM_ID,
    ),
    /signing material must be removed.*ios_distribution\.p12/,
  );
});

test('blocks secret-bearing wrap config fields', () => {
  const root = project('secret-field');
  const wrapPath = path.join(root, 'wrap.config.json');
  const wrap = JSON.parse(fs.readFileSync(wrapPath, 'utf8'));
  wrap.ios.signing.provisioningProfile = './profile.mobileprovision';
  fs.writeFileSync(wrapPath, JSON.stringify(wrap));
  assert.throws(
    () => validateProject(root, 'development', TEAM_ID),
    /forbidden signing\/secret fields: ios\.signing\.provisioningProfile/,
  );
});

test('allows a new safe nested output directory', () => {
  const root = project('new-nested-output');
  const wrapPath = path.join(root, 'wrap.config.json');
  const wrap = JSON.parse(fs.readFileSync(wrapPath, 'utf8'));
  wrap.outputPath = './artifacts/ios/registered-device';
  fs.writeFileSync(wrapPath, JSON.stringify(wrap));
  const result = validateProject(root, 'development', TEAM_ID);
  assert.strictEqual(result.outputPath, 'artifacts/ios/registered-device');
});

test('blocks output discovery and writes redirected through a project-local symlink', (context) => {
  const root = project('symlink-output');
  const external = path.join(TEST_ROOT, 'external-artifacts');
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(path.join(external, 'outside.ipa'), 'external artifact');
  try {
    fs.symlinkSync(external, path.join(root, 'dist'), 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      context.skip('directory symlinks are unavailable on this platform');
      return;
    }
    throw error;
  }

  assert.throws(
    () => validateProject(root, 'development', TEAM_ID),
    /outputPath must not contain symlinked path components/,
  );
  assert.strictEqual(fs.readFileSync(path.join(external, 'outside.ipa'), 'utf8'), 'external artifact');
});

test('blocks a symlinked parent of a not-yet-created output directory', (context) => {
  const root = project('symlink-output-parent');
  const wrapPath = path.join(root, 'wrap.config.json');
  const wrap = JSON.parse(fs.readFileSync(wrapPath, 'utf8'));
  wrap.outputPath = './artifacts/ios/new';
  fs.writeFileSync(wrapPath, JSON.stringify(wrap));
  const external = path.join(TEST_ROOT, 'external-parent');
  fs.mkdirSync(external, { recursive: true });
  try {
    fs.symlinkSync(external, path.join(root, 'artifacts'), 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      context.skip('directory symlinks are unavailable on this platform');
      return;
    }
    throw error;
  }
  assert.throws(
    () => validateProject(root, 'development', TEAM_ID),
    /outputPath must not contain symlinked path components/,
  );
  assert.strictEqual(fs.existsSync(path.join(external, 'ios', 'new')), false);
});

test('bounded diagnostics retain only 80 redacted lines', () => {
  const lines = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
  lines[99] = 'authorization: ****** ******';
  const result = bounded(lines);
  assert.strictEqual(result.length, 80);
  assert.strictEqual(result[0], 'line 21');
  assert.strictEqual(result[79], 'authorization: ****** ******');
  assert.strictEqual(redact('TOKEN=abc PRIVATE_KEY: xyz'), 'TOKEN=****** PRIVATE_KEY: ******');
});

test('redacts Xcode signing, provisioning, certificate, team, and keychain metadata', () => {
  const lines = [
    'CODE_SIGN_IDENTITY = Apple Development: Jane Doe (ABCD1234EF)',
    'EXPANDED_CODE_SIGN_IDENTITY: 0123456789ABCDEF0123456789ABCDEF01234567',
    'EXPANDED_CODE_SIGN_IDENTITY_NAME = Apple Development: Jane Doe (ABCD1234EF)',
    'EXPANDED_PROVISIONING_PROFILE = 12345678-1234-1234-1234-123456789ABC',
    'DEVELOPMENT_TEAM=ABCD1234EF',
    'PROVISIONING_PROFILE_SPECIFIER = Contoso Internal Devices',
    'Provisioning Profile UUID: 12345678-1234-1234-1234-123456789ABC',
    'Signing Identity: "Apple Distribution: Contoso"',
    'Signing Identity Hash: 0123456789ABCDEF0123456789ABCDEF01234567',
    'Certificate Identity = Apple Development: Jane Doe',
    'SHA-1 hash: 0123456789ABCDEF0123456789ABCDEF01234567',
    'Keychain path: /Users/jane/Library/Keychains/login.keychain-db',
    'KEYCHAIN_NAME = login.keychain-db',
    'note: selected Apple Development: Jane Doe (ABCD1234EF)',
    'profile: /Users/jane/Library/MobileDevice/Provisioning Profiles/12345678-1234-1234-1234-123456789ABC.mobileprovision',
    "error: No profiles were found; provisioning profiles matching 'Contoso Internal Devices'.",
  ];
  const output = bounded(lines);
  assert.strictEqual(output.length, lines.length);
  for (const line of output) assert.match(line, /\*{6}/);
  assert.doesNotMatch(output.join('\n'), /Jane Doe|ABCD1234EF|Contoso Internal|12345678|login\.keychain/);
});

test('sanitizes free-form keychain and provisioning-profile diagnostics', () => {
  const exactKeychain =
    'error: The specified keychain could not be found: /Users/jane/Library/Keychains/login.keychain-db';
  const exactProfile =
    'Using provisioning profile Contoso Internal Devices (UUID)';
  assert.strictEqual(
    sanitize(exactKeychain),
    'error: The specified keychain could not be found: ******',
  );
  assert.strictEqual(sanitize(exactProfile), 'Using provisioning profile ******');
  assert.strictEqual(
    sanitize(
      'error: keychain "/Users/jane/Library/Keychains/Work Signing.keychain-db" unavailable; '
      + "fallback 'login.keychain-db' also failed",
    ),
    'error: keychain ****** unavailable; fallback ****** also failed',
  );
  assert.strictEqual(
    sanitize(
      'Using provisioning profile "Contoso Internal Devices" '
      + '(12345678-1234-1234-1234-123456789ABC); '
      + "selected provisioning profile 'Contoso Backup' "
      + '(ABCDEFAB-1234-5678-9ABC-ABCDEFABCDEF); archive failed for an unregistered device',
    ),
    'Using provisioning profile ******; selected provisioning profile ******; '
      + 'archive failed for an unregistered device',
  );
  assert.strictEqual(
    sanitize(
      'Provisioning profile "Contoso Internal Devices" is expired; '
      + 'specified keychain name: Contoso Signing',
    ),
    'Provisioning profile ****** is expired; specified keychain name: ******',
  );
});

test('redacts descriptive signing names while preserving actionable grammar', () => {
  const cases = [
    [
      'The keychain Contoso Signing could not be found',
      'The keychain ****** could not be found',
    ],
    [
      'The keychain Work Signing is unavailable',
      'The keychain ****** is unavailable',
    ],
    [
      "Provisioning profile Contoso Internal doesn't include signing certificate",
      "Provisioning profile ****** doesn't include signing certificate",
    ],
    [
      'The keychain "Contoso Signing" could not be found',
      'The keychain ****** could not be found',
    ],
    [
      "THE KEYCHAIN 'Work Signing' IS UNAVAILABLE",
      'THE KEYCHAIN ****** IS UNAVAILABLE',
    ],
    [
      "PROVISIONING PROFILE 'Contoso Internal' DOESN'T INCLUDE SIGNING CERTIFICATE",
      "PROVISIONING PROFILE ****** DOESN'T INCLUDE SIGNING CERTIFICATE",
    ],
  ];
  for (const [input, expected] of cases) assert.strictEqual(sanitize(input), expected);

  assert.strictEqual(
    sanitize('The keychain service is unavailable'),
    'The keychain service is unavailable',
  );
  assert.strictEqual(
    sanitize("Provisioning profile validation doesn't include certificate checks"),
    "Provisioning profile validation doesn't include certificate checks",
  );
  assert.strictEqual(
    sanitize('error: CompileSwiftSources failed in src/screens/Home.tsx:42'),
    'error: CompileSwiftSources failed in src/screens/Home.tsx:42',
  );
});

test('pipeline redacts exact free-form signing reproductions while retaining safe errors', () => {
  const input = [
    'error: The specified keychain could not be found: /Users/jane/Library/Keychains/login.keychain-db',
    'Using provisioning profile Contoso Internal Devices (UUID)',
    'The keychain Contoso Signing could not be found',
    'The keychain Work Signing is unavailable',
    "Provisioning profile Contoso Internal doesn't include signing certificate",
    'THE KEYCHAIN "Nightly Signing" IS UNAVAILABLE',
    "PROVISIONING PROFILE 'Contoso Beta' DOESN'T INCLUDE SIGNING CERTIFICATE",
    'error: CompileSwiftSources failed in src/screens/Home.tsx:42',
    'error: archive failed because the selected device is not registered',
  ].join('\n');
  const result = spawnSync(process.execPath, [FILTER_PATH], {
    encoding: 'utf8',
    input,
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(result.stdout.trim().split('\n'), [
    'error: The specified keychain could not be found: ******',
    'Using provisioning profile ******',
    'The keychain ****** could not be found',
    'The keychain ****** is unavailable',
    "Provisioning profile ****** doesn't include signing certificate",
    'THE KEYCHAIN ****** IS UNAVAILABLE',
    "PROVISIONING PROFILE ****** DOESN'T INCLUDE SIGNING CERTIFICATE",
    'error: CompileSwiftSources failed in src/screens/Home.tsx:42',
    'error: archive failed because the selected device is not registered',
  ]);
  assert.doesNotMatch(
    result.stdout,
    /\/Users\/jane|login\.keychain|Contoso Internal|Contoso Signing|Work Signing|Nightly Signing|Contoso Beta|\(UUID\)/,
  );
});

test('suppresses security identity output and signing command lines', () => {
  assert.strictEqual(
    sanitize('  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Jane Doe"'),
    null,
  );
  assert.strictEqual(sanitize('  1 valid identities found'), null);
  assert.strictEqual(
    sanitize('/usr/bin/codesign --force --sign ABCDEF --keychain /Users/jane/login.keychain App.app'),
    null,
  );
  assert.strictEqual(
    sanitize('xcodebuild archive DEVELOPMENT_TEAM=ABCD1234EF CODE_SIGN_IDENTITY="Apple Development"'),
    null,
  );
  assert.strictEqual(sanitize('security find-identity -v -p codesigning'), null);
  assert.strictEqual(sanitize('security unlock-keychain -p hunter2 login.keychain-db'), null);
  assert.strictEqual(sanitize('/usr/bin/codesign -s ABCDEF App.app'), null);
  assert.strictEqual(
    sanitize('builtin-productPackagingUtility -provisioningprofile /Users/jane/profile.mobileprovision'),
    null,
  );
});

test('retains useful bounded build errors after signing metadata removal', () => {
  const output = bounded([
    '/usr/bin/codesign --sign ABCDEF --keychain login.keychain App.app',
    'error: CompileSwiftSources failed in src/screens/Home.tsx:42',
    'Provisioning Profile: Contoso Internal Devices',
    'error: archive failed because the selected device is not registered',
  ]);
  assert.deepStrictEqual(output, [
    'error: CompileSwiftSources failed in src/screens/Home.tsx:42',
    'Provisioning Profile: ******',
    'error: archive failed because the selected device is not registered',
  ]);
});
