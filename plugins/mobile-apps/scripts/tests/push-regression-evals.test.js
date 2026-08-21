'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const EVAL_FILES = [
  'skills/create-push-notification-flow/evals/evals.json',
  'skills/setup-push-wif/evals/evals.json',
  'skills/setup-push-service-account/evals/evals.json',
  'skills/add-dataverse/evals/evals.json',
  'skills/set-app-registration-native/evals/evals.json',
];
const ORCHESTRATION_EVAL_PATH = path.join(
  PLUGIN_ROOT,
  'skills/add-push-notifications/evals/evals.json',
);

test('the handoff regression scenarios are represented exactly once', () => {
  const evals = EVAL_FILES.flatMap((relativePath) => (
    require(path.join(PLUGIN_ROOT, relativePath)).evals
  ));
  const ids = evals.map(({ id }) => id).sort((left, right) => left - right);

  assert.deepStrictEqual(ids, Array.from({ length: 39 }, (_, index) => index + 1));
  for (const evaluation of evals) {
    assert.ok(evaluation.prompt.trim(), `scenario ${evaluation.id} needs a prompt`);
    assert.ok(evaluation.expected_output.trim(), `scenario ${evaluation.id} needs expected output`);
  }
});

test('push orchestration documents independent resumable setup tracks', () => {
  const orchestration = require(ORCHESTRATION_EVAL_PATH);
  assert.strictEqual(orchestration.skill_name, 'add-push-notifications');
  assert.deepStrictEqual(
    orchestration.evals.map(({ id }) => id),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );

  const skill = require('node:fs').readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const readme = require('node:fs').readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const agents = require('node:fs').readFileSync(path.join(PLUGIN_ROOT, 'AGENTS.md'), 'utf8');

  assert.match(skill, /independent,\s+resumable tracks/);
  assert.match(
    skill,
    /Multiple safe exact\s+matches require.*independently for Android\s+and iOS/s,
  );
  assert.match(skill, /run\s+`\/create-push-notification-flow` directly/);
  assert.match(readme, /`\/setup-push-service-account`/);
  assert.match(readme, /Push notification cloud prerequisites/);
  assert.match(readme, /premium connector/);
  assert.match(agents, /WIF is the preferred sender authentication/);
  assert.match(agents, /managed identity reads the existing Firebase JSON from Azure Key Vault/);
});

test('iOS push orchestration reports stage ownership without duplicating build or verification', () => {
  const fs = require('node:fs');
  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const apns = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/setup-apns/SKILL.md'), 'utf8');
  const deploy = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/deploy/SKILL.md'), 'utf8');
  const debug = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/debug-app/SKILL.md'), 'utf8');
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(PLUGIN_ROOT, 'AGENTS.md'), 'utf8');

  for (const state of [
    'Native client',
    'APNs',
    'Sender authentication',
    'Power Automate flows',
    'Wrapped iOS build',
    'Physical iOS delivery',
  ]) {
    assert.match(skill, new RegExp(`\\| ${state.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')} \\|`));
  }
  assert.match(skill, /configured, device verification pending/i);
  assert.match(skill, /These are handoffs, not substeps/);
  assert.match(apns, /configured, device verification\s+pending/i);
  assert.match(apns, /Only `\/verify-ios-push`/);
  assert.match(deploy, /Power Platform \*\*web bundle deployment\*\*/);
  assert.match(deploy, /route to `\/build-ios`/i);
  assert.doesNotMatch(deploy, /native compile and manual device testing are user-owned/);
  assert.match(debug, /route user to `\/verify-ios-push`/);
  assert.match(debug, /Keep general Metro diagnostics here/);
  assert.match(readme, /\| `\/build-ios` \|/);
  assert.match(readme, /\| `\/verify-ios-push` \|/);
  assert.match(readme, /development and ad-hoc registered-device IPA workflows/);
  assert.match(readme, /certificates, private keys, provisioning profiles, device\s+UDIDs/s);
  assert.match(agents, /36 skills \+ 5 agents/);
  assert.match(agents, /Apple certificates, private keys/);
});

test('iOS push contract is consent-first and registers background handling before Router', () => {
  const fs = require('node:fs');
  const skill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const contract = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-notifications.md'),
    'utf8',
  );
  const packageJson = require(path.join(PLUGIN_ROOT, 'template/package.json'));
  const firebaseConfig = require(path.join(PLUGIN_ROOT, 'template/firebase.json'));
  const entry = fs.readFileSync(path.join(PLUGIN_ROOT, 'template/index.js'), 'utf8');

  assert.strictEqual(packageJson.main, 'index.js');
  assert.strictEqual(
    firebaseConfig['react-native'].messaging_auto_init_enabled,
    false,
  );
  assert.strictEqual(
    firebaseConfig['react-native'].messaging_ios_auto_register_for_remote_messages,
    false,
  );
  assert.ok(
    entry.indexOf('setBackgroundMessageHandler') < entry.indexOf("require('expo-router/entry')"),
    'background handler must be registered before Expo Router mounts',
  );
  assert.match(contract, /permission.*registerDeviceForRemoteMessages.*setAutoInitEnabled.*getToken/s);
  assert.match(contract, /Never persist an FCM registration token/);
  assert.match(contract, /getLastNotificationResponseAsync\(\).*once/s);
  assert.match(skill, /never call `getToken` before registration/);
  assert.match(skill, /never persist an FCM registration token/);
});
