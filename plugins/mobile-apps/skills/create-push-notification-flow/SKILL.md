---
name: create-push-notification-flow
description: Use when creating, repairing, or extending the Power Automate producer and sender flows for Power Apps mobile push notifications, including choosing between recommended WIF, managed Azure Function compatibility, or customer-owned manual sender authentication; Dataverse row-created triggers; outbox queuing; lowercase Entra OID topics; FCM HTTP v1; FlowAgent setup; or push-flow smoke tests.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, Skill, mcp__flowagent__list_environments, mcp__flowagent__set_current_env, mcp__flowagent__get_current_env, mcp__flowagent__resolve_environment, mcp__flowagent__list_flows, mcp__flowagent__get_flow, mcp__flowagent__create_flow, mcp__flowagent__update_flow, mcp__flowagent__edit_flow, mcp__flowagent__copy_flow, mcp__flowagent__publish_flow, mcp__flowagent__disable_flow, mcp__flowagent__delete_flow, mcp__flowagent__list_connections, mcp__flowagent__test_connection, mcp__flowagent__list_connectors, mcp__flowagent__get_connector, mcp__flowagent__search_operations, mcp__flowagent__get_operation_details, mcp__flowagent__pick_or_create_connection, mcp__flowagent__resolve_entity, mcp__flowagent__resolve_refs, mcp__flowagent__resolve_params, mcp__flowagent__validate_flow, mcp__flowagent__preflight_flow, mcp__flowagent__preview_update, mcp__flowagent__smoke_test, mcp__flowagent__run_flow, mcp__flowagent__get_run_history, mcp__flowagent__get_run_details, mcp__flowagent__get_run_actions, mcp__flowagent__get_expression_help, mcp__flowagent__invoke_operation, mcp__flowagent__get_flow_context, mcp__flowagent__set_current_flow, mcp__flowagent__clear_current_flow, mcp__flowagent__list_backups, mcp__flowagent__get_backup, mcp__flowagent__restore_backup
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Outbox schema: [push-notification-outbox.md](${PLUGIN_ROOT}/shared/references/push-notification-outbox.md)**.

**Keyless sender protocol: [push-flow-wif.md](${PLUGIN_ROOT}/shared/references/push-flow-wif.md)**.

**Sender-auth handoff: [sender-auth-contract.md](${PLUGIN_ROOT}/shared/references/sender-auth-contract.md)**.

**Sender-auth choices: [push-sender-auth-options.md](${PLUGIN_ROOT}/shared/references/push-sender-auth-options.md)**.

**Function sender protocol: [function-endpoint.md](${PLUGIN_ROOT}/skills/setup-push-service-account/references/function-endpoint.md)**.

# Create Push Notification Flow

For a plugin-managed sender, create two separate cloud flows through FlowAgent:

1. A **producer** that reacts to the app event, resolves the recipient, and
   writes a privacy-safe `Queued` row to the push outbox.
2. A **sender** that owns delivery, idempotency, WIF token exchange, FCM HTTP
   v1, and the outbox transition to `Sent` or `Failed`; or invokes one validated
   Entra-protected Function that owns Google authentication and FCM.

For manual/customer-owned authentication, the plugin may create only the
producer/outbox portion. The customer authors and operates the sender.

Do not put FCM authorization in each business-event flow. Do not hand-author
connector schemas or use shell commands for flow operations when FlowAgent MCP
tools are available.

For plugin-managed sender authoring, select exactly one sender-auth mode from a
fresh validated project-local `sender-auth.json`. Never add a second mode as a
fallback, migration branch, or failure handler. A customer may instead choose
manual/customer-owned sender authentication; that route has no plugin-managed
handoff and must not be represented as a validated sender mode.

This skill consumes the validated Firebase/client and sender-auth handoffs
produced by the official MCP-first owner skills. `/setup-fcm` owns Firebase
through the vendor-official Firebase MCP only; `/setup-push-wif` owns
Google-side WIF provisioning through gcloud MCP, and
`/setup-push-service-account` owns the Azure compatibility path. Do not
recreate that work here with CLI fallbacks.

FlowAgent tools are named below without a client prefix. Claude Code exposes
them as `mcp__flowagent__<tool>` and Copilot CLI as `flowagent-<tool>`.

## Workflow

1. Bootstrap FlowAgent -> 2. Prove one environment -> 3. Prove Firebase/client
and sender-auth consistency -> 4. Ensure the outbox -> 5. Configure the producer
-> 6. Discover schemas/connections ->
7. Author the stopped sender -> 8. Author the stopped producer ->
9. Verify every mutation -> 10. Confirm publish -> 11. Gate smoke tests

## 1. Bootstrap FlowAgent exactly

If FlowAgent tools are missing, give these supported Copilot CLI steps in this
exact order and stop:

```text
/plugin marketplace add microsoft/power-platform-skills
/plugin install power-automate@power-platform-skills
/restart
/setup
```

After restart/setup, require `/mcp` to show `flowagent` as connected. If the
plugin is installed but `/mcp` shows disconnected, rerun `/setup`, then
`/restart`, and check `/mcp` again. Do not proceed using guessed definitions,
Power Automate portal automation, or a locally cloned FlowAgent CLI.

## 2. Prove environment and identity consistency

Run from the app root containing `power.config.json`. Read its
`environmentId`, then resolve it with:

```bash
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" \
  "$(node -e "console.log(require('./power.config.json').environmentId || '')")"
npx power-apps auth-status --json
az account show --query "{user:user.name,tenantId:tenantId}" -o json
pac auth who
```

Treat the resolved environment ID, Dataverse URL, and tenant ID as the expected
target. The auth stores for `npx power-apps`, `az`, `pac`, and FlowAgent are
independent; changing one does not change another. In this skill, `az` is a
narrow local identity check only — Azure resource provisioning stays in the
Azure MCP owner skills.

1. Verify the active `npx power-apps` account is the intended maker and belongs
   to the resolved tenant. Compare the tenant/home-account information returned
   by `auth-status --json`; if that output cannot prove the tenant, run a
   read-only `npx power-apps` environment operation against the project target
   and stop rather than assuming.
2. Verify `az account show.tenantId` equals the resolved tenant. Switch/login
   explicitly if it does not.
3. Verify `pac auth who` reports the same tenant and target environment URL.
   Correct its independent profile before continuing.
4. Call `resolve_environment` for the `power.config.json` environment ID, then
   `set_current_env` with the resolved FlowAgent environment.
5. Call `get_current_env` and compare its environment ID and Dataverse URL with
   `power.config.json` and the resolver output.

Show a compact comparison for `power.config.json`, `npx power-apps`, `pac`,
`az`, and FlowAgent (`source`, environment, URL, tenant/user).
Stop before any Dataverse or flow mutation when a value conflicts or cannot be
proved. Never repair a Power Apps CLI mismatch with `az account set`.

## 3. Prove Firebase client and sender-auth consistency

Read `memory-bank.md`, `sender-auth.json` when present, and the active native
Firebase client configuration. Do not rerun `/setup-fcm` merely because this
flow skill was invoked.

Determine the expected Firebase project from the already-integrated client:

1. Inspect only active project-local native client configuration:
   `firebase/google-services.json` and/or
   `firebase/GoogleService-Info.plist`, including evaluated
   `npx expo config --type public --json` service-file paths.
2. Require every active Android/iOS client configuration to name the same
   Firebase project. Compare it with the Firebase project recorded in
   `memory-bank.md` when present. A disagreement is a blocker; never choose one
   platform as authoritative.
3. If at least one selected native platform is already configured and the
   evaluated Expo config activates it, accept that existing client integration.
   Do not invoke `/setup-fcm` again.
4. If no selected native platform has valid active Firebase client
   configuration, route to `/setup-fcm` and return only after it completes.

Next inspect whether a project-local regular `sender-auth.json` exists. When it
does, validate it against that exact client project:

```bash
node "${PLUGIN_ROOT}/scripts/validate-sender-auth-contract.js" \
  --project-root . \
  --file sender-auth.json \
  --expected-firebase-project "<client-firebase-project-id>"
```

Exit `0` is required before any **plugin-managed** sender discovery or
authoring. Treat an expired
proof, project mismatch, mode conflict, symlink, path escape, or forbidden
credential field as invalid; do not salvage safe-looking IDs from an invalid
handoff.

If the handoff is absent or invalid, read the sender-auth choices reference,
show its three-option comparison, and ask the customer to choose. WIF is marked
**Recommended**, but selection must stay explicit because the options have
different infrastructure, licensing, credential, and operating costs.

1. **Workload Identity Federation (Recommended):** invoke `/setup-push-wif`
   for provision/reuse/repair.
2. **Managed Azure Function compatibility:** invoke
   `/setup-push-service-account`. Use its validate/reuse path for an existing
   supported endpoint, or scaffold/deploy only when the customer already
   possesses the Firebase service-account JSON. That skill must never create
   or download the key.
3. **Manual/customer-owned sender authentication:** do not invoke or create a
   setup skill, do not ask for credentials, and do not create a manual
   `sender-auth.json`. Explain the completion contract and allow the customer
   to configure the Power Automate sender authentication/actions or their own
   endpoint independently.

After the owner skill returns, rerun the validator with the same expected
Firebase project. Do not translate one managed mode into another, construct a
managed handoff inside this skill, or author a managed sender until validation
succeeds. Record the validated mode, Firebase project, safe
connection/resource identifiers, verifier, and proof timestamp; never record
credentials or proof response bodies. Do not fall back to `firebase-tools`,
`gcloud`, or Azure provisioning from this skill.

For the manual route, offer to continue with the producer and outbox only. The
customer owns sender authentication, delivery actions, technical validation,
publication, monitoring, and support. Record only
`customer-owned / not plugin-validated` in `memory-bank.md`; do not record
credentials, arbitrary endpoint details, or a success-shaped proof. Stop before
plugin sender discovery/authoring and give the completion checklist from the
sender-auth choices reference. A checkbox or verbal confirmation cannot promote
this route to plugin-validated or publish-ready.

## 4. Ensure and resolve the outbox

Read `native-app-plan.md`, `.datamodel-manifest.json`, and the outbox reference.
If the table is absent, invoke `/add-dataverse --skip-planning`, then read the
manifest and live metadata back before continuing. If provisioning reports
`429`, re-query metadata before retrying: the initial create may have succeeded,
and a blind retry can fail as a duplicate.

Resolve and record from metadata, never pluralization guesses:

- the outbox singular logical name, used by Dataverse triggers;
- the outbox plural `EntitySetName`, used by Dataverse actions;
- logical column names and actual choice integer values;
- the producer source table's singular logical name and plural entity set;
- `systemuser` singular name and `systemusers` entity set for owner resolution.

Use `resolve_entity`, Dataverse connector dynamic resolvers, and the repository
Dataverse metadata helper where needed. FlowAgent `list_tables` is for tabular
connector datasets such as SharePoint/SQL/Excel, not Dataverse metadata. The
display name `Push Notification` is not a connector parameter.

## 5. Ask for producer configuration

Ask one grouped question covering:

- source table/event and optional trigger filter;
- recipient rule;
- generic notification title/body;
- internal deep-link route;
- for a managed mode, whether both flows may be created now and whether they
  should remain stopped;
- for the manual route, whether the plugin should create only the producer and
  outbox while the customer implements the sender independently.

Default to **Dataverse row created** when the user does not specify a trigger.
For a user/team-owned source row, default recipient resolution is:

1. Read the row's `ownerid` Dataverse GUID.
2. Get that `systemuser` row using the **plural** `systemusers` action entity
   set.
3. Read and GUID-validate `azureactivedirectoryobjectid`.
4. Lowercase the validated OID before writing `Target OID`.

`ownerid` is not an Entra OID. If the owner is a team, the OID is absent, or the
recipient rule is ambiguous, route to an explicit skip/failure branch; never
send to a guessed topic. If the user explicitly declines a producer, create
only the sender and record that business events still need to queue outbox rows.

## 6. Discover exact schemas and connections

For every trigger/action, use `get_connector` or `search_operations`, followed
by `get_operation_details`. Discover at minimum:

- Microsoft Dataverse row-created/row-added-or-modified trigger;
- Dataverse get-row, add-row, and update-row operations;
- for `wif`: Azure Key Vault secret retrieval and the HTTP actions used by the
  four WIF/FCM requests;
- for `function-endpoint`: the exact Entra-authenticated HTTP
  operation/connector compatible with `functionEndpoint.endpointUrl` and
  `functionEndpoint.entra.resourceAudience`.

Manual/customer-owned sender authentication is outside this discovery step.
Do not discover, infer, or author the customer's authentication connector,
generic HTTP action, endpoint schema, or credentials.

Use `resolve_params`, `resolve_refs`, and `invoke_operation` for dynamic values.
Never infer an operation ID, parameter name, enum, action type, API ID,
connection reference, or choice integer.

If a Dataverse, Power Automate, Entra, or Key Vault contract is unclear, query
Microsoft Learn per `shared/shared-instructions.md` before guessing.

Use `list_connections`, `pick_or_create_connection`, and `test_connection`.
Require connected Embedded references for Dataverse and every mode-specific
connector. For `wif`, require Key Vault and any HTTP connector returned by
discovery; the Key Vault connection principal—not the maker or sender app—must
have secret read access.

For `function-endpoint`, start from the handoff's exact
`functionEndpoint.connection.referenceName` and `.resourceId`. Find that live
connection, test it, discover the operation through `search_operations`, and
read its schema with `get_operation_details`. Require an operation that uses the
handoff endpoint and Entra audience with that exact connection. Do not replace
it with a generic unauthenticated HTTP action, another connection owned by the
maker, a pasted bearer token, or a guessed operation ID. If FlowAgent cannot
discover and prove the exact connection/operation, stop and return to
`/setup-push-service-account`; do not fall back to WIF authoring.

The following Dataverse contracts were verified and override tempting guesses:

| Surface | Exact contract |
| --- | --- |
| Connector trigger type | `OpenApiConnectionWebhook` |
| Trigger table parameter | `entityname` = **singular logical name**, e.g. `new_note` |
| Dataverse action table parameter | `entityName` = **plural EntitySetName**, e.g. `new_notes` |
| Owner lookup | Get item from `systemusers`, then read `azureactivedirectoryobjectid` |

Still call `get_operation_details`: it supplies all other fields and confirms
the operation-specific schema.

Every definition declares `$authentication` (`SecureObject`) and `$connections`
(`Object`), uses `Embedded` connection references, and omits `authentication`
from action inputs.

## 7. Author the sender flow

Skip this section for the manual/customer-owned route. The plugin may author the
producer/outbox independently, but it must not create a placeholder,
unauthenticated HTTP action, guessed custom-connector action, mixed-mode
fallback, or publish-ready sender shell for the customer to fill with secrets.

Build a stopped, idempotent sender:

1. Trigger on an outbox row entering `Queued`. Use a trigger filter or an
   immediate guard so updates made by the sender cannot retrigger delivery.
2. Validate required fields and atomically move the row to `Sending`; increment
   Attempt Count. Limit concurrency per row to prevent duplicate sends.
3. For `User`, require a GUID Target OID and use
   `toLower(<validated-target-oid>)` as `message.topic`. For `AllUsers`, require
   an empty Target OID and use exact case-sensitive `allUsers`.
4. Execute exactly one mode-specific delivery branch:
   - **`wif`:** retrieve the referenced Entra client credential from Key Vault,
     then perform Entra client credentials -> Google STS -> sender
     service-account impersonation -> FCM HTTP v1 exactly as specified by
     `push-flow-wif.md`. Derive every resource from the validated handoff and
     preserve the observed `appid`/`azp` claim contract.
   - **`function-endpoint`:** invoke only the exact FlowAgent-discovered,
     Entra-authenticated operation and connection proven in Step 6. Send the
     Function's strict request contract (`topic`, approved generic
     `title`/`body`, string `schemaVersion`, allowlisted `deepLink`, and
     `validateOnly: false`). The Function owns Key Vault, Google credential
     minting, and FCM; the flow must contain no Key Vault retrieval, Entra ->
     Google STS exchange, service-account impersonation, direct FCM HTTP action,
     service-account JSON, or alternate/fallback sender path.
5. Preserve the privacy-safe payload contract in either mode. For `wif`, send
   only string-valued `data.schemaVersion` and `data.deepLink`, the approved
   generic notification title/body, and discovered Android/APNs fields. For
   `function-endpoint`, send only the Function's strict allowlisted request
   fields; do not append connector metadata or direct-FCM platform fields.
6. On success, update the row to `Sent` with the bounded provider message ID and
   UTC Sent On.
7. On terminal failure, update it to `Failed` with bounded sanitized error code
   and message. Retry only transient `429`/`5xx` responses with bounded backoff.

For `wif`, mark secure inputs/outputs on secret retrieval, every token exchange,
service-account impersonation, and authorized FCM action. For
`function-endpoint`, mark secure inputs/outputs on the Function invocation and
retain only the handoff's exact connection reference. In both modes, never copy
token responses, headers, secret values, Function/connector response bodies,
raw connector errors, or outbox payloads into diagnostics.

Do not include explicit `null` fields merely to clear optional Dataverse
columns. The service can reject explicit nulls even after local validation.
Omit unchanged/empty optional fields unless the discovered operation schema
provides a supported clear operation.

## 8. Author the producer flow

Build a separate stopped producer using the confirmed configuration:

1. Use the discovered Dataverse trigger with type
   `OpenApiConnectionWebhook` and singular trigger `entityname`.
2. Resolve the recipient. For the default owner rule, call the Dataverse
   get-row action with plural `entityName: systemusers`.
3. Validate `azureactivedirectoryobjectid`, lowercase it, and create one outbox
   row using the outbox's plural action `entityName`.
4. Set Audience `User`, the lowercase Target OID, privacy-safe Title/Body,
   allowlisted internal Deep Link, Payload Version `1`, Status `Queued`, and
   Attempt Count `0`.
5. If recipient validation fails, terminate without queuing and expose only a
   bounded operational reason.

The producer payload must be generic—for example, “You have a new note.” Do not
copy note text, titles, customer names, email addresses, confidential record
fields, access tokens, or secrets. OID topics are routing convenience, not an
authorization boundary, so payloads must remain safe if topic membership is
spoofed.

## 9. Validate, preflight, mutate, and read back

Apply this loop to **every** create, update, edit, copy, restore, publish, or
disable operation:

1. `validate_flow` against the complete candidate definition.
2. `preflight_flow`; resolve missing references and solution-wrap warnings.
3. For updates, call `preview_update` and inspect structural/action/ref changes.
4. Perform exactly one mutation.
5. Immediately call `get_flow` and compare state, trigger type, singular/plural
   entity parameters, action tree/run-after structure, connection references,
   secure settings, selected sender-auth mode, and all changed fields with the
   candidate.

Mode-specific read-back is a hard gate:

- `wif` must contain the Key Vault -> Entra -> STS -> impersonation -> FCM
  action tree, its secure settings, and only its required mode connections. It
  must not contain a Function invocation/connection.
- `function-endpoint` must contain the exact discovered secure Function
  operation/connection and no Key Vault, Google token, impersonation, direct
  FCM, generic HTTP, or WIF fallback actions/connections.
- `customer-owned` is not a plugin-managed mode and has no sender read-back
  claim. Only independently authored producer/outbox work may be reported; the
  sender remains `customer-owned / not plugin-validated`.

A valid action from one mode does not compensate for a missing or insecure
action in the other. Reject mixed trees even when the fallback is reachable
only through `runAfter` failure handling.

An acknowledged create/update/publish response is not proof of persistence.
If read-back differs, wait once for propagation and read again. If it still
differs, stop and report the mutation as failed; do not stack another edit on
an unverified base. Validation/preflight are also not proof that publishing
will pass—the publish path performs stricter Dataverse metadata checks.

Malformed definitions can accidentally nest all actions under a trigger or
scope. Inspect the full read-back action tree and every `runAfter`; do not rely
only on action counts.

## 10. Recovery, backup, and publishing

- Create new flows in `Stopped` state and read them back before any publish.
- Before changing an existing flow, call `get_flow` and `list_backups`. Inspect
  the latest backup with `get_backup`; if no usable recovery point exists,
  make a clearly named stopped recovery copy with `copy_flow` and read it back.
- Prefer `edit_flow` for a small surgical change. Use `update_flow` only after
  `preview_update` confirms the complete definition and references.
- Never issue a state-only `update_flow`; a known null-definition path can
  reject or corrupt it. Use `publish_flow`/`disable_flow`, then `get_flow`.
- Preflight and read-back must compare logical connection-reference names.
  Solution wrapping can rewrite them; do not publish a wrapped definition whose
  references no longer match the connected Embedded references.
- If a mutation persists an incorrect definition, stop the flow and use
  `restore_backup`, then validate/preflight/read back the restored flow.
- Never delete a previously working flow as a retry strategy. Delete only an
  empty/incorrect flow created by this invocation, after confirming it is
  stopped, a verified replacement or backup exists, and the user approves.

Present both verified stopped flow IDs and a concise architecture/security
summary. Ask for explicit confirmation before publishing either flow. Publish
the sender first, read it back as `Started`, then publish the producer and read
it back. If `publish_flow` says enabled but `get_flow` remains `Stopped`, stop;
do not work around it with an unreviewed replacement.

For the manual/customer-owned route, present only plugin-authored
producer/outbox artifacts. The plugin must not publish, enable, edit, or claim
read-back ownership of the customer's sender. Publish the producer only after
the customer confirms their independently implemented sender is ready under
their own process and explicitly approves producer publication; retain the
sender status as `customer-owned / not plugin-validated`.

## 11. Gate smoke tests

First run `smoke_test`/connection checks that do not deliver a notification.
For the manual route, these checks cover only plugin-authored producer/outbox
components. The customer owns non-delivery testing of their sender, and the
plugin must not convert customer attestation into a plugin validation result.
Do not create a live outbox row until the user confirms:

1. a matching physical-device build is installed;
2. notification consent is enabled;
3. the device is subscribed to exact `allUsers`; and
4. a non-confidential test notification may be sent now.

After confirmation, create one generic `allUsers` row with no Target OID and an
allowlisted test deep link. Read the row back, inspect `get_run_history`,
`get_run_details`, and `get_run_actions`, then require the outbox to reach
`Sent` with a provider message ID. On failure, preserve sanitized diagnostics
and do not resubmit repeatedly. User-targeted smoke tests require separate
explicit confirmation from the consenting target user.

Finish with flow IDs/states, environment ID/URL, Firebase project, validated
managed sender-auth mode/verifier/proof timestamp or the exact
`customer-owned / not plugin-validated` status, mode-specific connections used
only for managed modes, mutation read-back results, and whether delivery was
skipped or verified. Never print secrets, tokens, raw JWTs, Function response
bodies, or confidential payload data.

For the prescribed iOS push chain, published-and-read-back flows hand off to
`/build-ios`, which consumes the fresh `/setup-apple-ios` provisioning
contract and secure retained-keychain proof. After the exact IPA is installed,
hand off to `/verify-ios-push`; do not treat flow smoke-test acceptance as
physical delivery.
