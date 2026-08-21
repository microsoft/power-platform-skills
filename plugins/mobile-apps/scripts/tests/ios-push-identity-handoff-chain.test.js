'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Cross-skill identity handoff chain regression test.
 * Validates the documented chain preserves Firebase project, iOS app ID, bundle ID,
 * APNs environment, and build mode without silent reselection/override.
 */

test('iOS push chain: all required skills exist', () => {
  const skillNames = [
    'setup-fcm',
    'setup-apns',
    'add-push-notifications',
    'create-push-notification-flow',
    'build-ios',
    'verify-ios-push',
  ];

  for (const skillName of skillNames) {
    const skillPath = path.join(PLUGIN_ROOT, `skills/${skillName}/SKILL.md`);
    assert.ok(fs.existsSync(skillPath), `${skillName} SKILL.md exists`);

    const content = fs.readFileSync(skillPath, 'utf8');
    // Check for required frontmatter fields
    assert.ok(content.includes('name:'), `${skillName} has name field`);
    assert.ok(content.includes('description:'), `${skillName} has description field`);
    assert.ok(content.includes('user-invocable:'), `${skillName} has user-invocable field`);
  }
});

test('iOS push chain: setup-fcm handles Google credentials safely', () => {
  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-fcm/SKILL.md'),
    'utf8',
  );

  assert.ok(skill.includes('Record non-secret setup state'), 'documents state recording');
  assert.ok(skill.includes('memory-bank.md'), 'uses memory-bank.md');
  assert.ok(skill.includes('Do not record Google account details'), 'blocks credential storage');
  assert.ok(skill.includes('Never print the token'), 'blocks token printing');
});

test('iOS push chain: setup-apns consumes setup-fcm handoff', () => {
  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apns/SKILL.md'),
    'utf8',
  );

  assert.ok(skill.includes('Consume the `/setup-fcm` handoff'), 'consumes FCM handoff');
  assert.ok(skill.includes('memory-bank.md'), 'reads from memory-bank');
  assert.ok(skill.includes('STOP if any field is absent'), 'validates handoff completeness');
  assert.ok(skill.includes('Never persist the `.p8`'), 'blocks p8 file storage');
});

test('iOS push chain: add-push-notifications enables independent resumable tracks', () => {
  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );

  assert.ok(
    skill.toLowerCase().includes('independent'),
    'documents independent tracks',
  );
  // Just check the file exists and has substantive content about push setup
  assert.ok(skill.length > 1000, 'has substantial documentation');
});

test('iOS push chain: create-push-notification-flow requires authentication', () => {
  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/create-push-notification-flow/SKILL.md'),
    'utf8',
  );

  assert.ok(skill.includes('handoff'), 'documents handoff consumption');
  assert.ok(skill.includes('authentication'), 'mentions authentication');
});

test('iOS push chain: build-ios preserves Firebase and APNs identity', () => {
  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/build-ios/SKILL.md'),
    'utf8',
  );

  assert.ok(skill.includes('Consume the exact `/setup-fcm` and `/setup-apns` handoff'),
    'consumes both handoffs');
  assert.ok(skill.includes('do not reconstruct it or select another'),
    'prevents reselection');
  assert.ok(skill.includes('Missing or conflicting handoff data blocks'),
    'validates handoff consistency');
  assert.ok(skill.includes('Signing boundary'), 'enforces signing boundary');
  assert.ok(skill.includes('Never request') && skill.includes('private keys'),
    'blocks private key access');
});

test('iOS push chain: verify-ios-push requires exact IPA and flow state', () => {
  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/verify-ios-push/SKILL.md'),
    'utf8',
  );

  assert.ok(skill.includes('Verify the already-built client'), 'verifies existing build');
  assert.ok(skill.includes('does not') && skill.includes('build an IPA'),
    'does not create IPA');
  assert.ok(skill.includes('development') && skill.includes('ad-hoc') && skill.includes('IPA'),
    'requires specific IPA modes');
  assert.ok(skill.includes('Never') && skill.includes('FCM registration token'),
    'blocks token access');
});

test('iOS push chain: build-ios and verify-ios-push are non-overlapping', () => {
  const buildSkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/build-ios/SKILL.md'),
    'utf8',
  );
  const verifySkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/verify-ios-push/SKILL.md'),
    'utf8',
  );

  // build-ios creates IPA
  assert.ok(buildSkill.includes('Build a registered-device'), 'builds iOS artifacts');
  assert.ok(buildSkill.includes('npm run build:ios'), 'uses wrap build command');

  // verify-ios-push tests on physical device
  assert.ok(verifySkill.includes('does not') && verifySkill.includes('build an IPA'),
    'verify does not build');
  assert.ok(verifySkill.includes('physical iPhone or iPad'), 'requires physical device');
  assert.ok(verifySkill.includes('manually installed on that device'), 'user installs');
});

test('iOS push chain: credentials are protected throughout', () => {
  const fcm = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/setup-fcm/SKILL.md'), 'utf8');
  const apns = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/setup-apns/SKILL.md'), 'utf8');
  const build = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/build-ios/SKILL.md'), 'utf8');
  const verify = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/verify-ios-push/SKILL.md'), 'utf8');

  // All skills block credential storage
  assert.ok(fcm.includes('Do not record Google account'), 'setup-fcm blocks Google creds');
  assert.ok(apns.includes('Never persist the `.p8`'), 'setup-apns blocks .p8');
  assert.ok(build.includes('Do not add credential fields'), 'build-ios blocks credential fields');
  assert.ok(verify.includes('Never') && verify.includes('authorization header'),
    'verify-ios-push blocks auth headers');
});
