---
name: create-push-notification-flow
description: Use when creating, repairing, or extending the Power Automate producer and sender flows for Power Apps mobile push notifications, including choosing between recommended WIF, managed Azure Function compatibility, or customer-owned manual sender authentication; Dataverse row-created triggers; outbox queuing; lowercase Entra OID topics; FCM HTTP v1; FlowAgent setup; or push-flow smoke tests.
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

**WIF runtime protocol: [push-flow-wif.md](${PLUGIN_ROOT}/shared/references/push-flow-wif.md)**.

**Sender-auth handoff: [sender-auth-contract.md](${PLUGIN_ROOT}/shared/references/sender-auth-contract.md)**.

**Sender-auth choices: [push-sender-auth-options.md](${PLUGIN_ROOT}/shared/references/push-sender-auth-options.md)**.

**Function sender protocol: [function-endpoint.md](${PLUGIN_ROOT}/skills/setup-push-service-account/references/function-endpoint.md)**.

# Create Push Notification Flow

For a plugin-managed sender, create two separate FlowAgent-authored flows:

1. a producer that resolves a recipient and writes a privacy-safe `Queued`
   outbox row; and
2. a sender that owns idempotency, delivery, and `Sent`/`Failed` transitions.

For manual/customer-owned authentication, do not author or mutate the sender.
Author the requested producer/outbox, then require the safe sender handoff
below: either read back the exact customer-owned Power Automate sender flow ID
and observable non-secret contract, or record the non-Flow unavailable-
verification status. The customer authors, validates, publishes, monitors, and
supports the sender. Never put FCM authorization into each business-event flow.

This skill consumes owner-skill handoffs. `/setup-fcm` owns Firebase through
the vendor-official Firebase MCP only; `/setup-push-wif` owns Google-side WIF
provisioning; `/setup-push-service-account` owns the Function compatibility
path. Do not fall back to `firebase-tools`, `gcloud`, or Azure provisioning from this skill.

## Required workflow

### 1. Bootstrap and prove the environment

Execute Sections 1–2 of `push-flow-authoring.md`. If FlowAgent is unavailable,
give its exact plugin install/restart/setup sequence and stop. Prove
`power.config.json`, `npx power-apps`, PAC, Azure, and FlowAgent target the same
environment/URL/tenant before any mutation. FlowAgent is the only flow mutation
path; do not use portal automation, shell flow commands, or guessed
definitions.

### 2. Prove Firebase and select sender authentication

Read active native Firebase configs and require one project. Do not rerun
`/setup-fcm` when valid selected-platform client configuration is already
active.

Validate a project-local `sender-auth.json` before plugin-managed sender
discovery. If absent or invalid, read the sender-auth choices reference and
show its three-option comparison, then ask the customer to choose:

1. **Workload Identity Federation (Recommended):** invoke `/setup-push-wif`.
2. **Managed Azure Function compatibility:** invoke
   `/setup-push-service-account`; it may consume an existing customer-owned
   Firebase service-account JSON but must never create or download one.
3. **Manual/customer-owned sender authentication:** do not invoke or create a
   setup skill, request credentials, or create `sender-auth.json`/a managed
   authentication handoff. The safe operational sender handoff below is still
   required. When it is a Power Automate sender, require its exact flow ID for
   FlowAgent identity/state/observable-contract read-back.

After an owner skill returns, revalidate against the exact client Firebase
project. Never translate modes, construct the managed handoff here, or add a
second mode as a fallback.

In manual mode, FlowAgent authors only the producer/outbox artifacts, but the
workflow is not ready for downstream routing without a safe sender handoff.
Record no managed auth handoff, credentials, endpoint secrets, or success-
shaped proof. The plugin must not create a placeholder or unauthenticated HTTP
action for the sender. A checkbox or verbal confirmation cannot promote this
route to plugin-validated or publish-ready. Give the customer-owned completion
checklist from the choices reference.

For a customer-owned Power Automate sender, require the customer-supplied and
approved **exact sender flow ID**—never a similar display name—and call
`get_flow` for that ID in the proved FlowAgent environment. Require the
returned ID to match exactly and state `Started`. Read back only the observable
queued-outbox trigger/guard, idempotent claim, `allUsers` versus lowercase-OID
routing, one delivery invocation, and terminal `Sent`/`Failed` updates. Do not
request or inspect credentials, secure values, authentication headers,
connection secrets, endpoint secrets, or raw delivery bodies; do not validate
`sender-auth.json` or claim the customer's authentication, least privilege, or
rotation design was technically validated. Stop before producer publication
when the ID is missing, unreadable, different, not `Started`, or lacks the
observable contract.

If the manual sender is a non-Flow endpoint, record only its customer-approved
non-secret immutable identifier and report
`customer-owned non-Flow endpoint / plugin physical verification unavailable`.
Keep the producer-only state distinct and do not route to plugin physical
verification because there is no exact sender flow for FlowAgent to correlate.

### 3. Resolve the outbox and producer intent

Execute Section 3 of the authoring reference. Create a missing outbox only via
`/add-dataverse --skip-planning`, then reread live metadata. Resolve singular
logical names, plural entity sets, actual choice integers, and `systemusers`;
never guess them.

Ask the grouped producer question from the reference. Default to Dataverse row
created and owner-based resolution only when unspecified. `ownerid` is not an
Entra OID: resolve `systemusers.azureactivedirectoryobjectid`, GUID-validate,
and lowercase it. Team/missing/ambiguous owners must skip or fail, never route
to a guessed topic.

### 4. Discover before authoring

Execute Section 4. Use `get_connector`/`search_operations`, then
`get_operation_details`, dynamic resolvers, live connections, and
`test_connection`. Never infer operation IDs, schemas, parameters, connection
references, or Dataverse choice values.

For WIF, require the proved Key Vault connection and read
`push-flow-wif.md`. For Function mode, require the handoff's exact
Entra-authenticated connection/operation and endpoint audience. If it cannot be
proved, return to `/setup-push-service-account`; never substitute generic HTTP
or WIF.

### 5. Author stopped definitions

Execute Section 5 exactly. The sender is idempotent, concurrency-safe, and has
one mode-specific branch. `User` uses a validated lowercase OID topic;
`AllUsers` uses empty Target OID plus exact `allUsers`. Payloads remain generic
because topic membership is not an authorization boundary.

The producer uses `OpenApiConnectionWebhook`, singular trigger `entityname`,
plural action `entityName`, and plural `systemusers` for owner lookup. It
queues Payload Version `1`, Status `Queued`, and Attempt Count `0`, with no
confidential record content.

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
Publish/read back the sender as `Started` before the producer. Manual mode never
edits or publishes the customer's sender. In customer-owned Power Automate
mode, immediately reread the exact sender ID as `Started`, then publish the
producer only after the customer confirms operational readiness and explicitly
approves. Read both exact IDs back after publication.

### 7. Gate delivery testing and hand off

Run non-delivery checks first. Follow Section 8's physical-device, consent,
`allUsers`, privacy, and live-row confirmation gates. Read the row and run
history/actions back; do not repeatedly resubmit failures or retain raw
diagnostics.

Report environment, Firebase project, connections, read-back results, and
whether delivery was skipped or verified. For flow-backed senders report
producer/sender IDs and states; for a non-Flow endpoint report only the
producer ID/state, approved non-secret `Sender endpoint identifier`, and exact
blocked status. Never print secrets, tokens, JWTs, Function responses, or
confidential payloads.

Persist exactly one of the authoring reference's `Push flow handoff` schemas in
`memory-bank.md`:

- For a plugin-managed or customer-owned Power Automate sender, record the
  exact environment, producer ID/state, sender ID/state, read-back timestamp,
  and sender authentication status. In manual Power Automate mode, both IDs
  must read back as `Started`; record exactly
  `customer-owned Power Automate sender / observable contract read back; authentication not plugin-validated`
  and no authentication-validation result.
- For a non-Flow endpoint, record only the environment, producer ID/state,
  customer-approved immutable non-secret `Sender endpoint identifier`,
  read-back timestamp, and exact status
  `customer-owned non-Flow endpoint / plugin physical verification unavailable`.
  Omit `Sender flow ID` and `Sender flow state` entirely; do not emit empty or
  `not applicable` placeholders.

For iOS, published-and-read-back flows hand off to `/build-ios`. After the
exact IPA is installed, hand off to `/verify-ios-push`; a flow smoke test is
not physical delivery verification.
