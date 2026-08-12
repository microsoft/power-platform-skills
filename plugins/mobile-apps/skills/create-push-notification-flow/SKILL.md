---
name: create-push-notification-flow
description: Use when creating, repairing, or extending the Power Automate producer and sender flows for Power Apps mobile push notifications, including Dataverse row-created triggers, outbox queuing, lowercase Entra OID topics, keyless Google WIF, FCM HTTP v1, FlowAgent setup, or push-flow smoke tests.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, Skill, mcp__flowagent__list_environments, mcp__flowagent__set_current_env, mcp__flowagent__get_current_env, mcp__flowagent__resolve_environment, mcp__flowagent__list_flows, mcp__flowagent__get_flow, mcp__flowagent__create_flow, mcp__flowagent__update_flow, mcp__flowagent__edit_flow, mcp__flowagent__copy_flow, mcp__flowagent__publish_flow, mcp__flowagent__disable_flow, mcp__flowagent__delete_flow, mcp__flowagent__list_connections, mcp__flowagent__test_connection, mcp__flowagent__list_connectors, mcp__flowagent__get_connector, mcp__flowagent__search_operations, mcp__flowagent__get_operation_details, mcp__flowagent__pick_or_create_connection, mcp__flowagent__resolve_entity, mcp__flowagent__resolve_refs, mcp__flowagent__resolve_params, mcp__flowagent__validate_flow, mcp__flowagent__preflight_flow, mcp__flowagent__preview_update, mcp__flowagent__smoke_test, mcp__flowagent__run_flow, mcp__flowagent__get_run_history, mcp__flowagent__get_run_details, mcp__flowagent__get_run_actions, mcp__flowagent__get_expression_help, mcp__flowagent__invoke_operation, mcp__flowagent__get_flow_context, mcp__flowagent__set_current_flow, mcp__flowagent__clear_current_flow, mcp__flowagent__list_backups, mcp__flowagent__get_backup, mcp__flowagent__restore_backup
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Outbox schema: [push-notification-outbox.md](${PLUGIN_ROOT}/shared/references/push-notification-outbox.md)**.

**Keyless sender protocol: [push-flow-wif.md](${PLUGIN_ROOT}/shared/references/push-flow-wif.md)**.

# Create Push Notification Flow

Create two separate cloud flows through FlowAgent:

1. A **producer** that reacts to the app event, resolves the recipient, and
   writes a privacy-safe `Queued` row to the push outbox.
2. A **sender** that owns delivery, idempotency, WIF token exchange, FCM HTTP
   v1, and the outbox transition to `Sent` or `Failed`.

Do not put FCM authorization in each business-event flow. Do not hand-author
connector schemas or use shell commands for flow operations when FlowAgent MCP
tools are available.

FlowAgent tools are named below without a client prefix. Claude Code exposes
them as `mcp__flowagent__<tool>` and Copilot CLI as `flowagent-<tool>`.

## Workflow

1. Bootstrap FlowAgent -> 2. Prove one environment -> 3. Ensure the outbox ->
4. Prove WIF -> 5. Configure the producer -> 6. Discover schemas/connections ->
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
independent; changing one does not change another.

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

## 3. Ensure and resolve the outbox

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

## 4. Invoke the WIF owner skill

Invoke `/setup-push-wif` before authoring the sender. It owns Entra, Key Vault,
Google IAM/WIF, and the non-delivery `validateOnly` FCM proof.

Continue only after it proves the complete chain:

`Key Vault secret -> Entra JWT -> Google STS -> service-account impersonation -> FCM validateOnly`

Use the observed JWT claims returned by that skill. Do not assume a v2 issuer or
an `azp` claim: a verified working token may use the `sts.windows.net` issuer
and `appid`. Never weaken the provider to tenant-only trust, embed a secret in
the flow, create a Google service-account key, or substitute a fixed token.

## 5. Ask for producer configuration

Ask one grouped question covering:

- source table/event and optional trigger filter;
- recipient rule;
- generic notification title/body;
- internal deep-link route;
- whether both flows may be created now and whether they should remain stopped.

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
- Azure Key Vault secret retrieval;
- HTTP actions used by the four WIF/FCM requests.

Use `resolve_params`, `resolve_refs`, and `invoke_operation` for dynamic values.
Never infer an operation ID, parameter name, enum, action type, API ID,
connection reference, or choice integer.

Use `list_connections`, `pick_or_create_connection`, and `test_connection`.
Require connected Embedded references for Dataverse, Key Vault, and any HTTP
connector returned by discovery. The Key Vault connection principal—not the
maker or sender app—must have secret read access.

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

Build a stopped, idempotent sender:

1. Trigger on an outbox row entering `Queued`. Use a trigger filter or an
   immediate guard so updates made by the sender cannot retrigger delivery.
2. Validate required fields and atomically move the row to `Sending`; increment
   Attempt Count. Limit concurrency per row to prevent duplicate sends.
3. For `User`, require a GUID Target OID and use
   `toLower(<validated-target-oid>)` as `message.topic`. For `AllUsers`, require
   an empty Target OID and use exact case-sensitive `allUsers`.
4. Retrieve the Entra client credential with secure inputs/outputs.
5. Perform the Entra token, Google STS, IAM Credentials impersonation, and FCM
   calls exactly as specified by `push-flow-wif.md`.
6. Send only string-valued `data.schemaVersion` and `data.deepLink`, plus the
   approved generic notification title/body and discovered Android/APNs fields.
7. On success, update the row to `Sent` with the bounded provider message ID and
   UTC Sent On.
8. On terminal failure, update it to `Failed` with bounded sanitized error code
   and message. Retry only transient `429`/`5xx` responses with bounded backoff.

Mark secure inputs/outputs on secret retrieval, every token exchange, and every
authorized HTTP action. Never copy token responses, headers, secret values, raw
connector errors, or outbox payloads into diagnostics.

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
   secure settings, and all changed fields with the candidate.

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

## 11. Gate smoke tests

First run `smoke_test`/connection checks that do not deliver a notification.
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

Finish with flow IDs/states, environment ID/URL, connections used, WIF proof
timestamp, mutation read-back results, and whether delivery was skipped or
verified. Never print secrets, tokens, raw JWTs, or confidential payload data.
