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
  assert.doesNotMatch(lifecycle, /customer-owned non-Flow endpoint/);
  assert.match(lifecycle, /customer supplies and approves recording the exact sender flow ID/);
  assert.doesNotMatch(lifecycle, /Use a distinct non-Flow handoff schema/);
  assert.match(lifecycle, /manual Apple Developer\/Xcode guidance with Yes\/No confirmations/);
  assert.match(lifecycle, /Neither automates Apple configuration or emits an Apple proof artifact/);
  assert.match(lifecycle, /signing assets and Xcode configuration are user-managed/);
  assert.match(lifecycle, /`\/build-ios` runs the direct Wrap command only after exact confirmation/);
});

test('add-push owns runtime integration and orchestrates platform owners', () => {
  const skill = read('skills/add-push-notifications/SKILL.md');
  const description = skill.match(/^description: (.+)$/m)?.[1] || '';

  for (const responsibility of [
    'permissions',
    'registration-token lifecycle',
    'topic synchronization',
    'listeners/background handling',
    'shared typed navigation-intent integration',
  ]) {
    assert.ok(description.includes(responsibility), `description owns ${responsibility}`);
  }

  assert.match(skill, /default user-facing push command/);
  assert.match(skill, /Select one stopping point/);
  assert.match(skill, /Default to \*\*Create delivery flows\*\*/);
  assert.match(skill, /invoke `\/build-android`/);
  assert.match(skill, /invoke `\/verify-android-push`/);
  assert.match(skill, /never requires or fabricates\s+`sender-auth\.json`/);
  assert.match(skill, /exact\s+plugin-created sender flow ID/);
  assert.doesNotMatch(skill, /non-Flow endpoint/);
  assert.match(skill, /manual Apple Developer\/Xcode guidance/);
  assert.match(skill, /does not automate Apple setup or emit a proof artifact/);
  assert.match(skill, /cloud\s+provisioning, flow mutation, wrapped builds/);
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
  assert.doesNotMatch(verify, /non-Flow endpoint/);
  assert.match(verify, /### A\. Permission UX/);
  assert.match(verify, /### H\. Token refresh\/re-registration recovery/);
  assert.match(verify, /Mark APNs physical verification complete only when A-H\s+all pass/);

  assert.match(verifyAndroid, /push-physical-verification\.md/);
  assert.match(physical, /## Required handoff continuity/);
  assert.match(physical, /## FlowAgent-only flow boundary/);
  assert.match(physical, /## Privacy-safe correlation/);
  assert.match(physical, /## Completion rules/);
});

test('lifecycle eval IDs append locally and cover guided orchestration', () => {
  const addPush = JSON.parse(read('skills/add-push-notifications/evals/evals.json'));
  const verifyIos = JSON.parse(read('skills/verify-ios-push/evals/evals.json'));

  assert.deepStrictEqual(
    addPush.evals.map(({ id }) => id),
    Array.from({ length: 21 }, (_, index) => index + 1),
  );
  assert.match(addPush.evals[14].expected_output, /invokes build-android/);
  assert.match(addPush.evals[14].expected_output, /invokes verify-android-push/);
  assert.match(addPush.evals[15].expected_output, /exact plugin-created sender flow ID/);
  assert.match(addPush.evals[15].expected_output, /never inspects credentials/);
  assert.match(addPush.evals[16].expected_output, /custom endpoint and Azure Function sender options are not offered/);
  assert.match(addPush.evals[17].expected_output, /shared parser\/dispatcher for all four sources/);
  assert.match(addPush.evals[17].expected_output, /without fallback navigation/);
  assert.match(addPush.evals[18].expected_output, /one guided workflow/);
  assert.match(addPush.evals[18].expected_output, /never makes the user manually chain slash commands/);
  assert.match(addPush.evals[19].expected_output, /scheduleNotificationAsync/);
  assert.match(addPush.evals[20].expected_output, /same channel ID/);

  assert.deepStrictEqual(
    verifyIos.evals.map(({ id }) => id),
    Array.from({ length: 15 }, (_, index) => index + 1),
  );
  assert.strictEqual(verifyIos.evals[8].coverage, 'manual-auth-downstream');
  assert.match(verifyIos.evals[8].prompt, /exact manual Power Automate sender flow ID/);
  assert.match(verifyIos.evals[8].expected_output, /does not require or fabricate sender-auth\.json/);
  assert.strictEqual(verifyIos.evals[9].coverage, 'unsupported-custom-endpoint');
  assert.strictEqual(verifyIos.evals[10].coverage, 'missing-ios-build-handoff');
  assert.strictEqual(verifyIos.evals[14].coverage, 'valid-lightweight-ios-handoff');
});

test('manual Power Automate sender handoff stays aligned with flow authoring', () => {
  const createFlow = read('skills/create-push-notification-flow/SKILL.md');
  const authoring = read('shared/references/push-flow-authoring.md');

  for (const content of [createFlow, authoring]) {
    assert.match(
      content,
      /customer-owned Power Automate sender \/ observable contract read back;\s+authentication not plugin-validated/,
      'uses the canonical manual sender status',
    );
    assert.match(content, /exact\s+(?:plugin-created\s+)?sender flow ID/i);
    assert.match(content, /queued[- ]outbox\s+(?:trigger\/guard|guard)/i);
    assert.match(content, /idempotent claim/i);
    assert.match(content, /`allUsers`.*lowercase-OID/is);
    assert.match(content, /delivery invocation/i);
    assert.match(content, /`Sent`\/`Failed` updates/i);
    assert.match(content, /do not\s+(?:request or\s+)?inspect[\s\S]*credentials/i);
  }
});
