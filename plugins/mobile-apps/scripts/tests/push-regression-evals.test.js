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

  assert.deepStrictEqual(ids, Array.from({ length: 48 }, (_, index) => index + 1));
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
  assert.match(shared, /mcp__azure__functionapp/);
  assert.match(shared, /mcp__azure__appservice/);
  assert.doesNotMatch(shared, /mcp__azure__keyvault/);
  assert.match(shared, /role_assignment_list/);
  assert.match(shared, /functionapp_get/);
  assert.match(shared, /appservice_webapp_get/);
  assert.match(shared, /appservice_webapp_deployment_get/);
  assert.match(shared, /appservice_webapp_settings_get-appsettings/);
  assert.match(shared, /appservice_webapp_settings_update-appsettings/);
  assert.match(shared, /does not expose the `keyvault` namespace/i);
  assert.match(shared, /value-carrying secret operations/i);
  assert.match(shared, /Do \*\*not\*\* rely on nonexistent names such[\s\S]*`functionapp_list` or `keyvault_secret_list`/);
  assert.doesNotMatch(shared, /azmcp_/);

  assert.match(readme, /`\/setup-fcm`.*vendor-official Firebase MCP/);
  assert.match(
    readme,
    /\| `\/setup-fcm` \| .*vendor-official Firebase MCP to list\/select\/create Firebase projects.*No CLI fallback\./,
  );
  assert.match(readme, /gcloud MCP for `\/setup-push-wif` Google Cloud operations/);
  assert.match(readme, /`functionapp_get`/);
  assert.match(readme, /does not expose the `keyvault` namespace/i);

  assert.match(agents, /Firebase MCP for `\/setup-fcm`/);
  assert.match(agents, /gcloud MCP for `\/setup-push-wif`/);
  assert.match(agents, /`role_assignment_list`, `functionapp_get`, `appservice_webapp_get`/);
  assert.match(agents, /does not expose Azure MCP's `keyvault` namespace/i);
  assert.match(officialMcp, /Workflow readiness gates and `\/mcp` recovery/);
  assert.match(officialMcp, /\/setup-push-wif[\s\S]*`azure`; `gcloud` preferred[\s\S]*mcp__azure__role[\s\S]*mcp__gcloud__run_gcloud_command/s);
  assert.match(officialMcp, /\/setup-push-service-account[\s\S]*azure[\s\S]*mcp__azure__functionapp[\s\S]*mcp__azure__appservice/s);
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
  assert.match(flow, /Managed Azure Function compatibility/);
  assert.match(flow, /Manual\/customer-owned sender authentication/);
  assert.match(flow, /show its three-option comparison/);
  assert.match(flow, /do not invoke or create a\s+setup skill/i);
  assert.match(
    flow,
    /customer-owned Power Automate sender \/ observable contract read back;\s+authentication not plugin-validated/,
  );
  assert.match(
    flow,
    /authors only the producer\/outbox artifacts[\s\S]*not ready for downstream routing without a safe sender handoff/i,
  );
  assert.match(flow, /must not create a placeholder[\s\S]*unauthenticated HTTP\s+action/i);
  assert.match(flow, /checkbox or verbal confirmation cannot promote/i);
  assert.match(flow, /customer-supplied and\s+approved \*\*exact sender flow ID\*\*/i);
  assert.match(flow, /call\s+`get_flow` for that ID/i);
  assert.match(flow, /returned ID to match exactly and state `Started`/i);
  assert.match(flow, /observable\s+queued-outbox trigger\/guard, idempotent claim/i);
  assert.match(flow, /no\s+authentication-validation result/i);
  assert.match(
    authoring,
    /A display name, URL with\s+an unproved ID, screenshot,\s+checkbox, or verbal "it works" is not a flow identity/i,
  );
  assert.match(authoring, /Read back only its observable, non-secret contract/i);
  assert.match(authoring, /Push flow handoff/);
  assert.match(authoring, /Sender flow ID/);
  assert.match(
    authoring,
    /customer-owned Power Automate sender \/ observable contract read back;\s+authentication not plugin-validated/,
  );
  assert.match(authoring, /### Flow-backed handoff schema/);
  assert.match(authoring, /both exact IDs must read back by ID\s+as `Started`/i);
  assert.match(authoring, /### Non-Flow blocked handoff schema/);
  const nonFlowFields = authoring.match(
    /### Non-Flow blocked handoff schema[\s\S]*?Use only these fields:\n([\s\S]*?)\n\nThe endpoint identifier/,
  )?.[1] || '';
  assert.match(nonFlowFields, /`Sender endpoint identifier`/);
  assert.match(nonFlowFields, /`Producer flow ID`/);
  assert.match(nonFlowFields, /`Producer flow state`/);
  assert.doesNotMatch(nonFlowFields, /`Sender flow ID`|`Sender flow state`/);
  assert.match(
    flow,
    /For a non-Flow endpoint[\s\S]*Omit `Sender flow ID` and `Sender flow state` entirely/i,
  );

  assert.match(options, /Workload Identity Federation \(Recommended\)/);
  assert.match(options, /Dedicated Entra app\/service principal and credential/);
  assert.match(options, /Azure Key Vault secret plus data-plane RBAC/);
  assert.match(options, /Google Workload Identity Pool and Provider/);
  assert.match(options, /existing Firebase service-account JSON/i);
  assert.match(options, /managed-identity-enabled Azure Function/);
  assert.match(options, /customer-selected design requires/i);
  assert.match(options, /No setup skill, provisioning, credential handling/);
  assert.match(options, /FCM `validateOnly`/);
  assert.match(options, /customer-owned \/ not plugin-validated/);

  assert.match(contract, /covers only the plugin-managed `wif` and\s+`function-endpoint` modes/i);
  assert.match(contract, /Do not create a manual mode/i);
  assert.match(
    orchestration,
    /customer-owned Power Automate sender[\s\S]*authentication not plugin-validated/i,
  );
  assert.match(readme, /three choices—\*\*WIF \(Recommended\)\*\*/);
  assert.match(readme, /Manual\/customer-owned/);
  assert.match(agents, /three informed sender-auth choices/);
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
  assert.deepStrictEqual(evals.slice(-3).map(({ id }) => id), [46, 47, 48]);
  assert.match(evals.find(({ id }) => id === 46).expected_output, /exact producer and sender IDs\/states/i);
  assert.match(evals.find(({ id }) => id === 47).expected_output, /does not use delete_flow/i);
  assert.match(
    evals.find(({ id }) => id === 48).expected_output,
    /omits Sender flow ID and Sender flow state entirely/i,
  );
});

test('push sender auth skills pin GA MCP versions and namespace semantics', () => {
  const fs = require('node:fs');
  const wifSkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-push-wif/SKILL.md'),
    'utf8',
  );
  const wifReference = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-flow-wif.md'),
    'utf8',
  );
  const endpointSkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-push-service-account/SKILL.md'),
    'utf8',
  );
  const functionReference = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-push-service-account/references/function-endpoint.md'),
    'utf8',
  );

  assert.match(wifSkill, /allowed-tools: .*mcp__gcloud__run_gcloud_command.*mcp__azure__subscription.*mcp__azure__group.*mcp__azure__role/s);
  assert.match(wifSkill, /Google tool readiness gate/);
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

  assert.match(endpointSkill, /allowed-tools: .*mcp__azure__subscription.*mcp__azure__group.*mcp__azure__role.*mcp__azure__functionapp.*mcp__azure__appservice/s);
  assert.match(endpointSkill, /MCP readiness gate/);
  assert.match(endpointSkill, /\/mcp[\s\S]*\/setup[\s\S]*\/restart[\s\S]*\/mcp/);
  assert.match(endpointSkill, /show `azure` connected with the required[\s\S]*tools/i);
  assert.match(endpointSkill, /@azure\/mcp@2\.0\.5/);
  assert.match(endpointSkill, /mcp__azure__subscription/);
  assert.match(endpointSkill, /mcp__azure__group/);
  assert.doesNotMatch(endpointSkill, /allowed-tools: .*mcp__azure__keyvault/s);
  assert.match(endpointSkill, /mcp__azure__functionapp/);
  assert.match(endpointSkill, /mcp__azure__appservice/);
  assert.doesNotMatch(endpointSkill, /allowed-tools: .*mcp__azure__deploy/s);
  assert.match(endpointSkill, /mcp__azure__role/);
  assert.match(endpointSkill, /Use the namespace[\s\S]*tool plus routed command\/parameters/);
  assert.match(endpointSkill, /does not[\s\S]*expose the `keyvault` namespace/i);
  assert.match(endpointSkill, /mcp__azure__azmcp_functionapp_get/);
  assert.match(endpointSkill, /mcp__azure__azmcp_role_assignment_list/);
  assert.match(endpointSkill, /functionapp_list/);
  assert.match(endpointSkill, /keyvault_secret_list/);

  assert.match(functionReference, /@azure\/mcp@2\.0\.5/);
  assert.match(functionReference, /mcp__azure__subscription/);
  assert.match(functionReference, /mcp__azure__group/);
  assert.doesNotMatch(functionReference, /mcp__azure__keyvault/);
  assert.match(functionReference, /mcp__azure__functionapp/);
  assert.match(functionReference, /functionapp_get/);
  assert.match(functionReference, /mcp__azure__appservice/);
  assert.match(functionReference, /appservice_webapp_get/);
  assert.match(functionReference, /appservice_webapp_deployment_get/);
  assert.match(functionReference, /appservice_webapp_settings_get-appsettings/);
  assert.match(functionReference, /appservice_webapp_settings_update-appsettings/);
  assert.match(functionReference, /mcp__azure__role/);
  assert.match(functionReference, /role_assignment_list/);
  assert.match(functionReference, /does not expose a safe[\s\S]*metadata-only Key Vault namespace route/i);
  assert.match(functionReference, /Function creation\/deployment and other unsupported mutation edges/);
  assert.match(functionReference, /Do not use `keyvault_secret_get` or `keyvault_secret_create`/);
  assert.doesNotMatch(functionReference, /mcp__azure__deploy/);
  assert.match(functionReference, /do not\s+invent nonexistent tool names such as `mcp__azure__azmcp_functionapp_get` or\s+`functionapp_list`/i);
});

test('push orchestration documents independent resumable setup tracks', () => {
  const orchestration = require(ORCHESTRATION_EVAL_PATH);
  assert.strictEqual(orchestration.skill_name, 'add-push-notifications');
  assert.deepStrictEqual(
    orchestration.evals.map(({ id }) => id),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
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
  assert.match(lifecycle, /Track Android and iOS independently/);
  assert.match(lifecycle, /\| 5\. Power Automate flows .*`\/create-push-notification-flow` \|/);
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
  assert.match(skill, /These\s+are handoffs, not substeps/);
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
  assert.match(agents, /38 skills \+ 5 agents/);
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
  assert.match(shared, /functionapp_get/);
  assert.match(shared, /appservice_webapp_get/);
  assert.match(shared, /appservice_webapp_deployment_get/);
  assert.match(shared, /appservice_webapp_settings_get-appsettings/);
  assert.match(shared, /appservice_webapp_settings_update-appsettings/);
  assert.match(shared, /secret values and are intentionally excluded/i);
  assert.match(shared, /RBAC mutations/);
  assert.match(shared, /Function\s+creation\/deployment\/auth\/managed identity/);
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
  assert.match(readme, /`role_assignment_list`/);
  assert.match(readme, /`functionapp_get`/);
  assert.match(readme, /does not expose the `keyvault` namespace/i);
  assert.match(readme, /RBAC mutations/);
  assert.match(agents, /Push cloud setup is \*\*official MCP-first\*\*/);
  assert.match(agents, /firebase-tools` 15\.27\.0/);
  assert.match(agents, /gcloud MCP 0\.5\.3/);
  assert.match(agents, /Azure MCP GA 2\.0\.5/);
  assert.match(agents, /`role_assignment_list`, `functionapp_get`, `appservice_webapp_get`/);
  assert.match(agents, /secret-safe writes remain explicit `az` gaps/);
  assert.match(addPush, /vendor-official Firebase MCP\s+only/);
  assert.match(
    createFlow,
    /Do not fall\s+back to `firebase-tools`,\s*`gcloud`, or Azure provisioning from this skill/,
  );
  assert.match(verify, /consumes only previously validated MCP-first handoffs/i);
  assert.match(officialMcp, /Apple Developer and Xcode setup is intentionally outside MCP automation/);
  assert.match(officialMcp, /No MCP\s+server, local provisioning tool, or generated proof artifact substitutes/);
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
