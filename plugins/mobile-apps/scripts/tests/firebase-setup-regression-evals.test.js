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
  'missing-firebase-json-project-activation',
  'parallel-platform-success',
  'single-platform-worker',
  'task-unavailable-inline-fallback',
  'malformed-platform-result',
  'partial-platform-dispatch',
  'firebase-worker-executable-contract',
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

test('setup-apns guidance scenarios remain contiguous and fixture-free', () => {
  const document = JSON.parse(fs.readFileSync(APNS_EVAL_PATH, 'utf8'));
  assert.strictEqual(document.skill_name, 'setup-apns');
  assert.deepStrictEqual(
    document.evals.map(({ id }) => id),
    Array.from({ length: document.evals.length }, (_, index) => index + 1),
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

test('fixtures and workflow remain sanitized and MCP-first with no Firebase CLI fallback', () => {
  const fixtureNames = fs.readdirSync(FIXTURE_ROOT).sort();
  assert.strictEqual(fixtureNames.length, 18);
  for (const name of fixtureNames) {
    const content = readFixture(name).toString('utf8');
    assert.doesNotMatch(content, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    assert.doesNotMatch(content, /ya29\.|AIza[0-9A-Za-z_-]{20,}/);
  }

  const provisioning = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/firebase-mcp-provisioning.md'),
    'utf8',
  );
  const officialMcp = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/official-mcp-servers.md'),
    'utf8',
  );
  assert.match(officialMcp, /Workflow readiness gates and `\/mcp` recovery/);
  assert.match(officialMcp, /\/mcp[\s\S]*\/setup[\s\S]*\/restart[\s\S]*\/mcp/);
  assert.match(officialMcp, /\/setup-fcm[\s\S]*firebase[\s\S]*mcp__firebase__firebase_get_environment[\s\S]*mcp__firebase__firebase_get_sdk_config/s);
  assert.match(officialMcp, /`\/setup-apns` has no MCP readiness gate/);
  assert.match(officialMcp, /user performs the APNs key upload manually in\s+Firebase Console/);
  assert.match(officialMcp, /Never call `gcloud` directly[\s\S]*extend this exception to Firebase or Azure/i);
  assert.match(provisioning, /mcp__firebase__firebase_get_environment/);
  assert.match(provisioning, /mcp__firebase__firebase_login/);
  assert.match(provisioning, /mcp__firebase__firebase_list_projects/);
  assert.match(provisioning, /mcp__firebase__firebase_create_project/);
  assert.match(provisioning, /mcp__firebase__firebase_list_apps/);
  assert.match(provisioning, /mcp__firebase__firebase_create_app/);
  assert.match(provisioning, /mcp__firebase__firebase_get_sdk_config/);
  assert.match(provisioning, /extract-firebase-sdk-config\.js/);
  assert.match(provisioning, /firebase\/\.android-sdk-config\.mcp\.txt/);
  assert.match(provisioning, /firebase\/\.ios-sdk-config\.mcp\.txt/);
  assert.match(provisioning, /15\.27\.0/);
  assert.match(provisioning, /organization[\s\S]*folder[\s\S]*Do not fall back to CLI parent flags/i);
  assert.match(provisioning, /no separate addFirebase core MCP tool/i);
  assert.match(provisioning, /Establish the project-directory anchor first/);
  assert.match(provisioning, /project_dir/);
  assert.match(provisioning, /acknowledged update without persisted read-back is a failure/i);
  assert.doesNotMatch(provisioning, /npx firebase-tools/);
  assert.doesNotMatch(provisioning, /15\.28\.1/);

  const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/setup-fcm/SKILL.md'), 'utf8');
  assert.match(skill, /allowed-tools: [^\n]*mcp__firebase__firebase_get_environment/);
  assert.match(skill, /allowed-tools: [^\n]*mcp__firebase__firebase_login/);
  assert.match(skill, /allowed-tools: [^\n]*mcp__firebase__firebase_update_environment/);
  assert.match(skill, /allowed-tools: [^\n]*mcp__firebase__firebase_list_projects/);
  assert.match(skill, /allowed-tools: [^\n]*mcp__firebase__firebase_get_project/);
  assert.match(skill, /allowed-tools: [^\n]*mcp__firebase__firebase_create_project/);
  assert.match(skill, /allowed-tools: [^\n]*mcp__firebase__firebase_list_apps/);
  assert.match(skill, /allowed-tools: [^\n]*mcp__firebase__firebase_create_app/);
  assert.match(skill, /allowed-tools: [^\n]*mcp__firebase__firebase_get_sdk_config/);
  assert.match(skill, /firebase-mcp-provisioning\.md/);
  assert.match(skill, /official-mcp-servers\.md/);
  assert.match(skill, /\/setup-apns/);
  assert.match(skill, /manual Apple Developer\/Xcode\s+guidance/);
  assert.match(skill, /Yes\/No confirmation/);
  assert.match(skill, /do not automate Apple setup or expect a generated proof\s+artifact/);
  assert.match(skill, /Never request, download, copy, or commit a Firebase Admin/);
  assert.match(skill, /regular,\s+non-symlink project-root `firebase\.json`/);
  assert.match(skill, /both the\s+exact project root as `project_dir` and the selected ID as `active_project`/);
  assert.match(skill, /authentication, project selection\/creation, project activation, and both\s+activation read-backs in the parent and strictly serial/);
  assert.match(skill, /launch exactly two\s+`mobile-app:firebase-platform-worker` execution tasks/);
  assert.match(skill, /If only one platform needs work, use one synchronous worker/);
  assert.match(skill, /exactly\s+one parseable `WORKER_RESULT`/);
  assert.match(skill, /Cap at 2 retries per platform/);
  assert.match(skill, /Treat dispatch as potentially partial/);
  assert.match(provisioning, /## 1\. Verify Firebase MCP authentication/);
  assert.match(provisioning, /firebase_get_environment/);
  assert.match(provisioning, /firebase_login/);
  assert.match(provisioning, /--selected-app-id "<APP_ID>"/);
  assert.match(provisioning, /selection-required/);
  assert.doesNotMatch(provisioning, /npx firebase-tools/);
  assert.doesNotMatch(skill, /npx firebase-tools/);
  assert.doesNotMatch(skill, /15\.28\.1/);
  assert.doesNotMatch(skill, /projects:create <PROJECT_ID>/);
  assert.doesNotMatch(skill, /projects:addfirebase <PROJECT_ID>/);
  assert.doesNotMatch(skill, /apps:create ANDROID/);
  assert.doesNotMatch(skill, /apps:sdkconfig ANDROID/);

  const apnsSkill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/setup-apns/SKILL.md'), 'utf8');
  assert.doesNotMatch(apnsSkill, /mcp__firebase__/);
  assert.match(apnsSkill, /Consume the `\/setup-fcm` handoff/);
  assert.match(apnsSkill, /immutable selected Firebase iOS app ID/);
  assert.match(apnsSkill, /Do not reconstruct missing values/);
  assert.match(apnsSkill, /Continue with APNs setup for project/);
  assert.match(apnsSkill, /Choices: Yes \/ No/);
  assert.match(apnsSkill, /configured, device verification\s+pending/i);
  assert.match(apnsSkill, /Only `\/verify-ios-push` may mark physical delivery verified/);
  assert.match(apnsSkill, /Return to `\/add-push-notifications`/);
  assert.match(apnsSkill, /route Apple[\s\S]*to `\/setup-apple-ios`/i);
  assert.match(apnsSkill, /either an APNs authentication key \(`\.p8`\) or an APNs certificate \(`\.p12`\)/i);
  assert.match(apnsSkill, /authentication key is recommended[\s\S]*not mandatory/i);
  assert.match(apnsSkill, /There is no supported automated Firebase\s+upload/i);
  assert.match(apnsSkill, /outside\s+(?:this and )?every\s+(?:other\s+)?repository/);
  assert.match(apnsSkill, /exact immutable iOS Firebase app ID and bundle ID from Phase 1/i);
  assert.match(apnsSkill, /Did Firebase Console accept the selected APNs/);
  assert.match(apnsSkill, /Resume an already completed manual upload/);
  assert.match(apnsSkill, /Do \*\*not\*\* call\s+`validate-firebase-client-config\.js` with the canonical plist as both/);
  assert.match(apnsSkill, /user-confirmed; not portal proof/);
  assert.doesNotMatch(apnsSkill, /npx firebase-tools/);
  assert.doesNotMatch(apnsSkill, /apps:create IOS/);
});

test('Firebase worker contract hashes memory without owning it and releases every file', () => {
  const skill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/setup-fcm/SKILL.md'), 'utf8');
  const worker = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'agents/firebase-platform-worker.md'),
    'utf8',
  );
  const evaluation = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8')).evals
    .find(({ coverage }) => coverage === 'firebase-worker-executable-contract');

  assert.ok(evaluation, 'setup-fcm has an executable worker-contract eval');
  assert.match(skill, /operation: preflight/);
  assert.match(skill, /memory_bank_sha256: <pre-wave SHA-256>/);
  assert.match(skill, /only the raw `memory-bank\.md` bytes needed to compare that hash/);
  assert.match(
    skill,
    /must\s+never parse, display, search, summarize, edit, replace, append, create, or\s+delete the file/,
  );
  assert.match(worker, /\*\*Hash-only memory access\.\*\*/);
  assert.match(worker, /only permitted access to\s+`memory-bank\.md` is reading its raw bytes to compute and compare SHA-256/);
  assert.match(worker, /Never edit, replace, append, create, or delete it/);
  assert.match(worker, /"executeMemoryAccess":"sha256-only"/);

  for (const content of [skill, worker]) {
    assert.match(content, /scratchCleanupComplete/);
    assert.match(content, /ownershipReleased/);
    assert.match(content, /project-relative paths/i);
    assert.match(content, /resolve[\s\S]{0,160}(?:against|with) `?working_dir`?/i);
    assert.match(content, /absolute[\s\S]{0,160}`?exclusive_files`|`?exclusive_files`[\s\S]{0,160}absolute/i);
  }
  assert.match(skill, /including `NEEDS_CONTEXT` and `BLOCKED`/);
  assert.match(skill, /false\/missing cleanup or release\s+flag is `BLOCKED`/);
  assert.match(worker, /Set `scratchCleanupComplete` explicitly on every return/);
  assert.match(worker, /Set `ownershipReleased` explicitly on every return/);
  assert.match(evaluation.expected_output, /may read only raw memory-bank\.md bytes/);
  assert.match(evaluation.expected_output, /never writes memory/);
});
