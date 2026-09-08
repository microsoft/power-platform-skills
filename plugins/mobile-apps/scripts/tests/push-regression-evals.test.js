'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const EVAL_FILES = [
  'skills/create-push-notification-flow/evals/evals.json',
  'skills/setup-push-wif/evals/evals.json',
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

  assert.deepStrictEqual(ids, Array.from({ length: 56 }, (_, index) => index + 1));
  for (const evaluation of evals) {
    assert.ok(evaluation.prompt.trim(), `scenario ${evaluation.id} needs a prompt`);
    assert.ok(evaluation.expected_output.trim(), `scenario ${evaluation.id} needs expected output`);
  }
});

test('shared push docs record verified Firebase, gcloud, and Azure MCP boundaries', () => {
  const fs = require('node:fs');
  const shared = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/shared-instructions.md'),
    'utf8',
  );
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(PLUGIN_ROOT, 'AGENTS.md'), 'utf8');
  const addPush = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const createFlow = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/create-push-notification-flow/SKILL.md'),
    'utf8',
  );
  const officialMcp = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/official-mcp-servers.md'),
    'utf8',
  );

  assert.match(shared, /Firebase MCP required/);
  assert.match(shared, /gcloud MCP preferred for `\/setup-push-wif`/);
  assert.match(shared, /mcp__azure__role/);
  assert.doesNotMatch(shared, /mcp__azure__keyvault/);
  assert.match(shared, /role_assignment_list/);
  assert.match(shared, /does not expose the `keyvault` namespace/i);
  assert.match(shared, /value-carrying secret operations/i);
  assert.match(shared, /Do \*\*not\*\* rely on nonexistent names such[\s\S]*`functionapp_list` or `keyvault_secret_list`/);
  assert.doesNotMatch(shared, /azmcp_/);

  assert.match(readme, /`\/setup-fcm`.*vendor-official Firebase MCP/);
  assert.match(
    readme,
    /\| `\/setup-fcm` \| .*vendor-official Firebase MCP\. No CLI fallback\./,
  );
  assert.match(readme, /gcloud MCP for `\/setup-push-wif` Google Cloud operations/);
  assert.match(readme, /does not expose the `keyvault` namespace/i);

  assert.match(agents, /Firebase MCP for `\/setup-fcm`/);
  assert.match(agents, /gcloud MCP for `\/setup-push-wif`/);
  assert.match(agents, /gcloud MCP requires Node\.js 20\+ and Google Cloud CLI/i);
  assert.match(agents, /`keyvault` namespace remains excluded/i);
  assert.match(officialMcp, /Workflow readiness gates and `\/mcp` recovery/);
  assert.match(officialMcp, /\/setup-push-wif[\s\S]*`azure`; `gcloud` preferred[\s\S]*mcp__azure__role[\s\S]*mcp__gcloud__run_gcloud_command/s);
  assert.match(officialMcp, /requires Node\.js 20\+ plus a working `gcloud` executable/i);
  assert.match(officialMcp, /\/mcp[\s\S]*\/setup[\s\S]*\/restart[\s\S]*\/mcp/);
  assert.match(officialMcp, /Never call `gcloud` directly[\s\S]*extend this exception to Firebase or Azure/i);

  assert.match(addPush, /vendor-official Firebase MCP\s+only/);
  assert.doesNotMatch(addPush, /Firebase MCP[\s\S]*plus gcloud MCP/);
  assert.match(createFlow, /vendor-official Firebase MCP only/);
});

test('push flow presents informed managed and customer-owned sender auth choices', () => {
  const fs = require('node:fs');
  const flow = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/create-push-notification-flow/SKILL.md'),
    'utf8',
  );
  const orchestration = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const options = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-sender-auth-options.md'),
    'utf8',
  );
  const contract = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/sender-auth-contract.md'),
    'utf8',
  );
  const authoring = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-flow-authoring.md'),
    'utf8',
  );
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(PLUGIN_ROOT, 'AGENTS.md'), 'utf8');

  assert.match(flow, /Workload Identity Federation \(Recommended\)/);
  assert.match(flow, /Create Power Automate flows; configure FCM authentication manually/);
  assert.match(flow, /two-option comparison/);
  assert.doesNotMatch(flow, /Managed Azure Function compatibility/);
  assert.doesNotMatch(flow, /non-Flow endpoint/);
  assert.match(
    flow,
    /customer-owned Power Automate sender \/ observable contract read back;\s+authentication not plugin-validated/,
  );
  assert.match(flow, /authors the complete non-secret producer,[\s\S]*sender action structure/i);
  assert.match(flow, /remains stopped/i);
  assert.match(flow, /customer configures FCM\s+authentication/i);
  assert.match(flow, /checkbox or verbal confirmation cannot promote/i);
  assert.match(flow, /exact\s+plugin-created sender flow ID/i);
  assert.match(flow, /observable\s+queued-outbox trigger\/guard, idempotent claim/i);
  assert.match(flow, /no\s+authentication-validation result/i);
  assert.match(authoring, /display name, screenshot, checkbox, or verbal "it works" is not a flow\s+identity/i);
  assert.match(authoring, /Read back only its observable, non-secret contract/i);
  assert.match(authoring, /Push flow handoff/);
  assert.match(authoring, /Sender flow ID/);
  assert.match(
    authoring,
    /customer-owned Power Automate sender \/ observable contract read back;\s+authentication not plugin-validated/,
  );
  assert.match(authoring, /both exact IDs must read back by ID\s+as `Started`/i);
  assert.doesNotMatch(authoring, /Non-Flow blocked handoff/);

  assert.match(options, /Workload Identity Federation \(Recommended\)/);
  assert.match(options, /Dedicated Entra app\/service principal and credential/);
  assert.match(options, /Azure Key Vault secret plus data-plane RBAC/);
  assert.match(options, /Google Workload Identity Pool and Provider/);
  assert.match(options, /Create Power Automate flows; configure FCM authentication manually/);
  assert.match(options, /authors the flows stopped/i);
  assert.doesNotMatch(options, /Managed Azure Function compatibility/);
  assert.doesNotMatch(options, /hosted endpoint/);
  assert.match(options, /FCM `validateOnly`/);
  assert.match(options, /authentication not plugin-validated/);

  assert.match(contract, /covers only the plugin-managed `wif` mode/i);
  assert.match(contract, /Do not create a manual\s+mode/i);
  assert.match(
    orchestration,
    /customer-owned Power Automate sender[\s\S]*authentication not plugin-validated/i,
  );
  assert.match(readme, /two choices—\*\*WIF \(Recommended\)\*\*/);
  assert.match(readme, /customer-configured FCM authentication/);
  assert.match(agents, /presents two sender-auth choices/);
});

test('push flow omits arbitrary extra data while preserving navigation and lifecycle fields', () => {
  const fs = require('node:fs');
  const flow = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/create-push-notification-flow/SKILL.md'),
    'utf8',
  );
  const authoring = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-flow-authoring.md'),
    'utf8',
  );
  const outbox = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-notification-outbox.md'),
    'utf8',
  );
  const wif = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-flow-wif.md'),
    'utf8',
  );
  const evals = require(path.join(
    PLUGIN_ROOT,
    'skills/create-push-notification-flow/evals/evals.json',
  )).evals;

  assert.doesNotMatch(outbox, /\| Additional Data \|/);
  assert.doesNotMatch(authoring, /additional data payload fields/i);
  assert.doesNotMatch(wif, /merges? approved Additional Data/i);
  assert.match(flow, /Do not solicit, store, or merge arbitrary extra FCM data/i);
  assert.match(authoring, /limits FCM `message\.data` to `schemaVersion`,\s+`destination`, and `params`/i);
  assert.match(outbox, /Payload Version/);
  assert.match(outbox, /Provider Message ID/);
  assert.match(outbox, /Navigation Parameters/);
  assert.match(evals.find(({ id }) => id === 33).expected_output, /does not ask for or construct arbitrary extra FCM fields/i);
  assert.match(evals.find(({ id }) => id === 33).expected_output, /lifecycle and correlation fields/i);
});

test('push flow recovery keeps the tool surface non-destructive', () => {
  const fs = require('node:fs');
  const flow = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/create-push-notification-flow/SKILL.md'),
    'utf8',
  );
  const authoring = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-flow-authoring.md'),
    'utf8',
  );
  const frontmatter = flow.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  const evals = JSON.parse(fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/create-push-notification-flow/evals/evals.json'),
    'utf8',
  )).evals;

  assert.doesNotMatch(frontmatter, /mcp__flowagent__delete_flow/);
  assert.doesNotMatch(authoring, /\bdelete_flow\b/);
  assert.doesNotMatch(authoring, /Delete only an empty\/incorrect flow/i);
  assert.match(authoring, /use `disable_flow`[\s\S]*disabled\/`Stopped`/i);
  assert.match(authoring, /make cleanup explicitly user-owned/i);
  assert.match(flow, /leave cleanup explicitly user-owned; do not delete it/i);
  assert.deepStrictEqual(evals.slice(-8, -5).map(({ id }) => id), [46, 47, 48]);
  assert.match(evals.find(({ id }) => id === 46).expected_output, /exact producer and sender IDs\/states/i);
  assert.match(evals.find(({ id }) => id === 47).expected_output, /does not use delete_flow/i);
  assert.match(
    evals.find(({ id }) => id === 48).expected_output,
    /does not offer or record a custom endpoint route/i,
  );
  assert.match(evals.find(({ id }) => id === 49).expected_output, /rejects the synthetic webhook run/i);
  assert.match(evals.find(({ id }) => id === 50).expected_output, /asynchronous-service backlog/i);
  assert.match(evals.find(({ id }) => id === 51).expected_output, /sender.*Dataverse callback queue/i);
  assert.match(evals.find(({ id }) => id === 52).expected_output, /without requiring equality/i);
  assert.match(evals.find(({ id }) => id === 53).expected_output, /fixed lookup/i);
});

test('WIF sender auth pins MCP versions and gcloud prerequisites', () => {
  const fs = require('node:fs');
  const wifSkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-push-wif/SKILL.md'),
    'utf8',
  );
  const wifReference = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-flow-wif.md'),
    'utf8',
  );
  assert.match(wifSkill, /allowed-tools: .*mcp__gcloud__run_gcloud_command.*mcp__azure__subscription.*mcp__azure__group.*mcp__azure__role/s);
  assert.match(wifSkill, /Google tool readiness gate/);
  assert.match(wifSkill, /official gcloud MCP requires Node\.js 20\+/i);
  assert.match(wifSkill, /Install Google Cloud CLI for me/);
  assert.match(wifSkill, /brew update && brew install --cask gcloud-cli/);
  assert.match(wifSkill, /separate explicit\s+confirmation/i);
  assert.match(wifSkill, /\/mcp[\s\S]*\/setup[\s\S]*\/restart[\s\S]*\/mcp/);
  assert.match(wifSkill, /require the Azure MCP surfaces and prefer the\s+official gcloud MCP surface/i);
  assert.match(wifSkill, /@google-cloud\/gcloud-mcp@0\.5\.3/);
  assert.match(wifSkill, /@azure\/mcp@2\.0\.5/);
  assert.match(wifSkill, /mcp__azure__subscription/);
  assert.match(wifSkill, /mcp__azure__group/);
  assert.doesNotMatch(wifSkill, /allowed-tools: .*mcp__azure__keyvault/s);
  assert.match(wifSkill, /mcp__azure__role/);
  assert.match(wifSkill, /role_assignment_list/);
  assert.match(wifSkill, /namespace tool plus[\s\S]*routed command\/parameters/);
  assert.match(wifSkill, /prepends the `gcloud` executable itself/);
  assert.match(wifSkill, /args"\s*:\s*\[\s*"config",\s*"list",\s*"account",\s*"--format=json"/s);
  assert.doesNotMatch(wifSkill, /"args"\s*:\s*\[\s*"gcloud"/s);
  assert.match(wifSkill, /does not expose the `keyvault` namespace/i);
  assert.match(wifSkill, /value-carrying Key[\s\S]*Vault secret operations/i);
  assert.match(wifSkill, /mcp__azure__azmcp_role_assignment_list/);
  assert.match(wifSkill, /keyvault_secret_list/);
  assert.doesNotMatch(wifSkill, /mcp__azure__azmcp_role_assignment_list.*allowed-tools/s);

  assert.match(wifReference, /@google-cloud\/gcloud-mcp@0\.5\.3/);
  assert.match(wifReference, /@azure\/mcp@2\.0\.5/);
  assert.match(wifReference, /mcp__azure__subscription/);
  assert.match(wifReference, /mcp__azure__group/);
  assert.doesNotMatch(wifReference, /mcp__azure__keyvault/);
  assert.match(wifReference, /mcp__azure__role/);
  assert.match(wifReference, /role_assignment_list/);
  assert.match(wifReference, /Call the namespace tool with routed command\/parameters/);
  assert.match(wifReference, /does not expose its[\s\S]*`keyvault` namespace/i);
  assert.match(wifReference, /no safe[\s\S]*metadata-only route/i);
});

test('WIF worker plans read-only and executes only the unchanged approved diff', () => {
  const fs = require('node:fs');
  const worker = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'agents/push-wif-worker.md'),
    'utf8',
  );
  const owner = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-push-wif/SKILL.md'),
    'utf8',
  );
  const parent = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const evaluation = require(path.join(
    PLUGIN_ROOT,
    'skills/setup-push-wif/evals/evals.json',
  )).evals.find(({ coverage }) => coverage === 'orchestrated-plan-approval-echo');

  assert.ok(evaluation, 'setup-push-wif covers plan approval and execute echo');
  for (const content of [worker, owner]) {
    assert.match(content, /`operation: plan`[\s\S]*read-only/i);
    assert.match(content, /proposedPlan/);
    assert.match(content, /approved_plan/);
    assert.match(content, /unchanged/);
  }
  assert.match(worker, /`plan` proposes; it never approves or executes/);
  assert.match(owner, /Planning never grants\s+mutation permission/i);
  assert.match(parent, /WIF `operation: plan` is never\s+part of this execution batch/);
  assert.match(parent, /Pass the accepted `sender-auth-plan`'s `proposedPlan` object unchanged/);
  assert.match(parent, /approved: true/);
  assert.match(parent, /broader_fcm_role_approved: true\|false/);

  const executeLine = [...worker.matchAll(/^WORKER_RESULT: (\{.+\})$/gm)]
    .map((match) => JSON.parse(match[1]))
    .find(({ operation }) => operation === 'execute');
  assert.ok(executeLine, 'WIF worker publishes a parseable execute result');

  for (const key of [
    'firebaseProjectId',
    'googleProjectId',
    'azureTenantId',
    'azureSubscriptionId',
    'wifPoolId',
    'wifProviderId',
    'senderServiceAccount',
    'entraSenderClientId',
  ]) {
    assert.ok(Object.hasOwn(executeLine.identities, key), `execute echoes identity ${key}`);
  }
  for (const key of [
    'approved',
    'route',
    'mutations',
    'apiEnablement',
    'googleExecutionMode',
    'broaderFcmRoleApproved',
    'leastPrivilegeRole',
    'broaderFcmRoleRequired',
    'resourceGroup',
    'keyVaultUri',
    'keyVaultSecretName',
    'runtimeConnectionPrincipal',
    'inventoryObservedAt',
  ]) {
    assert.ok(Object.hasOwn(executeLine.decisions, key), `execute echoes decision ${key}`);
  }
  assert.strictEqual(executeLine.decisions.approved, true);
  assert.deepStrictEqual(executeLine.changedFiles, ['sender-auth.json']);
  assert.deepStrictEqual(executeLine.validatedFiles, ['sender-auth.json']);
  assert.match(parent, /resolve each against `working_dir`\s+before comparing it with the absolute exclusive path/);
  assert.match(evaluation.expected_output, /execute consumes the unchanged plan/);
  assert.match(evaluation.expected_output, /echoes every identity, route, list, role, and approval/);
});

test('WIF worker separates truly cold identity bootstrap from final execution', () => {
  const fs = require('node:fs');
  const worker = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'agents/push-wif-worker.md'),
    'utf8',
  );
  const parent = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const reference = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-wif-provisioning.md'),
    'utf8',
  );
  const evaluation = require(path.join(
    PLUGIN_ROOT,
    'skills/setup-push-wif/evals/evals.json',
  )).evals.find(({ coverage }) => coverage === 'orchestrated-cold-identity-bootstrap');
  const workerResults = [...worker.matchAll(/^WORKER_RESULT: (\{.+\})$/gm)]
    .map((match) => JSON.parse(match[1]));
  const bootstrapPlan = workerResults.find(({ stage }) => stage === 'identity-bootstrap-plan');
  const bootstrap = workerResults.find(({ operation }) => operation === 'identity-bootstrap');

  assert.ok(evaluation, 'setup-push-wif covers a genuinely absent Entra app');
  assert.ok(bootstrapPlan, 'worker defines the initial bootstrap plan result');
  assert.strictEqual(bootstrapPlan.identities.entraSenderClientId, null);
  assert.deepStrictEqual(bootstrapPlan.identityBootstrapPlan.googleMutations, []);
  assert.deepStrictEqual(bootstrapPlan.identityBootstrapPlan.apiEnablement, []);
  assert.ok(bootstrap, 'worker defines the identity-bootstrap result');
  assert.ok(bootstrap.identityBootstrapReceipt.entraSenderClientId);
  assert.deepStrictEqual(bootstrap.changedFiles, []);
  assert.ok(!Object.hasOwn(bootstrap, 'senderAuthPath'));

  for (const content of [worker, reference]) {
    assert.match(content, /operation: identity-bootstrap/);
    assert.match(content, /fresh (?:app-only token|read-only plan)/i);
    assert.match(content, /server-generated\s+client ID/i);
  }
  assert.match(parent, /first approval does \*\*not\*\* authorize/);
  assert.match(parent, /approval #2/);
  assert.match(parent, /same `run_id`/);
  assert.match(parent, /identity-bootstrap-plan -> identity-bootstrap ->\s+sender-auth-plan -> sender-auth/);
  assert.match(evaluation.expected_output, /does not create sender-auth\.json/);
  assert.match(evaluation.expected_output, /second explicit approval/);
});

test('push orchestration documents independent resumable setup tracks', () => {
  const orchestration = require(ORCHESTRATION_EVAL_PATH);
  assert.strictEqual(orchestration.skill_name, 'add-push-notifications');
  assert.deepStrictEqual(
    orchestration.evals.map(({ id }) => id),
    Array.from({ length: 29 }, (_, index) => index + 1),
  );

  const skill = require('node:fs').readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const readme = require('node:fs').readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const agents = require('node:fs').readFileSync(path.join(PLUGIN_ROOT, 'AGENTS.md'), 'utf8');
  const lifecycle = require('node:fs').readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-lifecycle.md'),
    'utf8',
  );

  assert.match(skill, /independent,\s+resumable lifecycle/);
  assert.match(skill, /default user-facing push command/);
  assert.match(skill, /Default to \*\*Create delivery flows\*\*/);
  assert.match(skill, /do not merely print the next slash\s+command/i);
  assert.match(lifecycle, /Track Android and iOS independently/);
  assert.match(lifecycle, /A user should not need to manually chain them/);
  assert.match(lifecycle, /\| 5\. Power Automate flows .*`\/create-push-notification-flow` \|/);
  assert.match(readme, /Push notification cloud prerequisites/);
  assert.match(readme, /premium connector/);
  assert.match(agents, /WIF is the preferred sender authentication/);
  assert.match(agents, /Azure Function and custom endpoint options are not offered/);
  assert.match(orchestration.evals[17].expected_output, /shared parser\/dispatcher for all four sources/);
  assert.match(orchestration.evals[19].expected_output, /scheduleNotificationAsync/);
  assert.match(orchestration.evals[20].expected_output, /same channel ID/);
  assert.match(orchestration.evals[21].expected_output, /at most two platform workers/);
  assert.match(orchestration.evals[21].expected_output, /max-three wave/);
  assert.match(orchestration.evals[22].expected_output, /one synchronous mobile-app:push-runtime-worker/);
  assert.match(orchestration.evals[23].expected_output, /deterministic serial owner\/inline path/);
  assert.match(orchestration.evals[24].expected_output, /malformed WIF return as BLOCKED/);
  assert.match(orchestration.evals[25].expected_output, /detects drift from the pre-wave hash/);
  assert.match(orchestration.evals[26].expected_output, /iOS as blocked/);
  assert.strictEqual(
    orchestration.evals[27].coverage,
    'worker-contract-preflight-plan-paths-and-ios-fallback',
  );
  assert.match(orchestration.evals[27].expected_output, /operation: preflight/);
  assert.match(orchestration.evals[27].expected_output, /unchanged explicitly approved plan/);
  assert.match(orchestration.evals[27].expected_output, /setup-apns exactly once/);
  assert.strictEqual(
    orchestration.evals[28].coverage,
    'cold-wif-identity-bootstrap-reapproval',
  );
  assert.match(orchestration.evals[28].expected_output, /null Entra client ID/);
  assert.match(orchestration.evals[28].expected_output, /second explicit approval/);
  assert.match(orchestration.evals[28].expected_output, /only in order/);
});

test('iOS push orchestration invokes owners without duplicating their workflows', () => {
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

  assert.match(skill, /\| iOS \| Firebase client; Apple\/APNs capability; runtime integration; wrapped build; physical delivery \|/);
  assert.match(skill, /\| Shared delivery \| Sender authentication; producer\/sender flows \|/);
  assert.match(skill, /configured, device verification pending/i);
  assert.match(skill, /invoking and resuming those owners, not copying their implementation/i);
  assert.match(skill, /invoke `\/build-android` and\/or\s+`\/build-ios`/);
  assert.match(skill, /invoke `\/verify-android-push` and\/or\s+`\/verify-ios-push`/);
  assert.match(apns, /configured, device verification\s+pending/i);
  assert.match(apns, /Only `\/verify-ios-push`/);
  assert.match(deploy, /Power Platform \*\*web bundle deployment\*\*/);
  assert.match(deploy, /route to `\/build-ios`/i);
  assert.doesNotMatch(deploy, /native compile and manual device testing are user-owned/);
  assert.match(debug, /route user to `\/verify-ios-push`/);
  assert.match(debug, /Keep general Metro diagnostics here/);
  assert.match(readme, /\| `\/build-ios` \|/);
  assert.match(readme, /\| `\/verify-ios-push` \|/);
  assert.match(readme, /development and ad-hoc\s+registered-device IPA workflows/);
  assert.match(readme, /user directly manages signing; `\/build-ios` runs the confirmed Wrap\s+command/);
  assert.match(agents, /35 skills \+ 9 agents/);
  assert.match(agents, /manual Apple Developer and Xcode guidance/);
  assert.match(agents, /user owns signing assets, registered devices/);
});

test('push docs require official MCP-first orchestration boundaries', () => {
  const fs = require('node:fs');
  const shared = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/shared-instructions.md'),
    'utf8',
  );
  const readme = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf8');
  const agents = fs.readFileSync(path.join(PLUGIN_ROOT, 'AGENTS.md'), 'utf8');
  const addPush = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const createFlow = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/create-push-notification-flow/SKILL.md'),
    'utf8',
  );
  const verify = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/verify-ios-push/SKILL.md'),
    'utf8',
  );
  const officialMcp = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/official-mcp-servers.md'),
    'utf8',
  );

  assert.match(shared, /official MCP-first/i);
  assert.match(shared, /firebase-tools` \*\*15\.27\.0\*\*/);
  assert.match(shared, /15\.28\.1.*main\/unpublished/);
  assert.match(shared, /gcloud MCP \*\*0\.5\.3\*\*/);
  assert.match(shared, /Azure MCP GA \*\*2\.0\.5\*\*/);
  assert.match(shared, /Firebase MCP required/);
  assert.match(shared, /gcloud MCP preferred for `\/setup-push-wif`/);
  assert.match(shared, /Azure MCP required for covered operations/);
  assert.match(shared, /role_assignment_list/);
  assert.match(shared, /secret values and are intentionally excluded/i);
  assert.match(shared, /RBAC mutations/);
  assert.match(shared, /Entra resource work/);
  assert.match(shared, /secret-safe writes/);
  assert.match(shared, /FlowAgent remains the Power Automate mutation path/);
  assert.match(shared, /Apple setup is manual and user-owned/);
  assert.match(shared, /Do not automate Apple\s+configuration, generate a proof contract, inspect signing assets/);
  assert.match(readme, /Push cloud setup is \*\*official MCP-first\*\*/);
  assert.match(readme, /No CLI fallback/);
  assert.match(readme, /Microsoft Learn MCP\/docs remain the authoritative\s+source/);
  assert.match(readme, /firebase-tools` \*\*15\.27\.0\*\*/);
  assert.match(readme, /gcloud MCP \*\*0\.5\.3\*\*/);
  assert.match(readme, /Azure MCP GA \*\*2\.0\.5\*\*/);
  assert.match(readme, /subscription\/group\/RBAC read-back/i);
  assert.match(readme, /does not expose the `keyvault` namespace/i);
  assert.match(readme, /RBAC mutations/);
  assert.match(agents, /Push cloud setup is \*\*official MCP-first\*\*/);
  assert.match(agents, /firebase-tools` 15\.27\.0/);
  assert.match(agents, /gcloud MCP 0\.5\.3/);
  assert.match(agents, /Azure MCP GA 2\.0\.5/);
  assert.match(agents, /Google Cloud CLI/);
  assert.match(addPush, /vendor-official Firebase MCP\s+only/);
  assert.match(
    createFlow,
    /Do not fall\s+back to `firebase-tools`, `gcloud`, or cloud\s+provisioning from this skill/,
  );
  assert.match(verify, /consumes only previously validated MCP-first handoffs/i);
  assert.match(officialMcp, /Apple Developer and Xcode setup is intentionally outside MCP automation/);
  assert.match(
    officialMcp,
    /No MCP\s+server, local\s+provisioning tool, or generated proof artifact substitutes/,
  );
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
