---
name: create-push-notification-flow
description: Use when creating or repairing the Dataverse-triggered Power Automate flow that sends FCM HTTP v1 push notifications to an Entra OID topic or the allUsers topic for a Power Apps mobile app.
user-invocable: true
allowed-tools: Read, Edit, Write, Grep, Glob, Bash, AskUserQuestion, Skill, mcp__flowagent__list_environments, mcp__flowagent__set_current_env, mcp__flowagent__get_current_env, mcp__flowagent__resolve_environment, mcp__flowagent__list_connections, mcp__flowagent__list_connectors, mcp__flowagent__get_connector, mcp__flowagent__search_operations, mcp__flowagent__get_operation_details, mcp__flowagent__pick_or_create_connection, mcp__flowagent__resolve_refs, mcp__flowagent__resolve_params, mcp__flowagent__create_flow, mcp__flowagent__publish_flow, mcp__flowagent__validate_flow, mcp__flowagent__preflight_flow, mcp__flowagent__smoke_test, mcp__flowagent__get_expression_help, mcp__flowagent__invoke_operation
model: opus
---

**Shared instructions: [shared-instructions.md](${PLUGIN_ROOT}/shared/shared-instructions.md)** — read first.

**Outbox schema: [push-notification-outbox.md](${PLUGIN_ROOT}/shared/references/push-notification-outbox.md)**.

**Keyless sender protocol: [push-flow-wif.md](${PLUGIN_ROOT}/shared/references/push-flow-wif.md)**.

# Create Push Notification Flow

Reuse the installed `power-automate` plugin/FlowAgent. Do not copy its MCP server
or hand-author connector schemas.

## Workflow

1. Verify app/environment -> 2. Ensure outbox table -> 3. Verify FlowAgent ->
4. Configure workload federation -> 5. Discover actions -> 6. Create stopped flow ->
7. Validate/preflight -> 8. Confirm publish -> 9. Smoke test

### 1. Ensure the outbox

Check `native-app-plan.md` and `.datamodel-manifest.json` for the Push
Notification table from the outbox reference. If absent, update the plan and
invoke `/add-dataverse --skip-planning` before flow creation.

### 2. Require FlowAgent

If FlowAgent tools or the `power-automate` plugin are unavailable, stop with
install/wiring instructions. Flow creation must use its environment resolution,
connector discovery, validation, preflight, and create/publish operations.

### 3. Configure keyless Google authentication

Use Google Cloud Workload Identity Federation (WIF), not a service-account key.
This keeps the sender compatible with raw Power Automate HTTP actions because
Google STS accepts a short-lived Entra JWT and performs the trust exchange; the
flow never needs a SHA-256 or RS256 primitive.

Collect or create these non-secret configuration values:

- Entra tenant ID, app/client ID, token audience/scope, and client credential
  secret reference
- Google project ID and project number
- workload identity pool ID and OIDC provider ID
- Firebase sender service-account email

Guide the user through these one-time administrative steps:

1. Create a dedicated Entra app registration/service principal for the flow.
2. Create a Google workload identity pool plus OIDC provider for the Entra
   issuer and expected audience. Restrict its attribute condition to the
   dedicated app identity; do not trust every identity in the tenant.
3. Grant only that federated principal
   `roles/iam.workloadIdentityUser` on the sender service account.
4. Grant the sender service account the minimum Firebase Messaging send role.
5. Store the Entra client secret in Azure Key Vault or a secret environment
   variable. Never put it directly in the flow definition.

Official protocols:

- Google STS token exchange:
  https://cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token
- Service-account impersonation:
  https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateAccessToken
- FCM HTTP v1 authorization:
  https://firebase.google.com/docs/cloud-messaging/auth-server

Follow the exact HTTP sequence and security requirements in
`push-flow-wif.md`; do not reconstruct token bodies from memory.

Before authoring, prove FlowAgent can discover the Key Vault/secret retrieval,
HTTP, and Dataverse actions. If WIF is not configured or the required actions
are unavailable, return a precise `BLOCKED:` status. Never fall back to a
Firebase Admin key, fixed JWT assertion, or fixed access token.

### 4. Build the flow

Discover exact Dataverse and HTTP action schemas; never guess them. Create the
flow stopped with:

1. Dataverse create/update trigger filtered to a transition into `Queued`.
2. Update row to `Sending`; increment attempts.
3. Validate Audience/Target OID and select lowercase `<oid>` or exact
   `allUsers`.
4. Retrieve the Entra client credential with secure inputs/outputs, then POST a
   client-credentials request to the tenant token endpoint for the provider's
   configured audience.
5. Exchange the Entra access token at `https://sts.googleapis.com/v1/token`
   using the WIF provider resource name and
   `urn:ietf:params:oauth:token-type:jwt`.
6. Call
   `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/<encoded-email>:generateAccessToken`
   with scope `https://www.googleapis.com/auth/firebase.messaging`.
7. POST
   `https://fcm.googleapis.com/v1/projects/<project-id>/messages:send`.
8. Include `notification`, `data.schemaVersion`, `data.deepLink`, Android
   channel/priority, and APNs alert/sound fields.
9. On success, set `Sent`, provider message ID, and UTC Sent On.
10. On failure, set `Failed` with sanitized bounded diagnostics.

Enable secure inputs/outputs for every secret, Entra token, federated token,
Google access token, and authorized HTTP action. Use Embedded connections.

Validate and preflight before creation. Publish only after explicit confirmation.
Create one test outbox row for `allUsers` only after the user confirms a test
device is subscribed.
