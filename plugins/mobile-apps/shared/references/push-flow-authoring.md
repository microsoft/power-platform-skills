# Push flow authoring with FlowAgent

Canonical environment, connector discovery, definition authoring, mutation,
read-back, recovery, publication, and smoke-test workflow for the push producer
and plugin-managed sender, plus exact identity/state/observable-contract
read-back for a customer-owned Power Automate sender.

## Contents

1. [Bootstrap FlowAgent](#1-bootstrap-flowagent)
2. [Prove one environment](#2-prove-one-environment)
3. [Resolve handoffs and outbox metadata](#3-resolve-handoffs-and-outbox-metadata)
4. [Discover schemas and connections](#4-discover-schemas-and-connections)
5. [Author sender and producer definitions](#5-author-sender-and-producer-definitions)
6. [Validate, mutate, and read back](#6-validate-mutate-and-read-back)
7. [Recovery and publishing](#7-recovery-and-publishing)
8. [Smoke tests and handoff](#8-smoke-tests-and-handoff)

FlowAgent tool names below omit client prefixes. Claude Code exposes
`mcp__flowagent__<tool>` and Copilot CLI exposes `flowagent-<tool>`.

## 1. Bootstrap FlowAgent

If tools are missing, give these supported Copilot CLI steps exactly and stop:

```text
/plugin marketplace add microsoft/power-platform-skills
/plugin install power-automate@power-platform-skills
/restart
/setup
```

After restart/setup, require `/mcp` to show `flowagent` connected. If installed
but disconnected, rerun `/setup`, `/restart`, and `/mcp`. Never use guessed
definitions, portal automation, shell flow commands, or a cloned FlowAgent CLI.

## 2. Prove one environment

Run from the app root:

```bash
node "${PLUGIN_ROOT}/scripts/resolve-environment.js" \
  "$(node -e "console.log(require('./power.config.json').environmentId || '')")"
npx power-apps auth-status --json
az account show --query "{user:user.name,tenantId:tenantId}" -o json
pac auth who
```

The `npx power-apps`, `az`, `pac`, and FlowAgent auth stores are independent.
Prove that Power Apps uses the intended maker/tenant, `az` uses that tenant,
and `pac` reports the same tenant and target Dataverse URL. If `auth-status`
cannot prove tenant, perform a read-only Power Apps environment operation
against the target and stop rather than assuming. Never repair a Power Apps
CLI mismatch with `az account set`.

Call `resolve_environment` for `power.config.json.environmentId`,
`set_current_env` with that exact result, then `get_current_env`. Compare
environment ID, Dataverse URL, and tenant across config, resolver, Power Apps,
PAC, Azure, and FlowAgent. Show a compact source/value table. Stop before
Dataverse or flow mutation on any conflict or unproved value.

## 3. Resolve handoffs and outbox metadata

Read `memory-bank.md`, `native-app-plan.md`, active evaluated Firebase files,
and `sender-auth.json` when present. Active Android/iOS configs must name one
Firebase project and agree with the memory handoff. If at least one selected
native platform is valid and active, do not rerun `/setup-fcm`; otherwise route
there.

For plugin-managed sending, validate the handoff against the exact client
project:

```bash
node "${PLUGIN_ROOT}/scripts/validate-sender-auth-contract.js" \
  --project-root . --file sender-auth.json \
  --expected-firebase-project "<client-firebase-project-id>"
```

Exit `0` is required. Never salvage IDs from an expired, mismatched, symlinked,
path-escaping, mode-conflicted, or credential-bearing file. The owner skill
must repair it. A manual/customer-owned route has no plugin-managed
authentication handoff; create no `sender-auth.json` and no placeholder sender.
It still requires the safe operational sender handoff below.

For a customer-owned Power Automate sender, the customer must create and
operate it through their own process, then provide and approve recording its
**exact sender flow ID**. A display name, URL with an unproved ID, screenshot,
checkbox, or verbal "it works" is not a flow identity. Call `get_flow` with
that exact ID in the already-proved current environment and require the
returned ID to match exactly and live state to be `Started`. Stop on a missing,
stopped, unreadable, or different flow.

Read back only its observable, non-secret contract: queued-outbox
trigger/guard, idempotent claim, `allUsers` versus lowercase-OID routing, one
delivery invocation, and terminal `Sent`/`Failed` updates. Do not open secure
inputs/outputs, and do not request or inspect credentials, authentication
headers, tokens, connection secrets, endpoint secrets, or raw delivery bodies.
Do not run `sender-auth.json` validation, test or approve the customer's
authentication architecture, or convert this read-back into a plugin-
authentication claim. Retain the exact ID for the final producer publication
gate and downstream physical verification.

If the customer uses a non-Flow endpoint instead, record only a
customer-approved non-secret immutable endpoint identifier. Keep the
producer-only flow state distinct and report
`customer-owned non-Flow endpoint / plugin physical verification unavailable`;
FlowAgent cannot provide the exact sender-flow continuity required by plugin
physical verification.

Read `push-notification-outbox.md` and `.datamodel-manifest.json`. If the table
is absent, invoke `/add-dataverse --skip-planning`, then reread manifest and
live metadata. On `429`, requery metadata before retrying because creation may
already have succeeded.

Resolve from metadata, never pluralization guesses:

- outbox singular logical name and plural `EntitySetName`;
- logical columns and actual choice integers;
- producer source singular logical name and plural entity set;
- `systemuser` and plural `systemusers`.

Use `resolve_entity`, connector dynamic resolvers, and repository metadata
helpers. FlowAgent `list_tables` is not Dataverse metadata. `Push
Notification` is not a connector parameter.

Ask one grouped producer question: source event/filter, recipient rule, generic
title/body, internal deep link, requested artifacts, and whether created flows
remain stopped. Default to Dataverse row created. For owner-based delivery,
read `ownerid`, get the row from plural `systemusers`, GUID-validate
`azureactivedirectoryobjectid`, and lowercase it. A team owner, absent OID, or
ambiguity must skip/fail explicitly; never guess a topic.

## 4. Discover schemas and connections

For every trigger/action, use `get_connector` or `search_operations`, then
`get_operation_details`. Discover:

- Dataverse row-created/added-or-modified trigger;
- Dataverse get-row, add-row, and update-row;
- WIF Key Vault retrieval and all four HTTP actions; or
- the exact Entra-authenticated Function operation compatible with the
  validated endpoint URL, audience, and connection.

Use `resolve_params`, `resolve_refs`, and `invoke_operation` for dynamic values.
Never infer operation IDs, parameter names, enums, action types, API IDs,
connection references, or choice integers. Query Microsoft Learn when a
contract is unclear.

Use `list_connections`, `pick_or_create_connection`, and `test_connection`.
Require connected `Embedded` references for Dataverse and every selected-mode
connector. For WIF, the Key Vault connection principal—not the maker/sender
app—must have secret read access.

For Function mode, start from the handoff's exact
`functionEndpoint.connection.referenceName` and `.resourceId`, find/test that
connection, discover its operation, and require its exact endpoint and Entra
audience. Never substitute generic unauthenticated HTTP, another maker-owned
connection, pasted bearer tokens, or guessed operations. If not provable, stop
and return to `/setup-push-service-account`; do not fall back to WIF.

Verified Dataverse invariants:

| Surface | Contract |
|---|---|
| Trigger type | `OpenApiConnectionWebhook` |
| Trigger table | singular `entityname`, e.g. `new_note` |
| Action table | plural `entityName`, e.g. `new_notes` |
| Owner lookup | Get item from `systemusers`, then `azureactivedirectoryobjectid` |

Still discover each operation's remaining fields. Every definition declares
`$authentication` (`SecureObject`) and `$connections` (`Object`), uses
`Embedded` references, and omits `authentication` from action inputs.

## 5. Author sender and producer definitions

Create new flows stopped.

The sender triggers only when an outbox row enters `Queued`, guards against
self-retrigger, atomically transitions to `Sending`, increments Attempt Count,
and limits concurrency per row. It validates:

- `User`: GUID Target OID -> lowercase `message.topic`;
- `AllUsers`: empty Target OID -> exact case-sensitive `allUsers`.

Execute exactly one mode:

- **WIF:** follow `push-flow-wif.md` exactly.
- **Function endpoint:** invoke only the discovered secure operation/connection
  with `topic`, approved generic `title`/`body`, string `schemaVersion`,
  allowlisted `deepLink`, and `validateOnly:false`. Include no Key Vault,
  Entra/Google token exchange, impersonation, direct FCM, service-account JSON,
  generic HTTP, or fallback path.

On success update to `Sent` with bounded provider message ID and UTC Sent On.
On terminal failure update to `Failed` with bounded sanitized code/message.
Retry only transient `429`/`5xx` with bounded backoff. Mark all secret/token or
Function invocation inputs/outputs secure. Never diagnose with tokens, headers,
secret values, raw errors/responses, or outbox payloads. Omit optional
Dataverse fields instead of explicit `null` unless the discovered operation
supports clearing.

The producer uses the confirmed Dataverse webhook and singular trigger table,
resolves the recipient, and adds one row through the plural outbox entity set.
Set `Audience=User`, lowercase OID, generic privacy-safe Title/Body, allowlisted
internal Deep Link, Payload Version `1`, Status `Queued`, Attempt Count `0`.
Invalid recipients terminate without queuing and expose only a bounded reason.
Never place record text, names, email, confidential fields, tokens, or secrets
in the notification.

For the customer-owned route, FlowAgent authors only producer/outbox artifacts,
but downstream routing still requires the safe sender handoff from Section 3.
Do not discover customer authentication, create a placeholder/unauthenticated
sender, edit/publish their sender, or claim it is plugin-validated. Reuse only
the exact customer-supplied sender ID that already passed the safe read-back.

## 6. Validate, mutate, and read back

For **every** create, update, edit, copy, restore, publish, or disable:

1. `validate_flow` the complete candidate.
2. `preflight_flow`; resolve missing references and solution-wrap warnings.
3. Before updates, `preview_update` and inspect definition/action/reference
   changes.
4. Perform exactly one mutation.
5. Immediately `get_flow` and compare state, trigger type, singular/plural
   entity parameters, full action/run-after tree, logical connection-reference
   names, secure settings, selected mode, and every changed field.

WIF read-back must prove only Key Vault -> Entra -> STS -> impersonation -> FCM.
Function read-back must prove only the exact secure Function
operation/connection. Reject mixed trees even when the extra mode is reachable
only through failure handling. Customer-owned Power Automate mode has only
exact sender identity/environment/state and observable-contract read-back; do
not apply managed-mode authentication validation claims to it.

An acknowledged mutation is not persistence proof. If read-back differs, wait
once and reread; if still different, stop instead of stacking another edit.
Inspect full nesting and `runAfter`, not action counts. Publish performs
stricter Dataverse checks than validation/preflight.

## 7. Recovery and publishing

Before changing an existing flow, call `get_flow`, `list_backups`, and inspect
the latest `get_backup`. If no usable recovery point exists, `copy_flow` to a
clearly named stopped recovery flow and read it back.

Prefer `edit_flow` for surgical changes. Use `update_flow` only after
`preview_update` proves the complete definition/references. Never issue a
state-only `update_flow`; use `publish_flow` or `disable_flow`, then read back.
Reject solution-wrapped connection-reference drift.

If an incorrect definition persists, disable it and `restore_backup`, then
validate, preflight, and reread. Never delete a previously working flow as a
retry. If this invocation created an incorrect flow that has no prior backup,
use `disable_flow` when necessary and `get_flow` to prove it is
disabled/`Stopped`. Leave it stopped, report its exact ID and why it is unsafe,
and make cleanup explicitly user-owned. Do not perform destructive deletion;
retaining the stopped artifact preserves evidence and avoids cleanup on an
uncertain identity.

Present verified stopped IDs and a concise architecture/security summary.
Require explicit publish confirmation. Publish sender first and require
`Started` read-back, then producer and require `Started`. If publish reports
enabled but read-back remains stopped, stop.

For customer-owned Power Automate sending, never publish or mutate the sender. Immediately
before producer publication, call `get_flow` again with the exact recorded
sender ID and require the same ID in the proved environment with state
`Started`. Publish the producer only after that read-back, the customer's
operational statement under their own process, and explicit producer
publication approval. Read both exact IDs back afterward. Keep sender status
`customer-owned Power Automate sender / observable contract read back; authentication not plugin-validated`;
identity/observable-contract continuity does not validate credentials or
authentication design.

## 8. Smoke tests and handoff

Run non-delivery `smoke_test`/connection checks first. Do not create a live
outbox row until the user confirms a matching physical-device build,
notification consent, exact `allUsers` subscription, and permission for one
non-confidential test.

Then create one generic `allUsers` row with empty Target OID and an allowlisted
test deep link. Read it back; inspect `get_run_history`, `get_run_details`, and
`get_run_actions`; require `Sent` plus provider message ID. Preserve only
sanitized diagnostics and do not repeatedly resubmit. A user-targeted test
needs separate consent from that user. Manual mode smoke tests cover only
plugin-authored producer/outbox components.

Finish with environment ID/URL, Firebase project, managed-mode connections,
mutation read-backs, and whether delivery was skipped or verified. Report
producer/sender flow IDs/states for flow-backed senders; for a non-Flow
endpoint report only the producer ID/state, approved non-secret
`Sender endpoint identifier`, and exact blocked status. Never print secrets,
tokens, JWTs, Function bodies, or confidential payload data.

Write exactly one stable `Push flow handoff` schema to `memory-bank.md` after
the applicable read-backs succeed.

### Flow-backed handoff schema

Use for plugin-managed senders and customer-owned Power Automate senders:

- `Environment ID`
- `Dataverse URL`
- `Producer flow ID`
- `Producer flow state`
- `Sender flow ID`
- `Sender flow state`
- `Sender authentication status`
- `Flow read-back timestamp`

For a customer-owned Power Automate sender, both exact IDs must read back by ID
as `Started`, and the status is exactly
`customer-owned Power Automate sender / observable contract read back; authentication not plugin-validated`.
Do not add credentials, connection authentication details, endpoint secrets,
or an authentication-verification result. Downstream verification consumes
these exact IDs and rereads them through FlowAgent rather than selecting by
display name.

### Non-Flow blocked handoff schema

Use only these fields:

- `Environment ID`
- `Dataverse URL`
- `Producer flow ID`
- `Producer flow state`
- `Sender endpoint identifier`
- `Sender authentication status`
- `Flow read-back timestamp`

The endpoint identifier must be customer-approved, immutable, and non-secret.
The status is exactly
`customer-owned non-Flow endpoint / plugin physical verification unavailable`.
Do not include `Sender flow ID` or `Sender flow state`, even as empty or
`not applicable` values: no sender flow exists to read back. This schema
records the producer and blocked routing state; it is not a physical-
verification handoff.
