'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
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

  assert.deepStrictEqual(ids, Array.from({ length: 79 }, (_, index) => index + 1));
  for (const evaluation of evals) {
    assert.ok(evaluation.prompt.trim(), `scenario ${evaluation.id} needs a prompt`);
    assert.ok(evaluation.expected_output.trim(), `scenario ${evaluation.id} needs expected output`);
  }
});

test('shared push docs record Firebase MCP, guarded gcloud CLI, and Azure MCP boundaries', () => {
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
  assert.match(shared, /Guarded Google Cloud CLI required for `\/setup-push-wif`/);
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
  assert.match(readme, /Google Cloud CLI executed\s+only through the checked-in allowlisted wrapper/);
  assert.match(readme, /does not expose the `keyvault` namespace/i);

  assert.match(agents, /Firebase MCP for `\/setup-fcm`/);
  assert.match(agents, /Google Cloud CLI only through `scripts\/run-allowlisted-gcloud\.js` for `\/setup-push-wif`/);
  assert.match(agents, /requires Node\.js 20\+ and Google Cloud CLI only when WIF setup runs/i);
  assert.match(agents, /`keyvault` namespace remains excluded/i);
  assert.match(officialMcp, /Workflow readiness gates and `\/mcp` recovery/);
  assert.match(officialMcp, /\/setup-push-wif[\s\S]*`azure`[\s\S]*mcp__azure__role[\s\S]*run-allowlisted-gcloud\.js/s);
  assert.match(officialMcp, /requires Node\.js 20\+ plus a working official\s+`gcloud` executable/i);
  assert.match(officialMcp, /\/mcp[\s\S]*\/setup[\s\S]*\/restart[\s\S]*\/mcp/);
  assert.match(officialMcp, /Never call `gcloud` directly[\s\S]*outside the checked-in allowlist/i);

  assert.match(addPush, /vendor-official Firebase MCP\s+only/);
  assert.doesNotMatch(addPush, /Firebase MCP[\s\S]*plus gcloud MCP/);
  assert.doesNotMatch(`${agents}\n${addPush}`, /gcloud(?:\/Azure)? MCP/i);
  const orchestrationEvals = fs.readFileSync(ORCHESTRATION_EVAL_PATH, 'utf8');
  assert.doesNotMatch(orchestrationEvals, /gcloud(?:\/Azure)? MCP/i);
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
  assert.match(flow, /choose managed WIF or customer-configured authentication/);
  assert.match(flow, /Reuse this app registration/);
  assert.match(flow, /Use a different existing registration/);
  assert.match(flow, /Create a new dedicated registration/);
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
  assert.match(options, /reuse the app registration, provide another existing client ID, or create a new dedicated registration/i);
  assert.match(options, /Cross-tenant IDs are unsupported/);
  assert.match(options, /Never overwrite the mobile app's `auth\.config\.json`/);
  assert.match(options, /credential stored in Azure Key Vault; data-plane RBAC/);
  assert.match(options, /Google Workload Identity Pool and Provider/);
  assert.match(options, /Create Power Automate flows; configure FCM authentication manually/);
  assert.match(options, /authors the flows stopped/i);
  assert.doesNotMatch(options, /Managed Azure Function compatibility/);
  assert.doesNotMatch(options, /hosted endpoint/);
  assert.match(options, /FCM `validateOnly`/);
  assert.match(options, /authentication not plugin-validated/);

  assert.match(contract, /covers only the plugin-managed `wif` mode/i);
  assert.match(contract, /Common envelope \(version 2\)/);
  assert.match(contract, /reuse-app-registration/);
  assert.match(contract, /use-existing-registration/);
  assert.match(contract, /create-dedicated-registration/);
  assert.match(contract, /Version 1 handoffs are intentionally rejected/);
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
  assert.ok(evals.find(({ id }) => id === 46));
  assert.ok(evals.find(({ id }) => id === 47));
  assert.ok(evals.find(({ id }) => id === 48));
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

test('WIF sender auth uses the guarded gcloud CLI and pinned Azure MCP', () => {
  const fs = require('node:fs');
  const wifSkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-push-wif/SKILL.md'),
    'utf8',
  );
  const wifReference = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-flow-wif.md'),
    'utf8',
  );
  assert.match(wifSkill, /allowed-tools: .*mcp__azure__subscription.*mcp__azure__group.*mcp__azure__role/s);
  assert.doesNotMatch(wifSkill, /mcp__gcloud/);
  assert.match(wifSkill, /Google tool readiness gate/);
  assert.match(wifSkill, /requires Node\.js 20\+, an installed Google Cloud CLI/i);
  assert.match(wifSkill, /Install Google Cloud CLI for me/);
  assert.match(wifSkill, /brew update && brew install --cask gcloud-cli/);
  assert.match(wifSkill, /separate explicit\s+confirmation/i);
  assert.match(wifSkill, /require the Azure MCP surfaces, a successful\s+`gcloud --version`/i);
  assert.match(wifSkill, /scripts\/run-allowlisted-gcloud\.js/);
  assert.match(wifSkill, /@azure\/mcp@2\.0\.5/);
  assert.match(wifSkill, /mcp__azure__subscription/);
  assert.match(wifSkill, /mcp__azure__group/);
  assert.doesNotMatch(wifSkill, /allowed-tools: .*mcp__azure__keyvault/s);
  assert.match(wifSkill, /mcp__azure__role/);
  assert.match(wifSkill, /role_assignment_list/);
  assert.match(wifSkill, /namespace tool plus[\s\S]*routed command\/parameters/);
  assert.match(wifSkill, /Pass tokenized arguments after `--`/);
  assert.match(wifSkill, /config list account --format=json/);
  assert.match(wifSkill, /does not expose the `keyvault` namespace/i);
  assert.match(wifSkill, /value-carrying Key[\s\S]*Vault secret operations/i);
  assert.match(wifSkill, /mcp__azure__azmcp_role_assignment_list/);
  assert.match(wifSkill, /keyvault_secret_list/);
  assert.doesNotMatch(wifSkill, /mcp__azure__azmcp_role_assignment_list.*allowed-tools/s);

  assert.match(wifReference, /scripts\/run-allowlisted-gcloud\.js/);
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

test('push owners share stage-specific readiness and evidence-based recovery', () => {
  const readiness = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-tool-readiness.md'),
    'utf8',
  );
  const wifSkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-push-wif/SKILL.md'),
    'utf8',
  );
  const wifReference = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-wif-provisioning.md'),
    'utf8',
  );
  const flowSkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/create-push-notification-flow/SKILL.md'),
    'utf8',
  );
  const authoring = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-flow-authoring.md'),
    'utf8',
  );
  const wifEvals = JSON.parse(fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-push-wif/evals/evals.json'),
    'utf8',
  )).evals;
  const flowEvals = JSON.parse(fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/create-push-notification-flow/evals/evals.json'),
    'utf8',
  )).evals;
  const appleSkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apple-ios/SKILL.md'),
    'utf8',
  );
  const apnsSkill = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-apns/SKILL.md'),
    'utf8',
  );

  for (const code of [
    'local-runtime-missing',
    'mcp-server-disconnected',
    'plugin-missing',
    'not-authenticated',
    'active-context-mismatch',
    'permission-denied',
    'api-disabled',
    'billing-policy-blocked',
    'transient-readback',
    'unknown-safe-blocker',
  ]) {
    assert.match(readiness, new RegExp(`\\\`${code}\\\``));
  }
  assert.match(wifSkill, /--stage wif/);
  assert.match(wifSkill, /choosing manual installation must not end the skill/);
  assert.match(wifSkill, /Only an explicit cancellation may turn a missing-CLI installation gate into a\s+terminal blocker/);
  assert.match(wifSkill, /installation or `\/mcp` recovery is not a fix for\s+an authenticated provider denial/);
  assert.match(wifReference, /Do not recommend installation for an authenticated IAM\/API\/policy failure/);
  assert.match(wifReference, /do not return a terminal blocker or require the user to\s+start the skill again/);
  assert.match(flowSkill, /Run the `flow-authoring`\s+local prerequisite probe first/);
  assert.match(flowSkill, /Do not return\s+a terminal blocker or end the session while the user is installing/);
  assert.match(authoring, /--stage flow-authoring/);
  assert.match(authoring, /Keep the current skill invocation open\s+while the user installs the tool/);
  assert.match(authoring, /Confirmation alone is not proof/);
  assert.match(appleSkill, /--stage ios-build/);
  assert.doesNotMatch(appleSkill, /combined worker mode|WORKER_RESULT|push-ios-prerequisites-worker/);
  assert.match(apnsSkill, /has no MCP, Firebase CLI, gcloud, Azure/);
  assert.match(apnsSkill, /do not diagnose that as a missing APNs automation tool/);
  for (const id of [68, 69, 70, 71, 72, 78]) assert.ok(wifEvals.find((item) => item.id === id));
  for (const id of [73, 74, 75, 76, 77, 79]) assert.ok(flowEvals.find((item) => item.id === id));
});

test('WIF owner plans and executes the exact approved diff serially', () => {
  const owner = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-push-wif/SKILL.md'),
    'utf8',
  );
  const reference = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-wif-provisioning.md'),
    'utf8',
  );
  const parent = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );

  assert.match(owner, /Show the full state\/diff, resource and RBAC mutations/);
  assert.match(owner, /Obtain explicit confirmation before every\s+repair\/provision route/);
  assert.match(owner, /first approval never authorizes the second stage/i);
  assert.match(reference, /Any\s+discovered addition, route change, execution-mode change/);
  assert.match(reference, /requires a new explicit approval/);
  assert.match(parent, /invoke `\/setup-push-wif --working-dir <root>` synchronously/);
  assert.doesNotMatch(parent, /broader_fcm_role_approved/);
  assert.doesNotMatch(owner, /push-wif-worker/);
  assert.doesNotMatch(reference, /WORKER_RESULT/);
  assert.ok(!fs.existsSync(path.join(PLUGIN_ROOT, 'agents/push-wif-worker.md')));
});

test('WIF does not offer a broader Firebase Admin role', () => {
  const fs = require('node:fs');
  const reference = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-wif-provisioning.md'),
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
  )).evals.find(({ coverage }) => coverage === 'no-broader-fcm-role-question');

  assert.match(reference, /only supported FCM project role/);
  assert.match(reference, /`wif-custom-role-policy-blocked`/);
  assert.match(reference, /must not be offered/);
  assert.match(owner, /do not offer or ask about a broader Firebase/);
  assert.match(parent, /Do not ask about a broader Firebase role or\s+Firebase Admin SDK/);
  assert.doesNotMatch(`${reference}\n${owner}\n${parent}`, /broader_fcm_role_approved/);
  assert.ok(evaluation, 'WIF broader-role regression eval exists');
  assert.match(evaluation.expected_output, /does not ask for or offer broader Firebase role/);
});

test('WIF owner separates truly cold identity bootstrap from final execution', () => {
  const parent = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/add-push-notifications/SKILL.md'),
    'utf8',
  );
  const owner = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/setup-push-wif/SKILL.md'),
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
  assert.ok(evaluation, 'setup-push-wif covers a genuinely absent Entra app');
  for (const content of [parent, owner, reference]) {
    assert.match(content, /create-dedicated-registration/);
    assert.match(content, /(?:server-)?generated\s+client ID/i);
    assert.match(content, /fresh (?:claim|token)/i);
  }
  assert.match(parent, /two-stage approval boundary/);
  assert.match(parent, /Bootstrap never mutates Google or writes `sender-auth\.json`/);
  assert.match(owner, /first approval never authorizes the second stage/i);
  assert.match(reference, /first present\s+only the narrow identity\/credential and secret-safe Key Vault bootstrap plan/);
  assert.match(reference, /fresh complete plan for the remaining Google\/API\/RBAC work/);
  assert.match(evaluation.expected_output, /does not create sender-auth\.json/);
  assert.match(evaluation.expected_output, /second explicit approval/);
});

test('WIF registration choice is immutable and same-tenant', () => {
  const flow = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'skills/create-push-notification-flow/SKILL.md'),
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
  const reference = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/push-wif-provisioning.md'),
    'utf8',
  );
  const contract = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'shared/references/sender-auth-contract.md'),
    'utf8',
  );

  for (const content of [flow, owner, parent, reference, contract]) {
    assert.match(content, /reuse-app-registration/);
    assert.match(content, /use-existing-registration/);
    assert.match(content, /create-dedicated-registration/);
  }
  assert.match(flow, /never write this sender-only ID to `auth\.config\.json`/i);
  assert.match(reference, /same (?:resolved )?tenant/i);
  assert.match(reference, /never\s+write it to `auth\.config\.json`/i);
  assert.match(parent, /Never silently switch modes/i);
  assert.match(contract, /registrationMode/);
});

test('push orchestration documents independent resumable setup tracks', () => {
  const orchestration = require(ORCHESTRATION_EVAL_PATH);
  assert.strictEqual(orchestration.skill_name, 'add-push-notifications');
  assert.deepStrictEqual(
    orchestration.evals.map(({ id }) => id),
    Array.from({ length: 38 }, (_, index) => index + 1),
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
  assert.match(orchestration.evals[21].expected_output, /creates no background Task/);
  assert.match(orchestration.evals[21].expected_output, /invokes \/setup-fcm serially/);
  assert.match(orchestration.evals[21].expected_output, /implements runtime integration directly/);
  assert.match(orchestration.evals[22].expected_output, /implements Android runtime integration directly/);
  assert.match(orchestration.evals[23].expected_output, /uses no background Task/);
  assert.match(orchestration.evals[24].expected_output, /uses no background agents/);
  assert.match(orchestration.evals[25].expected_output, /No deferred worker merge/i);
  assert.match(orchestration.evals[26].expected_output, /iOS as blocked/);
  assert.strictEqual(
    orchestration.evals[27].coverage,
    'serial-ios-owner-order',
  );
  assert.match(orchestration.evals[27].expected_output, /setup-apple-ios and then \/setup-apns synchronously/);
  assert.match(orchestration.evals[27].expected_output, /No worker preflight or fallback exists/);
  assert.strictEqual(
    orchestration.evals[28].coverage,
    'cold-wif-identity-bootstrap-reapproval',
  );
  assert.match(orchestration.evals[28].expected_output, /null client ID/);
  assert.match(orchestration.evals[28].expected_output, /second explicit approval/);
  assert.match(orchestration.evals[28].expected_output, /never delegates MCP work to a background agent/);
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
  assert.match(deploy, /route to its bounded build owner/i);
  assert.match(deploy, /Android customer-signed direct-test APK: `\/build-android`/);
  assert.match(deploy, /`\/verify-android-push`/);
  assert.match(deploy, /Registered-device iOS development or ad-hoc IPA: `\/build-ios`/);
  assert.doesNotMatch(deploy, /native compile and manual device testing are user-owned/);
  assert.match(debug, /route user to `\/verify-ios-push`/);
  assert.match(debug, /Keep general Metro diagnostics here/);
  assert.match(readme, /\| `\/build-ios` \|/);
  assert.match(readme, /\| `\/verify-ios-push` \|/);
  assert.match(readme, /development and ad-hoc\s+registered-device IPA workflows/);
  assert.match(readme, /user directly manages signing; `\/build-ios` runs the confirmed Wrap\s+command/);
  assert.doesNotMatch(readme, /push-notifications-architecture-diagrams\.md/);
  assert.match(readme, /push-notifications\.md/);
  assert.match(readme, /navigation-link-contract\.md/);
  assert.match(agents, /35 skills \+ 5 agents/);
  assert.match(agents, /manual Apple Developer and Xcode guidance/);
  assert.match(agents, /user owns signing assets, registered devices/);
});

test('screen-planner navigation examples match the eight-column contract', () => {
  const planner = fs.readFileSync(
    path.join(PLUGIN_ROOT, 'agents/screen-planner.md'),
    'utf8',
  );
  const section = planner.match(
    /\| Route \| Destination ID \| Path params \| Query params \(UNION across all senders\) \| External params \| Requires auth \| Intent \| Returns to caller \|([\s\S]*?)\n\n### Shared Conventions/,
  );

  assert.ok(section, 'navigation-contract example table exists');
  const rows = section[1]
    .split('\n')
    .filter((line) => line.startsWith('| `/(app)/'));

  assert.ok(rows.length >= 7, 'navigation-contract example has representative rows');
  for (const row of rows) {
    assert.strictEqual(
      row.split('|').length - 2,
      8,
      `navigation-contract row has eight cells: ${row}`,
    );
  }
});

test('push docs require owner-bounded cloud orchestration', () => {
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

  assert.match(shared, /Owner-bounded push cloud architecture/i);
  assert.match(shared, /firebase-tools` \*\*15\.27\.0\*\*/);
  assert.match(shared, /15\.28\.1.*main\/unpublished/);
  assert.match(shared, /Azure MCP GA \*\*2\.0\.5\*\*/);
  assert.match(shared, /Firebase MCP required/);
  assert.match(shared, /Guarded Google Cloud CLI required for `\/setup-push-wif`/);
  assert.match(shared, /Azure MCP required for covered operations/);
  assert.match(shared, /role_assignment_list/);
  assert.match(shared, /secret values and are intentionally excluded/i);
  assert.match(shared, /RBAC mutations/);
  assert.match(shared, /Entra resource work/);
  assert.match(shared, /secret-safe writes/);
  assert.match(shared, /FlowAgent remains the Power Automate mutation path/);
  assert.match(shared, /Apple setup is manual and user-owned/);
  assert.match(shared, /Do not automate Apple\s+configuration, generate a proof contract, inspect signing assets/);
  assert.match(readme, /Push cloud setup is \*\*owner-bounded\*\*/);
  assert.match(readme, /No CLI fallback/);
  assert.match(readme, /Microsoft Learn MCP\/docs remain the authoritative\s+source/);
  assert.match(readme, /firebase-tools` \*\*15\.27\.0\*\*/);
  assert.match(readme, /Azure MCP GA \*\*2\.0\.5\*\*/);
  assert.match(readme, /subscription\/group\/RBAC read-back/i);
  assert.match(readme, /does not expose the `keyvault` namespace/i);
  assert.match(readme, /RBAC mutations/);
  assert.match(agents, /Push cloud setup uses the narrowest supported owner surface/);
  assert.match(agents, /firebase-tools` 15\.27\.0/);
  assert.match(agents, /Azure MCP GA 2\.0\.5/);
  assert.match(agents, /Google Cloud CLI/);
  assert.match(addPush, /vendor-official Firebase MCP\s+only/);
  assert.match(
    createFlow,
    /Do not fall\s+back to `firebase-tools`, `gcloud`, or cloud\s+provisioning from this skill/,
  );
  assert.match(verify, /consumes only previously validated owner-generated handoffs/i);
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
  assert.match(contract, /onNotificationOpenedApp.*getInitialNotification\(\).*once/s);
  assert.match(contract, /Expo.*foreground-local marker.*ignore unmarked Expo responses/is);
  assert.match(skill, /never call `getToken` before registration/);
  assert.match(skill, /never persist an FCM registration token/);
});
