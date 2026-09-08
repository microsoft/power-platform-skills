# Push flow authoring with FlowAgent

Canonical environment, connector discovery, definition authoring, mutation,
read-back, recovery, publication, and smoke-test workflow for the push producer
and sender. Sender authentication is either plugin-managed WIF or configured
manually by the customer in the plugin-created Power Automate sender.

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

The mobile plugin does not automatically install the separate
`power-automate@power-platform-skills` plugin. If FlowAgent tools are missing,
give these supported Copilot CLI setup steps exactly and stop:

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
must repair it. A manual-auth route has no plugin-managed authentication handoff; create no
`sender-auth.json`. It still creates a real stopped sender definition, but its
FCM authentication remains intentionally incomplete until the customer
configures it.

For manual authentication, retain the exact sender PPAPI/FlowAgent runtime
resource ID created by this workflow. After the customer configures FCM
authentication and asks to resume, call `get_flow` with that exact runtime
resource ID in the already-proved current environment. A display name, screenshot, checkbox, or verbal "it works" is not a flow identity.

Treat the flow's two IDs as separate roles:

- **PPAPI/FlowAgent runtime resource ID**: the ID used with `get_flow`,
  validation, mutation, publication, run-history tools, and the exact GUID
  stored in `callbackregistration.name`.
- **Dataverse Workflow (Process) ID**: the `workflowid` used to read the
  Workflow row and correlate `Callback Registration Expander` async jobs.

Record and use both IDs for both producer and sender. Never substitute one for
the other, and never require them to be equal. Equality, when observed, is not
the identity proof; using each ID against its owning surface is.

Read back only its observable, non-secret contract: queued-outbox
trigger/guard, idempotent claim, `allUsers` versus lowercase-OID routing, one
delivery invocation, and terminal `Sent`/`Failed` updates. Do not open secure
inputs/outputs, and do not request or inspect credentials, authentication
headers, tokens, connection secrets, endpoint secrets, or raw delivery bodies.
Do not run `sender-auth.json` validation, test or approve the customer's
authentication architecture, or convert this read-back into a plugin-
authentication claim. Retain the exact ID for the final producer publication
gate and downstream physical verification.

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

Ask one grouped producer question:

- source Dataverse table, event, and optional filter;
- recipient rule;
- title and body templates;
- additional data payload fields;
- suggested internal navigation;
- requested artifacts; and
- whether created flows remain stopped.

Before asking for content mappings, explain that title/body may appear on a
lock screen and all data fields reach the device. Explain that topic membership
is not authorization and recommend minimizing personal, confidential, or
regulated data. The user chooses the business content. Do not reject it solely
on privacy grounds after explicit selection. Always reject credentials,
tokens, private keys, authorization headers, and secret values.

For navigation, inspect `native-app-plan.md` and the generated destination
registry. Based on the trigger table, suggest a detail screen backed by that
table and map the trigger row ID when possible; otherwise suggest a list screen
for that table; otherwise suggest no deep link. Ask the user to accept the
suggestion, choose another registered destination, or choose no deep link.

Default to Dataverse row created. For owner-based delivery, read `ownerid`, get
the row from plural `systemusers`, GUID-validate
`azureactivedirectoryobjectid`, and lowercase it. A team owner, absent OID, or
ambiguity must skip/fail explicitly; never guess a topic.

Lookup target shape is part of discovery. A fixed single-target lookup, such as
a custom lookup whose metadata target is only `systemuser`, must use its GUID
value directly and must not require the optional
`@Microsoft.Dynamics.CRM.lookuplogicalname` annotation. A polymorphic lookup,
such as `ownerid`, may use that annotation to distinguish valid target types.
Do not copy a polymorphic guard onto a fixed-target lookup.

## 4. Discover schemas and connections

For every trigger/action, use `get_connector` or `search_operations`, then
`get_operation_details`. Discover:

- Dataverse row-created/added-or-modified trigger;
- Dataverse get-row, add-row, and update-row;
- WIF Key Vault retrieval and all four HTTP actions; or
- the FCM HTTP action shape whose authentication the customer will configure.

Use `resolve_params`, `resolve_refs`, and `invoke_operation` for dynamic values.
Never infer operation IDs, parameter names, enums, action types, API IDs,
connection references, or choice integers. Query Microsoft Learn when a
contract is unclear.

Use `list_connections`, `pick_or_create_connection`, and `test_connection`.
Require connected `Embedded` references for Dataverse and every selected-mode
connector. For WIF, the Key Vault connection principal—not the maker/sender
app—must have secret read access.

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
- **Customer-configured FCM authentication:** author the same FCM HTTP request,
  topic, payload, idempotency, and terminal update structure, but leave the
  action authentication unconfigured. Mark the flow incomplete and stopped.
  Do not insert a fake connection, placeholder token, service-account key,
  custom endpoint, Azure Function, or fallback branch.

On success update to `Sent` with bounded provider message ID and UTC Sent On.
On terminal failure update to `Failed` with bounded sanitized code/message.
Retry only transient `429`/`5xx` with bounded backoff. Mark all secret/token or
Function invocation inputs/outputs secure. Never diagnose with tokens, headers,
secret values, raw errors/responses, or outbox payloads. Omit optional
Dataverse fields instead of explicit `null` unless the discovered operation
supports clearing.

The producer uses the confirmed Dataverse webhook and singular trigger table,
resolves the recipient, and adds one row through the plural outbox entity set.
Set `Audience=User`, lowercase OID, user-approved Title/Body, canonical
Additional Data, optional allowlisted Destination/Navigation Parameters,
Payload Version `1`, Status `Queued`, and Attempt Count `0`. Additional Data
must be a flat string map and cannot override `schemaVersion`, `destination`,
`params`, or `deepLink`. Never accept an arbitrary route, URL, href, or
complete contract JSON. The sender revalidates the destination/parameters
before delivery and omits navigation fields when no deep link was selected.
Legacy `deepLink` rows and branches are rejected rather than used as fallback.
Invalid recipients terminate without queuing and expose only a bounded reason.
Credentials, tokens, private keys, authorization headers, and secret values
are forbidden; user-approved business content is allowed.

For manual authentication, do not discover or inspect customer credentials.
After authoring the stopped sender, show its exact ID and the exact action that
needs FCM authentication, then stop until the customer completes it.

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
Manual-auth mode has only exact sender identity/environment/state and
observable-contract read-back; do not inspect secure authentication values or
apply WIF validation claims to it.

Use the PPAPI/FlowAgent runtime resource ID for every FlowAgent read-back. After
publication, separately resolve and record the Dataverse Workflow ID used by
the webhook registration. A successful read on one surface does not prove the
other identity, and ID inequality is not drift.

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

For manual-auth Power Automate sending, stop after creating the sender until
the customer configures authentication. On resume, call `get_flow` again with
the exact plugin-created sender flow ID (its PPAPI/FlowAgent runtime resource
ID), validate and preflight
without reading secure values, and require explicit publication approval.
Publish the sender first, then the producer, read both exact runtime resource
IDs back, and resolve both Dataverse Workflow IDs afterward. Keep sender status
`customer-owned Power Automate sender / observable contract read back; authentication not plugin-validated`;
identity/observable-contract continuity does not validate credentials or
authentication design.

## 8. Smoke tests and handoff

Run non-delivery `smoke_test`/connection checks first. Do not create a live
outbox row until the user confirms a matching physical-device build,
notification consent, exact `allUsers` subscription, and permission for one
test notification whose content the user approves after the privacy warning.

`run_flow` is never proof that an `OpenApiConnectionWebhook` trigger works.
Synthetic invocation can create a run whose trigger body is null and bypasses
the organic Dataverse callback-registration/expander path. Use `run_flow` only
when read-back proves the flow has a manual trigger. A Dataverse webhook must
be tested with one consented organic Dataverse row event through its discovered
connector operation.

Then create one `allUsers` row with empty Target OID and the approved optional
navigation intent. Read it back; inspect `get_run_history`, `get_run_details`,
and `get_run_actions`; require `Sent` plus provider message ID. Preserve only
sanitized diagnostics and do not repeatedly resubmit. A user-targeted test
needs separate consent from that user.

### Organic Dataverse callback diagnosis

For a bounded organic test window, correlate the allowlisted Dataverse facts
with run history from the exact PPAPI/FlowAgent runtime resource ID. Classify
the first failed boundary:

| Observed state | Classification / owner |
|---|---|
| Dataverse Workflow or callback registration absent, or no expander job after the organic row | `missing-registration` / `missing-job`; callback setup |
| exact callback registration exists, but `message` does not include the expected event | `registration-event-mismatch`; trigger event configuration |
| `Callback Registration Expander` is Ready/Waiting and has no start timestamp | `dataverse-async-backlog`; Dataverse asynchronous processing |
| callback-expander job is Failed, Canceled, or Suspended | `callback-job-failed` / `callback-job-canceled` / `callback-job-suspended`; Dataverse callback execution |
| callback job completed, but bounded history for the exact runtime resource ID has no run | `identity-routing`; wrong ID role, environment, registration, or runtime route |
| producer runtime run exists, but no outbox row was created | `producer-no-outbox`; producer definition/action path |
| outbox remains `Queued`, but no sender callback job/run exists | `queued-outbox-no-sender`; sender trigger/callback path |
| outbox reaches `Sent` or bounded `Failed` | `terminal-sender`; sender completed and physical receipt is still a separate gate |

Use the read-only helper when direct Dataverse evidence is needed:

```bash
node "${PLUGIN_ROOT}/scripts/diagnose-dataverse-callback-health.js" \
  --environment-url "<Dataverse URL>" \
  --tenant-id "<tenant GUID>" \
  --source-entity-set "<plural source entity set>" \
  --source-record-id "<exact approved organic source row GUID>" \
  --source-event "<created|updated|deleted>" \
  --outbox-entity-set "<plural outbox entity set>" \
  --outbox-record-id "<exact correlated outbox row GUID, when one exists>" \
  --outbox-status-column "<status logical name>" \
  --outbox-queued-statuses "<actual Queued choice integer>" \
  --outbox-terminal-statuses "<actual Sent integer>,<actual Failed integer>" \
  --producer-callback-workflow-id "<Dataverse producer workflowid>" \
  --producer-runtime-resource-id "<FlowAgent producer resource ID>" \
  --sender-callback-workflow-id "<Dataverse sender workflowid>" \
  --sender-runtime-resource-id "<FlowAgent sender resource ID>" \
  --since "<bounded UTC timestamp>"
```

After checking bounded FlowAgent run history, pass
`--producer-runtime-run-state observed|absent` and
`--sender-runtime-run-state observed|absent`; an observed state also requires
the corresponding sanitized `--*-runtime-run-id`. Do not mark a runtime run
absent merely because `run_flow` produced a null trigger body.

The source record ID is required so the helper never selects an arbitrary
latest row. Pass the outbox record ID only after bounded producer evidence
identifies the correlated row; without it, sender-stage diagnosis remains
pending and outbox evidence is `unknown`. An exact outbox ID that was queried
and returned `404` is `queried-missing`; an exact returned row is `present`.
The helper emits `producer-no-outbox` only for `queried-missing`, never when no
outbox was queried. The helper performs only allowlisted `GET` requests through
`dataverse-request.js`. It emits IDs, timestamps, normalized statuses, and
classifications only. It never selects or prints OIDs, recipient/title/body,
payload/provider values, callback URLs, runtime integration properties, or
authentication values. If Azure CLI authentication is unreadable, expired, or
unauthorized, stop and refresh `az` authentication for the target tenant;
never fall back to another cached tenant.

Correlation is relationship-bound, not timestamp-assigned. For a row webhook,
the callback registration must have exact GUID `name` equal to the recorded
runtime resource ID, exact trigger-table `entityname`, and
`softdeletestatus=0`. Its `message` must include the requested source event;
the sender registration must include `created` because its expected input is a
new outbox row:

| `callbackregistration.message` | Compatible `--source-event` values |
|---|---|
| `1` Added | `created` |
| `2` Deleted | `deleted` |
| `3` Modified | `updated` |
| `4` Added or Modified | `created`, `updated` |
| `5` Added or Deleted | `created`, `deleted` |
| `6` Modified or Deleted | `updated`, `deleted` |
| `7` Added or Modified or Deleted | `created`, `updated`, `deleted` |

These are the documented Dataverse `callbackregistration_message` choices.
See:
https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/reference/callbackregistration.
The helper selects only the numeric choice and emits that number plus
normalized compatible event names; no trigger body or filter expression is
read. An exact registration with no compatible event is
`registration-event-mismatch`, not a healthy registration.

The operation-type `79` job must then have
`workflowactivationid` equal to the recorded Dataverse Workflow ID and
`regardingobjectid` equal to the exact source/outbox row ID. Ignore interleaved
jobs whose relationship IDs do not match. The async job's `createdon`, not the
source or outbox row's `createdon`, determines whether evidence is in the
bounded diagnostic window. Therefore an `updated` event remains valid when
the source row was created earlier, and a `deleted` event may have a
`queried-missing` source row when the exact callback job still correlates it.
Report queue latency only when both
`createdAt` and `startedAt` exist, and execution latency only when both
`startedAt` and `completedAt` exist; otherwise report `null`.
Failed, Canceled, and Suspended callback-expander jobs must be reported as
`callback-job-failed`, `callback-job-canceled`, or
`callback-job-suspended`; none may fall through to
`insufficient-or-healthy-snapshot`.

Finish with environment ID/URL, Firebase project, connections, mutation
read-backs, and whether delivery was skipped or verified. Report both ID roles
and producer/sender states. Never print secrets, tokens, JWTs, secure action
values, or raw payload data.

Write this stable `Push flow handoff` schema to `memory-bank.md` after the
applicable read-backs succeed:

- `Environment ID`
- `Dataverse URL`
- `Producer PPAPI/FlowAgent runtime resource ID`
- `Producer Dataverse Workflow ID`
- `Producer flow state`
- `Sender flow ID (PPAPI/FlowAgent runtime resource ID)`
- `Sender Dataverse Workflow ID`
- `Sender flow state`
- `Sender authentication status`
- `Flow read-back timestamp`

For a customer-owned Power Automate sender, both exact IDs must read back by ID
as `Started`; use their PPAPI/FlowAgent runtime resource IDs through FlowAgent,
use those same runtime resource IDs for exact callback-registration `name`
correlation, and record both Dataverse Workflow IDs for Workflow/async-job
correlation. The status is exactly
`customer-owned Power Automate sender / observable contract read back; authentication not plugin-validated`.
Do not add credentials, connection authentication details, endpoint secrets,
or an authentication-verification result. Downstream verification consumes
the runtime resource IDs through FlowAgent and the Dataverse Workflow IDs
through the callback diagnostic rather than selecting by display name or
requiring cross-surface equality.
