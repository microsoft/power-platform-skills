'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_PATH = path.join(
  PLUGIN_ROOT,
  'skills',
  'verify-android-push',
  'SKILL.md',
);
const MATRIX_PATH = path.join(
  PLUGIN_ROOT,
  'skills',
  'verify-android-push',
  'references',
  'android-physical-matrix.md',
);
const COMMON_PATH = path.join(
  PLUGIN_ROOT,
  'shared',
  'references',
  'push-physical-verification.md',
);
const EVAL_PATH = path.join(
  PLUGIN_ROOT,
  'skills',
  'verify-android-push',
  'evals',
  'evals.json',
);

test('verify-android-push evals cover the physical Android boundary and matrix', () => {
  const document = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  assert.strictEqual(document.skill_name, 'verify-android-push');
  assert.deepStrictEqual(
    document.evals.map(({ coverage }) => coverage),
    [
      'non-physical-runtime-rejected',
      'strict-handoff-validator',
      'android-13-permission',
      'pre-13-channel-foreground',
      'fcm-accepted-background-miss',
      'terminated-exactly-once-deep-link',
      'oid-account-transition-privacy',
      'opt-out-and-reregistration-control',
      'customer-owned-sender-routing',
      'full-managed-physical-success',
    ],
  );
  assert.deepStrictEqual(
    document.evals.map(({ id }) => id),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  for (const evaluation of document.evals) {
    assert.ok(evaluation.prompt.trim(), `${evaluation.coverage} needs a prompt`);
    assert.ok(
      evaluation.expected_output.trim(),
      `${evaluation.coverage} needs expected output`,
    );
    assert.deepStrictEqual(evaluation.files, []);
  }
});

test('verify-android-push is public and uses FlowAgent without flow mutation', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');

  assert.match(skill, /^name: verify-android-push$/m);
  assert.match(skill, /^user-invocable: true$/m);
  for (const tool of [
    'mcp__flowagent__get_flow',
    'mcp__flowagent__list_connections',
    'mcp__flowagent__test_connection',
    'mcp__flowagent__invoke_operation',
    'mcp__flowagent__run_flow',
    'mcp__flowagent__get_run_history',
    'mcp__flowagent__get_run_details',
    'mcp__flowagent__get_run_actions',
  ]) {
    assert.match(skill, new RegExp(tool));
  }
  for (const mutationTool of [
    'mcp__flowagent__create_flow',
    'mcp__flowagent__update_flow',
    'mcp__flowagent__edit_flow',
    'mcp__flowagent__publish_flow',
    'mcp__flowagent__disable_flow',
    'mcp__flowagent__delete_flow',
    'mcp__flowagent__copy_flow',
  ]) {
    assert.doesNotMatch(skill, new RegExp(mutationTool));
  }
  for (const unnecessaryOrUnsafeTool of [
    'mcp__flowagent__get_past_trigger_inputs',
    'mcp__flowagent__list_flows',
    'mcp__flowagent__list_environments',
    'mcp__flowagent__get_connector',
    'mcp__flowagent__resolve_entity',
    'mcp__flowagent__resolve_params',
    'mcp__flowagent__resolve_refs',
    'mcp__flowagent__smoke_test',
    'mcp__flowagent__set_current_flow',
    'mcp__flowagent__clear_current_flow',
  ]) {
    assert.doesNotMatch(skill, new RegExp(unnecessaryOrUnsafeTool));
  }
  assert.match(skill, /FlowAgent is the only supported path for flow/);
  assert.match(skill, /Do not use the Power Automate portal/);
  assert.match(skill, /Do not call any flow create, update, edit, publish/);
});

test('verify-android-push consumes an exact fresh build and active client identity', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  const matrix = fs.readFileSync(MATRIX_PATH, 'utf8');

  assert.match(skill, /exact fresh project-local `android-build\.json`/);
  assert.match(skill, /physical Android 8\+ device/);
  assert.match(
    skill,
    /Reject an emulator, Expo Go, Metro-only preview, browser preview, generic\s+Power Apps Developer/,
  );
  assert.match(skill, /Do not find a substitute APK by globbing/);
  assert.match(skill, /previous installation/);
  assert.match(skill, /configuration-only evidence/);
  assert.match(skill, /FCM-accepted\/`Sent` result/);
  assert.match(skill, /scripts\/validate-android-build-handoff\.js/);
  assert.match(skill, /--file android-build\.json --max-age-hours 24[\s\S]*--expected-signer-sha256/);
  assert.equal(
    (skill.match(/node "\$\{PLUGIN_ROOT\}\/scripts\/validate-android-build-handoff\.js"/g) || []).length,
    (skill.match(/--expected-signer-sha256/g) || []).length,
    'every executable handoff-validator invocation must pass the independent expected signer',
  );
  assert.match(skill, /Never derive it solely from editable\s+`android-build\.json`/);
  assert.match(skill, /Never copy it only from `android-build\.json\.signing\.certificateSha256`/);
  assert.match(skill, /never request a certificate file, keystore, alias,\s+password, SHA-1 redirect hash, or signing command/i);
  assert.match(skill, /Use the same independently sourced expected signer fingerprint/);
  assert.match(
    skill,
    /Exit 0 and JSON `status: valid` are required before install confirmation or any\s+live send/,
  );
  assert.match(skill, /Immediately before the first live notification, rerun/);
  assert.match(skill, /any addition, removal, size change, or SHA-256\s+change/);
  assert.match(
    skill,
    /`assets\/power-platform\/android-build-input-proof\.json` entry/,
  );
  assert.match(
    skill,
    /`declaredInputsDigest` exactly equal to `android-build\.json inputs\.digest`/,
  );
  assert.match(skill, /final APK Signature Scheme v2\+ signing block/);
  assert.match(skill, /Reject temporal-only freshness/);
  assert.match(skill, /copied, substituted, renamed, or\s+touched APK fails/);
  assert.match(skill, /Bind the installation confirmation\s+and every later case to that returned `inputs\.digest`/);
  assert.match(skill, /newly returned `inputs\.digest` to equal the value\s+bound to the install confirmation/);

  const validator = 'node "${PLUGIN_ROOT}/scripts/validate-android-build-handoff.js"';
  assert.ok(skill.indexOf(validator) < skill.indexOf('Ask the user to confirm only:'));
  assert.ok(
    skill.lastIndexOf(validator) > skill.indexOf('## 4. Establish correlation and send consent'),
  );

  assert.match(matrix, /Consume the finalized strict schema version 1/);
  assert.match(matrix, /\| Root \| `schemaVersion: 1`/);
  assert.match(matrix, /\| `artifact` \| `path`, `sha256`, `sizeBytes`, `modifiedAt`, plus decimal-string `modifiedAtNs`, `changedAtNs`, `device`, `inode` \|/);
  assert.match(matrix, /\| `app` \| `package`, `displayName`, `versionName`, `versionCode`, `minSdkVersion`, `targetSdkVersion`, `sourceIconPath`, `sourceIconSha256`, `packagedIconResource`, `packagedIconSha256` \|/);
  assert.match(matrix, /\| `firebase` \| `projectId`, `androidAppId`, `package`, `clientConfigPath` \|/);
  assert.match(matrix, /\| `auth` \| `clientId`, `tenantId` \|/);
  assert.match(matrix, /\| `signing` \| `verified`, `verificationTool`, `certificateSha256`, `schemes` \|/);
  assert.match(matrix, /\| `tooling` \| `metadataTool`, `wrapPackage`, `wrapVersion` \|/);
  assert.match(matrix, /\| `timestamps` \| `inputsCapturedAt`, `buildStartedAt`, `verifiedAt`, `validUntil` \|/);
  assert.match(matrix, /\| `inputs` \| `schemaVersion: 1`, `algorithm: "sha256"`, lowercase `digest: "sha256:<64 hex>"`/);
  assert.match(matrix, /\| `inputs\.files\[\]` \| exactly normalized POSIX project-relative `path`/);
  assert.match(matrix, /paths are unique and sorted by UTF-8 byte order/);
  assert.match(matrix, /`android-declared-inputs-v1` SHA-256 contract/);
  assert.match(matrix, /never file contents/);
  assert.match(matrix, /Do not\s+independently reimplement the digest algorithm/);
  assert.match(matrix, /requires it to precede or equal `buildStartedAt`/);
  assert.match(matrix, /no more\s+than 24 hours older/);
  assert.match(matrix, /## Signed APK-embedded input proof/);
  assert.match(
    matrix,
    /`assets\/power-platform\/android-build-input-proof\.json` ZIP entry/,
  );
  assert.match(matrix, /exact canonical bytes: minified one-line JSON plus LF/);
  assert.match(
    matrix,
    /\{"schemaVersion":1,"algorithm":"sha256","declaredInputsDigest":"sha256:<64 lowercase hex>"\}\\n/,
  );
  assert.match(matrix, /no other fields\s+or whitespace/);
  assert.match(matrix, /successful validator output's safe\s+`inputs\.digest`, `fileCount`, `totalBytes`, and `timestamps\.inputsCapturedAt`/);
  assert.match(matrix, /rerun to return the same\s+`inputs\.digest`/);
  assert.match(matrix, /high-resolution artifact fields are validator-owned TOCTOU evidence/);
  assert.match(matrix, /must not\s+independently stat or compare `modifiedAtNs`, `changedAtNs`, `device`, or\s+`inode`/);
  assert.match(matrix, /private byte-identical\s+read-only snapshot/);
  assert.match(matrix, /immediately before returning `status: "valid"`/);
  assert.match(matrix, /replacement, symlink-swap, touch, truncation, and same-size-content\s+races/);
  assert.match(matrix, /expected signer fingerprint is non-secret/);
  assert.match(matrix, /must not be sourced\s+solely from editable `android-build\.json\.signing\.certificateSha256`/);
  assert.match(matrix, /fresh v2\+ signature schemes and a\s+fresh signer fingerprint matching both the handoff value and the separately\s+supplied expected signer/);
  assert.match(matrix, /minSdkVersion\/targetSdkVersion/);
  assert.match(matrix, /final APK Signature\s+Scheme v2-or-newer whole-file signing block/);
  assert.match(matrix, /Temporal-only evidence is invalid/);
  assert.match(matrix, /copied\/touched file/);
  assert.match(matrix, /post-sign inserted, covered only by v1\/JAR signing/);
  assert.match(matrix, /rejects file additions\/removals plus aggregate\s+digest/);
  assert.match(matrix, /regular non-symlink\s+files under the project root/);
  assert.match(matrix, /`mobilesdk_app_id`/);
  assert.match(matrix, /`package_name`/);
  assert.match(matrix, /Never run `adb devices`/);
  assert.doesNotMatch(skill, /prematurely fixing|may finalize the JSON property names/i);
  assert.doesNotMatch(matrix, /semantic safe fields|may finalize the JSON property names/i);
});

test('strict build eval rejects temporal-only and substituted APK evidence', () => {
  const document = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  const evaluation = document.evals.find(({ coverage }) => (
    coverage === 'strict-handoff-validator'
  ));

  assert.match(evaluation.prompt, /Use the signer fingerprint stored inside editable android-build\.json/);
  assert.match(evaluation.prompt, /skip asking for an independent expected signer/);
  assert.match(evaluation.expected_output, /rejects temporal-only freshness/);
  assert.match(evaluation.expected_output, /refuses to derive the expected signer solely from android-build\.json/);
  assert.match(evaluation.expected_output, /separate customer-managed 64-hex certificate SHA-256/);
  assert.match(evaluation.expected_output, /private-snapshot signer\/v2\+/);
});

test('Android matrix distinguishes permissions and covers all delivery states', () => {
  const matrix = fs.readFileSync(MATRIX_PATH, 'utf8');

  assert.match(matrix, /### A\. Android-version permission branch/);
  assert.match(matrix, /Android 13\+ \(API 33\+\)/);
  assert.match(matrix, /`POST_NOTIFICATIONS` runtime prompt/);
  assert.match(matrix, /Android 8-12 \(API 26-32\)/);
  assert.match(matrix, /Do not expect or simulate an Android 13 runtime prompt/);
  assert.match(matrix, /### B\. Channel and signed-out foreground `allUsers`/);
  assert.match(matrix, /non-silent importance/);
  assert.match(matrix, /### C\. Signed-out background `allUsers`/);
  assert.match(matrix, /### D\. Terminated tap and exactly-once deep link/);
  assert.match(matrix, /exactly one navigation/);
  assert.match(matrix, /### E\. Lowercase-OID sign-in/);
  assert.match(matrix, /### F\. Account switch and sign-out/);
  assert.match(matrix, /account-A negative case/);
  assert.match(matrix, /### G\. Opt-out negative/);
  assert.match(matrix, /### H\. Token refresh or exact same-APK re-registration/);
  assert.match(matrix, /positive control that makes G's non-delivery meaningful/);
});

test('common protocol requires safe read-back, idempotency, and bounded retry', () => {
  const common = fs.readFileSync(COMMON_PATH, 'utf8');

  assert.match(common, /## FlowAgent-only flow boundary/);
  assert.match(common, /Fetch producer and sender by exact recorded IDs/);
  assert.match(
    common,
    /customer-owned Power Automate sender \/ observable contract read\s+back; authentication not plugin-validated/,
  );
  assert.match(
    common,
    /customer-owned non-Flow endpoint \/ plugin physical verification\s+unavailable/,
  );
  assert.match(common, /exact customer-supplied\s+sender flow ID/);
  assert.match(common, /Do not inspect credentials, authorization configuration/);
  assert.doesNotMatch(common, /customer-owned \/ not plugin-validated/);
  assert.match(common, /## Privacy-safe correlation/);
  assert.match(common, /case label and bounded UTC test window/);
  assert.match(common, /Never request, collect, display, copy, log, or persist/);
  assert.match(common, /FCM\/APNs registration tokens/);
  assert.match(common, /Entra OIDs.*ADB serials/);
  assert.match(common, /raw notification payloads/);
  assert.match(common, /provider responses/);
  assert.match(common, /## Topic, outbox, and idempotency evidence/);
  assert.match(common, /`Queued -> Sending -> Sent`/);
  assert.match(common, /repeated navigation,[\s\S]*fails idempotency/);
  assert.match(common, /Do not repeatedly resubmit a failed run/);
  assert.match(common, /new case label and new test row/);
  assert.match(common, /negative test is\s+provisional until a positive control succeeds/);
});

test('Android verification routes customer-owned senders without credential inspection', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');

  assert.match(
    skill,
    /customer-owned Power Automate sender \/\s+observable contract read back; authentication not plugin-validated/,
  );
  assert.match(skill, /exact customer-supplied sender flow ID/);
  assert.match(skill, /Refetch that ID with\s+`get_flow`, require `Started`/);
  assert.match(skill, /Do not run the sender-auth validator, inspect\s+credentials/);
  assert.match(
    skill,
    /customer-owned non-Flow endpoint \/ plugin physical verification\s+unavailable/,
  );
  assert.match(skill, /stop before live sends/);
  assert.doesNotMatch(skill, /customer-owned \/ not plugin-validated/);
});

test('verification completes only after the full physical matrix', () => {
  const skill = fs.readFileSync(SKILL_PATH, 'utf8');
  const matrix = fs.readFileSync(MATRIX_PATH, 'utf8');
  const common = fs.readFileSync(COMMON_PATH, 'utf8');

  assert.match(
    skill,
    /Say \*\*Android push physically verified\*\* only when every applicable\s+case passes/,
  );
  assert.match(matrix, /Anything less remains \*\*pending physical verification\*\*/);
  assert.match(common, /foreground-only, FCM-accepted-only, stale-build/);
  assert.match(skill, /validate-mobile-files\.js/);
  assert.match(skill, /--file memory-bank\.md/);
  assert.match(
    skill,
    /Do not store tokens, OIDs, device IDs, ADB serials, raw payloads/,
  );
});
