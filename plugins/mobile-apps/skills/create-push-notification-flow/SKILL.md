---
name: create-push-notification-flow
description: Use when creating, repairing, or extending Power Automate producer and sender flows for Power Apps mobile push notifications, including choosing recommended WIF or customer-configured FCM authentication; Dataverse triggers; outbox queuing; content mapping; trigger-aware deep links; lowercase Entra OID topics; FCM HTTP v1; FlowAgent setup; or push-flow smoke tests.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, Skill, mcp__flowagent__list_environments, mcp__flowagent__set_current_env, mcp__flowagent__get_current_env, mcp__flowagent__resolve_environment, mcp__flowagent__list_flows, mcp__flowagent__get_flow, mcp__flowagent__create_flow, mcp__flowagent__update_flow, mcp__flowagent__edit_flow, mcp__flowagent__copy_flow, mcp__flowagent__publish_flow, mcp__flowagent__disable_flow, mcp__flowagent__list_connections, mcp__flowagent__test_connection, mcp__flowagent__list_connectors, mcp__flowagent__get_connector, mcp__flowagent__search_operations, mcp__flowagent__get_operation_details, mcp__flowagent__pick_or_create_connection, mcp__flowagent__resolve_entity, mcp__flowagent__resolve_refs, mcp__flowagent__resolve_params, mcp__flowagent__validate_flow, mcp__flowagent__preflight_flow, mcp__flowagent__preview_update, mcp__flowagent__smoke_test, mcp__flowagent__run_flow, mcp__flowagent__get_run_history, mcp__flowagent__get_run_details, mcp__flowagent__get_run_actions, mcp__flowagent__get_expression_help, mcp__flowagent__invoke_operation, mcp__flowagent__get_flow_context, mcp__flowagent__set_current_flow, mcp__flowagent__clear_current_flow, mcp__flowagent__list_backups, mcp__flowagent__get_backup, mcp__flowagent__restore_backup
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Canonical FlowAgent workflow: [push-flow-authoring.md](${PLUGIN_ROOT}/shared/references/push-flow-authoring.md)** —
read in full. It owns environment proof, schema/connection discovery,
definitions, validate/preflight/mutate/read-back, recovery, publishing, and
smoke-test gates.

**Outbox schema: [push-notification-outbox.md](${PLUGIN_ROOT}/shared/references/push-notification-outbox.md)**.

**Navigation contract: [navigation-link-contract.md](${PLUGIN_ROOT}/shared/references/navigation-link-contract.md)**.

**WIF runtime protocol: [push-flow-wif.md](${PLUGIN_ROOT}/shared/references/push-flow-wif.md)**.

**Sender-auth handoff: [sender-auth-contract.md](${PLUGIN_ROOT}/shared/references/sender-auth-contract.md)**.

**Sender-auth choices: [push-sender-auth-options.md](${PLUGIN_ROOT}/shared/references/push-sender-auth-options.md)**.

# Create Push Notification Flow

For a plugin-managed sender, create two separate FlowAgent-authored flows:

1. a producer that resolves a recipient and writes a user-approved `Queued`
   outbox row; and
2. a sender that owns idempotency, delivery, and `Sent`/`Failed` transitions.

For customer-configured authentication, author both flows stopped, but leave
the sender's FCM authentication unconfigured and clearly identify the action
the customer must complete. The customer configures, validates, publishes,
monitors, and supports that authentication. Never put FCM authorization into
each business-event flow.

This skill consumes owner-skill handoffs. `/setup-fcm` owns Firebase through
the vendor-official Firebase MCP only; `/setup-push-wif` owns Google-side WIF
provisioning. Do not fall back to `firebase-tools`, `gcloud`, or cloud
provisioning from this skill.

## Required workflow

### 1. Bootstrap and prove the environment

Execute Sections 1–2 of `push-flow-authoring.md`. The mobile plugin declares
no automatic installation dependency on the separate `power-automate` plugin.
If FlowAgent is unavailable, give the documented manual
install/restart/setup steps and stop. Prove
`power.config.json`, `npx power-apps`, PAC, Azure, and FlowAgent target the same
environment/URL/tenant before any mutation. FlowAgent is the only flow mutation
path; do not use portal automation, shell flow commands, or guessed
definitions.

### 2. Prove Firebase and select sender authentication

Read active native Firebase configs and require one project. Do not rerun
`/setup-fcm` when valid selected-platform client configuration is already
active.

Validate a project-local `sender-auth.json` before WIF sender discovery. If
absent or invalid, read the sender-auth choices reference and show its
two-option comparison, then ask the customer to choose:

1. **Workload Identity Federation (Recommended):** invoke `/setup-push-wif`.
2. **Create Power Automate flows; configure FCM authentication manually:**
   create both flows stopped without credentials or `sender-auth.json`. The
   customer completes the sender's authentication before publication.

After an owner skill returns, revalidate against the exact client Firebase
project. Never construct the WIF handoff here or add another authentication
mode as a fallback.

In manual-auth mode, FlowAgent authors the complete non-secret producer,
outbox, idempotency, routing, payload, and sender action structure. The sender
remains stopped and explicitly incomplete until the customer configures FCM
authentication in the identified action. Record no managed auth handoff,
credentials, endpoint secrets, or success-shaped authentication proof. A
checkbox or verbal confirmation cannot promote authentication to
plugin-validated.

After the customer says authentication is configured, fetch the exact
plugin-created sender flow ID and read back only the observable
queued-outbox trigger/guard, idempotent claim, `allUsers` versus lowercase-OID
routing, one delivery invocation, and terminal `Sent`/`Failed` updates. Do not
request or inspect credentials, secure values, authentication headers,
connection secrets, or raw delivery bodies; do not validate
`sender-auth.json` or claim the customer's authentication, least privilege, or
rotation design was technically validated.

### 3. Resolve the outbox and producer intent

Execute Section 3 of the authoring reference. Create a missing outbox only via
`/add-dataverse --skip-planning`, then reread live metadata. Resolve singular
logical names, plural entity sets, actual choice integers, and `systemusers`;
never guess them.

Ask the grouped producer question from the reference. For title, body, and
additional data, explain lock-screen/device exposure and that topic membership
is not authorization, recommend minimizing sensitive data, then let the user
choose source fields and templates. Reject only credentials, tokens, private
keys, authentication headers, or technically invalid payload shapes; do not
override the user's business-content choice on privacy grounds.

Based on the selected Dataverse trigger table, inspect the screen plan and
navigation registry and suggest a relevant detail destination with the trigger
row ID, otherwise a relevant list destination, otherwise no deep link. Show
the suggestion and let the user accept it, choose another registered
destination, or choose no deep link. Never accept an arbitrary route, URL,
href, or complete navigation-contract JSON. Default to Dataverse row created
and owner-based resolution only when unspecified. `ownerid` is not an Entra
OID: resolve `systemusers.azureactivedirectoryobjectid`, GUID-validate, and
lowercase it. Team/missing/ambiguous owners must skip or fail, never route to a
guessed topic.

### 4. Discover before authoring

Execute Section 4. Use `get_connector`/`search_operations`, then
`get_operation_details`, dynamic resolvers, live connections, and
`test_connection`. Never infer operation IDs, schemas, parameters, connection
references, or Dataverse choice values.

For WIF, require the proved Key Vault connection and read
`push-flow-wif.md`. For manual-auth mode, discover the FCM HTTP action schema
but leave its authentication configuration for the customer; never insert a
placeholder credential or secret.

### 5. Author stopped definitions

Execute Section 5 exactly. The sender is idempotent and concurrency-safe.
`User` uses a validated lowercase OID topic; `AllUsers` uses empty Target OID
plus exact `allUsers`. Before authoring payload mappings, warn that
title/body/data can be visible on the device and that topic membership is not
authorization. Use the user's approved content mappings, including business
data if they explicitly choose it, while continuing to prohibit credentials
and authentication material.

The producer uses `OpenApiConnectionWebhook`, singular trigger `entityname`,
plural action `entityName`, and plural `systemusers` for owner lookup. It
validates selected parameter and Additional Data fields, constructs canonical
sorted JSON, and queues Payload Version `1`, optional allowlisted
Destination/Navigation Parameters, Status `Queued`, and Attempt Count `0`.
The sender revalidates the same contract, merges approved Additional Data
without reserved keys, and includes `schemaVersion`, `destination`, and
`params` only when navigation was selected; a legacy `deepLink` branch is a
blocker.

### 6. Validate, mutate, read back, and recover

Apply Sections 6–7 to **every** create, update, edit, copy, restore, publish,
or disable: `validate_flow`, `preflight_flow`, `preview_update` when updating,
one mutation, then full `get_flow` comparison. An acknowledged response is not
proof of persistence.

Create new flows stopped. Before existing-flow changes, prove a backup or make
a stopped recovery copy. Prefer surgical `edit_flow`; never use state-only
`update_flow`, stack edits on failed read-back, mix auth modes, or delete a
previously working flow as retry. If this invocation created an incorrect flow
without a usable backup, disable it, read it back as `Stopped`, report its
exact ID, and leave cleanup explicitly user-owned; do not delete it.

Present verified stopped IDs and require explicit publication confirmation.
For WIF, publish/read back the sender as `Started` before the producer. For
manual-auth mode, stop after authoring until the customer configures FCM
authentication in the sender. Then validate/preflight and read back the same
exact sender flow without inspecting secure values, require explicit approval,
publish the sender before the producer, and read both exact IDs back after
publication.

### 7. Gate delivery testing and hand off

Run non-delivery checks first. Follow Section 8's physical-device, consent,
`allUsers`, privacy, and live-row confirmation gates. Read the row and run
history/actions back; do not repeatedly resubmit failures or retain raw
diagnostics.

Report environment, Firebase project, connections, read-back results, and
whether delivery was skipped or verified. Report producer/sender IDs and
states. Never print secrets, tokens, JWTs, secure action values, or raw
payloads.

Persist the authoring reference's flow-backed `Push flow handoff` schema in
`memory-bank.md`. Record the exact environment, producer ID/state, sender
ID/state, read-back timestamp, and sender authentication status. In manual
Power Automate mode, both IDs must read back as `Started`; record exactly
`customer-owned Power Automate sender / observable contract read back;
authentication not plugin-validated` and no authentication-validation result.

For iOS, published-and-read-back flows hand off to the direct user-managed
`/build-ios` Wrap path after manual `/setup-apple-ios` and `/setup-apns`
completion. After the exact IPA is installed, hand off to
`/verify-ios-push`; a flow smoke test is not physical delivery verification.
