'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Cross-skill identity handoff chain regression test.
 * Validates the documented chain preserves Firebase project, iOS app ID,
 * manual Apple/APNs boundaries, and build mode without silent automation.
 */

test('iOS push chain: all required skills exist', () => {
  const skillNames = [
    'setup-fcm',
    'setup-apple-ios',
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

  assert.match(
    skill,
    /parent runs[\s\S]*update `memory-bank\.md` exactly once with the combined\s+non-secret state/i,
    'documents the parent-owned single memory update',
  );
  assert.match(
    skill,
    /Workers may read\s+only the raw `memory-bank\.md` bytes needed to compare that hash/,
  );
  assert.match(
    skill,
    /must\s+never parse, display, search, summarize, edit, replace, append, create, or\s+delete the file/,
  );
  assert.ok(skill.includes('memory-bank.md'), 'uses memory-bank.md');
  assert.match(skill, /Do not record Google\s+account details/, 'blocks credential storage');
  assert.ok(skill.includes('mcp__firebase__firebase_get_environment'), 'uses Firebase MCP environment readback');
  assert.ok(skill.includes('mcp__firebase__firebase_login'), 'uses Firebase MCP login');
  assert.ok(skill.includes('Session ID'), 'requires session-id verification during login');
  assert.match(skill, /Hand off first to `\/setup-apple-ios`/);
  assert.match(skill, /manual Apple Developer\/Xcode\s+guidance/);
  assert.match(skill, /Yes\/No confirmation/);
  assert.match(skill, /do not automate Apple setup or expect a generated proof\s+artifact/);
  assert.match(skill, /Only after that guidance is complete, hand off to `\/setup-apns`/);
});

test('iOS push chain: Apple setup does not collect a device count', () => {
  const setupSkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apple-ios/SKILL.md'),
    'utf8',
  );
  const provisioningGuide = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/apple-ios-signing-provisioning.md'),
    'utf8',
  );
  const evals = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apple-ios/evals/evals.json'),
    'utf8',
  );
  const setupContract = `${setupSkill}\n${provisioningGuide}\n${evals}`;

  assert.doesNotMatch(
    setupContract,
    /<COUNT>|registeredDeviceCount|non-sensitive total count|intended device count|scope\/count|with \d+ devices/i,
  );
  assert.match(
    provisioningGuide,
    /Are all intended test devices registered on Team <TEAM_ID>\?/,
  );
  assert.match(provisioningGuide, /all intended registered devices/);
  assert.match(provisioningGuide, /intendedDevicesRegistered: user-confirmed/);
  assert.match(setupSkill, /physical registered-device development and\/or ad-hoc/);
});

test('iOS push chain: setup-apns consumes setup-fcm handoff', () => {
  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apns/SKILL.md'),
    'utf8',
  );

  assert.ok(skill.includes('Consume the `/setup-fcm` handoff'), 'consumes FCM handoff');
  assert.ok(skill.includes('memory-bank.md'), 'reads from memory-bank');
  assert.ok(skill.includes('STOP if any field is absent'), 'validates handoff completeness');
  assert.match(skill, /Never persist either credential type/, 'blocks APNs credential storage');
  assert.match(skill, /APNs certificate \(`\.p12`\)/, 'supports p12 certificate route');
  assert.match(skill, /Resume an already completed manual upload/);
  assert.match(skill, /already\s+uploaded[\s\S]*`\.p12`|uploaded `\.p12`/);
});

test('iOS push chain: setup-apns keeps both credential uploads manual', () => {
  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apns/SKILL.md'),
    'utf8',
  );

  assert.match(skill, /either an APNs authentication key \(`\.p8`\) or an\s+APNs certificate \(`\.p12`\)/);
  assert.match(skill, /authentication key is recommended[\s\S]*not mandatory/i);
  assert.match(skill, /Choices: Yes \/ No/);
  assert.ok(skill.includes('no supported') || skill.includes('There is no supported'),
    'states that no supported automated Firebase upload exists');
  assert.match(skill, /outside\s+(?:this and )?every\s+(?:other\s+)?repository/,
    'keeps APNs credentials outside repositories');
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
  assert.match(skill, /published-and-read-back flows hand off to the direct user-managed\s+`\/build-ios` Wrap path/);
  assert.match(skill, /hand off to\s+`\/verify-ios-push`/);
});

test('iOS push chain: owned orchestration keeps Wrap and signing user-managed', () => {
  const lifecycle = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-lifecycle.md'),
    'utf8',
  );
  const deploy = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/deploy/SKILL.md'),
    'utf8',
  );

  assert.match(lifecycle, /manual Apple Developer\/Xcode guidance with Yes\/No confirmations/);
  assert.match(lifecycle, /signing assets and Xcode configuration are user-managed/);
  assert.match(lifecycle, /`\/build-ios` runs the direct Wrap command only after exact confirmation/);
  assert.match(lifecycle, /strict project-local `ios-build\.json`/);
  assert.match(lifecycle, /pre\/post-build project-input continuity plus artifact identity\/freshness/);
  assert.match(lifecycle, /not signing\/profile\/certificate\/entitlement\/IPA-signature attestation/);
  assert.match(lifecycle, /does not cryptographically embed the input digest in the IPA/);
  assert.match(
    lifecycle,
    /before installation confirmation and again immediately\s+before the live verification sequence/,
  );
  assert.match(lifecycle, /Do not repeat it before every send/);
  assert.match(deploy, /directly confirmed `npm run build:ios` Wrap path/);
  assert.match(deploy, /user owns Xcode signing, registered devices, profiles, and\s+credentials/);
  assert.match(deploy, /`\/build-ios` runs the command after exact confirmation/);
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
  assert.ok(skill.includes('Never request') && skill.includes('FCM registration') &&
      skill.includes('token'),
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
  assert.ok(buildSkill.includes('write-ios-build-handoff.js'), 'writes lightweight build handoff');
  assert.ok(buildSkill.includes('validate-ios-build-handoff.js'), 'validates build handoff');

  // verify-ios-push tests on physical device
  assert.ok(verifySkill.includes('does not') && verifySkill.includes('build an IPA'),
    'verify does not build');
  assert.ok(verifySkill.includes('physical iPhone or iPad'), 'requires physical device');
  assert.ok(verifySkill.includes('manually installed on that device'), 'user installs');
  assert.match(verifySkill, /Immediately before the first live case in the verification sequence/);
  assert.match(verifySkill, /Do not rerun this validator before every individual send/);
});

test('iOS push chain: credentials remain user-owned throughout', () => {
  const fcm = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/setup-fcm/SKILL.md'), 'utf8');
  const apns = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/setup-apns/SKILL.md'), 'utf8');
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const verify = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/verify-ios-push/SKILL.md'), 'utf8');

  // All skills block credential storage
  assert.match(fcm, /Do not record Google\s+account/, 'setup-fcm blocks Google creds');
  assert.match(apns, /Never persist either credential type/, 'setup-apns blocks APNs credentials');
  assert.match(readme, /keeps all signing assets and\s+secrets outside the\s+repository/);
  assert.match(readme, /does not inspect, generate, stage,\s+or attest signing assets/);
  assert.ok(verify.includes('Never') && verify.includes('authorization header'),
    'verify-ios-push blocks auth headers');
});

test('iOS push chain: guided orchestration and manual boundaries stay explicit', () => {
  const addPush = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const shared = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/shared-instructions.md'),
    'utf8',
  );
  assert.match(
    addPush,
    /default user-facing push command[\s\S]*invokes the owner skills/i,
  );
  assert.match(addPush, /invoke `\/build-android` and\/or\s+`\/build-ios`/);
  assert.match(addPush, /invoke `\/verify-android-push` and\/or\s+`\/verify-ios-push`/);
  assert.match(addPush, /does not automate Apple setup or emit a proof artifact/);
  assert.match(addPush, /owner-required installation handoff/);
  assert.match(shared, /Apple setup is manual and user-owned/);
  assert.match(shared, /Do not automate Apple\s+configuration, generate a proof contract, inspect signing assets/);
});

test('iOS fallback has one combined setup-apns owner and one terminal result', () => {
  const addPush = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const apple = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apple-ios/SKILL.md'),
    'utf8',
  );
  const apns = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apns/SKILL.md'),
    'utf8',
  );
  const appleEvals = JSON.parse(fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apple-ios/evals/evals.json'),
    'utf8',
  )).evals;
  const apnsEvals = JSON.parse(fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apns/evals/evals.json'),
    'utf8',
  )).evals;

  const fallback = addPush.match(
    /use this deterministic serial fallback[\s\S]*?(?=\n#### 4\.3)/,
  )?.[0] || '';
  assert.match(fallback, /apply the iOS combined envelope through the internal orchestrated owner\s+mode of `\/setup-apns` once/);
  assert.match(fallback, /do not invoke\s+`\/setup-apple-ios` separately/);
  assert.match(fallback, /one final iOS `WORKER_RESULT`/);
  assert.strictEqual(
    (fallback.match(/apply the iOS combined envelope[\s\S]*?`\/setup-apns` once/g) || []).length,
    1,
    'fallback invokes one combined setup-apns owner',
  );

  assert.match(apple, /do not emit an intermediate Apple `WORKER_RESULT`/i);
  assert.match(apple, /returns exactly one final iOS result/i);
  assert.match(apns, /do not emit or accept an intermediate Apple result|do not invoke `\/setup-apple-ios` separately and do\s+not emit or accept an intermediate Apple result/i);
  assert.match(apns, /return exactly one\s+final iOS `WORKER_RESULT`/i);

  assert.match(
    appleEvals.find(({ coverage }) => coverage === 'combined-ios-fallback-no-intermediate-result')
      ?.expected_output || '',
    /invokes setup-apns exactly once/,
  );
  assert.match(
    apnsEvals.find(({ coverage }) => coverage === 'single-combined-fallback-result')
      ?.expected_output || '',
    /exactly one final iOS WORKER_RESULT/,
  );
});
