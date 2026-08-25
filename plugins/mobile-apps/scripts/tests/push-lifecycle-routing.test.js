'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), 'utf8');
}

test('canonical push lifecycle defines ordered resumable ownership', () => {
  const lifecycle = read('shared/references/push-lifecycle.md');
  const stages = [
    '1. Firebase client',
    '2. Platform credentials and capabilities',
    '3. Runtime integration',
    '4. Sender authentication',
    '5. Power Automate flows',
    '6. Wrapped build',
    '7. Physical delivery',
  ];

  let previous = -1;
  for (const stage of stages) {
    const index = lifecycle.indexOf(stage);
    assert.ok(index > previous, `${stage} appears in canonical order`);
    previous = index;
  }

  for (const route of [
    '/setup-fcm',
    '/setup-apple-ios',
    '/setup-apns',
    '/add-push-notifications',
    '/setup-push-wif',
    '/setup-push-service-account',
    '/create-push-notification-flow',
    '/build-ios',
    '/verify-ios-push',
    '/build-android',
    '/verify-android-push',
  ]) {
    assert.ok(lifecycle.includes(route), `${route} has a lifecycle owner or route`);
  }

  assert.match(lifecycle, /Android build and verification entries are routing names only/);
  assert.match(lifecycle, /do not assume an artifact extension, build mode/i);
  assert.match(lifecycle, /authentication not plugin-validated/);
  assert.match(lifecycle, /exact producer and sender flow IDs are recorded, published, and read back/);
  assert.match(lifecycle, /\[push-physical-verification\.md\]\(\.\/push-physical-verification\.md\)/);
  assert.match(lifecycle, /## Safe manual sender handoff/);
  assert.match(lifecycle, /customer-owned Power Automate sender \/ observable contract read back; authentication not plugin-validated/);
  assert.match(lifecycle, /customer-owned non-Flow endpoint \/ plugin physical verification unavailable/);
  assert.match(lifecycle, /customer supplies and approves recording the exact sender flow ID/);
  assert.match(lifecycle, /Use a distinct non-Flow handoff schema/);
  assert.match(lifecycle, /Omit `Sender flow ID` and `Sender flow state`/);
});

test('add-push owns runtime integration and reports platform states independently', () => {
  const skill = read('skills/add-push-notifications/SKILL.md');
  const description = skill.match(/^description: (.+)$/m)?.[1] || '';

  for (const responsibility of [
    'permissions',
    'registration-token lifecycle',
    'topic synchronization',
    'listeners/background handling',
    'validated deep links',
  ]) {
    assert.ok(description.includes(responsibility), `description owns ${responsibility}`);
  }

  for (const state of [
    'Wrapped Android build',
    'Wrapped iOS build',
    'Physical Android delivery',
    'Physical iOS delivery',
  ]) {
    assert.match(skill, new RegExp(`\\| ${state} \\|`));
  }

  assert.match(skill, /\| `\/build-android`; route by name only/);
  assert.match(skill, /\| `\/verify-android-push`; route by name only/);
  assert.match(skill, /without requiring\s+`sender-auth\.json`/);
  assert.match(skill, /customer-supplied exact sender flow ID/);
  assert.match(skill, /non-Flow endpoint \/ plugin physical verification unavailable/);
});

test('build and physical verification boundaries remain non-overlapping', () => {
  const build = read('skills/build-ios/SKILL.md');
  const verify = read('skills/verify-ios-push/SKILL.md');
  const verifyAndroid = read('skills/verify-android-push/SKILL.md');
  const physical = read('shared/references/push-physical-verification.md');
  const buildDescription = build.match(/^description: (.+)$/m)?.[1] || '';

  assert.match(build, /owns only the iOS wrapped-build stage/);
  assert.match(build, /does not install, launch, or test the IPA/);
  assert.match(buildDescription, /does not install or verify them/);

  assert.match(verify, /push-physical-verification\.md/);
  assert.match(verify, /Apply the shared physical-verification protocol first/);
  assert.match(verify, /A-H matrix below remain mandatory and authoritative/);
  assert.match(verify, /Do not run the sender-auth validator\s+for a customer-owned Power Automate sender/);
  assert.match(verify, /exact canonical status and customer-supplied sender flow ID/);
  assert.match(verify, /A recorded non-Flow endpoint identifier is not sufficient/);
  assert.match(verify, /### A\. Permission UX/);
  assert.match(verify, /### H\. Token refresh\/re-registration recovery/);
  assert.match(verify, /Mark APNs physical verification complete only when A-H\s+all pass/);

  assert.match(verifyAndroid, /push-physical-verification\.md/);
  assert.match(physical, /## Required handoff continuity/);
  assert.match(physical, /## FlowAgent-only flow boundary/);
  assert.match(physical, /## Privacy-safe correlation/);
  assert.match(physical, /## Completion rules/);
});

test('lifecycle eval IDs append locally and cover manual auth plus Android routing', () => {
  const addPush = JSON.parse(read('skills/add-push-notifications/evals/evals.json'));
  const verifyIos = JSON.parse(read('skills/verify-ios-push/evals/evals.json'));

  assert.deepStrictEqual(
    addPush.evals.map(({ id }) => id),
    Array.from({ length: 17 }, (_, index) => index + 1),
  );
  assert.match(addPush.evals[14].expected_output, /to \/build-android/);
  assert.match(addPush.evals[14].expected_output, /then \/verify-android-push/);
  assert.match(addPush.evals[15].prompt, /exact sender flow ID/);
  assert.match(addPush.evals[15].expected_output, /never inspects credentials/);
  assert.match(addPush.evals[16].expected_output, /plugin physical verification unavailable/);

  assert.deepStrictEqual(
    verifyIos.evals.map(({ id }) => id),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  assert.strictEqual(verifyIos.evals[8].coverage, 'manual-auth-downstream');
  assert.match(verifyIos.evals[8].prompt, /exact manual Power Automate sender flow ID/);
  assert.match(verifyIos.evals[8].expected_output, /does not require or fabricate sender-auth\.json/);
  assert.strictEqual(verifyIos.evals[9].coverage, 'non-flow-sender-unverifiable');
});

test('manual Power Automate sender handoff stays aligned with flow authoring', () => {
  const createFlow = read('skills/create-push-notification-flow/SKILL.md');
  const authoring = read('shared/references/push-flow-authoring.md');
  const canonicalStatus =
    'customer-owned Power Automate sender / observable contract read back; ' +
    'authentication not plugin-validated';

  for (const content of [createFlow, authoring]) {
    assert.ok(content.includes(canonicalStatus), 'uses the canonical manual sender status');
    assert.match(content, /exact sender flow ID/i);
    assert.match(content, /queued[- ]outbox\s+(?:trigger\/guard|guard)/i);
    assert.match(content, /idempotent claim/i);
    assert.match(content, /`allUsers`.*lowercase-OID/is);
    assert.match(content, /delivery invocation/i);
    assert.match(content, /`Sent`\/`Failed` updates/i);
    assert.match(content, /do not\s+(?:request or\s+)?inspect[\s\S]*credentials/i);
  }
});
